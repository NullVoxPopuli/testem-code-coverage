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
   * Create a thin wrapper around browser.send(method, params, sessionId) that
   * mimics the API used in the /_coverage handler. This lets us avoid opening
   * a separate WebSocket per page target — all commands flow through the single
   * browser-level WebSocket using the CDP flat (session-multiplexed) protocol.
   */
  function createSessionClient(browser, sessionId) {
    return {
      _sessionId: sessionId,
      Profiler: {
        enable: () => browser.send("Profiler.enable", {}, sessionId),
        startPreciseCoverage: (params) =>
          browser.send("Profiler.startPreciseCoverage", params, sessionId),
        takePreciseCoverage: () => browser.send("Profiler.takePreciseCoverage", {}, sessionId),
      },
      Page: {
        enable: () => browser.send("Page.enable", {}, sessionId),
        reload: () => browser.send("Page.reload", {}, sessionId),
      },
      Runtime: {
        runIfWaitingForDebugger: () =>
          browser.send("Runtime.runIfWaitingForDebugger", {}, sessionId),
      },
    };
  }

  /**
   * Connect to Chrome DevTools.
   *
   * Strategy:
   *  1. Establish a browser-level CDP connection (survives renderer restarts).
   *  2. Register Target.setAutoAttach with flatten:true (required by Chrome
   *     for browser-level auto-attach). This causes Chrome to auto-attach to
   *     all existing and future page targets, firing Target.attachedToTarget
   *     events over the already-open browser-level WebSocket.
   *  3. attachedToTarget handler:
   *     • Start coverage via a session (no separate WebSocket per page).
   *     • If the target is already running (waitingForDebugger:false) → reload
   *       so scripts run while coverage is active (same logic as before).
   *     • If the target is paused (waitingForDebugger:true, i.e. the new
   *       renderer after a reload on Linux) → start coverage and resume.
   *  4. Target.detachedFromTarget handler nulls out cdpClient so /_coverage
   *     knows to wait for the new session.
   *
   * Why flatten:true is required
   * ----------------------------
   * Chrome's CDP requires the "flat" (session-multiplexed) protocol when
   * calling Target.setAutoAttach at the browser level. Without flatten:true,
   * Chrome responds with:
   *   "Only flatten protocol is supported with browser level auto-attach"
   * With flatten:true all CDP messages (both browser and page) flow through
   * the same WebSocket, tagged with a sessionId. chrome-remote-interface
   * supports this via browser.send(method, params, sessionId).
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
      //    We must use /json/version to get the browser's own WebSocket URL;
      //    CDP({ port }) without a target connects to the first *page* target.
      const version = await CDP.Version({ port: remoteDebuggingPort });
      const browserWsUrl = version.webSocketDebuggerUrl;
      if (!browserWsUrl)
        throw new Error(
          "No webSocketDebuggerUrl in /json/version — Chrome may not expose the browser endpoint",
        );
      const browser = await CDP({ target: browserWsUrl });
      logInfo("connectChromeDevTools", "browser-level connection established");

      browser.on("disconnect", () => {
        logInfo("browser", "browser-level connection closed");
      });

      // Track whether we've already reloaded so we don't reload on subsequent
      // attachedToTarget events (e.g. if setAutoAttach auto-attaches multiple times).
      let reloadSent = false;

      // 2. Auto-attach with flatten:true — required for browser-level auto-attach.
      //    This fires attachedToTarget for ALL existing page targets immediately,
      //    and for any new page targets (e.g. after Page.reload on Linux).
      browser.Target.attachedToTarget(async ({ targetInfo, waitingForDebugger, sessionId }) => {
        if (targetInfo.type !== "page") return;
        logInfo(
          "attachedToTarget",
          `page target ${targetInfo.targetId}, sessionId=${sessionId}, waitingForDebugger=${waitingForDebugger}`,
        );
        try {
          const session = createSessionClient(browser, sessionId);
          await session.Profiler.enable();
          await session.Profiler.startPreciseCoverage({ callCount: true, detailed: true });
          logInfo("attachedToTarget", `coverage started on session ${sessionId}`);
          cdpClient = session;

          if (waitingForDebugger) {
            // New renderer after reload — scripts are paused. Resume now that
            // coverage is active so the scripts run under coverage.
            await session.Runtime.runIfWaitingForDebugger();
            logInfo("attachedToTarget", `session ${sessionId} resumed`);
          } else if (!reloadSent) {
            // Existing renderer (page already loaded). Reload so scripts run
            // while coverage is active, producing correct count=0 entries for
            // never-called functions instead of v8-to-istanbul's default count=1.
            reloadSent = true;
            await session.Page.enable();
            await session.Page.reload();
            logInfo("attachedToTarget", `page reload sent for session ${sessionId}`);
          }
        } catch (err) {
          logError("attachedToTarget handler", err);
        }
      });

      // Null out cdpClient when the current page session is destroyed (e.g.
      // the renderer exits on Linux after Page.reload). The /_coverage handler's
      // retry loop will wait for the new session's attachedToTarget to restore it.
      browser.Target.detachedFromTarget(({ sessionId: detachedId }) => {
        if (cdpClient && cdpClient._sessionId === detachedId) {
          logInfo("detachedFromTarget", `session ${detachedId} detached — cdpClient → null`);
          cdpClient = null;
        }
      });

      await browser.Target.setAutoAttach({
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
      logInfo("connectChromeDevTools", "setAutoAttach configured");

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
      // cdpClient may be null if the page session was destroyed mid-request
      // (detachedFromTarget fired) and the new session's attachedToTarget hasn't
      // fired yet. The retry loop waits up to 10 s for cdpClient to be restored
      // by the next attachedToTarget event.
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
