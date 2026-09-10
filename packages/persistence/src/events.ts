import type { AuditEvent, AuditEventType } from "@koven/audit";

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
}

export interface LocalEvent<T = unknown> extends AuditEvent {
  payload: T;
  publishedAt?: string;
}

/** Stores the complete local payload while keeping public audit fields queryable. */
export function createEvent<T>(database: KovenDatabase, event: LocalEvent<T>): void {
  try {
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
           transaction_id, occurred_at, published_at
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
    return event;
  });
}

export function markEventPublished(
  database: KovenDatabase,
  id: string,
  transactionId: string,
  publishedAt: string,
): boolean {
  const result = database.prepare(`
    UPDATE events
    SET transaction_id = ?, published_at = ?
    WHERE id = ? AND published_at IS NULL
  `).run(transactionId, publishedAt, id);
  return result.changes === 1;
}
