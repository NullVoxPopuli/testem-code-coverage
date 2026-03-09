import { module, test } from 'qunit';
import { setupTest } from 'ember-chrome-coverage-demo/tests/helpers';
import { formatScore } from 'ember-chrome-coverage-demo/utils/format-score';

module('Unit | Utility | format-score', function (hooks) {
  setupTest(hooks);

  test('returns "No score yet" for zero', function (assert) {
    assert.strictEqual(formatScore(0), 'No score yet');
  });

  test('formats a positive score with default unit', function (assert) {
    assert.strictEqual(formatScore(42), '42 pts');
  });

  test('formats a positive score with a custom unit', function (assert) {
    assert.strictEqual(formatScore(7, { unit: 'goals' }), '7 goals');
  });

  // The score < 0 branch is deliberately NOT tested so it appears as an
  // uncovered branch in the coverage report.
});
