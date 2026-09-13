import type { AuditEvent, AuditSink, HcsEventEnvelope } from "./index.js";

export interface PreparedHcsMessage {
  readonly transactionId: string;
  readonly transactionBase64: string;
  readonly validUntil: number;
}

export type HcsSubmissionResult =
  | { readonly status: "confirmed"; readonly sequenceNumber: bigint }
  | { readonly status: "failed" | "uncertain" };

/** Network boundary used by the durable worker and replaced by a fake in offline tests. */
export interface HcsPublisher {
  prepare(message: string): Promise<PreparedHcsMessage>;
  submit(transactionBase64: string): Promise<HcsSubmissionResult>;
  reconcile(transactionId: string): Promise<HcsSubmissionResult>;
}

export interface AuditOutboxJob {
  readonly eventId: string;
  readonly missionId: string;
  readonly envelope: HcsEventEnvelope;
  readonly envelopeJson: string;
  readonly attempts: number;
  readonly token: string;
  readonly transactionId: string | null;
  readonly transactionBase64: string | null;
  readonly validUntil: number | null;
  readonly submissionAttempted: boolean;
}

/** Persistence boundary; implementations must compare the lease token on every mutation. */
export interface AuditOutboxStore {
  claimDue(now: number, leaseMs: number): AuditOutboxJob | undefined;
  savePrepared(job: AuditOutboxJob, prepared: PreparedHcsMessage, now: number): void;
  /** Records, before the network call, that the stored bytes may have reached a node. */
  markSubmissionAttempted(job: AuditOutboxJob, now: number): void;
  markPublished(job: AuditOutboxJob, transactionId: string, sequenceNumber: bigint, publishedAt: string): void;
  /** Releases the lease, counts one more failed attempt and schedules the next one. */
  retry(job: AuditOutboxJob, nextAttemptAt: number, detail: string, resetPrepared: boolean, now: number): void;
  pendingCount(): number;
  nextAttemptAt(): number | null;
}

export interface HcsAuditWriterOptions {
  readonly store: AuditOutboxStore;
  readonly publisher: HcsPublisher;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly leaseMs?: number;
  readonly uncertaintyGraceMs?: number;
}

const wait = (milliseconds: number): Promise<void> => new Promise(resolve => {
  setTimeout(resolve, milliseconds);
});

/**
 * Drains the durable outbox without making the caller's committed lifecycle
 * transition depend on HCS availability.
 */
export class HcsAuditWriter implements AuditSink {
  readonly durable = true;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly leaseMs: number;
  private readonly uncertaintyGraceMs: number;
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private drain: Promise<number> | null = null;

  constructor(private readonly options: HcsAuditWriterOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.uncertaintyGraceMs = options.uncertaintyGraceMs ?? 600_000;
    if (!Number.isInteger(this.leaseMs) || this.leaseMs < 1) throw new Error("Audit lease must be positive");
    if (!Number.isInteger(this.uncertaintyGraceMs) || this.uncertaintyGraceMs < 0) {
      throw new Error("Audit uncertainty grace must be non-negative");
    }
  }

  /** The event is already durable with its outbox row; this only wakes the worker. */
  async write(_event: AuditEvent): Promise<void> {
    this.wake();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  wake(): void {
    if (this.running) this.schedule(0);
  }

  async dispatchDue(limit = 25): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Audit batch limit must be 1-100");
    if (this.drain !== null) return this.drain;
    this.drain = this.drainDue(limit);
    try {
      return await this.drain;
    } finally {
      this.drain = null;
    }
  }

  /** Used by demo shutdown and `audit:flush`; throws while any entry remains. */
  async flush(timeoutMs = 30_000): Promise<void> {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error("Audit flush timeout must be positive");
    const deadline = this.now() + timeoutMs;
    while (this.options.store.pendingCount() > 0) {
      await this.dispatchDue(100);
      if (this.options.store.pendingCount() === 0) return;
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      const due = this.options.store.nextAttemptAt();
      await wait(Math.min(remaining, Math.max(1, (due ?? this.now() + 100) - this.now()), 100));
    }
    const pending = this.options.store.pendingCount();
    if (pending > 0) throw new Error(`HCS audit flush timed out with ${pending} pending event(s)`);
  }

  private async drainDue(limit: number): Promise<number> {
    let processed = 0;
    while (processed < limit) {
      const job = this.options.store.claimDue(this.now(), this.leaseMs);
      if (job === undefined) break;
      await this.publish(job);
      processed += 1;
    }
    return processed;
  }

  private async publish(job: AuditOutboxJob): Promise<void> {
    let prepared: PreparedHcsMessage;
    try {
      if (job.transactionId === null || job.transactionBase64 === null || job.validUntil === null) {
        prepared = await this.options.publisher.prepare(job.envelopeJson);
        this.options.store.savePrepared(job, prepared, this.now());
      } else {
        prepared = {
          transactionId: job.transactionId,
          transactionBase64: job.transactionBase64,
          validUntil: job.validUntil,
        };
      }

      if (job.submissionAttempted) {
        const reconciled = await this.options.publisher.reconcile(prepared.transactionId);
        if (reconciled.status === "confirmed") {
          this.complete(job, prepared.transactionId, reconciled.sequenceNumber);
          return;
        }
        if (reconciled.status === "uncertain" && this.now() < prepared.validUntil + this.uncertaintyGraceMs) {
          this.retry(job, "HCS submission outcome remains uncertain", false);
          return;
        }
        this.retry(job, "HCS transaction did not reach successful consensus", true);
        return;
      }

      this.options.store.markSubmissionAttempted(job, this.now());
      const submitted = await this.options.publisher.submit(prepared.transactionBase64);
      if (submitted.status === "confirmed") {
        this.complete(job, prepared.transactionId, submitted.sequenceNumber);
        return;
      }
      this.retry(
        job,
        submitted.status === "failed" ? "HCS transaction failed" : "HCS submission outcome is uncertain",
        submitted.status === "failed",
      );
    } catch (error) {
      this.retry(job, error instanceof Error ? error.message : "HCS audit publication failed", false);
    }
  }

  private complete(job: AuditOutboxJob, transactionId: string, sequenceNumber: bigint): void {
    this.options.store.markPublished(job, transactionId, sequenceNumber, new Date(this.now()).toISOString());
  }

  /** Full-jitter exponential backoff over every failed attempt (prepare, submit or reconcile), capped at one minute. */
  private retry(job: AuditOutboxJob, detail: string, resetPrepared: boolean): void {
    const cap = Math.min(60_000, 1_000 * (2 ** Math.min(job.attempts, 16)));
    const delay = Math.max(1, Math.floor(this.random() * cap));
    const now = this.now();
    this.options.store.retry(job, now + delay, detail, resetPrepared, now);
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.dispatchDue().catch(() => 0).finally(() => {
        if (!this.running) return;
        const next = this.options.store.nextAttemptAt();
        this.schedule(next === null ? 60_000 : Math.min(60_000, Math.max(0, next - this.now())));
      });
    }, delay);
    this.timer.unref();
  }
}
