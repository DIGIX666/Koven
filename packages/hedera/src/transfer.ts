import { AccountInfoQuery, Hbar, Status, TransferTransaction, type Client } from "@hiero-ledger/sdk";
import { assertTestnetOperator, parseAccountId } from "./client.js";

export interface TransferHbarRequest {
  from: string;
  to: string;
  amountTinybar: bigint;
  memo?: string;
}

export function validateMemo(memo: string): void {
  if (Buffer.byteLength(memo, "utf8") > 100 || memo.includes("\0")) {
    throw new Error("Memo must be at most 100 UTF-8 bytes without NUL");
  }
}

/** Transfers from the client operator and waits for a consensus receipt. */
export async function transferHbar(client: Client, request: TransferHbarRequest): Promise<{
  transactionId: string; status: string;
}> {
  const operator = assertTestnetOperator(client);
  const from = parseAccountId(request.from);
  const to = parseAccountId(request.to);
  if (from.toString() !== operator.toString()) throw new Error("Transfer source must be the client operator");
  if (from.toString() === to.toString()) throw new Error("Transfer accounts must be distinct");
  // Transfer protobuf amounts are signed int64, narrower than wire uint64 money.
  if (typeof request.amountTinybar !== "bigint" || request.amountTinybar <= 0n
      || request.amountTinybar > 9223372036854775807n) {
    throw new Error("Transfer amount must be a positive int64 tinybar bigint");
  }
  const memo = request.memo ?? "";
  validateMemo(memo);
  await new AccountInfoQuery().setAccountId(to).execute(client);
  const response = await new TransferTransaction()
    .addHbarTransfer(from, Hbar.fromTinybars((-request.amountTinybar).toString()))
    .addHbarTransfer(to, Hbar.fromTinybars(request.amountTinybar.toString()))
    .setTransactionMemo(memo).execute(client);
  const receipt = await response.getReceipt(client);
  if (receipt.status !== Status.Success) throw new Error("Hedera transfer did not succeed");
  return { transactionId: response.transactionId.toString(), status: receipt.status.toString() };
}
