import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Run `pnpm test` inside a scenario directory.
 * Throws with stdout+stderr attached if the command exits non-zero.
 */
export function runScenario(scenarioDir: string): void {
  const result = spawnSync("pnpm", ["test"], {
    cwd: scenarioDir,
    encoding: "utf8",
    // Pipe both streams so we can include them in error messages.
    stdio: "pipe",
    // Give the subprocess 5 minutes before we kill it.
    timeout: 5 * 60 * 1000,
  });

  if (result.status !== 0) {
    throw new Error(
      `pnpm test failed in ${scenarioDir} (exit ${result.status})\n\nSTDOUT:\n${result.stdout}\n\nSTDERR:\n${result.stderr}`,
    );
  }
}

/**
 * Read coverage-summary.txt from a scenario's coverage folder.
 */
export function readCoverageSummaryText(scenarioDir: string): string {
  const txtPath = join(scenarioDir, "coverage", "coverage-summary.txt");

  if (!existsSync(txtPath)) {
    throw new Error(`coverage-summary.txt not found at ${txtPath}`);
  }

  return readFileSync(txtPath, "utf8");
}

/**
 * Read coverage-summary.json from a scenario's coverage folder and return a
 * normalised object whose keys are paths relative to the scenario root
 * (instead of absolute paths), making the snapshot machine-independent.
 */
export function readCoverageSummary(scenarioDir: string): Record<string, unknown> {
  const summaryPath = join(scenarioDir, "coverage", "coverage-summary.json");

  if (!existsSync(summaryPath)) {
    throw new Error(`coverage-summary.json not found at ${summaryPath}`);
  }

  const raw: Record<string, unknown> = JSON.parse(readFileSync(summaryPath, "utf8"));

  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      // Keep the 'total' sentinel as-is; normalise everything else.
      key === "total" ? "total" : relative(scenarioDir, key),
      value,
    ]),
  );
}
