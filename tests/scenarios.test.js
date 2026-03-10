import { describe, test, expect } from "vitest";
import { readdirSync } from "node:fs";
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

for (const name of scenarios) {
  describe(name, () => {
    const scenarioDir = join(scenariosRoot, name);
    const snapshotDir = join(snapshotsRoot, name);

    test("coverage summary matches snapshot", async () => {
      runScenario(scenarioDir);

      const summary = readCoverageSummary(scenarioDir);
      const summaryText = readCoverageSummaryText(scenarioDir);

      await expect(JSON.stringify(summary, null, 2)).toMatchFileSnapshot(
        join(snapshotDir, "coverage-summary.json"),
      );
      await expect(summaryText).toMatchFileSnapshot(
        join(snapshotDir, "coverage-summary.txt"),
      );
    });
  });
}
