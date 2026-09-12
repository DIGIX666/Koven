import { EnvironmentValidationError, loadSignerEnv } from "@koven/config";
import { PrivateKey, PublicKey } from "@koven/hedera";
import { AccountId, Id } from "@koven/schemas";

type EnvironmentSource = Record<string, string | undefined>;

/** Opaque service credentials: 32 bytes or more, base64url without padding. */
const CREDENTIAL = /^[A-Za-z0-9_-]{43,}$/;
const CALLBACK_SECRET = /^[A-Za-z0-9_-]+$/;
const DEFAULT_HOST = "127.0.0.1";

export interface SignerConfig {
  readonly network: "hedera:testnet";
  readonly accountId: string;
  readonly privateKey: PrivateKey;
  /** The configured key text, handed only to the Hedera client factory. */
  readonly privateKeyText: string;
  readonly mirrorNodeUrl: string;
  readonly databasePath: string;
  readonly host: string;
  readonly port: number;
  /** Service credentials mapped to roles in configuration, never asserted by callers. */
  readonly credentials: {
    readonly consumer: string;
    readonly orchestrator: string;
    readonly registrar: string;
    /** Lender credential → lender account ID. */
    readonly lenders: Readonly<Record<string, string>>;
  };
  /** Lender account ID → pinned ECDSA public key (raw hex). */
  readonly lenderPublicKeys: Readonly<Record<string, string>>;
  /** Provider ID → decoded 32-byte callback secret. */
  readonly providerCallbackSecrets: Readonly<Record<string, Uint8Array>>;
}

function required(source: EnvironmentSource, key: string, invalid: string[]): string {
  const value = source[key];
  if (!value) {
    invalid.push(key);
    return "";
  }
  return value;
}

function credential(source: EnvironmentSource, key: string, invalid: string[]): string {
  const value = required(source, key, invalid);
  if (value && !CREDENTIAL.test(value)) invalid.push(key);
  return value;
}

/** Parses `key:value;key:value` maps; keys and values are validated by the caller. */
function pairs(value: string): [string, string][] {
  return value.split(";").filter(entry => entry.length > 0).map(entry => {
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator === entry.length - 1) throw new Error("Malformed map entry");
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  });
}

function bindHost(value: string): string {
  const hostname = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(value);
  const ipv6 = /^[0-9A-Fa-f:]+$/.test(value) && value.includes(":");
  if (!hostname && !ipv6) throw new Error("Invalid bind host");
  return value;
}

function trustedOrigin(value: string): string {
  const url = new URL(value);
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Expected an HTTPS or loopback origin");
  }
  return value;
}

export function decodeCallbackSecret(encoded: string): Uint8Array {
  if (!CALLBACK_SECRET.test(encoded)) throw new Error("Callback secret must be unpadded base64url");
  const secret = Buffer.from(encoded, "base64url");
  if (secret.length !== 32 || secret.toString("base64url") !== encoded) {
    throw new Error("Callback secret must encode exactly 32 bytes");
  }
  return secret;
}

function validate<T>(key: string, parse: () => T, invalid: string[]): T | undefined {
  try {
    return parse();
  } catch {
    invalid.push(key);
    return undefined;
  }
}

/**
 * Loads the only process configuration allowed to hold `CONSUMER_PRIVATE_KEY`.
 * Every counterparty identity comes from here: credentials map to roles and
 * lender accounts, lender keys and provider callback secrets are pinned, and
 * request bodies can never introduce a new one.
 */
export function loadSignerConfig(source: EnvironmentSource = process.env): SignerConfig {
  const base = loadSignerEnv(source);
  const invalid: string[] = [];

  const privateKey = validate("CONSUMER_PRIVATE_KEY", () => PrivateKey.fromStringECDSA(base.privateKey), invalid);
  const mirrorNodeUrl = validate("HEDERA_MIRROR_NODE_URL", () => trustedOrigin(base.mirrorNodeUrl), invalid);
  const host = validate("RESTRICTED_SIGNER_HOST", () => bindHost(source.RESTRICTED_SIGNER_HOST || DEFAULT_HOST), invalid);
  const consumer = credential(source, "SIGNER_CONSUMER_CREDENTIAL", invalid);
  const orchestrator = credential(source, "SIGNER_ORCHESTRATOR_CREDENTIAL", invalid);
  const registrar = credential(source, "SIGNER_REGISTRAR_CREDENTIAL", invalid);

  const lenders = validate("SIGNER_LENDER_CREDENTIALS", () => {
    const map: Record<string, string> = {};
    for (const [accountId, token] of pairs(required(source, "SIGNER_LENDER_CREDENTIALS", invalid))) {
      if (!CREDENTIAL.test(token) || token in map) throw new Error("Invalid lender credential");
      map[token] = AccountId.parse(accountId);
    }
    if (Object.keys(map).length === 0) throw new Error("At least one lender credential is required");
    return map;
  }, invalid);
  const lenderPublicKeys = validate("SIGNER_LENDER_PUBLIC_KEYS", () => {
    const map: Record<string, string> = {};
    for (const [accountId, key] of pairs(required(source, "SIGNER_LENDER_PUBLIC_KEYS", invalid))) {
      map[AccountId.parse(accountId)] = PublicKey.fromStringECDSA(key).toStringRaw();
    }
    if (Object.keys(map).length === 0) throw new Error("At least one lender key is required");
    return map;
  }, invalid);
  const providerCallbackSecrets = validate("SIGNER_PROVIDER_CALLBACK_SECRETS", () => {
    const map: Record<string, Uint8Array> = {};
    for (const [providerId, secret] of pairs(required(source, "SIGNER_PROVIDER_CALLBACK_SECRETS", invalid))) {
      map[Id.parse(providerId)] = decodeCallbackSecret(secret);
    }
    if (Object.keys(map).length === 0) throw new Error("At least one provider callback secret is required");
    return map;
  }, invalid);

  const distinct = new Set([consumer, orchestrator, registrar, ...Object.keys(lenders ?? {})]);
  if (distinct.size !== 3 + Object.keys(lenders ?? {}).length) {
    invalid.push("SIGNER_CONSUMER_CREDENTIAL", "SIGNER_ORCHESTRATOR_CREDENTIAL", "SIGNER_REGISTRAR_CREDENTIAL", "SIGNER_LENDER_CREDENTIALS");
  }

  if (invalid.length > 0 || !privateKey || !mirrorNodeUrl || !host || !lenders || !lenderPublicKeys || !providerCallbackSecrets) {
    throw new EnvironmentValidationError([...new Set(invalid)].sort());
  }

  return Object.freeze({
    network: base.x402Network,
    accountId: base.accountId,
    privateKey,
    privateKeyText: base.privateKey,
    mirrorNodeUrl,
    databasePath: base.databaseUrl,
    host,
    port: base.port,
    credentials: Object.freeze({ consumer, orchestrator, registrar, lenders: Object.freeze(lenders) }),
    lenderPublicKeys: Object.freeze(lenderPublicKeys),
    providerCallbackSecrets: Object.freeze(providerCallbackSecrets),
  });
}
