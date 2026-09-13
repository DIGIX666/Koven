import { readFile } from "node:fs/promises";
import { config as loadDotenv } from "dotenv";
import { createDirectoryApp, createRegistrarApp, HttpMissionPolicyTarget, ProviderRegistry } from "@koven/directory";
import { openDatabase } from "@koven/persistence";

loadDotenv({ path: ".env" });
const required = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing directory configuration: ${key}`);
  return value;
};
const registrar = process.argv.includes("--registrar");
const port = Number(required(registrar ? "REGISTRAR_PORT" : "DIRECTORY_PORT"));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid service port");
const registry = new ProviderRegistry(process.env.DIRECTORY_PROVIDERS_FILE
  ? JSON.parse(await readFile(process.env.DIRECTORY_PROVIDERS_FILE, "utf8"))
  : ["A", "B"].map(name => ({ id: required(`PROVIDER_${name}_ID`), accountId: required(`PROVIDER_${name}_ACCOUNT_ID`),
    endpoint: required(`PROVIDER_${name}_PUBLIC_URL`), capability: "solidity-scan", priceTinybar: required(`PROVIDER_${name}_PRICE_TINYBAR`),
    expectedLatencyMs: Number(required(`PROVIDER_${name}_LATENCY_MS`)) })));
const events = openDatabase(required("DATABASE_URL"));
const approvals = registrar ? openDatabase(required("REGISTRAR_DATABASE_URL")) : undefined;
try {
  const app = approvals === undefined ? createDirectoryApp({ database: events, registry }) : await createRegistrarApp({
    database: approvals, eventDatabase: events, registry,
    borrowerAccountId: required("CONSUMER_ACCOUNT_ID"),
    operatorCredential: required("REGISTRAR_OPERATOR_CREDENTIAL"),
    orchestratorCredential: required("SIGNER_ORCHESTRATOR_CREDENTIAL"),
    targets: [new HttpMissionPolicyTarget({ baseUrl: required("SIGNER_URL"), credential: required("SIGNER_REGISTRAR_CREDENTIAL") }),
      ...["A", "B"].map(name => new HttpMissionPolicyTarget({ baseUrl: required(`LENDER_${name}_URL`), credential: required(`LENDER_${name}_REGISTRAR_CREDENTIAL`) }))],
  });
  const server = app.listen(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  process.stdout.write(`${registrar ? "Registrar" : "Directory"} listening on 127.0.0.1:${port}\n`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close(() => {
    try { approvals?.close(); } finally { events.close(); }
  }));
} catch (error) {
  try { approvals?.close(); } finally { events.close(); }
  throw error;
}
