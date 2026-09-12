import { PrivateKey } from "@koven/hedera";
import { describe, expect, it, vi } from "vitest";

import { loadSignerConfig } from "../src/config.js";
import { MirrorTransferConfirmer } from "../src/ledger.js";

const consumer = PrivateKey.generateECDSA();
const lender = PrivateKey.generateECDSA();
const valid = {
  HEDERA_NETWORK: "testnet",
  HEDERA_MIRROR_NODE_URL: "https://testnet.mirrornode.hedera.com",
  X402_NETWORK: "hedera:testnet",
  CONSUMER_ACCOUNT_ID: "0.0.1001",
  CONSUMER_PRIVATE_KEY: consumer.toStringRaw(),
  RESTRICTED_SIGNER_PORT: "3004",
  DATABASE_URL: "./signer.db",
  DEFAULT_MISSION_SPENDING_CAP: "5000000",
  APPROVED_RECIPIENTS_ROOT: "1",
  SIGNER_CONSUMER_CREDENTIAL: "c".repeat(43),
  SIGNER_ORCHESTRATOR_CREDENTIAL: "o".repeat(43),
  SIGNER_REGISTRAR_CREDENTIAL: "r".repeat(43),
  SIGNER_LENDER_CREDENTIALS: `0.0.4001:${"l".repeat(43)}`,
  SIGNER_LENDER_PUBLIC_KEYS: `0.0.4001:${lender.publicKey.toStringRaw()}`,
  SIGNER_PROVIDER_CALLBACK_SECRETS: `provider-a:${Buffer.alloc(32, 1).toString("base64url")}`,
} as const;

describe("loadSignerConfig", () => {
  it("maps credentials to roles and pins counterparty keys and secrets", () => {
    const config = loadSignerConfig(valid);
    expect(config.accountId).toBe("0.0.1001");
    expect(config.host).toBe("127.0.0.1");
    expect(config.credentials).toEqual({
      consumer: "c".repeat(43),
      orchestrator: "o".repeat(43),
      registrar: "r".repeat(43),
      lenders: { ["l".repeat(43)]: "0.0.4001" },
    });
    expect(config.lenderPublicKeys).toEqual({ "0.0.4001": lender.publicKey.toStringRaw() });
    expect(config.providerCallbackSecrets["provider-a"]).toEqual(Buffer.alloc(32, 1));
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("rejects short, duplicated or malformed credentials, keys, secrets and hosts", () => {
    expect(() => loadSignerConfig({ ...valid, SIGNER_CONSUMER_CREDENTIAL: "short" })).toThrowError(/SIGNER_CONSUMER_CREDENTIAL/);
    expect(() => loadSignerConfig({ ...valid, SIGNER_ORCHESTRATOR_CREDENTIAL: "c".repeat(43) })).toThrowError(/SIGNER_ORCHESTRATOR_CREDENTIAL/);
    expect(() => loadSignerConfig({ ...valid, SIGNER_LENDER_CREDENTIALS: `0.0.4001:${"c".repeat(43)}` })).toThrowError(/SIGNER_LENDER_CREDENTIALS/);
    expect(() => loadSignerConfig({ ...valid, SIGNER_LENDER_PUBLIC_KEYS: "0.0.4001:nope" })).toThrowError(/SIGNER_LENDER_PUBLIC_KEYS/);
    expect(() => loadSignerConfig({ ...valid, SIGNER_PROVIDER_CALLBACK_SECRETS: "provider-a:c2hvcnQ" })).toThrowError(/SIGNER_PROVIDER_CALLBACK_SECRETS/);
    expect(() => loadSignerConfig({ ...valid, HEDERA_MIRROR_NODE_URL: "http://mirror.example" })).toThrowError(/HEDERA_MIRROR_NODE_URL/);
    expect(() => loadSignerConfig({ ...valid, RESTRICTED_SIGNER_HOST: "http://0.0.0.0" })).toThrowError(/RESTRICTED_SIGNER_HOST/);
    expect(loadSignerConfig({ ...valid, RESTRICTED_SIGNER_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
  });
});

describe("MirrorTransferConfirmer", () => {
  const transactionId = "0.0.4001@1789128000.000000001";
  const row = (transfers: { account: string; amount: number }[], overrides: Record<string, unknown> = {}) => ({
    transactions: [{
      transaction_id: "0.0.4001-1789128000-000000001",
      result: "SUCCESS",
      name: "CRYPTOTRANSFER",
      nonce: 0,
      scheduled: false,
      consensus_timestamp: "1789128001.500000000",
      token_transfers: [],
      nft_transfers: [],
      transfers: transfers.map(transfer => ({ ...transfer, is_approval: false })),
      ...overrides,
    }],
  });
  const confirmerFor = (body: unknown, status = 200) => new MirrorTransferConfirmer({
    mirrorNodeUrl: "https://testnet.mirrornode.hedera.com",
    fetch: vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })),
  });
  const expectation = { transactionId, payerAccountId: "0.0.4001", recipientAccountId: "0.0.1001", amountTinybar: 3_000_000n };

  it("confirms an exact transfer where only the payer and fee payer are debited", async () => {
    const confirmer = confirmerFor(row([
      { account: "0.0.4001", amount: -3_000_100 },
      { account: "0.0.1001", amount: 3_000_000 },
      { account: "0.0.3", amount: 100 },
    ]));
    await expect(confirmer.confirm(expectation)).resolves.toEqual({ settledAt: "2026-09-11T12:00:01.500Z" });
  });

  it("treats missing or unsuccessful transactions as unconfirmed and wrong transfers as mismatches", async () => {
    await expect(confirmerFor({ transactions: [] }).confirm(expectation)).rejects.toMatchObject({ code: "settlement_unconfirmed" });
    await expect(confirmerFor({}, 404).confirm(expectation)).rejects.toMatchObject({ code: "settlement_unconfirmed" });
    await expect(confirmerFor(row([], { result: "INSUFFICIENT_PAYER_BALANCE" })).confirm(expectation)).rejects.toMatchObject({ code: "settlement_unconfirmed" });
    await expect(confirmerFor(row([{ account: "0.0.4001", amount: -2_000_000 }, { account: "0.0.1001", amount: 2_000_000 }])).confirm(expectation))
      .rejects.toMatchObject({ code: "funding_mismatch" });
    await expect(confirmerFor(row([{ account: "0.0.4001", amount: -3_000_000 }, { account: "0.0.9999", amount: 3_000_000 }])).confirm(expectation))
      .rejects.toMatchObject({ code: "funding_mismatch" });
    await expect(confirmerFor(row([{ account: "0.0.5555", amount: -3_000_000 }, { account: "0.0.1001", amount: 3_000_000 }])).confirm(expectation))
      .rejects.toMatchObject({ code: "funding_mismatch" });
    await expect(confirmerFor(row([{ account: "0.0.4001", amount: -3_000_000 }, { account: "0.0.1001", amount: 3_000_000 }], { token_transfers: [{}] })).confirm(expectation))
      .rejects.toMatchObject({ code: "funding_mismatch" });
  });
});

describe("SdkRepaymentLedger.prepare", () => {
  it("builds a signed consumer-paid transfer offline without submitting it", async () => {
    const { Client, Transaction, TransferTransaction } = await import("@koven/hedera");
    const { SdkRepaymentLedger } = await import("../src/repay.js");
    const client = Client.forTestnet().setOperator("0.0.1001", consumer);
    try {
      const ledger = new SdkRepaymentLedger(client, "0.0.1001", consumer);
      const prepared = await ledger.prepare({ from: "0.0.1001", to: "0.0.4001", amountTinybar: 3_030_000n, memo: "repayment:loan-1" });

      const transaction = Transaction.fromBytes(Buffer.from(prepared.transactionBase64, "base64"));
      expect(transaction).toBeInstanceOf(TransferTransaction);
      expect(transaction.transactionId?.toString()).toBe(prepared.transactionId);
      expect(prepared.transactionId.startsWith("0.0.1001@")).toBe(true);
      expect(transaction.transactionMemo).toBe("repayment:loan-1");
      expect(transaction.transactionValidDuration).toBe(180);
      expect(prepared.validUntil - transaction.transactionId!.validStart!.toDate().getTime()).toBe(180_000);
      const signatures = [...transaction.getSignatures().values()].flatMap(nodeMap => [...nodeMap.values()]);
      expect(signatures.length).toBeGreaterThan(0);
      await expect(ledger.prepare({ from: "0.0.9999", to: "0.0.4001", amountTinybar: 1n, memo: "x" })).rejects.toThrow(/consumer account/);
    } finally {
      client.close();
    }
  });
});
