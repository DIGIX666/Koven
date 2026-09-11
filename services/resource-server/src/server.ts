import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { HTTPFacilitatorClient, type FacilitatorClient, x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";
import { decodePaymentResponseHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { SettleResponse } from "@x402/core/types";
import { ExpressAdapter } from "@x402/express";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import { ErrorCode, type ScanReport } from "@koven/domain";
import { AccountId, MAX_HTTP_BODY_BYTES } from "@koven/schemas";

import {
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
} from "./settlement.js";

export interface ScanService {
  scan(input: unknown): Promise<ScanReport>;
}

export interface ScanServiceOptions {
  readonly providerId: string;
  readonly engine?: ScanEngine;
  readonly now?: () => Date;
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
}

export interface PaidScanServer {
  readonly app: Express;
  readonly callbacks: CallbackDispatcher;
  readonly x402: x402HTTPResourceServer;
}

function sendJsonError(response: Response, status: number, code: string, detail: string): void {
  response.status(status).json({ code, detail });
}

function sendPaymentInstructions(response: Response, instructions: {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
  isHtml?: boolean;
}): void {
  for (const [name, value] of Object.entries(instructions.headers)) response.setHeader(name, value);
  if (instructions.isHtml) response.status(instructions.status).send(instructions.body);
  else response.status(instructions.status).json(instructions.body ?? {});
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
    network: "hedera:testnet",
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
): void {
  if (
    !result.success
    || result.transaction !== attempt.authorization.transactionId
    || result.network !== "hedera:testnet"
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
        maxTimeoutSeconds: 180,
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

  const reconcile = async (payment: StoredPayment): Promise<StoredPayment | null> => {
    if (payment.status === "completed") return payment;
    if (!payment.settlementAttempted || !payment.report) return null;

    const confirmed = await options.settlementConfirmer.confirm({
      transactionId: payment.transactionId,
      payerAccountId: payment.request.paymentAuthorization.borrowerAccountId,
      providerAccountId: options.providerAccountId,
      amountTinybar: options.amountTinybar,
    });
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

      const attempt = validatePaidPaymentAttempt(request.body, paymentHeader, authorizationPolicy, now());
      const claim = options.store.claimPayment(attempt, now().getTime());
      if (!claim.owned) {
        const recovered = await reconcile(claim.payment);
        if (!recovered?.report) {
          sendJsonError(response, 503, ErrorCode.SETTLEMENT_UNCONFIRMED, "Payment is already being processed");
          return;
        }
        for (const [name, value] of Object.entries(recovered.responseHeaders)) response.setHeader(name, value);
        response.setHeader("cache-control", "private");
        response.json(recovered.report);
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
      let settled: Awaited<ReturnType<typeof httpServer.processSettlement>>;
      try {
        settled = await httpServer.processSettlement(
          processing.paymentPayload,
          processing.paymentRequirements,
          processing.declaredExtensions,
          { request: context, responseBody, responseHeaders: { "content-type": "application/json" } },
        );
      } catch {
        throw new SettlementConfirmationError(
          ErrorCode.SETTLEMENT_UNCONFIRMED,
          503,
          "Payment settlement outcome is uncertain",
        );
      }
      if (!settled.success) {
        sendPaymentInstructions(response, settled.response);
        return;
      }
      const { headers, requirements: _requirements, ...settlement } = settled;
      assertSettlementResult(settlement, attempt);
      const responseHeaders = safePaymentResponseHeaders(headers, settlement);
      options.store.saveSettlement(attempt.authorization.transactionId, settlement, responseHeaders, now().getTime());
      for (const [name, value] of Object.entries(responseHeaders)) response.setHeader(name, value);

      const confirmed = await options.settlementConfirmer.confirm({
        transactionId: attempt.authorization.transactionId,
        payerAccountId: attempt.authorization.borrowerAccountId,
        providerAccountId: options.providerAccountId,
        amountTinybar: options.amountTinybar,
      });
      const stored = options.store.getPayment(attempt.authorization.transactionId)!;
      options.store.completeAndEnqueue(
        attempt.authorization.transactionId,
        callbackFor(stored, confirmed.settledAt),
        now().getTime(),
      );
      dispatchCallback();
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
    sendJsonError(response, 500, ErrorCode.INTERNAL_ERROR, "Resource server failed to process the request");
  });

  if (options.dispatchCallbacks !== false) callbacks.start();
  return { app, callbacks, x402: httpServer };
}
