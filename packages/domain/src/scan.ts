import type { ScanPaymentAuthorization } from "./payment.js";

export interface ScanRequest {
  missionId: string; targetRef: string; source: string; targetSha256: string;
}
export interface PaidScanRequest extends ScanRequest {
  paymentAuthorization: ScanPaymentAuthorization;
}
export type Severity = "info" | "low" | "medium" | "high" | "critical";
export interface Finding {
  ruleId: string; severity: Severity; file: string; line: number; message: string;
}
export interface ScanReport {
  schemaVersion: 1; missionId: string; targetSha256: string; providerId: string;
  findings: Finding[]; startedAt: string; completedAt: string; reportSha256: string;
}
