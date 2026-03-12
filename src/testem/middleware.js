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
 *
 * Browser-level vs page-level CDP connection
 * ------------------------------------------
 * On Linux headless Chrome, Page.reload() causes the renderer process to be
 * replaced. The page target's DevTools WebSocket closes and the DevTools port
 * (9222) temporarily refuses NEW connections (ECONNREFUSED) while the new
 * renderer starts.
 *
 * The fix is to establish the browser-level CDP connection FIRST. The
 * browser-level WebSocket is associated with the browser process (not any
 * renderer), so it survives renderer restarts. We register
 * Target.setAutoAttach({ waitForDebuggerOnStart: true }) on this connection
 * BEFORE the reload. When the new renderer starts, Chrome delivers a
 * Target.attachedToTarget event over the still-open browser-level WebSocket.
 * We then open a fresh page-level connection to the new renderer, start
 * precise coverage, and resume execution.
 *
 * On macOS Desktop Chrome, Page.reload() reuses the same renderer, so the
 * page-level WebSocket never closes and the initial client remains valid.
 * Target.attachedToTarget does not fire in this case, which is fine — the
 * original client's coverage data is still accessible.
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

  function logInfo(label, msg) {
    const line = `[${new Date().toISOString()}] INFO ${label}: ${msg}\n`;
    process.stderr.write(line);
    try {
      fs.mkdirSync(outputPath, { recursive: true });
      fs.appendFileSync(errorLog, line);
    } catch {
      // stderr fallback above
    }
  }

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

  let connectStart;
  let lastAttempt;

  /**
   * Connect a fresh page-level CDP client to the given target, enable the
   * Profiler domain, start precise coverage, and (if the target is paused
   * by waitForDebuggerOnStart) resume execution.
   */
  async function setupPageClient(targetId, { waitingForDebugger = false, startCoverage = true } = {}) {
    const pageClient = await CDP({ port: remoteDebuggingPort, target: targetId });

    pageClient.on("disconnect", () => {
      logInfo("pageClient", `target ${targetId} disconnected`);
      cdpClient = null;
    });

    await pageClient.Profiler.enable();

    if (startCoverage) {
      await pageClient.Profiler.startPreciseCoverage({ callCount: true, detailed: true });
      logInfo("setupPageClient", `precise coverage started on target ${targetId}`);
    }

    cdpClient = pageClient;

    if (waitingForDebugger) {
      await pageClient.Runtime.runIfWaitingForDebugger();
      logInfo("setupPageClient", `target ${targetId} resumed`);
    }

    return pageClient;
  }

  /**
   * Connect to Chrome DevTools.
   *
   * Strategy:
   *  1. Establish a browser-level CDP connection (survives renderer restarts).
   *  2. Register Target.setAutoAttach so new page targets are caught BEFORE
   *     their scripts run (waitForDebuggerOnStart pauses them).
   *  3. Connect to the existing page target, start coverage, and reload.
   *     • macOS: same renderer reused — page-level WebSocket stays open.
   *     • Linux: new renderer created — Target.attachedToTarget fires on the
   *       still-open browser-level WebSocket; we connect and resume the new
   *       page target with fresh coverage.
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
      // 1. Browser-level connection — not tied to any page renderer.
      //    Stays open even when the page target's WebSocket closes on reload.
      //    We must use /json/version to get the browser's own WebSocket URL;
      //    CDP({ port }) without a target connects to the first *page* target.
      const version = await CDP.Version({ port: remoteDebuggingPort });
      const browserWsUrl = version.webSocketDebuggerUrl;
      if (!browserWsUrl) throw new Error("No webSocketDebuggerUrl in /json/version — Chrome may not expose the browser endpoint");
      const browser = await CDP({ target: browserWsUrl });
      logInfo("connectChromeDevTools", "browser-level connection established");

      browser.on("disconnect", () => {
        logInfo("browser", "browser-level connection closed");
      });

      // 2. Auto-attach: when Chrome creates a new page target (e.g. after
      //    Page.reload() spawns a new renderer on Linux), this event fires on
      //    the still-open browser-level WebSocket. The target is paused before
      //    any scripts run, giving us a clean slate for coverage.
      browser.Target.attachedToTarget(async ({ targetInfo, waitingForDebugger }) => {
        if (targetInfo.type !== "page") return;
        logInfo("attachedToTarget", `new page target ${targetInfo.targetId}, waitingForDebugger=${waitingForDebugger}`);
        try {
          await setupPageClient(targetInfo.targetId, { waitingForDebugger, startCoverage: true });
        } catch (err) {
          logError("attachedToTarget handler", err);
        }
      });

      await browser.Target.setAutoAttach({
        autoAttach: true,
        waitForDebuggerOnStart: true,
      });
      logInfo("connectChromeDevTools", "setAutoAttach configured");

      // 3. Find the existing page target (Chrome may have already loaded the page).
      const targets = await CDP.List({ port: remoteDebuggingPort });
      const pageTarget = targets.find((t) => t.type === "page");

      if (!pageTarget) {
        // No page yet — attachedToTarget will fire when Chrome opens one.
        logInfo("connectChromeDevTools", "no page target yet — waiting for attachedToTarget");
        return;
      }

      logInfo("connectChromeDevTools", `existing page target: ${pageTarget.id} — starting coverage + reload`);

      // Connect to the existing page target and start coverage.
      const pageClient = await setupPageClient(pageTarget.id, { startCoverage: true });

      // Reload so scripts run while coverage is active.
      // On macOS: in-place reload, same WebSocket — cdpClient stays valid.
      // On Linux: new renderer is created; the disconnect fires (cdpClient → null)
      //           and Target.attachedToTarget fires on the browser-level WebSocket,
      //           connecting to the new renderer and restoring cdpClient.
      await pageClient.Page.enable();
      await pageClient.Page.reload();
      logInfo("connectChromeDevTools", "page reload sent");

      return;
    } catch (err) {
      logError("connectChromeDevTools", err);
      setTimeout(() => connectChromeDevTools(), CHECK_INTERVAL);
    }
  }

  void connectChromeDevTools();

  return function coverageMiddleware(app) {
    app.get(REPORT_TO_MIDDLEWARE_PATH, async (req, res) => {
      logInfo("/_coverage", `request received, cdpClient=${cdpClient ? "connected" : "null"}`);
      // The page-target WebSocket may close at the same moment /_coverage is
      // called (disconnect and request arrive within 1 ms of each other on
      // Linux headless Chrome). Handle both cases with a single retry loop:
      //   • cdpClient is null  → wait for reconnectAfterReload() to restore it
      //   • cdpClient is set but WebSocket just died → takePreciseCoverage()
      //     throws; cdpClient will be null after the disconnect handler runs,
      //     so loop around and wait for reconnect
      let coverageResult;
      const deadline = Date.now() + 10_000;

      while (Date.now() < deadline) {
        while (!cdpClient && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        if (!cdpClient) break;

        try {
          const { result } = await cdpClient.Profiler.takePreciseCoverage();
          logInfo("/_coverage", `takePreciseCoverage succeeded: ${result.length} scripts`);
          coverageResult = result;
          break;
        } catch (err) {
          logError("takePreciseCoverage (will retry after reconnect)", err);
          // The WebSocket likely closed simultaneously. The disconnect handler
          // will null out cdpClient and start reconnectAfterReload(); give it
          // a moment then loop back to the wait above.
          cdpClient = null;
          await new Promise((r) => setTimeout(r, 50));
        }
      }

      if (!coverageResult) {
        const msg = `Could not collect coverage after ${Math.round((Date.now() - (deadline - 10_000)) / 1000)}s — CDP connection lost`;
        logError("/_coverage", new Error(msg));
        res.status(503).json({ error: msg });
        return;
      }

      try {
        fs.mkdirSync(outputPath, { recursive: true });
        fs.writeFileSync(outputFile, JSON.stringify(coverageResult));
        // Generate the report before responding. The browser's QUnit.done() async
        // hook is still awaiting this response, so Chrome stays alive until we're
        // done printing. Output goes to process.stdout of the testem process and
        // appears directly in the terminal.
        await generateReport(coverageResult, {
          coverageDir: outputPath,
        });

        await handleReport?.(coverageResult);

        res.json({ ok: true, scripts: coverageResult.length });
      } catch (err) {
        logError("/_coverage handler", err);
        console.error("\n[coverage] Error generating report:", err.stack || err.message);
        res.status(500).json({ error: err.message });
      }
    });
  };
}
