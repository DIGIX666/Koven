import type { HederaAdapter, HederaTransferResult, TransferHbarRequest } from "@koven/hedera";

export type FakeHederaOperation = "getBalance" | "transfer";

export interface FakeHederaAdapterOptions {
  balances?: Readonly<Record<string, bigint>>;
  transactionPayer?: string;
}

export class FakeHederaAdapter implements HederaAdapter {
  readonly transfers: TransferHbarRequest[] = [];
  private readonly balances = new Map<string, bigint>();
  private readonly failures = new Map<FakeHederaOperation, Error[]>();
  private sequence = 0;
  private readonly transactionPayer: string;

  constructor(options: FakeHederaAdapterOptions = {}) {
    for (const [accountId, balance] of Object.entries(options.balances ?? {})) {
      this.balances.set(accountId, balance);
    }
    this.transactionPayer = options.transactionPayer ?? "0.0.999";
  }

  /** Queues one deterministic failure without changing subsequent calls. */
  failNext(operation: FakeHederaOperation, error = new Error(`Injected ${operation} failure`)): void {
    const queued = this.failures.get(operation) ?? [];
    queued.push(error);
    this.failures.set(operation, queued);
  }

  setBalance(accountId: string, balanceTinybar: bigint): void {
    if (balanceTinybar < 0n) throw new RangeError("Balance cannot be negative");
    this.balances.set(accountId, balanceTinybar);
  }

  async getBalanceTinybar(accountId: string): Promise<bigint> {
    this.throwQueuedFailure("getBalance");
    return this.balances.get(accountId) ?? 0n;
  }

  async transferHbar(request: TransferHbarRequest): Promise<HederaTransferResult> {
    this.throwQueuedFailure("transfer");
    if (request.amountTinybar <= 0n) throw new RangeError("Transfer amount must be positive");
    if (request.from === request.to) throw new Error("Transfer accounts must be distinct");

    const sourceBalance = this.balances.get(request.from) ?? 0n;
    if (sourceBalance < request.amountTinybar) throw new Error("Insufficient fake balance");

    this.balances.set(request.from, sourceBalance - request.amountTinybar);
    this.balances.set(request.to, (this.balances.get(request.to) ?? 0n) + request.amountTinybar);
    this.transfers.push({ ...request });
    this.sequence += 1;
    return {
      transactionId: `${this.transactionPayer}@${this.sequence}.000000000`,
      status: "SUCCESS",
    };
  }

  private throwQueuedFailure(operation: FakeHederaOperation): void {
    const queued = this.failures.get(operation);
    const error = queued?.shift();
    if (queued?.length === 0) this.failures.delete(operation);
    if (error !== undefined) throw error;
  }
}
