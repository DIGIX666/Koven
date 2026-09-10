import Database from "better-sqlite3";
import { ErrorCode } from "@koven/domain";

import { applyMigrations } from "./migrations.js";

export const MAX_TINYBAR = 18_446_744_073_709_551_615n;

export type KovenDatabase = Database.Database;

export const PersistenceConflict = {
  CAP_EXCEEDED: ErrorCode.CAP_EXCEEDED,
  CUMULATIVE_BUDGET_EXCEEDED: ErrorCode.CUMULATIVE_BUDGET_EXCEEDED,
  IDEMPOTENCY_CONFLICT: ErrorCode.IDEMPOTENCY_CONFLICT,
  NONCE_ALREADY_USED: ErrorCode.NONCE_ALREADY_USED,
  LOAN_REGISTRATION_CONFLICT: ErrorCode.LOAN_REGISTRATION_CONFLICT,
  CONCURRENT_UPDATE: "concurrent_update",
  PAYMENT_COMMITMENT_ALREADY_USED: "payment_commitment_already_used",
  ENTITY_ALREADY_EXISTS: "entity_already_exists",
  EVENT_ALREADY_EXISTS: "event_already_exists",
  REPAYMENT_TRANSACTION_CONFLICT: "repayment_transaction_conflict",
} as const;

export type PersistenceConflict = (typeof PersistenceConflict)[keyof typeof PersistenceConflict];

export function isUniqueConstraint(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  return error.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || error.code === "SQLITE_CONSTRAINT_UNIQUE";
}

export class PersistenceConflictError extends Error {
  constructor(
    readonly conflict: PersistenceConflict,
    message: string,
  ) {
    super(message);
    this.name = "PersistenceConflictError";
  }
}

export class PersistenceNotFoundError extends Error {
  constructor(readonly entity: "mission" | "session", readonly id: string) {
    super(`${entity} not found: ${id}`);
    this.name = "PersistenceNotFoundError";
  }
}

/** Converts an in-memory uint64 tinybar amount to its canonical database representation. */
export function tinybarToText(value: bigint): string {
  if (value < 0n || value > MAX_TINYBAR) {
    throw new RangeError(`Tinybar amount must be between 0 and ${MAX_TINYBAR}`);
  }
  return value.toString(10);
}

/** Restores a canonical tinybar string as bigint without passing through Number. */
export function tinybarFromText(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new TypeError("Stored tinybar amount is not canonical decimal text");
  }
  const parsed = BigInt(value);
  if (parsed > MAX_TINYBAR) {
    throw new RangeError(`Stored tinybar amount exceeds ${MAX_TINYBAR}`);
  }
  return parsed;
}

export interface OpenDatabaseOptions {
  readonly?: boolean;
  fileMustExist?: boolean;
}

/** Opens one caller-owned SQLite connection and prepares its local schema. */
export function openDatabase(filename: string, options: OpenDatabaseOptions = {}): KovenDatabase {
  const database = new Database(filename, options);
  database.pragma("foreign_keys = ON");
  database.pragma("busy_timeout = 5000");

  if (!options.readonly) {
    database.pragma("journal_mode = WAL");
    applyMigrations(database);
  }

  return database;
}
