import type { HttpResponse } from "@koven/schemas";

type Mission = HttpResponse<"missionDetail">;
type SignerHealth = HttpResponse<"health">;

/** Frozen by the x402 requirement contract: HBAR on Hedera testnet is the only accepted rail. */
export const PAYMENT_NETWORK = "hedera:testnet";
export const PAYMENT_ASSET = "0.0.0";

export type PaymentStatus = "pending" | "authorized" | "settled" | "rejected" | "failed";
export type ProofStatus = "not-generated" | "generated" | "verified" | "rejected" | "deterministic";

export interface PaymentEvidenceView {
  readonly missionId: string;
  readonly status: PaymentStatus;
  readonly proof: ProofStatus;
  /** Signer-declared circuit and pinned key hash; `null` hash means the deterministic M2 gate. */
  readonly circuitId: string;
  readonly vkeyHash: string | null;
  /** The mission spending cap the proof was made under. */
  readonly capTinybar: string;
  readonly approvedRecipientsRoot: string;
  readonly targetSha256: string;
  /** The x402 payment transaction, present once the signer authorized it. */
  readonly transactionId?: string;
  readonly authorizedAt?: string;
  readonly settledAt?: string;
  readonly rejectedAt?: string;
  readonly proofGeneratedAt?: string;
}

const eventOf = (mission: Mission, type: Mission["events"][number]["type"]) => mission.events.find(event => event.type === type);

/**
 * Derives the payment rail view from validated read models only: the mission
 * detail (public event references) and the signer's health. Nothing is
 * recomputed or guessed; a value the contracts do not expose stays absent.
 */
export function derivePaymentEvidence(mission: Mission, health: SignerHealth | undefined): PaymentEvidenceView {
  const proofGenerated = eventOf(mission, "proof-generated");
  const authorized = eventOf(mission, "payment-authorized");
  const settled = eventOf(mission, "x402-settled");
  const rejected = eventOf(mission, "payment-rejected");
  const failedBeforePayment = mission.events.some(event => event.type === "mission-failed") && authorized === undefined;

  const status: PaymentStatus = settled !== undefined ? "settled"
    : authorized !== undefined ? "authorized"
    : rejected !== undefined ? "rejected"
    : failedBeforePayment ? "failed"
    : "pending";
  const zk = health === undefined ? proofGenerated !== undefined : health.vkeyHash !== null;
  const proof: ProofStatus = !zk && proofGenerated === undefined ? "deterministic"
    : rejected !== undefined && authorized === undefined ? "rejected"
    : authorized !== undefined && proofGenerated !== undefined ? "verified"
    : proofGenerated !== undefined ? "generated"
    : "not-generated";

  const transactionId = settled?.transactionId ?? authorized?.transactionId;
  return {
    missionId: mission.id,
    status,
    proof,
    circuitId: health?.circuitId ?? "koven-policy-v1",
    vkeyHash: health?.vkeyHash ?? null,
    capTinybar: mission.spendingCapTinybar,
    approvedRecipientsRoot: mission.approvedRecipientsRoot,
    targetSha256: mission.targetSha256,
    ...(transactionId === undefined ? {} : { transactionId }),
    ...(authorized === undefined ? {} : { authorizedAt: authorized.occurredAt }),
    ...(settled === undefined ? {} : { settledAt: settled.occurredAt }),
    ...(rejected === undefined ? {} : { rejectedAt: rejected.occurredAt }),
    ...(proofGenerated === undefined ? {} : { proofGeneratedAt: proofGenerated.occurredAt }),
  };
}
