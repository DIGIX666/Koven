import { PrivateKey } from "@koven/hedera";
import { describe, expect, it } from "vitest";

import { loadPaidScanEnvironment } from "../src/config.js";

const signer = PrivateKey.generateECDSA();
const valid = {
  X402_NETWORK: "hedera:testnet",
  X402_FACILITATOR_URL: "https://api.testnet.blocky402.com",
  X402_PAY_TO_ACCOUNT_ID: "0.0.2001",
  X402_ASSET: "0.0.0",
  RESOURCE_SERVER_PORT: "3003",
  PROVIDER_ID: "provider-a",
  PROVIDER_A_PRICE_TINYBAR: "1000000",
  RESOURCE_SERVER_PUBLIC_URL: "http://127.0.0.1:3003",
  RESOURCE_SERVER_DATABASE_URL: "./provider.db",
  CALLBACK_URL: "http://127.0.0.1:3001/callbacks/mission-complete",
  CALLBACK_SECRET: Buffer.alloc(32, 1).toString("base64url"),
  HEDERA_MIRROR_NODE_URL: "https://testnet.mirrornode.hedera.com",
  CONSUMER_ACCOUNT_ID: "0.0.1001",
  CONSUMER_PUBLIC_KEY: signer.publicKey.toStringRaw(),
} as const;

describe("loadPaidScanEnvironment", () => {
  it("builds a process-scoped configuration without private signing keys", () => {
    const config = loadPaidScanEnvironment(valid);

    expect(config).toMatchObject({
      providerId: "provider-a",
      providerAccountId: "0.0.2001",
      scanUrl: "http://127.0.0.1:3003/scan",
      amountTinybar: "1000000",
      callbackUrl: "http://127.0.0.1:3001/callbacks/mission-complete",
    });
    expect(config.signerPublicKeys).toEqual({ "0.0.1001": signer.publicKey.toStringRaw() });
    expect(config).not.toHaveProperty("privateKey");
    expect(Object.isFrozen(config)).toBe(true);
    expect(config.host).toBe("127.0.0.1");
    expect(config.expectedLatencyMs).toBe(0);
    expect(config.scanFailureMode).toBe("none");
  });

  it("prefers generic per-process provider settings over legacy single-provider values", () => {
    const config = loadPaidScanEnvironment({
      ...valid,
      PROVIDER_ID: "provider-b",
      PORT: "3013",
      PAY_TO: "0.0.2002",
      PRICE_TINYBAR: "45000000",
      LATENCY_MS: "9000",
      SCAN_FAILURE_MODE: "malformed",
      RESOURCE_SERVER_PUBLIC_URL: "http://127.0.0.1:3013",
    });

    expect(config).toMatchObject({
      providerId: "provider-b",
      providerAccountId: "0.0.2002",
      amountTinybar: "45000000",
      port: 3013,
      expectedLatencyMs: 9000,
      scanFailureMode: "malformed",
      scanUrl: "http://127.0.0.1:3013/scan",
    });
  });

  it("binds to the configured interface and rejects hosts carrying a scheme, port or path", () => {
    expect(loadPaidScanEnvironment({ ...valid, RESOURCE_SERVER_HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    expect(loadPaidScanEnvironment({ ...valid, RESOURCE_SERVER_HOST: "::" }).host).toBe("::");
    expect(loadPaidScanEnvironment({ ...valid, RESOURCE_SERVER_HOST: "provider.internal" }).host).toBe("provider.internal");
    for (const host of ["http://0.0.0.0", "0.0.0.0:3003", "localhost/scan", " "]) {
      expect(() => loadPaidScanEnvironment({ ...valid, RESOURCE_SERVER_HOST: host })).toThrowError(/RESOURCE_SERVER_HOST/);
    }
  });

  it("rejects unsafe URLs, zero prices, malformed keys and short callback secrets", () => {
    expect(() => loadPaidScanEnvironment({
      ...valid,
      PROVIDER_A_PRICE_TINYBAR: "0",
      RESOURCE_SERVER_PUBLIC_URL: "http://remote.example",
      X402_FACILITATOR_URL: "http://remote.example",
      CONSUMER_PUBLIC_KEY: "not-a-key",
      CALLBACK_SECRET: "c2hvcnQ",
    })).toThrowError(/CALLBACK_SECRET.*CONSUMER_PUBLIC_KEY.*PROVIDER_A_PRICE_TINYBAR.*RESOURCE_SERVER_PUBLIC_URL.*X402_FACILITATOR_URL/);
  });

  it("rejects unsupported latency and failure controls", () => {
    expect(() => loadPaidScanEnvironment({
      ...valid,
      LATENCY_MS: "60001",
      SCAN_FAILURE_MODE: "corrupt",
    })).toThrowError(/LATENCY_MS.*SCAN_FAILURE_MODE/);
  });
});
