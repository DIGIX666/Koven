import type { TransferHbarRequest } from "./transfer.js";

export interface HederaTransferResult {
  transactionId: string;
  status: "SUCCESS";
}

/** Narrow Hedera boundary used by deterministic mission workflows. */
export interface HederaAdapter {
  getBalanceTinybar(accountId: string): Promise<bigint>;
  transferHbar(request: TransferHbarRequest): Promise<HederaTransferResult>;
}
