/**
 * Testem middleware that:
 *  1. Connects to Chrome via the DevTools Protocol (CDP) as soon as Chrome is
 *     ready, enabling precise coverage collection.
 *  2. Reloads the page after enabling coverage so V8 tracks every byte from
 *     the very first script execution (see note below).
 *  3. Exposes GET /_coverage — called by the QUnit.done() async hook in
 *     test-helper.js. QUnit awaits all done() callbacks before emitting the
 *     final TAP summary line, which is what gates Chrome's shutdown. So this
 *     handler completing is exactly what keeps Chrome alive long enough to
 *     write coverage-data.json before testem kills it.
 *
 * Why the reload is required
 * --------------------------
 * CDP connects to the *page* target, which only becomes available after
 * Chrome has already navigated to the test URL and begun parsing the bundle.
 * If startPreciseCoverage() is called after the scripts have already been
 * parsed and the module-level code has already run:
 *
 *   • V8 emits no top-level function entry (startOffset=0) for the bundle.
 *   • Functions that are defined but never subsequently called (e.g. an
 *     unexercised class method like `clampedCount`) never appear in the
 *     coverage snapshot at all.
 *
 * v8-to-istanbul initialises every source line with count=1 (covered) and
 * only zeroes lines that appear in the V8 snapshot with an explicit count=0
 * entry.  Lines that have no entry at all therefore stay green, so the
 * never-called functions report 100 % coverage — a false positive.
 *
 * Calling Page.reload() after startPreciseCoverage() ensures the scripts run
 * while coverage is already active, which produces the top-level function
 * entry and correct count=0 entries for every uncalled function.
 */

import { isAbsolute, join } from "node:path";
import fs from "node:fs";
import CDP from "chrome-remote-interface";
import { generateReport } from "#v8/report.js";
import { REPORT_TO_MIDDLEWARE_PATH } from "#utils";

const CHECK_INTERVAL = 500; // ms

export function middleware(options = {}) {
  const { outputFolder = "coverage", handleReport, chrome } = options;
  const { connectionTimeout = 30_000, remoteDebuggingPort = 9222 } = chrome || {};

  const cwd = process.cwd();
  let cdpClient = null;

  const outputPath = isAbsolute(outputFolder) ? outputFolder : join(cwd, outputFolder);
  const outputFile = join(outputPath, "coverage-data.json");

  let connectStart;
  let lastAttempt;
  async function connectChromeDevTools() {
    lastAttempt = Date.now();

    if (!connectStart) {
      connectStart = Date.now();
    }

    if (lastAttempt - connectStart >= connectionTimeout) {
      console.warn("[coverage] Could not connect to Chrome CDP after 30 s — coverage disabled.");
      return;
    }

    try {
      // Connect to the page target specifically (not the browser-level WebSocket)
      // so that the Profiler domain covers the page's JavaScript V8 context.
      const targets = await CDP.List({ port: remoteDebuggingPort });
      const pageTarget = targets.find((t) => t.type === "page");

      if (!pageTarget) throw new Error("no page target yet");

      const client = await CDP({ port: remoteDebuggingPort, target: pageTarget.id });

      client.on("disconnect", () => {
        cdpClient = null;
      });

      await client.Profiler.enable();
      await client.Profiler.startPreciseCoverage({ callCount: true, detailed: true });

      // Reload so the test scripts run while coverage is already active.
      // This produces the top-level function entry (startOffset=0) that lets
      // v8-to-istanbul correctly zero out every never-called function.
      // Without the reload, functions that are defined but never called have
      // no V8 record at all and remain at v8-to-istanbul's default count=1.
      await client.Page.enable();
      await client.Page.reload();

      cdpClient = client;
      return;
    } catch {
      setTimeout(connectChromeDevTools, CHECK_INTERVAL);
    }
  }

  void connectChromeDevTools();

  return function coverageMiddleware(app) {
    app.get(REPORT_TO_MIDDLEWARE_PATH, async (req, res) => {
      if (!cdpClient) {
        res.status(503).json({ error: "Chrome DevTools not connected" });
        return;
      }

      try {
        const { result } = await cdpClient.Profiler.takePreciseCoverage();

        fs.writeFileSync(outputFile, JSON.stringify(result));
        // Generate the report before responding. The browser's QUnit.done() async
        // hook is still awaiting this response, so Chrome stays alive until we're
        // done printing. Output goes to process.stdout of the testem process and
        // appears directly in the terminal.
        await generateReport(result, {
          coverageDir: outputPath,
        });

        await handleReport?.(result);

        res.json({ ok: true, scripts: result.length });
      } catch (err) {
        console.error("\n[coverage] Error generating report:", err.stack || err.message);
        res.status(500).json({ error: err.message });
      }
    });
  };
}
