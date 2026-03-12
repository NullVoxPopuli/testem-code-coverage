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
  const errorLog = join(outputPath, "errors.log");

  function logError(label, err) {
    const line = `[${new Date().toISOString()}] ${label}: ${err?.stack ?? err?.message ?? String(err)}\n`;
    process.stderr.write(line);
    try {
      fs.mkdirSync(outputPath, { recursive: true });
      fs.appendFileSync(errorLog, line);
    } catch {
      // If we can't write the log file, stderr above is the fallback.
    }
  }

  // Set to true once startPreciseCoverage has been called. Used by the
  // disconnect handler to know whether to attempt a post-reload reconnect.
  let coverageStarted = false;

  let connectStart;
  let lastAttempt;

  /**
   * Aggressively reconnect to the page target after a reload-triggered
   * disconnect. Retries every 50 ms (instead of CHECK_INTERVAL) so cdpClient
   * is restored well before /_coverage is hit by the test runner.
   */
  async function reconnectAfterReload() {
    const deadline = Date.now() + connectionTimeout;
    while (Date.now() < deadline) {
      try {
        const targets = await CDP.List({ port: remoteDebuggingPort });
        const pageTarget = targets.find((t) => t.type === "page");
        if (!pageTarget) throw new Error("no page target yet");

        const newClient = await CDP({ port: remoteDebuggingPort, target: pageTarget.id });
        newClient.on("disconnect", () => {
          cdpClient = null;
        });
        await newClient.Profiler.enable();
        cdpClient = newClient;
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    console.warn("[coverage] Could not reconnect to Chrome after reload — coverage disabled.");
    logError("reconnectAfterReload", new Error("Timed out waiting for page target after reload"));
  }

  /**
   * Connect to Chrome DevTools on initial startup. Retries every CHECK_INTERVAL
   * ms until Chrome is ready or connectionTimeout elapses.
   */
  async function connectChromeDevTools() {
    lastAttempt = Date.now();

    if (!connectStart) {
      connectStart = Date.now();
    }

    if (lastAttempt - connectStart >= connectionTimeout) {
      const msg = "Could not connect to Chrome CDP after 30 s — coverage disabled.";
      console.warn(`[coverage] ${msg}`);
      logError("connectChromeDevTools", new Error(msg));
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
        if (coverageStarted) {
          // On Linux headless Chrome, Page.reload() closes the page target's
          // DevTools WebSocket. Reconnect aggressively (no fixed delay, 50 ms
          // retry loop) so cdpClient is restored before /_coverage is called.
          // V8 precise coverage is an isolate-level setting and persists across
          // same-origin navigations, so takePreciseCoverage() on the new
          // connection still returns data collected since startPreciseCoverage().
          logError("disconnect", new Error("Page target WebSocket closed after reload — starting reconnectAfterReload()"));
          void reconnectAfterReload();
        }
      });

      await client.Profiler.enable();
      await client.Profiler.startPreciseCoverage({ callCount: true, detailed: true });
      coverageStarted = true;

      // Reload so the test scripts run while coverage is already active.
      // This produces the top-level function entry (startOffset=0) that lets
      // v8-to-istanbul correctly zero out every never-called function.
      // Without the reload, functions that are defined but never called have
      // no V8 record at all and remain at v8-to-istanbul's default count=1.
      await client.Page.enable();
      await client.Page.reload();

      cdpClient = client;
      return;
    } catch (err) {
      // If coverage was already started, the disconnect handler fired and
      // reconnectAfterReload() is already taking care of reconnecting.
      // Do NOT retry connectChromeDevTools() here — that would call
      // startPreciseCoverage() + Page.reload() again, wiping coverage data.
      if (!coverageStarted) {
        setTimeout(() => connectChromeDevTools(), CHECK_INTERVAL);
      } else {
        logError("connectChromeDevTools (post-reload throw)", err);
      }
    }
  }

  void connectChromeDevTools();

  return function coverageMiddleware(app) {
    app.get(REPORT_TO_MIDDLEWARE_PATH, async (req, res) => {
      // If cdpClient is temporarily null (e.g. during a post-reload reconnect on
      // Linux headless Chrome), wait up to 10 s for reconnectAfterReload() to
      // restore it rather than immediately returning 503.
      if (!cdpClient) {
        const deadline = Date.now() + 10_000;
        while (!cdpClient && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      if (!cdpClient) {
        const msg = "Chrome DevTools not connected after 10 s wait";
        logError("/_coverage", new Error(msg));
        res.status(503).json({ error: msg });
        return;
      }

      try {
        const { result } = await cdpClient.Profiler.takePreciseCoverage();

        fs.mkdirSync(outputPath, { recursive: true });
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
        logError("/_coverage handler", err);
        console.error("\n[coverage] Error generating report:", err.stack || err.message);
        res.status(500).json({ error: err.message });
      }
    });
  };
}
