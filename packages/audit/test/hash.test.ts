import { describe, expect, it } from "vitest";

import { buildHcsEnvelope, hashAuditPayload, serializeHcsEnvelope } from "../src/index.js";

describe("public HCS audit envelopes", () => {
  it("contains only hashes and non-sensitive references", () => {
    const message = serializeHcsEnvelope({
      id: "event-1",
      missionId: "mission-1",
      type: "payment-authorized",
      payloadHash: "a".repeat(64),
      transactionId: "0.0.10@1788696000.000000001",
      occurredAt: "2026-09-13T12:00:00.000Z",
    });

    expect(JSON.parse(message)).toEqual(buildHcsEnvelope({
      id: "event-1",
      missionId: "mission-1",
      type: "payment-authorized",
      payloadHash: "a".repeat(64),
      transactionId: "0.0.10@1788696000.000000001",
      occurredAt: "2026-09-13T12:00:00.000Z",
    }));
    expect(message).not.toContain("signature");
    expect(message).not.toContain("privateKey");
  });

  it("hashes exact canonical payload bytes and rejects unsafe envelopes", () => {
    expect(hashAuditPayload("{\"amount\":\"10\"}"))
      .toBe("a67dbcc19c1614ade24b6c38b124687ddf4ab2cc9a5c9650840e043cf7b3c38d");
    expect(() => serializeHcsEnvelope({
      id: "x".repeat(1_024),
      missionId: "mission-1",
      type: "mission-created",
      payloadHash: "a".repeat(64),
      occurredAt: "2026-09-13T12:00:00.000Z",
    })).toThrow(/one HCS message/);
    expect(() => serializeHcsEnvelope({
      id: "event-1",
      missionId: "mission-1",
      type: "mission-created",
      payloadHash: "SECRET",
      occurredAt: "2026-09-13T12:00:00.000Z",
    })).toThrow(/SHA-256/);
  });
});
