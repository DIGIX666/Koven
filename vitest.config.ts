import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    restoreMocks: true,
    clearMocks: true,
    allowOnly: false,
    include: ["src/**/*.test.ts", "test/**/*.test.ts", "tests/**/*.test.ts", "*.test.ts"],
  },
});
