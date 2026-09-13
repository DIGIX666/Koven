import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HcsAuditWriter,
  type HcsPublisher,
  type HcsSubmissionResult,
  type PreparedHcsMessage,
} from "@koven/audit";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createEvent,
  listMissionEvents,
  openDatabase,
  MIGRATIONS,
  SqliteAuditOutbox,
  type KovenDatabase,
} from "../src/index.js";

const occurredAt = "2026-09-13T12:00:00.000Z";

class FakePublisher implements HcsPublisher {
  readonly messages: string[] = [];
  readonly submitted: string[] = [];
  readonly reconciled: string[] = [];
  submitResult: HcsSubmissionResult = { status: "confirmed", sequenceNumber: 1n };
  reconcileResult: HcsSubmissionResult = { status: "confirmed", sequenceNumber: 1n };
  private sequence = 0;

  async prepare(message: string): Promise<PreparedHcsMessage> {
    this.messages.push(message);
    this.sequence += 1;
    return {
      transactionId: `0.0.10@178869600${this.sequence}.000000001`,
      transactionBase64: Buffer.from(`prepared-${this.sequence}`).toString("base64"),
      validUntil: Date.parse(occurredAt) + 180_000,
    };
  }

  async submit(transactionBase64: string): Promise<HcsSubmissionResult> {
    this.submitted.push(transactionBase64);
    return this.submitResult;
  }

  async reconcile(transactionId: string): Promise<HcsSubmissionResult> {
    this.reconciled.push(transactionId);
    return this.reconcileResult;
  }
}

describe("durable HCS audit outbox", () => {
  let directory: string;
  let database: KovenDatabase;
  let now: number;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "koven-audit-"));
    database = openDatabase(join(directory, "audit.sqlite"));
    now = Date.parse(occurredAt);
  });

  afterEach(() => {
    if (database.open) database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const append = (id: string, missionId = "mission-1", payload = { secret: "local-only" }) => {
    createEvent(database, {
      id,
      missionId,
      type: "mission-created",
      payloadHash: "a".repeat(64),
      payload,
      occurredAt,
    });
  };

  it("atomically creates a public outbox row without copying the local payload", () => {
    append("event-1");
    expect(database.prepare("SELECT COUNT(*) AS count FROM events").get()).toEqual({ count: 1 });
    const row = database.prepare(`
      SELECT envelope_json, status FROM hcs_audit_outbox WHERE event_id = 'event-1'
    `).get() as { envelope_json: string; status: string };
    expect(row.status).toBe("pending");
    expect(row.envelope_json).not.toContain("local-only");
    expect(JSON.parse(row.envelope_json)).toMatchObject({ eventId: "event-1", missionId: "mission-1" });
  });

  it("backfills pending legacy events when a version-two database is reopened", () => {
    const path = join(directory, "legacy.sqlite");
    const legacy = new Database(path);
    legacy.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;
    `);
    for (const migration of MIGRATIONS.slice(0, 2)) {
      legacy.exec(migration.sql);
      legacy.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)")
        .run(migration.version, migration.name, occurredAt);
    }
    legacy.prepare(`
      INSERT INTO events (
        id, mission_id, type, payload_hash, payload_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run("legacy-event", "legacy-mission", "mission-created", "a".repeat(64), '{"secret":"local"}', occurredAt);
    legacy.close();

    const upgraded = openDatabase(path);
    const row = upgraded.prepare(`
      SELECT envelope_json, status FROM hcs_audit_outbox WHERE event_id = ?
    `).get("legacy-event") as { envelope_json: string; status: string };
    expect(row.status).toBe("pending");
    expect(row.envelope_json).not.toContain("secret");
    expect(JSON.parse(row.envelope_json)).toMatchObject({ eventId: "legacy-event" });
    upgraded.close();
  });

  it("publishes events in per-mission insertion order and stores HCS references", async () => {
    append("event-1");
    append("event-2");
    const publisher = new FakePublisher();
    let sequence = 40n;
    publisher.submit = async bytes => {
      publisher.submitted.push(bytes);
      sequence += 1n;
      return { status: "confirmed", sequenceNumber: sequence };
    };
    const writer = new HcsAuditWriter({
      store: new SqliteAuditOutbox(database),
      publisher,
      now: () => now,
      random: () => 0,
    });

    expect(await writer.dispatchDue()).toBe(2);
    expect(publisher.messages.map(message => JSON.parse(message).eventId)).toEqual(["event-1", "event-2"]);
    expect(listMissionEvents(database, "mission-1").map(event => event.hcsSequenceNumber))
      .toEqual([41n, 42n]);
    expect(new SqliteAuditOutbox(database).pendingCount()).toBe(0);
  });

  it("reconciles an uncertain stored transaction after restart without resubmitting", async () => {
    append("event-1");
    const publisher = new FakePublisher();
    publisher.submitResult = { status: "uncertain" };
    const first = new HcsAuditWriter({
      store: new SqliteAuditOutbox(database), publisher, now: () => now, random: () => 0,
    });
    await first.dispatchDue();
    expect(publisher.submitted).toHaveLength(1);

    now += 2;
    publisher.reconcileResult = { status: "confirmed", sequenceNumber: 99n };
    const restarted = new HcsAuditWriter({
      store: new SqliteAuditOutbox(database), publisher, now: () => now, random: () => 0,
    });
    await restarted.dispatchDue();

    expect(publisher.submitted).toHaveLength(1);
    expect(publisher.reconciled).toEqual(["0.0.10@1788696001.000000001"]);
    expect(listMissionEvents(database, "mission-1")[0]).toMatchObject({
      hcsTransactionId: "0.0.10@1788696001.000000001",
      hcsSequenceNumber: 99n,
    });
  });

  it("does not let a later mission event pass an earlier leased event", () => {
    append("event-1");
    append("event-2");
    append("other-event", "mission-2");
    const store = new SqliteAuditOutbox(database);

    expect(store.claimDue(now, 30_000)?.eventId).toBe("event-1");
    expect(store.claimDue(now, 30_000)?.eventId).toBe("other-event");
    expect(store.claimDue(now, 30_000)).toBeUndefined();
  });
});
