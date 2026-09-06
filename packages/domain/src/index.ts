export type MissionState =
  | "created"
  | "discovering-services"
  | "credit-requested"
  | "funded"
  | "payment-preparation"
  | "payment-authorized"
  | "service-paid"
  | "running"
  | "completed"
  | "repayment-pending"
  | "repaid"
  | "failed"
  | "defaulted"
  | "closed";

export interface Mission {
  id: string;
  state: MissionState;
  spendingCapTinybar: bigint;
  spentTinybar: bigint;
  approvedRecipientsRoot: string;
  createdAt: string;
  updatedAt: string;
}

export interface Provider {
  id: string;
  accountId: string;
  endpoint: string;
  capability: string;
  priceTinybar: bigint;
  reputationScore: number;
  expectedLatencyMs: number;
}

export interface CreditOffer {
  id: string;
  requestId: string;
  lenderAccountId: string;
  principalTinybar: bigint;
  feeTinybar: bigint;
  expiresAt: string;
  termsHash: string;
  signature: string;
}

