import { randomUUID } from "node:crypto";

import type { AuditEventType } from "@koven/audit";
import { ErrorCode } from "@koven/domain";
import {
  Hbar,
  PrecheckStatusError,
  PrivateKey,
  ReceiptStatusError,
  Status,
  Transaction,
  TransactionId,
  TransactionReceiptQuery,
  TransferTransaction,
  type Client,
} from "@koven/hedera";
import { createEvent } from "@koven/persistence";
import { RepayRequestSchema, RepayResponseSchema, type HttpRequest, type HttpResponse } from "@koven/schemas";

import { canonicalHash } from "./canonical.js";
import { fail } from "./errors.js";
import { KeyedMutex, transactionValidUntil } from "./gate.js";
import type { TransferConfirmer } from "./ledger.js";
import type { SignerStore } from "./store.js";

/** Mirror lag tolerated after the transaction's valid window before an unseen submission is treated as not executed. */
export const REPAYMENT_FAILURE_GRACE_MS = 600_000;
const REPAYMENT_VALID_DURATION_SECONDS = 180;

export interface RepaymentTransfer {
  readonly from: string;
  readonly to: string;
  readonly amountTinybar: bigint;
  readonly memo: string;
}

export interface PreparedRepayment {
  readonly transactionId: string;
  readonly transactionBase64: string;
  /** Unix milliseconds of valid-start plus valid-duration. */
  readonly validUntil: number;
}

export type SubmissionOutcome = "success" | "failed" | "uncertain";

/** Builds and signs a transfer without submitting it, and submits stored bytes unchanged. */
export interface RepaymentLedger {
  prepare(transfer: RepaymentTransfer): Promise<PreparedRepayment>;
  submit(transactionBase64: string): Promise<SubmissionOutcome>;
}

/** Hedera SDK implementation: the consumer key signs here and nowhere else. */
export class SdkRepaymentLedger implements RepaymentLedger {
  constructor(
    private readonly client: Client,
    private readonly accountId: string,
    private readonly privateKey: PrivateKey,
  ) {}

  async prepare(transfer: RepaymentTransfer): Promise<PreparedRepayment> {
    if (transfer.from !== this.accountId) throw new Error("Repayment must be paid by the signer's consumer account");
    if (transfer.amountTinybar <= 0n || transfer.amountTinybar > 9_223_372_036_854_775_807n) {
      throw new Error("Repayment amount must be a positive int64 tinybar amount");
    }
    const transaction = new TransferTransaction()
      .addHbarTransfer(transfer.from, Hbar.fromTinybars((-transfer.amountTinybar).toString()))
      .addHbarTransfer(transfer.to, Hbar.fromTinybars(transfer.amountTinybar.toString()))
      .setTransactionMemo(transfer.memo)
      .setTransactionId(TransactionId.generate(transfer.from))
      .setTransactionValidDuration(REPAYMENT_VALID_DURATION_SECONDS)
      .freezeWith(this.client);
    await transaction.sign(this.privateKey);
    const transactionBase64 = Buffer.from(transaction.toBytes()).toString("base64");
    const transactionId = transaction.transactionId?.toString();
    if (transactionId === undefined) throw new Error("Repayment transaction has no ID");
    return { transactionId, transactionBase64, validUntil: transactionValidUntil(transactionBase64, transactionId) };
  }

  /**
   * Submits the persisted bytes and reads the receipt for the persisted
   * transaction ID through `TransactionReceiptQuery`, never through
   * `TransactionResponse.getReceipt()`: the latter reacts to
   * `THROTTLED_AT_CONSENSUS` by regenerating the ID and resubmitting, which
   * would move funds under an ID this store never recorded. Here a throttled
   * receipt is a definite failure of that ID and the service builds and
   * persists the replacement itself.
   *
   * A receipt is consensus: success or a definite failure. A precheck
   * rejection never reached consensus, except `DUPLICATE_TRANSACTION`, which
   * means these bytes were already accepted and must be reconciled instead.
   * Anything else (network errors, timeouts) is uncertain.
   */
  async submit(transactionBase64: string): Promise<SubmissionOutcome> {
    const transaction = Transaction.fromBytes(Buffer.from(transactionBase64, "base64"));
    const persistedId = transaction.transactionId;
    if (persistedId === null) throw new Error("Stored repayment bytes carry no transaction ID");
    try {
      const response = await transaction.execute(this.client);
      if (response.transactionId.toString() !== persistedId.toString()) return "uncertain";
      const receipt = await new TransactionReceiptQuery().setTransactionId(persistedId).execute(this.client);
      return receipt.status === Status.Success ? "success" : "failed";
    } catch (error) {
      if (error instanceof ReceiptStatusError) return "failed";
      if (error instanceof PrecheckStatusError) {
        return error.status === Status.DuplicateTransaction ? "uncertain" : "failed";
      }
      return "uncertain";
    }
  }
}

export interface RepaymentServiceOptions {
  readonly store: SignerStore;
  readonly accountId: string;
  readonly ledger: RepaymentLedger;
  readonly confirmer: TransferConfirmer;
  readonly now?: () => Date;
}

/**
 * `/repay`: the caller supplies only the mission, the loan and the frozen
 * idempotency key. Lender and exact principal + fee come from the registered
 * loan, the mission must have an independently accepted completion, and one
 * stable signed transaction is persisted before submission and reconciled on
 * retries; a fresh transaction is only built once the previous one can no
 * longer execute.
 */
export class RepaymentService {
  private readonly mutex = new KeyedMutex();
  private readonly now: () => Date;

  constructor(private readonly options: RepaymentServiceOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async repay(input: HttpRequest<"repay">): Promise<HttpResponse<"repay">> {
    const request = RepayRequestSchema.parse(input);
    return this.mutex.run(request.loanId, async () => {
      const loan = this.options.store.getLoan(request.loanId);
      if (loan === undefined) fail(ErrorCode.NOT_FOUND, "Loan is not registered");
      if (loan.missionId !== request.missionId) fail(ErrorCode.REQUEST_INVALID, "Loan does not belong to the mission");
      if (loan.state === "repaid" && loan.repaymentTxId !== undefined) {
        this.emit(loan.missionId, "repayment-idempotency-hit", { loanId: loan.id, transactionId: loan.repaymentTxId }, loan.repaymentTxId);
        return RepayResponseSchema.parse({ transactionId: loan.repaymentTxId });
      }
      if (loan.state !== "funded") fail(ErrorCode.LOAN_NOT_FUNDED, "Loan is not funded");
      if (this.options.store.getCompletion(loan.missionId) === undefined) {
        fail(ErrorCode.MISSION_NOT_REPAYABLE, "Mission has no independently accepted completion");
      }

      const transfer: RepaymentTransfer = {
        from: this.options.accountId,
        to: loan.lenderAccountId,
        amountTinybar: loan.principalTinybar + loan.feeTinybar,
        memo: `repayment:${loan.id}`,
      };
      const expectation = {
        payerAccountId: transfer.from,
        recipientAccountId: transfer.to,
        amountTinybar: transfer.amountTinybar,
      };

      let pending = this.options.store.getRepayment(loan.id);
      if (pending?.status === "confirmed") return this.settle(loan.id, loan.missionId, pending.transactionId);
      if (pending !== undefined && pending.status === "pending") {
        try {
          await this.options.confirmer.confirm({ transactionId: pending.transactionId, ...expectation });
          return this.settle(loan.id, loan.missionId, pending.transactionId);
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== ErrorCode.SETTLEMENT_UNCONFIRMED) throw error;
        }
        const nowMs = this.now().getTime();
        if (nowMs >= pending.validUntil + REPAYMENT_FAILURE_GRACE_MS) {
          this.options.store.updateRepayment(loan.id, "failed", "Transaction expired without reaching consensus", this.now().toISOString());
          pending = undefined;
        } else if (nowMs >= pending.validUntil) {
          fail(ErrorCode.SETTLEMENT_UNCONFIRMED, "Repayment outcome is uncertain until the ledger view settles");
        }
      }

      if (pending === undefined || pending.status === "failed") {
        const prepared = await this.options.ledger.prepare(transfer);
        this.options.store.saveRepayment({ loanId: loan.id, ...prepared }, this.now().toISOString());
        pending = this.options.store.getRepayment(loan.id)!;
      }

      const outcome = await this.options.ledger.submit(pending.transactionBase64);
      if (outcome === "success") return this.settle(loan.id, loan.missionId, pending.transactionId);
      this.options.store.updateRepayment(
        loan.id,
        outcome === "failed" ? "failed" : "pending",
        outcome === "failed" ? "Repayment transaction failed at consensus" : "Repayment submission outcome is uncertain",
        this.now().toISOString(),
      );
      fail(
        ErrorCode.SETTLEMENT_UNCONFIRMED,
        outcome === "failed" ? "Repayment transaction failed; retry builds a new one" : "Repayment is not confirmed yet",
      );
    });
  }

  private settle(loanId: string, missionId: string, transactionId: string): HttpResponse<"repay"> {
    const now = this.now().toISOString();
    this.options.store.updateRepayment(loanId, "confirmed", null, now);
    this.options.store.markLoanRepaid(loanId, transactionId);
    this.emit(missionId, "repayment-settled", { loanId, transactionId }, transactionId);
    return RepayResponseSchema.parse({ transactionId });
  }

  private emit(missionId: string, type: AuditEventType, payload: Record<string, string>, transactionId: string): void {
    createEvent(this.options.store.database, {
      id: `event-${randomUUID()}`,
      missionId,
      type,
      payloadHash: canonicalHash(payload),
      transactionId,
      occurredAt: this.now().toISOString(),
      payload,
    });
  }
}
