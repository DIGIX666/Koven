import { fileURLToPath } from "node:url";
import { AccountId, AccountInfoQuery, createClient, explorerUrl, PrivateKey, PublicKey, TransactionId,
  TransactionReceiptQuery, Status, type Client } from "@koven/hedera";
import { EnvStore, OperatorError, withEnvLock } from "./env-store.js";
export { OperatorError } from "./env-store.js";

export const roles = {
  operator: "HEDERA_OPERATOR",
  consumer: "CONSUMER",
  "lender-a": "LENDER_A",
  "lender-b": "LENDER_B",
  "provider-a": "PROVIDER_A",
  "provider-b": "PROVIDER_B",
} as const;
export type Role = keyof typeof roles;
export const roleNames = Object.keys(roles) as Role[];
export const idKey = (role: Role) => role === "operator" ? "HEDERA_OPERATOR_ID" : `${roles[role]}_ACCOUNT_ID`;
export const keyKey = (role: Role) => `${roles[role]}_PRIVATE_KEY`;
export interface Context { store: EnvStore; client: Client; }

export function accountId(value: string): AccountId {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
      || value.split(".").some(v => BigInt(v) > 9223372036854775807n)) throw new OperatorError("Expected a numeric account ID");
  return AccountId.fromString(value);
}

export function tinybars(value: string): bigint {
  if (!/^[1-9]\d{0,18}$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new OperatorError("Amount must be a positive signed-int64 tinybar string");
  }
  return BigInt(value);
}

export function role(value: string): Role {
  if (!Object.hasOwn(roles, value)) throw new OperatorError(`Unknown role; expected ${roleNames.join(", ")}`);
  return value as Role;
}

export function assertDistinctAccounts(store: EnvStore): void {
  const seen = new Set<string>();
  for (const name of roleNames) {
    const id = store.get(idKey(name));
    if (!id) continue;
    accountId(id);
    if (seen.has(id)) throw new OperatorError("Each role must have a distinct account ID");
    seen.add(id);
  }
}

export async function inspectAccount(ctx: Context, name: Role): Promise<string> {
  const id = ctx.store.get(idKey(name));
  if (!id) throw new OperatorError(`Missing ${idKey(name)}`);
  const info = await new AccountInfoQuery().setAccountId(accountId(id)).execute(ctx.client);
  if (info.isDeleted) throw new OperatorError(`${name}: account is deleted`);
  if (!(info.key instanceof PublicKey) || info.key.type !== "secp256k1") {
    throw new OperatorError(`${name}: account must use a single ECDSA secp256k1 key`);
  }
  const secret = ctx.store.get(keyKey(name));
  if (!secret && !name.startsWith("provider-")) throw new OperatorError(`${name}: missing signing key in .env`);
  if (secret) {
    let key: PrivateKey;
    try { key = PrivateKey.fromStringECDSA(secret); }
    catch { throw new OperatorError(`${name}: invalid ECDSA key in .env`); }
    if (info.key.toString() !== key.publicKey.toString()) throw new OperatorError(`${name}: key does not match account`);
  }
  return id;
}

/** A saved transaction is reconciled, never automatically resubmitted. */
export async function savedReceipt(ctx: Context, transactionId: string) {
  console.info(`Reconcile: ${explorerUrl(transactionId)}`);
  const receipt = await new TransactionReceiptQuery().setTransactionId(TransactionId.fromString(transactionId))
    .setValidateStatus(false).execute(ctx.client);
  if (receipt.status !== Status.Success) {
    throw new OperatorError("Saved transaction has no SUCCESS receipt. Inspect its HashScan history before changing the journal; do not blindly retry.");
  }
  return receipt;
}

export function announce(transactionId: TransactionId): void {
  console.info(`Transaction: ${explorerUrl(transactionId.toString())}`);
}

export async function run(work: (ctx: Context) => Promise<void>): Promise<void> {
  const path = fileURLToPath(new URL("../../.env", import.meta.url));
  try {
    await withEnvLock(path, async () => {
      const store = new EnvStore(path);
      if (store.get("HEDERA_NETWORK") !== "testnet"
          || (process.env.HEDERA_NETWORK && process.env.HEDERA_NETWORK !== "testnet")) {
        throw new OperatorError("HEDERA_NETWORK must be testnet");
      }
      assertDistinctAccounts(store);
      const client = createClient({ HEDERA_NETWORK: store.get("HEDERA_NETWORK"),
        HEDERA_OPERATOR_ID: store.get("HEDERA_OPERATOR_ID"),
        HEDERA_OPERATOR_PRIVATE_KEY: store.get("HEDERA_OPERATOR_PRIVATE_KEY") })
        .setRequestTimeout(30_000).setMaxAttempts(3);
      try {
        await inspectAccount({ store, client }, "operator");
        await work({ store, client });
      } finally { client.close(); }
    });
  } catch (error) {
    // SDK errors may contain signed transaction objects. Only our errors are printable.
    console.error(error instanceof OperatorError ? error.message : "Hedera operation failed. Check .env, network access and any printed transaction link; keep pending journal entries for reconciliation.");
    process.exitCode = 1;
  }
}
