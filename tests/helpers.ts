import { spawnSync } from "node:child_process";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Run `pnpm <script>` (default: `test`) inside a scenario directory.
 * Throws with stdout+stderr attached if the command exits non-zero.
 */
export function runScenario(scenarioDir: string, script = "test"): void {
  const result = spawnSync("pnpm", [script], {
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
 * Strips the "% Branch" column from each row to avoid non-deterministic
 * V8 JIT branch counts causing snapshot churn.
 */
export function readCoverageSummaryText(scenarioDir: string): string {
  const txtPath = join(scenarioDir, "coverage", "coverage-summary.txt");

  if (!existsSync(txtPath)) {
    throw new Error(`coverage-summary.txt not found at ${txtPath}`);
  }

  const raw = readFileSync(txtPath, "utf8");

  // Each line is pipe-delimited: File | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s
  // Remove % Branch (index 2) and Uncovered Line #s (last column) — both are non-deterministic
  // due to V8's tiered JIT compilation varying between runs.
  return raw
    .split("\n")
    .map((line) => {
      const cols = line.split("|");
      if (cols.length < 4) return line;
      return [...cols.slice(0, 2), ...cols.slice(3, -1)].join("|");
    })
    .join("\n");
}

type FileCoverage = Record<
  string,
  { total: number; covered: number; skipped: number; pct: number }
>;

/** Remove branch metrics from a single file's coverage entry. */
function dropBranches(entry: unknown): unknown {
  if (typeof entry !== "object" || entry === null) return entry;
  const { branches: _b, branchesTrue: _bt, ...rest } = entry as Record<string, FileCoverage>;
  return rest;
}

/**
 * Read coverage-summary.json from a scenario's coverage folder and return a
 * normalised object whose keys are paths relative to the scenario root
 * (instead of absolute paths), making the snapshot machine-independent.
 * Branch counts are omitted — they are non-deterministic across runs due to
 * V8's tiered JIT compilation.
 */
export function readCoverageSummary(
  scenarioDir: string,
  coverageDir = "coverage",
): Record<string, unknown> {
  const summaryPath = join(scenarioDir, coverageDir, "coverage-summary.json");

  if (!existsSync(summaryPath)) {
    throw new Error(`coverage-summary.json not found at ${summaryPath}`);
  }

  const raw: Record<string, unknown> = JSON.parse(readFileSync(summaryPath, "utf8"));

  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      // Keep the 'total' sentinel as-is; normalise everything else.
      key === "total" ? "total" : relative(scenarioDir, key),
      dropBranches(value),
    ]),
  );
}

/**
 * Absolute paths of every file in a scenario's coverage-summary.json,
 * without the `total` sentinel.
 */
export function readCoverageFiles(scenarioDir: string, coverageDir = "coverage"): string[] {
  const summaryPath = join(scenarioDir, coverageDir, "coverage-summary.json");

  if (!existsSync(summaryPath)) {
    throw new Error(`coverage-summary.json not found at ${summaryPath}`);
  }

  const raw: Record<string, unknown> = JSON.parse(readFileSync(summaryPath, "utf8"));

  return Object.keys(raw).filter((key) => key !== "total");
}

/**
 * Of the given reported files, the ones that belong to a third-party
 * dependency and therefore should never have been reported.
 *
 * A node_modules path on its own proves nothing: pnpm symlinks every package
 * in this repo's workspace into the consuming scenario's node_modules, and
 * those ARE files we want covered. Resolving symlinks first tells the two
 * apart — a package installed from the registry still sits inside a
 * node_modules directory after resolution, while a package that lives in this
 * git repo resolves back to its checked-in source.
 */
export function dependencyFiles(files: string[]): string[] {
  return files.filter((file) => {
    if (!file.split(sep).includes("node_modules")) return false;

    let resolved: string;
    try {
      resolved = realpathSync(file);
    } catch {
      // Unresolvable, but it named node_modules — certainly not app code.
      return true;
    }

    return resolved.split(sep).includes("node_modules");
  });
}
