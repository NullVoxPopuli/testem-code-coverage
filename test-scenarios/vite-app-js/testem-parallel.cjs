'use strict';

// Parallel-browser variant of testem.cjs.
//
// testem launches one browser per entry in `test_page`, so the two entries below
// produce two simultaneous Chromes. The QUnit `filter` splits the suite so that
// NEITHER browser sees the whole app:
//
//   browser 1 (filter=Unit)        exercises app/utils/format-score.js
//   browser 2 (filter=Integration) exercises app/components/counter.gjs
//
// A merged report therefore has to contain covered lines from both files. If the
// middleware only ever collected from one browser — the behaviour before
// per-browser sessions existed — one of those files would show zero covered
// lines, and the assertions in tests/vite-app-parallel-js.test.js fail.
if (typeof module !== 'undefined') {
  module.exports = {
    test_page: ['tests/index.html?hidepassed&filter=Unit', 'tests/index.html?hidepassed&filter=Integration'],
    cwd: 'dist',
    parallel: 2,
    disable_watching: true,
    launch_in_ci: ['Chrome'],
    launch_in_dev: ['Chrome'],
    browser_start_timeout: 120,
    middleware: [
      require('testem-code-coverage').middleware({
        outputFolder: 'coverage-parallel',
        reporters: ['json-summary'],
        chrome: {
          // 0 disables the fixed-port seed. Two browsers cannot share one port,
          // so this run relies entirely on discovering the ephemeral ports that
          // Chrome reports via <user-data-dir>/DevToolsActivePort.
          remoteDebuggingPort: 0,
        },
      }),
    ],
    browser_args: {
      Chrome: {
        ci: [
          // --no-sandbox is needed when running Chrome inside a container
          process.env.CI ? '--no-sandbox' : null,
          '--headless',
          '--disable-dev-shm-usage',
          '--disable-software-rasterizer',
          '--mute-audio',
          // Ephemeral, so both browsers get a port of their own.
          '--remote-debugging-port=0',
          '--window-size=1440,900',
        ].filter(Boolean),
        dev: ['--remote-debugging-port=0'],
      },
    },
  };
}
