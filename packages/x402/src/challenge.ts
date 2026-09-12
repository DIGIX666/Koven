import { createHash } from "node:crypto";

import { ErrorCode, type NormalizedChallenge, type PaymentRequirements } from "@koven/domain";
import { HttpUrl, Id, Nonce, PaymentRequirementsSchema, Sha256 } from "@koven/schemas";

/**
 * Pure challenge normalization. No I/O: this module is the most
 * security-sensitive one in the repo and must stay testable in isolation.
 * Every value here is recomputed from the raw x402 requirements and trusted
 * mission context; nothing is taken from a caller-supplied normalised form.
 */

export const CHALLENGE_METHOD = "POST";

export interface ChallengePolicy {
  readonly network: "hedera:testnet";
  readonly asset: "0.0.0";
}

export const DEFAULT_CHALLENGE_POLICY: ChallengePolicy = Object.freeze({
  network: "hedera:testnet",
  asset: "0.0.0",
});

export interface ChallengeContext {
  /** Validated absolute provider scan URL the request was sent to. */
  readonly scanUrl: string;
  readonly policy?: ChallengePolicy;
}

export class ChallengeRejectedError extends Error {
  readonly code = ErrorCode.CHALLENGE_BINDING_MISMATCH;

  constructor(readonly reason: string) {
    super(`x402 challenge rejected: ${reason}`);
    this.name = "ChallengeRejectedError";
  }
}

function reject(reason: string): never {
  throw new ChallengeRejectedError(reason);
}

/** Exact UTF-8 resource string frozen in docs/zk-spike.md; no normalization is applied. */
export function canonicalResourceString(
  method: string,
  url: string,
  missionId: string,
  targetSha256: string,
): string {
  return `${method} ${url}\n${missionId}\n${targetSha256}`;
}

/** Full SHA-256 of the canonical resource string, as carried in `NormalizedChallenge`. */
export function resourceHashHex(scanUrl: string, missionId: string, targetSha256: string): string {
  return createHash("sha256")
    .update(canonicalResourceString(CHALLENGE_METHOD, scanUrl, missionId, targetSha256), "utf8")
    .digest("hex");
}

/**
 * Accepts only the frozen exact-HBAR requirement subset for the configured
 * network and asset. Unknown schemes, other networks or assets, a missing fee
 * payer, extra fields and a non-decimal or zero amount are all rejected so
 * that nothing unnormalisable can reach the prover or signer.
 */
export function assertAcceptableRequirements(
  requirements: unknown,
  policy: ChallengePolicy = DEFAULT_CHALLENGE_POLICY,
): PaymentRequirements {
  const parsed = PaymentRequirementsSchema.safeParse(requirements);
  if (!parsed.success) {
    const candidate = typeof requirements === "object" && requirements !== null
      ? requirements as Record<string, unknown>
      : {};
    if (candidate.scheme !== "exact") reject("unsupported payment scheme");
    if (candidate.network !== policy.network) reject("unsupported network");
    if (candidate.asset !== policy.asset) reject("unsupported asset");
    const extra = candidate.extra;
    if (typeof extra !== "object" || extra === null || typeof (extra as Record<string, unknown>).feePayer !== "string") {
      reject("fee payer is missing");
    }
    reject("requirements do not match the frozen exact HBAR contract");
  }
  const accepted: PaymentRequirements = parsed.data;
  if (accepted.network !== policy.network) reject("unsupported network");
  if (accepted.asset !== policy.asset) reject("unsupported asset");
  if (accepted.amount === "0") reject("zero-priced challenge");
  return accepted;
}

/** Normalises an acceptable challenge against trusted mission context. */
export function normalizeChallenge(
  requirements: unknown,
  missionId: string,
  targetSha256: string,
  nonce: string,
  context: ChallengeContext,
): NormalizedChallenge {
  if (!Id.safeParse(missionId).success) reject("mission id is malformed");
  if (!Sha256.safeParse(targetSha256).success) reject("target hash is malformed");
  if (!Nonce.safeParse(nonce).success) reject("nonce is not a canonical decimal below 2^248");
  if (!HttpUrl.safeParse(context.scanUrl).success) reject("scan URL is not an absolute HTTP URL");
  const accepted = assertAcceptableRequirements(requirements, context.policy);

  return {
    amountTinybar: BigInt(accepted.amount),
    recipientAccountId: accepted.payTo,
    nonce,
    resourceHash: resourceHashHex(context.scanUrl, missionId, targetSha256),
    missionId,
  };
}

/** Poseidon over BN254 with Circomlib parameters; provided by `loadPoseidon()`. */
export type FieldHasher = (inputs: readonly bigint[]) => bigint;

export interface ChallengeFieldInputs {
  readonly amount: bigint;
  readonly recipient: bigint;
  readonly nonce: bigint;
  readonly resourceHash: bigint;
}

const ACCOUNT_ID = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const UINT64_MAX = (1n << 64n) - 1n;

/** `Poseidon([shard, realm, num])` over a canonical numeric account ID (docs/zk-spike.md). */
export function accountFieldElement(accountId: string, poseidon: FieldHasher): bigint {
  const match = ACCOUNT_ID.exec(accountId);
  if (!match) reject("recipient is not a canonical numeric account id");
  const parts = [match[1]!, match[2]!, match[3]!].map(part => BigInt(part));
  if (parts.some(part => part > UINT64_MAX)) reject("recipient account component exceeds 64 bits");
  return poseidon(parts);
}

/** Top 248 bits of the SHA-256 digest: the first 62 hex characters as a big-endian integer. */
export function resourceHashFieldElement(resourceHashHexValue: string): bigint {
  if (!Sha256.safeParse(resourceHashHexValue).success) reject("resource hash is malformed");
  return BigInt(`0x${resourceHashHexValue.slice(0, 62)}`);
}

/** Circuit witness encodings frozen in docs/zk-spike.md, derived from a normalised challenge. */
export function challengeToFieldInputs(
  challenge: NormalizedChallenge,
  poseidon: FieldHasher,
): ChallengeFieldInputs {
  if (challenge.amountTinybar < 0n || challenge.amountTinybar > UINT64_MAX) reject("amount exceeds 64 bits");
  if (!Nonce.safeParse(challenge.nonce).success) reject("nonce is not a canonical decimal below 2^248");
  return {
    amount: challenge.amountTinybar,
    recipient: accountFieldElement(challenge.recipientAccountId, poseidon),
    nonce: BigInt(challenge.nonce),
    resourceHash: resourceHashFieldElement(challenge.resourceHash),
  };
}

/** Public signal zero: `Poseidon([amount, recipient, nonce, resourceHash])`. */
export function paymentCommitment(inputs: ChallengeFieldInputs, poseidon: FieldHasher): bigint {
  return poseidon([inputs.amount, inputs.recipient, inputs.nonce, inputs.resourceHash]);
}
