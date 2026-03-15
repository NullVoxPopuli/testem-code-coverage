import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    // Integration tests spawn Chrome via testem, so run in a forked process
    // to avoid worker-thread restrictions on child_process.
    pool: "forks",
    // Scenarios launch Chrome on fixed ports (9222, 9223). Running test files
    // in parallel causes port collisions between scenarios that share the same
    // port. Run them sequentially to avoid this.
    fileParallelism: false,
    testTimeout: 60 * 1000,
    hookTimeout: 60 * 1000,
  },
});
