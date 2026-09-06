import { Status, TopicCreateTransaction, TopicId, TopicMessageSubmitTransaction, type Client } from "@hiero-ledger/sdk";
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
  assertTestnetOperator(client);
  parseAccountId(topicId);
  // The API returns one sequence number, so do not silently split an audit event.
  const bytes = Buffer.from(message, "utf8");
  if (bytes.length === 0 || bytes.length > 1024) throw new Error("Topic message must contain 1–1024 UTF-8 bytes");
  const response = await new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(topicId)).setMessage(bytes).setMaxChunks(1).execute(client);
  const receipt = await response.getReceipt(client);
  if (receipt.status !== Status.Success || receipt.topicSequenceNumber === null) {
    throw new Error("Hedera topic submission failed");
  }
  return { transactionId: response.transactionId.toString(), sequenceNumber: BigInt(receipt.topicSequenceNumber.toString()) };
}
