import { describe, expect, it, vi } from "vitest";

import { MirrorSettlementConfirmer } from "../src/settlement.js";

const expectation = {
  transactionId: "0.0.3001@1789118400.000000001",
  payerAccountId: "0.0.1001",
  providerAccountId: "0.0.2001",
  amountTinybar: "1000000",
};

function mirrorResponse(overrides: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({
    transactions: [{
      transaction_id: "0.0.3001-1789118400-000000001",
      result: "SUCCESS",
      name: "CRYPTOTRANSFER",
      nonce: 0,
      scheduled: false,
      consensus_timestamp: "1789118401.123456789",
      transfers: [
        { account: "0.0.1001", amount: -1_000_000, is_approval: false },
        { account: "0.0.2001", amount: 1_000_000, is_approval: false },
        { account: "0.0.3001", amount: -10, is_approval: false },
        { account: "0.0.98", amount: 10, is_approval: false },
      ],
      token_transfers: [],
      nft_transfers: [],
      ...overrides,
    }],
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("MirrorSettlementConfirmer", () => {
  it("confirms the exact HBAR transfer and converts consensus time", async () => {
    const fetchMock = vi.fn(async () => mirrorResponse());
    const confirmer = new MirrorSettlementConfirmer({
      mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",
      fetch: fetchMock,
    });

    await expect(confirmer.confirm(expectation)).resolves.toEqual({
      settledAt: "2026-09-11T09:20:01.123Z",
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://testnet.mirrornode.hedera.com/api/v1/transactions/0.0.3001-1789118400-000000001");
    expect(init.redirect).toBe("error");
  });

  it("treats absent consensus data as retryable without accepting it", async () => {
    const confirmer = new MirrorSettlementConfirmer({
      mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",
      fetch: vi.fn(async () => new Response(JSON.stringify({ transactions: [] }), { status: 200 })),
    });

    await expect(confirmer.confirm(expectation)).rejects.toMatchObject({
      code: "settlement_unconfirmed",
      status: 503,
    });
  });

  it("treats malformed Mirror JSON as an unavailable confirmation", async () => {
    const confirmer = new MirrorSettlementConfirmer({
      mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",
      fetch: vi.fn(async () => new Response("not-json", { status: 200 })),
    });

    await expect(confirmer.confirm(expectation)).rejects.toMatchObject({
      code: "settlement_unconfirmed",
      status: 503,
    });
  });

  it("rejects a confirmed transfer whose payer or amount differs", async () => {
    const confirmer = new MirrorSettlementConfirmer({
      mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",
      fetch: vi.fn(async () => mirrorResponse({
        transfers: [
          { account: "0.0.1001", amount: -999_999, is_approval: false },
          { account: "0.0.2001", amount: 999_999, is_approval: false },
        ],
      })),
    });

    await expect(confirmer.confirm(expectation)).rejects.toMatchObject({
      code: "payment_authorization_mismatch",
      status: 403,
    });
  });
});
