import { describe, test, expect } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario, readCoverageSummary, readCoverageSummaryText } from "./helpers.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scenariosRoot = join(repoRoot, "test-scenarios");
const snapshotsRoot = fileURLToPath(new URL("./__snapshots__", import.meta.url));

/** Discover scenarios by listing the test-scenarios directory. */
const scenarios = readdirSync(scenariosRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

// Whether to run exact-number snapshot tests. Vite/Embroider builds produce
// different chunk layouts on macOS (arm64) vs Linux (x86_64), so function
// totals vary. Snapshots are generated on Linux CI; macOS devs rely on the
// invariant tests below instead.
const isLinux = process.platform === "linux";

for (const name of scenarios) {
  describe(name, () => {
    const scenarioDir = join(scenariosRoot, name);
    const snapshotDir = join(snapshotsRoot, name);

    // Run the scenario once; subsequent tests in this describe block reuse
    // the coverage output without re-running.
    let summary;
    let summaryText;

    test("run scenario and collect coverage", () => {
      runScenario(scenarioDir);

      expect(existsSync(join(scenarioDir, "coverage")), "coverage directory was created").toBe(
        true,
      );

      summary = readCoverageSummary(scenarioDir);
      summaryText = readCoverageSummaryText(scenarioDir);
    });

    // ── Cross-platform correctness invariants ────────────────────────────────
    // These assertions express what the coverage plugin MUST get right on every
    // platform: the two never-called methods on Counter (clampedCount,
    // countAsString) must appear as uncovered.
    describe("correctness invariants", () => {
      test("counter.gjs: exactly 2 functions are uncovered (clampedCount, countAsString)", () => {
        const counter = summary["app/components/counter.gjs"];
        expect(counter, "counter.gjs entry exists in coverage report").toBeDefined();
        const uncovered = counter.functions.total - counter.functions.covered;
        expect(
          uncovered,
          "clampedCount and countAsString should be the only uncovered functions",
        ).toBe(2);
        expect(counter.functions.pct, "function coverage must be below 100%").toBeLessThan(100);
      });

      test("counter.gjs: get label and increment ARE covered", () => {
        const counter = summary["app/components/counter.gjs"];
        expect(
          counter.functions.covered,
          "at least get label + increment should be covered",
        ).toBeGreaterThanOrEqual(2);
      });

      test("counter.gjs: line coverage is partial (template block not fully exercised)", () => {
        const counter = summary["app/components/counter.gjs"];
        expect(counter.lines.covered, "some lines covered").toBeGreaterThan(0);
        expect(counter.lines.pct, "line coverage is less than 100%").toBeLessThan(100);
      });
    });

    // ── Exact-number snapshot tests (Linux CI only) ──────────────────────────
    // Vite chunk splits and Glimmer template compilation produce different
    // function counts on macOS vs Linux. Snapshots encode Linux values and are
    // verified only on Linux so that CI always has a regression guard without
    // breaking local macOS development.
    test.runIf(isLinux)("coverage summary matches snapshot", async () => {
      await expect(JSON.stringify(summary, null, 2)).toMatchFileSnapshot(
        join(snapshotDir, "coverage-summary.json"),
      );
      await expect(summaryText).toMatchFileSnapshot(join(snapshotDir, "coverage-summary.txt"));
    });
  });
}
