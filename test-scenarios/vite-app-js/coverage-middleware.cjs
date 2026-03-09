'use strict';

/**
 * Testem middleware that:
 *  1. Connects to Chrome via the DevTools Protocol (CDP) as soon as Chrome is
 *     ready, enabling precise coverage collection.
 *  2. Exposes GET /_coverage — called by the QUnit.done() async hook in
 *     test-helper.js. QUnit awaits all done() callbacks before emitting the
 *     final TAP summary line, which is what gates Chrome's shutdown. So this
 *     handler completing is exactly what keeps Chrome alive long enough to
 *     write coverage-data.json before testem kills it.
 *
 * Note: no /_coverage-ready handshake is needed. This middleware is loaded
 * when testem reads its config, which is before Chrome even launches. By the
 * time Chrome starts and the 2.5 MB test bundle is parsed and executed, CDP
 * has already been connected and coverage is active.
 */

const path = require('path');
const fs = require('fs');
const { generateReport } = require('./coverage-report.cjs');

const CDP_PORT = 9222;
const OUTPUT_FILE = path.join(__dirname, 'coverage-data.json');

let cdpClient = null;

async function connectToCDP() {
  let CDP;
  try {
    CDP = require('chrome-remote-interface');
  } catch {
    console.warn('[coverage] chrome-remote-interface not installed — coverage disabled.');
    return;
  }

  // Chrome takes a moment to start; retry until it accepts a connection.
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const client = await CDP({ port: CDP_PORT });

      client.on('disconnect', () => {
        cdpClient = null;
      });

      await client.Profiler.enable();
      await client.Profiler.startPreciseCoverage({ callCount: true, detailed: true });

      cdpClient = client;
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  console.warn('[coverage] Could not connect to Chrome CDP after 30 s — coverage disabled.');
}

// Begin attempting to connect immediately when the module is loaded by testem.
connectToCDP();

module.exports = function coverageMiddleware(app) {
  app.get('/_coverage', async (req, res) => {
    if (!cdpClient) {
      res.status(503).json({ error: 'CDP not connected' });
      return;
    }

    try {
      const { result } = await cdpClient.Profiler.takePreciseCoverage();
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(result));
      // Generate the report before responding. The browser's QUnit.done() async
      // hook is still awaiting this response, so Chrome stays alive until we're
      // done printing. Output goes to process.stdout of the testem process and
      // appears directly in the terminal.
      await generateReport(result);
      res.json({ ok: true, scripts: result.length });
    } catch (err) {
      console.error('\n[coverage] Error generating report:', err.stack || err.message);
      res.status(500).json({ error: err.message });
    }
  });
};
