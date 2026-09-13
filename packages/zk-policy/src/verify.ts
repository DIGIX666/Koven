import { ErrorCode } from "@koven/domain";
import { ProofBundleSchema } from "@koven/schemas";

import { CIRCUIT_ID, type Groth16Proof, type ProofBundle } from "./bundle.js";
import { snarkjsGroth16Verifier } from "./prove.js";

/** Groth16 verification over BN254. Pure: it receives the caller's own key object. */
export interface Groth16Verifier {
  verify(verificationKey: object, publicSignals: readonly string[], proof: Groth16Proof): Promise<boolean>;
}

/**
 * Fail-closed adapter: every bundle is `proof_invalid`. Use it wherever a
 * deployment must refuse proofs outright; the production default is
 * `snarkjsGroth16Verifier`. Only tests may inject another verifier, and they
 * must name it explicitly.
 */
export const unavailableGroth16Verifier: Groth16Verifier = {
  async verify() {
    return false;
  },
};

export interface TrustedVerificationInputs {
  /** The verifier's own verification key object, loaded from its own configuration. */
  readonly vkey: object;
  /** The verifier's own SHA-256 of the exact key file bytes; the bundle's claim is compared to this. */
  readonly vkeyHash: string;
  /** The approved recipients root the verifier derived from its own trusted policy. */
  readonly approvedRoot: string;
  /** The largest cap the verifier's policy allows the proof to have used. */
  readonly maxCapTinybar: bigint;
}

export interface ExpectedBinding {
  /** The commitment the verifier computed itself from the normalized challenge. */
  readonly commitment: string;
}

export type VerificationCode =
  | typeof ErrorCode.CIRCUIT_ID_MISMATCH
  | typeof ErrorCode.PROOF_VKEY_MISMATCH
  | typeof ErrorCode.PROOF_INVALID
  | typeof ErrorCode.CHALLENGE_BINDING_MISMATCH
  | typeof ErrorCode.RECIPIENT_NOT_APPROVED
  | typeof ErrorCode.CAP_EXCEEDED;

export type VerificationResult = { ok: true } | { ok: false; code: VerificationCode };

const DECIMAL = /^(0|[1-9]\d*)$/;

/**
 * Independent verification of a policy proof, safe to run inside a lender
 * process: no file I/O, no network, and nothing taken from the bundle as an
 * expectation. Checks run in the frozen order and stop at the first failure:
 * circuit ID, the caller's own key hash, Groth16 verification (real
 * `snarkjs.groth16.verify` by default), commitment binding, approved root,
 * then cap.
 */
export async function verifyProofBundle(
  bundle: ProofBundle,
  trusted: TrustedVerificationInputs,
  expected: ExpectedBinding,
  verifier: Groth16Verifier = snarkjsGroth16Verifier,
): Promise<VerificationResult> {
  const parsed = ProofBundleSchema.safeParse(bundle);
  if (!parsed.success) return { ok: false, code: ErrorCode.PROOF_INVALID };
  const candidate = parsed.data;

  if (candidate.circuitId !== CIRCUIT_ID) return { ok: false, code: ErrorCode.CIRCUIT_ID_MISMATCH };
  if (!/^[0-9a-f]{64}$/.test(trusted.vkeyHash) || candidate.vkeyHash !== trusted.vkeyHash) {
    return { ok: false, code: ErrorCode.PROOF_VKEY_MISMATCH };
  }

  let valid: boolean;
  try {
    valid = await verifier.verify(trusted.vkey, candidate.publicSignals, candidate.proof);
  } catch {
    valid = false;
  }
  if (valid !== true) return { ok: false, code: ErrorCode.PROOF_INVALID };

  const [commitment, root, cap] = candidate.publicSignals;
  if (!DECIMAL.test(expected.commitment) || commitment !== expected.commitment) {
    return { ok: false, code: ErrorCode.CHALLENGE_BINDING_MISMATCH };
  }
  if (!DECIMAL.test(trusted.approvedRoot) || root !== trusted.approvedRoot) {
    return { ok: false, code: ErrorCode.RECIPIENT_NOT_APPROVED };
  }
  if (trusted.maxCapTinybar < 0n || BigInt(cap) > trusted.maxCapTinybar) {
    return { ok: false, code: ErrorCode.CAP_EXCEEDED };
  }
  return { ok: true };
}
