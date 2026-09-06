import { getBalanceTinybar } from "@koven/hedera";
import { inspectAccount, OperatorError, roleNames, run } from "./lib/hedera.js";

await run(async ctx => {
  if (process.argv.length > 2) throw new OperatorError("Usage: pnpm tsx scripts/hedera-balances.ts");
  let funded = true;
  for (const name of roleNames) {
    const id = await inspectAccount(ctx, name);
    const balance = await getBalanceTinybar(ctx.client, id);
    console.info(`${name}: ${id} — ${balance} tinybar`);
    if (balance <= 0n) funded = false;
  }
  if (!funded) throw new OperatorError("All six accounts must have a positive balance");
  console.info("All six testnet accounts exist and are funded.");
});
