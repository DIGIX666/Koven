import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../vitest.config.base.js";

// Feasibility benchmark over the official artifacts; requires `pnpm zk:build`.
export default mergeConfig(base, defineConfig({
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    include: ["test/**/*.artifacts.test.ts"],
    fileParallelism: false,
  },
}));
