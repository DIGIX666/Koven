import { parseArgs } from "node:util";
import { getBalanceTinybar, Hbar, Status, TransactionId, TransferTransaction } from "@koven/hedera";
import { accountId, announce, inspectAccount, OperatorError, role, roles, run, savedReceipt, tinybars } from "./lib/hedera.js";
import { topUpAmount } from "./lib/funding.js";

await run(async ctx => {
  const { values } = parseArgs({ options: { role: { type: "string" }, "target-tinybar": { type: "string" } } });
  if (!values.role || !values["target-tinybar"]) throw new OperatorError("Usage: pnpm tsx scripts/hedera-fund.ts --role provider-a --target-tinybar 100000000");
  const name = role(values.role);
  if (name === "operator") throw new OperatorError("Fund the operator through the testnet faucet");
  const target = tinybars(values["target-tinybar"]);
  const to = await inspectAccount(ctx, name);
  const journalKey = `KOVEN_FUND_${roles[name]}_TX_ID`;
  const pending = ctx.store.get(journalKey);
  if (pending) {
    await savedReceipt(ctx, pending);
    ctx.store.set({ [journalKey]: "" });
    console.info(`${name}: previous funding confirmed; run again only if another top-up is needed`);
    return;
  }
  const balance = await getBalanceTinybar(ctx.client, to);
  const amount = topUpAmount(balance, target);
  if (amount === 0n) {
    console.info(`${name}: ${balance} tinybar; target already reached`);
    return;
  }
  const transactionId = TransactionId.generate(ctx.client.operatorAccountId!);
  ctx.store.set({ [journalKey]: transactionId.toString() });
  announce(transactionId);
  const response = await new TransferTransaction()
    .addHbarTransfer(ctx.client.operatorAccountId!, Hbar.fromTinybars((-amount).toString()))
    .addHbarTransfer(accountId(to), Hbar.fromTinybars(amount.toString()))
    .setTransactionMemo(`Koven fund ${name}`).setTransactionId(transactionId).execute(ctx.client);
  const receipt = await response.getReceipt(ctx.client);
  if (receipt.status !== Status.Success) throw new OperatorError("Funding has no SUCCESS receipt");
  ctx.store.set({ [journalKey]: "" });
  console.info(`${name}: transferred ${amount} tinybar to ${to}`);
});
