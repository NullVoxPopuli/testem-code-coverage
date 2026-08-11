import { test, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateReport } from "../src/v8/report.js";

/**
 * Some published packages ship source maps whose `sources` are bare relative
 * paths. route-recognizer, for example, lists "route-recognizer/dsl.ts" —
 * a path relative to nothing that exists. When such a package is bundled into
 * the app, v8-to-istanbul resolves those entries against the bundle's own
 * directory, producing absolute paths that sit inside the project root but
 * point at no file. They used to survive filtering and show up in the report
 * with meaningless numbers, and the HTML reporter rendered an ENOENT stack
 * trace in place of the source. See issue #34.
 */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Base64 VLQ-encode a single signed integer. */
function vlq(value) {
  let rest = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = "";
  do {
    let digit = rest & 31;
    rest >>>= 5;
    if (rest > 0) digit |= 32;
    out += B64[digit];
  } while (rest > 0);
  return out;
}

/**
 * Build a `mappings` string from one segment per generated line.
 * @param {{sourceIndex: number, originalLine: number}[]} segments
 *   Index in the array is the generated line (0-based); every segment maps
 *   generated column 0 to original column 0.
 */
function encodeMappings(segments) {
  let prevSource = 0;
  let prevOriginalLine = 0;
  return segments
    .map(({ sourceIndex, originalLine }) => {
      const encoded =
        vlq(0) + vlq(sourceIndex - prevSource) + vlq(originalLine - 1 - prevOriginalLine) + vlq(0);
      prevSource = sourceIndex;
      prevOriginalLine = originalLine - 1;
      return encoded;
    })
    .join(";");
}

const REAL_SOURCE = ["export function real() {", "  return 1;", "}", "", "real();", ""].join("\n");

const PHANTOM_SOURCE = ["export function phantom() {", "  return 2;", "}", ""].join("\n");

const BUNDLE = [
  "function real() {",
  "  return 1;",
  "}",
  "function phantom() {",
  "  return 2;",
  "}",
  "real();",
  "",
].join("\n");

let tmpDir;
let originalCwd;
let summary;

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tcc-phantom-")));

  const bundleDir = path.join(tmpDir, "dist", "assets");
  fs.mkdirSync(bundleDir, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, "app"), { recursive: true });

  fs.writeFileSync(path.join(tmpDir, "app", "real.js"), REAL_SOURCE);
  fs.writeFileSync(
    path.join(bundleDir, "bundle.js"),
    BUNDLE + "//# sourceMappingURL=bundle.js.map\n",
  );
  fs.writeFileSync(
    path.join(bundleDir, "bundle.js.map"),
    JSON.stringify({
      version: 3,
      file: "bundle.js",
      // Source 0 is a real app file; source 1 is the bare relative path that
      // resolves to <bundleDir>/route-recognizer/dsl.ts — which never exists.
      sources: ["../../app/real.js", "route-recognizer/dsl.ts"],
      sourcesContent: [REAL_SOURCE, PHANTOM_SOURCE],
      names: [],
      mappings: encodeMappings([
        { sourceIndex: 0, originalLine: 1 },
        { sourceIndex: 0, originalLine: 2 },
        { sourceIndex: 0, originalLine: 3 },
        { sourceIndex: 1, originalLine: 1 },
        { sourceIndex: 1, originalLine: 2 },
        { sourceIndex: 1, originalLine: 3 },
        { sourceIndex: 0, originalLine: 5 },
      ]),
    }),
  );

  const offsetOf = (needle) => BUNDLE.indexOf(needle);
  const v8Scripts = [
    {
      url: "http://localhost:7357/assets/bundle.js",
      functions: [
        {
          functionName: "",
          isBlockCoverage: true,
          ranges: [{ startOffset: 0, endOffset: BUNDLE.length, count: 1 }],
        },
        {
          functionName: "real",
          isBlockCoverage: true,
          ranges: [
            {
              startOffset: offsetOf("function real"),
              endOffset: offsetOf("}\nfunction phantom") + 1,
              count: 1,
            },
          ],
        },
        {
          functionName: "phantom",
          isBlockCoverage: true,
          ranges: [
            {
              startOffset: offsetOf("function phantom"),
              endOffset: offsetOf("}\nreal();") + 1,
              count: 0,
            },
          ],
        },
      ],
    },
  ];

  process.chdir(tmpDir);
  await generateReport(v8Scripts, {
    distDir: path.join(tmpDir, "dist"),
    coverageDir: path.join(tmpDir, "coverage"),
    reporters: ["json-summary"],
  });

  summary = JSON.parse(fs.readFileSync(path.join(tmpDir, "coverage", "coverage-summary.json")));
});

afterAll(() => {
  if (originalCwd) process.chdir(originalCwd);
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("real app sources are still reported", () => {
  expect(Object.keys(summary)).toContain(path.join(tmpDir, "app", "real.js"));
});

test("source-mapped paths that do not exist on disk are dropped", () => {
  const missing = Object.keys(summary).filter((key) => key !== "total" && !fs.existsSync(key));
  expect(missing, "every reported file exists on disk").toEqual([]);
});
