import { ErrorCode, type NormalizedChallenge, type ProofBundle } from "@koven/domain";
import { challengeToFieldInputs, type FieldHasher, paymentCommitment } from "@koven/x402";
import { buildMerkleTree, type Groth16Verifier, verifyProofBundle } from "@koven/zk-policy";

import { fail } from "./errors.js";
import type { MissionPolicy } from "./store.js";

export type ProofMode = "deterministic" | "zk";

/** The signer's own verification key, loaded and hash-pinned at startup; never taken from a request. */
export interface TrustedVerificationKey {
  readonly verificationKey: object;
  readonly vkeyHash: string;
}

export interface ProofPolicyOptions {
  readonly poseidon: FieldHasher;
  readonly trusted: TrustedVerificationKey;
  /** Test seam only; production uses the real Groth16 verifier. */
  readonly verifier?: Groth16Verifier;
}

/**
 * M3 proof enforcement shared by `/authorize` and `/sign-credit-acceptance`.
 * Every expected value is recomputed from the trusted mission policy and the
 * normalized challenge; nothing the caller supplies becomes an expectation.
 */
export class ProofPolicy {
  constructor(private readonly options: ProofPolicyOptions) {}

  get vkeyHash(): string {
    return this.options.trusted.vkeyHash;
  }

  /** The singleton recipient root a mission policy must carry for its selected provider. */
  rootFor(providerAccountId: string): string {
    return buildMerkleTree([providerAccountId], this.options.poseidon).root;
  }

  commitmentFor(challenge: NormalizedChallenge): string {
    return paymentCommitment(challengeToFieldInputs(challenge, this.options.poseidon), this.options.poseidon).toString(10);
  }

  /**
   * Verifies a bundle against this signer's key hash, the commitment computed
   * from the challenge, the mission's stored root and its spending cap, in the
   * frozen order. Failures carry the frozen proof error codes.
   */
  async assertProof(bundle: ProofBundle, policy: MissionPolicy, challenge: NormalizedChallenge): Promise<string> {
    const commitment = this.commitmentFor(challenge);
    const result = await verifyProofBundle(bundle, {
      vkey: this.options.trusted.verificationKey,
      vkeyHash: this.options.trusted.vkeyHash,
      approvedRoot: policy.approvedRecipientsRoot,
      maxCapTinybar: BigInt(policy.spendingCapTinybar),
    }, { commitment }, ...(this.options.verifier ? [this.options.verifier] : []));
    if (!result.ok) {
      const detail = {
        [ErrorCode.CIRCUIT_ID_MISMATCH]: "Proof bundle targets another circuit",
        [ErrorCode.PROOF_VKEY_MISMATCH]: "Proof bundle does not reference the signer's pinned verification key",
        [ErrorCode.PROOF_INVALID]: "Policy proof does not verify",
        [ErrorCode.CHALLENGE_BINDING_MISMATCH]: "Policy proof is not bound to this payment challenge",
        [ErrorCode.RECIPIENT_NOT_APPROVED]: "Policy proof root is not the mission's approved recipient root",
        [ErrorCode.CAP_EXCEEDED]: "Policy proof cap exceeds the mission spending cap",
      }[result.code];
      fail(result.code, detail);
    }
    // A3.3: the proof must have been made under this mission's cap, not merely a smaller one.
    if (bundle.publicSignals[2] !== policy.spendingCapTinybar) {
      fail(ErrorCode.MISSION_POLICY_MISMATCH, "Policy proof cap is not the mission spending cap");
    }
    return commitment;
  }
}
