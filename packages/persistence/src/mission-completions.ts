import type { Provider } from "@koven/domain";

import type { KovenDatabase } from "./db.js";
import { isUniqueConstraint, PersistenceConflict, PersistenceConflictError } from "./db.js";

export interface PersistedMissionPolicy {
  readonly missionId: string;
  readonly borrowerAccountId: string;
  readonly spendingCapTinybar: bigint;
  readonly sessionId: string;
  readonly sessionCapTinybar: bigint;
  readonly targetSha256: string;
  readonly provider: Provider;
  readonly approvedRecipientsRoot: string;
  readonly createdAt: string;
}

export interface MissionCompletion {
  readonly missionId: string;
  readonly reportSha256: string;
  readonly settlementTxId: string;
  readonly settlementPayerAccountId: string;
  readonly settlementRecipientAccountId: string;
  readonly settlementAsset: string;
  readonly settlementAmountTinybar: bigint;
  readonly settlementConfirmedAt: string;
  readonly callbackBodySha256: string;
  readonly acceptedAt: string;
}

interface PolicyRow {
  mission_id: string;
  borrower_account_id: string;
  spending_cap_tinybar: string;
  session_id: string;
  session_cap_tinybar: string;
  target_sha256: string;
  provider_id: string;
  provider_account_id: string;
  provider_endpoint: string;
  provider_capability: string;
  provider_price_tinybar: string;
  provider_reputation_score: number;
  provider_expected_latency_ms: number;
  approved_recipients_root: string;
  created_at: string;
}

interface CompletionRow {
  mission_id: string;
  report_sha256: string;
  settlement_tx_id: string;
  settlement_payer_account_id: string;
  settlement_recipient_account_id: string;
  settlement_asset: string;
  settlement_amount_tinybar: string;
  settlement_confirmed_at: string;
  callback_body_sha256: string;
  accepted_at: string;
}

const policyFromRow = (row: PolicyRow): PersistedMissionPolicy => ({
  missionId: row.mission_id,
  borrowerAccountId: row.borrower_account_id,
  spendingCapTinybar: BigInt(row.spending_cap_tinybar),
  sessionId: row.session_id,
  sessionCapTinybar: BigInt(row.session_cap_tinybar),
  targetSha256: row.target_sha256,
  provider: {
    id: row.provider_id,
    accountId: row.provider_account_id,
    endpoint: row.provider_endpoint,
    capability: row.provider_capability,
    priceTinybar: BigInt(row.provider_price_tinybar),
    reputationScore: row.provider_reputation_score,
    expectedLatencyMs: row.provider_expected_latency_ms,
  },
  approvedRecipientsRoot: row.approved_recipients_root,
  createdAt: row.created_at,
});

const completionFromRow = (row: CompletionRow): MissionCompletion => ({
  missionId: row.mission_id,
  reportSha256: row.report_sha256,
  settlementTxId: row.settlement_tx_id,
  settlementPayerAccountId: row.settlement_payer_account_id,
  settlementRecipientAccountId: row.settlement_recipient_account_id,
  settlementAsset: row.settlement_asset,
  settlementAmountTinybar: BigInt(row.settlement_amount_tinybar),
  settlementConfirmedAt: row.settlement_confirmed_at,
  callbackBodySha256: row.callback_body_sha256,
  acceptedAt: row.accepted_at,
});

export function getMissionPolicy(database: KovenDatabase, missionId: string): PersistedMissionPolicy | undefined {
  const row = database.prepare(`
    SELECT mission_id, borrower_account_id, spending_cap_tinybar, session_id,
      session_cap_tinybar, target_sha256, provider_id, provider_account_id,
      provider_endpoint, provider_capability, provider_price_tinybar,
      provider_reputation_score, provider_expected_latency_ms,
      approved_recipients_root, created_at
    FROM mission_policies WHERE mission_id = ?
  `).get(missionId) as PolicyRow | undefined;
  return row === undefined ? undefined : policyFromRow(row);
}

export function saveMissionPolicy(
  database: KovenDatabase,
  policy: PersistedMissionPolicy,
): PersistedMissionPolicy {
  try {
    database.prepare(`
      INSERT INTO mission_policies (
        mission_id, borrower_account_id, spending_cap_tinybar, session_id,
        session_cap_tinybar, target_sha256, provider_id, provider_account_id,
        provider_endpoint, provider_capability, provider_price_tinybar,
        provider_reputation_score, provider_expected_latency_ms,
        approved_recipients_root, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      policy.missionId,
      policy.borrowerAccountId,
      policy.spendingCapTinybar.toString(10),
      policy.sessionId,
      policy.sessionCapTinybar.toString(10),
      policy.targetSha256,
      policy.provider.id,
      policy.provider.accountId,
      policy.provider.endpoint,
      policy.provider.capability,
      policy.provider.priceTinybar.toString(10),
      policy.provider.reputationScore,
      policy.provider.expectedLatencyMs,
      policy.approvedRecipientsRoot,
      policy.createdAt,
    );
  } catch (error) {
    if (!isUniqueConstraint(error)) throw error;
    const existing = getMissionPolicy(database, policy.missionId);
    if (existing !== undefined
      && existing.borrowerAccountId === policy.borrowerAccountId
      && existing.spendingCapTinybar === policy.spendingCapTinybar
      && existing.sessionId === policy.sessionId
      && existing.sessionCapTinybar === policy.sessionCapTinybar
      && existing.targetSha256 === policy.targetSha256
      && existing.provider.id === policy.provider.id
      && existing.provider.accountId === policy.provider.accountId
      && existing.provider.endpoint === policy.provider.endpoint
      && existing.provider.capability === policy.provider.capability
      && existing.provider.priceTinybar === policy.provider.priceTinybar
      && existing.provider.reputationScore === policy.provider.reputationScore
      && existing.provider.expectedLatencyMs === policy.provider.expectedLatencyMs
      && existing.approvedRecipientsRoot === policy.approvedRecipientsRoot) return existing;
    throw new PersistenceConflictError(
      PersistenceConflict.MISSION_POLICY_CONFLICT,
      `Mission policy already differs: ${policy.missionId}`,
    );
  }
  return getMissionPolicy(database, policy.missionId)!;
}

export function getMissionCompletion(database: KovenDatabase, missionId: string): MissionCompletion | undefined {
  const row = database.prepare(`
    SELECT mission_id, report_sha256, settlement_tx_id,
      settlement_payer_account_id, settlement_recipient_account_id,
      settlement_asset, settlement_amount_tinybar, settlement_confirmed_at,
      callback_body_sha256, accepted_at
    FROM mission_completions WHERE mission_id = ?
  `).get(missionId) as CompletionRow | undefined;
  return row === undefined ? undefined : completionFromRow(row);
}

export function saveMissionCompletion(database: KovenDatabase, completion: MissionCompletion): MissionCompletion {
  try {
    database.prepare(`
      INSERT INTO mission_completions (
        mission_id, report_sha256, settlement_tx_id,
        settlement_payer_account_id, settlement_recipient_account_id,
        settlement_asset, settlement_amount_tinybar, settlement_confirmed_at,
        callback_body_sha256, accepted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      completion.missionId,
      completion.reportSha256,
      completion.settlementTxId,
      completion.settlementPayerAccountId,
      completion.settlementRecipientAccountId,
      completion.settlementAsset,
      completion.settlementAmountTinybar.toString(10),
      completion.settlementConfirmedAt,
      completion.callbackBodySha256,
      completion.acceptedAt,
    );
  } catch (error) {
    if (!isUniqueConstraint(error)) throw error;
    const existing = getMissionCompletion(database, completion.missionId);
    if (existing !== undefined
      && existing.reportSha256 === completion.reportSha256
      && existing.settlementTxId === completion.settlementTxId
      && existing.settlementPayerAccountId === completion.settlementPayerAccountId
      && existing.settlementRecipientAccountId === completion.settlementRecipientAccountId
      && existing.settlementAsset === completion.settlementAsset
      && existing.settlementAmountTinybar === completion.settlementAmountTinybar
      && existing.settlementConfirmedAt === completion.settlementConfirmedAt
      && existing.callbackBodySha256 === completion.callbackBodySha256) return existing;
    throw new PersistenceConflictError(
      PersistenceConflict.IDEMPOTENCY_CONFLICT,
      `Mission completion already differs: ${completion.missionId}`,
    );
  }
  return completion;
}
