import { parseArgs } from "node:util";
import { AccountCreateTransaction, Hbar, PrivateKey, Status, TransactionId } from "@koven/hedera";
import { announce, assertDistinctAccounts, idKey, inspectAccount, keyKey, OperatorError, role, roleNames,
  roles, run, savedReceipt, tinybars } from "./lib/hedera.js";

await run(async ctx => {
  const { values } = parseArgs({ options: { role: { type: "string" }, "initial-tinybar": { type: "string", default: "100000000" } } });
  const selected = values.role ? [role(values.role)] : roleNames.filter(name => name !== "operator");
  if (selected.includes("operator")) throw new OperatorError("Bootstrap the operator in the Hedera portal");
  const amount = tinybars(values["initial-tinybar"]!);
  for (const name of selected) {
    if (ctx.store.get(idKey(name))) {
      console.info(`${name}: ${await inspectAccount(ctx, name)} (already configured)`);
      continue;
    }
    const journalKey = `KOVEN_CREATE_${roles[name]}_TX_ID`;
    const pending = ctx.store.get(journalKey);
    let receipt;
    if (pending) {
      if (!ctx.store.get(keyKey(name))) throw new OperatorError("Pending account creation is missing its recovery key; restore .env before continuing");
      receipt = await savedReceipt(ctx, pending);
    } else {
      const secret = ctx.store.get(keyKey(name));
      const key = secret ? PrivateKey.fromStringECDSA(secret) : PrivateKey.generateECDSA();
      const transactionId = TransactionId.generate(ctx.client.operatorAccountId!);
      // Save the recovery key and ID before any network submission.
      ctx.store.set({ [keyKey(name)]: key.toStringDer(), [journalKey]: transactionId.toString() });
      announce(transactionId);
      const response = await new AccountCreateTransaction().setKeyWithoutAlias(key.publicKey)
        .setInitialBalance(Hbar.fromTinybars(amount.toString())).setTransactionId(transactionId).execute(ctx.client);
      receipt = await response.getReceipt(ctx.client);
    }
    if (receipt.status !== Status.Success || !receipt.accountId) throw new OperatorError("Account creation has no successful account receipt");
    ctx.store.set({ [idKey(name)]: receipt.accountId.toString() });
    assertDistinctAccounts(ctx.store);
    console.info(`${name}: ${await inspectAccount(ctx, name)} (created; key saved only in .env)`);
  }
  if (!ctx.store.get("X402_PAY_TO_ACCOUNT_ID") && ctx.store.get("PROVIDER_A_ACCOUNT_ID")) {
    ctx.store.set({ X402_PAY_TO_ACCOUNT_ID: ctx.store.get("PROVIDER_A_ACCOUNT_ID") });
  }
});
