import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountBalanceQuery, AccountInfoQuery, Hbar, PrivateKey, Status, TopicCreateTransaction,
  TopicId, TopicMessageSubmitTransaction, TransactionId, TransferTransaction } from "@hiero-ledger/sdk";
import { createClient, getBalanceTinybar, transferHbar, createTopic, submitTopicMessage, explorerUrl } from "../src/index.js";

// Ephemeral offline test key, never an account provisioned on a network.
const key = PrivateKey.generateECDSA();
const env = { HEDERA_NETWORK: "testnet", HEDERA_OPERATOR_ID: "0.0.10", HEDERA_OPERATOR_PRIVATE_KEY: key.toStringDer() };
const clients: ReturnType<typeof createClient>[] = [];
const client = () => { const c = createClient(env); clients.push(c); return c; };
afterEach(() => { for (const c of clients.splice(0)) c.close(); });
const txId = TransactionId.fromString("0.0.10@1788696000.000000001");

it("requires testnet and rejects invalid secret without echoing it", () => {
  expect(() => createClient({ ...env, HEDERA_NETWORK: "mainnet" })).toThrow("must be testnet");
  expect(() => createClient({ ...env, HEDERA_OPERATOR_ID: "0.0.010" })).toThrow("canonical");
  expect(() => createClient({ ...env, HEDERA_OPERATOR_PRIVATE_KEY: "secret-not-a-key" })).toThrow(/^Invalid ECDSA operator private key$/);
  expect(client().ledgerId?.toString()).toBe("testnet");
});

it("preserves balance precision beyond Number.MAX_SAFE_INTEGER", async () => {
  vi.spyOn(AccountBalanceQuery.prototype, "execute").mockResolvedValue({
    hbars: Hbar.fromTinybars("9007199254740993"),
  } as Awaited<ReturnType<AccountBalanceQuery["execute"]>>);
  expect(await getBalanceTinybar(client(), "0.0.20")).toBe(9007199254740993n);
});

describe("operator transfers", () => {
  it("checks target existence, balances exact signed-int64 amounts and awaits consensus", async () => {
    const exists = vi.spyOn(AccountInfoQuery.prototype, "execute").mockResolvedValue({} as never);
    const receipt = vi.fn().mockResolvedValue({ status: Status.Success });
    const execute = vi.spyOn(TransferTransaction.prototype, "execute").mockImplementation(async function (this: TransferTransaction) {
      expect(exists).toHaveBeenCalledOnce();
      const entries = [...this.hbarTransfers!].map(([id, amount]) => [id.toString(), amount.toTinybars().toString()]);
      expect(entries).toEqual([["0.0.10", "-9007199254740993"], ["0.0.20", "9007199254740993"]]);
      return { transactionId: txId, getReceipt: receipt } as never;
    });
    expect(await transferHbar(client(), { from: "0.0.10", to: "0.0.20", amountTinybar: 9007199254740993n })).toEqual({ transactionId: txId.toString(), status: "SUCCESS" });
    expect(execute).toHaveBeenCalledOnce();
    expect(receipt).toHaveBeenCalledOnce();
  });
  it("rejects bad amounts, foreign debit, same account and UTF-8 memo before network", async () => {
    const query = vi.spyOn(AccountInfoQuery.prototype, "execute");
    const c = client();
    const valid = { from: "0.0.10", to: "0.0.20", amountTinybar: 1n };
    for (const amountTinybar of [0n, -1n, 9223372036854775808n])
      await expect(transferHbar(c, { ...valid, amountTinybar })).rejects.toThrow("int64");
    await expect(transferHbar(c, { ...valid, from: "0.0.30" })).rejects.toThrow("operator");
    await expect(transferHbar(c, { ...valid, to: valid.from })).rejects.toThrow("distinct");
    await expect(transferHbar(c, { ...valid, memo: "é".repeat(51) })).rejects.toThrow("UTF-8");
    expect(query).not.toHaveBeenCalled();
  });
  it("does not submit when target lookup fails or report success on a failed receipt", async () => {
    const query = vi.spyOn(AccountInfoQuery.prototype, "execute").mockRejectedValue(new Error("missing account"));
    const execute = vi.spyOn(TransferTransaction.prototype, "execute").mockResolvedValue({
      transactionId: txId, getReceipt: vi.fn().mockResolvedValue({ status: Status.InvalidSignature }),
    } as never);
    const request = { from: "0.0.10", to: "0.0.20", amountTinybar: 1n };
    await expect(transferHbar(client(), request)).rejects.toThrow("missing account");
    expect(execute).not.toHaveBeenCalled();
    query.mockResolvedValue({} as never);
    await expect(transferHbar(client(), request)).rejects.toThrow("did not succeed");
  });
});

it("creates an operator-administered topic and returns its ID", async () => {
  vi.spyOn(TopicCreateTransaction.prototype, "execute").mockImplementation(async function (this: TopicCreateTransaction) {
    expect(this.adminKey?.toString()).toBe(key.publicKey.toString());
    expect(this.submitKey).toBeNull();
    return { getReceipt: vi.fn().mockResolvedValue({ status: Status.Success, topicId: TopicId.fromString("0.0.50") }) } as never;
  });
  expect(await createTopic(client(), "Koven audit")).toBe("0.0.50");
});

it("rejects chunked-size messages and returns exact topic sequence numbers", async () => {
  const execute = vi.spyOn(TopicMessageSubmitTransaction.prototype, "execute").mockResolvedValue({
    transactionId: txId, getReceipt: vi.fn().mockResolvedValue({ status: Status.Success, topicSequenceNumber: { toString: () => "9007199254740993" } }),
  } as never);
  const c = client();
  await expect(submitTopicMessage(c, "0.0.50", "é".repeat(513))).rejects.toThrow("1024");
  expect(execute).not.toHaveBeenCalled();
  expect(await submitTopicMessage(c, "0.0.50", "{}")).toEqual({ transactionId: txId.toString(), sequenceNumber: 9007199254740993n });
});

it("builds testnet explorer links only for canonical transaction IDs", () => {
  expect(explorerUrl(txId.toString())).toBe(`https://hashscan.io/testnet/transaction/${txId}`);
  expect(() => explorerUrl("../../mainnet")).toThrow();
});
