import { TopicCreateTransaction, TopicInfoQuery, TopicId, Status, TransactionId } from "@koven/hedera";
import { accountId, announce, OperatorError, savedReceipt, type Context } from "./hedera.js";

async function inspectAuditTopic(ctx: Context, topicId: string): Promise<void> {
  accountId(topicId);
  const info = await new TopicInfoQuery().setTopicId(TopicId.fromString(topicId)).execute(ctx.client);
  const operatorKey = ctx.client.operatorPublicKey;
  if (!operatorKey || info.adminKey?.toString() !== operatorKey.toString()) {
    throw new OperatorError("Audit topic admin key does not match the operator");
  }
  if (info.submitKey !== null) {
    throw new OperatorError("Audit topic must allow public submissions (no submit key)");
  }
}

export async function provisionAuditTopic(ctx: Context): Promise<void> {
  const existing = ctx.store.get("HCS_AUDIT_TOPIC_ID");
  if (existing) {
    await inspectAuditTopic(ctx, existing);
    console.info(`HCS_AUDIT_TOPIC_ID=${existing} (already configured)`);
    return;
  }
  const journalKey = "KOVEN_CREATE_TOPIC_TX_ID";
  const pending = ctx.store.get(journalKey);
  let receipt;
  if (pending) {
    receipt = await savedReceipt(ctx, pending);
  } else {
    const transactionId = TransactionId.generate(ctx.client.operatorAccountId!);
    ctx.store.set({ [journalKey]: transactionId.toString() });
    announce(transactionId);
    const response = await new TopicCreateTransaction().setTopicMemo("Koven testnet audit")
      .setAdminKey(ctx.client.operatorPublicKey!).setTransactionId(transactionId).execute(ctx.client);
    receipt = await response.getReceipt(ctx.client);
  }
  if (receipt.status !== Status.Success || !receipt.topicId) throw new OperatorError("Topic creation has no successful topic receipt");
  const topicId = receipt.topicId.toString();
  await inspectAuditTopic(ctx, topicId);
  ctx.store.set({ HCS_AUDIT_TOPIC_ID: topicId });
  console.info(`HCS_AUDIT_TOPIC_ID=${topicId}`);
}
