import { describe, test, expect, beforeAll } from "vitest";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario, readCoverageSummary } from "./helpers.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scenariosRoot = join(repoRoot, "test-scenarios");
const scenarios = readdirSync(scenariosRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

for (const name of scenarios) {
  describe(name, () => {
    const scenarioDir = join(scenariosRoot, name);

    // Run the scenario once in beforeAll so all tests in this describe block
    // can rely on coverage output being present regardless of execution order.
    let summary;

    beforeAll(() => {
      runScenario(scenarioDir);
      summary = readCoverageSummary(scenarioDir);
    });

    test("coverage directory was created", () => {
      expect(existsSync(join(scenarioDir, "coverage")), "coverage directory was created").toBe(
        true,
      );
    });

    // ── Cross-platform correctness invariants ────────────────────────────────
    // These assertions express what the coverage plugin MUST get right on every
    // platform: the two never-called methods on Counter (clampedCount,
    // countAsString) must appear as uncovered.
    //
    // The counter component lives at different paths per scenario
    // (e.g. app/components/counter.gjs vs src/components/counter.gjs),
    // so we find it by key suffix rather than hardcoding the full path.
    describe("correctness invariants", () => {
      function findCounter(summary) {
        const key = Object.keys(summary).find((k) => k.endsWith("components/counter.gjs"));
        return key ? summary[key] : undefined;
      }

      test("counter.gjs: exactly 2 functions are uncovered (clampedCount, countAsString)", () => {
        const counter = findCounter(summary);
        expect(counter, "counter.gjs entry exists in coverage report").toBeDefined();
        const uncovered = counter.functions.total - counter.functions.covered;
        expect(
          uncovered,
          "clampedCount and countAsString should be the only uncovered functions",
        ).toBe(2);
        expect(counter.functions.pct, "function coverage must be below 100%").toBeLessThan(100);
      });

      test("counter.gjs: get label and increment ARE covered", () => {
        const counter = findCounter(summary);
        expect(
          counter.functions.covered,
          "at least get label + increment should be covered",
        ).toBeGreaterThanOrEqual(2);
      });

      test("counter.gjs: line coverage is partial (template block not fully exercised)", () => {
        const counter = findCounter(summary);
        expect(counter.lines.covered, "some lines covered").toBeGreaterThan(0);
        expect(counter.lines.pct, "line coverage is less than 100%").toBeLessThan(100);
      });
    });

    // ── Exact-number snapshot tests removed ──────────────────────────────────
    // counter-test.gjs statement counts varied non-deterministically between CI
    // runs (24 / 26 / 27 observed) due to async timing in test teardown,
    // making file snapshots unreliable. The correctness invariants above are
    // the reliable regression guard for what actually matters.
  });
}
