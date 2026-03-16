/**
 * Testem middleware that:
 *  1. Connects to Chrome via the DevTools Protocol (CDP) as soon as Chrome is
 *     ready, enabling precise coverage collection.
 *  2. Reloads the page after enabling coverage so V8 tracks every byte from
 *     the very first script execution (see note below).
 *  3. Exposes GET /_coverage — called by the Testem afterTests hook.
 *     Testem awaits the hook before emitting the final TAP summary line,
 *     which gates Chrome's shutdown. This handler completing is what keeps
 *     Chrome alive long enough to write coverage-data.json before testem
 *     kills it.
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
 * On macOS Desktop Chrome, Page.reload() reuses the same renderer process —
 * no new target fires. Worse, V8's startPreciseCoverage state is reset when
 * a new JavaScript context is created on navigation, so module scripts compile
 * without precise coverage and never-called functions never appear in V8 output
 * (false 100% coverage).
 *
 * Fix: instead of Page.reload(), navigate the existing tab to about:blank and
 * then open a brand-new tab via Target.createTarget({ url: testUrl }).
 * Because setAutoAttach({ waitForDebuggerOnStart: true }) is active, the new
 * tab fires attachedToTarget(waitingForDebugger=true) before any JavaScript
 * runs — including before any module is fetched or compiled. The existing
 * waitingForDebugger=true handler calls startPreciseCoverage and resumes,
 * so every module compiles under precise coverage from the very first byte.
 */

import { isAbsolute, join } from "node:path";
import fs from "node:fs";
import CDP from "chrome-remote-interface";
import { generateReport } from "#v8/report.js";
import { REPORT_TO_MIDDLEWARE_PATH } from "#utils";

const CHECK_INTERVAL = 500; // ms

export function middleware(options = {}) {
  const { outputFolder = "coverage", distDir, handleReport, include, chrome } = options;
  const { connectionTimeout = 30_000, remoteDebuggingPort = 9222 } = chrome || {};

  const cwd = process.cwd();
  let cdpClient = null;

  // Reload-pending gate — prevents the pre-reload afterTests hook from
  // collecting stale coverage data and triggering TAP output before the new
  // page runs.
  //
  // Problem
  // -------
  // By the time the middleware establishes a CDP connection (~4 s on slow starts),
  // the page has ALREADY loaded and run all tests. The afterTests hook has
  // already sent a fetch('/_coverage') that is queued in the /_coverage retry
  // loop waiting for cdpClient to become available.
  //
  // When cdpClient is finally set (after startPreciseCoverage + before reload),
  // this stale /_coverage handler immediately calls takePreciseCoverage() and
  // gets pre-reload data: functions that were lazily compiled (never called)
  // don't appear in V8's registry, so v8-to-istanbul defaults them to covered=1
  // — the original false-positive bug.
  //
  // The reload was supposed to fix this (re-run scripts with coverage active),
  // but the stale handler collects coverage BEFORE the reload completes and the
  // new page's afterTests fires — and then responds with { ok: true }, testem
  // emits final TAP, kills Chrome, and the new page never runs.
  //
  // Solution
  // --------
  // Set reloadPending=true synchronously (before any await) when a reload is
  // triggered. Any /_coverage request that arrives while reloadPending=true is
  // the stale pre-reload handler — it waits on newCoveragePromise instead of
  // collecting coverage itself.
  //
  // On macOS (in-place reload, same session): the new page's afterTests sends
  // a fresh /_coverage request after its tests run; that new handler processes
  // coverage, resolves newCoveragePromise, and the stale handler then closes.
  //
  // On Linux (new renderer after reload): attachedToTarget fires with
  // waitingForDebugger:true; we resume and set reloadPending=false; the new
  // renderer's afterTests sends /_coverage, which is processed normally (stale
  // handler is already waiting on the promise and resolves when new does).
  let reloadPending = false;
  let newCoverageResolve = null;
  let newCoveragePromise = null;

  const outputPath = isAbsolute(outputFolder) ? outputFolder : join(cwd, outputFolder);
  const outputFile = join(outputPath, "coverage-data.json");
  const errorLog = join(outputPath, "errors.log");

  function writeLog(line) {
    process.stderr.write(line);
    try {
      fs.mkdirSync(outputPath, { recursive: true });
      fs.appendFileSync(errorLog, line);
    } catch {
      // If we can't write the log file, stderr above is the fallback.
    }
  }

  function logInfo(label, msg) {
    writeLog(`[${new Date().toISOString()}] INFO ${label}: ${msg}\n`);
  }

  function logError(label, err) {
    writeLog(
      `[${new Date().toISOString()}] ${label}: ${err?.stack ?? err?.message ?? String(err)}\n`,
    );
  }

  // Proactive coverage cache — refreshed every CACHE_INTERVAL ms while tests
  // are running. Used as a fallback in /_coverage if Chrome exits before the
  // live takePreciseCoverage() call can complete.
  //
  // Why this is needed (Linux headless Chrome SIGTERM race)
  // -------------------------------------------------------
  // Testem sends SIGTERM to Chrome almost immediately (~14ms) after receiving
  // the final TAP line. Even with a keepAlive timer in the Testem adapter,
  // Chrome may begin the shutdown sequence before the live takePreciseCoverage
  // CDP call completes. The proactive cache is taken every CACHE_INTERVAL ms
  // throughout the test run, so there is always a recent snapshot available as
  // a fallback when the live call fails.
  //
  // V8 precise coverage counters are CUMULATIVE from startPreciseCoverage().
  // Any snapshot taken after all tests have finished will therefore contain the
  // complete coverage picture. If the last cache was taken 0–CACHE_INTERVAL ms
  // before /_coverage arrived, and tests finished >CACHE_INTERVAL ms before
  // /_coverage, the cache is complete. For the vast majority of test suites
  // (tests take at least a few hundred ms), this window is comfortably covered.
  const CACHE_INTERVAL = 100; // ms
  let coverageCache = null;
  let cacheTimerHandle = null;

  function startCoverageCache() {
    if (cacheTimerHandle) clearTimeout(cacheTimerHandle);
    coverageCache = null;
    cacheTimerHandle = setTimeout(refreshCoverageCache, CACHE_INTERVAL);
  }

  async function refreshCoverageCache() {
    if (!cdpClient) return;
    try {
      const { result } = await cdpClient.Profiler.takePreciseCoverage();
      if (result) {
        coverageCache = result;
      }
    } catch {
      // Ignore — will retry on next interval
    }
    // Schedule the next refresh only if cdpClient is still alive.
    if (cdpClient) {
      cacheTimerHandle = setTimeout(refreshCoverageCache, CACHE_INTERVAL);
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
        navigate: (params) => browser.send("Page.navigate", params, sessionId),
        clearCompilationCache: () => browser.send("Page.clearCompilationCache", {}, sessionId),
      },
      Network: {
        enable: () => browser.send("Network.enable", {}, sessionId),
        setCacheDisabled: (params) => browser.send("Network.setCacheDisabled", params, sessionId),
        clearBrowserCache: () => browser.send("Network.clearBrowserCache", {}, sessionId),
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
      // The targetId of the fresh coverage tab we open via createTarget.
      // Set when createTarget resolves so we can reject spurious
      // attachedToTarget events from the old tab's about:blank renderer on Linux
      // (cross-origin navigate there creates a new renderer → fires attachedToTarget
      // for the OLD target with a new session — targetId unmistakable since it's the
      // same old-tab target, different from the new tab).
      let coverageTabTargetId = null;

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

          if (waitingForDebugger) {
            // A new page was created via createTarget and paused before any JS
            // runs (waitForDebuggerOnStart: true). This is the dedicated coverage
            // tab — resume it once coverage is fully set up.
            //
            // Guard: on Linux, navigating the old tab to about:blank sometimes
            // spawns a NEW RENDERER for the OLD target, which also fires
            // attachedToTarget(waitingForDebugger=true). Reject that by checking
            // the targetId — we set coverageTabTargetId from createTarget's return
            // value just after this event fires (because Chrome fires the event
            // before the CDP createTarget response returns, coverageTabTargetId
            // is set 1-3ms after the event). The check therefore runs safely
            // after two async calls (Profiler.enable + startPreciseCoverage) by
            // which time coverageTabTargetId is definitely set.
            if (coverageTabTargetId && targetInfo.targetId !== coverageTabTargetId) {
              logInfo(
                "attachedToTarget",
                `ignoring spurious waitingForDebugger tab (target ${targetInfo.targetId}, expected ${coverageTabTargetId})`,
              );
              await session.Runtime.runIfWaitingForDebugger();
              return;
            }

            cdpClient = session;
            startCoverageCache();

            // Two-layer cache-busting before the new tab loads test scripts:
            //   1. Network.setCacheDisabled — prevents Chrome from serving HTTP
            //      responses (including embedded pre-compiled V8 bytecode) from
            //      its disk cache. Forces a fresh download from the dev server.
            //   2. Page.clearCompilationCache — purges V8's in-memory compiled-
            //      code cache (shared across contexts in the same renderer).
            //
            // Both are attempted; errors are non-fatal.
            try {
              await session.Network.enable();
              await session.Network.setCacheDisabled({ cacheDisabled: true });
              logInfo("attachedToTarget", `HTTP cache disabled for session ${sessionId}`);
            } catch (netErr) {
              logError("attachedToTarget setCacheDisabled", netErr);
            }
            try {
              await session.Page.enable();
              await session.Page.clearCompilationCache();
              logInfo("attachedToTarget", `V8 compilation cache cleared for session ${sessionId}`);
            } catch (cacheErr) {
              logError("attachedToTarget clearCompilationCache", cacheErr);
            }

            await session.Runtime.runIfWaitingForDebugger();
            reloadPending = false;
            logInfo("attachedToTarget", `session ${sessionId} resumed — coverage ready`);
          } else if (!reloadSent) {
            cdpClient = session;
            startCoverageCache();

            // Existing renderer (page already loaded, waitingForDebugger=false).
            // V8 compiled all scripts WITHOUT precise coverage before we connected.
            // Chrome's HTTP cache also stored pre-compiled bytecode alongside the
            // HTTP responses — so a simple reload would still skip recompilation.
            //
            // Fix: navigate the current tab to about:blank (drops its Testem
            // socket.io connection, aborting the stale /_coverage fetch with
            // AbortError so next() is NOT called prematurely), then open a FRESH
            // tab via createTarget. The new tab pauses with waitingForDebugger=true
            // before any JS runs, letting us clear the V8 compilation cache and
            // call startPreciseCoverage before any modules compile.
            reloadSent = true;
            reloadPending = true;
            newCoveragePromise = new Promise((resolve) => {
              newCoverageResolve = resolve;
            });
            const testUrl = targetInfo.url;
            await session.Page.enable();

            // Navigate the current tab away so its Testem.afterTests fetch
            // gets AbortError (the adapter skips calling next(), preventing
            // premature SIGTERM before the new tab's coverage is collected).
            session.Page.navigate({ url: "about:blank" }).catch(() => {});

            // Clear Chrome's HTTP disk cache using the first tab's page session.
            // Network.clearBrowserCache clears the ENTIRE browser's disk cache
            // (including V8 bytecode metadata stored alongside HTTP responses).
            // It must be called at page/session level (Network domain requires
            // an active session); calling it at browser level fails with
            // "'Network.clearBrowserCache' wasn't found".
            try {
              await session.Network.enable();
              await session.Network.clearBrowserCache();
              logInfo("attachedToTarget", `browser HTTP cache cleared via first-tab session`);
            } catch (clearErr) {
              logError("attachedToTarget clearBrowserCache", clearErr);
            }

            // Open fresh tab at the test URL. waitForDebuggerOnStart pauses it
            // before any JS, giving us the waitingForDebugger=true path above
            // for coverage setup (cache clear + resume).
            const { targetId } = await browser.Target.createTarget({ url: testUrl });
            coverageTabTargetId = targetId;
            logInfo(
              "attachedToTarget",
              `new coverage tab opened for ${testUrl} (target ${targetId})`,
            );
          }
          // else: reloadSent=true, waitingForDebugger=false → ignore (could be
          // a second auto-attach event for an already-handled session, or the
          // old tab reconnecting after navigate to about:blank).
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
    } catch (err) {
      logError("connectChromeDevTools", err);
      setTimeout(() => connectChromeDevTools(), CHECK_INTERVAL);
    }
  }

  function resolveNewCoverage(result) {
    if (newCoverageResolve) {
      newCoverageResolve(result);
      newCoverageResolve = null;
    }
  }

  async function handleStaleRequest(res, logLabel) {
    reloadPending = false;
    logInfo(logLabel, "stale request — holding connection, waiting for post-reload coverage");
    await Promise.race([
      newCoveragePromise ?? Promise.resolve(null),
      new Promise((resolve) => setTimeout(() => resolve(null), 15_000)),
    ]);
    try {
      res.json({ ok: true, stale: true });
    } catch {
      // ignore — stale connection already closed by Chrome
    }
  }

  void connectChromeDevTools();

  return function coverageMiddleware(app) {
    app.get(REPORT_TO_MIDDLEWARE_PATH, async (req, res) => {
      logInfo(
        REPORT_TO_MIDDLEWARE_PATH,
        `request received, cdpClient=${cdpClient ? "connected" : "null"}, reloadPending=${reloadPending}`,
      );

      // Stale-request gate
      // ------------------
      // reloadPending is true between the moment we send Page.reload() and the
      // moment the new page's REPORT_TO_MIDDLEWARE_PATH request is processed. Any request that
      // arrives while the flag is set came from the pre-reload test run — its
      // coverage data is useless (scripts hadn't run under coverage yet).
      //
      // We hold this stale connection open (the Testem adapter's keepAlive
      // timer keeps Chrome alive while the fetch is pending) and wait for the
      // new page's handler to collect correct coverage and resolve
      // newCoveragePromise. Then we close this stale connection gracefully.
      if (reloadPending) {
        await handleStaleRequest(res, REPORT_TO_MIDDLEWARE_PATH);
        return;
      }

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

        // Re-check reloadPending here: the flag may have been set while we
        // were waiting for cdpClient above (the /_coverage request arrived
        // before the middleware connected to CDP, so it missed the entry-point
        // check at the top of the handler). Take the stale path now if so.
        if (reloadPending) {
          await handleStaleRequest(res, "/_coverage");
          return;
        }

        try {
          const { result } = await cdpClient.Profiler.takePreciseCoverage();
          logInfo("/_coverage", `takePreciseCoverage succeeded: ${result.length} scripts`);
          coverageResult = result;
          resolveNewCoverage(result);
          break;
        } catch (err) {
          logError("takePreciseCoverage (will retry after reconnect)", err);
          // Chrome may have exited (SIGTERM race). Try the proactive cache
          // before giving up — it is refreshed every CACHE_INTERVAL ms and
          // will be complete if tests finished more than CACHE_INTERVAL ms ago.
          if (coverageCache) {
            logInfo("/_coverage", `using cached coverage (${coverageCache.length} scripts)`);
            coverageResult = coverageCache;
            resolveNewCoverage(coverageCache);
            break;
          }
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
        // Generate the report before responding. The browser's afterTests hook
        // is still awaiting this response, so Chrome stays alive until we're
        // done. Output goes to process.stdout of the testem process and appears
        // directly in the terminal.
        await generateReport(coverageResult, {
          coverageDir: outputPath,
          distDir,
          include,
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
