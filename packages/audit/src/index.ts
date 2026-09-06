export const AUDIT_EVENT_TYPES = [
  "mission-created",
  "providers-ranked",
  "credit-requested",
  "offers-received",
  "offer-accepted",
  "loan-funded",
  "proof-generated",
  "payment-authorized",
  "payment-rejected",
  "x402-settled",
  "report-received",
  "callback-received",
  "callback-duplicate",
  "mission-completed",
  "mission-failed",
  "repayment-settled",
  "repayment-idempotency-hit",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];
/** Public envelope only. Raw local payloads never cross the HCS boundary. */
export interface AuditEvent {
  id: string; missionId: string; type: AuditEventType; payloadHash: string;
  transactionId?: string; occurredAt: string;
}
export interface HcsEventEnvelope {
  v: 1; eventId: string; missionId: string; type: AuditEventType;
  payloadHash: string; transactionId?: string; occurredAt: string;
}
export interface AuditSink { write(event: AuditEvent): Promise<void>; }
