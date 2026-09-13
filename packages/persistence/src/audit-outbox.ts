import { randomUUID } from "node:crypto";

import type {
  AuditOutboxJob,
  AuditOutboxStore,
  HcsEventEnvelope,
  PreparedHcsMessage,
} from "@koven/audit";

import type { KovenDatabase } from "./db.js";

interface OutboxRow {
  event_id: string;
  mission_id: string;
  envelope_json: string;
  attempts: number;
  lease_token: string;
  transaction_id: string | null;
  transaction_base64: string | null;
  valid_until: number | null;
  submission_attempted: number;
}

const parseJob = (row: OutboxRow): AuditOutboxJob => ({
  eventId: row.event_id,
  missionId: row.mission_id,
  envelope: JSON.parse(row.envelope_json) as HcsEventEnvelope,
  envelopeJson: row.envelope_json,
  attempts: row.attempts,
  token: row.lease_token,
  transactionId: row.transaction_id,
  transactionBase64: row.transaction_base64,
  validUntil: row.valid_until,
  submissionAttempted: row.submission_attempted === 1,
});

/** SQLite implementation that serializes each mission's public event order. */
export class SqliteAuditOutbox implements AuditOutboxStore {
  constructor(private readonly database: KovenDatabase) {}

  claimDue(now: number, leaseMs: number): AuditOutboxJob | undefined {
    const token = randomUUID();
    const claim = this.database.transaction(() => {
      const candidate = this.database.prepare(`
        SELECT outbox.event_id
        FROM hcs_audit_outbox AS outbox
        JOIN events AS event ON event.id = outbox.event_id
        WHERE outbox.status != 'published'
          AND outbox.next_attempt_at <= ?
          AND (outbox.status = 'pending' OR COALESCE(outbox.lease_until, 0) <= ?)
          AND NOT EXISTS (
            SELECT 1
            FROM hcs_audit_outbox AS earlier_outbox
            JOIN events AS earlier_event ON earlier_event.id = earlier_outbox.event_id
            WHERE earlier_outbox.mission_id = outbox.mission_id
              AND earlier_event.seq < event.seq
              AND earlier_outbox.status != 'published'
          )
        ORDER BY event.seq
        LIMIT 1
      `).get(now, now) as { event_id: string } | undefined;
      if (candidate === undefined) return undefined;
      const updated = this.database.prepare(`
        UPDATE hcs_audit_outbox
        SET status = 'processing', lease_token = ?, lease_until = ?, updated_at = ?
        WHERE event_id = ? AND status != 'published'
          AND (status = 'pending' OR COALESCE(lease_until, 0) <= ?)
      `).run(token, now + leaseMs, now, candidate.event_id, now);
      if (updated.changes !== 1) return undefined;
      return this.database.prepare(`
        SELECT event_id, mission_id, envelope_json, attempts, lease_token,
               transaction_id, transaction_base64, valid_until, submission_attempted
        FROM hcs_audit_outbox WHERE event_id = ?
      `).get(candidate.event_id) as OutboxRow;
    });
    const row = claim.immediate();
    return row === undefined ? undefined : parseJob(row);
  }

  savePrepared(job: AuditOutboxJob, prepared: PreparedHcsMessage, now: number): void {
    this.mutate(job, `
      UPDATE hcs_audit_outbox
      SET transaction_id = ?, transaction_base64 = ?, valid_until = ?, updated_at = ?
      WHERE event_id = ? AND status = 'processing' AND lease_token = ?
    `, prepared.transactionId, prepared.transactionBase64, prepared.validUntil, now, job.eventId, job.token);
  }

  markSubmissionAttempted(job: AuditOutboxJob, now: number): void {
    this.mutate(job, `
      UPDATE hcs_audit_outbox
      SET submission_attempted = 1, updated_at = ?
      WHERE event_id = ? AND status = 'processing' AND lease_token = ?
    `, now, job.eventId, job.token);
  }

  markPublished(
    job: AuditOutboxJob,
    transactionId: string,
    sequenceNumber: bigint,
    publishedAt: string,
  ): void {
    const complete = this.database.transaction(() => {
      const result = this.database.prepare(`
        UPDATE hcs_audit_outbox
        SET status = 'published', transaction_id = ?, hcs_sequence_number = ?,
            published_at = ?, lease_token = NULL, lease_until = NULL,
            last_error = NULL, updated_at = ?
        WHERE event_id = ? AND status = 'processing' AND lease_token = ?
      `).run(
        transactionId,
        sequenceNumber.toString(10),
        publishedAt,
        Date.parse(publishedAt),
        job.eventId,
        job.token,
      );
      if (result.changes !== 1) throw new Error(`Audit outbox lease was lost for ${job.eventId}`);
      const event = this.database.prepare(`
        UPDATE events
        SET hcs_transaction_id = ?, hcs_sequence_number = ?, published_at = ?
        WHERE id = ? AND published_at IS NULL
      `).run(transactionId, sequenceNumber.toString(10), publishedAt, job.eventId);
      if (event.changes !== 1) throw new Error(`Audit event was not publishable: ${job.eventId}`);
    });
    complete.immediate();
  }

  retry(
    job: AuditOutboxJob,
    nextAttemptAt: number,
    detail: string,
    resetPrepared: boolean,
    now: number,
  ): void {
    const prepared = resetPrepared
      ? "transaction_id = NULL, transaction_base64 = NULL, valid_until = NULL, submission_attempted = 0,"
      : "";
    this.mutate(job, `
      UPDATE hcs_audit_outbox
      SET status = 'pending', ${prepared}
          attempts = attempts + 1, next_attempt_at = ?, lease_token = NULL, lease_until = NULL,
          last_error = ?, updated_at = ?
      WHERE event_id = ? AND status = 'processing' AND lease_token = ?
    `, nextAttemptAt, detail.slice(0, 1_000), now, job.eventId, job.token);
  }

  pendingCount(): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count FROM hcs_audit_outbox WHERE status != 'published'
    `).get() as { count: number };
    return row.count;
  }

  nextAttemptAt(): number | null {
    const row = this.database.prepare(`
      SELECT MIN(
        CASE WHEN status = 'processing'
          THEN MAX(next_attempt_at, COALESCE(lease_until, next_attempt_at))
          ELSE next_attempt_at
        END
      ) AS next
      FROM hcs_audit_outbox
      WHERE status != 'published'
    `).get() as { next: number | null };
    return row.next;
  }

  private mutate(job: AuditOutboxJob, sql: string, ...parameters: unknown[]): void {
    const result = this.database.prepare(sql).run(...parameters);
    if (result.changes !== 1) throw new Error(`Audit outbox lease was lost for ${job.eventId}`);
  }
}
