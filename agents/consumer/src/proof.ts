import { ErrorCode, type NormalizedChallenge, type ProofBundle } from "@koven/domain";
import { type FieldHasher, loadPoseidon, X402RequestError } from "@koven/x402";
import {
  buildWitness,
  loadOfficialArtifacts,
  type MissionPolicy,
  prove,
  type ProverArtifacts,
  WitnessError,
} from "@koven/zk-policy";

import { ConsumerServiceError } from "./credit.js";

/** Signer, lender or witness refusals that are policy decisions, not failures. */
export const POLICY_REJECTION_CODES = new Set<string>([
  ErrorCode.CAP_EXCEEDED,
  ErrorCode.CUMULATIVE_BUDGET_EXCEEDED,
  ErrorCode.RECIPIENT_NOT_APPROVED,
  ErrorCode.PROOF_INVALID,
  ErrorCode.PROOF_VKEY_MISMATCH,
  ErrorCode.CIRCUIT_ID_MISMATCH,
  ErrorCode.CHALLENGE_BINDING_MISMATCH,
  ErrorCode.MISSION_POLICY_MISSING,
  ErrorCode.MISSION_POLICY_MISMATCH,
]);

/** A policy rejection surfaced with its frozen error code so the orchestrator can route it to recovery. */
export class ConsumerPolicyRejectedError extends Error {
  constructor(readonly code: string, detail: string) {
    super(detail);
    this.name = "ConsumerPolicyRejectedError";
  }
}

/** Re-throws service or witness refusals that carry a policy code as `ConsumerPolicyRejectedError`. */
export function rethrowPolicyRejection(error: unknown): never {
  if (error instanceof ConsumerPolicyRejectedError) throw error;
  if ((error instanceof ConsumerServiceError || error instanceof X402RequestError || error instanceof WitnessError)
    && POLICY_REJECTION_CODES.has(error.code)) {
    throw new ConsumerPolicyRejectedError(error.code, error.message);
  }
  throw error;
}

export interface ConsumerProver {
  prove(challenge: NormalizedChallenge, policy: MissionPolicy): Promise<ProofBundle>;
}

export interface ZkPolicyProverOptions {
  /** Verified official artifacts; loaded on first use when omitted. */
  readonly artifacts?: ProverArtifacts;
  readonly poseidon?: FieldHasher;
}

/**
 * Builds the witness from the mission policy and proves it with the official
 * artifacts. Over-cap amounts and unapproved recipients fail at witness
 * construction as policy rejections, before any proving work.
 */
export class ZkPolicyProver implements ConsumerProver {
  private artifacts: ProverArtifacts | undefined;
  private poseidon: FieldHasher | undefined;

  constructor(options: ZkPolicyProverOptions = {}) {
    this.artifacts = options.artifacts;
    this.poseidon = options.poseidon;
  }

  async prove(challenge: NormalizedChallenge, policy: MissionPolicy): Promise<ProofBundle> {
    this.artifacts ??= loadOfficialArtifacts();
    this.poseidon ??= await loadPoseidon();
    try {
      return await prove(buildWitness(policy, challenge, this.poseidon).input, this.artifacts);
    } catch (error) {
      rethrowPolicyRejection(error);
    }
  }
}

/** Wire form of a normalized challenge: the `paymentIntent` bound into the credit acceptance. */
export const paymentIntentWire = (challenge: NormalizedChallenge) => ({
  amountTinybar: challenge.amountTinybar.toString(10),
  recipientAccountId: challenge.recipientAccountId,
  nonce: challenge.nonce,
  resourceHash: challenge.resourceHash,
  missionId: challenge.missionId,
});
