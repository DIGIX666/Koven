import { ErrorCode } from "@koven/domain";
import {
  getLoanByMission,
  getMission,
  PersistenceNotFoundError,
  updateLoanState,
  type KovenDatabase,
} from "@koven/persistence";
import {
  ErrorResponseSchema,
  RepayRequestSchema,
  RepayResponseSchema,
  type HttpRequest,
  type HttpResponse,
} from "@koven/schemas";

import type { MissionStateMachine } from "../state/index.js";

const SERVICE_CREDENTIAL = /^[A-Za-z0-9_-]{43,}$/;

export interface RepaymentClient {
  repay(request: HttpRequest<"repay">): Promise<HttpResponse<"repay">>;
}

export class RepaymentRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    detail: string,
  ) {
    super(detail);
    this.name = "RepaymentRequestError";
  }
}

function trustedOrigin(value: string): URL {
  const url = new URL(value);
  const loopback = url.protocol === "http:"
    && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !loopback)
    || url.username || url.password || url.search || url.hash || url.pathname !== "/"
  ) throw new Error("Restricted signer URL must be an HTTPS or loopback HTTP origin");
  return url;
}

export interface HttpRepaymentClientOptions {
  readonly baseUrl: string;
  readonly credential: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/** Calls the typed signer command without accepting a recipient or amount from the orchestrator. */
export class HttpRepaymentClient implements RepaymentClient {
  private readonly baseUrl: URL;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: HttpRepaymentClientOptions) {
    this.baseUrl = trustedOrigin(options.baseUrl);
    if (!SERVICE_CREDENTIAL.test(options.credential)) throw new Error("Invalid orchestrator credential");
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
      throw new RangeError("Signer timeout must be between 1 and 120000 ms");
    }
  }

  async repay(input: HttpRequest<"repay">): Promise<HttpResponse<"repay">> {
    const request = RepayRequestSchema.parse(input);
    let response: Response;
    try {
      response = await this.fetchImplementation(new URL("/repay", this.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(request),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new RepaymentRequestError(
        503,
        ErrorCode.SETTLEMENT_UNCONFIRMED,
        "Repayment response was lost; retry the same command",
      );
    }
    if (response.status !== 200) {
      const error = ErrorResponseSchema.safeParse(await response.json().catch(() => undefined));
      throw error.success
        ? new RepaymentRequestError(response.status, error.data.code, error.data.detail)
        : new RepaymentRequestError(response.status, ErrorCode.INTERNAL_ERROR, "Restricted signer refused repayment");
    }
    return RepayResponseSchema.parse(await response.json());
  }
}

class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

export interface RepaymentWorkflowOptions {
  readonly database: KovenDatabase;
  readonly stateMachine: MissionStateMachine;
  readonly client: RepaymentClient;
}

/** Reconciles local mission state around the signer's durable, idempotent repayment command. */
export class RepaymentWorkflow {
  private readonly mutex = new KeyedMutex();

  constructor(private readonly options: RepaymentWorkflowOptions) {}

  run(missionId: string): Promise<string | null> {
    return this.mutex.run(missionId, () => this.runLocked(missionId));
  }

  private async runLocked(missionId: string): Promise<string | null> {
    let mission = getMission(this.options.database, missionId);
    if (mission === undefined) throw new PersistenceNotFoundError("mission", missionId);
    const loan = getLoanByMission(this.options.database, missionId);
    if (loan === undefined) {
      if (mission.state === "completed") {
        await this.options.stateMachine.transition(
          missionId,
          "completed",
          "closed",
          { type: "mission-completed", payload: { withoutCredit: true } },
        );
      }
      return null;
    }
    if (mission.state === "closed") {
      if (loan.state !== "repaid" || loan.repaymentTxId === undefined) {
        throw new RepaymentRequestError(409, ErrorCode.MISSION_NOT_REPAYABLE, "Closed mission has no repayment evidence");
      }
      return loan.repaymentTxId;
    }
    if (mission.state === "completed") {
      mission = await this.options.stateMachine.transition(
        missionId,
        "completed",
        "repayment-pending",
        { type: "mission-completed", payload: { loanId: loan.id } },
      );
    }

    let transactionId = loan.repaymentTxId;
    if (mission.state === "repayment-pending") {
      const result = await this.options.client.repay({
        missionId,
        loanId: loan.id,
        idempotencyKey: `repayment:${loan.id}`,
      });
      const confirmedTransactionId = result.transactionId;
      transactionId = confirmedTransactionId;
      mission = await this.options.stateMachine.transition(
        missionId,
        "repayment-pending",
        "repaid",
        {
          type: "repayment-settled",
          payload: { loanId: loan.id, transactionId: confirmedTransactionId },
          transactionId: confirmedTransactionId,
        },
        () => {
          if (!updateLoanState(this.options.database, loan.id, "funded", "repaid", {
            repaymentTxId: confirmedTransactionId,
          })) {
            throw new RepaymentRequestError(409, ErrorCode.LOAN_NOT_FUNDED, "Local loan is not funded");
          }
        },
      );
    }
    if (mission.state === "repaid") {
      if (transactionId === undefined) {
        throw new RepaymentRequestError(500, ErrorCode.INTERNAL_ERROR, "Repayment transaction is missing");
      }
      await this.options.stateMachine.transition(
        missionId,
        "repaid",
        "closed",
        {
          type: "repayment-settled",
          payload: { loanId: loan.id, transactionId },
          transactionId,
        },
      );
      return transactionId;
    }
    throw new RepaymentRequestError(409, ErrorCode.MISSION_NOT_REPAYABLE, `Mission is not repayable from ${mission.state}`);
  }
}
