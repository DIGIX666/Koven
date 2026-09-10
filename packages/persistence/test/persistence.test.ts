import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ErrorCode, type Mission } from "@koven/domain";
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
  updateLoanState,
  type KovenDatabase,
} from "../src/index.js";

const timestamp = "2026-09-07T10:00:00.000Z";
const hash = "a".repeat(64);

interface ReservationProcessResult {
  outcome: "ok" | string;
}

const executeFile = promisify(execFile);

async function launchReservationProcess(
  databasePath: string,
  startAt: number,
  nonce: string,
  paymentCommitment: string,
): Promise<ReservationProcessResult> {
  const script = fileURLToPath(new URL("./reservation.worker.ts", import.meta.url));
  const { stdout } = await executeFile(process.execPath, [
    "--import", "tsx/esm", script, databasePath, String(startAt), nonce, paymentCommitment, timestamp,
  ]);
  return JSON.parse(stdout) as ReservationProcessResult;
}

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

  it("returns the stored idempotency result for a replay and rejects conflicting content", () => {
    const database = open();
    const result = {
      key: "callback-1",
      requestHash: hash,
      statusCode: 202,
      response: { status: "accepted" },
      createdAt: timestamp,
    };
    expect(createIdempotencyResult(database, result)).toEqual(result);
    expect(createIdempotencyResult(database, { ...result, response: { status: "ignored" } }))
      .toEqual(result);
    expect(() => createIdempotencyResult(database, { ...result, requestHash: "b".repeat(64) }))
      .toThrow(expect.objectContaining({
        name: "PersistenceConflictError",
        conflict: ErrorCode.IDEMPOTENCY_CONFLICT,
      }));
  });

  it("reports duplicate entities through typed persistence conflicts", () => {
    const database = open();
    createSpendingSession(database, { id: "session-1", spendingCapTinybar: 100n, spentTinybar: 0n });
    createMission(database, mission("mission-1"));
    const loan = {
      id: "loan-1",
      offerId: "offer-1",
      missionId: "mission-1",
      lenderAccountId: "0.0.20",
      principalTinybar: 90n,
      feeTinybar: 10n,
      state: "offered" as const,
    };
    createLoan(database, loan);
    const event = {
      id: "event-1",
      missionId: "mission-1",
      type: "mission-created" as const,
      payloadHash: hash,
      payload: {},
      occurredAt: timestamp,
    };
    createEvent(database, event);

    for (const duplicate of [
      () => createSpendingSession(database, { id: "session-1", spendingCapTinybar: 100n, spentTinybar: 0n }),
      () => createMission(database, mission("mission-1")),
      () => createLoan(database, loan),
      () => createEvent(database, event),
    ]) {
      expect(duplicate).toThrow(expect.objectContaining({ name: "PersistenceConflictError" }));
    }
  });

  it("rejects invalid persisted mission and loan states", () => {
    const database = open();
    createMission(database, mission("mission-1"));
    createLoan(database, {
      id: "loan-1",
      offerId: "offer-1",
      missionId: "mission-1",
      lenderAccountId: "0.0.20",
      principalTinybar: 90n,
      feeTinybar: 10n,
      state: "offered",
    });

    expect(() => database.prepare("UPDATE missions SET state = 'bogus' WHERE id = 'mission-1'").run())
      .toThrow(/CHECK constraint failed/);
    expect(() => database.prepare("UPDATE loans SET state = 'bogus' WHERE id = 'loan-1'").run())
      .toThrow(/CHECK constraint failed/);
  });

  it("compare-and-swaps loan state and rejects conflicting transaction ids", () => {
    const database = open();
    createMission(database, mission("mission-1"));
    createLoan(database, {
      id: "loan-1",
      offerId: "offer-1",
      missionId: "mission-1",
      lenderAccountId: "0.0.20",
      principalTinybar: 90n,
      feeTinybar: 10n,
      state: "offered",
    });

    expect(updateLoanState(database, "loan-1", "offered", "funded", { fundingTxId: "tx-1" }))
      .toBe(true);
    expect(updateLoanState(database, "loan-1", "offered", "accepted")).toBe(false);
    expect(() => updateLoanState(database, "loan-1", "funded", "repaid", { fundingTxId: "tx-2" }))
      .toThrow(expect.objectContaining({ conflict: ErrorCode.LOAN_REGISTRATION_CONFLICT }));
    expect(getLoan(database, "loan-1")).toMatchObject({ state: "funded", fundingTxId: "tx-1" });
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
    })).toThrow(expect.objectContaining({ conflict: ErrorCode.CUMULATIVE_BUDGET_EXCEEDED }));

    expect(getMission(database, "mission-1")?.spentTinybar).toBe(60n);
    expect(getSpendingReservation(database, "mission-1", "1")).toBeUndefined();
  });

  it("distinguishes invalid, single-payment, and cumulative cap failures", () => {
    const database = open();
    createMission(database, mission("mission-1", 100n, 60n));

    expect(() => reserveSpending(database, {
      missionId: "mission-1", nonce: "zero", paymentCommitment: "zero",
      amountTinybar: 0n, consumedAt: timestamp,
    })).toThrow(RangeError);
    expect(() => reserveSpending(database, {
      missionId: "mission-1", nonce: "single", paymentCommitment: "single",
      amountTinybar: 101n, consumedAt: timestamp,
    })).toThrow(expect.objectContaining({ conflict: ErrorCode.CAP_EXCEEDED }));
    expect(() => reserveSpending(database, {
      missionId: "mission-1", nonce: "cumulative", paymentCommitment: "cumulative",
      amountTinybar: 41n, consumedAt: timestamp,
    })).toThrow(expect.objectContaining({ conflict: ErrorCode.CUMULATIVE_BUDGET_EXCEEDED }));
    expect(database.prepare("SELECT COUNT(*) AS count FROM consumed_nonces").get())
      .toEqual({ count: 0 });
  });

  it("preserves insertion order when event timestamps collide", () => {
    const database = open();
    for (const id of ["e3", "e1", "e2"]) {
      createEvent(database, {
        id,
        missionId: "mission-1",
        type: "mission-created",
        payloadHash: hash,
        payload: { id },
        occurredAt: timestamp,
      });
    }

    expect(listMissionEvents(database, "mission-1").map(event => event.id))
      .toEqual(["e3", "e1", "e2"]);
  });

  it("prevents concurrent reservations in separate workers from jointly exceeding a cap", async () => {
    const databasePath = join(directory, "shared.sqlite");
    const database = openDatabase(databasePath);
    createMission(database, mission("mission-1"));
    database.close();

    const startAt = Date.now() + 750;
    const results = await Promise.all([
      launchReservationProcess(databasePath, startAt, "1", "commitment-1"),
      launchReservationProcess(databasePath, startAt, "2", "commitment-2"),
    ]);

    expect(results.map(result => result.outcome).sort()).toEqual([
      ErrorCode.CUMULATIVE_BUDGET_EXCEEDED,
      "ok",
    ]);
    const verification = open("shared.sqlite");
    expect(getMission(verification, "mission-1")?.spentTinybar).toBe(60n);
    const reservations = [
      getSpendingReservation(verification, "mission-1", "1"),
      getSpendingReservation(verification, "mission-1", "2"),
    ];
    expect(reservations.filter(Boolean)).toHaveLength(1);
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
    })).toThrow(expect.objectContaining({ conflict: ErrorCode.CUMULATIVE_BUDGET_EXCEEDED }));
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
