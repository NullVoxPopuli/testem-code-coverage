import { test, expect, beforeAll } from "vitest";
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

// vite-app-js currently only produces coverage for embroider virtual files
// (dist/@embroider/virtual/*), not for actual app source files.
// This is a known limitation — the scenario validates that the coverage
// pipeline runs end-to-end even when source maps don't resolve to local files.

test("coverage summary has entries", () => {
  const keys = Object.keys(summary).filter((k) => k !== "total");
  expect(keys.length, "at least one file entry in coverage").toBeGreaterThan(0);
});
