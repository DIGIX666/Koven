export type AuditEventType =
  | "credit-requested"
  | "offer-accepted"
  | "loan-funded"
  | "payment-authorized"
  | "payment-settled"
  | "mission-completed"
  | "repayment-settled";

export interface AuditEvent {
  id: string;
  missionId: string;
  type: AuditEventType;
  payloadHash: string;
  transactionId?: string;
  occurredAt: string;
}

