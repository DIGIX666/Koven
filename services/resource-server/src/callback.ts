import { createHmac } from "node:crypto";

import { CallbackResponseSchema, CompletionCallbackSchema } from "@koven/schemas";
import type { ScanReport } from "@koven/domain";

import { canonicalJson } from "./report.js";
import { type CallbackJob, ProviderStore } from "./outbox.js";

const MAX_RETRY_AFTER_MS = 86_400_000;

export interface CompletionCallbackJob {
  readonly idempotencyKey: string;
  readonly body: string;
}

export function buildCompletionCallback(
  report: ScanReport,
  settlementTxId: string,
  observedAt: string,
): CompletionCallbackJob {
  const callback = CompletionCallbackSchema.parse({
    outcome: {
      missionId: report.missionId,
      delivered: true,
      reportSha256: report.reportSha256,
      settlementTxId,
      observedAt,
    },
    report,
  });
  return {
    idempotencyKey: `mission-complete:${report.missionId}:${report.reportSha256}`,
    body: canonicalJson(callback),
  };
}

export function decodeCallbackSecret(encoded: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("Callback secret must be unpadded base64url");
  const secret = Buffer.from(encoded, "base64url");
  if (secret.length !== 32 || secret.toString("base64url") !== encoded) {
    throw new Error("Callback secret must encode exactly 32 bytes");
  }
  return secret;
}

export function callbackSignature(
  secret: Uint8Array,
  timestamp: string,
  idempotencyKey: string,
  body: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${idempotencyKey}.${body}`, "utf8")
    .digest("hex");
}

function retryAfterMs(response: Response, now: number): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  if (/^(0|[1-9]\d*)$/.test(value)) return Math.min(Number(value) * 1000, MAX_RETRY_AFTER_MS);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.min(Math.max(0, date - now), MAX_RETRY_AFTER_MS);
}

export interface CallbackDispatcherOptions {
  readonly store: ProviderStore;
  readonly callbackUrl: string;
  readonly callbackSecret: string | Uint8Array;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly timeoutMs?: number;
}

export class CallbackDispatcher {
  private readonly secret: Uint8Array;
  private readonly fetchImplementation: typeof fetch;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly timeoutMs: number;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private drain: Promise<number> | null = null;

  constructor(private readonly options: CallbackDispatcherOptions) {
    const callbackUrl = new URL(options.callbackUrl);
    const loopback = callbackUrl.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(callbackUrl.hostname);
    if (
      (callbackUrl.protocol !== "https:" && !loopback)
      || callbackUrl.username
      || callbackUrl.password
      || callbackUrl.search
      || callbackUrl.hash
    ) throw new Error("Callback URL must be HTTPS or loopback HTTP without credentials, query or fragment");

    this.secret = typeof options.callbackSecret === "string"
      ? decodeCallbackSecret(options.callbackSecret)
      : options.callbackSecret;
    if (this.secret.byteLength !== 32) throw new Error("Callback secret must contain exactly 32 bytes");
    this.fetchImplementation = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new Error("Callback timeout must be between 1 and 60000 ms");
    }
  }

  async dispatchDue(limit = 10): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Callback batch limit must be 1-100");
    if (this.drain) return this.drain;
    this.drain = this.drainDue(limit);
    try {
      return await this.drain;
    } finally {
      this.drain = null;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  wake(): void {
    if (!this.running) return;
    this.schedule(0);
  }

  private async drainDue(limit: number): Promise<number> {
    let processed = 0;
    while (processed < limit) {
      const job = this.options.store.claimDueCallback(this.now());
      if (!job) break;
      await this.dispatch(job);
      processed += 1;
    }
    return processed;
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.dispatchDue().catch(() => 0).finally(() => {
        if (!this.running) return;
        const next = this.options.store.nextCallbackAt();
        this.schedule(next === null ? 60_000 : Math.min(60_000, Math.max(0, next - this.now())));
      });
    }, delay);
    this.timer.unref();
  }

  private async dispatch(job: CallbackJob): Promise<void> {
    const timestamp = Math.floor(this.now() / 1000).toString();
    let response: Response;
    try {
      response = await this.fetchImplementation(this.options.callbackUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": job.idempotencyKey,
          "x-callback-timestamp": timestamp,
          "x-callback-signature": callbackSignature(this.secret, timestamp, job.idempotencyKey, job.body),
        },
        body: job.body,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      this.retry(job, "Callback request failed", this.now());
      return;
    }

    if (response.status === 202) {
      try {
        CallbackResponseSchema.parse(await response.json());
        this.options.store.markCallbackDelivered(job, this.now());
      } catch {
        this.retry(job, "Callback returned an invalid acknowledgement", this.now());
      }
      return;
    }

    if (response.status === 429 || response.status >= 500) {
      const finishedAt = this.now();
      this.retry(job, `Callback returned HTTP ${response.status}`, finishedAt, retryAfterMs(response, finishedAt));
      return;
    }

    if (response.status >= 400 && response.status < 500) {
      this.options.store.markCallbackForRepair(job, `Callback returned HTTP ${response.status}`, this.now());
      return;
    }

    this.retry(job, `Callback returned unexpected HTTP ${response.status}`, this.now());
  }

  private retry(job: CallbackJob, detail: string, now: number, retryAfter: number | null = null): void {
    const exponentialCap = Math.min(60_000, 1000 * (2 ** Math.min(job.attempts, 16)));
    const jitter = Math.floor(this.random() * exponentialCap);
    const delay = Math.max(1, jitter, retryAfter ?? 0);
    this.options.store.retryCallback(job, now + delay, detail, this.now());
  }
}
