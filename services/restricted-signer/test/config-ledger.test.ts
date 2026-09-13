import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    expect(() => loadSignerConfig({ ...valid, SIGNER_LENDER_PUBLIC_KEYS: `0.0.4002:${lender.publicKey.toStringRaw()}` })).toThrowError(/SIGNER_LENDER_PUBLIC_KEYS/);
    expect(loadSignerConfig(valid).proofMode).toBe("deterministic");
    expect(() => loadSignerConfig({ ...valid, SIGNER_PROOF_MODE: "plonk" })).toThrowError(/SIGNER_PROOF_MODE/);
    // zk mode refuses to start without a pinned key file and hash, or with a hash that does not match the file.
    expect(() => loadSignerConfig({ ...valid, SIGNER_PROOF_MODE: "zk" })).toThrowError(/SIGNER_TRUSTED_VKEY_SHA256|SIGNER_VERIFICATION_KEY_PATH/);
    const keyPath = join(tmpdir(), `koven-vkey-${process.pid}.json`);
    writeFileSync(keyPath, '{"protocol":"groth16","curve":"bn128"}');
    const pin = createHash("sha256").update(readFileSync(keyPath)).digest("hex");
    expect(() => loadSignerConfig({ ...valid, SIGNER_PROOF_MODE: "zk", SIGNER_VERIFICATION_KEY_PATH: keyPath, SIGNER_TRUSTED_VKEY_SHA256: "0".repeat(64) })).toThrowError(/SIGNER_TRUSTED_VKEY_SHA256/);
    const zk = loadSignerConfig({ ...valid, SIGNER_PROOF_MODE: "zk", SIGNER_VERIFICATION_KEY_PATH: keyPath, SIGNER_TRUSTED_VKEY_SHA256: pin });
    expect(zk.proofMode).toBe("zk");
    expect(zk.verification).toEqual({ verificationKey: { protocol: "groth16", curve: "bn128" }, vkeyHash: pin });
    rmSync(keyPath);
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

describe("SdkRepaymentLedger.submit", () => {
  it("classifies precheck rejections as failed, duplicates and network errors as uncertain", async () => {
    const { AccountId, Client, PrecheckStatusError, Status, Transaction, TransactionId } = await import("@koven/hedera");
    const { SdkRepaymentLedger } = await import("../src/repay.js");
    const client = Client.forTestnet().setOperator("0.0.1001", consumer);
    const transactionId = TransactionId.generate("0.0.1001");
    const outcomes: unknown[] = [
      new PrecheckStatusError({ status: Status.InsufficientTxFee, transactionId, contractFunctionResult: null, nodeId: AccountId.fromString("0.0.3") }),
      new PrecheckStatusError({ status: Status.DuplicateTransaction, transactionId, contractFunctionResult: null, nodeId: AccountId.fromString("0.0.3") }),
      new Error("socket hang up"),
    ];
    const spy = vi.spyOn(Transaction, "fromBytes").mockImplementation(() => ({
      transactionId,
      execute: async () => { throw outcomes.shift(); },
    }) as never);
    try {
      const ledger = new SdkRepaymentLedger(client, "0.0.1001", consumer);
      const bytes = Buffer.from("x").toString("base64");
      expect(await ledger.submit(bytes)).toBe("failed");
      expect(await ledger.submit(bytes)).toBe("uncertain");
      expect(await ledger.submit(bytes)).toBe("uncertain");
    } finally {
      spy.mockRestore();
      client.close();
    }
  });

  it("reads the receipt for the persisted id and treats a throttled receipt as that id's failure", async () => {
    const { Client, ReceiptStatusError, Status, Transaction, TransactionId, TransactionReceiptQuery } = await import("@koven/hedera");
    const { SdkRepaymentLedger } = await import("../src/repay.js");
    const client = Client.forTestnet().setOperator("0.0.1001", consumer);
    const transactionId = TransactionId.generate("0.0.1001");
    const responseIds = [transactionId, transactionId, TransactionId.generate("0.0.1001")];
    const getReceipt = vi.fn();
    const fromBytes = vi.spyOn(Transaction, "fromBytes").mockImplementation(() => ({
      transactionId,
      execute: async () => ({ transactionId: responseIds.shift(), getReceipt }),
    }) as never);
    const receipts: unknown[] = [
      () => { throw new ReceiptStatusError({ transactionReceipt: {} as never, status: Status.ThrottledAtConsensus, transactionId }); },
      () => ({ status: Status.Success }),
    ];
    const queried: string[] = [];
    const setId = vi.spyOn(TransactionReceiptQuery.prototype, "setTransactionId").mockImplementation(function (this: InstanceType<typeof TransactionReceiptQuery>, id) {
      queried.push(String(id));
      return this;
    });
    const execute = vi.spyOn(TransactionReceiptQuery.prototype, "execute").mockImplementation(async () => (receipts.shift() as () => unknown)() as never);
    try {
      const ledger = new SdkRepaymentLedger(client, "0.0.1001", consumer);
      const bytes = Buffer.from("x").toString("base64");
      // Throttled at consensus: the SDK's response.getReceipt() would have
      // resubmitted under a fresh id; here it is a definite failure of this id.
      expect(await ledger.submit(bytes)).toBe("failed");
      expect(await ledger.submit(bytes)).toBe("success");
      expect(queried).toEqual([transactionId.toString(), transactionId.toString()]);
      expect(getReceipt).not.toHaveBeenCalled();
      // A response that does not carry the persisted id is never trusted.
      expect(await ledger.submit(bytes)).toBe("uncertain");
      expect(execute).toHaveBeenCalledTimes(2);
    } finally {
      fromBytes.mockRestore();
      setId.mockRestore();
      execute.mockRestore();
      client.close();
    }
  });
});

describe("KeyedMutex", () => {
  it("serialises tasks per key and releases entries once they settle", async () => {
    const { KeyedMutex } = await import("../src/gate.js");
    const mutex = new KeyedMutex();
    const order: string[] = [];
    const first = mutex.run("k", async () => { await new Promise(resolve => setTimeout(resolve, 5)); order.push("first"); });
    const second = mutex.run("k", async () => { order.push("second"); });
    const other = mutex.run("other", async () => { order.push("other"); throw new Error("boom"); });
    await expect(other).rejects.toThrow("boom");
    await Promise.all([first, second]);
    expect(order).toEqual(["other", "first", "second"]);
    expect(mutex.size).toBe(0);
  });
});
