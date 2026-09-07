import { describe, expect, expectTypeOf, test } from "vitest";
import {
  EnvironmentValidationError,
  loadConsumerEnv,
  loadDirectoryEnv,
  loadLenderEnv,
  loadOperatorEnv,
  loadOrchestratorEnv,
  loadResourceServerEnv,
  loadSignerEnv,
  loadWebEnv,
} from "../src/index.js";

const validEnvironment = {
  HEDERA_NETWORK: "testnet",
  HEDERA_OPERATOR_ID: "0.0.1",
  HEDERA_OPERATOR_PRIVATE_KEY: "operator-secret",
  HEDERA_MIRROR_NODE_URL: "https://testnet.mirrornode.hedera.com",
  X402_FACILITATOR_URL: "https://api.testnet.blocky402.com",
  X402_PAY_TO_ACCOUNT_ID: "0.0.2",
  X402_ASSET: "0.0.0",
  CONSUMER_ACCOUNT_ID: "0.0.3",
  CONSUMER_PRIVATE_KEY: "consumer-secret",
  LENDER_A_ACCOUNT_ID: "0.0.4",
  LENDER_A_PRIVATE_KEY: "lender-a-secret",
  LENDER_B_ACCOUNT_ID: "0.0.5",
  LENDER_B_PRIVATE_KEY: "lender-b-secret",
  HCS_AUDIT_TOPIC_ID: "0.0.6",
  DEFAULT_MISSION_SPENDING_CAP: "100000000",
  APPROVED_RECIPIENTS_ROOT: "123",
  WEB_PORT: "3000",
  ORCHESTRATOR_PORT: "3001",
  DIRECTORY_PORT: "3002",
  RESOURCE_SERVER_PORT: "3003",
  RESTRICTED_SIGNER_PORT: "3004",
  DATABASE_URL: "./koven.db",
} satisfies Record<string, string>;

describe("environment loading", () => {
  test("reports every missing key without exposing another configuration value", () => {
    const source = { ...validEnvironment, CONSUMER_PRIVATE_KEY: "", DATABASE_URL: "" };

    expect(() => loadSignerEnv(source)).toThrowError(EnvironmentValidationError);
    try {
      loadSignerEnv(source);
    } catch (error) {
      expect(error).toMatchObject({ keys: ["CONSUMER_PRIVATE_KEY", "DATABASE_URL"] });
      expect(String(error)).toContain("CONSUMER_PRIVATE_KEY");
      expect(String(error)).not.toContain("operator-secret");
    }
  });

  test("returns frozen, service-scoped views", () => {
    const signer = loadSignerEnv(validEnvironment);
    const orchestrator = loadOrchestratorEnv(validEnvironment);
    const consumer = loadConsumerEnv(validEnvironment);
    const lender = loadLenderEnv("B", validEnvironment);
    const publicViews = [
      orchestrator,
      consumer,
      loadDirectoryEnv(validEnvironment),
      loadResourceServerEnv(validEnvironment),
      loadWebEnv(validEnvironment),
    ];

    expect(Object.isFrozen(signer)).toBe(true);
    expect(signer.privateKey).toBe("consumer-secret");
    expect(lender.privateKey).toBe("lender-b-secret");
    expect(loadOperatorEnv(validEnvironment).privateKey).toBe("operator-secret");
    for (const view of publicViews) {
      expect(view).not.toHaveProperty("privateKey");
      expect(Object.values(view)).not.toContain("consumer-secret");
      expect(Object.values(view)).not.toContain("operator-secret");
    }
    expectTypeOf(orchestrator).not.toHaveProperty("privateKey");
    expectTypeOf(consumer).not.toHaveProperty("privateKey");
  });

  test("ignores unrelated process variables and rejects invalid Koven values", () => {
    expect(loadConsumerEnv({ ...validEnvironment, SHELL: "/bin/zsh" })).toEqual({
      accountId: "0.0.3",
      resourceServerPort: 3003,
      restrictedSignerPort: 3004,
    });
    expect(() => loadConsumerEnv({ ...validEnvironment, CONSUMER_ACCOUNT_ID: "not-an-account" }))
      .toThrowError(/CONSUMER_ACCOUNT_ID/);
  });

  test("normalizes the legacy HBAR label to the canonical x402 asset id", () => {
    expect(loadResourceServerEnv({ ...validEnvironment, X402_ASSET: "HBAR" }).asset).toBe("0.0.0");
  });
});
