import { expect, it } from "vitest";
import { AccountInfoQuery, createClient, explorerUrl, transferHbar } from "../src/index.js";

it("transfers 1 tinybar operator → consumer with a SUCCESS consensus receipt", async () => {
  const consumer = process.env.CONSUMER_ACCOUNT_ID;
  if (!consumer) throw new Error("CONSUMER_ACCOUNT_ID is required for the explicit testnet test");
  const client = createClient({ HEDERA_NETWORK: process.env.HEDERA_NETWORK,
    HEDERA_OPERATOR_ID: process.env.HEDERA_OPERATOR_ID,
    HEDERA_OPERATOR_PRIVATE_KEY: process.env.HEDERA_OPERATOR_PRIVATE_KEY }).setRequestTimeout(30_000).setMaxAttempts(3);
  let result: Awaited<ReturnType<typeof transferHbar>>;
  try {
    const operator = client.operatorAccountId!;
    const info = await new AccountInfoQuery().setAccountId(operator).execute(client);
    if (info.key.toString() !== client.operatorPublicKey!.toString()) throw new Error("Operator key does not match account");
    result = await transferHbar(client, { from: operator.toString(), to: consumer, amountTinybar: 1n, memo: "Koven A0.2 smoke" });
  } catch (error) {
    // SDK errors can retain transaction objects: only return a sanitized failure.
    const name = error instanceof Error ? error.name : "UnknownError";
    throw new Error(`Testnet transfer failed (${name}); inspect account/network configuration locally. Do not blindly retry an uncertain submission.`);
  } finally {
    client.close();
  }
  expect(result.status).toBe("SUCCESS");
  console.info(`A0.2 transfer: ${explorerUrl(result.transactionId)}`);
});
