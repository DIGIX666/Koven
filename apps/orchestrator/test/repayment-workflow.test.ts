import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createLoan,
  createMission,
  getLoan,
  getMission,
  openDatabase,
} from "@koven/persistence";
import { NoopAuditSink } from "@koven/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MissionStateMachine, RepaymentWorkflow } from "../src/index.js";

const timestamp = "2026-09-13T10:00:00.000Z";
const repaymentTxId = "0.0.1001@1789293600.000000001";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("RepaymentWorkflow restart recovery", () => {
  it("resumes a durable pending mission with the same signer command after reopening SQLite", async () => {
    const directory = mkdtempSync(join(tmpdir(), "koven-repayment-"));
    directories.push(directory);
    const path = join(directory, "orchestrator.sqlite");
    let database = openDatabase(path);
    createMission(database, {
      id: "mission-1",
      state: "repayment-pending",
      spendingCapTinybar: 100n,
      spentTinybar: 100n,
      approvedRecipientsRoot: "1",
      targetRef: "Example.sol",
      targetSha256: "a".repeat(64),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    createLoan(database, {
      id: "loan-1",
      offerId: "offer-1",
      missionId: "mission-1",
      lenderAccountId: "0.0.2001",
      principalTinybar: 99n,
      feeTinybar: 5n,
      state: "funded",
      fundingTxId: "0.0.2001@1789293590.000000001",
    });
    database.close();

    database = openDatabase(path);
    const client = {
      repay: vi.fn(async () => ({ transactionId: repaymentTxId })),
    };
    const stateMachine = new MissionStateMachine(database, new NoopAuditSink(), {
      now: () => timestamp,
      eventId: (_missionId, from, to) => `event-${from}-${to}`,
    });
    const workflow = new RepaymentWorkflow({ database, stateMachine, client });

    await expect(workflow.run("mission-1")).resolves.toBe(repaymentTxId);
    expect(client.repay).toHaveBeenCalledWith({
      missionId: "mission-1",
      loanId: "loan-1",
      idempotencyKey: "repayment:loan-1",
    });
    expect(getMission(database, "mission-1")?.state).toBe("closed");
    expect(getLoan(database, "loan-1")).toMatchObject({
      state: "repaid",
      repaymentTxId,
    });
    database.close();
  });
});
