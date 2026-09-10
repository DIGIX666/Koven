import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  "packages/*/vitest.config.ts",
  "agents/*/vitest.config.ts",
  "services/*/vitest.config.ts",
  "apps/*/vitest.config.ts",
  "tests/*/vitest.config.ts",
]);
