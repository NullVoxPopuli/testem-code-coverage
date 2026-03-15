import { describe, test, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario, readCoverageSummary } from "./helpers.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scenarioDir = join(repoRoot, "test-scenarios", "vite-app-using-v2-addon-js");

let summary;

beforeAll(() => {
  runScenario(scenarioDir);
  summary = readCoverageSummary(scenarioDir);
});

test("coverage directory was created", () => {
  expect(existsSync(join(scenarioDir, "coverage")), "coverage directory was created").toBe(true);
});

describe("local counter.gjs (app/components/counter.gjs)", () => {
  function findLocalCounter() {
    // Keys are relative to the scenario dir, so the local counter is just
    // "app/components/counter.gjs" — no scenario name in the path.
    const key = Object.keys(summary).find((k) => k === "app/components/counter.gjs");
    return key ? summary[key] : undefined;
  }

  test("exists in coverage report", () => {
    expect(findLocalCounter(), "local counter.gjs entry exists").toBeDefined();
  });

  test("line coverage is partial (template block not fully exercised)", () => {
    const counter = findLocalCounter();
    expect(counter.lines.covered, "some lines covered").toBeGreaterThan(0);
    expect(counter.lines.pct, "line coverage is less than 100%").toBeLessThan(100);
  });
});

describe("addon counter.gjs (v2-addon-js/src/components/counter.gjs)", () => {
  function findAddonCounter() {
    const key = Object.keys(summary).find(
      (k) => k.endsWith("components/counter.gjs") && k.includes("v2-addon-js/src"),
    );
    return key ? summary[key] : undefined;
  }

  test("addon counter.gjs is included via the include option", () => {
    expect(findAddonCounter(), "addon counter.gjs entry exists").toBeDefined();
  });

  test("exactly 2 functions are uncovered (clampedCount, countAsString)", () => {
    const counter = findAddonCounter();
    const uncovered = counter.functions.total - counter.functions.covered;
    expect(uncovered, "clampedCount and countAsString should be the only uncovered functions").toBe(
      2,
    );
  });

  test("get label and increment ARE covered", () => {
    const counter = findAddonCounter();
    expect(
      counter.functions.covered,
      "at least get label + increment should be covered",
    ).toBeGreaterThanOrEqual(2);
  });

  test("line coverage is partial (template block not fully exercised)", () => {
    const counter = findAddonCounter();
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
    expect(findFormatScore(), "format-score.js entry exists").toBeDefined();
  });

  test("function is covered", () => {
    const entry = findFormatScore();
    expect(entry.functions.covered).toBeGreaterThanOrEqual(1);
  });

  test("line coverage is partial (score < 0 branch is intentionally uncovered)", () => {
    const entry = findFormatScore();
    expect(entry.lines.covered, "some lines are covered").toBeGreaterThan(0);
    expect(entry.lines.pct, "score < 0 branch is uncovered so coverage is below 100%").toBeLessThan(
      100,
    );
  });
});
