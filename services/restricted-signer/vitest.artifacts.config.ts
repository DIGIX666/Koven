import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../vitest.config.base.js";

// Signer suites that need the verified official ZK artifacts; run through `pnpm zk:test`.
export default mergeConfig(base, defineConfig({
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["test/**/*.artifacts.test.ts"],
    fileParallelism: false,
    testTimeout: 60_000,
  },
}));
