# ember-code-coverage

Get _browser_ test coverage in vite apps using a [chrome-specific feature](https://developer.chrome.com/docs/devtools/coverage), [`startPreciseCoverage`](https://chromedevtools.github.io/devtools-protocol/tot/Profiler/#method-startPreciseCoverage). 

Works with any test framework, but isn't needed in [`vitest`](https://github.com/nullVoxPopuli/ember-vitest).

## Installation 

```bash
npm add ember-code-coverage
# or from github
npm add "github:NullVoxPopuli/ember-code-coverage#main"
```

## Setup

This is assuming you are using testem and qunit.

> [!NOTE]
> While neither testem nor qunit are *new*, I consider them to be closer to finished than vitest is, and generally provide a better browser-based testing experience than vitest does (at least for now).

Setup the testem middleware

```js
// testem.cjs
module.exports = {
    // ...
    middleware: [require('ember-code-coverage/testem')({
        /* optional config here */ 
    })],
    // ...
    browser_args: {
        Chrome: {
            ci: [
                // ...
                '--remote-debugging-port=9222',
                // ...
            ]
        }
    }
}
```

Setup qunit

```js
// tests/test-helper.js
import { setupCoverage } from 'ember-code-coverage/qunit';

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
require('ember-code-coverage/testem')({
    /**
     * If a non-absolute path, this defaults to CWD + /coverage
     * and is the location where the coverage reports are output
     * including: HTML, lcov,  
     */
    outputFolder: 'coverage',

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
    }
})
```
