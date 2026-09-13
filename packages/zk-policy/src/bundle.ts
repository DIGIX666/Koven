import { createHash } from "node:crypto";

import type { ProofBundle } from "@koven/domain";
import { ProofBundleSchema } from "@koven/schemas";

/** Circuit identity frozen in docs/zk-spike.md; a new statement or signal order needs a new ID. */
export const CIRCUIT_ID = "koven-policy-v1";

export type { ProofBundle };
export type Groth16Proof = ProofBundle["proof"];
/** `[commitment, root, cap]`, canonical decimal field elements. */
export type PublicSignals = ProofBundle["publicSignals"];

/** Validates the wire shape only; shape validity never establishes proof validity. */
export function parseProofBundle(value: unknown): ProofBundle {
  return ProofBundleSchema.parse(value);
}

/**
 * SHA-256 of the exact `verification_key.json` bytes, as pinned in the
 * artifact manifest. Callers hash the file they loaded, never a reserialized
 * JSON object, and never trust the hash a bundle claims.
 */
export function verificationKeyHash(fileBytes: Uint8Array): string {
  return createHash("sha256").update(fileBytes).digest("hex");
}
