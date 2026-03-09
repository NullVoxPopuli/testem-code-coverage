# ember-code-coverage

## Installation & Setup

```bash
npm add ember-code-coverage
# or from github
npm add "github:NullVoxPopuli/ember-code-coverage#main"
```

Setup the testem middleware

```js
// testem.cjs
module.exports = {
    // ...
    middleware: [require('ember-code-coverage/testem')]
    // ...
}
```

Setup qunit

```js
// tests/test-helper.js
import { setup } from 'qunit-dom';
import { setupCoverage } from 'ember-code-coverage/qunit';

export async function start() {
  setApplication(Application.create(config.APP));

  setup(QUnit.assert);
  setupEmberOnerrorValidation();
  setupCoverage(QUnit);
  qunitStart();
}
```

## Configuration
