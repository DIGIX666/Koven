import { EnvironmentValidationError, loadResourceServerEnv } from "@koven/config";
import { PublicKey } from "@koven/hedera";
import { AccountId, HttpUrl, Id, TinybarString } from "@koven/schemas";

import { decodeCallbackSecret } from "./callback.js";

type EnvironmentSource = Record<string, string | undefined>;

export interface PaidScanEnvironment {
  readonly providerId: string;
  readonly providerAccountId: string;
  readonly scanUrl: string;
  readonly amountTinybar: string;
  readonly network: "hedera:testnet";
  readonly asset: "0.0.0";
  readonly facilitatorUrl: string;
  readonly mirrorNodeUrl: string;
  readonly signerPublicKeys: Readonly<Record<string, string>>;
  readonly callbackUrl: string;
  readonly callbackSecret: string;
  readonly databasePath: string;
  readonly port: number;
}

function required(source: EnvironmentSource, key: string, invalidKeys: string[]): string {
  const value = source[key];
  if (!value) {
    invalidKeys.push(key);
    return "";
  }
  return value;
}

function validate<T>(key: string, value: string, parse: (candidate: string) => T, invalidKeys: string[]): T | undefined {
  try {
    return parse(value);
  } catch {
    invalidKeys.push(key);
    return undefined;
  }
}

function publicBaseUrl(value: string): string {
  HttpUrl.parse(value);
  const url = new URL(value);
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !loopback)
    || url.username
    || url.password
    || url.search
    || url.hash
    || url.pathname !== "/"
    || value.endsWith("/")
  ) throw new Error("Invalid public resource-server URL");
  return value;
}

function trustedServiceUrl(value: string): string {
  HttpUrl.parse(value);
  const url = new URL(value);
  const loopback = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash) {
    throw new Error("Service URL must be HTTPS or loopback HTTP");
  }
  return value;
}

function trustedOrigin(value: string): string {
  trustedServiceUrl(value);
  if (new URL(value).pathname !== "/") throw new Error("Expected a service origin");
  return value;
}

/** Loads only public/provider secrets required by the paid scan process. */
export function loadPaidScanEnvironment(source: EnvironmentSource = process.env): PaidScanEnvironment {
  const base = loadResourceServerEnv(source);
  const invalidKeys: string[] = [];
  const providerIdValue = required(source, "PROVIDER_ID", invalidKeys);
  const amountValue = required(source, "PROVIDER_A_PRICE_TINYBAR", invalidKeys);
  const publicUrlValue = required(source, "RESOURCE_SERVER_PUBLIC_URL", invalidKeys);
  const databasePath = required(source, "RESOURCE_SERVER_DATABASE_URL", invalidKeys);
  const callbackUrlValue = required(source, "CALLBACK_URL", invalidKeys);
  const callbackSecret = required(source, "CALLBACK_SECRET", invalidKeys);
  const mirrorNodeUrl = required(source, "HEDERA_MIRROR_NODE_URL", invalidKeys);
  const consumerAccountValue = required(source, "CONSUMER_ACCOUNT_ID", invalidKeys);
  const consumerPublicKey = required(source, "CONSUMER_PUBLIC_KEY", invalidKeys);

  const providerId = validate("PROVIDER_ID", providerIdValue, value => Id.parse(value), invalidKeys);
  const amountTinybar = validate("PROVIDER_A_PRICE_TINYBAR", amountValue, value => {
    const parsed = TinybarString.parse(value);
    if (parsed === "0") throw new Error("Price must be positive");
    return parsed;
  }, invalidKeys);
  const publicUrl = validate("RESOURCE_SERVER_PUBLIC_URL", publicUrlValue, publicBaseUrl, invalidKeys);
  const facilitatorUrl = validate("X402_FACILITATOR_URL", base.facilitatorUrl, trustedOrigin, invalidKeys);
  const callbackUrl = validate("CALLBACK_URL", callbackUrlValue, trustedServiceUrl, invalidKeys);
  validate("CALLBACK_SECRET", callbackSecret, value => decodeCallbackSecret(value), invalidKeys);
  const consumerAccountId = validate("CONSUMER_ACCOUNT_ID", consumerAccountValue, value => AccountId.parse(value), invalidKeys);
  validate("CONSUMER_PUBLIC_KEY", consumerPublicKey, value => PublicKey.fromStringECDSA(value), invalidKeys);
  validate("HEDERA_MIRROR_NODE_URL", mirrorNodeUrl, trustedOrigin, invalidKeys);

  if (invalidKeys.length > 0 || !providerId || !amountTinybar || !publicUrl
    || !facilitatorUrl || !callbackUrl || !consumerAccountId) {
    throw new EnvironmentValidationError([...new Set(invalidKeys)].sort());
  }

  return Object.freeze({
    providerId,
    providerAccountId: base.payToAccountId,
    scanUrl: `${publicUrl}/scan`,
    amountTinybar,
    network: base.network,
    asset: base.asset,
    facilitatorUrl,
    mirrorNodeUrl,
    signerPublicKeys: Object.freeze({ [consumerAccountId]: consumerPublicKey }),
    callbackUrl,
    callbackSecret,
    databasePath,
    port: base.port,
  });
}
