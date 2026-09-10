import { createHash, randomUUID } from "node:crypto";

import type { AuditEvent, AuditEventType, AuditSink } from "@koven/audit";
import { assertTransition, type MissionState } from "@koven/domain";
import {
  createEvent,
  getMission,
  PersistenceNotFoundError,
  transitionMission,
  type KovenDatabase,
  type LocalEvent,
  type PersistedMission,
} from "@koven/persistence";

export interface TransitionAudit<T = unknown> {
  type: AuditEventType;
  payload: T;
  transactionId?: string;
}

export interface MissionStateMachineOptions {
  now?: () => string;
  eventId?: (missionId: string, from: MissionState, to: MissionState) => string;
}

interface TransitionPayload<T> {
  from: MissionState;
  to: MissionState;
  detail: T;
}

const canonicalize = (value: unknown): unknown => {
  if (typeof value === "bigint") return value.toString(10);
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
};

const hashPayload = (payload: unknown): string => createHash("sha256")
  .update(JSON.stringify(canonicalize(payload)))
  .digest("hex");

/** Persists a state transition and its local audit record as one SQLite transaction. */
export class MissionStateMachine {
  private readonly now: () => string;
  private readonly eventId: (missionId: string, from: MissionState, to: MissionState) => string;

  constructor(
    private readonly database: KovenDatabase,
    private readonly auditSink: AuditSink,
    options: MissionStateMachineOptions = {},
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.eventId = options.eventId ?? (() => `event-${randomUUID()}`);
  }

  async transition<T>(
    missionId: string,
    from: MissionState,
    to: MissionState,
    audit: TransitionAudit<T>,
  ): Promise<PersistedMission> {
    assertTransition(from, to);
    const occurredAt = this.now();
    const payload: TransitionPayload<T> = { from, to, detail: audit.payload };
    const event: AuditEvent = {
      id: this.eventId(missionId, from, to),
      missionId,
      type: audit.type,
      payloadHash: hashPayload(payload),
      occurredAt,
    };
    if (audit.transactionId !== undefined) event.transactionId = audit.transactionId;

    const localEvent: LocalEvent<TransitionPayload<T>> = { ...event, payload };
    const persist = this.database.transaction(() => {
      if (getMission(this.database, missionId) === undefined) {
        throw new PersistenceNotFoundError("mission", missionId);
      }
      transitionMission(this.database, missionId, from, to, occurredAt);
      createEvent(this.database, localEvent);
      const mission = getMission(this.database, missionId);
      if (mission === undefined) throw new PersistenceNotFoundError("mission", missionId);
      return mission;
    });

    const mission = persist.immediate();
    await this.auditSink.write(event);
    return mission;
  }
}
