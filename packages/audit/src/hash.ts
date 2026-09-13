import { createHash } from "node:crypto";

import type { AuditEvent, HcsEventEnvelope } from "./index.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Builds the only payload allowed to cross the public HCS boundary. */
export function buildHcsEnvelope(event: AuditEvent): HcsEventEnvelope {
  if (!SHA256_HEX.test(event.payloadHash)) throw new Error("Audit payload hash must be lowercase SHA-256 hex");
  return {
    v: 1,
    eventId: event.id,
    missionId: event.missionId,
    type: event.type,
    payloadHash: event.payloadHash,
    ...(event.transactionId === undefined ? {} : { transactionId: event.transactionId }),
    occurredAt: event.occurredAt,
  };
}

/** Serializes a bounded, deterministic envelope without any local payload data. */
export function serializeHcsEnvelope(event: AuditEvent): string {
  const message = JSON.stringify(buildHcsEnvelope(event));
  const length = Buffer.byteLength(message, "utf8");
  if (length < 1 || length > 1024) throw new Error("Audit envelope must fit in one HCS message");
  return message;
}

export function hashAuditPayload(canonicalPayload: string): string {
  return createHash("sha256").update(canonicalPayload, "utf8").digest("hex");
}
