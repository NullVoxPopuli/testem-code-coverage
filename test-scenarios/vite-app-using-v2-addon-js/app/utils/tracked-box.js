import { tracked } from '@glimmer/tracking';

// Fully exercised by tests/unit/tracked-box-test.js — must report 100%
// coverage, including 100% functions. The compiled class contains helper
// functions that do not exist here (decorator static block,
// instance-members initializer); those must not appear in the functions
// metric (issue #29).
export default class TrackedBox {
  @tracked value = 0;

  get doubled() {
    return this.value * 2;
  }
}
