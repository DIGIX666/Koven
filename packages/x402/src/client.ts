import { createHash } from "node:crypto";

import {
  decodePaymentRequiredHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import type { ClientHederaSigner } from "@x402/hedera";
import { ErrorCode, type PaidScanRequest, type PaymentRequirements, type ScanRequest } from "@koven/domain";
import {
  AuthorizeRequestSchema,
  AuthorizeResponseSchema,
  ErrorResponseSchema,
  HttpUrl,
  PaymentRequiredHeadersSchema,
  ScanPaymentAuthorizationSchema,
  ScanReportSchema,
  ScanRequestSchema,
  type HttpRequest,
  type HttpResponse,
} from "@koven/schemas";

import {
  assertAcceptableRequirements,
  ChallengeRejectedError,
  type ChallengePolicy,
  DEFAULT_CHALLENGE_POLICY,
  normalizeChallenge,
} from "./challenge.js";
import type { PaidResourceResponse, PaymentRequiredResponse, X402Client } from "./interfaces.js";
import { decodeSettlement } from "./settlement.js";

export type AuthorizeRequest = HttpRequest<"authorize">;
export type AuthorizeResponse = HttpResponse<"authorize">;
/** Wire form of the signer's authorization: tinybars as decimal strings. */
export type WireScanPaymentAuthorization = AuthorizeResponse["paymentAuthorization"];

const X402_VERSION = 2;

/** Consumer-side view of the restricted signer's `POST /authorize`. */
export interface PaymentAuthorizer {
  authorize(request: AuthorizeRequest): Promise<AuthorizeResponse>;
}

/** A refusal returned by the restricted signer or the provider, with the frozen error code. */
export class X402RequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "X402RequestError";
  }
}

const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const transactionSha256 = (transactionBase64: string): string => {
  const bytes = Buffer.from(transactionBase64, "base64");
  if (bytes.toString("base64") !== transactionBase64) {
    throw new ChallengeRejectedError("signer returned non-canonical transaction bytes");
  }
  return sha256Hex(bytes);
};

async function errorFromResponse(response: Response, fallback: string): Promise<X402RequestError> {
  const parsed = ErrorResponseSchema.safeParse(await response.json().catch(() => undefined));
  return parsed.success
    ? new X402RequestError(response.status, parsed.data.code, parsed.data.detail)
    : new X402RequestError(response.status, ErrorCode.INTERNAL_ERROR, fallback);
}

function trustedServiceOrigin(value: string, label: string): URL {
  const url = new URL(value);
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !loopback)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/"
  ) throw new Error(`${label} must be an HTTPS or loopback HTTP origin`);
  return url;
}

export interface HttpPaymentAuthorizerOptions {
  readonly baseUrl: string;
  /** Consumer service credential presented as `Authorization: Bearer`. */
  readonly credential: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** HTTP transport for `POST /authorize`; the consumer never holds the key this calls. */
export function createHttpPaymentAuthorizer(options: HttpPaymentAuthorizerOptions): PaymentAuthorizer {
  const baseUrl = trustedServiceOrigin(options.baseUrl, "Restricted signer URL");
  const fetchImplementation = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) {
    throw new RangeError("Signer timeout must be between 1 and 120000 ms");
  }
  return {
    async authorize(request) {
      const response = await fetchImplementation(new URL("/authorize", baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${options.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(AuthorizeRequestSchema.parse(request)),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) throw await errorFromResponse(response, "Restricted signer refused the payment");
      return AuthorizeResponseSchema.parse(await response.json());
    },
  };
}

export interface MissionPaymentContext {
  readonly missionId: string;
  readonly targetSha256: string;
  /** Canonical decimal nonce below 2^248, fresh per payment intent. */
  readonly nonce: string;
  /** Absolute provider scan URL the payment is bound to. */
  readonly scanUrl: string;
  readonly policy?: ChallengePolicy;
}

/**
 * The `ClientHederaSigner` the consumer plugs into the x402 client. It holds
 * no key: it re-normalises every challenge locally, asks the restricted signer
 * for the partially signed transfer, verifies that the returned authorization
 * is bound to this mission and to those exact transaction bytes, and retains
 * it so the paid retry can carry it. One instance serves one mission intent.
 */
export class RemoteRestrictedSigner implements ClientHederaSigner {
  private readonly authorizations = new Map<string, WireScanPaymentAuthorization>();

  constructor(
    readonly accountId: string,
    readonly mission: MissionPaymentContext,
    private readonly authorizer: PaymentAuthorizer,
  ) {
    if (!HttpUrl.safeParse(mission.scanUrl).success) throw new Error("Mission scan URL must be an absolute HTTP URL");
  }

  async createPartiallySignedTransferTransaction(requirements: PaymentRequirements): Promise<string> {
    const { missionId, targetSha256, nonce, scanUrl, policy } = this.mission;
    normalizeChallenge(requirements, missionId, targetSha256, nonce, { scanUrl, ...(policy ? { policy } : {}) });

    const response = AuthorizeResponseSchema.parse(await this.authorizer.authorize({
      missionId,
      requirements,
      nonce,
    }));
    const authorization = response.paymentAuthorization;
    const expectedPolicy = policy ?? DEFAULT_CHALLENGE_POLICY;
    if (
      authorization.missionId !== missionId
      || authorization.targetSha256 !== targetSha256
      || authorization.nonce !== nonce
      || authorization.transactionSha256 !== transactionSha256(response.transaction)
      || authorization.borrowerAccountId !== this.accountId
      || authorization.providerAccountId !== requirements.payTo
      || authorization.amountTinybar !== requirements.amount
      || authorization.scanUrl !== scanUrl
      || authorization.network !== expectedPolicy.network
      || authorization.asset !== expectedPolicy.asset
    ) {
      throw new ChallengeRejectedError("signer authorization is not bound to this payment");
    }
    this.authorizations.set(authorization.transactionSha256, authorization);
    return response.transaction;
  }

  /** The authorization retained for exactly these transaction bytes, if this signer produced them. */
  authorizationFor(transactionBase64: string): WireScanPaymentAuthorization | undefined {
    try {
      return this.authorizations.get(transactionSha256(transactionBase64));
    } catch {
      return undefined;
    }
  }
}

interface DecodedChallenge {
  readonly envelope: PaymentRequired;
  readonly requirements: PaymentRequirements;
}

/** Decodes a 402 envelope and selects the first requirement the frozen contract accepts. */
function decodeChallenge(response: Response, policy: ChallengePolicy): DecodedChallenge {
  const header = response.headers.get("payment-required");
  if (header === null || !PaymentRequiredHeadersSchema.safeParse({ "payment-required": header }).success) {
    throw new ChallengeRejectedError("402 response carries no PAYMENT-REQUIRED header");
  }
  let envelope: PaymentRequired;
  try {
    envelope = decodePaymentRequiredHeader(header);
  } catch {
    throw new ChallengeRejectedError("PAYMENT-REQUIRED header is not a valid envelope");
  }
  if (envelope.x402Version !== X402_VERSION) throw new ChallengeRejectedError("unsupported x402 version");
  for (const candidate of envelope.accepts) {
    try {
      return { envelope, requirements: assertAcceptableRequirements(candidate, policy) };
    } catch (error) {
      if (!(error instanceof ChallengeRejectedError)) throw error;
    }
  }
  throw new ChallengeRejectedError("no accepted requirement matches the frozen exact HBAR contract");
}

function paymentPayload(
  challenge: DecodedChallenge,
  transaction: string,
): PaymentPayload {
  return {
    x402Version: X402_VERSION,
    resource: challenge.envelope.resource,
    accepted: challenge.requirements,
    payload: { transaction },
  };
}

const wireAuthorization = (
  authorization: PaidScanRequest["paymentAuthorization"] | WireScanPaymentAuthorization,
): WireScanPaymentAuthorization => ScanPaymentAuthorizationSchema.parse({
  ...authorization,
  amountTinybar: typeof authorization.amountTinybar === "bigint"
    ? authorization.amountTinybar.toString(10)
    : authorization.amountTinybar,
});

export interface PayingFetchOptions {
  readonly fetch?: typeof fetch;
}

/**
 * Wraps `fetch` with the x402 client flow for the scan endpoint: on a `402`,
 * decode the requirements from the header, obtain the signed transfer and its
 * authorization from the restricted signer, and retry once with the
 * `PAYMENT-SIGNATURE` header and the `PaidScanRequest` body. The original
 * request must be the `ScanRequest` of the signer's mission, sent to the
 * signer's scan URL; anything else is refused before the signer is contacted.
 */
export function createPayingFetch(
  signer: RemoteRestrictedSigner,
  options: PayingFetchOptions = {},
): typeof fetch {
  const fetchImplementation = options.fetch ?? fetch;
  const policy = signer.mission.policy ?? DEFAULT_CHALLENGE_POLICY;

  return async (input, init) => {
    const first = await fetchImplementation(input, init);
    if (first.status !== 402 || !first.headers.has("payment-required")) return first;

    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url !== signer.mission.scanUrl) {
      throw new ChallengeRejectedError("paid request URL is not the mission's scan URL");
    }
    const body = init?.body;
    const parsedBody = ScanRequestSchema.safeParse(typeof body === "string" ? JSON.parse(body) : undefined);
    if (!parsedBody.success) throw new ChallengeRejectedError("paid request body is not a ScanRequest");
    const scanRequest: ScanRequest = parsedBody.data;
    if (
      scanRequest.missionId !== signer.mission.missionId
      || scanRequest.targetSha256 !== signer.mission.targetSha256
    ) {
      throw new ChallengeRejectedError("paid request is not bound to this signer's mission");
    }

    const challenge = decodeChallenge(first, policy);
    const transaction = await signer.createPartiallySignedTransferTransaction(challenge.requirements);
    const authorization = signer.authorizationFor(transaction);
    if (authorization === undefined) throw new ChallengeRejectedError("no authorization retained for the signed transaction");

    const headers = new Headers(init?.headers);
    headers.set("content-type", "application/json");
    headers.set("payment-signature", encodePaymentSignatureHeader(paymentPayload(challenge, transaction)));
    return fetchImplementation(input, {
      ...init,
      method: "POST",
      headers,
      body: JSON.stringify({ ...scanRequest, paymentAuthorization: authorization }),
    });
  };
}

export interface HttpX402ClientOptions {
  /** Absolute provider scan URL; one client per provider endpoint. */
  readonly scanUrl: string;
  readonly fetch?: typeof fetch;
  readonly now?: () => string;
  readonly policy?: ChallengePolicy;
  readonly timeoutMs?: number;
}

/**
 * Real implementation of the orchestrator's `X402Client` boundary: the unpaid
 * request yields the accepted requirements, the paid retry carries the
 * transaction the restricted signer produced together with its authorization.
 * Challenges are retained per mission so concurrent missions cannot mix.
 */
export class HttpX402Client implements X402Client {
  private readonly scanUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => string;
  private readonly policy: ChallengePolicy;
  private readonly timeoutMs: number;
  private readonly challenges = new Map<string, DecodedChallenge>();

  constructor(options: HttpX402ClientOptions) {
    if (!HttpUrl.safeParse(options.scanUrl).success) throw new Error("Scan URL must be an absolute HTTP URL");
    this.scanUrl = options.scanUrl;
    this.fetchImplementation = options.fetch ?? fetch;
    this.now = options.now ?? (() => new Date().toISOString());
    this.policy = options.policy ?? DEFAULT_CHALLENGE_POLICY;
    this.timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) {
      throw new RangeError("Provider timeout must be between 1 and 300000 ms");
    }
  }

  async request(request: ScanRequest): Promise<PaymentRequiredResponse> {
    const scanRequest = ScanRequestSchema.parse(request);
    const response = await this.post(JSON.stringify(scanRequest));
    if (response.status !== 402) throw await errorFromResponse(response, "Provider did not issue a payment challenge");
    const challenge = decodeChallenge(response, this.policy);
    this.challenges.set(scanRequest.missionId, challenge);
    return { status: 402, requirements: challenge.requirements };
  }

  async retryWithPayment(request: PaidScanRequest, signedTransaction: string): Promise<PaidResourceResponse> {
    const challenge = this.challenges.get(request.missionId);
    if (challenge === undefined) throw new ChallengeRejectedError("no challenge retained for this mission");
    const authorization = wireAuthorization(request.paymentAuthorization);
    if (
      authorization.missionId !== request.missionId
      || authorization.transactionSha256 !== transactionSha256(signedTransaction)
      || authorization.providerAccountId !== challenge.requirements.payTo
      || authorization.amountTinybar !== challenge.requirements.amount
    ) {
      throw new ChallengeRejectedError("authorization is not bound to this mission's challenge and transaction");
    }
    const { paymentAuthorization: _ignored, ...scanRequest } = request;
    const response = await this.post(
      JSON.stringify({ ...ScanRequestSchema.parse(scanRequest), paymentAuthorization: authorization }),
      { "payment-signature": encodePaymentSignatureHeader(paymentPayload(challenge, signedTransaction)) },
    );
    if (response.status === 402) {
      // The provider (or its facilitator) refused this payment; the reason travels in the header.
      let reason = "Provider refused the payment";
      try {
        reason = decodePaymentRequiredHeader(response.headers.get("payment-required") ?? "").error ?? reason;
      } catch {
        // keep the generic reason
      }
      throw new X402RequestError(402, ErrorCode.PAYMENT_AUTHORIZATION_INVALID, reason);
    }
    if (response.status !== 200) throw await errorFromResponse(response, "Provider did not deliver the paid report");

    const settlementHeader = response.headers.get("payment-response");
    if (settlementHeader === null) throw new X402RequestError(200, ErrorCode.SETTLEMENT_UNCONFIRMED, "Paid response carries no PAYMENT-RESPONSE header");
    const receipt = decodeSettlement(settlementHeader, {
      missionId: request.missionId,
      requirements: challenge.requirements,
      payer: authorization.borrowerAccountId,
      observedAt: this.now(),
    });
    const report = ScanReportSchema.parse(await response.json());
    if (report.missionId !== request.missionId || report.targetSha256 !== request.targetSha256) {
      throw new X402RequestError(200, ErrorCode.REPORT_BINDING_MISMATCH, "Report is not bound to the paid request");
    }
    this.challenges.delete(request.missionId);
    return { status: 200, receipt, report };
  }

  private post(body: string, headers: Record<string, string> = {}): Promise<Response> {
    return this.fetchImplementation(this.scanUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}
