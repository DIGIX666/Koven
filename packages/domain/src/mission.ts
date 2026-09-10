import { ErrorCode } from "./errors.js";

export const MISSION_STATES = [
  "created",
  "discovering-services",
  "credit-requested",
  "funded",
  "payment-preparation",
  "payment-authorized",
  "service-paid",
  "running",
  "completed",
  "repayment-pending",
  "repaid",
  "policy-rejected",
  "recovery",
  "failed",
  "defaulted",
  "closed",
] as const;

export type MissionState = (typeof MISSION_STATES)[number];

export const ALLOWED_TRANSITIONS = {
  created: ["discovering-services", "failed"],
  "discovering-services": ["payment-preparation", "credit-requested", "failed"],
  "credit-requested": ["funded", "failed"],
  funded: ["payment-preparation", "failed"],
  "payment-preparation": ["payment-authorized", "policy-rejected", "failed"],
  "payment-authorized": ["service-paid", "failed"],
  "service-paid": ["running", "failed"],
  running: ["completed", "failed"],
  completed: ["repayment-pending", "closed"],
  "repayment-pending": ["repaid", "defaulted"],
  repaid: ["closed"],
  "policy-rejected": ["recovery"],
  recovery: ["repayment-pending", "defaulted", "closed"],
  failed: ["recovery", "repayment-pending", "defaulted", "closed"],
  defaulted: [],
  closed: [],
} as const satisfies Readonly<Record<MissionState, readonly MissionState[]>>;

export class IllegalStateTransitionError extends Error {
  readonly code = ErrorCode.ILLEGAL_STATE_TRANSITION;

  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal mission state transition: ${from} -> ${to}`);
    this.name = "IllegalStateTransitionError";
  }
}

export function assertTransition(from: MissionState, to: MissionState): void {
  const allowedTransitions = (
    ALLOWED_TRANSITIONS as Partial<Record<string, readonly MissionState[]>>
  )[from];

  if (allowedTransitions === undefined || !allowedTransitions.includes(to)) {
    throw new IllegalStateTransitionError(from, to);
  }
}

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
