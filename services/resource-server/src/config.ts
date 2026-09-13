import { EnvironmentValidationError, loadResourceServerEnv } from "@koven/config";
import { PublicKey } from "@koven/hedera";
import { AccountId, HttpUrl, Id, TinybarString } from "@koven/schemas";

import { decodeCallbackSecret } from "./callback.js";
import { SCAN_FAILURE_MODES, type ScanFailureMode } from "./scan.js";

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
  /** Interface the HTTP listener binds to; loopback by default, `0.0.0.0` for cross-host deployments. */
  readonly host: string;
  readonly port: number;
  readonly expectedLatencyMs: number;
  readonly scanFailureMode: ScanFailureMode;
}

const DEFAULT_HOST = "127.0.0.1";

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

/** A bare hostname, IPv4 or IPv6 literal for `listen()`; no scheme, port or path. */
function bindHost(value: string): string {
  const hostname = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(value);
  const ipv6 = /^[0-9A-Fa-f:]+$/.test(value) && value.includes(":");
  if (!hostname && !ipv6) throw new Error("Invalid bind host");
  return value;
}

function trustedOrigin(value: string): string {
  trustedServiceUrl(value);
  if (new URL(value).pathname !== "/") throw new Error("Expected a service origin");
  return value;
}

/** Loads only public/provider secrets required by the paid scan process. */
export function loadPaidScanEnvironment(source: EnvironmentSource = process.env): PaidScanEnvironment {
  const effectiveSource = {
    ...source,
    RESOURCE_SERVER_PORT: source.PORT ?? source.RESOURCE_SERVER_PORT,
    X402_PAY_TO_ACCOUNT_ID: source.PAY_TO ?? source.X402_PAY_TO_ACCOUNT_ID,
  };
  const base = loadResourceServerEnv(effectiveSource);
  const invalidKeys: string[] = [];
  const providerIdValue = required(source, "PROVIDER_ID", invalidKeys);
  const priceKey = source.PRICE_TINYBAR === undefined ? "PROVIDER_A_PRICE_TINYBAR" : "PRICE_TINYBAR";
  const amountValue = required(source, priceKey, invalidKeys);
  const publicUrlValue = required(source, "RESOURCE_SERVER_PUBLIC_URL", invalidKeys);
  const databasePath = required(source, "RESOURCE_SERVER_DATABASE_URL", invalidKeys);
  const callbackUrlValue = required(source, "CALLBACK_URL", invalidKeys);
  const callbackSecret = required(source, "CALLBACK_SECRET", invalidKeys);
  const mirrorNodeUrl = required(source, "HEDERA_MIRROR_NODE_URL", invalidKeys);
  const consumerAccountValue = required(source, "CONSUMER_ACCOUNT_ID", invalidKeys);
  const consumerPublicKey = required(source, "CONSUMER_PUBLIC_KEY", invalidKeys);
  const hostValue = source.RESOURCE_SERVER_HOST || DEFAULT_HOST;
  const latencyValue = source.LATENCY_MS ?? "0";
  const failureModeValue = source.SCAN_FAILURE_MODE ?? "none";

  const providerId = validate("PROVIDER_ID", providerIdValue, value => Id.parse(value), invalidKeys);
  const amountTinybar = validate(priceKey, amountValue, value => {
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
  const host = validate("RESOURCE_SERVER_HOST", hostValue, bindHost, invalidKeys);
  const expectedLatencyMs = validate("LATENCY_MS", latencyValue, value => {
    if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error("Latency must be a non-negative integer");
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed > 60_000) throw new Error("Latency is outside the supported range");
    return parsed;
  }, invalidKeys);
  const scanFailureMode = validate("SCAN_FAILURE_MODE", failureModeValue, value => {
    if (!SCAN_FAILURE_MODES.includes(value as ScanFailureMode)) throw new Error("Invalid scan failure mode");
    return value as ScanFailureMode;
  }, invalidKeys);

  if (invalidKeys.length > 0 || !providerId || !amountTinybar || !publicUrl
    || !facilitatorUrl || !callbackUrl || !consumerAccountId || !host
    || expectedLatencyMs === undefined || scanFailureMode === undefined) {
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
    host,
    port: base.port,
    expectedLatencyMs,
    scanFailureMode,
  });
}
