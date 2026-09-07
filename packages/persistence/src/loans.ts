import type { Loan, LoanState } from "@koven/domain";

import type { KovenDatabase } from "./db.js";
import { tinybarFromText, tinybarToText } from "./db.js";

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
  state: LoanState,
  transactionIds: { fundingTxId?: string; repaymentTxId?: string } = {},
): boolean {
  const result = database.prepare(`
    UPDATE loans
    SET state = @state,
        funding_tx_id = COALESCE(@fundingTxId, funding_tx_id),
        repayment_tx_id = COALESCE(@repaymentTxId, repayment_tx_id)
    WHERE id = @id
  `).run({
    id,
    state,
    fundingTxId: transactionIds.fundingTxId ?? null,
    repaymentTxId: transactionIds.repaymentTxId ?? null,
  });
  return result.changes === 1;
}
