/* global Testem */
import { REPORT_TO_MIDDLEWARE_PATH } from "#utils";

/**
 * testem serves each browser's test page under a numeric id prefix
 * (`/<id>/tests/index.html` — see testem's server route
 * `/^\/(?:-?[0-9]+)(\/.+)$/`). When testem runs several browsers in parallel
 * each one gets its own id, and that id is the only thing on the page that
 * tells the middleware WHICH browser is reporting — so it can take coverage
 * from that browser's own CDP session rather than another browser's.
 *
 * Returns "" when the page isn't served under an id prefix (a page opened
 * directly, say), in which case the middleware falls back to the sole
 * connected browser.
 */
function browserId() {
  const first = String(location.pathname).split("/")[1];

  return /^-?[0-9]+$/.test(first) ? first : "";
}

function reportUrl() {
  const id = browserId();

  if (!id) return REPORT_TO_MIDDLEWARE_PATH;

  return `${REPORT_TO_MIDDLEWARE_PATH}?id=${encodeURIComponent(id)}`;
}

export function setupCoverage() {
  // Testem will not be defined at dev-time
  if (typeof Testem === "undefined") return;

  // Use Testem.afterTests() to collect coverage before Chrome is killed.
  //
  // Why Testem.afterTests() instead of QUnit.done()
  // ------------------------------------------------
  // testem's own qunit_adapter.js registers a synchronous QUnit.done() that
  // calls emit('all-test-results'). testem_client.js handles that event by
  // calling Testem.runAfterTests(), which drains the afterTestsQueue and then
  // emits 'after-tests-complete'. The server receives 'after-tests-complete'
  // and sends SIGTERM to Chrome.
  //
  // Our QUnit.done() runs AFTER testem's (we register later), so by the time
  // our async done() starts its fetch, the afterTestsQueue is already empty
  // and 'after-tests-complete' has already been sent — Chrome gets SIGTERMed
  // while our fetch is still in-flight.
  //
  // Testem.afterTests(cb) pushes cb into afterTestsQueue. runAfterTests() will
  // call cb(null, null, next) instead of emitting 'after-tests-complete' right
  // away. Chrome is not killed until we call next(). This gives us full control
  // over the timing of Chrome's shutdown.
  //
  // The keepAlive timer prevents Chrome's event loop from going idle while the
  // fetch awaits a response (Linux headless Chrome may exit if the event loop
  // is empty, even with a pending HTTP request). A live timer is treated as
  // "real work" by Chrome's scheduler.
  Testem.afterTests(async function (err, data, next) {
    const keepAlive = setInterval(function () {}, 50);
    try {
      await fetch(reportUrl());
      clearInterval(keepAlive);
      next();
    } catch (fetchErr) {
      clearInterval(keepAlive);
      // AbortError means the page is navigating away (e.g. due to
      // Page.reload() triggered by the middleware to restart scripts under
      // V8 coverage). In that case we must NOT call next() here — the new
      // page will re-register Testem.afterTests and call next() after the
      // coverage request completes.
      //
      // For any other error (network failure, middleware crash, etc.) we
      // call next() as a best-effort fallback so the test run is not hung.
      if (fetchErr && fetchErr.name !== "AbortError") {
        next();
      }
    }
  });
}
