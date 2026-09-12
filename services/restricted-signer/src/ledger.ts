import { ErrorCode } from "@koven/domain";

import { fail } from "./errors.js";

export interface TransferExpectation {
  readonly transactionId: string;
  readonly payerAccountId: string;
  readonly recipientAccountId: string;
  readonly amountTinybar: bigint;
}

export interface ConfirmedTransfer {
  /** Consensus timestamp as RFC3339 UTC. */
  readonly settledAt: string;
}

/** Independent ledger observation; never satisfied by a counterparty's claim alone. */
export interface TransferConfirmer {
  /** Resolves when the transfer reached consensus with exactly the expected parties and amount. */
  confirm(expectation: TransferExpectation): Promise<ConfirmedTransfer>;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(ErrorCode.SETTLEMENT_UNCONFIRMED, "Mirror response is unavailable");
  }
  return value as Record<string, unknown>;
}

function mirrorTransactionId(transactionId: string): string {
  const match = /^(\d+\.\d+\.\d+)@(0|[1-9]\d*)\.(\d{9})$/.exec(transactionId);
  if (!match) fail(ErrorCode.FUNDING_MISMATCH, "Transaction ID is invalid");
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function consensusTimestamp(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.\d{9}$/.test(value)) {
    fail(ErrorCode.SETTLEMENT_UNCONFIRMED, "Settlement timestamp is unavailable");
  }
  const [seconds, nanos] = value.split(".") as [string, string];
  return new Date(Number((BigInt(seconds) * 1000n) + (BigInt(nanos) / 1_000_000n))).toISOString();
}

export interface MirrorTransferConfirmerOptions {
  readonly mirrorNodeUrl: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Confirms an HBAR transfer through a trusted Mirror Node: SUCCESS
 * CRYPTOTRANSFER, exact net debit of the payer and credit of the recipient,
 * no other debited account except the transaction's fee payer. A transfer not
 * yet visible is `settlement_unconfirmed` (retryable); a visible transfer
 * with different parties or amount is `funding_mismatch`.
 */
export class MirrorTransferConfirmer implements TransferConfirmer {
  private readonly baseUrl: URL;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: MirrorTransferConfirmerOptions) {
    this.baseUrl = new URL(options.mirrorNodeUrl);
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new RangeError("Mirror timeout must be between 1 and 60000 ms");
    }
  }

  async confirm(expectation: TransferExpectation): Promise<ConfirmedTransfer> {
    const id = mirrorTransactionId(expectation.transactionId);
    let response: Response;
    try {
      response = await this.fetchImplementation(new URL(`/api/v1/transactions/${id}`, this.baseUrl), {
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch {
      fail(ErrorCode.SETTLEMENT_UNCONFIRMED, "Transfer is not yet visible");
    }
    if (!response.ok) fail(ErrorCode.SETTLEMENT_UNCONFIRMED, "Transfer is not yet visible");
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      fail(ErrorCode.SETTLEMENT_UNCONFIRMED, "Mirror response is unavailable");
    }
    const rows = object(body).transactions;
    if (!Array.isArray(rows)) fail(ErrorCode.SETTLEMENT_UNCONFIRMED, "Transfer is not yet visible");
    const matching = rows.map(object).filter(row => (
      row.transaction_id === id && row.result === "SUCCESS" && row.name === "CRYPTOTRANSFER"
      && row.nonce === 0 && row.scheduled === false
    ));
    if (matching.length !== 1) fail(ErrorCode.SETTLEMENT_UNCONFIRMED, "Transfer is not yet visible");
    const transaction = matching[0]!;
    if (
      !Array.isArray(transaction.transfers)
      || !Array.isArray(transaction.token_transfers) || transaction.token_transfers.length !== 0
      || !Array.isArray(transaction.nft_transfers) || transaction.nft_transfers.length !== 0
    ) fail(ErrorCode.FUNDING_MISMATCH, "Transfer is not a plain HBAR transfer");

    const net = new Map<string, bigint>();
    for (const value of transaction.transfers) {
      const transfer = object(value);
      if (
        typeof transfer.account !== "string" || typeof transfer.amount !== "number"
        || !Number.isSafeInteger(transfer.amount) || transfer.is_approval !== false
      ) fail(ErrorCode.FUNDING_MISMATCH, "Transfer contains an invalid entry");
      net.set(transfer.account, (net.get(transfer.account) ?? 0n) + BigInt(transfer.amount));
    }
    const feePayer = expectation.transactionId.split("@")[0]!;
    const payerNet = net.get(expectation.payerAccountId) ?? 0n;
    const payerDebit = expectation.payerAccountId === feePayer ? payerNet <= -expectation.amountTinybar : payerNet === -expectation.amountTinybar;
    if (
      !payerDebit
      || net.get(expectation.recipientAccountId) !== expectation.amountTinybar
      || [...net].some(([account, amount]) => amount < 0n && account !== expectation.payerAccountId && account !== feePayer)
    ) fail(ErrorCode.FUNDING_MISMATCH, "Transfer does not match the expected payer, recipient and amount");

    return { settledAt: consensusTimestamp(transaction.consensus_timestamp) };
  }
}
