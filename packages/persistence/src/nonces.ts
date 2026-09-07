import type { KovenDatabase } from "./db.js";
import {
  PersistenceConflictError,
  PersistenceNotFoundError,
  tinybarFromText,
  tinybarToText,
} from "./db.js";

interface MissionBudgetRow {
  spent_tinybar: string;
  spending_cap_tinybar: string;
  session_id: string | null;
}

interface SessionBudgetRow {
  spent_tinybar: string;
  spending_cap_tinybar: string;
}

interface NonceRow {
  mission_id: string;
  nonce: string;
  payment_commitment: string;
  amount_tinybar: string;
  consumed_at: string;
}

export interface SpendingReservation {
  missionId: string;
  nonce: string;
  paymentCommitment: string;
  amountTinybar: bigint;
  consumedAt: string;
}

/** Atomically consumes replay identifiers and reserves mission and session budgets. */
export function reserveSpending(
  database: KovenDatabase,
  reservation: SpendingReservation,
): void {
  const reserve = database.transaction(() => {
    insertConsumedNonce(database, reservation);

    const mission = database.prepare(`
      SELECT spent_tinybar, spending_cap_tinybar, session_id
      FROM missions
      WHERE id = ?
    `).get(reservation.missionId) as MissionBudgetRow | undefined;
    if (mission === undefined) {
      throw new PersistenceNotFoundError("mission", reservation.missionId);
    }

    reserveBudget(
      database,
      "missions",
      reservation.missionId,
      mission.spent_tinybar,
      mission.spending_cap_tinybar,
      reservation.amountTinybar,
    );

    if (mission.session_id !== null) {
      const session = database.prepare(`
        SELECT spent_tinybar, spending_cap_tinybar
        FROM spending_sessions
        WHERE id = ?
      `).get(mission.session_id) as SessionBudgetRow | undefined;
      if (session === undefined) {
        throw new PersistenceNotFoundError("session", mission.session_id);
      }
      reserveBudget(
        database,
        "spending_sessions",
        mission.session_id,
        session.spent_tinybar,
        session.spending_cap_tinybar,
        reservation.amountTinybar,
      );
    }
  });

  reserve.immediate();
}

export function getSpendingReservation(
  database: KovenDatabase,
  missionId: string,
  nonce: string,
): SpendingReservation | undefined {
  const row = database.prepare(`
    SELECT mission_id, nonce, payment_commitment, amount_tinybar, consumed_at
    FROM consumed_nonces
    WHERE mission_id = ? AND nonce = ?
  `).get(missionId, nonce) as NonceRow | undefined;

  return row === undefined ? undefined : {
    missionId: row.mission_id,
    nonce: row.nonce,
    paymentCommitment: row.payment_commitment,
    amountTinybar: tinybarFromText(row.amount_tinybar),
    consumedAt: row.consumed_at,
  };
}

function insertConsumedNonce(
  database: KovenDatabase,
  reservation: SpendingReservation,
): void {
  try {
    database.prepare(`
      INSERT INTO consumed_nonces (
        mission_id, nonce, payment_commitment, amount_tinybar, consumed_at
      ) VALUES (
        @missionId, @nonce, @paymentCommitment, @amountTinybar, @consumedAt
      )
    `).run({
      missionId: reservation.missionId,
      nonce: reservation.nonce,
      paymentCommitment: reservation.paymentCommitment,
      amountTinybar: tinybarToText(reservation.amountTinybar),
      consumedAt: reservation.consumedAt,
    });
  } catch (error) {
    if (!isUniqueConstraint(error)) throw error;

    const nonceExists = database.prepare(`
      SELECT 1 FROM consumed_nonces WHERE mission_id = ? AND nonce = ?
    `).get(reservation.missionId, reservation.nonce);
    if (nonceExists !== undefined) {
      throw new PersistenceConflictError(
        "nonce_already_used",
        `Nonce already used for mission ${reservation.missionId}`,
      );
    }
    throw new PersistenceConflictError(
      "payment_commitment_already_used",
      "Payment commitment has already been used",
    );
  }
}

function reserveBudget(
  database: KovenDatabase,
  table: "missions" | "spending_sessions",
  id: string,
  currentText: string,
  capText: string,
  amount: bigint,
): void {
  const current = tinybarFromText(currentText);
  const cap = tinybarFromText(capText);
  const next = current + amount;
  if (amount <= 0n || next > cap) {
    throw new PersistenceConflictError("cap_exceeded", `Spending cap exceeded for ${table}:${id}`);
  }

  const result = database.prepare(`
    UPDATE ${table}
    SET spent_tinybar = ?
    WHERE id = ? AND spent_tinybar = ?
  `).run(tinybarToText(next), id, currentText);
  if (result.changes !== 1) {
    throw new PersistenceConflictError(
      "concurrent_update",
      `Spending changed concurrently for ${table}:${id}`,
    );
  }
}

function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Error && "code" in error && (
    error.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || error.code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}
