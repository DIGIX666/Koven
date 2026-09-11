import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CallbackDispatcher, callbackSignature } from "../src/callback.js";
import { ProviderStore } from "../src/outbox.js";

const stores: ProviderStore[] = [];
const temporaryDirectories: string[] = [];
const secret = Buffer.alloc(32, 9);
const idempotencyKey = `mission-complete:mission-1:${"a".repeat(64)}`;
const body = '{"outcome":{"delivered":true},"report":{}}';
const transactionId = "0.0.3001@1789118400.000000001";

afterEach(async () => {
  stores.splice(0).forEach(store => store.close());
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function seedCallback(store: ProviderStore, now: number): void {
  store.database.prepare(`
    INSERT INTO provider_paid_scans (
      network, transaction_id, fingerprint, request_json, payment_payload_json,
      status, settlement_attempted, created_at, updated_at
    ) VALUES ('hedera:testnet', ?, ?, '{}', '{}', 'completed', 1, ?, ?)
  `).run(transactionId, "b".repeat(64), now, now);
  store.database.prepare(`
    INSERT INTO provider_callback_jobs (
      idempotency_key, network, transaction_id, body, body_sha256, status,
      attempts, next_attempt_at, created_at, updated_at
    ) VALUES (?, 'hedera:testnet', ?, ?, ?, 'pending', 0, ?, ?, ?)
  `).run(idempotencyKey, transactionId, body, "c".repeat(64), now, now, now);
}

describe("CallbackDispatcher", () => {
  it("keeps body and key stable while refreshing timestamp and HMAC across retries", async () => {
    const store = new ProviderStore(":memory:");
    stores.push(store);
    let now = 1_789_118_400_000;
    seedCallback(store, now);
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("timeout"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "accepted" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }));
    const dispatcher = new CallbackDispatcher({
      store,
      callbackUrl: "http://127.0.0.1:3001/callbacks/mission-complete",
      callbackSecret: secret,
      fetch: fetchMock,
      now: () => now,
      random: () => 0.5,
    });

    expect(await dispatcher.dispatchDue()).toBe(1);
    now += 2_000;
    expect(await dispatcher.dispatchDue()).toBe(1);

    const [firstUrl, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [secondUrl, secondInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const firstHeaders = firstInit.headers as Record<string, string>;
    const secondHeaders = secondInit.headers as Record<string, string>;
    expect(firstUrl).toBe(secondUrl);
    expect(firstInit.body).toBe(body);
    expect(secondInit.body).toBe(body);
    expect(firstHeaders["idempotency-key"]).toBe(idempotencyKey);
    expect(secondHeaders["idempotency-key"]).toBe(idempotencyKey);
    expect(firstHeaders["x-callback-timestamp"]).not.toBe(secondHeaders["x-callback-timestamp"]);
    expect(firstHeaders["x-callback-signature"]).toBe(callbackSignature(
      secret,
      firstHeaders["x-callback-timestamp"]!,
      idempotencyKey,
      body,
    ));
    expect(secondHeaders["x-callback-signature"]).not.toBe(firstHeaders["x-callback-signature"]);
    const row = store.database.prepare(`
      SELECT status, attempts FROM provider_callback_jobs WHERE idempotency_key = ?
    `).get(idempotencyKey) as { status: string; attempts: number };
    expect(row).toEqual({ status: "delivered", attempts: 2 });
  });

  it("resumes a persisted callback after reopening the provider database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "koven-callback-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "provider.db");
    const firstStore = new ProviderStore(databasePath);
    seedCallback(firstStore, 1_789_118_400_000);
    firstStore.close();

    const reopened = new ProviderStore(databasePath);
    stores.push(reopened);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      status: "duplicate",
      code: "callback_duplicate",
    }), { status: 202, headers: { "content-type": "application/json" } }));
    const dispatcher = new CallbackDispatcher({
      store: reopened,
      callbackUrl: "http://localhost:3001/callbacks/mission-complete",
      callbackSecret: secret,
      fetch: fetchMock,
      now: () => 1_789_118_401_000,
    });

    expect(await dispatcher.dispatchDue()).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((reopened.database.prepare(`
      SELECT status FROM provider_callback_jobs WHERE idempotency_key = ?
    `).get(idempotencyKey) as { status: string }).status).toBe("delivered");
  });

  it("retains non-retryable client failures for explicit operator replay", async () => {
    const store = new ProviderStore(":memory:");
    stores.push(store);
    const now = 1_789_118_400_000;
    seedCallback(store, now);
    const dispatcher = new CallbackDispatcher({
      store,
      callbackUrl: "https://orchestrator.example/callbacks/mission-complete",
      callbackSecret: secret,
      fetch: vi.fn(async () => new Response("bad request", { status: 400 })),
      now: () => now,
    });

    await dispatcher.dispatchDue();
    expect((store.database.prepare(`
      SELECT status FROM provider_callback_jobs WHERE idempotency_key = ?
    `).get(idempotencyKey) as { status: string }).status).toBe("repair");
    expect(store.replayCallback(idempotencyKey, now + 1)).toBe(true);
  });
});
