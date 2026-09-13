import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { ErrorCode, IllegalStateTransitionError } from "@koven/domain";
import {
  createIdempotencyResult,
  getIdempotencyResult,
  getMission,
  getMissionCompletion,
  getMissionPolicy,
  PersistenceConflict,
  PersistenceConflictError,
  saveMissionCompletion,
  type KovenDatabase,
} from "@koven/persistence";
import {
  CALLBACK_CLOCK_SKEW_SECONDS,
  CallbackHeadersSchema,
  CallbackResponseSchema,
  CompletionCallbackSchema,
  ErrorResponseSchema,
  type HttpResponse,
} from "@koven/schemas";
import { z } from "zod";

import { canonicalJsonValue } from "../canonical.js";
import type { MissionStateMachine } from "../state/index.js";

const CallbackEnvelope = z.object({
  outcome: z.object({ missionId: z.string() }).passthrough(),
  report: z.object({ reportSha256: z.string() }).passthrough(),
}).passthrough();

export interface CompletionHeaders {
  readonly idempotencyKey: string | undefined;
  readonly timestamp: string | undefined;
  readonly signature: string | undefined;
}

export interface RawCompletionRequest {
  readonly body: Uint8Array;
  readonly headers: CompletionHeaders;
}

export interface CompletionSettlementConfirmer {
  confirm(expectation: {
    readonly transactionId: string;
    readonly payerAccountId: string;
    readonly recipientAccountId: string;
    readonly amountTinybar: bigint;
  }): Promise<{ readonly settledAt: string }>;
}

export interface SignerCompletionClient {
  complete(request: RawCompletionRequest): Promise<HttpResponse<"signerCompletion">>;
}

export class CompletionError extends Error {
  constructor(
    readonly code: typeof ErrorCode.CALLBACK_AUTH_INVALID
      | typeof ErrorCode.REPORT_SCHEMA_INVALID
      | typeof ErrorCode.REPORT_BINDING_MISMATCH
      | typeof ErrorCode.MISSION_POLICY_MISSING
      | typeof ErrorCode.SETTLEMENT_UNCONFIRMED,
    readonly status: 400 | 401 | 403 | 503,
    detail: string,
  ) {
    super(detail);
    this.name = "CompletionError";
  }
}

export class CallbackAuthenticationError extends CompletionError {
  constructor(detail: string) {
    super(ErrorCode.CALLBACK_AUTH_INVALID, 401, detail);
    this.name = "CallbackAuthenticationError";
  }
}

const signerCompletionError = (
  code: ErrorCode,
  detail: string,
): CompletionError => {
  switch (code) {
    case ErrorCode.CALLBACK_AUTH_INVALID:
      return new CompletionError(code, 401, detail);
    case ErrorCode.REPORT_SCHEMA_INVALID:
    case ErrorCode.REPORT_BINDING_MISMATCH:
      return new CompletionError(code, 400, detail);
    case ErrorCode.MISSION_POLICY_MISSING:
      return new CompletionError(code, 403, detail);
    case ErrorCode.FUNDING_MISMATCH:
      return new CompletionError(ErrorCode.REPORT_BINDING_MISMATCH, 400, detail);
    case ErrorCode.SETTLEMENT_UNCONFIRMED:
      return new CompletionError(code, 503, detail);
    default:
      return new CompletionError(
        ErrorCode.SETTLEMENT_UNCONFIRMED,
        503,
        "Restricted signer refused completion",
      );
  }
};

const settlementConfirmationError = (error: unknown): CompletionError => {
  if (error instanceof CompletionError) return error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
  const detail = error instanceof Error ? error.message : "Settlement could not be confirmed";
  if (code === ErrorCode.FUNDING_MISMATCH) {
    return new CompletionError(ErrorCode.REPORT_BINDING_MISMATCH, 400, detail);
  }
  return new CompletionError(ErrorCode.SETTLEMENT_UNCONFIRMED, 503, detail);
};

export function callbackSignature(
  secret: Uint8Array,
  timestamp: string,
  idempotencyKey: string,
  body: Uint8Array,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${idempotencyKey}.`, "utf8")
    .update(body)
    .digest("hex");
}

const sha256Hex = (value: Uint8Array): string => createHash("sha256").update(value).digest("hex");

const reportHash = (report: ReturnType<typeof CompletionCallbackSchema.parse>["report"]): string => {
  const { reportSha256: _reportSha256, ...unsigned } = report;
  return sha256Hex(Buffer.from(JSON.stringify(canonicalJsonValue(unsigned)), "utf8"));
};

function trustedOrigin(value: string): URL {
  const url = new URL(value);
  const loopback = url.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !loopback)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/"
  ) throw new Error("Restricted signer URL must be an HTTPS or loopback HTTP origin");
  return url;
}

export interface HttpSignerCompletionClientOptions {
  readonly baseUrl: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Forwards the provider's exact bytes and authentication headers for independent signer verification. */
export class HttpSignerCompletionClient implements SignerCompletionClient {
  private readonly baseUrl: URL;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HttpSignerCompletionClientOptions) {
    this.baseUrl = trustedOrigin(options.baseUrl);
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new RangeError("Signer timeout must be between 1 and 120000 ms");
    }
  }

  async complete(request: RawCompletionRequest): Promise<HttpResponse<"signerCompletion">> {
    let response: Response;
    try {
      response = await this.fetchImplementation(new URL("/internal/missions/complete", this.baseUrl), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": request.headers.idempotencyKey ?? "",
          "x-callback-timestamp": request.headers.timestamp ?? "",
          "x-callback-signature": request.headers.signature ?? "",
        },
        body: Buffer.from(request.body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new CompletionError(
        ErrorCode.SETTLEMENT_UNCONFIRMED,
        503,
        "Restricted signer has not acknowledged completion",
      );
    }
    if (response.status !== 202) {
      const error = ErrorResponseSchema.safeParse(await response.json().catch(() => undefined));
      throw error.success
        ? signerCompletionError(error.data.code, error.data.detail)
        : signerCompletionError(ErrorCode.INTERNAL_ERROR, "Restricted signer refused completion");
    }
    return CallbackResponseSchema.parse(await response.json());
  }
}

export interface CompletionHandlerOptions {
  readonly database: KovenDatabase;
  readonly stateMachine: MissionStateMachine;
  readonly providerCallbackSecrets: Readonly<Record<string, Uint8Array>>;
  readonly settlementConfirmer: CompletionSettlementConfirmer;
  readonly signerCompletion: SignerCompletionClient;
  readonly now?: () => Date;
}

export interface CompletionResult {
  readonly missionId: string;
  readonly response: HttpResponse<"completion">;
}

/** Authenticates, binds and durably accepts provider completion callbacks. */
export class CompletionHandler {
  private readonly now: () => Date;

  constructor(private readonly options: CompletionHandlerOptions) {
    this.now = options.now ?? (() => new Date());
    for (const secret of Object.values(options.providerCallbackSecrets)) {
      if (secret.byteLength !== 32) throw new Error("Provider callback secrets must contain exactly 32 bytes");
    }
  }

  private async duplicate(
    missionId: string,
    reportSha256: string,
    idempotencyKey: string,
  ): Promise<CompletionResult> {
    await this.options.stateMachine.record(missionId, {
      type: "callback-duplicate",
      payload: { reportSha256, idempotencyKey },
    });
    return {
      missionId,
      response: CallbackResponseSchema.parse({ status: "duplicate", code: ErrorCode.CALLBACK_DUPLICATE }),
    };
  }

  async receive(raw: RawCompletionRequest): Promise<CompletionResult> {
    const headers = CallbackHeadersSchema.safeParse({
      "idempotency-key": raw.headers.idempotencyKey,
      "x-callback-timestamp": raw.headers.timestamp,
      "x-callback-signature": raw.headers.signature,
    });
    if (!headers.success) throw new CallbackAuthenticationError("Callback headers are missing or malformed");
    const timestamp = headers.data["x-callback-timestamp"];
    const idempotencyKey = headers.data["idempotency-key"];
    const nowSeconds = Math.floor(this.now().getTime() / 1_000);
    if (Math.abs(nowSeconds - Number(timestamp)) > CALLBACK_CLOCK_SKEW_SECONDS) {
      throw new CallbackAuthenticationError("Callback timestamp is outside the accepted window");
    }

    let body: unknown;
    try {
      body = JSON.parse(Buffer.from(raw.body).toString("utf8"));
    } catch {
      throw new CallbackAuthenticationError("Callback body is not valid JSON");
    }
    const envelope = CallbackEnvelope.safeParse(body);
    if (!envelope.success) throw new CallbackAuthenticationError("Callback does not identify a mission and report");
    if (idempotencyKey !== `mission-complete:${envelope.data.outcome.missionId}:${envelope.data.report.reportSha256}`) {
      throw new CallbackAuthenticationError("Callback idempotency key does not match its body");
    }

    const policy = getMissionPolicy(this.options.database, envelope.data.outcome.missionId);
    if (policy === undefined) {
      throw new CompletionError(ErrorCode.MISSION_POLICY_MISSING, 403, "Mission policy is not registered");
    }
    const secret = this.options.providerCallbackSecrets[policy.provider.id];
    if (secret === undefined) throw new CallbackAuthenticationError("Selected provider has no callback secret");
    const expected = Buffer.from(callbackSignature(secret, timestamp, idempotencyKey, raw.body), "hex");
    const presented = Buffer.from(headers.data["x-callback-signature"], "hex");
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      throw new CallbackAuthenticationError("Callback signature is invalid");
    }

    const parsed = CompletionCallbackSchema.safeParse(body);
    if (!parsed.success) {
      throw new CompletionError(ErrorCode.REPORT_SCHEMA_INVALID, 400, "Callback report does not match its schema");
    }
    const { outcome, report } = parsed.data;
    const requestHash = sha256Hex(Buffer.concat([
      Buffer.from(`${idempotencyKey}.`, "utf8"),
      Buffer.from(raw.body),
    ]));
    const existing = getIdempotencyResult<HttpResponse<"completion">>(this.options.database, idempotencyKey);
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        throw new PersistenceConflictError(
          PersistenceConflict.IDEMPOTENCY_CONFLICT,
          "Completion callback key was reused with different content",
        );
      }
      return this.duplicate(policy.missionId, report.reportSha256, idempotencyKey);
    }
    if (
      report.missionId !== policy.missionId
      || report.targetSha256 !== policy.targetSha256
      || report.providerId !== policy.provider.id
      || reportHash(report) !== report.reportSha256
    ) throw new CompletionError(ErrorCode.REPORT_BINDING_MISMATCH, 400, "Report is not bound to the selected mission and provider");
    if (outcome.settlementTxId === undefined) {
      throw new CompletionError(ErrorCode.REPORT_BINDING_MISMATCH, 400, "Completion carries no settlement transaction");
    }

    if (getMissionCompletion(this.options.database, policy.missionId) !== undefined) {
      throw new PersistenceConflictError(
        PersistenceConflict.IDEMPOTENCY_CONFLICT,
        "Mission already has a different completion",
      );
    }
    const mission = getMission(this.options.database, policy.missionId);
    if (mission === undefined) throw new CompletionError(ErrorCode.MISSION_POLICY_MISSING, 403, "Mission is not available");
    if (mission.state !== "running") {
      if ([
        "created",
        "discovering-services",
        "credit-requested",
        "funded",
        "payment-preparation",
        "payment-authorized",
        "service-paid",
      ].includes(mission.state)) {
        throw new CompletionError(
          ErrorCode.SETTLEMENT_UNCONFIRMED,
          503,
          "Mission has not reached its callback-ready state",
        );
      }
      throw new IllegalStateTransitionError(mission.state, "completed");
    }

    let settlement: { readonly settledAt: string };
    try {
      settlement = await this.options.settlementConfirmer.confirm({
        transactionId: outcome.settlementTxId,
        payerAccountId: policy.borrowerAccountId,
        recipientAccountId: policy.provider.accountId,
        amountTinybar: policy.provider.priceTinybar,
      });
    } catch (error) {
      throw settlementConfirmationError(error);
    }
    await this.options.signerCompletion.complete(raw);

    const response = CallbackResponseSchema.parse({ status: "accepted" });
    try {
      await this.options.stateMachine.transition(
        policy.missionId,
        "running",
        "completed",
        {
          type: "callback-received",
          payload: { reportSha256: report.reportSha256, settlementTxId: outcome.settlementTxId },
          transactionId: outcome.settlementTxId,
        },
        () => {
          saveMissionCompletion(this.options.database, {
            missionId: policy.missionId,
            reportSha256: report.reportSha256,
            settlementTxId: outcome.settlementTxId!,
            settlementPayerAccountId: policy.borrowerAccountId,
            settlementRecipientAccountId: policy.provider.accountId,
            settlementAsset: "0.0.0",
            settlementAmountTinybar: policy.provider.priceTinybar,
            settlementConfirmedAt: settlement.settledAt,
            callbackBodySha256: sha256Hex(raw.body),
            acceptedAt: this.now().toISOString(),
          });
          createIdempotencyResult(this.options.database, {
            key: idempotencyKey,
            requestHash,
            statusCode: 202,
            response,
            createdAt: this.now().toISOString(),
          });
        },
      );
    } catch (error) {
      const concurrent = getIdempotencyResult<HttpResponse<"completion">>(this.options.database, idempotencyKey);
      if (concurrent?.requestHash === requestHash) {
        return this.duplicate(policy.missionId, report.reportSha256, idempotencyKey);
      }
      throw error;
    }
    return { missionId: policy.missionId, response };
  }
}
