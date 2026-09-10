import type Database from "better-sqlite3";
import { LOAN_STATES, MISSION_STATES } from "@koven/domain";

const sqlValues = (values: readonly string[]) => values.map(value => `'${value}'`).join(", ");
const missionStates = sqlValues(MISSION_STATES);
const loanStates = sqlValues(LOAN_STATES);

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial-persistence",
    sql: `
      CREATE TABLE spending_sessions (
        id TEXT PRIMARY KEY,
        spending_cap_tinybar TEXT NOT NULL CHECK (
          spending_cap_tinybar = '0' OR (
            spending_cap_tinybar GLOB '[1-9]*' AND
            spending_cap_tinybar NOT GLOB '*[^0-9]*'
          )
        ),
        spent_tinybar TEXT NOT NULL DEFAULT '0' CHECK (
          spent_tinybar = '0' OR (
            spent_tinybar GLOB '[1-9]*' AND
            spent_tinybar NOT GLOB '*[^0-9]*'
          )
        )
      );

      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN (${missionStates})),
        spending_cap_tinybar TEXT NOT NULL CHECK (
          spending_cap_tinybar = '0' OR (
            spending_cap_tinybar GLOB '[1-9]*' AND
            spending_cap_tinybar NOT GLOB '*[^0-9]*'
          )
        ),
        spent_tinybar TEXT NOT NULL CHECK (
          spent_tinybar = '0' OR (
            spent_tinybar GLOB '[1-9]*' AND
            spent_tinybar NOT GLOB '*[^0-9]*'
          )
        ),
        approved_recipients_root TEXT NOT NULL,
        target_ref TEXT NOT NULL,
        target_sha256 TEXT NOT NULL,
        session_id TEXT REFERENCES spending_sessions(id),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE loans (
        id TEXT PRIMARY KEY,
        offer_id TEXT NOT NULL,
        mission_id TEXT NOT NULL,
        lender_account_id TEXT NOT NULL,
        principal_tinybar TEXT NOT NULL CHECK (
          principal_tinybar = '0' OR (
            principal_tinybar GLOB '[1-9]*' AND
            principal_tinybar NOT GLOB '*[^0-9]*'
          )
        ),
        fee_tinybar TEXT NOT NULL CHECK (
          fee_tinybar = '0' OR (
            fee_tinybar GLOB '[1-9]*' AND
            fee_tinybar NOT GLOB '*[^0-9]*'
          )
        ),
        state TEXT NOT NULL CHECK (state IN (${loanStates})),
        funding_tx_id TEXT,
        repayment_tx_id TEXT,
        FOREIGN KEY (mission_id) REFERENCES missions(id)
      );

      CREATE TABLE idempotency_results (
        key TEXT PRIMARY KEY,
        request_hash TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        response_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE consumed_nonces (
        mission_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        payment_commitment TEXT NOT NULL UNIQUE,
        amount_tinybar TEXT NOT NULL CHECK (
          amount_tinybar = '0' OR (
            amount_tinybar GLOB '[1-9]*' AND
            amount_tinybar NOT GLOB '*[^0-9]*'
          )
        ),
        consumed_at TEXT NOT NULL,
        PRIMARY KEY (mission_id, nonce),
        FOREIGN KEY (mission_id) REFERENCES missions(id)
      );

      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        mission_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        transaction_id TEXT,
        occurred_at TEXT NOT NULL,
        published_at TEXT
      );

      CREATE INDEX events_mission_sequence_idx
        ON events (mission_id, seq);
    `,
  },
] as const;

interface AppliedMigrationRow {
  version: number;
  name: string;
}

/** Applies each pending schema migration exactly once and rejects unknown versions. */
export function applyMigrations(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  const applied = new Map(
    (database.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as AppliedMigrationRow[])
      .map(row => [row.version, row.name]),
  );
  const latestVersion = MIGRATIONS.at(-1)?.version ?? 0;
  const unknownVersion = [...applied.keys()].find(version => version > latestVersion);
  if (unknownVersion !== undefined) {
    throw new Error(`Database schema version ${unknownVersion} is newer than supported version ${latestVersion}`);
  }

  const migrate = database.transaction((migration: Migration) => {
    database.exec(migration.sql);
    database.prepare(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(migration.version, migration.name, new Date().toISOString());
  });

  for (const migration of MIGRATIONS) {
    const appliedName = applied.get(migration.version);
    if (appliedName === migration.name) continue;
    if (appliedName !== undefined) {
      throw new Error(`Migration ${migration.version} was applied as ${appliedName}, expected ${migration.name}`);
    }
    migrate.immediate(migration);
  }
}
