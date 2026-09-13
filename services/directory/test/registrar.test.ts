import { createHash } from "node:crypto";
import type { Server } from "node:http";
import { createEvent, openDatabase } from "@koven/persistence";
import { MissionPolicyRequestSchema, ProviderRankResponseSchema } from "@koven/schemas";
import { loadPoseidon } from "@koven/x402";
import { buildMissionRecipientRoot } from "@koven/zk-policy";
import { expect, it, vi } from "vitest";
import { createRegistrarApp, ProviderRegistry } from "../src/index.js";

it("requires operator approval, freezes selection, rejects forged policies and retries all targets after restart", async () => {
  const database = openDatabase(":memory:");
  const events = openDatabase(":memory:");
  const operator = "o".repeat(43);
  const orchestrator = "c".repeat(43);
  const targets = Array.from({ length: 3 }, () => ({ register: vi.fn(async () => undefined) }));
  const registry = new ProviderRegistry(["A", "b"].map((id, index) => ({ id, accountId: `0.0.${20 + index}`,
    endpoint: `http://127.0.0.1:${3003 + index}`, capability: "solidity-scan", priceTinybar: "100", expectedLatencyMs: 50 })));
  const options = { database, eventDatabase: events, registry, borrowerAccountId: "0.0.10", operatorCredential: operator, orchestratorCredential: orchestrator, targets };
  let server: Server | undefined;
  const start = async () => {
    const app = await createRegistrarApp(options);
    server = await new Promise<Server>((resolve, reject) => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); listener.once("error", reject); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing listener");
    return `http://127.0.0.1:${address.port}`;
  };
  const close = () => new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
  let origin = await start();
  const post = (path: string, body: unknown, credential = orchestrator) => fetch(`${origin}${path}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${credential}` }, body: JSON.stringify(body),
  });
  const request = { prompt: "Scan", source: "contract Test {}", targetRef: "Test.sol", maxBudgetTinybar: "200" };
  const approval = { missionId: "mission-approved", request };
  try {
    for (const path of ["/missions/approve", "/missions/approve/", "/MISSIONS/APPROVE"]) {
      expect((await post(path, approval)).status).toBe(401);
    }
    expect((await post("/missions/approve", approval, operator)).status).toBe(200);
    createEvent(events, { id: "failed", missionId: "history", type: "mission-failed", payloadHash: "0".repeat(64), payload: { providerId: "A" }, occurredAt: new Date().toISOString() });
    const ranking = ProviderRankResponseSchema.parse(await (await fetch(`${origin}/providers/rank?missionId=mission-approved&capability=solidity-scan&maxPriceTinybar=200`, { headers: { authorization: `Bearer ${orchestrator}` } })).json());
    expect(ranking.ranked.map(item => item.provider.id)).toEqual(["A", "b"]);
    const policy = MissionPolicyRequestSchema.parse({ missionId: approval.missionId, borrowerAccountId: "0.0.10", spendingCapTinybar: "200", sessionId: `session-${approval.missionId}`, sessionCapTinybar: "200",
      targetSha256: createHash("sha256").update(request.source).digest("hex"), provider: ranking.ranked[0]!.provider,
      approvedRecipientsRoot: buildMissionRecipientRoot("0.0.20", await loadPoseidon()) });
    for (const forged of [
      { ...policy, provider: ranking.ranked[1]!.provider },
      { ...policy, provider: ranking.ranked[1]!.provider, approvedRecipientsRoot: buildMissionRecipientRoot("0.0.21", await loadPoseidon()) }, { ...policy, approvedRecipientsRoot: "1" },
      { ...policy, spendingCapTinybar: "201" }, { ...policy, sessionCapTinybar: "201" },
      { ...policy, targetSha256: "0".repeat(64) }, { ...policy, borrowerAccountId: "0.0.99" },
      { ...policy, missionId: "unapproved" },
    ]) expect((await post("/missions/provision", forged)).status).toBe(409);
    expect(targets.every(target => target.register.mock.calls.length === 0)).toBe(true);
    targets[1]!.register.mockRejectedValueOnce(new Error("lost acknowledgement"));
    expect((await post("/missions/provision", policy)).status).toBe(503);
    expect(targets.every(target => target.register.mock.calls.length === 1)).toBe(true);
    await close();
    origin = await start();
    expect((await post("/missions/approve", approval, operator)).status).toBe(200);
    expect((await post("/missions/approve", { ...approval, request: { ...request, maxBudgetTinybar: "201" } }, operator)).status).toBe(409);
    expect((await post("/missions/provision", policy)).status).toBe(200);
    for (const target of targets) expect(target.register).toHaveBeenLastCalledWith(policy);
  } finally { await close(); database.close(); events.close(); }
});
