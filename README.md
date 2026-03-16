# testem-code-coverage

Get _browser_ test coverage using a [chrome-specific feature](https://developer.chrome.com/docs/devtools/coverage), [`startPreciseCoverage`](https://chromedevtools.github.io/devtools-protocol/tot/Profiler/#method-startPreciseCoverage).

Works with any test framework, but presently only provides an adapter for qunit.

## Installation

```bash
npm add testem-code-coverage
# or from github
npm add "github:NullVoxPopuli/testem-code-coverage#main"
```

## Setup

This is assuming you are using testem and qunit.

> [!NOTE]
> While neither testem nor qunit are _new_, I consider them to be closer to finished than vitest is, and generally provide a better browser-based testing experience than vitest does (at least for now).

Setup the testem middleware

```js
// testem.cjs
module.exports = {
  // ...
  middleware: [
    require("testem-code-coverage").middleware({
      /* optional config here */
    }),
  ],
  // ...
  browser_args: {
    Chrome: {
      ci: [
        // ...
        "--remote-debugging-port=9222",
        // ...
      ],
    },
  },
};
```

Setup the runtime

```js
// tests/test-helper.js
import { setupCoverage } from "testem-code-coverage/runtime";

export async function start() {
  // ... must come before tests are started
  setupCoverage();
  // ...
  qunitStart();
}
```

## Configuration

### Testem

only the testem middleware is configurable, as it is what outputs the coverage report.

Here are the default options:

```js
require("testem-code-coverage").middleware({
  /**
   * If a non-absolute path, this defaults to CWD + /coverage
   * and is the location where the coverage reports are output
   * including: HTML, JSON, and TXT
   */
  outputFolder: "coverage",

  /**
   * Paths to include in the coverage report.
   * By default, `node_modules` are excluded.
   * But specifying library names here would allow you to track coverage
   * of those libraries.
   */
  include: [],

  /**
   * async callback that can be used to generate additional
   * report formats.
   *
   * @type {(coverageReport: JSON[]) => Promise<void>}
   */
  handleReport: undefined,

  /**
   * Chrome-specific configuration for telling the middleware
   * how to connect to and interact with Chrome
   */
  chrome: {
    /**
     * Amount of time to allow for Chrome to boot up.
     *
     * Default is 30 seconds.
     * Units in milliseconds.
     */
    connectionTimeout: 30_000,

    /**
     * This is how we connect to and communicate with Chrome
     */
    remoteDebuggingPort: 9222,
  },
});
```

## Caveats about the implementation details

These are all internal things to this testem-code-coverage library

### `Page.reload()` is required for accurate coverage

After connecting to Chrome via CDP and calling `startPreciseCoverage`, this library reloads the page before the tests run. This is not optional — it is what makes function-level coverage correct.

**Why:** testem launches Chrome with the test URL as a CLI argument, so Chrome navigates to the page _immediately on process start_. By the time CDP can connect (a page target only exists after Chrome has loaded the page), the test bundle has already been parsed and all module-level code has already executed — without any coverage tracking active.

The consequence of skipping the reload:

- V8 emits **no top-level function entry** (`startOffset=0`) for the bundle, because the module never ran while coverage was active.
- Functions that are **defined but never called** (e.g. an untested class method) produce **no V8 record at all**. They are invisible to the coverage snapshot.
- `v8-to-istanbul` initialises every source line with `count = 1` (covered) and only zeroes lines that appear in the V8 snapshot with an explicit `count = 0`. Lines with no entry stay green.
- Result: uncalled functions report **100% coverage** — a silent false positive.

Calling `Page.reload()` after `startPreciseCoverage` ensures the scripts run while coverage is already armed. V8 then produces the top-level function entry and correct `count = 0` sub-ranges for every uncalled function, which `v8-to-istanbul` uses to zero those lines out. This is the same pattern used by Puppeteer and Playwright for browser coverage.

### There is no Chrome launch flag equivalent to `startPreciseCoverage`

The CDP docs state: _"Coverage data for JavaScript executed **before** enabling precise code coverage may be incomplete."_ There is no `--js-flags` or other Chrome launch flag that replicates what `Profiler.startPreciseCoverage` does, because:

- `startPreciseCoverage` prevents V8 from running optimized/lazy compilation and resets execution counters — these are runtime behaviors controlled on a live isolate via CDP.
- Chrome launch flags control how the browser process starts, not V8's internal coverage state machine.
- Node.js has `NODE_V8_COVERAGE` because it wraps the entire process startup; Chrome has no equivalent since the browser starts before any test harness can intercept it.

The `Page.reload()` is the correct and only reliable approach for browser-based precise coverage via CDP.

### testem has no hook between Chrome starting and the page loading

testem's lifecycle hooks (`on_start`, `before_tests`) run on the server side before Chrome launches — the CDP page target does not yet exist at that point. Chrome is spawned with the test URL as the last CLI argument and navigates immediately, leaving no gap to intercept. There is no built-in way to run code between "Chrome process starts" and "Chrome loads the page" without patching testem itself.

### Branch counts from V8 are non-deterministic

V8 uses tiered JIT compilation: functions start in the **Ignition** interpreter and may be promoted to **Maglev** or **TurboFan** optimising compilers if they become "hot". The coverage ranges reported by `Profiler.takePreciseCoverage` reflect whichever tier each function is in at the moment coverage is collected. TurboFan can split a single `if` into multiple tracked ranges or collapse branches it proves are unreachable, so the total number of branch ranges varies between runs depending on which background optimisation thread fires before `takePreciseCoverage` is called.

In practice, **line and function coverage for your own source files are stable** — those functions are called enough to consistently reach the same tier. The volatile numbers tend to appear in framework and vendor code (Ember internals, QUnit, test helpers) where tier-up is marginal. If you need deterministic snapshots, consider asserting only on `lines` and `functions` and omitting `branches`.
