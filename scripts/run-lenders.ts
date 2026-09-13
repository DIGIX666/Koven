import { pathToFileURL } from "node:url";
import type { Server } from "node:http";
import { createLenderRuntime } from "@koven/lender-agents";
import { config as loadDotenv } from "dotenv";

type Environment = Record<string, string | undefined>;
export function buildLenderEnvironments(source: Environment) {
  const environments = (["A", "B"] as const).map(name => {
    const environment: Environment = {};
    for (const key of ["CONSUMER_ACCOUNT_ID", "CONSUMER_PUBLIC_KEY", "HEDERA_MIRROR_NODE_URL", "LENDER_PROOF_MODE", "LENDER_VERIFICATION_KEY_PATH", "LENDER_TRUSTED_VKEY_SHA256", "SIGNER_URL", "LENDER_BORROWER_REPUTATION"]) environment[key] = source[key];
    for (const key of ["ACCOUNT_ID", "PRIVATE_KEY", "PORT", "DATABASE_URL", "REGISTRAR_CREDENTIAL", "SIGNER_CREDENTIAL"]) {
      const value = source[`LENDER_${name}_${key}`];
      if (!value) throw new Error(`Missing LENDER_${name}_${key}`);
      environment[`LENDER_${key}`] = value;
    }
    environment.LENDER_POLICY = name === "A" ? "conservative" : "competitive";
    return environment;
  });
  for (const key of ["ACCOUNT_ID", "PORT", "DATABASE_URL", "REGISTRAR_CREDENTIAL", "SIGNER_CREDENTIAL"]) {
    if (environments[0]![`LENDER_${key}`] === environments[1]![`LENDER_${key}`]) throw new Error(`Lenders require distinct ${key}`);
  }
  return environments;
}
export async function startLenderInstances(source: Environment = process.env, factory = createLenderRuntime) {
  const environments = buildLenderEnvironments(source);
  const runtimes: Awaited<ReturnType<typeof createLenderRuntime>>[] = [];
  const servers: Server[] = [];
  const close = async () => {
    const listeners = await Promise.allSettled(servers.map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))));
    const resources = await Promise.allSettled(runtimes.map(async runtime => runtime.close()));
    const failures = [...listeners, ...resources].filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Lender cleanup failed");
  };
  try {
    for (const environment of environments) {
      const runtime = await factory(environment);
      runtimes.push(runtime);
      servers.push(await runtime.listen());
    }
    return { close };
  } catch (error) { await close().catch(() => undefined); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadDotenv({ path: ".env" });
  const running = await startLenderInstances();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void running.close().then(() => process.exit(0), () => process.exit(1)); });
}
