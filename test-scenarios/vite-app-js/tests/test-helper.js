import '@warp-drive/ember/install';
import Application from 'ember-chrome-coverage-demo/app';
import config from 'ember-chrome-coverage-demo/config/environment';
import * as QUnit from 'qunit';
import { setApplication } from '@ember/test-helpers';
import { setup } from 'qunit-dom';
import { start as qunitStart, setupEmberOnerrorValidation } from 'ember-qunit';

export function start() {
  setApplication(Application.create(config.APP));

  setup(QUnit.assert);
  setupEmberOnerrorValidation();

  // Once all tests finish, ask the middleware to snapshot and save coverage
  // data. QUnit awaits async done() callbacks (via runLoggingCallbacks) before
  // emitting the final TAP summary line, so this fetch completing is what gates
  // Chrome's shutdown — making it the correct and only place to collect data.
  QUnit.done(async function () {
    try {
      await fetch('/_coverage');
    } catch {
      // Silently ignore — coverage is best-effort and must never fail the run.
    }
  });

  qunitStart();
}
