import { module, test } from "qunit";
import { setupTest } from "vite-app-js-using-base/tests/helpers";
import { matchRoute } from "vite-app-js-using-base/utils/match-route";

module("Unit | Utility | match-route", function (hooks) {
  setupTest(hooks);

  test("extracts the dynamic segment of a matching path", function (assert) {
    assert.strictEqual(matchRoute("/scores/12"), "12");
  });

  test("returns null when nothing matches", function (assert) {
    assert.strictEqual(matchRoute("/nope"), null);
  });
});
