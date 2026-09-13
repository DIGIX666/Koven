import { CreditProtocolError } from "@koven/credit-protocol";
import { ErrorCode, type CreditOffer, type ProofBundle } from "@koven/domain";
import type { HttpRequest } from "@koven/schemas";
import { challengeToFieldInputs, type FieldHasher, paymentCommitment, resourceHashHex } from "@koven/x402";
import { buildMerkleTree, type Groth16Verifier, loadPinnedVerificationKey, verifyProofBundle } from "@koven/zk-policy";

import type { MissionPolicy } from "./store.js";

export type LenderProofMode = "deterministic" | "zk";

/** The lender's own verification key, loaded and hash-pinned from its own configuration; never taken from a borrower. */
export interface LenderTrustedVerificationKey {
  readonly verificationKey: object;
  readonly vkeyHash: string;
}

export interface LenderProofVerifierOptions {
  readonly poseidon: FieldHasher;
  readonly trusted: LenderTrustedVerificationKey;
  /** Test seam only; production uses the real Groth16 verifier. */
  readonly verifier?: Groth16Verifier;
}

type PaymentIntentWire = NonNullable<HttpRequest<"accept">["paymentIntent"]>;

const PROOF_FAILURE_DETAIL: Record<string, string> = {
  [ErrorCode.CIRCUIT_ID_MISMATCH]: "Proof bundle targets another circuit",
  [ErrorCode.PROOF_VKEY_MISMATCH]: "Proof bundle does not reference the lender's pinned verification key",
  [ErrorCode.PROOF_INVALID]: "Proof does not verify under the lender's verification key",
  [ErrorCode.CHALLENGE_BINDING_MISMATCH]: "Proof is not bound to the signed payment intent",
  [ErrorCode.RECIPIENT_NOT_APPROVED]: "Proof root is not the mission's approved recipient root",
  [ErrorCode.CAP_EXCEEDED]: "Proof cap exceeds the mission spending cap",
};

/**
 * M3 independent verification at `POST /credit/accept`. Every expected value
 * is recomputed from the lender-local registrar policy and the stored offer:
 * the singleton provider root, the resource hash from the stored source hash,
 * mission and provider `/scan` URL, and the commitment from the signed intent.
 * Proof signals and borrower-supplied data never establish the expectation.
 */
export class LenderProofVerifier {
  constructor(private readonly options: LenderProofVerifierOptions) {}

  get vkeyHash(): string {
    return this.options.trusted.vkeyHash;
  }

  /** The singleton recipient root the registrar policy must carry for its selected provider. */
  rootFor(providerAccountId: string): string {
    return buildMerkleTree([providerAccountId], this.options.poseidon).root;
  }

  /**
   * Refuses funding unless the signed intent describes the payment the policy
   * allows (`mission_policy_mismatch`) and the bundle is a valid proof of it
   * under the lender's own key (frozen proof codes).
   */
  async assertAcceptanceEvidence(
    policy: MissionPolicy,
    offer: CreditOffer,
    paymentIntent: PaymentIntentWire,
    paymentProofBundle: ProofBundle,
  ): Promise<void> {
    const amountTinybar = BigInt(paymentIntent.amountTinybar);
    const expectedRoot = this.rootFor(policy.provider.accountId);
    if (
      paymentIntent.missionId !== policy.missionId
      || paymentIntent.recipientAccountId !== policy.provider.accountId
      || paymentIntent.resourceHash !== resourceHashHex(`${policy.provider.endpoint}/scan`, policy.missionId, policy.targetSha256)
      || amountTinybar > BigInt(policy.spendingCapTinybar)
      || amountTinybar > offer.principalTinybar
      || policy.approvedRecipientsRoot !== expectedRoot
    ) {
      throw new CreditProtocolError(
        ErrorCode.MISSION_POLICY_MISMATCH,
        "Payment intent does not match the registered mission policy and accepted offer",
      );
    }
    const challenge = { ...paymentIntent, amountTinybar };
    const commitment = paymentCommitment(challengeToFieldInputs(challenge, this.options.poseidon), this.options.poseidon).toString(10);
    const result = await verifyProofBundle(paymentProofBundle, {
      vkey: this.options.trusted.verificationKey,
      vkeyHash: this.options.trusted.vkeyHash,
      approvedRoot: expectedRoot,
      maxCapTinybar: BigInt(policy.spendingCapTinybar),
    }, { commitment }, ...(this.options.verifier ? [this.options.verifier] : []));
    if (!result.ok) {
      throw new CreditProtocolError(result.code, PROOF_FAILURE_DETAIL[result.code] ?? "Proof bundle was refused");
    }
  }
}

type EnvironmentSource = Record<string, string | undefined>;

/**
 * Reads the lender's proof mode and, in zk mode, its own verification key and
 * reviewed pin (`LENDER_VERIFICATION_KEY_PATH`, `LENDER_TRUSTED_VKEY_SHA256`).
 * Startup fails when the key file hashes differently from the pin.
 */
export function loadLenderVerification(source: EnvironmentSource = process.env): {
  proofMode: LenderProofMode;
  trusted?: LenderTrustedVerificationKey;
} {
  const proofMode = source.LENDER_PROOF_MODE || "deterministic";
  if (proofMode !== "deterministic" && proofMode !== "zk") throw new Error("LENDER_PROOF_MODE must be deterministic or zk");
  if (proofMode === "deterministic") return { proofMode };
  const keyPath = source.LENDER_VERIFICATION_KEY_PATH;
  const pin = source.LENDER_TRUSTED_VKEY_SHA256;
  if (!keyPath || !pin) throw new Error("zk mode requires LENDER_VERIFICATION_KEY_PATH and LENDER_TRUSTED_VKEY_SHA256");
  return { proofMode, trusted: loadPinnedVerificationKey(keyPath, pin) };
}
