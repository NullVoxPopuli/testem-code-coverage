import { module, test } from 'qunit';
import TrackedBox from 'vite-app-using-v2-addon-js/utils/tracked-box';

module('Unit | Utility | tracked-box', function () {
  test('doubles the tracked value', function (assert) {
    const box = new TrackedBox();
    assert.strictEqual(box.doubled, 0);

    box.value = 21;
    assert.strictEqual(box.doubled, 42);
  });
});
