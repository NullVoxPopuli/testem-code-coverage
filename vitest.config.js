import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    // Integration tests spawn Chrome via testem, so run in a forked process
    // to avoid worker-thread restrictions on child_process.
    pool: "forks",
    testTimeout: 60 * 1000,
    hookTimeout: 60 * 1000,
  },
});
