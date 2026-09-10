import type { Loan, LoanState } from "@koven/domain";

import type { KovenDatabase } from "./db.js";
import {
  isUniqueConstraint,
  PersistenceConflict,
  PersistenceConflictError,
  tinybarFromText,
  tinybarToText,
} from "./db.js";

interface LoanRow {
  id: string;
  offer_id: string;
  mission_id: string;
  lender_account_id: string;
  principal_tinybar: string;
  fee_tinybar: string;
  state: LoanState;
  funding_tx_id: string | null;
  repayment_tx_id: string | null;
}

export function createLoan(database: KovenDatabase, loan: Loan): void {
  try {
    database.prepare(`
      INSERT INTO loans (
        id, offer_id, mission_id, lender_account_id,
        principal_tinybar, fee_tinybar, state, funding_tx_id, repayment_tx_id
      ) VALUES (
        @id, @offerId, @missionId, @lenderAccountId,
        @principalTinybar, @feeTinybar, @state, @fundingTxId, @repaymentTxId
      )
    `).run({
      id: loan.id,
      offerId: loan.offerId,
      missionId: loan.missionId,
      lenderAccountId: loan.lenderAccountId,
      principalTinybar: tinybarToText(loan.principalTinybar),
      feeTinybar: tinybarToText(loan.feeTinybar),
      state: loan.state,
      fundingTxId: loan.fundingTxId ?? null,
      repaymentTxId: loan.repaymentTxId ?? null,
    });
  } catch (error) {
    if (!isUniqueConstraint(error)) throw error;
    throw new PersistenceConflictError(
      PersistenceConflict.LOAN_REGISTRATION_CONFLICT,
      `Loan already exists: ${loan.id}`,
    );
  }
}

export function getLoan(database: KovenDatabase, id: string): Loan | undefined {
  const row = database.prepare(`
    SELECT id, offer_id, mission_id, lender_account_id,
           principal_tinybar, fee_tinybar, state, funding_tx_id, repayment_tx_id
    FROM loans
    WHERE id = ?
  `).get(id) as LoanRow | undefined;

  if (row === undefined) return undefined;
  const loan: Loan = {
    id: row.id,
    offerId: row.offer_id,
    missionId: row.mission_id,
    lenderAccountId: row.lender_account_id,
    principalTinybar: tinybarFromText(row.principal_tinybar),
    feeTinybar: tinybarFromText(row.fee_tinybar),
    state: row.state,
  };
  if (row.funding_tx_id !== null) loan.fundingTxId = row.funding_tx_id;
  if (row.repayment_tx_id !== null) loan.repaymentTxId = row.repayment_tx_id;
  return loan;
}

export function updateLoanState(
  database: KovenDatabase,
  id: string,
  from: LoanState,
  to: LoanState,
  transactionIds: { fundingTxId?: string; repaymentTxId?: string } = {},
): boolean {
  const result = database.prepare(`
    UPDATE loans
    SET state = @to,
        funding_tx_id = COALESCE(@fundingTxId, funding_tx_id),
        repayment_tx_id = COALESCE(@repaymentTxId, repayment_tx_id)
    WHERE id = @id AND state = @from
      AND (@fundingTxId IS NULL OR funding_tx_id IS NULL OR funding_tx_id = @fundingTxId)
      AND (@repaymentTxId IS NULL OR repayment_tx_id IS NULL OR repayment_tx_id = @repaymentTxId)
  `).run({
    id,
    from,
    to,
    fundingTxId: transactionIds.fundingTxId ?? null,
    repaymentTxId: transactionIds.repaymentTxId ?? null,
  });
  if (result.changes === 1) return true;

  const current = database.prepare(`
    SELECT state, funding_tx_id, repayment_tx_id FROM loans WHERE id = ?
  `).get(id) as Pick<LoanRow, "state" | "funding_tx_id" | "repayment_tx_id"> | undefined;
  if (current === undefined || current.state !== from) return false;
  if (transactionIds.fundingTxId !== undefined
    && current.funding_tx_id !== null
    && current.funding_tx_id !== transactionIds.fundingTxId) {
    throw new PersistenceConflictError(
      PersistenceConflict.LOAN_REGISTRATION_CONFLICT,
      `Loan ${id} already has a different funding transaction`,
    );
  }
  if (transactionIds.repaymentTxId !== undefined
    && current.repayment_tx_id !== null
    && current.repayment_tx_id !== transactionIds.repaymentTxId) {
    throw new PersistenceConflictError(
      PersistenceConflict.REPAYMENT_TRANSACTION_CONFLICT,
      `Loan ${id} already has a different repayment transaction`,
    );
  }
  return false;
}
