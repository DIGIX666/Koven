import { createServer, type Server } from "node:http";
import assert from "node:assert/strict";
import { mock, test } from "node:test";

import type { PaidScanRuntime } from "@koven/resource-server";

import { buildProviderEnvironments, startProviderInstances } from "../run-providers.js";

const source = {
  RESOURCE_SERVER_PORT: "3003",
  RESOURCE_SERVER_PUBLIC_URL: "http://127.0.0.1:3003",
  RESOURCE_SERVER_DATABASE_URL: "./provider-a.db",
  CALLBACK_SECRET: "provider-a-secret",
  PROVIDER_A_ACCOUNT_ID: "0.0.2001",
  PROVIDER_A_PRICE_TINYBAR: "80000000",
  PROVIDER_B_ACCOUNT_ID: "0.0.2002",
  PROVIDER_B_PRICE_TINYBAR: "45000000",
  PROVIDER_B_CALLBACK_SECRET: "provider-b-secret",
} as const;

const listeningServer = async (): Promise<Server> => {
  const server = createServer((_request, response) => response.end());
  server.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  return server;
};

test("provider launcher maps role inventory onto isolated process environments", () => {
  const [providerA, providerB] = buildProviderEnvironments(source);

  assert.deepEqual({
    PROVIDER_ID: providerA.PROVIDER_ID,
    PORT: providerA.PORT,
    PAY_TO: providerA.PAY_TO,
    PRICE_TINYBAR: providerA.PRICE_TINYBAR,
    LATENCY_MS: providerA.LATENCY_MS,
    SCAN_FAILURE_MODE: providerA.SCAN_FAILURE_MODE,
    CALLBACK_SECRET: providerA.CALLBACK_SECRET,
  }, {
    PROVIDER_ID: "prov-a",
    PORT: "3003",
    PAY_TO: "0.0.2001",
    PRICE_TINYBAR: "80000000",
    LATENCY_MS: "4000",
    SCAN_FAILURE_MODE: "none",
    CALLBACK_SECRET: "provider-a-secret",
  });
  assert.deepEqual({
    PROVIDER_ID: providerB.PROVIDER_ID,
    PORT: providerB.PORT,
    PAY_TO: providerB.PAY_TO,
    PRICE_TINYBAR: providerB.PRICE_TINYBAR,
    LATENCY_MS: providerB.LATENCY_MS,
    SCAN_FAILURE_MODE: providerB.SCAN_FAILURE_MODE,
    CALLBACK_SECRET: providerB.CALLBACK_SECRET,
  }, {
    PROVIDER_ID: "prov-b",
    PORT: "3013",
    PAY_TO: "0.0.2002",
    PRICE_TINYBAR: "45000000",
    LATENCY_MS: "9000",
    SCAN_FAILURE_MODE: "none",
    CALLBACK_SECRET: "provider-b-secret",
  });
  assert.notEqual(providerA.RESOURCE_SERVER_DATABASE_URL, providerB.RESOURCE_SERVER_DATABASE_URL);
  assert.throws(() => buildProviderEnvironments({
    ...source,
    PROVIDER_B_CALLBACK_SECRET: source.CALLBACK_SECRET,
  }), /distinct CALLBACK_SECRET/);
});

test("provider launcher starts and closes both runtime instances", async () => {
  const closes = [mock.fn(), mock.fn()];
  let runtimeIndex = 0;
  const factory = mock.fn(async (environment: Record<string, string | undefined>) => {
    const index = runtimeIndex;
    runtimeIndex += 1;
    return {
      host: "127.0.0.1",
      port: Number(environment.PORT),
      listen: listeningServer,
      close: closes[index],
    } as unknown as PaidScanRuntime;
  });

  const running = await startProviderInstances(source, factory);
  assert.equal(factory.mock.callCount(), 2);
  assert.deepEqual(running.providers, [
    { id: "prov-a", host: "127.0.0.1", port: 3003 },
    { id: "prov-b", host: "127.0.0.1", port: 3013 },
  ]);

  await running.close();
  assert.equal(closes[0]!.mock.callCount(), 1);
  assert.equal(closes[1]!.mock.callCount(), 1);
});
