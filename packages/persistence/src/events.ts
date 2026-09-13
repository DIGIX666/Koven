import { serializeHcsEnvelope, type AuditEvent, type AuditEventType } from "@koven/audit";

import type { KovenDatabase } from "./db.js";
import { isUniqueConstraint, PersistenceConflict, PersistenceConflictError } from "./db.js";

interface EventRow {
  id: string;
  mission_id: string;
  type: AuditEventType;
  payload_hash: string;
  payload_json: string;
  transaction_id: string | null;
  occurred_at: string;
  published_at: string | null;
  hcs_transaction_id: string | null;
  hcs_sequence_number: string | null;
}

export interface LocalEvent<T = unknown> extends AuditEvent {
  payload: T;
  publishedAt?: string;
  hcsTransactionId?: string;
  hcsSequenceNumber?: bigint;
}

/** Stores the complete local payload while keeping public audit fields queryable. */
export function createEvent<T>(database: KovenDatabase, event: LocalEvent<T>): void {
  const envelopeJson = serializeHcsEnvelope(event);
  const now = Date.parse(event.occurredAt);
  if (!Number.isFinite(now)) throw new Error("Event occurredAt must be an ISO timestamp");
  const insert = database.transaction(() => {
    database.prepare(`
      INSERT INTO events (
        id, mission_id, type, payload_hash, payload_json,
        transaction_id, occurred_at, published_at
      ) VALUES (
        @id, @missionId, @type, @payloadHash, @payloadJson,
        @transactionId, @occurredAt, @publishedAt
      )
    `).run({
      id: event.id,
      missionId: event.missionId,
      type: event.type,
      payloadHash: event.payloadHash,
      payloadJson: JSON.stringify(event.payload),
      transactionId: event.transactionId ?? null,
      occurredAt: event.occurredAt,
      publishedAt: event.publishedAt ?? null,
    });
    database.prepare(`
      INSERT INTO hcs_audit_outbox (
        event_id, mission_id, envelope_json, status, next_attempt_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.missionId,
      envelopeJson,
      event.publishedAt === undefined ? "pending" : "published",
      now,
      now,
      now,
    );
  });
  try {
    insert.immediate();
  } catch (error) {
    if (!isUniqueConstraint(error)) throw error;
    throw new PersistenceConflictError(
      PersistenceConflict.EVENT_ALREADY_EXISTS,
      `Event already exists: ${event.id}`,
    );
  }
}

export function listMissionEvents<T = unknown>(
  database: KovenDatabase,
  missionId: string,
): LocalEvent<T>[] {
  const rows = database.prepare(`
    SELECT id, mission_id, type, payload_hash, payload_json,
           transaction_id, occurred_at, published_at,
           hcs_transaction_id, hcs_sequence_number
    FROM events
    WHERE mission_id = ?
    ORDER BY seq
  `).all(missionId) as EventRow[];

  return rows.map(row => {
    const event: LocalEvent<T> = {
      id: row.id,
      missionId: row.mission_id,
      type: row.type,
      payloadHash: row.payload_hash,
      payload: JSON.parse(row.payload_json) as T,
      occurredAt: row.occurred_at,
    };
    if (row.transaction_id !== null) event.transactionId = row.transaction_id;
    if (row.published_at !== null) event.publishedAt = row.published_at;
    if (row.hcs_transaction_id !== null) event.hcsTransactionId = row.hcs_transaction_id;
    if (row.hcs_sequence_number !== null) event.hcsSequenceNumber = BigInt(row.hcs_sequence_number);
    return event;
  });
}

export function markEventPublished(
  database: KovenDatabase,
  id: string,
  transactionId: string,
  sequenceNumber: bigint,
  publishedAt: string,
): boolean {
  const result = database.prepare(`
    UPDATE events
    SET hcs_transaction_id = ?, hcs_sequence_number = ?, published_at = ?
    WHERE id = ? AND published_at IS NULL
  `).run(transactionId, sequenceNumber.toString(10), publishedAt, id);
  return result.changes === 1;
}
