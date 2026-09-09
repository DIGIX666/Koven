import { OperatorError, run } from "./lib/hedera.js";
import { provisionAuditTopic } from "./lib/topic.js";

await run(async ctx => {
  if (process.argv.length > 2) throw new OperatorError("Usage: pnpm tsx scripts/hedera-create-topic.ts");
  await provisionAuditTopic(ctx);
});
