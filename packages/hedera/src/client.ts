import { AccountId, Client, PrivateKey } from "@hiero-ledger/sdk";

export interface HederaEnvironment {
  HEDERA_NETWORK?: string | undefined;
  HEDERA_OPERATOR_ID?: string | undefined;
  HEDERA_OPERATOR_PRIVATE_KEY?: string | undefined;
}

/** Numeric IDs only: no aliases, checksums or alternate textual encodings. */
export function parseAccountId(value: string): AccountId {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)
      || value.split(".").some(part => BigInt(part) > 9223372036854775807n)) {
    throw new Error("Expected a canonical numeric Hedera account ID");
  }
  return AccountId.fromString(value);
}

/** Caller owns the client and must close it in a finally block. */
export function createClient(env: HederaEnvironment): Client {
  if (env.HEDERA_NETWORK !== "testnet") throw new Error("HEDERA_NETWORK must be testnet");
  if (!env.HEDERA_OPERATOR_ID || !env.HEDERA_OPERATOR_PRIVATE_KEY) {
    throw new Error("Hedera operator ID and private key are required");
  }
  const accountId = parseAccountId(env.HEDERA_OPERATOR_ID);
  let key: PrivateKey;
  try {
    key = PrivateKey.fromStringECDSA(env.HEDERA_OPERATOR_PRIVATE_KEY);
  } catch {
    // Do not propagate parser errors that might contain the supplied secret.
    throw new Error("Invalid ECDSA operator private key");
  }
  return Client.forTestnet().setOperator(accountId, key);
}

export function assertTestnetOperator(client: Client): AccountId {
  if (client.ledgerId?.toString() !== "testnet" || !client.operatorAccountId) {
    throw new Error("A testnet client with an operator is required");
  }
  return client.operatorAccountId;
}
