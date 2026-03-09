import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { action } from '@ember/object';
import { on } from '@ember/modifier';

export default class Counter extends Component {
  @tracked count = 0;

  // ── used in the template ──────────────────────────────────────────────────

  get label() {
    return `Count: ${this.count}`;
  }

  @action
  increment() {
    this.count++;
  }

  // ── NOT used in the template — will appear as uncovered ──────────────────

  // Plain (undecorated) methods: their bodies only execute when explicitly
  // called, so V8 precise coverage correctly marks them as uncovered.

  clampedCount(max) {
    if (this.count > max) {
      return max;
    }
    return this.count;
  }

  countAsString() {
    return String(this.count);
  }

  <template>
    <div data-test-counter>
      <p data-test-label>{{this.label}}</p>
      <button data-test-increment type="button" {{on "click" this.increment}}>
        +1
      </button>
    </div>
  </template>
}
