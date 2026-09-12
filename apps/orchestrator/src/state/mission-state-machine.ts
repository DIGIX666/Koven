import { randomUUID } from "node:crypto";

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

import { canonicalJsonValue, hashCanonicalJson } from "../canonical.js";

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
    persistAdditionalState?: () => void,
  ): Promise<PersistedMission> {
    assertTransition(from, to);
    const occurredAt = this.now();
    const payload = canonicalJsonValue({ from, to, detail: audit.payload }) as TransitionPayload<unknown>;
    const event: AuditEvent = {
      id: this.eventId(missionId, from, to),
      missionId,
      type: audit.type,
      payloadHash: hashCanonicalJson(payload),
      occurredAt,
    };
    if (audit.transactionId !== undefined) event.transactionId = audit.transactionId;

    const localEvent: LocalEvent<TransitionPayload<unknown>> = { ...event, payload };
    const persist = this.database.transaction(() => {
      if (getMission(this.database, missionId) === undefined) {
        throw new PersistenceNotFoundError("mission", missionId);
      }
      transitionMission(this.database, missionId, from, to, occurredAt);
      createEvent(this.database, localEvent);
      persistAdditionalState?.();
      const mission = getMission(this.database, missionId);
      if (mission === undefined) throw new PersistenceNotFoundError("mission", missionId);
      return mission;
    });

    const mission = persist.immediate();
    // The durable local event is authoritative until the HCS outbox lands in M5.
    // A best-effort sink failure must not invalidate an already committed transition.
    await this.auditSink.write(event).catch(() => undefined);
    return mission;
  }
}
