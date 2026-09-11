import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { HTTPFacilitatorClient, type FacilitatorClient, x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";
import { decodePaymentResponseHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { SettleResponse } from "@x402/core/types";
import { ExpressAdapter } from "@x402/express";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { ErrorCode, type Finding, type ScanReport } from "@koven/domain";
import { AccountId, MAX_HTTP_BODY_BYTES } from "@koven/schemas";

import {
  MAX_TIMEOUT_SECONDS,
  type PaymentAuthorizationPolicy,
  PaymentAuthorizationError,
  validatePaidPaymentAttempt,
  type ValidatedPaymentAttempt,
} from "./authorization.js";
import { buildCompletionCallback, CallbackDispatcher } from "./callback.js";
import { ProviderStore, ProviderStoreError, type StoredPayment } from "./outbox.js";
import { buildReport, canonicalJson } from "./report.js";
import { parseBoundPaidScanRequestBase, parseBoundScanRequest, ScanServiceError } from "./request.js";
import { SolhintScanEngine, type ScanEngine } from "./scan.js";
import {
  SettlementConfirmationError,
  type SettlementConfirmer,
  SettlementReconciliationWorker,
} from "./settlement.js";

/** Report contract limits frozen by `ScanReportSchema` and `FindingSchema` in `@koven/schemas`. */
export const MAX_REPORT_FINDINGS = 1000;
export const MAX_FINDING_MESSAGE_CHARS = 4096;

export interface ScanService {
  scan(input: unknown): Promise<ScanReport>;
}

export interface ScanServiceOptions {
  readonly providerId: string;
  readonly engine?: ScanEngine;
  readonly now?: () => Date;
}

/** Fails explicitly when an engine result cannot be represented by the report contract. */
function assertReportLimits(findings: Finding[]): void {
  if (findings.length > MAX_REPORT_FINDINGS) {
    throw new ScanServiceError(
      ErrorCode.INTERNAL_ERROR,
      500,
      `Scan produced ${findings.length} findings; the report contract allows at most ${MAX_REPORT_FINDINGS}`,
    );
  }
  const oversized = findings.find(finding => finding.message.length > MAX_FINDING_MESSAGE_CHARS);
  if (oversized) {
    throw new ScanServiceError(
      ErrorCode.INTERNAL_ERROR,
      500,
      `Finding ${oversized.ruleId} at line ${oversized.line} exceeds ${MAX_FINDING_MESSAGE_CHARS} characters`,
    );
  }
}

/** Creates the validated scanning core; HTTP and payment adapters wrap this boundary. */
export function createScanService(options: ScanServiceOptions): ScanService {
  const engine = options.engine ?? new SolhintScanEngine();
  const now = options.now ?? (() => new Date());

  return {
    async scan(input: unknown): Promise<ScanReport> {
      const request = parseBoundScanRequest(input);
      const startedAt = now().toISOString();
      const findings = await engine.scan(request.source, request.targetRef);
      const completedAt = now().toISOString();
      assertReportLimits(findings);
      return buildReport(request, options.providerId, findings, { startedAt, completedAt });
    },
  };
}

export interface PaidScanServerOptions extends Omit<PaymentAuthorizationPolicy, "feePayerAccountId"> {
  readonly providerId: string;
  readonly facilitatorUrl: string;
  readonly store: ProviderStore;
  readonly settlementConfirmer: SettlementConfirmer;
  readonly callbackUrl: string;
  readonly callbackSecret: string | Uint8Array;
  readonly facilitatorClient?: FacilitatorClient;
  readonly engine?: ScanEngine;
  readonly now?: () => Date;
  readonly callbackFetch?: typeof fetch;
  readonly callbackRandom?: () => number;
  readonly dispatchCallbacks?: boolean;
  readonly reconcileSettlements?: boolean;
  readonly settlementReconcileIntervalMs?: number;
}

export interface PaidScanServer {
  readonly app: Express;
  readonly callbacks: CallbackDispatcher;
  readonly settlements: SettlementReconciliationWorker;
  readonly x402: x402HTTPResourceServer;
}

function sendJsonError(response: Response, status: number, code: string, detail: string): void {
  response.status(status).json({ code, detail });
}

/**
 * Relays x402 payment instructions. The frozen contract answers `402` with the
 * `PAYMENT-REQUIRED` header and an empty body, so the SDK's default JSON or
 * HTML paywall body is never sent.
 */
function sendPaymentInstructions(response: Response, instructions: {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  isHtml?: boolean;
}): void {
  for (const [name, value] of Object.entries(instructions.headers)) {
    if (name.toLowerCase() === "content-type") continue;
    response.setHeader(name, value);
  }
  response.status(instructions.status).end();
}

function callbackFor(payment: StoredPayment, settledAt: string) {
  if (!payment.report) throw new ProviderStoreError(ErrorCode.INTERNAL_ERROR, 500, "Stored scan report is missing");
  return buildCompletionCallback(payment.report, payment.transactionId, settledAt);
}

function syntheticSettlement(payment: StoredPayment): SettleResponse {
  return {
    success: true,
    payer: payment.request.paymentAuthorization.borrowerAccountId,
    transaction: payment.transactionId,
    network: payment.network,
  };
}

function responseHeadersFor(payment: StoredPayment, settlement: SettleResponse): Record<string, string> {
  if (Object.keys(payment.responseHeaders).length > 0) return { ...payment.responseHeaders };
  return { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settlement) };
}

function safePaymentResponseHeaders(
  headers: Readonly<Record<string, string>>,
  settlement: SettleResponse,
): Record<string, string> {
  const value = Object.entries(headers).find(([name]) => name.toLowerCase() === "payment-response")?.[1];
  if (!value) throw new ProviderStoreError(ErrorCode.INTERNAL_ERROR, 500, "Settlement response header is missing");
  try {
    if (canonicalJson(decodePaymentResponseHeader(value)) !== canonicalJson(settlement)) {
      throw new Error("Settlement header mismatch");
    }
  } catch {
    throw new ProviderStoreError(ErrorCode.INTERNAL_ERROR, 500, "Settlement response header is invalid");
  }
  return { "PAYMENT-RESPONSE": value };
}

function assertSettlementResult(
  result: SettleResponse,
  attempt: ValidatedPaymentAttempt,
  policy: PaymentAuthorizationPolicy,
): void {
  if (
    !result.success
    || result.transaction !== attempt.authorization.transactionId
    || result.network !== policy.network
    || result.payer !== attempt.authorization.borrowerAccountId
    || (result.amount !== undefined && result.amount !== attempt.authorization.amountTinybar)
  ) {
    throw new SettlementConfirmationError(
      ErrorCode.PAYMENT_AUTHORIZATION_MISMATCH,
      403,
      "Facilitator settlement does not match the authorized payment",
    );
  }
}

function isUnconfirmed(error: unknown): error is SettlementConfirmationError {
  return error instanceof SettlementConfirmationError && error.code === ErrorCode.SETTLEMENT_UNCONFIRMED;
}

function sendStoredReport(response: Response, payment: StoredPayment, report: ScanReport): void {
  for (const [name, value] of Object.entries(payment.responseHeaders)) response.setHeader(name, value);
  response.setHeader("cache-control", "private");
  response.json(report);
}

/**
 * Builds an x402 server whose provider-owned authorization and durable claim
 * checks run before facilitator verification or settlement.
 */
export async function createPaidScanServer(options: PaidScanServerOptions): Promise<PaidScanServer> {
  const facilitator = options.facilitatorClient
    ?? new HTTPFacilitatorClient({ url: options.facilitatorUrl, timeoutMs: 30_000 });
  const resourceServer = new x402ResourceServer(facilitator)
    .register("hedera:*", new ExactHederaScheme());
  const routes = {
    "POST /scan": {
      accepts: {
        scheme: "exact",
        network: options.network,
        payTo: options.providerAccountId,
        price: { amount: options.amountTinybar, asset: options.asset },
        maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
      },
      resource: options.scanUrl,
      description: "Solidity security scan",
      mimeType: "application/json",
    },
  } as const;
  const httpServer = new x402HTTPResourceServer(resourceServer, routes);
  await httpServer.initialize();
  const supportedKind = resourceServer.getSupportedKind(2, options.network, "exact");
  const feePayerCandidate = supportedKind?.extra?.feePayer;
  const parsedFeePayer = AccountId.safeParse(feePayerCandidate);
  if (
    !parsedFeePayer.success
    || parsedFeePayer.data === options.providerAccountId
    || Object.hasOwn(options.signerPublicKeys, parsedFeePayer.data)
  ) throw new Error("Facilitator returned an invalid Hedera fee payer");
  const authorizationPolicy: PaymentAuthorizationPolicy = {
    providerAccountId: options.providerAccountId,
    scanUrl: options.scanUrl,
    amountTinybar: options.amountTinybar,
    network: options.network,
    asset: options.asset,
    feePayerAccountId: parsedFeePayer.data,
    signerPublicKeys: options.signerPublicKeys,
  };

  const now = options.now ?? (() => new Date());
  const scanService = createScanService({
    providerId: options.providerId,
    ...(options.engine ? { engine: options.engine } : {}),
    now,
  });
  const callbacks = new CallbackDispatcher({
    store: options.store,
    callbackUrl: options.callbackUrl,
    callbackSecret: options.callbackSecret,
    ...(options.callbackFetch ? { fetch: options.callbackFetch } : {}),
    now: () => now().getTime(),
    ...(options.callbackRandom ? { random: options.callbackRandom } : {}),
  });

  const dispatchCallback = (): void => {
    if (options.dispatchCallbacks === false) return;
    callbacks.wake();
  };

  /**
   * Completes an attempted settlement once consensus is independently confirmed
   * and atomically enqueues its callback. An unconfirmed settlement is recorded
   * (rotating the row and, once the transaction can no longer execute, marking a
   * facilitator-unconfirmed payment as failed) and the error is rethrown.
   */
  const reconcile = async (payment: StoredPayment): Promise<StoredPayment | null> => {
    if (payment.status === "completed" || payment.status === "settlement_failed") return payment;
    if (!payment.settlementAttempted || !payment.report) return null;

    let confirmed: Awaited<ReturnType<SettlementConfirmer["confirm"]>>;
    try {
      confirmed = await options.settlementConfirmer.confirm({
        transactionId: payment.transactionId,
        payerAccountId: payment.request.paymentAuthorization.borrowerAccountId,
        providerAccountId: options.providerAccountId,
        amountTinybar: options.amountTinybar,
      });
    } catch (error) {
      if (error instanceof SettlementConfirmationError) {
        options.store.recordUnconfirmedSettlement(
          payment.transactionId,
          error.message,
          now().getTime(),
          { unconfirmed: isUnconfirmed(error) },
        );
      }
      throw error;
    }
    const settlement = payment.settlement ?? syntheticSettlement(payment);
    const headers = responseHeadersFor(payment, settlement);
    if (!payment.settlement) options.store.saveSettlement(payment.transactionId, settlement, headers, now().getTime());
    const current = options.store.getPayment(payment.transactionId)!;
    options.store.completeAndEnqueue(
      payment.transactionId,
      callbackFor(current, confirmed.settledAt),
      now().getTime(),
    );
    dispatchCallback();
    return options.store.getPayment(payment.transactionId);
  };
  const settlements = new SettlementReconciliationWorker({
    store: options.store,
    reconcile,
    ...(options.settlementReconcileIntervalMs !== undefined
      ? { intervalMs: options.settlementReconcileIntervalMs }
      : {}),
  });

  /**
   * Resolves a retry of a payment this provider already attempted to settle.
   * A facilitator-confirmed settlement returns the stored report even while
   * Mirror consensus is still pending; the callback is gated on that consensus
   * by the reconciliation worker. A settlement the facilitator did not confirm
   * must be observed on the ledger before the report is released.
   */
  const respondWithExisting = async (response: Response, payment: StoredPayment): Promise<void> => {
    let current: StoredPayment | null;
    let unconfirmed: SettlementConfirmationError | null = null;
    try {
      current = await reconcile(payment);
    } catch (error) {
      if (!isUnconfirmed(error)) throw error;
      unconfirmed = error;
      settlements.wake();
      current = options.store.getPayment(payment.transactionId);
    }
    if (current?.status === "settlement_failed") {
      throw new PaymentAuthorizationError(
        ErrorCode.PAYMENT_AUTHORIZATION_INVALID,
        401,
        "Payment did not settle before its transaction expired",
      );
    }
    if (!current?.report || !current.settlement) {
      if (unconfirmed) throw unconfirmed;
      sendJsonError(response, 503, ErrorCode.SETTLEMENT_UNCONFIRMED, "Payment is already being processed");
      return;
    }
    sendStoredReport(response, current, current.report);
  };

  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: MAX_HTTP_BODY_BYTES, strict: true }));
  app.post("/scan", async (request: Request, response: Response, next: NextFunction) => {
    try {
      const adapter = new ExpressAdapter(request);
      const paymentHeader = request.get("payment-signature");
      if (paymentHeader) parseBoundPaidScanRequestBase(request.body);
      else parseBoundScanRequest(request.body);
      const context = {
        adapter,
        path: adapter.getPath(),
        method: adapter.getMethod(),
        ...(paymentHeader ? { paymentHeader } : {}),
      };
      if (!paymentHeader) {
        const result = await httpServer.processHTTPRequest(context);
        if (result.type !== "payment-error") {
          throw new Error("x402 did not produce payment requirements for an unpaid scan");
        }
        sendPaymentInstructions(response, result.response);
        return;
      }

      const attempt = validatePaidPaymentAttempt(
        request.body,
        paymentHeader,
        authorizationPolicy,
        now(),
        { allowExpired: true },
      );
      if (attempt.authorizationExpired) {
        const existing = options.store.getPayment(attempt.authorization.transactionId);
        if (
          !existing
          || existing.fingerprint !== attempt.fingerprint
          || !existing.settlementAttempted
          || existing.status === "settlement_failed"
        ) {
          throw new PaymentAuthorizationError(
            ErrorCode.PAYMENT_AUTHORIZATION_INVALID,
            401,
            "Payment authorization has expired",
          );
        }
      }
      const claim = options.store.claimPayment(attempt, now().getTime());
      if (!claim.owned) {
        await respondWithExisting(response, claim.payment);
        return;
      }

      let processing: Awaited<ReturnType<typeof httpServer.processHTTPRequest>>;
      try {
        processing = await httpServer.processHTTPRequest(context);
      } catch {
        throw new SettlementConfirmationError(
          ErrorCode.SETTLEMENT_UNCONFIRMED,
          503,
          "Payment verification service is unavailable",
        );
      }
      if (processing.type === "payment-error") {
        sendPaymentInstructions(response, processing.response);
        return;
      }
      if (processing.type !== "payment-verified" || processing.beforeHandlerSettlement) {
        throw new Error("Unexpected x402 payment flow");
      }
      options.store.renewVerifiedPaymentLease(
        attempt.authorization.transactionId,
        claim.token!,
        now().getTime(),
      );

      let report = claim.payment.report;
      if (!report) {
        try {
          report = await scanService.scan(parseBoundPaidScanRequestBase(request.body));
        } catch (error) {
          await processing.cancellationDispatcher.cancel({ reason: "handler_threw", error });
          throw error;
        }
        options.store.saveReport(attempt.authorization.transactionId, claim.token!, report, now().getTime());
      }
      options.store.markSettlementAttempted(attempt.authorization.transactionId, claim.token!, now().getTime());

      const responseBody = Buffer.from(JSON.stringify(report), "utf8");
      let settled: Awaited<ReturnType<typeof httpServer.processSettlement>> | null = null;
      let failureReason = "Facilitator response is invalid";
      try {
        settled = await httpServer.processSettlement(
          processing.paymentPayload,
          processing.paymentRequirements,
          processing.declaredExtensions,
          { request: context, responseBody, responseHeaders: { "content-type": "application/json" } },
        );
        if (!settled.success) failureReason = settled.errorReason;
      } catch (error) {
        if (error instanceof Error) failureReason = error.message;
      }
      if (!settled?.success) {
        // The SDK reports facilitator timeouts and refusals alike as a failed
        // settlement, so the outcome is uncertain: the transaction may still
        // reach consensus. Keep the claim; reconciliation completes it from the
        // ledger or fails it once the transaction can no longer execute.
        options.store.recordUnconfirmedSettlement(
          attempt.authorization.transactionId,
          `Facilitator did not confirm settlement: ${failureReason}`,
          now().getTime(),
        );
        settlements.wake();
        throw new SettlementConfirmationError(
          ErrorCode.SETTLEMENT_UNCONFIRMED,
          503,
          "Payment settlement outcome is uncertain",
        );
      }
      const { headers, requirements: _requirements, ...settlement } = settled;
      assertSettlementResult(settlement, attempt, authorizationPolicy);
      const responseHeaders = safePaymentResponseHeaders(headers, settlement);
      options.store.saveSettlement(attempt.authorization.transactionId, settlement, responseHeaders, now().getTime());

      // The report is deliverable once the facilitator confirmed settlement;
      // only the completion callback waits for independent Mirror consensus.
      try {
        await reconcile(options.store.getPayment(attempt.authorization.transactionId)!);
      } catch (error) {
        if (!isUnconfirmed(error)) throw error;
        settlements.wake();
      }
      for (const [name, value] of Object.entries(responseHeaders)) response.setHeader(name, value);
      response.setHeader("cache-control", "private");
      response.json(report);
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ScanServiceError
      || error instanceof PaymentAuthorizationError
      || error instanceof ProviderStoreError
      || error instanceof SettlementConfirmationError) {
      sendJsonError(response, error.status, error.code, error.message);
      return;
    }
    if (typeof error === "object" && error !== null && "type" in error && error.type === "entity.too.large") {
      sendJsonError(response, 413, ErrorCode.SOURCE_TOO_LARGE, "Request body exceeds the configured limit");
      return;
    }
    if (typeof error === "object" && error !== null && "type" in error && error.type === "entity.parse.failed") {
      sendJsonError(response, 400, ErrorCode.REQUEST_INVALID, "Request body is not valid JSON");
      return;
    }
    sendJsonError(response, 500, ErrorCode.INTERNAL_ERROR, "Resource server failed to process the request");
  });

  if (options.dispatchCallbacks !== false) callbacks.start();
  if (options.reconcileSettlements !== false) settlements.start();
  return { app, callbacks, settlements, x402: httpServer };
}
