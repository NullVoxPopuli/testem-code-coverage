import "@warp-drive/ember/install";
import Application from "vite-app-using-v2-addon-js/app";
import config from "vite-app-using-v2-addon-js/config/environment";
import * as QUnit from "qunit";
import { setApplication } from "@ember/test-helpers";
import { setup } from "qunit-dom";
import { start as qunitStart, setupEmberOnerrorValidation } from "ember-qunit";
import { setupCoverage } from "testem-code-coverage/qunit";

export function start() {
  setApplication(Application.create(config.APP));

  setup(QUnit.assert);
  setupEmberOnerrorValidation();
  setupCoverage(QUnit);
  qunitStart();
}
