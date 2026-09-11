import { createLogger } from "@koven/config";

import { createPaidScanRuntime } from "./runtime.js";

/** Starts the paid scan provider from the process environment. */
const logger = createLogger({ name: "resource-server" });
const runtime = await createPaidScanRuntime();
const listener = await runtime.listen();

logger.info({ port: runtime.port }, "Paid scan provider listening");

const shutdown = (signal: NodeJS.Signals): void => {
  logger.info({ signal }, "Paid scan provider stopping");
  listener.close(() => {
    runtime.close();
    process.exit(0);
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
