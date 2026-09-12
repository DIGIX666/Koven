import { ErrorCode, IllegalStateTransitionError } from "@koven/domain";
import {
  createIdempotencyResult,
  getIdempotencyResult,
  getMission,
  PersistenceConflict,
  PersistenceConflictError,
  PersistenceNotFoundError,
  type KovenDatabase,
} from "@koven/persistence";
import type { HttpRequest, HttpResponse } from "@koven/schemas";

import { hashCanonicalJson } from "../canonical.js";
import type { MissionStateMachine } from "../state/index.js";

export interface CompletionHeaders {
  idempotencyKey: string;
  timestamp: string;
  signature: string;
}

export class CallbackAuthenticationError extends Error {
  readonly code = ErrorCode.CALLBACK_AUTH_INVALID;

  constructor(message: string) {
    super(message);
    this.name = "CallbackAuthenticationError";
  }
}

export class CompletionHandler {
  constructor(
    private readonly database: KovenDatabase,
    private readonly stateMachine: MissionStateMachine,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async receive(
    callback: HttpRequest<"completion">,
    headers: CompletionHeaders,
  ): Promise<HttpResponse<"completion">> {
    const expectedKey = `mission-complete:${callback.outcome.missionId}:${callback.report.reportSha256}`;
    if (headers.idempotencyKey !== expectedKey) {
      throw new CallbackAuthenticationError("Callback idempotency key does not match its payload");
    }

    const requestHash = hashCanonicalJson({
      callback,
      idempotencyKey: headers.idempotencyKey,
    });
    const existing = getIdempotencyResult<HttpResponse<"completion">>(
      this.database,
      headers.idempotencyKey,
    );
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        throw new PersistenceConflictError(
          PersistenceConflict.IDEMPOTENCY_CONFLICT,
          "Completion callback key was reused with different content",
        );
      }
      return { status: "duplicate", code: ErrorCode.CALLBACK_DUPLICATE };
    }

    const mission = getMission(this.database, callback.outcome.missionId);
    if (mission === undefined) {
      throw new PersistenceNotFoundError("mission", callback.outcome.missionId);
    }
    if (mission.state !== "running") {
      throw new IllegalStateTransitionError(mission.state, "completed");
    }
    const settlementTxId = callback.outcome.settlementTxId;
    if (settlementTxId === undefined) {
      throw new CallbackAuthenticationError("Delivered callback is missing settlement evidence");
    }

    const response = { status: "accepted" } as const;
    await this.stateMachine.transition(
      mission.id,
      "running",
      "completed",
      {
        type: "callback-received",
        payload: {
          reportSha256: callback.report.reportSha256,
          settlementTxId,
        },
        transactionId: settlementTxId,
      },
      () => createIdempotencyResult(this.database, {
        key: headers.idempotencyKey,
        requestHash,
        statusCode: 202,
        response,
        createdAt: this.now(),
      }),
    );
    return response;
  }
}
