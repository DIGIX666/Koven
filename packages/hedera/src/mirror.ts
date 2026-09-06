import { parseAccountId } from "./client.js";

export interface MirrorTopicMessage {
  topicId: string;
  sequenceNumber: bigint;
  consensusTimestamp: string;
  payerAccountId: string;
  message: string;
  runningHash: string;
  runningHashVersion: number;
}

export interface TopicMessagesOptions {
  /** Trusted configuration: HEDERA_MIRROR_NODE_URL. Required, never taken from a request. */
  mirrorNodeUrl: string;
  /** One ascending page (1–100). Resume with the last returned sequence number. */
  limit?: number;
  afterSequenceNumber?: bigint;
  timeoutMs?: number;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid mirror response");
  return value as Record<string, unknown>;
}

function base64(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error("Invalid mirror base64 field");
  }
  return value;
}

function positiveSafeInteger(value: unknown): number {
  // JSON.parse cannot preserve int64 numbers beyond MAX_SAFE_INTEGER. Fail closed.
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid or imprecise mirror integer");
  return value;
}

/** Fetch one bounded REST page; does not follow server-supplied pagination URLs. */
export async function getTopicMessages(topicId: string, opts: TopicMessagesOptions): Promise<MirrorTopicMessage[]> {
  parseAccountId(topicId);
  const base = new URL(opts.mirrorNodeUrl);
  if (base.username || base.password || base.search || base.hash || base.pathname !== "/"
      || (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)))) {
    throw new Error("Mirror URL must be an HTTPS origin or a loopback HTTP origin");
  }
  const limit = opts.limit ?? 25;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const after = opts.afterSequenceNumber ?? 0n;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Mirror limit must be 1–100");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("Mirror timeout must be 1–60000 ms");
  if (typeof after !== "bigint" || after < 0n || after > 9223372036854775807n) throw new Error("Invalid sequence cursor");
  const url = new URL(`/api/v1/topics/${topicId}/messages`, base);
  url.searchParams.set("encoding", "base64");
  url.searchParams.set("order", "asc");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sequencenumber", `gt:${after}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!response.ok) throw new Error(`Mirror request failed with HTTP ${response.status}`);
  const body = record(await response.json());
  if (!Array.isArray(body.messages) || body.messages.length > limit) throw new Error("Invalid mirror message list");
  let previous = after;
  return body.messages.map((entry: unknown) => {
    const row = record(entry);
    if (row.topic_id !== topicId || typeof row.payer_account_id !== "string"
        || typeof row.consensus_timestamp !== "string" || !/^\d+\.\d{9}$/.test(row.consensus_timestamp)) {
      throw new Error("Invalid mirror message binding");
    }
    // Koven emits only single-chunk events; never present a fragment as a complete event.
    if (row.chunk_info != null) {
      const chunk = record(row.chunk_info);
      if (chunk.total !== 1 || chunk.number !== 1) throw new Error("Invalid or unsupported mirror chunk");
    }
    parseAccountId(row.payer_account_id);
    const sequenceNumber = BigInt(positiveSafeInteger(row.sequence_number));
    if (sequenceNumber <= previous) throw new Error("Mirror messages are not strictly ascending after cursor");
    previous = sequenceNumber;
    return { topicId, sequenceNumber, consensusTimestamp: row.consensus_timestamp,
      payerAccountId: row.payer_account_id, message: base64(row.message),
      runningHash: base64(row.running_hash), runningHashVersion: positiveSafeInteger(row.running_hash_version) };
  });
}

export function explorerUrl(transactionId: string): string {
  const match = /^(\d+\.\d+\.\d+)@(0|[1-9]\d*)\.(\d{9})$/.exec(transactionId);
  if (!match) throw new Error("Expected a canonical unscheduled transaction ID");
  parseAccountId(match[1]!);
  return `https://hashscan.io/testnet/transaction/${transactionId}`;
}
