import { createLogger } from "@koven/config";

import { createOrchestratorRuntime, loadOrchestratorConfig } from "./runtime.js";

/** Starts the mission orchestrator from the process environment. */
const logger = createLogger({ name: "orchestrator" });
const config = loadOrchestratorConfig();
const runtime = createOrchestratorRuntime(config);
const listener = await runtime.listen();

logger.info({
  host: runtime.host,
  port: runtime.port,
  proofMode: config.proofMode,
  auditSink: config.audit.mode,
  lenders: config.lenders.length,
}, "Orchestrator listening");

let stopping = false;
const shutdown = (signal: NodeJS.Signals): void => {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "Orchestrator stopping");
  listener.close(() => {
    runtime.close();
    process.exit(0);
  });
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
