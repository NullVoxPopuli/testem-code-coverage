import { REPORT_TO_MIDDLEWARE_PATH } from "#utils";

export function setupCoverage(_qunitRef) {
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
  /* global Testem */
  if (typeof Testem !== "undefined") {
    Testem.afterTests(async function (err, data, next) {
      const keepAlive = setInterval(function () {}, 50);
      try {
        await fetch(REPORT_TO_MIDDLEWARE_PATH);
      } catch {
        // Best-effort: never fail the test run due to coverage errors.
      } finally {
        clearInterval(keepAlive);
        next();
      }
    });
  } else {
    // Fallback for environments where Testem is not available.
    _qunitRef.done(async function () {
      const keepAlive = setInterval(function () {}, 50);
      try {
        await fetch(REPORT_TO_MIDDLEWARE_PATH);
      } catch {
        // ignore
      } finally {
        clearInterval(keepAlive);
      }
    });
  }
}
