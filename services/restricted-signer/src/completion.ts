import { createHmac, timingSafeEqual } from "node:crypto";

import { ErrorCode } from "@koven/domain";
import {
  CALLBACK_CLOCK_SKEW_SECONDS,
  CallbackHeadersSchema,
  CallbackResponseSchema,
  CompletionCallbackSchema,
  type HttpResponse,
} from "@koven/schemas";

import { canonicalJson, sha256Hex } from "./canonical.js";
import { fail } from "./errors.js";
import type { TransferConfirmer } from "./ledger.js";
import type { SignerStore } from "./store.js";

export interface CompletionServiceOptions {
  readonly store: SignerStore;
  readonly accountId: string;
  readonly providerCallbackSecrets: Readonly<Record<string, Uint8Array>>;
  readonly confirmer: TransferConfirmer;
  readonly now?: () => Date;
}

export interface RawCallback {
  /** Exact request bytes; the MAC and the idempotency hash cover these, never a reserialization. */
  readonly body: Uint8Array;
  readonly headers: Readonly<Record<string, string | undefined>>;
}

export function callbackSignature(secret: Uint8Array, timestamp: string, idempotencyKey: string, body: Uint8Array): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${idempotencyKey}.`, "utf8")
    .update(body)
    .digest("hex");
}

/**
 * Independent completion check for `/internal/missions/complete`: the
 * orchestrator forwards the provider's raw callback and headers, and this
 * service re-verifies the provider MAC, the report binding to the stored
 * mission policy, and the settlement on the ledger before the mission becomes
 * repayable. An orchestrator state flag never substitutes for this.
 */
export class CompletionService {
  private readonly now: () => Date;

  constructor(private readonly options: CompletionServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async complete(raw: RawCallback): Promise<HttpResponse<"signerCompletion">> {
    const headers = CallbackHeadersSchema.safeParse({
      "idempotency-key": raw.headers["idempotency-key"],
      "x-callback-timestamp": raw.headers["x-callback-timestamp"],
      "x-callback-signature": raw.headers["x-callback-signature"],
    });
    if (!headers.success) fail(ErrorCode.CALLBACK_AUTH_INVALID, "Callback headers are missing or malformed");
    const timestamp = headers.data["x-callback-timestamp"];
    const idempotencyKey = headers.data["idempotency-key"];
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    if (Math.abs(nowSeconds - Number(timestamp)) > CALLBACK_CLOCK_SKEW_SECONDS) {
      fail(ErrorCode.CALLBACK_AUTH_INVALID, "Callback timestamp is outside the accepted window");
    }

    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(Buffer.from(raw.body).toString("utf8"));
    } catch {
      fail(ErrorCode.CALLBACK_AUTH_INVALID, "Callback body is not valid JSON");
    }
    const callback = CompletionCallbackSchema.safeParse(parsedBody);
    if (!callback.success) fail(ErrorCode.REPORT_SCHEMA_INVALID, "Callback does not match the completion contract");
    const { outcome, report } = callback.data;
    if (idempotencyKey !== `mission-complete:${outcome.missionId}:${report.reportSha256}`) {
      fail(ErrorCode.CALLBACK_AUTH_INVALID, "Idempotency key does not match the callback body");
    }

    const policy = this.options.store.getMissionPolicy(outcome.missionId);
    if (policy === undefined) fail(ErrorCode.MISSION_POLICY_MISSING, "Mission policy is not provisioned");
    const secret = this.options.providerCallbackSecrets[policy.provider.id];
    if (secret === undefined) fail(ErrorCode.CALLBACK_AUTH_INVALID, "No callback secret is pinned for the selected provider");
    const expected = Buffer.from(callbackSignature(secret, timestamp, idempotencyKey, raw.body), "hex");
    const presented = Buffer.from(headers.data["x-callback-signature"], "hex");
    if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
      fail(ErrorCode.CALLBACK_AUTH_INVALID, "Callback signature is invalid");
    }

    const { reportSha256, ...unsigned } = report;
    if (
      report.providerId !== policy.provider.id
      || report.missionId !== policy.missionId
      || report.targetSha256 !== policy.targetSha256
      || sha256Hex(Buffer.from(canonicalJson(unsigned), "utf8")) !== reportSha256
    ) fail(ErrorCode.REPORT_BINDING_MISMATCH, "Report is not bound to the stored mission and provider");

    const settlementTxId = outcome.settlementTxId;
    if (settlementTxId === undefined) fail(ErrorCode.REPORT_BINDING_MISMATCH, "Delivered outcome carries no settlement");
    const authorization = this.options.store.getAuthorizationByTransactionId(settlementTxId);
    if (authorization === undefined || authorization.missionId !== policy.missionId) {
      fail(ErrorCode.REPORT_BINDING_MISMATCH, "Settlement was not authorized by this signer for the mission");
    }
    await this.options.confirmer.confirm({
      transactionId: settlementTxId,
      payerAccountId: this.options.accountId,
      recipientAccountId: policy.provider.accountId,
      amountTinybar: BigInt(authorization.authorization.amountTinybar),
    });

    const status = this.options.store.recordCompletion(
      { missionId: policy.missionId, reportSha256, settlementTxId, acceptedAt: this.now().toISOString() },
      idempotencyKey,
      sha256Hex(Buffer.concat([Buffer.from(`${idempotencyKey}.`, "utf8"), Buffer.from(raw.body)])),
    );
    return CallbackResponseSchema.parse(
      status === "accepted" ? { status: "accepted" } : { status: "duplicate", code: ErrorCode.CALLBACK_DUPLICATE },
    );
  }
}
