import { parseArgs } from "node:util";
import { HTTPFacilitatorClient } from "@x402/core/http";
import { inspectAccount, run } from "./lib/hedera.js";
import { runSmoke, confirmOnMirror, smokeConfig, buildSmokePayment } from "./lib/x402-smoke.js";

await run(async ctx => {
  const { values } = parseArgs({ options: { reconcile: { type: "string" } } });
  const config = smokeConfig(ctx.store);
  await inspectAccount(ctx, "consumer");
  await inspectAccount(ctx, "provider-a");
  const facilitator = new HTTPFacilitatorClient({ url: config.facilitatorUrl, timeoutMs: 30_000 });
  await runSmoke(config, ctx.store, {
    facilitator,
    build: requirements => buildSmokePayment(config, ctx.store.get("CONSUMER_PRIVATE_KEY"), requirements),
    confirm: transactionId => confirmOnMirror(config, transactionId),
  }, values.reconcile);
});
