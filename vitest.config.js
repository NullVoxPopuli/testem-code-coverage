import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    // Integration tests spawn Chrome via testem, so run in a forked process
    // to avoid worker-thread restrictions on child_process.
    pool: "forks",
    // Each scenario builds the app + runs Chrome — allow up to 5 minutes.
    testTimeout: 5 * 60 * 1000,
    hookTimeout: 60 * 1000,
  },
});
