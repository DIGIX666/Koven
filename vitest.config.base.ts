export default {
  test: {
    environment: "node" as const,
    clearMocks: true,
    restoreMocks: true,
    testTimeout: 10_000,
  },
};
