import type { AuditEventType } from "@koven/audit";
import {
  ALLOWED_TRANSITIONS,
  ErrorCode,
  IllegalStateTransitionError,
  MISSION_STATES,
  type Mission,
  type MissionState,
} from "@koven/domain";
import {
  createMission,
  getMission,
  listMissionEvents,
  openDatabase,
  PersistenceConflictError,
  type KovenDatabase,
} from "@koven/persistence";
import { NoopAuditSink } from "@koven/testing";
import { afterEach, describe, expect, it } from "vitest";

import { MissionStateMachine } from "../src/state/index.js";

const timestamp = "2026-09-10T12:00:00.000Z";
const hash = "a".repeat(64);
const databases: KovenDatabase[] = [];

const databaseForTest = (): KovenDatabase => {
  const database = openDatabase(":memory:");
  databases.push(database);
  return database;
};

const mission = (id: string, state: MissionState = "created"): Mission => ({
  id,
  state,
  spendingCapTinybar: 1_000n,
  spentTinybar: 0n,
  approvedRecipientsRoot: "1",
  targetRef: "Example.sol",
  targetSha256: hash,
  createdAt: timestamp,
  updatedAt: timestamp,
});

const machineForTest = (database: KovenDatabase, sink: NoopAuditSink, fixedId?: string) => {
  let sequence = 0;
  return new MissionStateMachine(database, sink, {
    now: () => timestamp,
    eventId: () => fixedId ?? `event-${++sequence}`,
  });
};

interface Step {
  from: MissionState;
  to: MissionState;
  type: AuditEventType;
}

const walk = async (
  machine: MissionStateMachine,
  missionId: string,
  steps: readonly Step[],
): Promise<void> => {
  for (const step of steps) {
    await machine.transition(missionId, step.from, step.to, step.type === "mission-failed"
      ? { type: step.type, payload: { reason: "injected failure" } }
      : { type: step.type, payload: { step: step.to } });
  }
};

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("MissionStateMachine", () => {
  it("persists the funded happy path and emits one audit event per transition", async () => {
    const database = databaseForTest();
    const sink = new NoopAuditSink();
    const stateMachine = machineForTest(database, sink);
    createMission(database, mission("mission-happy"));

    const steps = [
      { from: "created", to: "discovering-services", type: "mission-created" },
      { from: "discovering-services", to: "credit-requested", type: "credit-requested" },
      { from: "credit-requested", to: "funded", type: "loan-funded" },
      { from: "funded", to: "payment-preparation", type: "offer-accepted" },
      { from: "payment-preparation", to: "payment-authorized", type: "payment-authorized" },
      { from: "payment-authorized", to: "service-paid", type: "x402-settled" },
      { from: "service-paid", to: "running", type: "x402-settled" },
      { from: "running", to: "completed", type: "report-received" },
      { from: "completed", to: "repayment-pending", type: "mission-completed" },
      { from: "repayment-pending", to: "repaid", type: "repayment-settled" },
      { from: "repaid", to: "closed", type: "repayment-settled" },
    ] as const satisfies readonly Step[];

    await walk(stateMachine, "mission-happy", steps);

    expect(getMission(database, "mission-happy")?.state).toBe("closed");
    const events = listMissionEvents<{ from: MissionState; to: MissionState }>(
      database,
      "mission-happy",
    );
    expect(events).toHaveLength(steps.length);
    expect(sink.events).toHaveLength(steps.length);
    expect(events.map(event => event.type)).toEqual(steps.map(step => step.type));
    expect(events.every(event => /^[0-9a-f]{64}$/.test(event.payloadHash))).toBe(true);
    expect(sink.events).toEqual(events.map(({ payload: _payload, ...event }) => event));
  });

  it("walks policy rejection, recovery, failure, and default paths", async () => {
    const database = databaseForTest();
    const sink = new NoopAuditSink();
    const stateMachine = machineForTest(database, sink);
    createMission(database, mission("mission-policy"));
    createMission(database, mission("mission-default"));

    await walk(stateMachine, "mission-policy", [
      { from: "created", to: "discovering-services", type: "mission-created" },
      { from: "discovering-services", to: "payment-preparation", type: "providers-ranked" },
      { from: "payment-preparation", to: "policy-rejected", type: "payment-rejected" },
      { from: "policy-rejected", to: "recovery", type: "payment-rejected" },
      { from: "recovery", to: "closed", type: "mission-failed" },
    ]);
    await walk(stateMachine, "mission-default", [
      { from: "created", to: "failed", type: "mission-failed" },
      { from: "failed", to: "recovery", type: "mission-failed" },
      { from: "recovery", to: "repayment-pending", type: "mission-failed" },
      { from: "repayment-pending", to: "defaulted", type: "mission-failed" },
    ]);

    expect(getMission(database, "mission-policy")?.state).toBe("closed");
    expect(getMission(database, "mission-default")?.state).toBe("defaulted");
    expect(listMissionEvents(database, "mission-policy")).toHaveLength(5);
    expect(listMissionEvents(database, "mission-default")).toHaveLength(4);
  });

  it("executes every allowed edge against persisted state", async () => {
    const database = databaseForTest();
    const sink = new NoopAuditSink();
    const stateMachine = machineForTest(database, sink);
    let transitions = 0;

    for (const from of MISSION_STATES) {
      for (const to of ALLOWED_TRANSITIONS[from]) {
        const id = `edge-${from}-${to}`;
        createMission(database, mission(id, from));
        await stateMachine.transition(id, from, to, {
          type: to === "failed" ? "mission-failed" : "mission-created",
          payload: { from, to },
        });
        expect(getMission(database, id)?.state).toBe(to);
        expect(listMissionEvents(database, id)).toHaveLength(1);
        transitions += 1;
      }
    }

    expect(sink.events).toHaveLength(transitions);
  });

  it("leaves state and events untouched after illegal or stale transitions", async () => {
    const database = databaseForTest();
    const sink = new NoopAuditSink();
    const stateMachine = machineForTest(database, sink);
    createMission(database, mission("mission-invalid"));

    await expect(stateMachine.transition(
      "mission-invalid",
      "created",
      "closed",
      { type: "mission-completed", payload: {} },
    )).rejects.toMatchObject({ code: ErrorCode.ILLEGAL_STATE_TRANSITION });
    await expect(stateMachine.transition(
      "mission-invalid",
      "discovering-services",
      "payment-preparation",
      { type: "providers-ranked", payload: {} },
    )).rejects.toBeInstanceOf(PersistenceConflictError);

    expect(getMission(database, "mission-invalid")?.state).toBe("created");
    expect(listMissionEvents(database, "mission-invalid")).toEqual([]);
    expect(sink.events).toEqual([]);
  });

  it("rolls back the state update when the local event cannot be persisted", async () => {
    const database = databaseForTest();
    const sink = new NoopAuditSink();
    const stateMachine = machineForTest(database, sink, "same-event");
    createMission(database, mission("mission-atomic"));

    await stateMachine.transition(
      "mission-atomic",
      "created",
      "discovering-services",
      { type: "mission-created", payload: {} },
    );
    await expect(stateMachine.transition(
      "mission-atomic",
      "discovering-services",
      "payment-preparation",
      { type: "providers-ranked", payload: {} },
    )).rejects.toBeInstanceOf(PersistenceConflictError);

    expect(getMission(database, "mission-atomic")?.state).toBe("discovering-services");
    expect(listMissionEvents(database, "mission-atomic")).toHaveLength(1);
    expect(sink.events).toHaveLength(1);
  });

  it("keeps a committed transition successful when best-effort publication fails", async () => {
    const database = databaseForTest();
    const sink = new NoopAuditSink();
    const stateMachine = machineForTest(database, sink);
    createMission(database, mission("mission-audit-failure"));
    sink.failNext(new Error("audit unavailable"));

    await expect(stateMachine.transition(
      "mission-audit-failure",
      "created",
      "discovering-services",
      { type: "mission-created", payload: {} },
    )).resolves.toMatchObject({ state: "discovering-services" });

    expect(getMission(database, "mission-audit-failure")?.state).toBe("discovering-services");
    expect(listMissionEvents(database, "mission-audit-failure")).toHaveLength(1);
    expect(sink.events).toEqual([]);
  });

  it.each(["closed", "defaulted"] as const)(
    "keeps terminal state %s immutable",
    async (terminal) => {
      const database = databaseForTest();
      const sink = new NoopAuditSink();
      const stateMachine = machineForTest(database, sink);
      createMission(database, mission(`mission-${terminal}`, terminal));

      await expect(stateMachine.transition(
        `mission-${terminal}`,
        terminal,
        "created",
        { type: "mission-created", payload: {} },
      )).rejects.toBeInstanceOf(IllegalStateTransitionError);
      expect(getMission(database, `mission-${terminal}`)?.state).toBe(terminal);
      expect(listMissionEvents(database, `mission-${terminal}`)).toEqual([]);
    },
  );
});
