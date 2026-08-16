# Authorized decision context

- Source: https://github.com/syamaner/roastpilot-cloud/issues/284#issuecomment-5303798740
- Posted by: `syamaner`
- Posted at: `2026-08-15T19:10:52Z`
- Verdict boundary: `2026-08-15T19:11:00Z`
- Capture policy: substantive planning context only; the disposition and any readiness-label recommendation are excluded.

## Chosen change

Set both `testTimeout` and `hookTimeout` to exactly `20_000` in `vitest.config.ts`. The implement gate runs Vitest without a command-line timeout override, so the shared config controls it. Remove the five per-test `15_000` overrides: after the global increase they would become lower caps on the five most starvation-prone tests rather than helpful extensions. Teardown, Playwright, and subprocess budgets are separate classes and remain unchanged.

The timeout remains fail-closed: an actual hang still fails, only after the bounded 20-second budget. No new execution class, credential, data surface, or capability is introduced.

## PR plan and dependencies

One conventional PR, with no dependencies, changes the two config values, removes the five obsolete overrides, and adds `tests/factory/vitest-timeout-contract.test.ts`. The factory taxonomy counts the config and test files as test-class, so the estimated logic size is zero and the total test diff is about 45–55 lines, below the 600-line QA size trigger.

## Acceptance and routing

The contract test imports the live Vitest config, asserts the `test` block exists, and byte-pins both timeout values to `20_000`. Deleting either setting or changing either value must fail its corresponding test. A sleep-based timing test is excluded because it would be slow and sensitive to the same runner starvation being addressed. The final sweep verifies no command-line timeout shadows the config and no obsolete fixed timeout remains in the test suite.

The added factory contract test and implement-gate semantics require conventional execution and mandatory factory-security review. Standard lint, typecheck, coverage, pre-open review, post-open roster, and human merge apply. Schema, migration, and privacy routing are not triggered.
