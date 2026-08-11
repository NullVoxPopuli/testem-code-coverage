import { test, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario, readCoverageSummary, readCoverageFiles, dependencyFiles } from "./helpers.ts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scenarioDir = join(repoRoot, "test-scenarios", "vite-app-js");

let summary;
let files;

beforeAll(() => {
  runScenario(scenarioDir);
  summary = readCoverageSummary(scenarioDir);
  files = readCoverageFiles(scenarioDir);
});

test("coverage directory was created", () => {
  expect(existsSync(join(scenarioDir, "coverage")), "coverage directory was created").toBe(true);
});

test("custom reporters only write the requested artifacts", () => {
  expect(
    existsSync(join(scenarioDir, "coverage", "coverage-summary.json")),
    "json-summary output exists",
  ).toBe(true);
  expect(existsSync(join(scenarioDir, "coverage", "lcov.info")), "lcov output exists").toBe(true);
  expect(
    existsSync(join(scenarioDir, "coverage", "coverage-summary.txt")),
    "text summary is omitted when text reporter is not configured",
  ).toBe(false);
  expect(
    existsSync(join(scenarioDir, "coverage", "index.html")),
    "html report is omitted when html reporter is not configured",
  ).toBe(false);
});

test("coverage summary has entries", () => {
  const keys = Object.keys(summary).filter((k) => k !== "total");
  expect(keys.length, "at least one file entry in coverage").toBeGreaterThan(0);
});

test("app source files are reported", () => {
  expect(summary["app/utils/format-score.js"], "format-score.js").toBeDefined();
  expect(summary["app/utils/match-route.js"], "match-route.js").toBeDefined();
  expect(summary["app/components/counter.gjs"], "counter.gjs").toBeDefined();
});

test("no dependency files are reported", () => {
  // The app runs plenty of node_modules code during a test run — ember-source,
  // @glimmer, and route-recognizer are all executed and all collect V8
  // coverage. None of it belongs in the report.
  expect(dependencyFiles(files), "no node_modules files in the report").toEqual([]);
});

test("dependency sources do not leak in under a project-local path", () => {
  // route-recognizer is exercised by app/utils/match-route.js. Its published
  // source map lists bare relative `sources` ("route-recognizer/dsl.ts", …),
  // which resolve against the app bundle's own directory and therefore look
  // project-local rather than node_modules-shaped. See issue #34.
  const leaked = files.filter((file) => /route-recognizer|ember-source|@glimmer/.test(file));
  expect(leaked, "no dependency sources under a project-local path").toEqual([]);
});

test("every reported file exists on disk (issue #34)", () => {
  // A path the reporters cannot read renders an ENOENT stack trace instead of
  // source in the HTML report, and its numbers are meaningless.
  expect(files.filter((file) => !existsSync(file))).toEqual([]);
});
