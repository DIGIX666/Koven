import type { Mission, MissionState } from "@koven/domain";
import { assertTransition } from "@koven/domain";

import type { KovenDatabase } from "./db.js";
import { PersistenceConflictError, tinybarFromText, tinybarToText } from "./db.js";

interface MissionRow {
  id: string;
  state: MissionState;
  spending_cap_tinybar: string;
  spent_tinybar: string;
  approved_recipients_root: string;
  target_ref: string;
  target_sha256: string;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionRow {
  id: string;
  spending_cap_tinybar: string;
  spent_tinybar: string;
}

export interface SpendingSession {
  id: string;
  spendingCapTinybar: bigint;
  spentTinybar: bigint;
}

export interface PersistedMission extends Mission {
  sessionId?: string;
}

export function createSpendingSession(database: KovenDatabase, session: SpendingSession): void {
  database.prepare(`
    INSERT INTO spending_sessions (id, spending_cap_tinybar, spent_tinybar)
    VALUES (@id, @spendingCapTinybar, @spentTinybar)
  `).run({
    id: session.id,
    spendingCapTinybar: tinybarToText(session.spendingCapTinybar),
    spentTinybar: tinybarToText(session.spentTinybar),
  });
}

export function getSpendingSession(
  database: KovenDatabase,
  id: string,
): SpendingSession | undefined {
  const row = database.prepare(`
    SELECT id, spending_cap_tinybar, spent_tinybar
    FROM spending_sessions
    WHERE id = ?
  `).get(id) as SessionRow | undefined;

  return row === undefined ? undefined : {
    id: row.id,
    spendingCapTinybar: tinybarFromText(row.spending_cap_tinybar),
    spentTinybar: tinybarFromText(row.spent_tinybar),
  };
}

export function createMission(
  database: KovenDatabase,
  mission: Mission,
  sessionId?: string,
): void {
  database.prepare(`
    INSERT INTO missions (
      id, state, spending_cap_tinybar, spent_tinybar,
      approved_recipients_root, target_ref, target_sha256,
      session_id, created_at, updated_at
    ) VALUES (
      @id, @state, @spendingCapTinybar, @spentTinybar,
      @approvedRecipientsRoot, @targetRef, @targetSha256,
      @sessionId, @createdAt, @updatedAt
    )
  `).run({
    id: mission.id,
    state: mission.state,
    spendingCapTinybar: tinybarToText(mission.spendingCapTinybar),
    spentTinybar: tinybarToText(mission.spentTinybar),
    approvedRecipientsRoot: mission.approvedRecipientsRoot,
    targetRef: mission.targetRef,
    targetSha256: mission.targetSha256,
    sessionId: sessionId ?? null,
    createdAt: mission.createdAt,
    updatedAt: mission.updatedAt,
  });
}

export function getMission(database: KovenDatabase, id: string): PersistedMission | undefined {
  const row = database.prepare(`
    SELECT id, state, spending_cap_tinybar, spent_tinybar,
           approved_recipients_root, target_ref, target_sha256,
           session_id, created_at, updated_at
    FROM missions
    WHERE id = ?
  `).get(id) as MissionRow | undefined;

  if (row === undefined) return undefined;

  const mission: PersistedMission = {
    id: row.id,
    state: row.state,
    spendingCapTinybar: tinybarFromText(row.spending_cap_tinybar),
    spentTinybar: tinybarFromText(row.spent_tinybar),
    approvedRecipientsRoot: row.approved_recipients_root,
    targetRef: row.target_ref,
    targetSha256: row.target_sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.session_id !== null) mission.sessionId = row.session_id;
  return mission;
}

/** Advances a mission only when its persisted state still matches the caller's expectation. */
export function transitionMission(
  database: KovenDatabase,
  id: string,
  from: MissionState,
  to: MissionState,
  updatedAt: string,
): void {
  assertTransition(from, to);
  const result = database.prepare(`
    UPDATE missions
    SET state = ?, updated_at = ?
    WHERE id = ? AND state = ?
  `).run(to, updatedAt, id, from);

  if (result.changes !== 1) {
    throw new PersistenceConflictError(
      "concurrent_update",
      `Mission ${id} is no longer in expected state ${from}`,
    );
  }
}
