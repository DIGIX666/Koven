import { test, mock, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { PaymentRequirements, SupportedResponse, VerifyResponse, SettleResponse } from "@x402/core/types";
import { runSmoke, smokeConfig, assertMirrorPayment, buildSmokePayment, type SmokeConfig } from "../lib/x402-smoke.js";
import { PrivateKey, inspectHederaTransaction } from "@x402/hedera";

beforeEach(() => { mock.method(console, "info", () => {}); });
afterEach(() => { mock.restoreAll(); });

const id = "0.0.40@1788725329.539946918";
const config: SmokeConfig = { consumer: "0.0.10", provider: "0.0.20",
  facilitatorUrl: "https://api.testnet.blocky402.com", mirrorUrl: "https://testnet.mirrornode.hedera.com" };
const mirrorTx = { transaction_id: "0.0.40-1788725329-539946918", result: "SUCCESS", name: "CRYPTOTRANSFER",
  nonce: 0, scheduled: false, token_transfers: [], nft_transfers: [], transfers: [
    { account: "0.0.10", amount: -1000000, is_approval: false },
    { account: "0.0.20", amount: 1000000, is_approval: false },
    { account: "0.0.40", amount: -100, is_approval: false },
    { account: "0.0.802", amount: 100, is_approval: false },
  ] };

function fixture() {
  const values: Record<string, string> = {};
  const store = { get: (key: string) => values[key] ?? "", set: (updates: Record<string, string>) => { Object.assign(values, updates); } };
  const deps = {
    facilitator: {
      getSupported: mock.fn(async (): Promise<SupportedResponse> => ({ kinds: [{ x402Version: 2, scheme: "exact", network: "hedera:testnet", extra: { feePayer: "0.0.40" } }], extensions: [], signers: {} })),
      verify: mock.fn(async (): Promise<VerifyResponse> => ({ isValid: true, payer: config.consumer })),
      settle: mock.fn(async (): Promise<SettleResponse> => {
        assert.equal(store.get("KOVEN_X402_SMOKE_TX_ID"), id);
        assert.equal(store.get("KOVEN_X402_SMOKE_STATE"), "pending");
        return { success: true, transaction: id, network: "hedera:testnet", payer: config.consumer };
      }),
    },
    build: mock.fn(async (requirements: PaymentRequirements) => ({ transactionId: id,
      payload: { x402Version: 2, accepted: requirements, payload: { transaction: "structural-fixture" } } })),
    confirm: mock.fn(async (transactionId: string) => { assertMirrorPayment({ transactions: [mirrorTx] }, config, transactionId); }),
  };
  return { values, store, deps };
}

test("smoke pays once, saves the ID before settlement, then only reconciles on rerun", async () => {
  const { store, deps } = fixture();
  await runSmoke(config, store, deps);
  assert.equal(store.get("KOVEN_X402_SMOKE_STATE"), "confirmed");
  await runSmoke(config, store, deps);
  assert.equal(deps.facilitator.settle.mock.callCount(), 1);
  assert.equal(deps.build.mock.callCount(), 1);
  assert.equal(deps.confirm.mock.callCount(), 2);
});

test("verification refusal or a wrong payer never reaches settlement", async () => {
  for (const verification of [{ isValid: false }, { isValid: true, payer: "0.0.99" }]) {
    const { store, deps } = fixture();
    deps.facilitator.verify.mock.mockImplementation(async () => verification);
    await assert.rejects(runSmoke(config, store, deps), /verification failed/);
    assert.equal(deps.facilitator.settle.mock.callCount(), 0);
  }
});

test("timeout retains the journal and restart neither signs nor settles again", async () => {
  const { store, deps } = fixture();
  deps.facilitator.settle.mock.mockImplementation(async () => { throw new Error("sensitive response body"); });
  await assert.rejects(runSmoke(config, store, deps), error => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /settling/);
    assert.ok(!error.message.includes("sensitive response body"));
    return true;
  });
  assert.equal(store.get("KOVEN_X402_SMOKE_STATE"), "pending");
  await runSmoke(config, store, deps);
  assert.equal(deps.facilitator.settle.mock.callCount(), 1);
  assert.equal(deps.build.mock.callCount(), 1);
});

test("foreign transaction, network or payer cannot count as successful settlement", async () => {
  for (const change of [{ transaction: "0.0.40@1788725329.000000001" }, { network: "hedera:mainnet" as const }, { payer: "0.0.99" }, { success: false }]) {
    const { store, deps } = fixture();
    deps.facilitator.settle.mock.mockImplementation(async () => ({ success: true, transaction: id, network: "hedera:testnet", payer: config.consumer, ...change }));
    await assert.rejects(runSmoke(config, store, deps), /settlement response/);
    assert.equal(store.get("KOVEN_X402_SMOKE_STATE"), "pending");
    assert.equal(deps.confirm.mock.callCount(), 0);
  }
});

test("explicit reconciliation of an earlier transaction performs no new signing or payment", async () => {
  const { store, deps } = fixture();
  await runSmoke(config, store, deps, id);
  assert.equal(deps.facilitator.getSupported.mock.callCount(), 0);
  assert.equal(deps.build.mock.callCount(), 0);
  assert.equal(deps.facilitator.settle.mock.callCount(), 0);
  await assert.rejects(runSmoke(config, store, deps, "0.0.40@1788725329.000000001"), /conflicts/);
});

test("missing scheme and failed journal writes stop before settlement", async () => {
  const { store, deps } = fixture();
  deps.facilitator.getSupported.mock.mockImplementation(async () => ({ kinds: [], extensions: [], signers: {} }));
  await assert.rejects(runSmoke(config, store, deps), /Expected one/);
  assert.equal(deps.build.mock.callCount(), 0);
  const next = fixture();
  next.store.set = () => { throw new Error("disk full"); };
  await assert.rejects(runSmoke(config, next.store, next.deps));
  assert.equal(next.deps.facilitator.settle.mock.callCount(), 0);
});

test("real x402 SDK builds the expected signed HBAR transaction offline", async () => {
  const requirements: PaymentRequirements = { scheme: "exact", network: "hedera:testnet", asset: "0.0.0",
    amount: "1000000", payTo: config.provider, maxTimeoutSeconds: 180, extra: { feePayer: "0.0.40" } };
  const key = PrivateKey.generateECDSA().toStringDer();
  const payment = await buildSmokePayment(config, key, requirements);
  const decoded = inspectHederaTransaction(payment.payload.payload.transaction as string);
  assert.equal(decoded.transactionId, payment.transactionId);
  assert.equal(decoded.transactionIdAccountId, "0.0.40");
  assert.equal(decoded.hbarTransfers.find(t => t.accountId === config.consumer)?.amount, "-1000000");
  assert.equal(decoded.hbarTransfers.find(t => t.accountId === config.provider)?.amount, "1000000");
  assert.deepEqual(payment.payload.accepted, requirements);
  await assert.rejects(buildSmokePayment(config, key, { ...requirements, amount: "1" }), /does not match/);
});

test("mirror checks amounts, transaction ID, status, asset and approvals", () => {
  assertMirrorPayment({ transactions: [mirrorTx] }, config, id);
  for (const change of [{ result: "FAIL_INVALID" }, { transaction_id: "other" }, { nonce: 1 },
    { token_transfers: [{}] }, { transfers: [{ account: config.consumer, amount: -1, is_approval: false }] },
    { transfers: mirrorTx.transfers.map(t => ({ ...t, is_approval: true })) }]) {
    assert.throws(() => assertMirrorPayment({ transactions: [{ ...mirrorTx, ...change }] }, config, id));
  }
});

test("smoke configuration rejects wrong networks, assets and endpoints", () => {
  const env = { HEDERA_NETWORK: "testnet", X402_NETWORK: "hedera:testnet", X402_ASSET: "0.0.0",
    CONSUMER_ACCOUNT_ID: config.consumer, PROVIDER_A_ACCOUNT_ID: config.provider,
    X402_FACILITATOR_URL: config.facilitatorUrl, HEDERA_MIRROR_NODE_URL: config.mirrorUrl };
  const read = (values: Record<string, string>) => ({ get: (key: string) => values[key] ?? "" });
  assert.deepEqual(smokeConfig(read(env)), config);
  for (const change of [{ HEDERA_NETWORK: "mainnet" }, { X402_NETWORK: "hedera:mainnet" }, { X402_ASSET: "HBAR" },
    { X402_FACILITATOR_URL: "https://other.example" }, { PROVIDER_A_ACCOUNT_ID: config.consumer }]) {
    assert.throws(() => smokeConfig(read({ ...env, ...change })));
  }
});
