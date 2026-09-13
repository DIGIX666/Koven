import type { Server } from "node:http";
import { createDirectoryApp, ProviderRegistry } from "@koven/directory";
import { HttpProviderDirectory } from "@koven/orchestrator";
import { createEvent, openDatabase } from "@koven/persistence";
import { expect, it } from "vitest";
import { injectCompetitionFailures } from "./competition-history.js";

it("switches the reference-price winner after a real-success event and the shared failure fixture", async () => {
  const database = openDatabase(":memory:");
  const registry = new ProviderRegistry([
    { id: "provider-a", accountId: "0.0.20", endpoint: "http://127.0.0.1:3003", capability: "solidity-scan", priceTinybar: "80000000", expectedLatencyMs: 4000 },
    { id: "provider-b", accountId: "0.0.21", endpoint: "http://127.0.0.1:3013", capability: "solidity-scan", priceTinybar: "45000000", expectedLatencyMs: 9000 },
  ]);
  const app = createDirectoryApp({ database, registry });
  const server = await new Promise<Server>((resolve, reject) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); listener.once("error", reject);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing listener");
    const client = new HttpProviderDirectory({ baseUrl: `http://127.0.0.1:${address.port}` });
    const query = { capability: "solidity-scan", maxPriceTinybar: "100000000" };
    expect((await client.rank(query)).ranked[0]?.provider.id).toBe("provider-b");
    createEvent(database, { id: "success", missionId: "completed", type: "report-received", payloadHash: "0".repeat(64),
      payload: { detail: { providerId: "provider-b" } }, occurredAt: new Date().toISOString() });
    injectCompetitionFailures(database, "provider-b");
    const ranked = (await client.rank(query)).ranked;
    expect(ranked.map(item => item.provider.id)).toEqual(["provider-a", "provider-b"]);
    expect(ranked[1]?.provider.reputationScore).toBeCloseTo(2 / 11);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    database.close();
  }
});
