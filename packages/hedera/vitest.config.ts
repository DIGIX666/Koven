import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../vitest.config.base.js";
export default mergeConfig(base, defineConfig({
  test: { include: ["test/**/*.test.ts"], exclude: ["test/**/*.integration.test.ts"] },
}));
