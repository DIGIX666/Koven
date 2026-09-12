import { createLogger } from "@koven/config";

import { createSignerRuntime } from "./runtime.js";

/** Starts the restricted signer from the process environment. */
const logger = createLogger({ name: "restricted-signer" });
const runtime = await createSignerRuntime();
const listener = await runtime.listen();

logger.info({ host: runtime.host, port: runtime.port }, "Restricted signer listening");

const shutdown = (signal: NodeJS.Signals): void => {
  logger.info({ signal }, "Restricted signer stopping");
  listener.close(() => {
    runtime.close();
    process.exit(0);
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
