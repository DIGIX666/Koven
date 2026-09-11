import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";
import { validatePaymentPayload } from "@x402/core/schemas";
import type { PaymentPayload, SettleResponse } from "@x402/core/types";
import { ErrorCode, type ScanReport } from "@koven/domain";
import { PaidScanRequestSchema, ScanReportSchema } from "@koven/schemas";

import type { PaidScanRequest, ValidatedPaymentAttempt } from "./authorization.js";
import { canonicalJson, sha256Hex } from "./report.js";

const PAYMENT_LEASE_MS = 30_000;
const VERIFIED_PAYMENT_LEASE_MS = 300_000;
const CALLBACK_LEASE_MS = 30_000;
/**
 * Mirror Node lag tolerated after a transaction's valid window before a
 * settlement the facilitator never confirmed is recorded as failed.
 */
export const SETTLEMENT_FAILURE_GRACE_MS = 600_000;

export class ProviderStoreError extends Error {
  constructor(
    readonly code: typeof ErrorCode.IDEMPOTENCY_CONFLICT
      | typeof ErrorCode.INTERNAL_ERROR
      | typeof ErrorCode.SETTLEMENT_UNCONFIRMED,
    readonly status: 409 | 500 | 503,
    detail: string,
  ) {
    super(detail);
    this.name = "ProviderStoreError";
  }
}

export interface StoredPayment {
  readonly network: "hedera:testnet";
  readonly transactionId: string;
  readonly fingerprint: string;
  readonly request: PaidScanRequest;
  readonly paymentPayload: PaymentPayload;
  readonly status: "claimed" | "report_ready" | "settled" | "completed" | "settlement_failed";
  readonly settlementAttempted: boolean;
  readonly report: ScanReport | null;
  readonly settlement: SettleResponse | null;
  readonly responseHeaders: Readonly<Record<string, string>>;
  readonly leaseToken: string | null;
  readonly leaseUntil: number | null;
  /** Unix milliseconds after which the Hedera transaction can no longer reach consensus. */
  readonly validUntil: number;
  readonly lastError: string | null;
}

export interface PaymentClaim {
  readonly owned: boolean;
  readonly token: string | null;
  readonly payment: StoredPayment;
}

export interface CallbackJob {
  readonly idempotencyKey: string;
  readonly body: string;
  readonly attempts: number;
  readonly token: string;
}

interface PaymentRow {
  network: string;
  transaction_id: string;
  fingerprint: string;
  request_json: string;
  payment_payload_json: string;
  status: StoredPayment["status"];
  settlement_attempted: number;
  report_json: string | null;
  settlement_json: string | null;
  response_headers_json: string | null;
  lease_token: string | null;
  lease_until: number | null;
  valid_until: number;
  last_error: string | null;
}

interface CallbackRow {
  idempotency_key: string;
  body: string;
  attempts: number;
  lease_token: string;
}

function parseObjectJson(value: string | null): Record<string, string> {
  if (value === null) return {};
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProviderStoreError(ErrorCode.INTERNAL_ERROR, 500, "Stored response headers are invalid");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.some(([, entry]) => typeof entry !== "string")) {
    throw new ProviderStoreError(ErrorCode.INTERNAL_ERROR, 500, "Stored response headers are invalid");
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function parsePaymentRow(row: PaymentRow): StoredPayment {
  const request = PaidScanRequestSchema.parse(JSON.parse(row.request_json));
  const paymentPayload = validatePaymentPayload(JSON.parse(row.payment_payload_json)) as PaymentPayload;
  const report = row.report_json === null ? null : ScanReportSchema.parse(JSON.parse(row.report_json));
  const settlement = row.settlement_json === null ? null : JSON.parse(row.settlement_json) as SettleResponse;
  return {
    network: "hedera:testnet",
    transactionId: row.transaction_id,
    fingerprint: row.fingerprint,
    request,
    paymentPayload,
    status: row.status,
    settlementAttempted: row.settlement_attempted === 1,
    report,
    settlement,
    responseHeaders: parseObjectJson(row.response_headers_json),
    leaseToken: row.lease_token,
    leaseUntil: row.lease_until,
    validUntil: row.valid_until,
    lastError: row.last_error,
  };
}

const PAYMENT_COLUMNS = `network, transaction_id, fingerprint, request_json, payment_payload_json,
        status, settlement_attempted, report_json, settlement_json,
        response_headers_json, lease_token, lease_until, valid_until, last_error`;

export class ProviderStore {
  readonly database: Database.Database;

  constructor(filename: string) {
    this.database = new Database(filename);
    this.database.pragma("foreign_keys = ON");
    this.database.pragma("busy_timeout = 5000");
    this.database.pragma("journal_mode = WAL");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS provider_paid_scans (
        network TEXT NOT NULL,
        transaction_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        request_json TEXT NOT NULL,
        payment_payload_json TEXT NOT NULL,
        status TEXT NOT NULL
          CHECK (status IN ('claimed', 'report_ready', 'settled', 'completed', 'settlement_failed')),
        settlement_attempted INTEGER NOT NULL DEFAULT 0 CHECK (settlement_attempted IN (0, 1)),
        report_json TEXT,
        settlement_json TEXT,
        response_headers_json TEXT,
        lease_token TEXT,
        lease_until INTEGER,
        valid_until INTEGER NOT NULL,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (network, transaction_id)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS provider_callback_jobs (
        idempotency_key TEXT PRIMARY KEY,
        network TEXT NOT NULL,
        transaction_id TEXT NOT NULL,
        body TEXT NOT NULL,
        body_sha256 TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'delivered', 'failed', 'repair')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        lease_token TEXT,
        lease_until INTEGER,
        last_error TEXT,
        delivered_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (network, transaction_id)
          REFERENCES provider_paid_scans(network, transaction_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS provider_callback_due_idx
        ON provider_callback_jobs (status, next_attempt_at);
    `);
  }

  close(): void {
    this.database.close();
  }

  private payment(transactionId: string): StoredPayment | null {
    const row = this.database.prepare(`
      SELECT ${PAYMENT_COLUMNS}
      FROM provider_paid_scans
      WHERE network = 'hedera:testnet' AND transaction_id = ?
    `).get(transactionId) as PaymentRow | undefined;
    return row ? parsePaymentRow(row) : null;
  }

  getPayment(transactionId: string): StoredPayment | null {
    return this.payment(transactionId);
  }

  pendingSettlements(limit = 10): StoredPayment[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ProviderStoreError(ErrorCode.INTERNAL_ERROR, 500, "Settlement batch limit must be 1-100");
    }
    const rows = this.database.prepare(`
      SELECT ${PAYMENT_COLUMNS}
      FROM provider_paid_scans
      WHERE network = 'hedera:testnet' AND settlement_attempted = 1
        AND status NOT IN ('completed', 'settlement_failed') AND report_json IS NOT NULL
      ORDER BY updated_at, transaction_id
      LIMIT ?
    `).all(limit) as PaymentRow[];
    return rows.map(parsePaymentRow);
  }

  claimPayment(attempt: ValidatedPaymentAttempt, now = Date.now()): PaymentClaim {
    const token = randomUUID();
    const transactionId = attempt.authorization.transactionId;
    const claim = this.database.transaction((): PaymentClaim => {
      this.database.prepare(`
        INSERT OR IGNORE INTO provider_paid_scans (
          network, transaction_id, fingerprint, request_json, payment_payload_json,
          status, lease_token, lease_until, valid_until, created_at, updated_at
        ) VALUES ('hedera:testnet', ?, ?, ?, ?, 'claimed', ?, ?, ?, ?, ?)
      `).run(
        transactionId,
        attempt.fingerprint,
        canonicalJson(attempt.request),
        canonicalJson(attempt.paymentPayload),
        token,
        now + PAYMENT_LEASE_MS,
        attempt.transactionValidUntil,
        now,
        now,
      );

      let payment = this.payment(transactionId);
      if (!payment) throw new ProviderStoreError(ErrorCode.INTERNAL_ERROR, 500, "Payment claim was not persisted");
      if (payment.fingerprint !== attempt.fingerprint) {
        throw new ProviderStoreError(ErrorCode.IDEMPOTENCY_CONFLICT, 409, "Transaction is already bound to another scan");
      }

      if (
        payment.leaseToken !== token
        && !payment.settlementAttempted
        && payment.status !== "completed"
        && (payment.leaseUntil ?? 0) <= now
      ) {
        this.database.prepare(`
          UPDATE provider_paid_scans
          SET lease_token = ?, lease_until = ?, updated_at = ?
          WHERE network = 'hedera:testnet' AND transaction_id = ?
            AND settlement_attempted = 0 AND status != 'completed'
            AND COALESCE(lease_until, 0) <= ?
        `).run(token, now + PAYMENT_LEASE_MS, now, transactionId, now);
        payment = this.payment(transactionId)!;
      }

      const owned = payment.leaseToken === token;
      return { owned, token: owned ? token : null, payment };
    });
    return claim.immediate();
  }

  saveReport(transactionId: string, token: string, report: ScanReport, now = Date.now()): void {
    const reportJson = canonicalJson(ScanReportSchema.parse(report));
    const existing = this.payment(transactionId);
    if (!existing || existing.leaseToken !== token || existing.settlementAttempted) {
      throw new ProviderStoreError(ErrorCode.INTERNAL_ERROR, 500, "Payment processing lease is not held");
    }
    if (existing.report && canonicalJson(existing.report) !== reportJson) {
      throw new ProviderStoreError(ErrorCode.IDEMPOTENCY_CONFLICT, 409, "Payment already has a different report");
    }
    this.database.prepare(`
      UPDATE provider_paid_scans
      SET report_json = ?, status = 'report_ready', updated_at = ?
      WHERE network = 'hedera:testnet' AND transaction_id = ? AND lease_token = ?
    `).run(reportJson, now, transactionId, token);
  }

  renewVerifiedPaymentLease(transactionId: string, token: string, now = Date.now()): void {
    const result = this.database.prepare(`
      UPDATE provider_paid_scans
      SET lease_until = ?, updated_at = ?
      WHERE network = 'hedera:testnet' AND transaction_id = ? AND lease_token = ?
        AND settlement_attempted = 0 AND status IN ('claimed', 'report_ready')
    `).run(now + VERIFIED_PAYMENT_LEASE_MS, now, transactionId, token);
    if (result.changes !== 1) {
      throw new ProviderStoreError(
        ErrorCode.SETTLEMENT_UNCONFIRMED,
        503,
        "Payment processing was taken over by another request",
      );
    }
  }

  markSettlementAttempted(transactionId: string, token: string, now = Date.now()): void {
    const result = this.database.prepare(`
      UPDATE provider_paid_scans
      SET settlement_attempted = 1, lease_token = NULL, lease_until = NULL, updated_at = ?
      WHERE network = 'hedera:testnet' AND transaction_id = ? AND lease_token = ?
        AND report_json IS NOT NULL AND settlement_attempted = 0
    `).run(now, transactionId, token);
    if (result.changes !== 1) {
      throw new ProviderStoreError(ErrorCode.INTERNAL_ERROR, 500, "Settlement attempt was not durably recorded");
    }
  }

  saveSettlement(
    transactionId: string,
    settlement: SettleResponse,
    responseHeaders: Readonly<Record<string, string>>,
    now = Date.now(),
  ): void {
    const existing = this.payment(transactionId);
    const settlementJson = canonicalJson(settlement);
    if (!existing || !existing.settlementAttempted || !existing.report) {
      throw new ProviderStoreError(ErrorCode.INTERNAL_ERROR, 500, "Settlement has no prepared scan");
    }
    if (
      !settlement.success
      || settlement.transaction !== transactionId
      || settlement.network !== existing.network
      || settlement.payer !== existing.request.paymentAuthorization.borrowerAccountId
      || (settlement.amount !== undefined
        && settlement.amount !== existing.request.paymentAuthorization.amountTinybar)
    ) throw new ProviderStoreError(ErrorCode.INTERNAL_ERROR, 500, "Settlement evidence is invalid");
    if (existing.settlement && canonicalJson(existing.settlement) !== settlementJson) {
      throw new ProviderStoreError(ErrorCode.IDEMPOTENCY_CONFLICT, 409, "Settlement result conflicts with stored evidence");
    }
    this.database.prepare(`
      UPDATE provider_paid_scans
      SET settlement_json = ?, response_headers_json = ?, status = 'settled', updated_at = ?
      WHERE network = 'hedera:testnet' AND transaction_id = ?
    `).run(settlementJson, canonicalJson(responseHeaders), now, transactionId);
  }

  /**
   * Records a reconciliation attempt that did not complete the payment. Bumping
   * `updated_at` rotates the row to the back of the pending queue so a stuck
   * payment cannot starve newer ones. When the ledger showed nothing
   * (`unconfirmed`), a payment the facilitator never confirmed becomes
   * terminally failed once its transaction can no longer reach consensus and
   * the Mirror grace period has elapsed.
   */
  recordUnconfirmedSettlement(
    transactionId: string,
    detail: string,
    now = Date.now(),
    options: { readonly unconfirmed?: boolean } = {},
  ): StoredPayment {
    const outcome = this.database.transaction((): StoredPayment => {
      const existing = this.payment(transactionId);
      if (!existing || !existing.settlementAttempted || !existing.report) {
        throw new ProviderStoreError(ErrorCode.INTERNAL_ERROR, 500, "Settlement has no prepared scan");
      }
      if (existing.status === "completed" || existing.status === "settlement_failed") return existing;
      const failed = options.unconfirmed !== false
        && existing.settlement === null
        && now > existing.validUntil + SETTLEMENT_FAILURE_GRACE_MS;
      this.database.prepare(`
        UPDATE provider_paid_scans
        SET status = CASE WHEN ? THEN 'settlement_failed' ELSE status END,
          last_error = ?, updated_at = ?
        WHERE network = 'hedera:testnet' AND transaction_id = ?
          AND status NOT IN ('completed', 'settlement_failed')
      `).run(failed ? 1 : 0, detail.slice(0, 1024), now, transactionId);
      return this.payment(transactionId)!;
    });
    return outcome.immediate();
  }

  completeAndEnqueue(
    transactionId: string,
    callback: { idempotencyKey: string; body: string },
    now = Date.now(),
  ): void {
    const complete = this.database.transaction(() => {
      const payment = this.payment(transactionId);
      if (!payment?.report || !payment.settlement || !["settled", "completed"].includes(payment.status)) {
        throw new ProviderStoreError(ErrorCode.INTERNAL_ERROR, 500, "Cannot complete an unprepared payment");
      }
      if (payment.status === "settled") {
        const updated = this.database.prepare(`
          UPDATE provider_paid_scans
          SET status = 'completed', lease_token = NULL, lease_until = NULL, updated_at = ?
          WHERE network = 'hedera:testnet' AND transaction_id = ? AND status = 'settled'
        `).run(now, transactionId);
        if (updated.changes !== 1) {
          throw new ProviderStoreError(ErrorCode.INTERNAL_ERROR, 500, "Payment completion state changed unexpectedly");
        }
      }

      const bodySha256 = sha256Hex(callback.body);
      this.database.prepare(`
        INSERT OR IGNORE INTO provider_callback_jobs (
          idempotency_key, network, transaction_id, body, body_sha256, status,
          attempts, next_attempt_at, created_at, updated_at
        ) VALUES (?, 'hedera:testnet', ?, ?, ?, 'pending', 0, ?, ?, ?)
      `).run(callback.idempotencyKey, transactionId, callback.body, bodySha256, now, now, now);
      const stored = this.database.prepare(`
        SELECT body_sha256 FROM provider_callback_jobs WHERE idempotency_key = ?
      `).get(callback.idempotencyKey) as { body_sha256: string } | undefined;
      if (!stored || stored.body_sha256 !== bodySha256) {
        throw new ProviderStoreError(ErrorCode.IDEMPOTENCY_CONFLICT, 409, "Callback key is bound to different content");
      }
    });
    complete.immediate();
  }

  claimDueCallback(now = Date.now()): CallbackJob | null {
    const token = randomUUID();
    const take = this.database.transaction((): CallbackJob | null => {
      const row = this.database.prepare(`
        SELECT idempotency_key
        FROM provider_callback_jobs
        WHERE (status = 'pending' AND next_attempt_at <= ?)
           OR (status = 'processing' AND COALESCE(lease_until, 0) <= ?)
        ORDER BY next_attempt_at, created_at
        LIMIT 1
      `).get(now, now) as { idempotency_key: string } | undefined;
      if (!row) return null;
      const result = this.database.prepare(`
        UPDATE provider_callback_jobs
        SET status = 'processing', lease_token = ?, lease_until = ?, updated_at = ?
        WHERE idempotency_key = ?
          AND ((status = 'pending' AND next_attempt_at <= ?)
            OR (status = 'processing' AND COALESCE(lease_until, 0) <= ?))
      `).run(token, now + CALLBACK_LEASE_MS, now, row.idempotency_key, now, now);
      if (result.changes !== 1) return null;
      const claimed = this.database.prepare(`
        SELECT idempotency_key, body, attempts, lease_token
        FROM provider_callback_jobs WHERE idempotency_key = ?
      `).get(row.idempotency_key) as CallbackRow;
      return {
        idempotencyKey: claimed.idempotency_key,
        body: claimed.body,
        attempts: claimed.attempts,
        token: claimed.lease_token,
      };
    });
    return take.immediate();
  }

  markCallbackDelivered(job: CallbackJob, now = Date.now()): void {
    this.finishCallback(job, "delivered", null, null, now);
  }

  markCallbackForRepair(job: CallbackJob, detail: string, now = Date.now()): void {
    this.finishCallback(job, "repair", null, detail, now);
  }

  retryCallback(job: CallbackJob, nextAttemptAt: number, detail: string, now = Date.now()): void {
    const attempts = job.attempts + 1;
    const status = attempts >= 20 ? "failed" : "pending";
    this.finishCallback(job, status, status === "pending" ? nextAttemptAt : null, detail, now, attempts);
  }

  replayCallback(idempotencyKey: string, now = Date.now()): boolean {
    const result = this.database.prepare(`
      UPDATE provider_callback_jobs
      SET status = 'pending', attempts = 0, next_attempt_at = ?, lease_token = NULL,
        lease_until = NULL, last_error = NULL, updated_at = ?
      WHERE idempotency_key = ? AND status IN ('failed', 'repair')
    `).run(now, now, idempotencyKey);
    return result.changes === 1;
  }

  nextCallbackAt(): number | null {
    const row = this.database.prepare(`
      SELECT MIN(CASE
        WHEN status = 'pending' THEN next_attempt_at
        WHEN status = 'processing' THEN COALESCE(lease_until, 0)
      END) AS next_at
      FROM provider_callback_jobs
      WHERE status IN ('pending', 'processing')
    `).get() as { next_at: number | null };
    return row.next_at;
  }

  private finishCallback(
    job: CallbackJob,
    status: "pending" | "delivered" | "failed" | "repair",
    nextAttemptAt: number | null,
    detail: string | null,
    now: number,
    attempts = job.attempts + 1,
  ): void {
    const result = this.database.prepare(`
      UPDATE provider_callback_jobs
      SET status = ?, attempts = ?, next_attempt_at = COALESCE(?, next_attempt_at),
        lease_token = NULL, lease_until = NULL, last_error = ?,
        delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
        updated_at = ?
      WHERE idempotency_key = ? AND status = 'processing' AND lease_token = ?
    `).run(status, attempts, nextAttemptAt, detail, status, now, now, job.idempotencyKey, job.token);
    if (result.changes !== 1) {
      throw new ProviderStoreError(ErrorCode.INTERNAL_ERROR, 500, "Callback processing lease was lost");
    }
  }
}
