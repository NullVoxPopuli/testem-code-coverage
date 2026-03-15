import { describe, test, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario, readCoverageSummary } from "./helpers.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scenarioDir = join(repoRoot, "test-scenarios", "vite-app-js");

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
    const key = Object.keys(summary).find((k) => k.endsWith("app/components/counter.gjs"));
    return key ? summary[key] : undefined;
  }

  test("exactly 2 functions are uncovered (clampedCount, countAsString)", () => {
    const counter = findCounter();
    expect(counter, "counter.gjs entry exists in coverage report").toBeDefined();
    const uncovered = counter.functions.total - counter.functions.covered;
    expect(uncovered, "clampedCount and countAsString should be the only uncovered functions").toBe(
      2,
    );
    expect(counter.functions.pct, "function coverage must be below 100%").toBeLessThan(100);
  });

  test("get label and increment ARE covered", () => {
    const counter = findCounter();
    expect(
      counter.functions.covered,
      "at least get label + increment should be covered",
    ).toBeGreaterThanOrEqual(2);
  });

  test("line coverage is partial (template block not fully exercised)", () => {
    const counter = findCounter();
    expect(counter.lines.covered, "some lines covered").toBeGreaterThan(0);
    expect(counter.lines.pct, "line coverage is less than 100%").toBeLessThan(100);
  });
});

describe("format-score.js", () => {
  function findFormatScore() {
    const key = Object.keys(summary).find((k) => k.endsWith("utils/format-score.js"));
    return key ? summary[key] : undefined;
  }

  test("exists in coverage report", () => {
    const entry = findFormatScore();
    expect(entry, "format-score.js entry exists in coverage report").toBeDefined();
  });

  test("function is covered", () => {
    const entry = findFormatScore();
    expect(entry.functions.covered).toBeGreaterThanOrEqual(1);
  });

  test("line coverage is partial (score < 0 branch not exercised)", () => {
    const entry = findFormatScore();
    expect(entry.lines.pct, "line coverage is less than 100%").toBeLessThan(100);
  });
});
