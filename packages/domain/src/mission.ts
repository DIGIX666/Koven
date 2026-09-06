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
  | "policy-rejected"
  | "recovery"
  | "failed"
  | "defaulted"
  | "closed";

export interface Mission {
  id: string;
  state: MissionState;
  spendingCapTinybar: bigint;
  spentTinybar: bigint;
  approvedRecipientsRoot: string;
  targetRef: string;
  targetSha256: string;
  createdAt: string;
  updatedAt: string;
}

