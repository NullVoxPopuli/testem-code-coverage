# testem-code-coverage

Get _browser_ test coverage, without sus babel plugins, using a [chrome-specific feature](https://developer.chrome.com/docs/devtools/coverage), [`startPreciseCoverage`](https://chromedevtools.github.io/devtools-protocol/tot/Profiler/#method-startPreciseCoverage).

Works with any test framework, but presently only provides an adapter for qunit.

## Installation

```bash
npm add testem-code-coverage
# or from github
npm add "github:NullVoxPopuli/testem-code-coverage#main"
```

## Setup

This assumes you are using testem and qunit.

> [!NOTE]
> While neither testem nor qunit are _new_, I consider them to be closer to finished than vitest is, and generally provide a better browser-based testing experience than vitest does (at least for now).

Add the middleware and a remote-debugging port:

```js
// testem.cjs
module.exports = {
  // ...
  middleware: [
    require("testem-code-coverage").middleware({
      // optional config here, see "Configuration" below
    }),
  ],
  browser_args: {
    Chrome: {
      ci: [
        // ...
        "--remote-debugging-port=9222",
      ],
    },
  },
};
```

Then call `setupCoverage()` before the tests start:

```js
// tests/test-helper.js
import { setupCoverage } from "testem-code-coverage/runtime";

export async function start() {
  setupCoverage(); // must come before tests are started
  qunitStart();
}
```

If you build with Vite, enable source maps for the build that serves your browser tests:

```js
// vite.config.mjs
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    sourcemap: true,
  },
});
```

## Generating coverage

Run tests through the `testem` CLI:

```bash
testem ci
```

If you're using ember, avoid `ember test` and point your `test` script at testem directly:

```json
"test": "vite build --mode development && testem ci --port 0"
```

## Configuration

Only the testem middleware is configurable, as it is what outputs the coverage report.

All options, with their defaults:

```js
require("testem-code-coverage").middleware({
  // Where reports are written (HTML, JSON, TXT).
  // Relative paths resolve from CWD.
  outputFolder: "coverage",

  // Path to the built assets that Chrome loads during the test run.
  distDir: "dist",

  // node_modules are excluded by default; list library names here
  // to track their coverage anyway.
  include: [],

  // Glob patterns to exclude, matched against paths relative to the
  // project root. Setting this replaces the defaults entirely —
  // pass [] to disable all exclusions.
  exclude: [
    "**/tests/**",
    "**/node_modules/**",
    "**/.embroider/**",
    "**/embroider-implicit-modules/**",
    "**/-embroider-*",
  ],

  // Istanbul reporters to run — any name supported by istanbul-reports
  // works ("lcov", "cobertura", "json", "text-summary", ...).
  // If "text" is included, coverage/coverage-summary.txt is also written.
  reporters: ["text", "html", "json-summary"],

  // async callback for generating additional report formats,
  // beyond what the built-in Istanbul reporters offer.
  // (coverageReport: JSON[]) => Promise<void>
  handleReport: undefined,

  chrome: {
    // How long to wait for Chrome to boot, in milliseconds.
    connectionTimeout: 30_000,

    // Must match the --remote-debugging-port passed to Chrome.
    remoteDebuggingPort: 9222,
  },

  // Write middleware diagnostics to stderr and coverage/errors.log.
  debug: false,
});
```

## Implementation notes

### `Page.reload()` is required for accurate coverage

testem passes the test URL to Chrome as a CLI argument, so the page loads — and all module-level code runs — before CDP can even connect. Without a reload, functions that are never called produce no V8 record at all, and `v8-to-istanbul` reports them as covered: a silent false positive. So after calling `startPreciseCoverage`, this library reloads the page so every script runs with coverage armed. Puppeteer and Playwright do the same.

### Why not a Chrome launch flag?

There isn't one. `startPreciseCoverage` changes runtime behavior on a live V8 isolate (disabling lazy compilation, resetting counters), which launch flags can't do. Node has `NODE_V8_COVERAGE` because it wraps process startup — Chrome starts before any test harness can intercept it. testem also has no hook between "Chrome starts" and "the page loads" (its lifecycle hooks run server-side, before launch), so the reload above is the only reliable option.

### Branch counts from V8 are non-deterministic

V8's tiered JIT (Ignition → Maglev → TurboFan) can split or collapse branch ranges depending on which tier a function is in when coverage is collected, so branch totals vary between runs. Line and function coverage for your own code is stable; the noise shows up in framework and vendor code (Ember internals, QUnit, test helpers) where tier-up is marginal. If you need deterministic snapshots, assert on `lines` and `functions` and skip `branches`.
