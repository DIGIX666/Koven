import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PrivateKey } from "@koven/hedera";
import { buildLenderEnvironments, startLenderInstances } from "../run-lenders.js";

const freePort = async () => {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>(resolve => server.close(() => resolve()));
  if (!address || typeof address === "string") throw new Error("Missing port");
  return String(address.port);
};

test("launches two real lender apps with isolated keys, stores and policies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "koven-lenders-"));
  const source: Record<string, string> = {
    CONSUMER_ACCOUNT_ID: "0.0.10", CONSUMER_PUBLIC_KEY: PrivateKey.generateECDSA().publicKey.toStringRaw(),
    HEDERA_MIRROR_NODE_URL: "https://testnet.mirrornode.hedera.com", LENDER_PROOF_MODE: "deterministic",
    HCS_AUDIT_TOPIC_ID: "0.0.50",
    SIGNER_URL: "http://127.0.0.1:3004", LENDER_BORROWER_REPUTATION: "0.9",
    CONSUMER_PRIVATE_KEY: "must-not-reach-lenders", SIGNER_REGISTRAR_CREDENTIAL: "must-not-reach-lenders",
  };
  for (const [index, name] of ["A", "B"].entries()) Object.assign(source, {
    [`LENDER_${name}_ACCOUNT_ID`]: `0.0.${20 + index}`, [`LENDER_${name}_PRIVATE_KEY`]: PrivateKey.generateECDSA().toStringRaw(),
    [`LENDER_${name}_PORT`]: await freePort(), [`LENDER_${name}_DATABASE_URL`]: join(directory, `${name}.db`),
    [`LENDER_${name}_REGISTRAR_CREDENTIAL`]: name.repeat(43), [`LENDER_${name}_SIGNER_CREDENTIAL`]: name.toLowerCase().repeat(43),
  });
  const environments = buildLenderEnvironments(source);
  assert.deepEqual(environments.map(environment => environment.LENDER_POLICY), ["conservative", "competitive"]);
  assert.ok(environments.every(environment => environment.CONSUMER_PRIVATE_KEY === undefined && environment.SIGNER_REGISTRAR_CREDENTIAL === undefined));
  assert.throws(() => buildLenderEnvironments({ ...source, LENDER_B_PORT: source.LENDER_A_PORT }), /distinct PORT/);
  const running = await startLenderInstances(source);
  try {
    for (const name of ["A", "B"]) {
      const response = await fetch(`http://127.0.0.1:${source[`LENDER_${name}_PORT`]}/credit/quote`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
      assert.equal(response.status, 400);
    }
  } finally { await running.close(); await rm(directory, { recursive: true, force: true }); }
});
