import { ErrorCode, type CreditAcceptance, type Loan, type UnsignedCreditRequest } from "@koven/domain";
import {
  createIdempotencyResult,
  createLoan,
  createMission,
  createSpendingSession,
  getIdempotencyResult,
  getLoan,
  getMission,
  getSpendingSession,
  openDatabase,
  PersistenceConflict,
  PersistenceConflictError,
  reserveSpending,
  updateLoanState,
  type KovenDatabase,
} from "@koven/persistence";
import { CreditOfferSchema, MissionPolicyRequestSchema, ScanPaymentAuthorizationSchema, type HttpRequest } from "@koven/schemas";

import { canonicalHash, canonicalJson } from "./canonical.js";
import { fail, SignerError } from "./errors.js";

export type MissionPolicy = HttpRequest<"registerMissionPolicy">;
export type WireAuthorization = ReturnType<typeof ScanPaymentAuthorizationSchema.parse>;
export type WireOffer = ReturnType<typeof CreditOfferSchema.parse>;

export interface StoredAuthorization {
  readonly missionId: string;
  readonly nonce: string;
  readonly commitment: string;
  readonly transactionBase64: string;
  readonly authorization: WireAuthorization;
  /** Unix milliseconds of valid-start plus valid-duration. */
  readonly validUntil: number;
}

export interface StoredCreditRequest {
  readonly request: UnsignedCreditRequest;
  readonly signature: string;
}

export interface StoredAcceptance {
  readonly acceptance: CreditAcceptance;
  readonly signature: string;
  readonly offer: WireOffer;
}

export interface StoredCompletion {
  readonly missionId: string;
  readonly reportSha256: string;
  readonly settlementTxId: string;
  readonly acceptedAt: string;
}

export type RepaymentStatus = "pending" | "confirmed" | "failed";

export interface StoredRepayment {
  readonly loanId: string;
  readonly transactionId: string;
  readonly transactionBase64: string;
  readonly validUntil: number;
  readonly status: RepaymentStatus;
  readonly attempts: number;
  readonly lastError: string | null;
}

const POLICY_TARGET_REF = "restricted-signer-policy";

const conflictCode = (error: unknown): SignerError | undefined => {
  if (!(error instanceof PersistenceConflictError)) return undefined;
  switch (error.conflict) {
    case PersistenceConflict.NONCE_ALREADY_USED:
    case PersistenceConflict.PAYMENT_COMMITMENT_ALREADY_USED:
      return new SignerError(ErrorCode.NONCE_ALREADY_USED, "Nonce or payment commitment was already consumed for this mission");
    case PersistenceConflict.CAP_EXCEEDED:
      return new SignerError(ErrorCode.CAP_EXCEEDED, "Payment exceeds the mission spending cap");
    case PersistenceConflict.CUMULATIVE_BUDGET_EXCEEDED:
      return new SignerError(ErrorCode.CUMULATIVE_BUDGET_EXCEEDED, "Payment exceeds the remaining mission or session budget");
    case PersistenceConflict.LOAN_REGISTRATION_CONFLICT:
      return new SignerError(ErrorCode.LOAN_REGISTRATION_CONFLICT, error.message);
    case PersistenceConflict.IDEMPOTENCY_CONFLICT:
      return new SignerError(ErrorCode.IDEMPOTENCY_CONFLICT, error.message);
    default:
      return new SignerError(ErrorCode.INTERNAL_ERROR, error.message);
  }
};

/** The signer's private database: policy, nonce/budget, loan, completion and repayment state. */
export class SignerStore {
  readonly database: KovenDatabase;

  constructor(filename: string) {
    this.database = openDatabase(filename);
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS signer_mission_policies (
        mission_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        policy_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS signer_authorizations (
        mission_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        commitment TEXT NOT NULL UNIQUE,
        transaction_sha256 TEXT NOT NULL UNIQUE,
        transaction_id TEXT NOT NULL UNIQUE,
        transaction_base64 TEXT NOT NULL,
        authorization_json TEXT NOT NULL,
        valid_until INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (mission_id, nonce)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS signer_credit_requests (
        id TEXT PRIMARY KEY,
        mission_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        request_json TEXT NOT NULL,
        signature TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS signer_acceptances (
        mission_id TEXT PRIMARY KEY,
        offer_id TEXT NOT NULL UNIQUE,
        request_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        offer_json TEXT NOT NULL,
        acceptance_json TEXT NOT NULL,
        signature TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS signer_completions (
        mission_id TEXT PRIMARY KEY,
        report_sha256 TEXT NOT NULL,
        settlement_tx_id TEXT NOT NULL UNIQUE,
        accepted_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS signer_repayments (
        loan_id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL UNIQUE,
        transaction_base64 TEXT NOT NULL,
        valid_until INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  }

  close(): void {
    this.database.close();
  }

  // --- mission policy -------------------------------------------------------

  /**
   * Persists an operator-provisioned policy exactly once. Identical retries are
   * acknowledged; a differing registration for the same mission is rejected.
   * The mission's spending cap and session cap become the persistence budgets
   * that `/authorize` reserves against; a new mission cannot raise a session's
   * stored cap.
   */
  registerMissionPolicy(policy: MissionPolicy, now: string): "registered" | "duplicate" {
    const parsed = MissionPolicyRequestSchema.parse(policy);
    const contentHash = canonicalHash(parsed);
    const register = this.database.transaction((): "registered" | "duplicate" => {
      const existing = this.database.prepare(`
        SELECT content_hash FROM signer_mission_policies WHERE mission_id = ?
      `).get(parsed.missionId) as { content_hash: string } | undefined;
      if (existing !== undefined) {
        if (existing.content_hash === contentHash) return "duplicate";
        fail(ErrorCode.MISSION_POLICY_CONFLICT, "Mission policy already exists with different content");
      }

      const sessionCap = BigInt(parsed.sessionCapTinybar);
      const session = getSpendingSession(this.database, parsed.sessionId);
      if (session === undefined) {
        createSpendingSession(this.database, { id: parsed.sessionId, spendingCapTinybar: sessionCap, spentTinybar: 0n });
      } else if (sessionCap > session.spendingCapTinybar) {
        fail(ErrorCode.MISSION_POLICY_CONFLICT, "A new mission cannot raise the session's stored cap");
      }
      createMission(this.database, {
        id: parsed.missionId,
        state: "created",
        spendingCapTinybar: BigInt(parsed.spendingCapTinybar),
        spentTinybar: 0n,
        approvedRecipientsRoot: parsed.approvedRecipientsRoot,
        targetRef: POLICY_TARGET_REF,
        targetSha256: parsed.targetSha256,
        createdAt: now,
        updatedAt: now,
      }, parsed.sessionId);
      this.database.prepare(`
        INSERT INTO signer_mission_policies (mission_id, content_hash, policy_json, created_at)
        VALUES (?, ?, ?, ?)
      `).run(parsed.missionId, contentHash, canonicalJson(parsed), now);
      return "registered";
    });
    try {
      return register.immediate();
    } catch (error) {
      throw conflictCode(error) ?? error;
    }
  }

  getMissionPolicy(missionId: string): MissionPolicy | undefined {
    const row = this.database.prepare(`
      SELECT policy_json FROM signer_mission_policies WHERE mission_id = ?
    `).get(missionId) as { policy_json: string } | undefined;
    return row === undefined ? undefined : MissionPolicyRequestSchema.parse(JSON.parse(row.policy_json));
  }

  // --- payment authorization -------------------------------------------------

  /**
   * One SQLite transaction: consume `(missionId, nonce)` and the unique
   * commitment, reserve mission and session budget, and persist the exact
   * signed bytes with their authorization. Nothing is consumed when it throws.
   */
  reserveAuthorization(record: StoredAuthorization, now: string): void {
    const reserve = this.database.transaction(() => {
      reserveSpending(this.database, {
        missionId: record.missionId,
        nonce: record.nonce,
        paymentCommitment: record.commitment,
        amountTinybar: BigInt(record.authorization.amountTinybar),
        consumedAt: now,
      });
      this.database.prepare(`
        INSERT INTO signer_authorizations (
          mission_id, nonce, commitment, transaction_sha256, transaction_id,
          transaction_base64, authorization_json, valid_until, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        record.missionId,
        record.nonce,
        record.commitment,
        record.authorization.transactionSha256,
        record.authorization.transactionId,
        record.transactionBase64,
        canonicalJson(record.authorization),
        record.validUntil,
        now,
      );
    });
    try {
      reserve.immediate();
    } catch (error) {
      throw conflictCode(error) ?? error;
    }
  }

  getAuthorizationByTransactionId(transactionId: string): StoredAuthorization | undefined {
    const row = this.database.prepare(`
      SELECT mission_id, nonce, commitment, transaction_base64, authorization_json, valid_until
      FROM signer_authorizations WHERE transaction_id = ?
    `).get(transactionId) as {
      mission_id: string; nonce: string; commitment: string; transaction_base64: string;
      authorization_json: string; valid_until: number;
    } | undefined;
    return row === undefined ? undefined : {
      missionId: row.mission_id,
      nonce: row.nonce,
      commitment: row.commitment,
      transactionBase64: row.transaction_base64,
      authorization: ScanPaymentAuthorizationSchema.parse(JSON.parse(row.authorization_json)),
      validUntil: row.valid_until,
    };
  }

  // --- credit ----------------------------------------------------------------

  /** Records the unsigned request before its signature is returned; duplicate IDs must be identical. */
  saveCreditRequest(request: UnsignedCreditRequest, signature: string, now: string): StoredCreditRequest {
    const contentHash = canonicalHash(request);
    const save = this.database.transaction((): StoredCreditRequest => {
      const existing = this.getCreditRequest(request.id);
      if (existing !== undefined) {
        if (canonicalHash(existing.request) !== contentHash) {
          fail(ErrorCode.IDEMPOTENCY_CONFLICT, "Credit request ID was reused with different content");
        }
        return existing;
      }
      this.database.prepare(`
        INSERT INTO signer_credit_requests (id, mission_id, content_hash, request_json, signature, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(request.id, request.missionId, contentHash, canonicalJson(request), signature, now);
      return { request, signature };
    });
    return save.immediate();
  }

  getCreditRequest(id: string): StoredCreditRequest | undefined {
    const row = this.database.prepare(`
      SELECT request_json, signature FROM signer_credit_requests WHERE id = ?
    `).get(id) as { request_json: string; signature: string } | undefined;
    if (row === undefined) return undefined;
    const parsed = JSON.parse(row.request_json) as Omit<UnsignedCreditRequest, "principalTinybar"> & { principalTinybar: string };
    return { request: { ...parsed, principalTinybar: BigInt(parsed.principalTinybar) }, signature: row.signature };
  }

  /** One immutable acceptance per mission; identical retries return the stored signature. */
  saveAcceptance(offer: WireOffer, acceptance: CreditAcceptance, signature: string, now: string): StoredAcceptance {
    const contentHash = canonicalHash(acceptance);
    const save = this.database.transaction((): StoredAcceptance => {
      const existing = this.getAcceptance(acceptance.missionId);
      if (existing !== undefined) {
        if (canonicalHash(existing.acceptance) !== contentHash) {
          fail(ErrorCode.CREDIT_ACCEPTANCE_CONFLICT, "Mission already has a different accepted offer");
        }
        return existing;
      }
      this.database.prepare(`
        INSERT INTO signer_acceptances (
          mission_id, offer_id, request_id, content_hash, offer_json, acceptance_json, signature, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        acceptance.missionId,
        acceptance.offerId,
        acceptance.requestId,
        contentHash,
        canonicalJson(offer),
        canonicalJson(acceptance),
        signature,
        now,
      );
      return { acceptance, signature, offer };
    });
    return save.immediate();
  }

  getAcceptance(missionId: string): StoredAcceptance | undefined {
    const row = this.database.prepare(`
      SELECT offer_json, acceptance_json, signature FROM signer_acceptances WHERE mission_id = ?
    `).get(missionId) as { offer_json: string; acceptance_json: string; signature: string } | undefined;
    return row === undefined ? undefined : {
      acceptance: JSON.parse(row.acceptance_json) as CreditAcceptance,
      signature: row.signature,
      offer: CreditOfferSchema.parse(JSON.parse(row.offer_json)),
    };
  }

  // --- loans -----------------------------------------------------------------

  getLoan(loanId: string): Loan | undefined {
    return getLoan(this.database, loanId);
  }

  getLoanByFundingTransaction(fundingTxId: string): Loan | undefined {
    const row = this.database.prepare(`SELECT id FROM loans WHERE funding_tx_id = ?`).get(fundingTxId) as { id: string } | undefined;
    return row === undefined ? undefined : getLoan(this.database, row.id);
  }

  getLoanByMission(missionId: string): Loan | undefined {
    const row = this.database.prepare(`SELECT id FROM loans WHERE mission_id = ?`).get(missionId) as { id: string } | undefined;
    return row === undefined ? undefined : getLoan(this.database, row.id);
  }

  /**
   * Registers a verified funded loan once. Identical registrations succeed
   * even after the loan moved on (a lender retrying a lost acknowledgement
   * after repayment); registrations with different terms or funding fail.
   */
  registerFundedLoan(loan: Loan & { fundingTxId: string }): Loan {
    const terms = ({ id, offerId, missionId, lenderAccountId, principalTinybar, feeTinybar, fundingTxId }: Loan) => (
      canonicalJson({ id, offerId, missionId, lenderAccountId, principalTinybar, feeTinybar, fundingTxId })
    );
    const register = this.database.transaction((): Loan => {
      const existing = getLoan(this.database, loan.id);
      if (existing !== undefined) {
        if (terms(existing) !== terms(loan)) {
          fail(ErrorCode.LOAN_REGISTRATION_CONFLICT, "Loan is already registered with different terms");
        }
        return existing;
      }
      if (this.getLoanByFundingTransaction(loan.fundingTxId) !== undefined) {
        fail(ErrorCode.LOAN_REGISTRATION_CONFLICT, "Funding transaction already registered for another loan");
      }
      if (this.getLoanByMission(loan.missionId) !== undefined) {
        fail(ErrorCode.LOAN_REGISTRATION_CONFLICT, "Mission already has a registered loan");
      }
      createLoan(this.database, loan);
      return loan;
    });
    try {
      return register.immediate();
    } catch (error) {
      throw conflictCode(error) ?? error;
    }
  }

  markLoanRepaid(loanId: string, repaymentTxId: string): void {
    if (!updateLoanState(this.database, loanId, "funded", "repaid", { repaymentTxId })) {
      const current = getLoan(this.database, loanId);
      if (current?.state !== "repaid" || current.repaymentTxId !== repaymentTxId) {
        fail(ErrorCode.INTERNAL_ERROR, "Loan repayment state could not be recorded");
      }
    }
  }

  // --- completion ------------------------------------------------------------

  getCompletion(missionId: string): StoredCompletion | undefined {
    const row = this.database.prepare(`
      SELECT mission_id, report_sha256, settlement_tx_id, accepted_at FROM signer_completions WHERE mission_id = ?
    `).get(missionId) as { mission_id: string; report_sha256: string; settlement_tx_id: string; accepted_at: string } | undefined;
    return row === undefined ? undefined : {
      missionId: row.mission_id,
      reportSha256: row.report_sha256,
      settlementTxId: row.settlement_tx_id,
      acceptedAt: row.accepted_at,
    };
  }

  /**
   * "duplicate" when the key is stored with the same content. Conflicting
   * content for the key, or a second report for a mission that already has an
   * accepted completion, is rejected before any ledger lookup.
   */
  completionReplay(missionId: string, reportSha256: string, idempotencyKey: string, requestHash: string): "duplicate" | "new" {
    const existing = getIdempotencyResult(this.database, idempotencyKey);
    if (existing !== undefined) {
      if (existing.requestHash !== requestHash) {
        fail(ErrorCode.IDEMPOTENCY_CONFLICT, "Callback key was reused with different content");
      }
      return "duplicate";
    }
    const completion = this.getCompletion(missionId);
    if (completion !== undefined && completion.reportSha256 !== reportSha256) {
      fail(ErrorCode.IDEMPOTENCY_CONFLICT, "Mission already has an accepted completion");
    }
    return "new";
  }

  /**
   * Accepts one completion per mission and the callback idempotency key in the
   * same transaction. Returns "accepted" on first success, "duplicate" for an
   * identical replay; conflicting content for a stored key or a second
   * completion for the mission is rejected.
   */
  recordCompletion(
    completion: StoredCompletion,
    idempotencyKey: string,
    requestHash: string,
  ): "accepted" | "duplicate" {
    const record = this.database.transaction((): "accepted" | "duplicate" => {
      const existing = getIdempotencyResult(this.database, idempotencyKey);
      if (existing !== undefined) {
        if (existing.requestHash !== requestHash) {
          fail(ErrorCode.IDEMPOTENCY_CONFLICT, "Callback key was reused with different content");
        }
        return "duplicate";
      }
      const stored = this.getCompletion(completion.missionId);
      if (stored !== undefined) {
        fail(ErrorCode.IDEMPOTENCY_CONFLICT, "Mission already has an accepted completion");
      }
      this.database.prepare(`
        INSERT INTO signer_completions (mission_id, report_sha256, settlement_tx_id, accepted_at)
        VALUES (?, ?, ?, ?)
      `).run(completion.missionId, completion.reportSha256, completion.settlementTxId, completion.acceptedAt);
      createIdempotencyResult(this.database, {
        key: idempotencyKey,
        requestHash,
        statusCode: 202,
        response: { status: "accepted" },
        createdAt: completion.acceptedAt,
      });
      return "accepted";
    });
    try {
      return record.immediate();
    } catch (error) {
      throw conflictCode(error) ?? error;
    }
  }

  // --- repayment -------------------------------------------------------------

  getRepayment(loanId: string): StoredRepayment | undefined {
    const row = this.database.prepare(`
      SELECT loan_id, transaction_id, transaction_base64, valid_until, status, attempts, last_error
      FROM signer_repayments WHERE loan_id = ?
    `).get(loanId) as {
      loan_id: string; transaction_id: string; transaction_base64: string; valid_until: number;
      status: RepaymentStatus; attempts: number; last_error: string | null;
    } | undefined;
    return row === undefined ? undefined : {
      loanId: row.loan_id,
      transactionId: row.transaction_id,
      transactionBase64: row.transaction_base64,
      validUntil: row.valid_until,
      status: row.status,
      attempts: row.attempts,
      lastError: row.last_error,
    };
  }

  /** Persists the stable transaction ID and signed bytes before any submission. */
  saveRepayment(record: Omit<StoredRepayment, "status" | "attempts" | "lastError">, now: string): void {
    this.database.prepare(`
      INSERT INTO signer_repayments (
        loan_id, transaction_id, transaction_base64, valid_until, status, attempts, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
      ON CONFLICT(loan_id) DO UPDATE SET
        transaction_id = excluded.transaction_id,
        transaction_base64 = excluded.transaction_base64,
        valid_until = excluded.valid_until,
        status = 'pending', attempts = 0, last_error = NULL, updated_at = excluded.updated_at
      WHERE signer_repayments.status = 'failed'
    `).run(record.loanId, record.transactionId, record.transactionBase64, record.validUntil, now, now);
  }

  updateRepayment(loanId: string, status: RepaymentStatus, detail: string | null, now: string): void {
    this.database.prepare(`
      UPDATE signer_repayments
      SET status = ?, attempts = attempts + 1, last_error = ?, updated_at = ?
      WHERE loan_id = ?
    `).run(status, detail, now, loanId);
  }

  missionExists(missionId: string): boolean {
    return getMission(this.database, missionId) !== undefined;
  }
}
