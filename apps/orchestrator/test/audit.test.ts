import type { HcsPublisher } from "@koven/audit";
import { createEvent, openDatabase, type KovenDatabase } from "@koven/persistence";
import { afterEach, describe, expect, it } from "vitest";

import { createOrchestratorAuditRuntime } from "../src/audit.js";

describe("orchestrator audit composition", () => {
  let database: KovenDatabase | undefined;

  afterEach(() => database?.close());

  it("keeps noop mode offline and requires a publisher for hcs mode", async () => {
    database = openDatabase(":memory:");
    const offline = createOrchestratorAuditRuntime({ database, mode: "noop" });
    await expect(offline.sink.write({
      id: "event-1", missionId: "mission-1", type: "mission-created",
      payloadHash: "a".repeat(64), occurredAt: "2026-09-13T12:00:00.000Z",
    })).resolves.toBeUndefined();
    expect(() => createOrchestratorAuditRuntime({ database: database!, mode: "hcs" }))
      .toThrow(/requires an HCS publisher/);
  });

  it("drains persisted events when hcs mode is selected", async () => {
    database = openDatabase(":memory:");
    createEvent(database, {
      id: "event-1", missionId: "mission-1", type: "mission-created",
      payloadHash: "a".repeat(64), payload: {}, occurredAt: new Date().toISOString(),
    });
    const publisher: HcsPublisher = {
      prepare: async () => ({
        transactionId: "0.0.10@1788696000.000000001",
        transactionBase64: "c2lnbmVk",
        validUntil: Date.now() + 180_000,
      }),
      submit: async () => ({ status: "confirmed", sequenceNumber: 7n }),
      reconcile: async () => ({ status: "uncertain" }),
    };
    const runtime = createOrchestratorAuditRuntime({ database, mode: "hcs", publisher });
    await runtime.flush();
    expect(database.prepare("SELECT published_at FROM events WHERE id = 'event-1'").get())
      .toMatchObject({ published_at: expect.any(String) });
  });
});
