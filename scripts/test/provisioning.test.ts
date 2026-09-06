import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, statSync, rmSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "dotenv";
import { EnvStore, updateEnv, withEnvLock } from "../lib/env-store.js";
import { accountId, assertDistinctAccounts, role, tinybars } from "../lib/hedera.js";
import { topUpAmount } from "../lib/funding.js";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "koven-provision-"));
  const path = join(directory, ".env");
  writeFileSync(path, "# Local configuration\nHEDERA_NETWORK=testnet\nHEDERA_OPERATOR_ID=0.0.10\nCONSUMER_ACCOUNT_ID=0.0.20\n");
  return { directory, path, clean: () => rmSync(directory, { recursive: true, force: true }) };
}

test("env updates preserve unrelated secrets/comments and remove duplicate assignments", () => {
  const before = '# Keep this comment\nOTHER_SECRET="test sentinel with spaces"\nPROVIDER_A_ACCOUNT_ID=\nexport PROVIDER_A_ACCOUNT_ID=0.0.99\n';
  const after = updateEnv(before, { PROVIDER_A_ACCOUNT_ID: "0.0.30", KOVEN_CREATE_PROVIDER_A_TX_ID: "0.0.10@1.000000001" });
  assert.equal(parse(after).OTHER_SECRET, parse(before).OTHER_SECRET);
  assert.equal(parse(after).PROVIDER_A_ACCOUNT_ID, "0.0.30");
  assert.equal(after.match(/PROVIDER_A_ACCOUNT_ID=/g)?.length, 1);
  assert.ok(after.startsWith("# Keep this comment"));
  assert.throws(() => updateEnv(before, { X: "value\nINJECTED=yes" }));
});

test("keys and transaction journal survive reopening and remain mode 0600", () => {
  const f = fixture();
  try {
    const store = new EnvStore(f.path);
    store.set({ PROVIDER_A_PRIVATE_KEY: "test-only-key", KOVEN_CREATE_PROVIDER_A_TX_ID: "0.0.10@1.000000001" });
    const reopened = new EnvStore(f.path);
    assert.equal(reopened.get("PROVIDER_A_PRIVATE_KEY"), "test-only-key");
    assert.equal(reopened.get("KOVEN_CREATE_PROVIDER_A_TX_ID"), "0.0.10@1.000000001");
    assert.equal(statSync(f.path).mode & 0o777, 0o600);
    reopened.set({ PROVIDER_A_ACCOUNT_ID: "0.0.30" });
    assert.equal(new EnvStore(f.path).get("PROVIDER_A_PRIVATE_KEY"), "test-only-key");
  } finally { f.clean(); }
});

test("concurrent provisioning is rejected and a failed operation releases its lock", async () => {
  const f = fixture();
  try {
    await assert.rejects(withEnvLock(f.path, async () => {
      await assert.rejects(withEnvLock(f.path, async () => {}), /lock unavailable/);
      throw new Error("simulated network failure");
    }), /simulated network failure/);
    assert.equal(existsSync(`${f.path}.provision.lock`), false);
    await withEnvLock(f.path, async () => {});
  } finally { f.clean(); }
});

test("manual edits are not overwritten and symlink env files are refused", () => {
  const f = fixture();
  try {
    const store = new EnvStore(f.path);
    const edited = readFileSync(f.path, "utf8") + "# manual edit\n";
    writeFileSync(f.path, edited);
    assert.throws(() => store.set({ HCS_AUDIT_TOPIC_ID: "0.0.50" }), /changed during provisioning/);
    assert.equal(readFileSync(f.path, "utf8"), edited);
    const link = join(f.directory, ".env.link");
    symlinkSync(f.path, link);
    assert.throws(() => new EnvStore(link), /regular file/);
  } finally { f.clean(); }
});

test("numeric validation and role separation reject ambiguous funding targets", () => {
  assert.equal(accountId("0.0.20").toString(), "0.0.20");
  for (const value of ["0.0.020", "0x1234", "0.0.-1"]) assert.throws(() => accountId(value));
  for (const value of ["0", "-1", "1e8", "01", "9223372036854775808"]) assert.throws(() => tinybars(value));
  assert.equal(tinybars("9007199254740993"), 9007199254740993n);
  assert.throws(() => role("__proto__"));
  const f = fixture();
  try {
    const store = new EnvStore(f.path);
    store.set({ PROVIDER_A_ACCOUNT_ID: "0.0.20" });
    assert.throws(() => assertDistinctAccounts(store), /distinct/);
  } finally { f.clean(); }
});

test("funding tops up only the exact shortfall and a repeated target sends nothing", () => {
  assert.equal(topUpAmount(1n, 9007199254740993n), 9007199254740992n);
  assert.equal(topUpAmount(100n, 100n), 0n);
  assert.equal(topUpAmount(101n, 100n), 0n);
  assert.throws(() => topUpAmount(-1n, 100n));
});

test("account inspection rejects an Ed25519 account or a mismatched local key", async t => {
  const { AccountInfoQuery, PrivateKey } = await import("@koven/hedera");
  const { inspectAccount } = await import("../lib/hedera.js");
  const f = fixture();
  try {
    const key = PrivateKey.generateECDSA();
    const store = new EnvStore(f.path);
    store.set({ CONSUMER_PRIVATE_KEY: key.toStringDer() });
    const ctx = { store, client: {} as import("@koven/hedera").Client };
    let accountKey = PrivateKey.generateED25519().publicKey;
    t.mock.method(AccountInfoQuery.prototype, "execute", async () => ({ key: accountKey, isDeleted: false }));
    await assert.rejects(inspectAccount(ctx, "consumer"), /single ECDSA/);
    accountKey = PrivateKey.generateECDSA().publicKey;
    await assert.rejects(inspectAccount(ctx, "consumer"), /does not match/);
    accountKey = key.publicKey;
    assert.equal(await inspectAccount(ctx, "consumer"), "0.0.20");
  } finally { f.clean(); }
});

test("pending transactions reconcile by their saved ID and reject unsuccessful receipts", async t => {
  const { TransactionReceiptQuery, Status } = await import("@koven/hedera");
  const { savedReceipt } = await import("../lib/hedera.js");
  const f = fixture();
  try {
    const ctx = { store: new EnvStore(f.path), client: {} as import("@koven/hedera").Client };
    let status = Status.Success;
    t.mock.method(console, "info", () => {});
    t.mock.method(TransactionReceiptQuery.prototype, "execute", async function (this: InstanceType<typeof TransactionReceiptQuery>) {
      assert.equal(this.transactionId?.toString(), "0.0.10@1.000000001");
      return { status };
    });
    assert.equal((await savedReceipt(ctx, "0.0.10@1.000000001")).status, Status.Success);
    status = Status.InvalidSignature;
    await assert.rejects(savedReceipt(ctx, "0.0.10@1.000000001"), /no SUCCESS/);
  } finally { f.clean(); }
});
