import { randomUUID } from "node:crypto";

import { createClient, getTopicMessages } from "@koven/hedera";
import { expect, it } from "vitest";

import {
  HederaHcsPublisher,
  HcsAuditWriter,
  serializeHcsEnvelope,
  type AuditOutboxJob,
  type AuditOutboxStore,
  type PreparedHcsMessage,
} from "../src/index.js";

class SingleEventStore implements AuditOutboxStore {
  private status: "pending" | "processing" | "published" = "pending";
  private prepared: PreparedHcsMessage | undefined;
  private attempted = false;
  private due = Date.now();
  transactionId: string | undefined;
  sequenceNumber: bigint | undefined;

  constructor(private readonly eventId: string, private readonly envelopeJson: string) {}

  claimDue(now: number): AuditOutboxJob | undefined {
    if (this.status !== "pending" || this.due > now) return undefined;
    this.status = "processing";
    return {
      eventId: this.eventId,
      missionId: "mission-hcs-smoke",
      envelope: JSON.parse(this.envelopeJson),
      envelopeJson: this.envelopeJson,
      attempts: this.attempted ? 1 : 0,
      token: "test-lease",
      transactionId: this.prepared?.transactionId ?? null,
      transactionBase64: this.prepared?.transactionBase64 ?? null,
      validUntil: this.prepared?.validUntil ?? null,
      submissionAttempted: this.attempted,
    };
  }

  savePrepared(_job: AuditOutboxJob, prepared: PreparedHcsMessage): void { this.prepared = prepared; }
  markSubmissionAttempted(): void { this.attempted = true; }
  markPublished(_job: AuditOutboxJob, transactionId: string, sequenceNumber: bigint): void {
    this.transactionId = transactionId;
    this.sequenceNumber = sequenceNumber;
    this.status = "published";
  }
  retry(_job: AuditOutboxJob, nextAttemptAt: number): void {
    this.status = "pending";
    this.due = nextAttemptAt;
  }
  pendingCount(): number { return this.status === "published" ? 0 : 1; }
  nextAttemptAt(): number | null { return this.status === "published" ? null : this.due; }
}

it("publishes one hashed lifecycle envelope and reads it from the Mirror Node", async () => {
  const topicId = process.env.HCS_AUDIT_TOPIC_ID;
  const mirrorNodeUrl = process.env.HEDERA_MIRROR_NODE_URL;
  if (!topicId || !mirrorNodeUrl) throw new Error("HCS_AUDIT_TOPIC_ID and HEDERA_MIRROR_NODE_URL are required");
  const eventId = `audit-smoke-${randomUUID()}`;
  const envelope = serializeHcsEnvelope({
    id: eventId,
    missionId: "mission-hcs-smoke",
    type: "mission-created",
    payloadHash: "a".repeat(64),
    occurredAt: new Date().toISOString(),
  });
  const store = new SingleEventStore(eventId, envelope);
  const client = createClient({
    HEDERA_NETWORK: process.env.HEDERA_NETWORK,
    HEDERA_OPERATOR_ID: process.env.HEDERA_OPERATOR_ID,
    HEDERA_OPERATOR_PRIVATE_KEY: process.env.HEDERA_OPERATOR_PRIVATE_KEY,
  }).setRequestTimeout(30_000).setMaxAttempts(3);
  try {
    const writer = new HcsAuditWriter({ store, publisher: new HederaHcsPublisher(client, topicId) });
    await writer.flush(60_000);
    expect(store.sequenceNumber).toBeDefined();

    const deadline = Date.now() + 60_000;
    let observed: string | undefined;
    while (Date.now() < deadline && observed === undefined) {
      const messages = await getTopicMessages(topicId, {
        mirrorNodeUrl,
        afterSequenceNumber: store.sequenceNumber! - 1n,
        limit: 10,
      });
      observed = messages
        .map(message => Buffer.from(message.message, "base64").toString("utf8"))
        .find(message => message.includes(eventId));
      if (observed === undefined) await new Promise(resolve => setTimeout(resolve, 1_000));
    }
    expect(observed).toBe(envelope);
    console.info(
      `F12 HCS audit verified: topic=${topicId} sequence=${store.sequenceNumber} transaction=${store.transactionId}`,
    );
  } finally {
    client.close();
  }
});
