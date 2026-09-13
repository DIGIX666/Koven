import { describe, expect, it } from "vitest";

import { missionFixture } from "../test-fixtures";
import { derivePaymentEvidence } from "./payment";

const event = (type: string, occurredAt: string, transactionId?: string) => ({
  id: `event-${type}`,
  missionId: missionFixture.id,
  type,
  payloadHash: "c".repeat(64),
  occurredAt,
  ...(transactionId === undefined ? {} : { transactionId }),
}) as (typeof missionFixture)["events"][number];

const zkHealth = { status: "ok" as const, circuitId: "koven-policy-v1", vkeyHash: "d".repeat(64) };

describe("derivePaymentEvidence", () => {
  it("reports a settled zk payment with its transaction, pinned key and verified proof", () => {
    const mission = { ...missionFixture, events: [
      event("proof-generated", "2026-09-13T10:00:30.000Z"),
      event("payment-authorized", "2026-09-13T10:01:00.000Z", "0.0.123@1789000000.123456789"),
      event("x402-settled", "2026-09-13T10:02:00.000Z", "0.0.123@1789000000.123456789"),
    ] };
    expect(derivePaymentEvidence(mission, zkHealth)).toEqual({
      missionId: "mission-demo-1",
      status: "settled",
      proof: "verified",
      circuitId: "koven-policy-v1",
      vkeyHash: "d".repeat(64),
      capTinybar: "2500000000",
      approvedRecipientsRoot: "123456789",
      targetSha256: "a".repeat(64),
      transactionId: "0.0.123@1789000000.123456789",
      proofGeneratedAt: "2026-09-13T10:00:30.000Z",
      authorizedAt: "2026-09-13T10:01:00.000Z",
      settledAt: "2026-09-13T10:02:00.000Z",
    });
  });

  it("distinguishes pending, authorized-but-unsettled, rejected and failed payments", () => {
    const at = "2026-09-13T10:00:00.000Z";
    expect(derivePaymentEvidence({ ...missionFixture, events: [] }, zkHealth)).toMatchObject({ status: "pending", proof: "not-generated" });
    expect(derivePaymentEvidence({ ...missionFixture, events: [
      event("proof-generated", at), event("payment-authorized", at, "0.0.1@1.000000001"),
    ] }, zkHealth)).toMatchObject({ status: "authorized", proof: "verified", transactionId: "0.0.1@1.000000001" });
    expect(derivePaymentEvidence({ ...missionFixture, events: [event("proof-generated", at), event("payment-rejected", at)] }, zkHealth))
      .toMatchObject({ status: "rejected", proof: "rejected", rejectedAt: at });
    expect(derivePaymentEvidence({ ...missionFixture, events: [event("mission-failed", at)] }, zkHealth))
      .toMatchObject({ status: "failed" });
  });

  it("labels the deterministic gate when the signer pins no key and no proof was generated", () => {
    const health = { status: "ok" as const, circuitId: "koven-policy-v1", vkeyHash: null };
    expect(derivePaymentEvidence({ ...missionFixture, events: [] }, health)).toMatchObject({ proof: "deterministic", vkeyHash: null });
    expect(derivePaymentEvidence({ ...missionFixture, events: [] }, undefined)).toMatchObject({ proof: "deterministic", vkeyHash: null });
  });
});
