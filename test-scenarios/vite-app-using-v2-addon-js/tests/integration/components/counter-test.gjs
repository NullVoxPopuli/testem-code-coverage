import { module, test } from 'qunit';
import { setupRenderingTest } from 'vite-app-using-v2-addon-js/tests/helpers';
import { render, click } from '@ember/test-helpers';
import Counter from 'vite-app-using-v2-addon-js/components/counter';

module('Integration | Component | counter', function (hooks) {
  setupRenderingTest(hooks);

  test('it renders the initial label', async function (assert) {
    await render(<template><Counter /></template>);

    assert.dom('[data-test-label]').hasText('Count: 0');
  });

  test('increment button increases the count', async function (assert) {
    await render(<template><Counter /></template>);

    await click('[data-test-increment]');
    assert.dom('[data-test-label]').hasText('Count: 1');

    await click('[data-test-increment]');
    assert.dom('[data-test-label]').hasText('Count: 2');
  });

  // reset(), double, and decrement() are deliberately NOT tested here so they
  // show as uncovered functions in the coverage report.
});
