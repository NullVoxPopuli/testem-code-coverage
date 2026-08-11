import { describe, test, expect, beforeAll } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario, readCoverageSummary } from "./helpers.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scenarioDir = join(repoRoot, "test-scenarios", "vite-app-js");

/**
 * Two browsers, each running half the suite (see testem-parallel.cjs):
 *
 *   browser 1 (filter=Unit)        → app/utils/format-score.js
 *   browser 2 (filter=Integration) → app/components/counter.gjs
 *
 * Neither browser covers both files, so these assertions only hold if coverage
 * was collected from BOTH browsers and merged. They are the regression test for
 * one-session-per-browser: with a single shared session, whichever browser lost
 * the race contributes nothing and its file reports zero covered lines.
 */
let summary;

beforeAll(() => {
  runScenario(scenarioDir, "test:parallel");
  summary = readCoverageSummary(scenarioDir, "coverage-parallel");
});

function find(suffix) {
  const key = Object.keys(summary).find((k) => k.endsWith(suffix));

  return key ? summary[key] : undefined;
}

test("both browsers' files are present in the merged report", () => {
  expect(find("app/utils/format-score.js"), "format-score.js (Unit browser)").toBeDefined();
  expect(find("app/components/counter.gjs"), "counter.gjs (Integration browser)").toBeDefined();
});

describe("merged coverage", () => {
  test("the Unit-only browser contributed covered lines", () => {
    const formatScore = find("app/utils/format-score.js");

    expect(formatScore.lines.covered, "format-score.js has covered lines").toBeGreaterThan(0);
  });

  test("the Integration-only browser contributed covered lines", () => {
    const counter = find("app/components/counter.gjs");

    expect(counter.lines.covered, "counter.gjs has covered lines").toBeGreaterThan(0);
  });

  test("uncovered branches are still reported as uncovered", () => {
    // format-score.js deliberately leaves the `score < 0` branch untested, and
    // counter.gjs never calls clampedCount/countAsString. Merging must not turn
    // untested code green — mergeProcessCovs sums counts, so a function absent
    // from both browsers stays at zero.
    const formatScore = find("app/utils/format-score.js");
    const counter = find("app/components/counter.gjs");

    expect(formatScore.lines.pct, "format-score.js below 100%").toBeLessThan(100);
    expect(counter.functions.pct, "counter.gjs functions below 100%").toBeLessThan(100);
  });
});
