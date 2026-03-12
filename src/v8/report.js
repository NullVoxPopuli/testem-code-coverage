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
import { parse as acornParse } from "acorn";
import { TraceMap, originalPositionFor } from "@jridgewell/trace-mapping";
import v8ToIstanbul from "v8-to-istanbul";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * V8's startPreciseCoverage does not force eager compilation of class methods.
 * A class method body that is never called is never compiled by V8 and thus
 * never appears in the coverage output. v8-to-istanbul then defaults those
 * uncovered bodies to the parent scope's count (usually 1), producing a false
 * "100% covered" result for never-called methods.
 *
 * This function parses the bundle with acorn, finds all class MethodDefinition
 * nodes whose byte range does NOT appear in the V8 functions array, and
 * returns synthetic V8 function entries with count=0 — but ONLY for methods
 * that source-map back to local application files (not node_modules or
 * framework internals). These synthetic entries are merged with the real V8
 * data before passing to v8-to-istanbul so that never-called class methods are
 * correctly marked as uncovered.
 */
function syntheticUncoveredMethods(source, v8Functions, filePath) {
  // Build a set of start offsets already present in V8 coverage data.
  // V8 uses the start of the method name as the startOffset (e.g., the 'i' in
  // 'increment()'), which matches acorn's MethodDefinition.start.
  const knownStarts = new Set(v8Functions.map((f) => f.ranges[0]?.startOffset));

  let ast;
  try {
    ast = acornParse(source, { ecmaVersion: "latest", sourceType: "module" });
  } catch {
    try {
      ast = acornParse(source, { ecmaVersion: "latest", sourceType: "script" });
    } catch {
      return [];
    }
  }

  // Load the source map for this bundle so we can filter by original source file.
  // If no source map exists we fall back to skipping synthetic injection entirely
  // (better than injecting for all bundled files indiscriminately).
  let tracer = null;
  const mapPath = filePath + ".map";
  if (fs.existsSync(mapPath)) {
    try {
      tracer = new TraceMap(JSON.parse(fs.readFileSync(mapPath, "utf8")));
    } catch {
      // malformed map — skip filtering
    }
  }

  // Build a line-start offset table so we can convert byte offsets → (line, col)
  // for source map lookups. Line numbers are 1-based, columns are 0-based.
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") lineStarts.push(i + 1);
  }

  function offsetToLineCol(offset) {
    let lo = 0,
      hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - lineStarts[lo] };
  }

  /** Returns true if the given original source URL is a local app file. */
  function isLocalSource(source) {
    if (!source) return false;
    // Exclude any file that comes from node_modules or Embroider's .embroider cache.
    return !source.includes("node_modules") && !source.includes("/.embroider/");
  }

  const synthetic = [];

  function walk(node) {
    if (!node || typeof node !== "object") return;

    if (node.type === "MethodDefinition" && node.value) {
      // acorn's MethodDefinition.start matches V8's startOffset for the method
      // (both point to the first character of the method name / 'get'/'set').
      if (!knownStarts.has(node.start)) {
        // Determine whether this method maps to a local app source file.
        let isLocal = true; // default: include when no source map available
        if (tracer) {
          const { line, column } = offsetToLineCol(node.start);
          const orig = originalPositionFor(tracer, { line, column });
          isLocal = isLocalSource(orig.source);
        }

        if (isLocal) {
          const kind = node.kind === "get" ? "get " : node.kind === "set" ? "set " : "";
          const name =
            node.key?.type === "Identifier"
              ? node.key.name
              : node.key?.type === "Literal"
                ? String(node.key.value)
                : "";
          synthetic.push({
            functionName: `${kind}${name}`,
            // Use the full MethodDefinition range so the synthetic entry spans the
            // same bytes that V8 would have reported.
            ranges: [{ startOffset: node.start, endOffset: node.end, count: 0 }],
            isBlockCoverage: false,
          });
        }
      }
    }

    for (const key of Object.keys(node)) {
      // Avoid circular walks via 'parent' or non-AST keys.
      if (key === "start" || key === "end" || key === "type") continue;
      const val = node[key];
      if (Array.isArray(val)) {
        for (const child of val) {
          if (child && typeof child === "object" && child.type) walk(child);
        }
      } else if (val && typeof val === "object" && val.type) {
        walk(val);
      }
    }
  }

  walk(ast);
  return synthetic;
}

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
      // Augment V8 data with synthetic count=0 entries for class methods that
      // V8 never compiled (never called) — they would otherwise default to the
      // parent scope's count=1, producing a false "100% covered" result.
      const synth = syntheticUncoveredMethods(source, script.functions, filePath);
      converter.applyCoverage([...script.functions, ...synth]);
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

  // --- HTML + JSON summary reports ---
  fs.mkdirSync(coverageDir, { recursive: true });
  const fileContext = libReport.createContext({
    dir: coverageDir,
    coverageMap: filteredMap,
  });
  reports.create("html").execute(fileContext);
  // json-summary writes coverage-summary.json — consumed by integration tests.
  reports.create("json-summary").execute(fileContext);
  // text report written to file mirrors the terminal table output.
  reports.create("text", { file: "coverage-summary.txt" }).execute(fileContext);
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
