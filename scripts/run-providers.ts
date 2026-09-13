import type { Server } from "node:http";
import { pathToFileURL } from "node:url";

import { createPaidScanRuntime, type PaidScanRuntime } from "@koven/resource-server";
import { config as loadDotenv } from "dotenv";

type EnvironmentSource = Record<string, string | undefined>;
type RuntimeFactory = (source: EnvironmentSource) => Promise<PaidScanRuntime>;

export interface RunningProviderInstances {
  readonly providers: readonly { id: string; host: string; port: number }[];
  close(): Promise<void>;
}

const required = (source: EnvironmentSource, key: string): string => {
  const value = source[key];
  if (!value) throw new Error(`Missing provider configuration: ${key}`);
  return value;
};

const configured = (source: EnvironmentSource, key: string): string | undefined => source[key] || undefined;

const providerEnvironment = (
  source: EnvironmentSource,
  name: "A" | "B",
): EnvironmentSource => {
  const prefix = `PROVIDER_${name}_`;
  const fallbackPort = name === "A" ? configured(source, "RESOURCE_SERVER_PORT") : "3013";
  const port = configured(source, `${prefix}PORT`) ?? fallbackPort;
  if (!port) throw new Error(`Missing provider configuration: ${prefix}PORT`);
  const providerId = configured(source, `${prefix}ID`)
    ?? (name === "A" ? configured(source, "PROVIDER_ID") ?? "prov-a" : "prov-b");
  const payTo = configured(source, `${prefix}ACCOUNT_ID`)
    ?? (name === "A" ? configured(source, "X402_PAY_TO_ACCOUNT_ID") : undefined);
  const price = required(source, `${prefix}PRICE_TINYBAR`);
  const expectedLatency = configured(source, `${prefix}LATENCY_MS`) ?? (name === "A" ? "4000" : "9000");
  const publicUrl = configured(source, `${prefix}PUBLIC_URL`)
    ?? (name === "A" ? configured(source, "RESOURCE_SERVER_PUBLIC_URL") : `http://127.0.0.1:${port}`);
  const databaseUrl = configured(source, `${prefix}DATABASE_URL`)
    ?? (name === "A" ? configured(source, "RESOURCE_SERVER_DATABASE_URL") : "./koven-provider-b.db");
  const callbackSecret = configured(source, `${prefix}CALLBACK_SECRET`)
    ?? (name === "A" ? configured(source, "CALLBACK_SECRET") : undefined);

  return {
    ...source,
    PROVIDER_ID: providerId,
    PORT: port,
    PAY_TO: payTo,
    PRICE_TINYBAR: price,
    LATENCY_MS: expectedLatency,
    SCAN_FAILURE_MODE: configured(source, `${prefix}SCAN_FAILURE_MODE`) ?? "none",
    RESOURCE_SERVER_PUBLIC_URL: publicUrl,
    RESOURCE_SERVER_DATABASE_URL: databaseUrl,
    CALLBACK_SECRET: callbackSecret,
  };
};

export function buildProviderEnvironments(
  source: EnvironmentSource = process.env,
): readonly [EnvironmentSource, EnvironmentSource] {
  const environments = [providerEnvironment(source, "A"), providerEnvironment(source, "B")] as const;
  for (const key of [
    "PROVIDER_ID",
    "PORT",
    "PAY_TO",
    "PRICE_TINYBAR",
    "LATENCY_MS",
    "RESOURCE_SERVER_PUBLIC_URL",
    "RESOURCE_SERVER_DATABASE_URL",
    "CALLBACK_SECRET",
  ]) {
    const [left, right] = environments.map(environment => environment[key]);
    if (left !== undefined && left === right) {
      throw new Error(`Provider instances require distinct ${key} values`);
    }
  }
  return environments;
}

const closeServer = (server: Server): Promise<void> => new Promise((resolve, reject) => {
  server.close(error => error === undefined ? resolve() : reject(error));
});

/** Starts two isolated instances of the production resource-server runtime. */
export async function startProviderInstances(
  source: EnvironmentSource = process.env,
  createRuntime: RuntimeFactory = createPaidScanRuntime,
): Promise<RunningProviderInstances> {
  const environments = buildProviderEnvironments(source);
  const runtimes: PaidScanRuntime[] = [];
  const listeners: Server[] = [];
  try {
    for (const environment of environments) {
      const runtime = await createRuntime(environment);
      runtimes.push(runtime);
      listeners.push(await runtime.listen());
    }
  } catch (error) {
    await Promise.allSettled(listeners.map(closeServer));
    runtimes.forEach(runtime => runtime.close());
    throw error;
  }

  return {
    providers: runtimes.map((runtime, index) => ({
      id: environments[index]!.PROVIDER_ID!,
      host: runtime.host,
      port: runtime.port,
    })),
    async close(): Promise<void> {
      await Promise.all(listeners.map(closeServer));
      runtimes.forEach(runtime => runtime.close());
    },
  };
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  try {
    loadDotenv({ path: ".env" });
    const running = await startProviderInstances();
    for (const provider of running.providers) {
      process.stdout.write(`${provider.id} listening on ${provider.host}:${provider.port}\n`);
    }
    let shuttingDown = false;
    const shutdown = (signal: NodeJS.Signals): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.stdout.write(`Stopping provider instances after ${signal}\n`);
      void running.close().then(() => process.exit(0), () => process.exit(1));
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Provider startup failed"}\n`);
    process.exitCode = 1;
  }
}
