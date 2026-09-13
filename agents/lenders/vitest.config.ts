import { fileURLToPath } from "node:url";
import { defineProject, mergeConfig } from "vitest/config";
import shared from "../../vitest.config.js";

// Suites named *.artifacts.test.ts need the verified official ZK artifacts from
// `pnpm zk:build`; they run through `vitest.artifacts.config.ts` (`pnpm zk:test`).
export default mergeConfig(shared, defineProject({
  test: {
    name: "@koven/lender-agents",
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.artifacts.test.ts"],
  },
}));
