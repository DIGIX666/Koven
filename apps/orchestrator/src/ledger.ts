import type { ConsumerBalanceReader } from "@koven/consumer-agent";

export interface MirrorBalanceReaderOptions {
  readonly mirrorNodeUrl: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
}

/**
 * Reads the borrower's HBAR balance from a trusted Mirror Node, so the
 * orchestrator never needs a Hedera key of its own to decide whether credit
 * is required.
 */
export class MirrorBalanceReader implements ConsumerBalanceReader {
  private readonly baseUrl: URL;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: MirrorBalanceReaderOptions) {
    this.baseUrl = new URL(options.mirrorNodeUrl);
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 60_000) {
      throw new RangeError("Mirror timeout must be between 1 and 60000 ms");
    }
  }

  async getBalanceTinybar(accountId: string): Promise<bigint> {
    if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(accountId)) throw new Error("Account ID is invalid");
    const response = await this.fetchImplementation(new URL(`/api/v1/accounts/${accountId}`, this.baseUrl), {
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`Mirror balance request failed with HTTP ${response.status}`);
    const body: unknown = await response.json();
    const balance = typeof body === "object" && body !== null && "balance" in body ? (body as { balance: unknown }).balance : undefined;
    const tinybar = typeof balance === "object" && balance !== null && "balance" in balance ? (balance as { balance: unknown }).balance : undefined;
    if (typeof tinybar !== "number" || !Number.isSafeInteger(tinybar) || tinybar < 0) throw new Error("Mirror balance is unavailable");
    return BigInt(tinybar);
  }
}

/** Demo setting: the borrower always borrows the full price, so the credit beat is exercised regardless of its balance. */
export const emptyBalanceReader: ConsumerBalanceReader = { getBalanceTinybar: async () => 0n };
