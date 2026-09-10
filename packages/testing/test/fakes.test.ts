import type { AuditSink } from "@koven/audit";
import type { HederaAdapter } from "@koven/hedera";
import {
  AuditEventSchema,
  Base64,
  PaymentReceiptSchema,
  PaymentRequirementsSchema,
  ScanReportSchema,
} from "@koven/schemas";
import type { ResourceServer, X402Client } from "@koven/x402";
import type { ClientHederaSigner } from "@x402/hedera";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  FakeHederaAdapter,
  FakeResourceServer,
  FakeSigner,
  FakeX402Client,
  NoopAuditSink,
} from "../src/index.js";

const hash = "a".repeat(64);
const signature = "b".repeat(128);
const timestamp = "2026-09-10T12:00:00.000Z";
const transactionId = "0.0.10@1788696000.000000001";

const requirements = {
  scheme: "exact" as const,
  network: "hedera:testnet" as const,
  asset: "0.0.0" as const,
  amount: "100",
  payTo: "0.0.20",
  maxTimeoutSeconds: 180,
  extra: { feePayer: "0.0.40" },
};

const paymentAuthorization = {
  missionId: "mission-1",
  targetSha256: hash,
  transactionSha256: hash,
  transactionId,
  borrowerAccountId: "0.0.10",
  providerAccountId: "0.0.20",
  scanUrl: "http://localhost:3003/scan",
  amountTinybar: 100n,
  network: "hedera:testnet" as const,
  asset: "0.0.0" as const,
  nonce: "1",
  expiresAt: timestamp,
  signature,
};

const paidRequest = {
  missionId: "mission-1",
  targetRef: "Example.sol",
  source: "pragma solidity ^0.8.0; contract Example {}",
  targetSha256: hash,
  paymentAuthorization,
};

const report = {
  schemaVersion: 1 as const,
  missionId: paidRequest.missionId,
  targetSha256: paidRequest.targetSha256,
  providerId: "provider-fake",
  findings: [],
  startedAt: timestamp,
  completedAt: timestamp,
  reportSha256: hash,
};

const receipt = {
  missionId: paidRequest.missionId,
  transactionId,
  network: "hedera:testnet" as const,
  payer: "0.0.10",
  recipientAccountId: "0.0.20",
  asset: "0.0.0" as const,
  amountTinybar: 100n,
  settledAt: timestamp,
};

describe("Track A fakes", () => {
  it("moves balances and creates deterministic Hedera transaction IDs", async () => {
    const fake = new FakeHederaAdapter({ balances: { "0.0.10": 250n } });
    expectTypeOf(fake).toMatchTypeOf<HederaAdapter>();

    await expect(fake.transferHbar({ from: "0.0.10", to: "0.0.20", amountTinybar: 100n }))
      .resolves.toEqual({ transactionId: "0.0.999@1", status: "SUCCESS" });
    await expect(fake.transferHbar({ from: "0.0.10", to: "0.0.20", amountTinybar: 50n }))
      .resolves.toEqual({ transactionId: "0.0.999@2", status: "SUCCESS" });

    await expect(fake.getBalanceTinybar("0.0.10")).resolves.toBe(100n);
    await expect(fake.getBalanceTinybar("0.0.20")).resolves.toBe(150n);
    expect(fake.transfers).toHaveLength(2);
  });

  it("injects a Hedera failure for one call without mutating the ledger", async () => {
    const fake = new FakeHederaAdapter({ balances: { "0.0.10": 100n } });
    fake.failNext("transfer", new Error("consensus unavailable"));

    await expect(fake.transferHbar({ from: "0.0.10", to: "0.0.20", amountTinybar: 25n }))
      .rejects.toThrow("consensus unavailable");
    await expect(fake.getBalanceTinybar("0.0.10")).resolves.toBe(100n);
    expect(fake.transfers).toHaveLength(0);
  });

  it("implements ClientHederaSigner and records every requirement", async () => {
    const fake = new FakeSigner("0.0.10");
    expectTypeOf(fake).toMatchTypeOf<ClientHederaSigner>();

    const signedTransaction = await fake.createPartiallySignedTransferTransaction(requirements);
    expect(signedTransaction)
      .toBe(Buffer.from("fake-signed-transaction:0.0.10:1").toString("base64"));
    expect(Base64.safeParse(signedTransaction).success).toBe(true);
    expect(fake.requirements).toEqual([requirements]);

    fake.failNext(new Error("signer unavailable"));
    await expect(fake.createPartiallySignedTransferTransaction(requirements))
      .rejects.toThrow("signer unavailable");
    expect(fake.requirements).toHaveLength(2);
  });

  it("returns configurable x402 challenge and paid retry responses", async () => {
    const fake = new FakeX402Client({
      challenge: { status: 402, requirements },
      settlement: { status: 200, receipt, report },
    });
    expectTypeOf(fake).toMatchTypeOf<X402Client>();

    const scanRequest = {
      missionId: paidRequest.missionId,
      targetRef: paidRequest.targetRef,
      source: paidRequest.source,
      targetSha256: paidRequest.targetSha256,
    };
    const challenge = await fake.request(scanRequest);
    const settlement = await fake.retryWithPayment(paidRequest, "AQID");

    expect(PaymentRequirementsSchema.safeParse(challenge.requirements).success).toBe(true);
    expect(ScanReportSchema.safeParse(settlement.report).success).toBe(true);
    expect(PaymentReceiptSchema.safeParse({
      ...settlement.receipt,
      amountTinybar: settlement.receipt.amountTinybar.toString(),
    }).success).toBe(true);
    expect(fake.requests).toEqual([scanRequest]);
    expect(fake.paidRetries).toEqual([{ request: paidRequest, signedTransaction: "AQID" }]);
  });

  it("returns a schema-valid report bound to the requested mission", async () => {
    const fake = new FakeResourceServer({ reportSha256: hash, timestamp });
    expectTypeOf(fake).toMatchTypeOf<ResourceServer>();

    const result = await fake.scan(paidRequest);
    expect(result).toMatchObject({
      missionId: paidRequest.missionId,
      targetSha256: paidRequest.targetSha256,
      providerId: "provider-fake",
    });
    expect(ScanReportSchema.safeParse(result).success).toBe(true);
    expect(fake.requests).toEqual([paidRequest]);
  });

  it("captures schema-valid audit events without publishing them", async () => {
    const fake = new NoopAuditSink();
    expectTypeOf(fake).toMatchTypeOf<AuditSink>();
    const event = {
      id: "event-1",
      missionId: paidRequest.missionId,
      type: "mission-created" as const,
      payloadHash: hash,
      occurredAt: timestamp,
    };

    await fake.write(event);
    expect(fake.events).toEqual([event]);
    expect(AuditEventSchema.safeParse(fake.events[0]).success).toBe(true);
  });

  it("injects one-shot failures in the workflow-facing fakes", async () => {
    const x402 = new FakeX402Client({
      challenge: { status: 402, requirements },
      settlement: { status: 200, receipt, report },
    });
    const resourceServer = new FakeResourceServer({ reportSha256: hash, timestamp });
    const audit = new NoopAuditSink();
    const event = {
      id: "event-1",
      missionId: paidRequest.missionId,
      type: "mission-created" as const,
      payloadHash: hash,
      occurredAt: timestamp,
    };

    x402.failNext("request", new Error("challenge unavailable"));
    await expect(x402.request(paidRequest)).rejects.toThrow("challenge unavailable");
    await expect(x402.request(paidRequest)).resolves.toEqual({ status: 402, requirements });

    resourceServer.failNext(new Error("provider unavailable"));
    await expect(resourceServer.scan(paidRequest)).rejects.toThrow("provider unavailable");
    await expect(resourceServer.scan(paidRequest)).resolves.toMatchObject({ missionId: "mission-1" });

    audit.failNext(new Error("audit unavailable"));
    await expect(audit.write(event)).rejects.toThrow("audit unavailable");
    await audit.write(event);
    expect(audit.events).toEqual([event]);
  });
});
