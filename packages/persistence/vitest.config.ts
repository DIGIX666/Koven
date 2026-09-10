import { fileURLToPath } from "node:url";
import { defineProject, mergeConfig } from "vitest/config";
import shared from "../../vitest.config.js";

export default mergeConfig(shared, defineProject({
  test: { name: "@koven/persistence", root: fileURLToPath(new URL(".", import.meta.url)) },
}));
