import { TopicCreateTransaction, TopicInfoQuery, TopicId, Status, TransactionId } from "@koven/hedera";
import { accountId, announce, OperatorError, run, savedReceipt } from "./lib/hedera.js";

await run(async ctx => {
  if (process.argv.length > 2) throw new OperatorError("Usage: pnpm tsx scripts/hedera-create-topic.ts");
  const existing = ctx.store.get("HCS_AUDIT_TOPIC_ID");
  if (existing) {
    accountId(existing);
    const info = await new TopicInfoQuery().setTopicId(existing).execute(ctx.client);
    if (info.adminKey?.toString() !== ctx.client.operatorPublicKey!.toString()) {
      throw new OperatorError("Configured topic admin key does not match the operator");
    }
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
  await new TopicInfoQuery().setTopicId(TopicId.fromString(topicId)).execute(ctx.client);
  ctx.store.set({ HCS_AUDIT_TOPIC_ID: topicId });
  console.info(`HCS_AUDIT_TOPIC_ID=${topicId}`);
});
