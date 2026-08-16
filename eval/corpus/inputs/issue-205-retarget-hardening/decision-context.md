# Authorized decision context

- Source: https://github.com/syamaner/roastpilot-cloud/issues/205#issuecomment-5184997584
- Posted by: `syamaner`
- Posted at: `2026-08-04T21:47:26Z`
- Verdict boundary: `2026-08-04T21:47:28Z`
- Capture policy: substantive planning context only; the disposition and any readiness-label recommendation are excluded.

## Chosen design

Use one credential-free `resolve-trusted-revision` workflow job, with `permissions: {}`, to resolve and publish a trusted SHA without checking out or executing repository content. A composite action is rejected because it would be repository-local code in credential-bearing jobs and cannot safely run before checkout. A `scripts/factory` helper is rejected because the privileged checkout site needs the answer before any script can exist in the workspace.

The resolver compares `base.ref` byte-for-byte with the default branch. For the default branch it accepts the event base SHA; otherwise it resolves the exact default-branch tip with anonymous `git ls-remote`. Branch inputs may not become git arguments. The output grammar is exactly one lowercase 40-hex SHA plus a closed source tag, and every missing, malformed, duplicate, or unreachable state exits non-zero without an output.

All three consumers use the same job output. The two read-only review jobs revalidate the SHA before fetching and restoring configuration. The write-capable publishing job must depend on resolver success, assert the output before checkout, and set checkout `ref` to that output so resolver failure cannot fall back to a pull-request merge ref. Existing removal, restore, selective re-overlay, token permissions, and credential-persistence constraints remain unchanged.

## Ordered PR plan

One conventional PR contains four ordered commits so the shared security boundary and its tests land together:

1. Add the resolver; harden the write-capable publish job's dependencies, success gate, assertion step, and checkout ref (about 85 logic lines).
2. Move the spec-grounded read-only consumer to the shared output while preserving its final selective re-overlay (about 25 logic lines; depends on commit 1).
3. Move the other read-only consumer to the shared output and delete its inline resolver (about 35 logic lines; depends on commit 1).
4. Add executable resolver, consumer, workflow-structure, and mutation tests (test lines excluded from the logic estimate; depends on commits 1–3).

The total logic estimate is about 150–190 lines. Splitting into separate PRs would leave two implementations of the trusted-revision rule on the default branch. A fallback split is permitted only if adversarial review forces a resolver redesign, logic exceeds about 300 lines, or the test diff exceeds 600 lines.

## Verification and routing

Tests cover default-branch and retargeted paths; near-miss refs; absent, malformed, duplicate, and unreachable remote results; shell/ref injection; exact output grammar; each consumer's rejection of empty or malformed SHAs; write-job dependency and step ordering; and preservation of the selective re-overlay. Each named guard has a mutation witness.

The protected workflow and factory-test surface requires conventional execution. The write-capable publisher gets its own factory-security round; the resolver and read-only consumers get a distinct round. QA verifies the guard-shaped tests, and the normal lint, typecheck, coverage, and pre-open review gates apply. Schema and privacy routing are not triggered.
