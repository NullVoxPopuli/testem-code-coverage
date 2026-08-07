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

  test("methods exercised by the tests are covered (issue #22)", () => {
    const counter = findLocalCounter();
    // `get label` and `increment` are both exercised by the rendering tests.
    // Before coverage deltas were merged across takePreciseCoverage calls,
    // their counts were wiped by the periodic cache poll and this reported 0.
    expect(counter.functions.covered, "label + increment are covered").toBeGreaterThanOrEqual(2);
  });

  test("tree-shaken unusedNonClassFunction is uncovered (issue #22)", () => {
    const counter = findLocalCounter();
    // unusedNonClassFunction is unexported and never called, so the bundler
    // removes it from the build entirely. It must still be reported as an
    // uncovered function, not default to covered. Together with the two
    // never-called class methods that makes at least 3 uncovered functions —
    // without tree-shake detection there are only 2.
    const uncovered = counter.functions.total - counter.functions.covered;
    expect(
      uncovered,
      "clampedCount + countAsString + unusedNonClassFunction",
    ).toBeGreaterThanOrEqual(3);
  });
});

describe("store.js (app/services/store.js)", () => {
  function findStore() {
    const key = Object.keys(summary).find((k) => k === "app/services/store.js");
    return key ? summary[key] : undefined;
  }

  test("exists in coverage report", () => {
    expect(findStore(), "store.js entry exists").toBeDefined();
  });

  test("tree-shaken unusedTestFunction is uncovered (issue #22)", () => {
    const store = findStore();
    // unusedTestFunction is the only function in the file. It is unexported
    // and never called, so the bundler tree-shakes it out of the build — no
    // compiled code maps back to its lines. It must be reported as an
    // uncovered function with its lines uncovered, not default to covered.
    expect(store.functions.total, "the eliminated function is tracked").toBeGreaterThanOrEqual(1);
    expect(store.functions.covered, "no functions covered").toBe(0);
    expect(store.lines.pct, "its lines are uncovered").toBeLessThan(100);
  });
});

describe("tracked-box.js (app/utils/tracked-box.js)", () => {
  function findTrackedBox() {
    const key = Object.keys(summary).find((k) => k === "app/utils/tracked-box.js");
    return key ? summary[key] : undefined;
  }

  test("exists in coverage report", () => {
    expect(findTrackedBox(), "tracked-box.js entry exists").toBeDefined();
  });

  test("fully exercised class reports 100% functions (issue #29)", () => {
    const box = findTrackedBox();
    // The compiled class contains helper functions that do not exist in the
    // source (decorator static block, <instance_members_initializer>). Those
    // must not appear in the functions metric: the only function is the
    // `doubled` getter, and it is covered.
    expect(box.functions.total, "only the getter is a function").toBe(1);
    expect(box.functions.pct, "100% functions").toBe(100);
    expect(box.lines.pct, "100% lines").toBe(100);
    expect(box.statements.pct, "100% statements").toBe(100);
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

  test("has partial function coverage (clampedCount and countAsString are always uncovered)", () => {
    const counter = findAddonCounter();
    // clampedCount and countAsString are never called, so function coverage is never 100%.
    // V8's nondeterministic JIT may or may not track get label/increment as separate
    // function entries, so we check pct rather than exact covered/uncovered counts.
    expect(counter.functions.total, "at least 2 functions tracked").toBeGreaterThanOrEqual(2);
    expect(counter.functions.pct, "function coverage below 100%").toBeLessThan(100);
  });

  test("line coverage is partial (template block not fully exercised)", () => {
    const counter = findAddonCounter();
    expect(counter.lines.covered, "some lines covered").toBeGreaterThan(0);
    expect(counter.lines.pct, "line coverage is less than 100%").toBeLessThan(100);
  });

  test("methods exercised by the tests are covered (issue #22)", () => {
    const counter = findAddonCounter();
    expect(counter.functions.covered, "label + increment are covered").toBeGreaterThanOrEqual(2);
  });
});

test("embroider virtual modules are excluded from the report", () => {
  const embroiderKeys = Object.keys(summary).filter((k) => k.includes("@embroider/"));
  expect(embroiderKeys, "no @embroider virtual-module entries").toEqual([]);
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
