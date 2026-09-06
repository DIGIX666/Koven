import { AccountBalanceQuery, type Client } from "@hiero-ledger/sdk";
import { assertTestnetOperator, parseAccountId } from "./client.js";

export async function getBalanceTinybar(client: Client, accountId: string): Promise<bigint> {
  assertTestnetOperator(client);
  const balance = await new AccountBalanceQuery()
    .setAccountId(parseAccountId(accountId)).execute(client);
  return BigInt(balance.hbars.toTinybars().toString());
}
