import { REPORT_TO_MIDDLEWARE_PATH } from "#utils";

export function setupCoverage(qunitRef) {
  // Once all tests finish, ask the middleware to snapshot and save coverage
  // data. QUnit awaits async done() callbacks (via runLoggingCallbacks) before
  // emitting the final TAP summary line, so this fetch completing is what gates
  // Chrome's shutdown — making it the correct and only place to collect data.
  qunitRef.done(async function () {
    try {
      await fetch(REPORT_TO_MIDDLEWARE_PATH);
    } catch {
      // Silently ignore — coverage is best-effort and must never fail the run.
    }
  });
}
