import { createHash } from "node:crypto";
import { createEvent, type KovenDatabase } from "@koven/persistence";

/** Controlled failures sufficient to offset the reference provider's price advantage after one success. */
export function injectCompetitionFailures(history: KovenDatabase, providerId: string): void {
  for (let index = 0; index < 8; index += 1) {
    const payload = { providerId };
    createEvent(history, { id: `failure-${index}`, missionId: `history-${index}`, type: "mission-failed",
      payloadHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"), payload, occurredAt: new Date().toISOString() });
  }
}
