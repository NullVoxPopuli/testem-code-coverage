/**
 * Converts a V8 precise coverage snapshot into an Istanbul coverage report.
 *
 * Usage:
 *   - As a module: import { generateReport } from './report.js';
 *                  await generateReport(v8Scripts);
 *   - Standalone:  node report.js
 *                  (reads coverage-data.json written by coverage-middleware)
 */

import path from "node:path";
import fs from "node:fs";
import { URL, fileURLToPath } from "node:url";
import v8ToIstanbul from "v8-to-istanbul";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function generateReport(v8Scripts, options = {}) {
  const distDir = options.distDir ?? path.join(process.cwd(), "dist");
  const coverageDir = options.coverageDir ?? path.join(process.cwd(), "coverage");
  // Only process local script files served by the testem dev server.
  const localScripts = v8Scripts.filter(
    (s) =>
      s.url &&
      s.url.includes("://localhost") &&
      s.url.endsWith(".js") &&
      // Skip testem's own injected runner
      !s.url.includes("/testem.js"),
  );

  if (localScripts.length === 0) {
    console.log("\n[coverage] No local scripts found in coverage snapshot.");
    return;
  }

  const coverageMap = libCoverage.createCoverageMap({});

  for (const script of localScripts) {
    let filePath;
    try {
      const parsed = new URL(script.url);
      filePath = path.join(distDir, parsed.pathname);
    } catch {
      continue;
    }

    if (!fs.existsSync(filePath)) continue;

    try {
      const source = fs.readFileSync(filePath, "utf8");
      const converter = v8ToIstanbul(filePath, 0, { source });
      await converter.load();
      converter.applyCoverage(script.functions);
      coverageMap.merge(converter.toIstanbul());
    } catch {
      // If a file can't be processed (e.g. no source map), skip it silently.
    }
  }

  // Remove noise: node_modules and Embroider internals.
  const filteredMap = libCoverage.createCoverageMap({});
  for (const file of coverageMap.files()) {
    if (!file.includes("node_modules") && !file.includes("/.embroider/")) {
      filteredMap.addFileCoverage(coverageMap.fileCoverageFor(file));
    }
  }

  if (filteredMap.files().length === 0) {
    console.log(
      "\n[coverage] No app-source coverage data after filtering — falling back to byte-level report.",
    );
    printByteReport(localScripts);
    return;
  }

  // --- Terminal output ---
  console.log("\n");
  const textContext = libReport.createContext({
    dir: coverageDir,
    coverageMap: filteredMap,
    watermarks: {
      statements: [50, 80],
      functions: [50, 80],
      branches: [50, 80],
      lines: [50, 80],
    },
  });
  reports.create("text").execute(textContext);

  // --- HTML report ---
  fs.mkdirSync(coverageDir, { recursive: true });
  const htmlContext = libReport.createContext({
    dir: coverageDir,
    coverageMap: filteredMap,
  });
  reports.create("html").execute(htmlContext);
  console.log(`\nHTML coverage report → ${path.join(coverageDir, "index.html")}\n`);
}

/**
 * Fallback: byte-level coverage using raw V8 range data.
 * Useful when source maps are absent or v8-to-istanbul cannot process a file.
 */
function printByteReport(scripts) {
  const W = { file: 50, used: 8, total: 9, pct: 7 };
  const sep = "─".repeat(W.file + W.used + W.total + W.pct);

  console.log("\n\x1b[1mCoverage Summary (byte-level)\x1b[0m");
  console.log(sep);
  console.log(
    "File".padEnd(W.file) +
      "Used B".padStart(W.used) +
      "Total B".padStart(W.total) +
      "     %".padStart(W.pct),
  );
  console.log(sep);

  let totalUsed = 0;
  let totalSize = 0;

  for (const script of scripts) {
    const { usedBytes, totalBytes } = computeBytecoverage(script.functions);
    totalUsed += usedBytes;
    totalSize += totalBytes;

    const pct = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
    const color = pct >= 80 ? "\x1b[32m" : pct >= 50 ? "\x1b[33m" : "\x1b[31m";
    const displayName = new URL(script.url).pathname.slice(1); // strip leading /

    console.log(
      displayName.slice(-W.file).padEnd(W.file) +
        usedBytes.toString().padStart(W.used) +
        totalBytes.toString().padStart(W.total) +
        `${color}${(pct + "%").padStart(W.pct)}\x1b[0m`,
    );
  }

  console.log(sep);
  const totalPct = totalSize > 0 ? Math.round((totalUsed / totalSize) * 100) : 0;
  console.log(
    "Total".padEnd(W.file) +
      totalUsed.toString().padStart(W.used) +
      totalSize.toString().padStart(W.total) +
      (totalPct + "%").padStart(W.pct),
  );
  console.log("");
}

function computeBytecoverage(functions) {
  // Collect all covered intervals, then merge them to avoid double-counting.
  let maxEnd = 0;
  const covered = [];

  for (const fn of functions) {
    for (const range of fn.ranges) {
      maxEnd = Math.max(maxEnd, range.endOffset);
      if (range.count > 0) {
        covered.push([range.startOffset, range.endOffset]);
      }
    }
  }

  covered.sort((a, b) => a[0] - b[0]);

  let usedBytes = 0;
  let cursor = 0;
  for (const [start, end] of covered) {
    const effectiveStart = Math.max(start, cursor);
    if (effectiveStart < end) {
      usedBytes += end - effectiveStart;
      cursor = end;
    }
  }

  return { usedBytes, totalBytes: maxEnd };
}
