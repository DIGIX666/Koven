import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mission } from "@koven/domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createEvent,
  createIdempotencyResult,
  createLoan,
  createMission,
  createSpendingSession,
  getIdempotencyResult,
  getLoan,
  getMission,
  getSpendingReservation,
  getSpendingSession,
  listMissionEvents,
  MAX_TINYBAR,
  openDatabase,
  reserveSpending,
  type KovenDatabase,
} from "../src/index.js";

const timestamp = "2026-09-07T10:00:00.000Z";
const hash = "a".repeat(64);

function mission(
  id: string,
  spendingCapTinybar = 100n,
  spentTinybar = 0n,
): Mission {
  return {
    id,
    state: "created",
    spendingCapTinybar,
    spentTinybar,
    approvedRecipientsRoot: "1",
    targetRef: "Example.sol",
    targetSha256: hash,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("SQLite persistence", () => {
  let directory: string;
  const databases: KovenDatabase[] = [];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "koven-persistence-"));
  });

  afterEach(() => {
    for (const database of databases.splice(0)) {
      if (database.open) database.close();
    }
    rmSync(directory, { recursive: true, force: true });
  });

  function open(name = "koven.sqlite"): KovenDatabase {
    const database = openDatabase(join(directory, name));
    databases.push(database);
    return database;
  }

  it("applies migrations and preserves every record type after reopening", () => {
    const path = join(directory, "durable.sqlite");
    let database = openDatabase(path);
    createMission(database, mission("mission-1"));
    createLoan(database, {
      id: "loan-1",
      offerId: "offer-1",
      missionId: "mission-1",
      lenderAccountId: "0.0.20",
      principalTinybar: 90n,
      feeTinybar: 10n,
      state: "funded",
      fundingTxId: "0.0.10@1788696000.000000001",
    });
    createIdempotencyResult(database, {
      key: "mission-complete:mission-1:hash",
      requestHash: hash,
      statusCode: 202,
      response: { status: "accepted" },
      createdAt: timestamp,
    });
    createEvent(database, {
      id: "event-1",
      missionId: "mission-1",
      type: "mission-created",
      payloadHash: hash,
      payload: { source: "local-only" },
      occurredAt: timestamp,
    });
    reserveSpending(database, {
      missionId: "mission-1",
      nonce: "1",
      paymentCommitment: "commitment-1",
      amountTinybar: 25n,
      consumedAt: timestamp,
    });
    database.close();

    database = openDatabase(path);
    databases.push(database);
    expect(getMission(database, "mission-1")?.spentTinybar).toBe(25n);
    expect(getLoan(database, "loan-1")).toMatchObject({ principalTinybar: 90n, feeTinybar: 10n });
    expect(getIdempotencyResult(database, "mission-complete:mission-1:hash")?.response)
      .toEqual({ status: "accepted" });
    expect(listMissionEvents(database, "mission-1")).toHaveLength(1);
    expect(getSpendingReservation(database, "mission-1", "1")?.amountTinybar).toBe(25n);
    expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get())
      .toEqual({ count: 1 });
  });

  it("returns a controlled conflict for a duplicate idempotency key", () => {
    const database = open();
    const result = {
      key: "callback-1",
      requestHash: hash,
      statusCode: 202,
      response: { status: "accepted" },
      createdAt: timestamp,
    };
    createIdempotencyResult(database, result);

    expect(() => createIdempotencyResult(database, result)).toThrow(
      expect.objectContaining({
        name: "PersistenceConflictError",
        conflict: "duplicate_idempotency_key",
      }),
    );
  });

  it("rejects reuse of either a mission nonce or a payment commitment", () => {
    const database = open();
    createMission(database, mission("mission-1"));
    createMission(database, mission("mission-2"));
    reserveSpending(database, {
      missionId: "mission-1",
      nonce: "7",
      paymentCommitment: "commitment-1",
      amountTinybar: 10n,
      consumedAt: timestamp,
    });

    expect(() => reserveSpending(database, {
      missionId: "mission-1",
      nonce: "7",
      paymentCommitment: "commitment-2",
      amountTinybar: 10n,
      consumedAt: timestamp,
    })).toThrow(expect.objectContaining({ conflict: "nonce_already_used" }));

    expect(() => reserveSpending(database, {
      missionId: "mission-2",
      nonce: "8",
      paymentCommitment: "commitment-1",
      amountTinybar: 10n,
      consumedAt: timestamp,
    })).toThrow(expect.objectContaining({ conflict: "payment_commitment_already_used" }));
  });

  it("rolls back nonce consumption and spending when a mission cap is exceeded", () => {
    const database = open();
    createMission(database, mission("mission-1", 100n, 60n));

    expect(() => reserveSpending(database, {
      missionId: "mission-1",
      nonce: "1",
      paymentCommitment: "overflow",
      amountTinybar: 41n,
      consumedAt: timestamp,
    })).toThrow(expect.objectContaining({ conflict: "cap_exceeded" }));

    expect(getMission(database, "mission-1")?.spentTinybar).toBe(60n);
    expect(getSpendingReservation(database, "mission-1", "1")).toBeUndefined();
  });

  it("prevents reservations from separate connections jointly exceeding a cap", () => {
    const first = open("shared.sqlite");
    const second = open("shared.sqlite");
    createMission(first, mission("mission-1"));
    reserveSpending(first, {
      missionId: "mission-1",
      nonce: "1",
      paymentCommitment: "commitment-1",
      amountTinybar: 60n,
      consumedAt: timestamp,
    });

    expect(() => reserveSpending(second, {
      missionId: "mission-1",
      nonce: "2",
      paymentCommitment: "commitment-2",
      amountTinybar: 50n,
      consumedAt: timestamp,
    })).toThrow(expect.objectContaining({ conflict: "cap_exceeded" }));
    expect(getMission(second, "mission-1")?.spentTinybar).toBe(60n);
    expect(getSpendingReservation(second, "mission-1", "2")).toBeUndefined();
  });

  it("atomically enforces a session cap shared by multiple missions", () => {
    const database = open();
    createSpendingSession(database, { id: "session-1", spendingCapTinybar: 100n, spentTinybar: 0n });
    createMission(database, mission("mission-1"), "session-1");
    createMission(database, mission("mission-2"), "session-1");
    reserveSpending(database, {
      missionId: "mission-1",
      nonce: "1",
      paymentCommitment: "commitment-1",
      amountTinybar: 60n,
      consumedAt: timestamp,
    });

    expect(() => reserveSpending(database, {
      missionId: "mission-2",
      nonce: "1",
      paymentCommitment: "commitment-2",
      amountTinybar: 50n,
      consumedAt: timestamp,
    })).toThrow(expect.objectContaining({ conflict: "cap_exceeded" }));
    expect(getMission(database, "mission-2")?.spentTinybar).toBe(0n);
    expect(getSpendingSession(database, "session-1")?.spentTinybar).toBe(60n);
    expect(getSpendingReservation(database, "mission-2", "1")).toBeUndefined();
  });

  it("round-trips the largest valid tinybar amount without precision loss", () => {
    const database = open();
    createMission(database, mission("mission-max", MAX_TINYBAR));
    createLoan(database, {
      id: "loan-max",
      offerId: "offer-max",
      missionId: "mission-max",
      lenderAccountId: "0.0.20",
      principalTinybar: MAX_TINYBAR,
      feeTinybar: MAX_TINYBAR,
      state: "funded",
    });
    reserveSpending(database, {
      missionId: "mission-max",
      nonce: "1",
      paymentCommitment: "commitment-max",
      amountTinybar: MAX_TINYBAR,
      consumedAt: timestamp,
    });

    expect(getMission(database, "mission-max")).toMatchObject({
      spendingCapTinybar: MAX_TINYBAR,
      spentTinybar: MAX_TINYBAR,
    });
    expect(getLoan(database, "loan-max")).toMatchObject({
      principalTinybar: MAX_TINYBAR,
      feeTinybar: MAX_TINYBAR,
    });
    expect(database.prepare("SELECT spent_tinybar FROM missions WHERE id = ?").get("mission-max"))
      .toEqual({ spent_tinybar: MAX_TINYBAR.toString() });
  });

  it("keeps signer-owned state isolated in a separate database file", () => {
    const signer = open("signer.sqlite");
    const orchestrator = open("orchestrator.sqlite");
    createMission(signer, mission("signer-mission"));
    reserveSpending(signer, {
      missionId: "signer-mission",
      nonce: "secret-nonce",
      paymentCommitment: "secret-commitment",
      amountTinybar: 10n,
      consumedAt: timestamp,
    });

    expect(getMission(orchestrator, "signer-mission")).toBeUndefined();
    expect(getSpendingReservation(orchestrator, "signer-mission", "secret-nonce"))
      .toBeUndefined();
  });

  it("keeps successful reservations consumed when their external outcome is uncertain", () => {
    const path = join(directory, "uncertain.sqlite");
    let database = openDatabase(path);
    createMission(database, mission("mission-1"));
    reserveSpending(database, {
      missionId: "mission-1",
      nonce: "1",
      paymentCommitment: "uncertain-commitment",
      amountTinybar: 20n,
      consumedAt: timestamp,
    });
    database.close();

    database = openDatabase(path);
    databases.push(database);
    expect(getMission(database, "mission-1")?.spentTinybar).toBe(20n);
    expect(getSpendingReservation(database, "mission-1", "1")).toBeDefined();
  });
});
