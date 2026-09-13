import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Runs the executable from an isolated directory, without reading the developer's .env.
test("directory executable serves registry metadata and shuts down cleanly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "koven-directory-"));
  const probe = createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const address = probe.address();
  await new Promise<void>(resolve => probe.close(() => resolve()));
  assert.ok(address && typeof address !== "string");
  const registryPath = join(directory, "providers.json");
  await writeFile(registryPath, JSON.stringify(["a_", "A", "a-"].map((id, index) => ({ id, accountId: `0.0.${20 + index}`, endpoint: `http://127.0.0.1:${4000 + index}`,
    capability: "solidity-scan", priceTinybar: "100", expectedLatencyMs: 50 }))));
  const child = spawn(process.execPath, ["--import", fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url)), fileURLToPath(new URL("../run-directory.ts", import.meta.url))], {
    cwd: directory, env: { PATH: process.env.PATH, DIRECTORY_PORT: String(address.port), DATABASE_URL: join(directory, "events.db"), DIRECTORY_PROVIDERS_FILE: registryPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Directory startup timed out")), 10000);
      child.stdout.on("data", (data: Buffer) => { if (data.toString().includes("listening")) { clearTimeout(timeout); resolve(); } });
      child.once("exit", () => { clearTimeout(timeout); reject(new Error("Directory exited during startup")); });
      child.once("error", error => { clearTimeout(timeout); reject(error); });
    });
    const response = await fetch(`http://127.0.0.1:${address.port}/providers`);
    assert.equal(response.status, 200);
    const records = await response.json() as { id: string }[];
    assert.deepEqual(records.map(record => record.id), ["A", "a-", "a_"]);
  } finally {
    child.kill("SIGTERM");
    assert.equal(await exited, 0);
    await rm(directory, { recursive: true, force: true });
  }
});
