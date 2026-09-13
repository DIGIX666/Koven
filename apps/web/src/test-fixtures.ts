import type { HttpResponse } from "@koven/schemas";

export const missionFixture: HttpResponse<"missionDetail"> = {
  id: "mission-demo-1",
  state: "service-paid",
  spendingCapTinybar: "2500000000",
  spentTinybar: "1000000",
  approvedRecipientsRoot: "123456789",
  targetRef: "contracts/Vault.sol",
  targetSha256: "a".repeat(64),
  createdAt: "2026-09-13T10:00:00.000Z",
  updatedAt: "2026-09-13T10:02:00.000Z",
  events: [{
    id: "event-1",
    missionId: "mission-demo-1",
    type: "x402-settled",
    payloadHash: "b".repeat(64),
    transactionId: "0.0.123@1789000000.123456789",
    occurredAt: "2026-09-13T10:02:00.000Z",
  }],
};

export const providerRankingFixture: HttpResponse<"rankProviders"> = {
  formula: "0.4 price + 0.35 reputation + 0.25 latency",
  ranked: [{
    provider: {
      id: "provider-a",
      accountId: "0.0.123",
      endpoint: "http://127.0.0.1:3003",
      capability: "solidity-security",
      priceTinybar: "1000000",
      reputationScore: 0.8,
      expectedLatencyMs: 4_000,
    },
    score: 0.82,
    breakdown: { price: 0.9, reputation: 0.8, latency: 0.7 },
  }],
};

