import type { AuditEventType } from "@koven/audit";
import type { KovenDatabase } from "@koven/persistence";

export const REPUTATION_FORMULA = "(successes + 1) / (successes + failures + 2)";

export interface ProviderReputation {
  readonly successes: number;
  readonly failures: number;
  readonly score: number;
}

interface ReputationEventRow {
  readonly type: AuditEventType;
  readonly payload_json: string;
}

const providerIdFromPayload = (payloadJson: string): string | undefined => {
  const payload = JSON.parse(payloadJson) as unknown;
  if (typeof payload !== "object" || payload === null) return undefined;
  if ("providerId" in payload && typeof payload.providerId === "string") return payload.providerId;
  if (!("detail" in payload) || typeof payload.detail !== "object" || payload.detail === null) return undefined;
  return "providerId" in payload.detail && typeof payload.detail.providerId === "string"
    ? payload.detail.providerId
    : undefined;
};

export function computeReputation(successes: number, failures: number): number {
  if (!Number.isSafeInteger(successes) || successes < 0
    || !Number.isSafeInteger(failures) || failures < 0) {
    throw new RangeError("Reputation counts must be non-negative safe integers");
  }
  return (successes + 1) / (successes + failures + 2);
}

export function getProviderReputation(
  database: KovenDatabase,
  providerId: string,
): ProviderReputation {
  return getProviderReputations(database, [providerId]).get(providerId)!;
}

export function getProviderReputations(
  database: KovenDatabase,
  providerIds: readonly string[],
): ReadonlyMap<string, ProviderReputation> {
  const counts = new Map(providerIds.map(providerId => [providerId, { successes: 0, failures: 0 }]));
  const rows = database.prepare(`
    SELECT type, payload_json
    FROM events
    WHERE type IN ('report-received', 'mission-failed')
    ORDER BY seq
  `).all() as ReputationEventRow[];
  for (const row of rows) {
    const providerId = providerIdFromPayload(row.payload_json);
    if (providerId === undefined) continue;
    const providerCounts = counts.get(providerId);
    if (providerCounts === undefined) continue;
    if (row.type === "report-received") providerCounts.successes += 1;
    else if (row.type === "mission-failed") providerCounts.failures += 1;
  }
  return new Map([...counts].map(([providerId, value]) => [providerId, {
    ...value,
    score: computeReputation(value.successes, value.failures),
  }]));
}
