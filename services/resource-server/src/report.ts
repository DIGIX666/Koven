import { createHash } from "node:crypto";

import type { Finding, ScanReport, ScanRequest } from "@koven/domain";
import { ScanReportSchema } from "@koven/schemas";

export interface ReportWindow {
  readonly startedAt: string;
  readonly completedAt: string;
}

function serializeCanonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON only supports finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(serializeCanonical).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${serializeCanonical(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("Canonical JSON does not support this value");
}

export function canonicalJson(value: unknown): string {
  return serializeCanonical(value);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function buildReport(
  request: ScanRequest,
  providerId: string,
  findings: Finding[],
  window: ReportWindow = {
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  },
): ScanReport {
  const unsigned = {
    schemaVersion: 1 as const,
    missionId: request.missionId,
    targetSha256: sha256Hex(request.source),
    providerId,
    findings,
    startedAt: window.startedAt,
    completedAt: window.completedAt,
  };
  const report = {
    ...unsigned,
    reportSha256: sha256Hex(canonicalJson(unsigned)),
  };

  return ScanReportSchema.parse(report);
}

export function hasValidReportHash(report: ScanReport): boolean {
  const { reportSha256, ...unsigned } = report;
  return reportSha256 === sha256Hex(canonicalJson(unsigned));
}
