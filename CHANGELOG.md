# Changelog

## Release (2026-08-12)

* testem-code-coverage 0.3.1 (patch)

#### :bug: Bug Fix
* `testem-code-coverage`
  * [#37](https://github.com/NullVoxPopuli/testem-code-coverage/pull/37) Back the coverage accumulator off on large apps ([@NullVoxPopuli](https://github.com/NullVoxPopuli))
  * [#35](https://github.com/NullVoxPopuli/testem-code-coverage/pull/35) Drop coverage entries whose source-mapped path does not exist ([@NullVoxPopuli](https://github.com/NullVoxPopuli))

#### Committers: 1
- [@NullVoxPopuli](https://github.com/NullVoxPopuli)

## Release (2026-08-11)

* testem-code-coverage 0.3.0 (minor)

#### :rocket: Enhancement
* `testem-code-coverage`
  * [#32](https://github.com/NullVoxPopuli/testem-code-coverage/pull/32) Collect coverage from every browser, not just one ([@NullVoxPopuli](https://github.com/NullVoxPopuli))

#### Committers: 1
- [@NullVoxPopuli](https://github.com/NullVoxPopuli)

## Release (2026-08-07)

* testem-code-coverage 0.2.3 (patch)

#### :bug: Bug Fix
* `testem-code-coverage`
  * [#30](https://github.com/NullVoxPopuli/testem-code-coverage/pull/30) Drop compiled-artifact functions from the functions metric ([@NullVoxPopuli-ai-agent](https://github.com/NullVoxPopuli-ai-agent))

#### Committers: 1
- @NullVoxPopuli's reduced-access machine account for AI usage ([@NullVoxPopuli-ai-agent](https://github.com/NullVoxPopuli-ai-agent))

## Release (2026-08-07)

* testem-code-coverage 0.2.2 (patch)

#### :bug: Bug Fix
* `testem-code-coverage`
  * [#27](https://github.com/NullVoxPopuli/testem-code-coverage/pull/27) Report bundler-eliminated (tree-shaken) functions as uncovered ([@NullVoxPopuli-ai-agent](https://github.com/NullVoxPopuli-ai-agent))

#### :house: Internal
* `testem-code-coverage`
  * [#24](https://github.com/NullVoxPopuli/testem-code-coverage/pull/24) Upload coverage reports as CI artifacts and link them from a PR comment ([@NullVoxPopuli-ai-agent](https://github.com/NullVoxPopuli-ai-agent))

#### Committers: 1
- @NullVoxPopuli's reduced-access machine account for AI usage ([@NullVoxPopuli-ai-agent](https://github.com/NullVoxPopuli-ai-agent))

## Release (2026-08-07)

* testem-code-coverage 0.2.1 (patch)

#### :bug: Bug Fix
* `testem-code-coverage`
  * [#23](https://github.com/NullVoxPopuli/testem-code-coverage/pull/23) Merge coverage deltas across takePreciseCoverage calls ([@NullVoxPopuli-ai-agent](https://github.com/NullVoxPopuli-ai-agent))

#### :memo: Documentation
* `testem-code-coverage`
  * [#20](https://github.com/NullVoxPopuli/testem-code-coverage/pull/20) Update README to mention requirements for running testem directly ([@jagthedrummer](https://github.com/jagthedrummer))

#### Committers: 2
- @NullVoxPopuli's reduced-access machine account for AI usage ([@NullVoxPopuli-ai-agent](https://github.com/NullVoxPopuli-ai-agent))
- Jeremy Green ([@jagthedrummer](https://github.com/jagthedrummer))

## Release (2026-03-20)

* testem-code-coverage 0.2.0 (minor)

#### :rocket: Enhancement
* `testem-code-coverage`
  * [#18](https://github.com/NullVoxPopuli/testem-code-coverage/pull/18) Add reporters config and more documentation ([@LucasHillDex](https://github.com/LucasHillDex))

#### :house: Internal
* `testem-code-coverage`
  * [#16](https://github.com/NullVoxPopuli/testem-code-coverage/pull/16) Ignore changelog in oxfmt ([@NullVoxPopuli](https://github.com/NullVoxPopuli))

#### Committers: 2
- Lucas Hill ([@LucasHillDex](https://github.com/LucasHillDex))
- [@NullVoxPopuli](https://github.com/NullVoxPopuli)

## Release (2026-03-16)

* testem-code-coverage 0.1.0 (minor)

#### :rocket: Enhancement
* `testem-code-coverage`
  * [#1](https://github.com/NullVoxPopuli/testem-code-coverage/pull/1) Implementation ([@NullVoxPopuli](https://github.com/NullVoxPopuli))
  * [#6](https://github.com/NullVoxPopuli/testem-code-coverage/pull/6) Implement `include` option to track coverage of project-resolvable library packages ([@Copilot](https://github.com/apps/copilot-swe-agent))

#### :bug: Bug Fix
* `testem-code-coverage`
  * [#8](https://github.com/NullVoxPopuli/testem-code-coverage/pull/8) Fix intermittent `functions.covered=0` for v2-addon-js counter; fix workspace `include` resolution ([@Copilot](https://github.com/apps/copilot-swe-agent))
  * [#7](https://github.com/NullVoxPopuli/testem-code-coverage/pull/7) Fix flaky scenario tests: sequential execution + correct coverage assertion ([@Copilot](https://github.com/apps/copilot-swe-agent))

#### :house: Internal
* `testem-code-coverage`
  * [#15](https://github.com/NullVoxPopuli/testem-code-coverage/pull/15) fix ci ([@NullVoxPopuli](https://github.com/NullVoxPopuli))
  * [#14](https://github.com/NullVoxPopuli/testem-code-coverage/pull/14) Set package as private in package.json ([@NullVoxPopuli](https://github.com/NullVoxPopuli))
  * [#12](https://github.com/NullVoxPopuli/testem-code-coverage/pull/12) Add release plan ([@NullVoxPopuli](https://github.com/NullVoxPopuli))
  * [#11](https://github.com/NullVoxPopuli/testem-code-coverage/pull/11) Cleanup ([@NullVoxPopuli](https://github.com/NullVoxPopuli))
  * [#10](https://github.com/NullVoxPopuli/testem-code-coverage/pull/10) Claude simplify ([@NullVoxPopuli](https://github.com/NullVoxPopuli))
  * [#9](https://github.com/NullVoxPopuli/testem-code-coverage/pull/9) Fix flaky function-coverage assertions that depend on V8 JIT nondeterminism ([@Copilot](https://github.com/apps/copilot-swe-agent))
  * [#5](https://github.com/NullVoxPopuli/testem-code-coverage/pull/5) Remove stale standalone CLI usage from report.js header comment ([@Copilot](https://github.com/apps/copilot-swe-agent))
  * [#4](https://github.com/NullVoxPopuli/testem-code-coverage/pull/4) test: move scenario setup into beforeAll to eliminate inter-test dependencies ([@Copilot](https://github.com/apps/copilot-swe-agent))

#### Committers: 2
- Copilot [Bot] ([@copilot-swe-agent](https://github.com/apps/copilot-swe-agent))
- [@NullVoxPopuli](https://github.com/NullVoxPopuli)
