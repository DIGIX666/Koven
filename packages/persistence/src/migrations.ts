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
  {
    version: 2,
    name: "mission-policy-and-completion",
    sql: `
      CREATE TABLE mission_policies (
        mission_id TEXT PRIMARY KEY REFERENCES missions(id),
        borrower_account_id TEXT NOT NULL,
        spending_cap_tinybar TEXT NOT NULL CHECK (
          spending_cap_tinybar = '0' OR (
            spending_cap_tinybar GLOB '[1-9]*' AND
            spending_cap_tinybar NOT GLOB '*[^0-9]*'
          )
        ),
        session_id TEXT NOT NULL,
        session_cap_tinybar TEXT NOT NULL CHECK (
          session_cap_tinybar = '0' OR (
            session_cap_tinybar GLOB '[1-9]*' AND
            session_cap_tinybar NOT GLOB '*[^0-9]*'
          )
        ),
        target_sha256 TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        provider_endpoint TEXT NOT NULL,
        provider_capability TEXT NOT NULL,
        provider_price_tinybar TEXT NOT NULL CHECK (
          provider_price_tinybar = '0' OR (
            provider_price_tinybar GLOB '[1-9]*' AND
            provider_price_tinybar NOT GLOB '*[^0-9]*'
          )
        ),
        provider_reputation_score REAL NOT NULL CHECK (
          provider_reputation_score >= 0 AND provider_reputation_score <= 1
        ),
        provider_expected_latency_ms INTEGER NOT NULL CHECK (provider_expected_latency_ms >= 0),
        approved_recipients_root TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE mission_completions (
        mission_id TEXT PRIMARY KEY REFERENCES missions(id),
        report_sha256 TEXT NOT NULL,
        settlement_tx_id TEXT NOT NULL UNIQUE,
        settlement_payer_account_id TEXT NOT NULL,
        settlement_recipient_account_id TEXT NOT NULL,
        settlement_asset TEXT NOT NULL,
        settlement_amount_tinybar TEXT NOT NULL CHECK (
          settlement_amount_tinybar = '0' OR (
            settlement_amount_tinybar GLOB '[1-9]*' AND
            settlement_amount_tinybar NOT GLOB '*[^0-9]*'
          )
        ),
        settlement_confirmed_at TEXT NOT NULL,
        callback_body_sha256 TEXT NOT NULL,
        accepted_at TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 3,
    name: "durable-hcs-audit-outbox",
    sql: `
      ALTER TABLE events ADD COLUMN hcs_transaction_id TEXT;
      ALTER TABLE events ADD COLUMN hcs_sequence_number TEXT CHECK (
        hcs_sequence_number IS NULL OR (
          hcs_sequence_number GLOB '[1-9]*' AND
          hcs_sequence_number NOT GLOB '*[^0-9]*'
        )
      );

      CREATE TABLE hcs_audit_outbox (
        event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
        mission_id TEXT NOT NULL,
        envelope_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'processing', 'published')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        next_attempt_at INTEGER NOT NULL,
        lease_token TEXT,
        lease_until INTEGER,
        transaction_id TEXT UNIQUE,
        transaction_base64 TEXT,
        valid_until INTEGER,
        submission_attempted INTEGER NOT NULL DEFAULT 0
          CHECK (submission_attempted IN (0, 1)),
        last_error TEXT,
        hcs_sequence_number TEXT CHECK (
          hcs_sequence_number IS NULL OR (
            hcs_sequence_number GLOB '[1-9]*' AND
            hcs_sequence_number NOT GLOB '*[^0-9]*'
          )
        ),
        published_at TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        CHECK (
          (transaction_id IS NULL AND transaction_base64 IS NULL AND valid_until IS NULL)
          OR
          (transaction_id IS NOT NULL AND transaction_base64 IS NOT NULL AND valid_until IS NOT NULL)
        )
      ) STRICT;

      CREATE INDEX hcs_audit_outbox_due_idx
        ON hcs_audit_outbox (status, next_attempt_at);
      CREATE INDEX hcs_audit_outbox_mission_idx
        ON hcs_audit_outbox (mission_id, status);

      INSERT INTO hcs_audit_outbox (
        event_id, mission_id, envelope_json, status, next_attempt_at,
        created_at, updated_at, published_at
      )
      SELECT
        id,
        mission_id,
        CASE WHEN transaction_id IS NULL THEN
          json_object(
            'v', 1, 'eventId', id, 'missionId', mission_id, 'type', type,
            'payloadHash', payload_hash, 'occurredAt', occurred_at
          )
        ELSE
          json_object(
            'v', 1, 'eventId', id, 'missionId', mission_id, 'type', type,
            'payloadHash', payload_hash, 'transactionId', transaction_id,
            'occurredAt', occurred_at
          )
        END,
        CASE WHEN published_at IS NULL THEN 'pending' ELSE 'published' END,
        unixepoch(occurred_at) * 1000,
        unixepoch(occurred_at) * 1000,
        unixepoch(occurred_at) * 1000,
        published_at
      FROM events;
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
