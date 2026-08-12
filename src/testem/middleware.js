/**
 * Testem middleware that:
 *  1. Discovers every Chrome testem launches and connects to each one via the
 *     DevTools Protocol (CDP), enabling precise coverage collection.
 *  2. Reloads each page after enabling coverage so V8 tracks every byte from
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
 * temporarily refuses NEW connections (ECONNREFUSED) while the new renderer
 * starts.
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
 *
 * Several browsers at once
 * ------------------------
 * testem runs N browsers in parallel (ember-exam's --parallel, testem's own
 * parallel option). Every one of them gets the SAME browser_args, because
 * testem resolves that config once per browser *name*, not per instance — so
 * a hard-coded --remote-debugging-port=9222 means only the first Chrome binds
 * the port and the rest expose no CDP endpoint at all. Coverage would then
 * silently describe 1/N of the suite.
 *
 * So for parallel runs we do not pick the port; Chrome tells us. Each launcher
 * gets its own --user-data-dir (testem's Launcher#setupBrowserTmpDir), and a
 * Chrome started with --remote-debugging-port=0 writes the port it actually
 * bound into <user-data-dir>/DevToolsActivePort. We poll for those files,
 * connect to every browser we find, keep one coverage session per browser, and
 * merge the per-browser V8 snapshots into a single report at the end.
 *
 * Note that Chrome writes DevToolsActivePort ONLY for an ephemeral (0) port —
 * with a pinned port there is nothing to announce, so no file appears. Pinned
 * ports are therefore still handled by seeding chrome.remoteDebuggingPort
 * (default 9222) directly; discovery does not and cannot replace that path.
 */

import { isAbsolute, join } from "node:path";
import fs from "node:fs";
import os from "node:os";
import CDP from "chrome-remote-interface";
import { mergeProcessCovs } from "@bcoe/v8-coverage";
import { generateReport } from "#v8/report.js";
import { REPORT_TO_MIDDLEWARE_PATH } from "#utils";

const CHECK_INTERVAL = 500; // ms
const DISCOVERY_INTERVAL = 250; // ms

function normalizeReporters(reporters) {
  if (reporters === undefined) return undefined;

  if (!Array.isArray(reporters)) {
    throw new TypeError("[coverage] reporters must be an array of Istanbul reporter names.");
  }

  const normalized = reporters.map((reporter) => {
    if (typeof reporter !== "string" || reporter.trim() === "") {
      throw new TypeError("[coverage] reporters must only contain non-empty strings.");
    }

    return reporter.trim();
  });

  return [...new Set(normalized)];
}

/**
 * Chrome writes DevToolsActivePort into its --user-data-dir as soon as the
 * DevTools endpoint is listening. Line 1 is the port; line 2 is the browser
 * target path (which we don't need — CDP.Version gives us the same thing).
 */
function readDevToolsPort(file) {
  try {
    const port = Number(fs.readFileSync(file, "utf8").split("\n")[0].trim());

    return Number.isInteger(port) && port > 0 ? port : null;
  } catch {
    // Not written yet, or the dir vanished when testem cleaned up.
    return null;
  }
}

/**
 * Find the DevTools port of every Chrome testem has launched for THIS run.
 *
 * testem's Launcher#setupBrowserTmpDir creates `<userDataDir>/testem-<id>-XXXXXX`
 * per browser instance and passes it as --user-data-dir (known-browsers.js).
 * userDataDir defaults to os.tmpdir(), which is shared — so a concurrent
 * testem run (another CI job, another scenario) leaves its own testem-* dirs
 * lying around. Attaching to those would pull a foreign browser's coverage
 * into this report, so only directories created since we started count.
 */
function discoverBrowserPorts(userDataDir, since) {
  const ports = new Map();

  let entries;

  try {
    entries = fs.readdirSync(userDataDir, { withFileTypes: true });
  } catch {
    return ports;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("testem-")) continue;

    const dir = join(userDataDir, entry.name);

    try {
      if (fs.statSync(dir).mtimeMs < since) continue;
    } catch {
      continue;
    }

    const port = readDevToolsPort(join(dir, "DevToolsActivePort"));

    if (port !== null) ports.set(port, dir);
  }

  return ports;
}

export function middleware(options = {}) {
  const {
    outputFolder = "coverage",
    distDir,
    handleReport,
    include,
    exclude,
    chrome,
    debug = false,
    reporters,
  } = options;
  const {
    connectionTimeout = 30_000,
    remoteDebuggingPort = 9222,
    userDataDir = os.tmpdir(),
    cacheInterval = 100,
    stragglerTimeout = 30_000,
  } = chrome || {};
  const normalizedReporters = normalizeReporters(reporters);

  const cwd = process.cwd();

  // Discovery only considers user-data-dirs created after this point, so a
  // concurrent testem run's leftovers can't be mistaken for our browsers.
  // The 5s slack absorbs coarse filesystem mtime granularity.
  const startedAt = Date.now() - 5_000;

  const outputPath = isAbsolute(outputFolder) ? outputFolder : join(cwd, outputFolder);
  const outputFile = join(outputPath, "coverage-data.json");
  const errorLog = join(outputPath, "errors.log");

  function writeLog(line) {
    if (debug) process.stderr.write(line);
    try {
      fs.mkdirSync(outputPath, { recursive: true });
      fs.appendFileSync(errorLog, line);
    } catch {
      // If we can't write the log file, stderr is the fallback.
      if (!debug) process.stderr.write(line);
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

  // One entry per Chrome, keyed by its DevTools port. Everything that used to
  // be middleware-level state (the CDP session, the coverage accumulator, the
  // reload gate) is per-browser, because N browsers reload and finish
  // independently of each other.
  const browsers = new Map();
  let reportPromise = null;

  function createBrowserState(port) {
    return {
      port,
      /** Page-level CDP session currently collecting coverage, or null. */
      cdpClient: null,
      /**
       * testem's per-browser id, taken from the test page URL path prefix.
       * This is what ties an incoming /_coverage request to this browser.
       */
      testemId: null,
      /** Accumulated V8 coverage deltas — see mergeIntoCache. */
      coverageCache: null,
      cacheTimerHandle: null,
      coverageFinalized: false,
      /** Final merged V8 snapshot for this browser, once collected. */
      result: null,
      reported: false,
      /**
       * True once the browser-level CDP handshake succeeded. The default 9222
       * seed is speculative — if nothing is listening there, that entry must not
       * gate the report, or every ephemeral-port run would stall until the
       * straggler timeout waiting on a browser that never existed.
       */
      connected: false,
      // Reload gate — see the long comment on handleStaleRequest.
      reloadPending: false,
      newCoveragePromise: null,
      newCoverageResolve: null,
      reloadSent: false,
      coverageTabTargetId: null,
      connectStart: null,
    };
  }

  /**
   * Proactive coverage accumulator — refreshed every CACHE_INTERVAL ms while
   * tests are running, so a complete snapshot is always available as a
   * fallback if Chrome exits before the live takePreciseCoverage() call in
   * /_coverage can complete (Linux SIGTERM race: testem sends SIGTERM to
   * Chrome ~14ms after the final TAP line).
   *
   * Profiler.takePreciseCoverage RESETS V8's execution counters
   * ------------------------------------------------------------
   * Each call returns only the activity since the previous call — a delta,
   * not a cumulative snapshot. Functions whose counters were consumed by an
   * earlier take may be entirely absent from later takes.
   *
   * Because of that, every take (the periodic ones here AND the final live
   * one in /_coverage) is merged into the browser's coverageCache with
   * @bcoe/v8-coverage's mergeProcessCovs — the same algorithm c8 uses to
   * combine V8 coverage from multiple processes. Counts sum across deltas, so
   * the accumulated result is equivalent to one uninterrupted coverage
   * session. It is also exactly what we need to fold N browsers together at
   * the end, since each browser is just another set of deltas.
   *
   * (A previous version assumed counters were cumulative and kept only the
   * LATEST take, so the final report reflected just the last ~CACHE_INTERVAL
   * ms of the run. Which functions survived was a timing race that played out
   * differently per OS — issue #22.)
   */
  const CACHE_INTERVAL = cacheInterval;

  /**
   * How much of a browser's time this accumulator is allowed to consume.
   *
   * A fixed short interval quietly assumes takePreciseCoverage is cheap. It is
   * not: V8 serialises every script currently loaded, so the cost scales with
   * the app. Measured on a mid-size Ember app it was mean 35ms / p90 98ms /
   * max 188ms per call — against a 100ms interval, i.e. the browser was doing
   * little else, and with N browsers on one machine that is enough to push
   * tests past their own timeouts.
   *
   * So the next take is scheduled off how long the last one actually took, at
   * roughly a 1/(FACTOR+1) duty cycle, and never sooner than cacheInterval.
   * Small apps keep the old cadence; large apps back off on their own instead
   * of needing every consumer to discover this and tune it by hand.
   */
  const CACHE_DUTY_FACTOR = 9;

  function nextCacheDelay(lastTakeMs) {
    return Math.max(CACHE_INTERVAL, lastTakeMs * CACHE_DUTY_FACTOR);
  }

  function mergeIntoCache(state, result) {
    state.coverageCache = state.coverageCache
      ? mergeProcessCovs([{ result: state.coverageCache }, { result }]).result
      : result;

    return state.coverageCache;
  }

  function startCoverageCache(state) {
    if (state.cacheTimerHandle) clearTimeout(state.cacheTimerHandle);
    state.coverageCache = null;
    state.cacheTimerHandle = setTimeout(() => refreshCoverageCache(state), CACHE_INTERVAL);
  }

  async function refreshCoverageCache(state) {
    const session = state.cdpClient;

    if (!session || state.coverageFinalized) return;

    let elapsed = 0;

    try {
      const startedAt = Date.now();
      const { result } = await session.Profiler.takePreciseCoverage();

      elapsed = Date.now() - startedAt;

      // Discard the delta if the session changed while the call was in flight
      // (e.g. the pre-reload tab's stale data arriving after the fresh
      // coverage tab attached and reset the cache) or if the final result was
      // already collected.
      if (result && state.cdpClient === session && !state.coverageFinalized) {
        mergeIntoCache(state, result);
      }
    } catch {
      // Ignore — will retry on next interval
    }
    // Schedule the next refresh only if this browser's session is still alive.
    if (state.cdpClient && !state.coverageFinalized) {
      state.cacheTimerHandle = setTimeout(
        () => refreshCoverageCache(state),
        nextCacheDelay(elapsed),
      );
    }
  }

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
   * testem serves each browser's test page under a numeric id prefix
   * (`/<id>/tests/index.html`). The runtime hook sends that same id back on
   * /_coverage, so recording it here is what lets a request find its browser.
   */
  function testemIdFromUrl(url) {
    try {
      const first = new URL(url).pathname.split("/")[1];

      return /^-?[0-9]+$/.test(first) ? first : null;
    } catch {
      return null;
    }
  }

  /**
   * Connect to one Chrome's DevTools endpoint.
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
  async function connectChromeDevTools(state) {
    const now = Date.now();

    if (!state.connectStart) {
      state.connectStart = now;
    }

    if (now - state.connectStart >= connectionTimeout) {
      const msg = `Could not connect to Chrome CDP on port ${state.port} after ${Math.round(connectionTimeout / 1000)}s — coverage disabled for this browser.`;

      console.warn(`[coverage] ${msg}`);
      logError("connectChromeDevTools", new Error(msg));
      browsers.delete(state.port);

      return;
    }

    try {
      // 1. Browser-level connection — not tied to any page renderer.
      //    We must use /json/version to get the browser's own WebSocket URL;
      //    CDP({ port }) without a target connects to the first *page* target.
      const version = await CDP.Version({ port: state.port });
      const browserWsUrl = version.webSocketDebuggerUrl;

      if (!browserWsUrl)
        throw new Error(
          "No webSocketDebuggerUrl in /json/version — Chrome may not expose the browser endpoint",
        );

      const browser = await CDP({ target: browserWsUrl });

      logInfo(
        "connectChromeDevTools",
        `browser-level connection established on port ${state.port}`,
      );
      state.connected = true;
      logInfo("connectChromeDevTools", `[:${state.port}] ready`);

      browser.on("disconnect", () => {
        logInfo("browser", `browser-level connection closed on port ${state.port}`);
      });

      // 2. Auto-attach with flatten:true — required for browser-level auto-attach.
      //    This fires attachedToTarget for ALL existing page targets immediately,
      //    and for any new page targets (e.g. after Page.reload on Linux).
      browser.Target.attachedToTarget(async ({ targetInfo, waitingForDebugger, sessionId }) => {
        if (targetInfo.type !== "page") return;
        logInfo(
          "attachedToTarget",
          `[:${state.port}] page target ${targetInfo.targetId}, sessionId=${sessionId}, waitingForDebugger=${waitingForDebugger}`,
        );
        try {
          const session = createSessionClient(browser, sessionId);

          await session.Profiler.enable();
          await session.Profiler.startPreciseCoverage({
            callCount: true,
            detailed: true,
          });
          logInfo("attachedToTarget", `[:${state.port}] coverage started on session ${sessionId}`);

          const seenId = testemIdFromUrl(targetInfo.url);

          if (seenId) state.testemId = seenId;

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
            if (state.coverageTabTargetId && targetInfo.targetId !== state.coverageTabTargetId) {
              logInfo(
                "attachedToTarget",
                `[:${state.port}] ignoring spurious waitingForDebugger tab (target ${targetInfo.targetId}, expected ${state.coverageTabTargetId})`,
              );
              await session.Runtime.runIfWaitingForDebugger();

              return;
            }

            state.cdpClient = session;
            startCoverageCache(state);

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
              logInfo(
                "attachedToTarget",
                `[:${state.port}] HTTP cache disabled for session ${sessionId}`,
              );
            } catch (netErr) {
              logError("attachedToTarget setCacheDisabled", netErr);
            }
            try {
              await session.Page.enable();
              await session.Page.clearCompilationCache();
              logInfo(
                "attachedToTarget",
                `[:${state.port}] V8 compilation cache cleared for session ${sessionId}`,
              );
            } catch (cacheErr) {
              logError("attachedToTarget clearCompilationCache", cacheErr);
            }

            await session.Runtime.runIfWaitingForDebugger();
            state.reloadPending = false;
            logInfo(
              "attachedToTarget",
              `[:${state.port}] session ${sessionId} resumed — coverage ready`,
            );
          } else if (!state.reloadSent) {
            state.cdpClient = session;
            startCoverageCache(state);

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
            state.reloadSent = true;
            state.reloadPending = true;
            state.newCoveragePromise = new Promise((resolve) => {
              state.newCoverageResolve = resolve;
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
              logInfo(
                "attachedToTarget",
                `[:${state.port}] browser HTTP cache cleared via first-tab session`,
              );
            } catch (clearErr) {
              logError("attachedToTarget clearBrowserCache", clearErr);
            }

            // Open fresh tab at the test URL. waitForDebuggerOnStart pauses it
            // before any JS, giving us the waitingForDebugger=true path above
            // for coverage setup (cache clear + resume).
            const { targetId } = await browser.Target.createTarget({
              url: testUrl,
            });

            state.coverageTabTargetId = targetId;
            logInfo(
              "attachedToTarget",
              `[:${state.port}] new coverage tab opened for ${testUrl} (target ${targetId})`,
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
        if (state.cdpClient && state.cdpClient._sessionId === detachedId) {
          logInfo(
            "detachedFromTarget",
            `[:${state.port}] session ${detachedId} detached — cdpClient → null`,
          );
          state.cdpClient = null;
        }
      });

      await browser.Target.setAutoAttach({
        autoAttach: true,
        waitForDebuggerOnStart: true,
        flatten: true,
      });
      logInfo("connectChromeDevTools", `[:${state.port}] setAutoAttach configured`);
    } catch (err) {
      logError("connectChromeDevTools", err);
      setTimeout(() => connectChromeDevTools(state), CHECK_INTERVAL);
    }
  }

  /**
   * Poll for Chromes as testem launches them. Browsers can appear at any point
   * during a run (testem staggers launches, and ember-exam re-launches after a
   * browser dies), so this keeps running until the report is generated.
   */
  function startDiscovery() {
    const seed = Number(remoteDebuggingPort);

    // A fixed port is still seeded directly, and still defaults to 9222.
    //
    // Discovery cannot replace this: Chrome only writes DevToolsActivePort when
    // it was given --remote-debugging-port=0, because that is the only case where
    // the caller can't already know the port. A config that pins the port is
    // therefore invisible to discovery, and dropping this default silently broke
    // every single-browser setup that relied on it.
    //
    // The two mechanisms are complementary rather than redundant: pinned ports
    // come in here, and the ephemeral ports that parallel browsers must use come
    // in via discovery below.
    if (Number.isInteger(seed) && seed > 0) {
      const state = createBrowserState(seed);

      browsers.set(seed, state);
      void connectChromeDevTools(state);
    }

    const tick = () => {
      for (const port of discoverBrowserPorts(userDataDir, startedAt).keys()) {
        if (browsers.has(port)) continue;

        const state = createBrowserState(port);

        browsers.set(port, state);
        logInfo("discovery", `found Chrome on port ${port}`);
        void connectChromeDevTools(state);
      }

      if (!reportPromise) setTimeout(tick, DISCOVERY_INTERVAL).unref?.();
    };

    tick();
  }

  function resolveNewCoverage(state, result) {
    if (state.newCoverageResolve) {
      state.newCoverageResolve(result);
      state.newCoverageResolve = null;
    }
  }

  async function handleStaleRequest(state, res, logLabel) {
    state.reloadPending = false;
    logInfo(logLabel, "stale request — holding connection, waiting for post-reload coverage");
    await Promise.race([
      state.newCoveragePromise ?? Promise.resolve(null),
      new Promise((resolve) => setTimeout(() => resolve(null), 15_000)),
    ]);
    try {
      res.json({ ok: true, stale: true });
    } catch {
      // ignore — stale connection already closed by Chrome
    }
  }

  /**
   * Resolve an incoming /_coverage request to the browser that sent it.
   *
   * The request can beat its own browser's CDP connection (discovery polls,
   * and the CDP handshake takes a moment), so wait rather than give up. With a
   * single browser there is nothing to disambiguate, so any id matches.
   */
  async function findBrowserState(testemId, deadline) {
    while (Date.now() < deadline) {
      if (!testemId && browsers.size === 1) return [...browsers.values()][0];

      const match = [...browsers.values()].find((s) => s.testemId === testemId);

      if (match) return match;

      // Before any page has attached we don't know any browser's testem id.
      // A lone browser is still unambiguous.
      if (browsers.size === 1) {
        const only = [...browsers.values()][0];

        if (only.testemId === null) return only;
      }

      await new Promise((r) => setTimeout(r, 50));
    }

    return null;
  }

  /**
   * Take this browser's final coverage delta and fold it into its accumulator.
   *
   * cdpClient may be null if the page session was destroyed mid-request
   * (detachedFromTarget fired) and the new session's attachedToTarget hasn't
   * fired yet — so wait for it to be restored.
   */
  async function collectFinalCoverage(state, res) {
    const deadline = Date.now() + 10_000;

    while (Date.now() < deadline) {
      while (!state.cdpClient && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!state.cdpClient) break;

      // Re-check reloadPending here: the flag may have been set while we
      // were waiting for cdpClient above (the /_coverage request arrived
      // before the middleware connected to CDP, so it missed the entry-point
      // check in the handler). Take the stale path now if so.
      if (state.reloadPending) {
        await handleStaleRequest(state, res, REPORT_TO_MIDDLEWARE_PATH);

        return "stale";
      }

      try {
        const { result } = await state.cdpClient.Profiler.takePreciseCoverage();

        logInfo(
          REPORT_TO_MIDDLEWARE_PATH,
          `[:${state.port}] takePreciseCoverage succeeded: ${result.length} scripts`,
        );

        // The live take only holds the delta since the last periodic take —
        // merge it with the accumulated deltas for the full picture.
        const merged = mergeIntoCache(state, result);

        state.coverageFinalized = true;
        resolveNewCoverage(state, merged);

        return merged;
      } catch (err) {
        logError("takePreciseCoverage (will retry after reconnect)", err);
        // Chrome may have exited (SIGTERM race). Try the proactive cache
        // before giving up — it is refreshed every CACHE_INTERVAL ms and
        // will be complete if tests finished more than CACHE_INTERVAL ms ago.
        if (state.coverageCache) {
          logInfo(
            REPORT_TO_MIDDLEWARE_PATH,
            `[:${state.port}] using cached coverage (${state.coverageCache.length} scripts)`,
          );
          state.coverageFinalized = true;
          resolveNewCoverage(state, state.coverageCache);

          return state.coverageCache;
        }
        // The WebSocket likely closed simultaneously. The disconnect handler
        // will null out cdpClient; give it a moment then loop back to the wait.
        state.cdpClient = null;
        await new Promise((r) => setTimeout(r, 50));
      }
    }

    return null;
  }

  /**
   * Wait for the other browsers, then emit ONE merged report.
   *
   * Each browser's afterTests hook is still awaiting its HTTP response while
   * this runs, and testem does not kill a browser until that hook calls
   * next() — so holding the response open is what keeps the earlier-finishing
   * browsers alive. That is deliberate: it means no browser is torn down while
   * another is still producing coverage.
   *
   * A browser that dies without ever reporting (crash, testem timeout) would
   * otherwise hang the whole run, so the wait is bounded by stragglerTimeout
   * and we report on whatever we have.
   */
  function connectedBrowsers() {
    return [...browsers.values()].filter((s) => s.connected);
  }

  function everyoneReported() {
    return connectedBrowsers().every((s) => s.reported);
  }

  async function waitForOtherBrowsers() {
    const deadline = Date.now() + stragglerTimeout;

    while (Date.now() < deadline && !everyoneReported()) {
      await new Promise((r) => setTimeout(r, 50));
    }

    if (!everyoneReported()) {
      const missing = connectedBrowsers()
        .filter((s) => !s.reported)
        .map((s) => s.port);

      logError(
        "report",
        new Error(
          `Timed out after ${Math.round(stragglerTimeout / 1000)}s waiting for coverage from port(s) ${missing.join(", ")} — reporting without them.`,
        ),
      );
    }
  }

  async function generateMergedReport() {
    const results = [...browsers.values()].map((s) => s.result).filter(Boolean);

    if (results.length === 0) return null;

    // Folding browsers together is the same operation as folding one browser's
    // periodic deltas together: sum the counts per script.
    const merged =
      results.length === 1
        ? results[0]
        : mergeProcessCovs(results.map((result) => ({ result }))).result;

    logInfo("report", `merging coverage from ${results.length} browser(s)`);

    fs.mkdirSync(outputPath, { recursive: true });
    fs.writeFileSync(outputFile, JSON.stringify(merged));

    await generateReport(merged, {
      coverageDir: outputPath,
      distDir,
      include,
      exclude,
      debug,
      reporters: normalizedReporters,
    });

    await handleReport?.(merged);

    // generateReport clears the coverage directory before writing the
    // report, which removes the raw snapshot written above — write it
    // again so it survives for debugging.
    fs.writeFileSync(outputFile, JSON.stringify(merged));

    return merged;
  }

  startDiscovery();

  return function coverageMiddleware(app) {
    app.get(REPORT_TO_MIDDLEWARE_PATH, async (req, res) => {
      const testemId = req.query?.id ? String(req.query.id) : null;
      const state = await findBrowserState(testemId, Date.now() + 15_000);

      if (!state) {
        const msg = `No Chrome DevTools connection for testem browser ${testemId ?? "(unidentified)"} — coverage unavailable`;

        logError(REPORT_TO_MIDDLEWARE_PATH, new Error(msg));
        res.status(503).json({ error: msg });

        return;
      }

      logInfo(
        REPORT_TO_MIDDLEWARE_PATH,
        `[:${state.port}] request received (testem id ${testemId ?? "?"}), cdpClient=${state.cdpClient ? "connected" : "null"}, reloadPending=${state.reloadPending}`,
      );

      // Stale-request gate
      // ------------------
      // reloadPending is true between the moment we swap in the fresh coverage
      // tab and the moment that new page's request is processed. Any request
      // that arrives while the flag is set came from the pre-reload test run —
      // its coverage data is useless (scripts hadn't run under coverage yet).
      //
      // We hold this stale connection open (the Testem adapter's keepAlive
      // timer keeps Chrome alive while the fetch is pending) and wait for the
      // new page's handler to collect correct coverage and resolve
      // newCoveragePromise. Then we close this stale connection gracefully.
      if (state.reloadPending) {
        await handleStaleRequest(state, res, REPORT_TO_MIDDLEWARE_PATH);

        return;
      }

      const result = await collectFinalCoverage(state, res);

      // The stale path already responded.
      if (result === "stale") return;

      if (!result) {
        const msg = `Could not collect coverage from port ${state.port} — CDP connection lost`;

        logError(REPORT_TO_MIDDLEWARE_PATH, new Error(msg));
        // Let the other browsers finish rather than hanging them on this one.
        state.reported = true;
        res.status(503).json({ error: msg });

        return;
      }

      state.result = result;
      state.reported = true;

      try {
        // The first browser to finish owns report generation; the rest await
        // the same promise so the report is written exactly once.
        if (!reportPromise) {
          reportPromise = waitForOtherBrowsers().then(generateMergedReport);
        }

        const merged = await reportPromise;

        res.json({ ok: true, scripts: merged ? merged.length : 0 });
      } catch (err) {
        logError("/_coverage handler", err);
        console.error("\n[coverage] Error generating report:", err.stack || err.message);
        res.status(500).json({ error: err.message });
      }
    });
  };
}
