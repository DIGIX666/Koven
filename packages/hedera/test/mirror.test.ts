import { afterEach, expect, it, vi } from "vitest";
import { getTopicMessages } from "../src/index.js";
const opts = { mirrorNodeUrl: "https://testnet.mirrornode.hedera.com" };
const row = { topic_id: "0.0.50", payer_account_id: "0.0.10", sequence_number: 2,
  consensus_timestamp: "1788696000.000000001", message: "e30=", running_hash: "YWJj", running_hash_version: 3, chunk_info: null };
afterEach(() => vi.unstubAllGlobals());
const respond = (messages: unknown[]) => vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ messages, links: { next: "https://untrusted.example/" } }))));
it("requests a bounded ascending base64 page and returns the cursor without following links", async () => {
  respond([row]);
  expect(await getTopicMessages("0.0.50", { ...opts, afterSequenceNumber: 1n, limit: 10 })).toEqual([{
    topicId: "0.0.50", payerAccountId: "0.0.10", sequenceNumber: 2n,
    consensusTimestamp: row.consensus_timestamp, message: "e30=", runningHash: "YWJj", runningHashVersion: 3,
  }]);
  expect(fetch).toHaveBeenCalledOnce();
  const [url, init] = vi.mocked(fetch).mock.calls[0]!;
  expect(String(url)).toBe("https://testnet.mirrornode.hedera.com/api/v1/topics/0.0.50/messages?encoding=base64&order=asc&limit=10&sequencenumber=gt%3A1");
  expect(init?.redirect).toBe("error");
});
it("fails closed on foreign topics, imprecise integers, unordered messages and chunks", async () => {
  for (const change of [{ topic_id: "0.0.999" }, { sequence_number: 9007199254740992 },
    { message: "not base64" }, { chunk_info: { total: 2, number: 1 } }, { chunk_info: { total: 1, number: 2 } }]) {
    respond([{ ...row, ...change }]);
    await expect(getTopicMessages("0.0.50", opts)).rejects.toThrow();
  }
  respond([row, row]);
  await expect(getTopicMessages("0.0.50", opts)).rejects.toThrow("ascending");
});
it("rejects HTTP failures and unsafe configuration without exposing response bodies", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("upstream details", { status: 503 })));
  await expect(getTopicMessages("0.0.50", opts)).rejects.toThrow(/^Mirror request failed with HTTP 503$/);
  vi.mocked(fetch).mockClear();
  for (const mirrorNodeUrl of ["http://remote.example", "https://user:password@example.com", "https://example.com/path"])
    await expect(getTopicMessages("0.0.50", { mirrorNodeUrl })).rejects.toThrow();
  await expect(getTopicMessages("0.0.50", { ...opts, limit: 101 })).rejects.toThrow();
  expect(fetch).not.toHaveBeenCalled();
});

it("accepts a complete single-chunk event", async () => {
  respond([{ ...row, chunk_info: { total: 1, number: 1 } }]);
  expect(await getTopicMessages("0.0.50", opts)).toHaveLength(1);
});
