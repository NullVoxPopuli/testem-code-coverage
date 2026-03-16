import { describe, test, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario, readCoverageSummary } from "./helpers.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scenarioDir = join(repoRoot, "test-scenarios", "v2-addon-js");

let summary;

beforeAll(() => {
  runScenario(scenarioDir);
  summary = readCoverageSummary(scenarioDir);
});

test("coverage directory was created", () => {
  expect(existsSync(join(scenarioDir, "coverage")), "coverage directory was created").toBe(true);
});

describe("counter.gjs", () => {
  function findCounter() {
    const key = Object.keys(summary).find((k) => k.endsWith("src/components/counter.gjs"));
    return key ? summary[key] : undefined;
  }

  test("has partial function coverage (clampedCount and countAsString are always uncovered)", () => {
    const counter = findCounter();
    expect(counter, "counter.gjs entry exists in coverage report").toBeDefined();
    // clampedCount and countAsString are never called, so function coverage is never 100%.
    // V8's nondeterministic JIT may or may not track get label/increment as separate
    // function entries, so we check pct rather than exact covered/uncovered counts.
    expect(counter.functions.total, "at least 2 functions tracked").toBeGreaterThanOrEqual(2);
    expect(counter.functions.pct, "function coverage below 100%").toBeLessThan(100);
  });

  test("line coverage is partial (template block not fully exercised)", () => {
    const counter = findCounter();
    expect(counter.lines.covered, "some lines covered").toBeGreaterThan(0);
    expect(counter.lines.pct, "line coverage is less than 100%").toBeLessThan(100);
  });
});

test("no format-score.js in coverage (addon has no such file)", () => {
  const key = Object.keys(summary).find((k) => k.endsWith("format-score.js"));
  expect(key, "format-score.js should not appear in addon coverage").toBeUndefined();
});
