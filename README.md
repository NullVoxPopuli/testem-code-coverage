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

Setup qunit

```js
// tests/test-helper.js
import { setupCoverage } from "testem-code-coverage/qunit";

export async function start() {
  // ... must come before tests are started
  setupCoverage(QUnit);
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
   * including: HTML, JSON
   */
  outputFolder: "coverage",

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
