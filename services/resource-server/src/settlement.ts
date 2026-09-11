import { ErrorCode } from "@koven/domain";

export interface SettlementExpectation {
  readonly transactionId: string;
  readonly payerAccountId: string;
  readonly providerAccountId: string;
  readonly amountTinybar: string;
}

export interface ConfirmedSettlement {
  readonly settledAt: string;
}

export interface SettlementConfirmer {
  confirm(expectation: SettlementExpectation): Promise<ConfirmedSettlement>;
}

export class SettlementConfirmationError extends Error {
  constructor(
    readonly code: typeof ErrorCode.SETTLEMENT_UNCONFIRMED | typeof ErrorCode.PAYMENT_AUTHORIZATION_MISMATCH,
    readonly status: 403 | 503,
    detail: string,
  ) {
    super(detail);
    this.name = "SettlementConfirmationError";
  }
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new SettlementConfirmationError(ErrorCode.SETTLEMENT_UNCONFIRMED, 503, "Mirror response is unavailable");
  }
  return value as Record<string, unknown>;
}

function mirrorTransactionId(transactionId: string): string {
  const match = /^(\d+\.\d+\.\d+)@(0|[1-9]\d*)\.(\d{9})$/.exec(transactionId);
  if (!match) throw new SettlementConfirmationError(ErrorCode.PAYMENT_AUTHORIZATION_MISMATCH, 403, "Transaction ID is invalid");
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function consensusTimestamp(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)\.\d{9}$/.test(value)) {
    throw new SettlementConfirmationError(ErrorCode.SETTLEMENT_UNCONFIRMED, 503, "Settlement timestamp is unavailable");
  }
  const [secondsText, nanosText] = value.split(".") as [string, string];
  const milliseconds = (BigInt(secondsText) * 1000n) + (BigInt(nanosText) / 1_000_000n);
  if (milliseconds > BigInt(8_640_000_000_000_000)) {
    throw new SettlementConfirmationError(ErrorCode.SETTLEMENT_UNCONFIRMED, 503, "Settlement timestamp is invalid");
  }
  return new Date(Number(milliseconds)).toISOString();
}

export interface MirrorSettlementConfirmerOptions {
  readonly mirrorNodeUrl: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

export class MirrorSettlementConfirmer implements SettlementConfirmer {
  private readonly baseUrl: URL;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: MirrorSettlementConfirmerOptions) {
    this.baseUrl = new URL(options.mirrorNodeUrl);
    const loopback = this.baseUrl.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(this.baseUrl.hostname);
    if (
      (this.baseUrl.protocol !== "https:" && !loopback)
      || this.baseUrl.username
      || this.baseUrl.password
      || this.baseUrl.search
      || this.baseUrl.hash
      || this.baseUrl.pathname !== "/"
    ) throw new Error("Mirror URL must be an HTTPS origin or loopback HTTP origin");
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new Error("Mirror timeout must be between 1 and 60000 ms");
    }
  }

  async confirm(expectation: SettlementExpectation): Promise<ConfirmedSettlement> {
    const id = mirrorTransactionId(expectation.transactionId);
    const url = new URL(`/api/v1/transactions/${id}`, this.baseUrl);
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
    } catch {
      throw new SettlementConfirmationError(ErrorCode.SETTLEMENT_UNCONFIRMED, 503, "Settlement is not yet visible");
    }
    if (!response.ok) {
      throw new SettlementConfirmationError(ErrorCode.SETTLEMENT_UNCONFIRMED, 503, "Settlement is not yet visible");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new SettlementConfirmationError(ErrorCode.SETTLEMENT_UNCONFIRMED, 503, "Mirror response is unavailable");
    }
    const transactions = object(body).transactions;
    if (!Array.isArray(transactions)) {
      throw new SettlementConfirmationError(ErrorCode.SETTLEMENT_UNCONFIRMED, 503, "Settlement is not yet visible");
    }
    const matching = transactions.map(object).filter(row =>
      row.transaction_id === id
      && row.result === "SUCCESS"
      && row.name === "CRYPTOTRANSFER"
      && row.nonce === 0
      && row.scheduled === false
    );
    if (matching.length !== 1) {
      throw new SettlementConfirmationError(ErrorCode.SETTLEMENT_UNCONFIRMED, 503, "Settlement is not yet visible");
    }

    const transaction = matching[0]!;
    if (
      !Array.isArray(transaction.transfers)
      || !Array.isArray(transaction.token_transfers)
      || transaction.token_transfers.length !== 0
      || !Array.isArray(transaction.nft_transfers)
      || transaction.nft_transfers.length !== 0
    ) {
      throw new SettlementConfirmationError(ErrorCode.PAYMENT_AUTHORIZATION_MISMATCH, 403, "Settlement transfer shape does not match HBAR");
    }

    const net = new Map<string, bigint>();
    for (const value of transaction.transfers) {
      const transfer = object(value);
      if (
        typeof transfer.account !== "string"
        || typeof transfer.amount !== "number"
        || !Number.isSafeInteger(transfer.amount)
        || transfer.is_approval !== false
      ) throw new SettlementConfirmationError(ErrorCode.PAYMENT_AUTHORIZATION_MISMATCH, 403, "Settlement contains an invalid transfer");
      net.set(transfer.account, (net.get(transfer.account) ?? 0n) + BigInt(transfer.amount));
    }

    const feePayer = expectation.transactionId.split("@")[0]!;
    const expectedAmount = BigInt(expectation.amountTinybar);
    const total = [...net.values()].reduce((sum, amount) => sum + amount, 0n);
    if (
      net.get(expectation.payerAccountId) !== -expectedAmount
      || net.get(expectation.providerAccountId) !== expectedAmount
      || total !== 0n
      || [...net].some(([accountId, amount]) => amount < 0n
        && accountId !== expectation.payerAccountId
        && accountId !== feePayer)
    ) throw new SettlementConfirmationError(ErrorCode.PAYMENT_AUTHORIZATION_MISMATCH, 403, "Settlement does not match the authorized payment");

    return { settledAt: consensusTimestamp(transaction.consensus_timestamp) };
  }
}
