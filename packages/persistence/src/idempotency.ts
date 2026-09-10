import type { KovenDatabase } from "./db.js";
import { isUniqueConstraint, PersistenceConflict, PersistenceConflictError } from "./db.js";

interface IdempotencyRow {
  key: string;
  request_hash: string;
  status_code: number;
  response_json: string;
  created_at: string;
}

export interface IdempotencyResult<T = unknown> {
  key: string;
  requestHash: string;
  statusCode: number;
  response: T;
  createdAt: string;
}

/** Persists the first result for a key and reports later inserts as controlled conflicts. */
export function createIdempotencyResult<T>(
  database: KovenDatabase,
  result: IdempotencyResult<T>,
): IdempotencyResult<T> {
  try {
    database.prepare(`
      INSERT INTO idempotency_results (key, request_hash, status_code, response_json, created_at)
      VALUES (@key, @requestHash, @statusCode, @responseJson, @createdAt)
    `).run({
      key: result.key,
      requestHash: result.requestHash,
      statusCode: result.statusCode,
      responseJson: JSON.stringify(result.response),
      createdAt: result.createdAt,
    });
    return result;
  } catch (error) {
    if (isUniqueConstraint(error)) {
      const existing = getIdempotencyResult<T>(database, result.key);
      if (existing !== undefined && existing.requestHash === result.requestHash) return existing;
      throw new PersistenceConflictError(
        PersistenceConflict.IDEMPOTENCY_CONFLICT,
        `Idempotency key was reused with different content: ${result.key}`,
      );
    }
    throw error;
  }
}

export function getIdempotencyResult<T = unknown>(
  database: KovenDatabase,
  key: string,
): IdempotencyResult<T> | undefined {
  const row = database.prepare(`
    SELECT key, request_hash, status_code, response_json, created_at
    FROM idempotency_results
    WHERE key = ?
  `).get(key) as IdempotencyRow | undefined;

  return row === undefined ? undefined : {
    key: row.key,
    requestHash: row.request_hash,
    statusCode: row.status_code,
    response: JSON.parse(row.response_json) as T,
    createdAt: row.created_at,
  };
}
