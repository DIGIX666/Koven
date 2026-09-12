import { encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@koven/domain";
import { describe, expect, it } from "vitest";

import { decodeSettlement, SettlementDecodeError } from "../src/settlement.js";

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "hedera:testnet",
  asset: "0.0.0",
  amount: "1000000",
  payTo: "0.0.2001",
  maxTimeoutSeconds: 180,
  extra: { feePayer: "0.0.3001" },
};
const expected = {
  missionId: "mission-1",
  requirements,
  payer: "0.0.1001",
  observedAt: "2026-09-12T10:00:00.000Z",
};
const transaction = "0.0.3001@1789128000.000000001";
const settled = { success: true, transaction, network: "hedera:testnet" as const, payer: "0.0.1001" };
const header = (value: object) => encodePaymentResponseHeader(value as never);
const rejection = (run: () => unknown, reason: string) => {
  expect(run).toThrowError(SettlementDecodeError);
  expect(run).toThrowError(reason);
};

describe("decodeSettlement", () => {
  it("builds a receipt bound to the accepted requirements", () => {
    expect(decodeSettlement(header(settled), expected)).toEqual({
      missionId: "mission-1",
      transactionId: transaction,
      network: "hedera:testnet",
      payer: "0.0.1001",
      recipientAccountId: "0.0.2001",
      asset: "0.0.0",
      amountTinybar: 1_000_000n,
      settledAt: expected.observedAt,
    });
    expect(decodeSettlement(header({ ...settled, amount: "1000000" }), expected).amountTinybar).toBe(1_000_000n);
  });

  it("rejects settlements that are unsuccessful or do not match the payment", () => {
    rejection(() => decodeSettlement("not base64!", expected), "not base64");
    rejection(() => decodeSettlement(Buffer.from("[1]").toString("base64"), expected), "did not succeed");
    rejection(() => decodeSettlement(header({ ...settled, success: false, errorReason: "insufficient_funds" }), expected), "insufficient_funds");
    rejection(() => decodeSettlement(header({ ...settled, network: "hedera:mainnet" }), expected), "network mismatch");
    rejection(() => decodeSettlement(header({ ...settled, transaction: "0xabc" }), expected), "transaction id is malformed");
    rejection(() => decodeSettlement(header({ ...settled, payer: "0.0.9999" }), expected), "payer mismatch");
    rejection(() => decodeSettlement(header({ ...settled, payer: undefined }), expected), "payer mismatch");
    rejection(() => decodeSettlement(header({ ...settled, amount: "999999" }), expected), "amount mismatch");
    rejection(() => decodeSettlement(header(settled), { ...expected, observedAt: "yesterday" }), "frozen contract");
  });
});
