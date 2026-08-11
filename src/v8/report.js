/**
 * Converts a V8 precise coverage snapshot into an Istanbul coverage report.
 */

import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { URL } from "node:url";
import { parse as acornParse } from "acorn";
import { TraceMap, originalPositionFor, eachMapping } from "@jridgewell/trace-mapping";
import v8ToIstanbul from "v8-to-istanbul";
import libCoverage from "istanbul-lib-coverage";
import libReport from "istanbul-lib-report";
import reports from "istanbul-reports";
import picomatch from "picomatch";

const DEFAULT_REPORTERS = ["text", "html", "json-summary"];

/**
 * Resolve package names (e.g. "my-addon", "@scope/pkg") to their absolute
 * directories, using `createRequire` anchored at the project root
 * (process.cwd()).  Only packages that are directly resolvable from the
 * project root are considered — nested/transitive dependencies that are not
 * hoisted are silently skipped.
 *
 * @param {string[]} include  Package names from the `include` option.
 * @param {string}   cwd      Project root directory.
 * @returns {Promise<{dir: string, name: string}[]>} Objects with absolute
 *   directory path (ending with "/") and the package name.
 */
async function resolveIncludedPaths(include, cwd) {
  if (!include || include.length === 0) return [];

  // Use createRequire anchored at the project root so resolution walks
  // node_modules from there, not from this library's own location.
  const require = createRequire(path.join(cwd, "package.json"));
  const results = [];

  for (const name of include) {
    try {
      const resolvedPath = require.resolve(name);

      // Walk up to the package root inside node_modules.
      // e.g. /proj/node_modules/my-pkg/dist/index.js → /proj/node_modules/my-pkg/
      //      /proj/node_modules/@scope/pkg/dist/index.js → /proj/node_modules/@scope/pkg/
      const marker = "/node_modules/";
      const nmIdx = resolvedPath.indexOf(marker);
      if (nmIdx !== -1) {
        const afterNm = resolvedPath.slice(nmIdx + marker.length);
        const parts = afterNm.split("/");
        const pkgName = parts[0].startsWith("@") && parts[1] ? parts[0] + "/" + parts[1] : parts[0];
        results.push({
          dir: resolvedPath.slice(0, nmIdx + marker.length) + pkgName + "/",
          name: pkgName,
        });
      } else {
        // Workspace package or local path — the resolved path is the package's
        // main entry (e.g. /proj/packages/my-pkg/src/index.js). Walk up from the
        // resolved file to find the directory that contains package.json; that is
        // the package root.
        let dir = path.dirname(resolvedPath);
        let pkgRoot = null;
        let depth = 0;
        const maxDepth = 20; // guard against infinite loops on unusual filesystems
        while (dir !== path.dirname(dir) && depth < maxDepth) {
          if (fs.existsSync(path.join(dir, "package.json"))) {
            pkgRoot = dir;
            break;
          }
          dir = path.dirname(dir);
          depth++;
        }
        if (!pkgRoot) {
          console.warn(
            `[coverage] Could not find package.json for "${name}" — using resolved file directory as fallback.`,
          );
        }
        results.push({
          dir: (pkgRoot ?? path.dirname(resolvedPath)) + path.sep,
          name,
        });
      }
    } catch (err) {
      console.warn(
        `[coverage] Could not resolve included package "${name}" from project root — skipping. (${err.message})`,
      );
    }
  }

  return results;
}

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
function syntheticUncoveredMethods(
  source,
  v8Functions,
  diag = () => {},
  includedPaths = [],
  tracer = null,
) {
  // Build a set of start offsets already present in V8 coverage data.
  // V8 uses the start of the method name as the startOffset (e.g., the 'i' in
  // 'increment()'), which matches acorn's MethodDefinition.start.
  const knownStarts = new Set(v8Functions.map((f) => f.ranges[0]?.startOffset));

  // Diagnostic: collect local method ranges for post-walk nearby-V8-function logging.
  const localMethodRanges = [];

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

  // Build a map from original source URL → Set of line numbers that V8 covers
  // with count > 0. When a method's source map position is in this set, V8 has
  // already tracked it as covered — even if its BUNDLE position doesn't exactly
  // match acorn's MethodDefinition.start. This handles build configurations such
  // as babelHelpers:'inline' or decorator-transforms that produce compiled output
  // where V8 tracks methods at different byte offsets than what acorn sees.
  //
  // We scan ALL ranges within each V8 function entry, not just ranges[0]. With
  // `detailed: true` block-level coverage, each function entry contains sub-ranges
  // with independent counts. When V8 does not create a separate function entry for
  // a class method (e.g. due to lazy-compilation under babelHelpers:'runtime'),
  // it still emits block-level sub-ranges for the executed code inside the
  // containing function. These sub-ranges have the method's start offset and
  // count > 0, allowing us to detect coverage even without a dedicated V8 entry.
  const coveredLinesBySource = new Map(); // source → Set<line>
  if (tracer) {
    for (const fn of v8Functions) {
      for (const range of fn.ranges) {
        if ((range.count ?? 0) > 0) {
          const { line, column } = offsetToLineCol(range.startOffset);
          const orig = originalPositionFor(tracer, { line, column });
          if (orig.source && orig.line != null) {
            let lines = coveredLinesBySource.get(orig.source);
            if (!lines) {
              lines = new Set();
              coveredLinesBySource.set(orig.source, lines);
            }
            lines.add(orig.line);
          }
        }
      }
    }
  }

  /** Returns true if the given original source URL is a local app file or an explicitly included package. */
  function isLocalSource(source) {
    if (!source) return false;
    if (!source.includes("node_modules") && !source.includes("/.embroider/")) return true;
    // Allow files from explicitly included packages.  We check both:
    //  1. Absolute path prefix match (works when Vite resolves workspace deps to
    //     real paths: /proj/packages/my-pkg/src/... )
    //  2. 'node_modules/<pkg>/' segment match (works when the source map uses the
    //     symlinked path: ../../node_modules/my-pkg/src/...)
    return includedPaths.some((pkgDir) => {
      const marker = "/node_modules/";
      const nmIdx = pkgDir.indexOf(marker);
      if (nmIdx === -1) {
        // Workspace / real-path package: check absolute prefix.
        return source.startsWith(pkgDir);
      }
      // node_modules package: check for the 'node_modules/<pkg>/' segment.
      const pkgSegment = pkgDir.slice(nmIdx + 1); // e.g. "node_modules/my-pkg/"
      return source.includes(pkgSegment);
    });
  }

  const synthetic = [];

  function walk(node) {
    if (!node || typeof node !== "object") return;

    if (node.type === "MethodDefinition" && node.value) {
      // V8 typically uses node.start (including the 'get'/'set' keyword) as the
      // startOffset for getter/setter methods, matching acorn's MethodDefinition.start.
      // However, some Chrome versions / platforms use node.key.start (the method name
      // position, without the 'get'/'set' keyword prefix) instead. We check both to
      // avoid false-positive synthetic entries when V8 uses key.start.
      const kind = node.kind === "get" ? "get " : node.kind === "set" ? "set " : "";
      const name =
        node.key?.type === "Identifier"
          ? node.key.name
          : node.key?.type === "Literal"
            ? String(node.key.value)
            : "";
      const methodLabel = `${kind}${name}`;
      const keyStart = node.key?.start ?? node.start;
      // Primary check: exact bundle-position match between acorn MethodDefinition
      // and V8 function start (most reliable on all platforms).
      // Fallback: source-map based check — if V8 has already covered the original
      // source line that this MethodDefinition maps to (with count > 0), the method
      // IS tracked by V8 (just at a different bundle position). This handles build
      // configurations like babelHelpers:'inline' or decorator-transforms that produce
      // compiled output where V8 and acorn disagree on byte positions.
      let origSource = null;
      let origLine = null;
      if (tracer) {
        const { line, column } = offsetToLineCol(node.start);
        const orig = originalPositionFor(tracer, { line, column });
        origSource = orig.source;
        origLine = orig.line;
      }
      const coveredBySourceMap = coveredLinesBySource.get(origSource)?.has(origLine) ?? false;
      const inV8 = knownStarts.has(node.start) || knownStarts.has(keyStart) || coveredBySourceMap;

      if (!inV8) {
        // Determine whether this method maps to a local app source file.
        const isLocal = tracer ? isLocalSource(origSource) : true;
        // Only log local-source methods to keep diagnostics concise.
        if (isLocal) {
          diag(
            `  MethodDef ${methodLabel} @${node.start} (key@${keyStart}) NOT in V8 — local=true source=${origSource}`,
          );
          localMethodRanges.push({
            label: methodLabel,
            start: node.start,
            end: node.end,
          });
          synthetic.push({
            functionName: methodLabel,
            // Use the full MethodDefinition range so the synthetic entry spans the
            // same bytes that V8 would have reported.
            ranges: [{ startOffset: node.start, endOffset: node.end, count: 0 }],
            isBlockCoverage: false,
          });
        }
      } else {
        // Method IS in V8 — log it for diagnostics.
        const v8fn = v8Functions.find(
          (f) => f.ranges[0]?.startOffset === node.start || f.ranges[0]?.startOffset === keyStart,
        );
        const localForLog = tracer ? isLocalSource(origSource) : false;
        if (localForLog) {
          if (v8fn) {
            diag(
              `  MethodDef ${methodLabel} @${node.start} (key@${keyStart}) in V8 count=${v8fn.ranges[0]?.count} name="${v8fn.functionName}"`,
            );
          } else if (coveredBySourceMap) {
            diag(
              `  MethodDef ${methodLabel} @${node.start} (key@${keyStart}) in V8 via source-map (source=${origSource}:${origLine})`,
            );
          }
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

  // For each local method that was NOT found in V8, log the nearest V8 functions
  // within ±500 bytes of the expected offset. This helps identify cases where V8
  // reports the function at a slightly different startOffset than acorn's AST.
  if (localMethodRanges.length > 0) {
    for (const { label, start } of localMethodRanges) {
      const nearby = v8Functions
        .filter((f) => {
          const s = f.ranges[0]?.startOffset ?? -1;
          return s >= start - 500 && s <= start + 500;
        })
        .map(
          (f) => `  @${f.ranges[0]?.startOffset} count=${f.ranges[0]?.count} "${f.functionName}"`,
        );
      if (nearby.length > 0) {
        diag(`  V8 functions near ${label} @${start}: ${nearby.join(" | ")}`);
      } else {
        diag(`  V8 functions near ${label} @${start}: (none within ±500 bytes)`);
      }
    }
  }

  return synthetic;
}

/**
 * Record which original-source lines have at least one mapping segment in the
 * given bundle's source map. Used to detect code the bundler eliminated:
 * tree-shaken functions have NO mapping anywhere, so no V8 data can ever
 * reach them and v8-to-istanbul defaults their lines to covered.
 *
 * @param {TraceMap} tracer     Parsed source map of one bundle.
 * @param {string}   bundleDir  Directory of the bundle file (map paths are
 *                              relative to it).
 * @param {Map<string, Set<number>>} into  source path → mapped line numbers.
 */
function collectMappedLines(tracer, bundleDir, into) {
  eachMapping(tracer, (m) => {
    if (m.source == null || m.originalLine == null) return;
    const abs = path.resolve(bundleDir, m.source);
    let lines = into.get(abs);
    if (!lines) {
      lines = new Set();
      into.set(abs, lines);
    }
    lines.add(m.originalLine);
  });
}

/**
 * Blank out `<template>…</template>` spans so acorn can parse .gjs/.gts
 * files. Every span is replaced by "0" (valid in both expression position and
 * as a class member) padded with spaces; newlines are preserved so line and
 * column numbers stay identical to the original file.
 *
 * Returns the blanked source plus the line span of each template — templates
 * compile to functions, so they count as function containers when
 * reconciling V8 function entries with the original source.
 */
function stripGlimmerTemplates(source) {
  let out = "";
  let i = 0;
  let line = 1;
  const templateSpans = [];
  const countLines = (from, to) => {
    for (let k = from; k < to; k++) if (source[k] === "\n") line++;
  };
  for (;;) {
    const open = source.indexOf("<template", i);
    if (open === -1) {
      out += source.slice(i);
      break;
    }
    const close = source.indexOf("</template>", open);
    if (close === -1) {
      out += source.slice(i);
      break;
    }
    const end = close + "</template>".length;
    out += source.slice(i, open);
    out += "0" + source.slice(open + 1, end).replace(/[^\n]/g, " ");
    countLines(i, open);
    const start = line;
    countLines(open, end);
    templateSpans.push({ start, end: line });
    i = end;
  }
  return { source: out, templateSpans };
}

/**
 * Blank out decorators (`@tracked`, `@action`, `@service('store')`, …) so
 * acorn — which does not support the decorator proposal — can parse original
 * source files. Only parse-validity matters here, not semantics: the `@`,
 * the (possibly dotted) decorator name, and a balanced call-argument group
 * are replaced by spaces, preserving all offsets. An `@` inside a string
 * (e.g. an email address) also gets blanked, which changes that string's
 * value but never its syntax.
 */
function stripDecorators(source) {
  const chars = Array.from(source);
  const isIdent = (c) => /[\w$]/.test(c);

  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "@" || !isIdent(chars[i + 1] ?? "")) continue;

    let j = i + 1;
    while (j < chars.length && (isIdent(chars[j]) || (chars[j] === "." && isIdent(chars[j + 1])))) {
      j++;
    }
    if (chars[j] === "(") {
      let depth = 0;
      do {
        if (chars[j] === "(") depth++;
        else if (chars[j] === ")") depth--;
        j++;
      } while (j < chars.length && depth > 0);
    }
    for (let k = i; k < j; k++) {
      if (chars[k] !== "\n") chars[k] = " ";
    }
    i = j - 1;
  }
  return chars.join("");
}

/** AST walk helper — visits every node, skipping location bookkeeping keys. */
function walkAst(node, visit) {
  if (!node || typeof node !== "object") return;
  if (visit(node) === false) return;
  for (const key of Object.keys(node)) {
    if (key === "start" || key === "end" || key === "type" || key === "loc") continue;
    const val = node[key];
    if (Array.isArray(val)) {
      for (const child of val) {
        if (child && typeof child === "object" && child.type) walkAst(child, visit);
      }
    } else if (val && typeof val === "object" && val.type) {
      walkAst(val, visit);
    }
  }
}

/**
 * Reconcile an Istanbul FileCoverage with the file's ORIGINAL source, fixing
 * two classes of wrong data that pure V8-side processing cannot see:
 *
 * 1. Compiled-artifact functions (issue #29). The build output contains
 *    functions that do not exist in the source — decorator static blocks,
 *    `<instance_members_initializer>`, implicit constructors, template
 *    `scope` thunks. Their source-mapped positions land on class headers or
 *    field lines, so a fully-covered class reports e.g. "4/6 functions" with
 *    an uncovered range on `extends`. Every function entry whose declaration
 *    is not inside a real function span of the original source (function /
 *    arrow / method / user-written static block / `<template>` tag) is
 *    removed — the functions metric then counts only functions the user
 *    actually wrote.
 *
 * 2. Bundler-eliminated (tree-shaken) code (issue #22). An unexported,
 *    unreferenced function is dead-code-eliminated: no compiled code exists,
 *    the source map has no segments for its lines, and v8-to-istanbul
 *    defaults those lines to covered. Declaration spans with no mapping
 *    segment in ANY bundle get their statement counts zeroed and an
 *    uncovered function entry added. Spans with even one mapped line are
 *    left alone: the bundle kept them, so real V8 data (or the
 *    synthetic-method pass) already decides their coverage.
 *
 * Files that cannot be read or parsed are left untouched.
 *
 * @param {import('istanbul-lib-coverage').FileCoverage} fc
 * @param {string}           filePath     Absolute path of the original file.
 * @param {Set<number>|undefined} mappedLines  Lines with mapping segments.
 * @param {(msg: string) => void} diag
 */
function reconcileWithOriginalSource(fc, filePath, mappedLines, diag) {
  // No mapping info at all → nothing reliable to reconcile against.
  if (!mappedLines) return;

  let source;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  let templateSpans = [];
  if (/\.g[jt]s$/.test(filePath)) {
    ({ source, templateSpans } = stripGlimmerTemplates(source));
  }
  source = stripDecorators(source);

  let ast;
  const acornOptions = { ecmaVersion: "latest", locations: true };
  try {
    ast = acornParse(source, { ...acornOptions, sourceType: "module" });
  } catch {
    try {
      ast = acornParse(source, { ...acornOptions, sourceType: "script" });
    } catch {
      return;
    }
  }

  // ── 1. Prune compiled-artifact function entries ─────────────────────────
  // Function containers: every construct in the original source that
  // actually compiles to a function, at any nesting depth.
  const containers = templateSpans.slice();
  walkAst(ast, (node) => {
    switch (node.type) {
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
      case "MethodDefinition":
      case "StaticBlock":
        containers.push({ start: node.loc.start.line, end: node.loc.end.line });
    }
  });

  for (const [key, fn] of Object.entries(fc.data.fnMap)) {
    const line = fn.decl?.start?.line;
    const isReal = containers.some((c) => line >= c.start && line <= c.end);
    if (!isReal) {
      diag(
        `  compiled-artifact function dropped: ${fn.name} @L${line} count=${fc.data.f[key]} in ${filePath}`,
      );
      delete fc.data.fnMap[key];
      delete fc.data.f[key];
    }
  }

  // ── 2. Mark bundler-eliminated declarations as uncovered ────────────────
  // Candidate spans: declaration-position constructs only, without recursing
  // into a recorded node — when an outer function was eliminated, its inner
  // functions are gone with it and one uncovered entry is enough.
  const eliminationSpans = [];
  walkAst(ast, (node) => {
    let name = null;
    if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") {
      name = node.id?.name ?? "(anonymous)";
    } else if (
      node.type === "VariableDeclarator" &&
      (node.init?.type === "FunctionExpression" || node.init?.type === "ArrowFunctionExpression")
    ) {
      name = node.id?.name ?? "(anonymous)";
    }
    if (name !== null) {
      eliminationSpans.push({ name, start: node.loc.start.line, end: node.loc.end.line });
      return false;
    }
  });

  for (const span of eliminationSpans) {
    let mapped = false;
    for (let line = span.start; line <= span.end; line++) {
      if (mappedLines.has(line)) {
        mapped = true;
        break;
      }
    }
    if (mapped) continue;

    diag(`  eliminated by bundler: ${span.name} lines ${span.start}-${span.end} in ${filePath}`);

    for (const [key, stmt] of Object.entries(fc.data.statementMap)) {
      if (stmt.start.line >= span.start && stmt.start.line <= span.end) {
        fc.data.s[key] = 0;
      }
    }

    const fnKeys = Object.keys(fc.data.fnMap).map(Number);
    const next = fnKeys.length > 0 ? Math.max.apply(null, fnKeys) + 1 : 0;
    const loc = {
      start: { line: span.start, column: 0 },
      end: { line: span.end, column: 0 },
    };
    fc.data.fnMap[next] = { name: span.name, decl: loc, loc, line: span.start };
    fc.data.f[next] = 0;
  }
}

const DEFAULT_EXCLUDE = [
  "**/tests/**",
  "**/node_modules/**",
  "**/.embroider/**",
  // Embroider-generated virtual modules (e.g. dist/@embroider/virtual/vendor.js)
  "**/@embroider/**",
  "**/embroider-implicit-modules/**",
  "**/-embroider-*",
];

export async function generateReport(v8Scripts, options = {}) {
  const distDir = path.resolve(options.distDir ?? "dist");
  const coverageDir = options.coverageDir ?? path.join(process.cwd(), "coverage");
  const cwd = process.cwd();
  const excludePatterns = options.exclude ?? DEFAULT_EXCLUDE;
  const configuredReporters = options.reporters;
  const effectiveReporters = configuredReporters ?? DEFAULT_REPORTERS;
  // dot:true so patterns match dot-directories like ".embroider" — without it
  // picomatch skips dotfile segments and the "**/.embroider/**" default
  // exclude never matches.
  const isExcluded =
    excludePatterns.length > 0 ? picomatch(excludePatterns, { dot: true }) : () => false;

  // Resolve any explicitly included package names to their directories
  // so they survive the node_modules filter step below.
  const includedPackages = await resolveIncludedPaths(options.include ?? [], cwd);
  const includedPaths = includedPackages.map((p) => p.dir);
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

  const debug = options.debug ?? false;
  const diagLines = [];
  function diag(...args) {
    const line = args.join(" ");
    diagLines.push(line);
    if (debug) console.log("[coverage-diag]", line);
  }

  const coverageMap = libCoverage.createCoverageMap({});
  // original source path → line numbers with at least one mapping segment in
  // any bundle. Lines outside this set were eliminated from the build.
  const mappedLinesBySource = new Map();

  for (const script of localScripts) {
    let filePath;
    try {
      const parsed = new URL(script.url);
      filePath = path.resolve(distDir, parsed.pathname.slice(1));
    } catch {
      continue;
    }

    if (!filePath.startsWith(distDir + path.sep) && filePath !== distDir) continue;
    if (!fs.existsSync(filePath)) continue;

    try {
      const source = fs.readFileSync(filePath, "utf8");
      diag(
        `script: ${script.url} — ${script.functions.length} V8 functions, covered: ${script.functions.filter((f) => f.ranges[0]?.count > 0).length}`,
      );

      // Load the bundle's source map once — used to filter synthetic entries
      // by original source and to detect bundler-eliminated code. A missing
      // or malformed map leaves tracer null; both consumers handle that.
      let tracer = null;
      const mapPath = filePath + ".map";
      if (fs.existsSync(mapPath)) {
        try {
          tracer = new TraceMap(JSON.parse(fs.readFileSync(mapPath, "utf8")));
        } catch {
          // malformed map — skip map-based filtering
        }
      }
      if (tracer) {
        collectMappedLines(tracer, path.dirname(filePath), mappedLinesBySource);
      }

      const converter = v8ToIstanbul(filePath, 0, { source });
      await converter.load();
      // Augment V8 data with synthetic count=0 entries for class methods that
      // V8 never compiled (never called) — they would otherwise default to the
      // parent scope's count=1, producing a false "100% covered" result.
      const synth = syntheticUncoveredMethods(
        source,
        script.functions,
        diag,
        includedPaths,
        tracer,
      );
      if (synth.length > 0) {
        diag(
          `  → ${synth.length} synthetic entries added: ${synth.map((s) => s.functionName).join(", ")}`,
        );
      }
      converter.applyCoverage([...script.functions, ...synth]);
      coverageMap.merge(converter.toIstanbul());
    } catch (err) {
      diag(`  → ERROR processing ${script.url}: ${err.message}`);
      // If a file can't be processed (e.g. no source map), skip it silently.
    }
  }

  // Remove noise: keep only files under the project root or in explicitly
  // included packages.  This filters out node_modules, Embroider internals,
  // and any library source files that leaked in via source maps.
  const cwdPrefix = cwd.endsWith(path.sep) ? cwd : cwd + path.sep;
  const filteredMap = libCoverage.createCoverageMap({});

  /** If `file` belongs to an included package, return that package; else undefined. */
  function findIncludedPackage(file) {
    return includedPackages.find((pkg) => {
      // Direct absolute-path match (real path or workspace symlink).
      if (file.startsWith(pkg.dir)) return true;
      // node_modules symlink: check for 'node_modules/<name>/' segment.
      if (file.includes(`/node_modules/${pkg.name}/`)) return true;
      return false;
    });
  }

  for (const file of coverageMap.files()) {
    // Third-party packages sometimes ship source maps whose `sources` are bare
    // relative paths (route-recognizer's are "route-recognizer/dsl.ts", …).
    // v8-to-istanbul resolves those against the bundle's directory, so they
    // land inside the project root and survive every filter below even though
    // no such file exists. The resulting entries carry meaningless numbers and
    // make the HTML reporter render an ENOENT stack trace instead of source.
    // A path we cannot read is never reportable, so drop it. (issue #34)
    if (!fs.existsSync(file)) {
      diag(`  dropped — source-mapped path does not exist on disk: ${file}`);
      continue;
    }

    // Compute the relative path for exclude-pattern matching.
    const relPath = file.startsWith(cwdPrefix) ? file.slice(cwdPrefix.length) : file;

    const pkg = findIncludedPackage(file);
    if (pkg) {
      // Included package — remap its path under cwd so the HTML report
      // shows it as "<pkg-name>/..." instead of a deep relative path.
      const relInPkg = file.startsWith(pkg.dir)
        ? file.slice(pkg.dir.length)
        : file.slice(
            file.indexOf(`/node_modules/${pkg.name}/`) + `/node_modules/${pkg.name}/`.length,
          );
      const remapped = path.join(cwd, pkg.name, relInPkg);
      if (isExcluded(relPath)) continue;
      const fc = coverageMap.fileCoverageFor(file);
      reconcileWithOriginalSource(fc, file, mappedLinesBySource.get(file), diag);
      fc.data.path = remapped;
      filteredMap.addFileCoverage(fc);
    } else if (file.startsWith(cwdPrefix)) {
      if (isExcluded(relPath)) continue;
      // Local project file — keep as-is.
      const fc = coverageMap.fileCoverageFor(file);
      reconcileWithOriginalSource(fc, file, mappedLinesBySource.get(file), diag);
      filteredMap.addFileCoverage(fc);
    }
    // Everything else (library internals, node_modules, .embroider) is dropped.
  }

  if (filteredMap.files().length === 0) {
    console.log(
      "\n[coverage] No app-source coverage data after filtering — falling back to byte-level report.",
    );
    printByteReport(localScripts);
    return;
  }

  // Clean previous output so stale files from prior runs don't linger.
  const resolvedCoverageDir = path.resolve(coverageDir);
  if (!resolvedCoverageDir.startsWith(cwd + path.sep) && resolvedCoverageDir !== cwd) {
    throw new Error(
      `[coverage] coverageDir "${coverageDir}" resolves outside the project root — refusing to delete.`,
    );
  }
  fs.rmSync(resolvedCoverageDir, { recursive: true, force: true });
  fs.mkdirSync(coverageDir, { recursive: true });

  // Write diagnostic log for debugging cross-platform coverage differences.
  fs.writeFileSync(path.join(coverageDir, "coverage-debug.log"), diagLines.join("\n") + "\n");

  const context = libReport.createContext({
    dir: coverageDir,
    coverageMap: filteredMap,
    watermarks: {
      statements: [50, 80],
      functions: [50, 80],
      branches: [50, 80],
      lines: [50, 80],
    },
  });

  if (effectiveReporters.length === 0) {
    console.log("\n[coverage] No Istanbul reporters configured.");
    return;
  }

  const shouldWriteTextSummaryFile =
    configuredReporters === undefined || effectiveReporters.includes("text");

  console.log("\n");

  for (const reporterName of effectiveReporters) {
    reports.create(reporterName).execute(context);
  }

  // Preserve the legacy text summary file for the default path, and when
  // users explicitly request the text reporter.
  if (shouldWriteTextSummaryFile) {
    reports.create("text", { file: "coverage-summary.txt" }).execute(context);
  }

  if (effectiveReporters.includes("html")) {
    console.log(`\nHTML coverage report → ${path.join(coverageDir, "index.html")}\n`);
  }
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
