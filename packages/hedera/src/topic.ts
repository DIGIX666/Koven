import {
  PrecheckStatusError,
  ReceiptStatusError,
  Status,
  TopicCreateTransaction,
  TopicId,
  TopicMessageSubmitTransaction,
  Transaction,
  TransactionId,
  TransactionReceiptQuery,
  type Client,
} from "@hiero-ledger/sdk";
import { assertTestnetOperator, parseAccountId } from "./client.js";
import { validateMemo } from "./transfer.js";

export async function createTopic(client: Client, memo: string): Promise<string> {
  assertTestnetOperator(client);
  validateMemo(memo);
  const publicKey = client.operatorPublicKey;
  if (!publicKey) throw new Error("Topic creation requires the operator public key");
  // Public submissions allow the separate lender hooks planned in M5.
  // Readers must authenticate event provenance; topic membership alone is not trust.
  const response = await new TopicCreateTransaction().setTopicMemo(memo)
    .setAdminKey(publicKey).execute(client);
  const receipt = await response.getReceipt(client);
  if (receipt.status !== Status.Success || !receipt.topicId) throw new Error("Hedera topic creation failed");
  return receipt.topicId.toString();
}

export async function submitTopicMessage(client: Client, topicId: string, message: string): Promise<{
  transactionId: string; sequenceNumber: bigint;
}> {
  const prepared = await prepareTopicMessage(client, topicId, message);
  const result = await submitPreparedTopicMessage(client, prepared.transactionBase64);
  if (result.status !== "confirmed") throw new Error(`Hedera topic submission ${result.status}`);
  return { transactionId: prepared.transactionId, sequenceNumber: result.sequenceNumber };
}

export interface PreparedTopicMessage {
  readonly transactionId: string;
  readonly transactionBase64: string;
  readonly validUntil: number;
}

export type TopicSubmissionResult =
  | { readonly status: "confirmed"; readonly sequenceNumber: bigint }
  | { readonly status: "failed" | "uncertain" };

const TOPIC_TRANSACTION_VALID_SECONDS = 180;

/** Builds signed topic bytes so callers can persist them before submission. */
export async function prepareTopicMessage(
  client: Client,
  topicId: string,
  message: string,
): Promise<PreparedTopicMessage> {
  const accountId = assertTestnetOperator(client);
  parseAccountId(topicId);
  const bytes = Buffer.from(message, "utf8");
  if (bytes.length === 0 || bytes.length > 1024) throw new Error("Topic message must contain 1–1024 UTF-8 bytes");
  const transaction = new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(topicId))
    .setMessage(bytes)
    .setMaxChunks(1)
    .setTransactionId(TransactionId.generate(accountId))
    .setTransactionValidDuration(TOPIC_TRANSACTION_VALID_SECONDS)
    .freezeWith(client);
  await transaction.signWithOperator(client);
  const transactionId = transaction.transactionId?.toString();
  if (transactionId === undefined) throw new Error("Prepared topic transaction has no ID");
  const match = /@(\d+)\.(\d{9})$/.exec(transactionId);
  if (match === null) throw new Error("Prepared topic transaction has an invalid ID");
  return {
    transactionId,
    transactionBase64: Buffer.from(transaction.toBytes()).toString("base64"),
    validUntil: Number(match[1]) * 1_000
      + Number(match[2]) / 1_000_000
      + TOPIC_TRANSACTION_VALID_SECONDS * 1_000,
  };
}

const topicReceipt = async (client: Client, transactionId: TransactionId): Promise<TopicSubmissionResult> => {
  const receipt = await new TransactionReceiptQuery().setTransactionId(transactionId).execute(client);
  if (receipt.status !== Status.Success) return { status: "failed" };
  if (receipt.topicSequenceNumber === null) throw new Error("HCS receipt has no sequence number");
  return { status: "confirmed", sequenceNumber: BigInt(receipt.topicSequenceNumber.toString()) };
};

/** Submits the exact stored bytes and never lets the SDK replace their transaction ID. */
export async function submitPreparedTopicMessage(
  client: Client,
  transactionBase64: string,
): Promise<TopicSubmissionResult> {
  const transaction = Transaction.fromBytes(Buffer.from(transactionBase64, "base64"));
  const transactionId = transaction.transactionId;
  if (transactionId === null) throw new Error("Stored HCS bytes carry no transaction ID");
  try {
    const response = await transaction.execute(client);
    if (response.transactionId.toString() !== transactionId.toString()) return { status: "uncertain" };
    return await topicReceipt(client, transactionId);
  } catch (error) {
    if (error instanceof ReceiptStatusError) return { status: "failed" };
    if (error instanceof PrecheckStatusError) {
      return error.status === Status.DuplicateTransaction ? { status: "uncertain" } : { status: "failed" };
    }
    return { status: "uncertain" };
  }
}

/** Queries only the persisted transaction ID after a crash or uncertain response. */
export async function reconcileTopicMessage(
  client: Client,
  transactionId: string,
): Promise<TopicSubmissionResult> {
  try {
    return await topicReceipt(client, TransactionId.fromString(transactionId));
  } catch (error) {
    if (error instanceof ReceiptStatusError) return { status: "failed" };
    return { status: "uncertain" };
  }
}
