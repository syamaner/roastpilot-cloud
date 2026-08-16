# Authorized decision context

- Source: https://github.com/syamaner/roastpilot-cloud/issues/120#issuecomment-5078394741
- Posted by: `syamaner`
- Posted at: `2026-07-25T11:56:57Z`
- Verdict boundary: `2026-07-25T17:57:12Z`
- Capture policy: substantive planning context only; the disposition and any readiness-label recommendation are excluded.

## Ratified direction

The operator approved D117 option 1: a credential-reachability, repository-wide inventory with factory-core enforcement first. The inventory was corrected to 15 jobs after including effective read permissions and implicit runtime credentials, not only explicit secret references or write permissions.

The boundary classifies permissions, implicit and runtime credentials, environments, reusable workflows, containers, YAML aliases and merge keys, and persisted state fail-closed. It requires source-qualified protected glue, fresh-runner credential cuts, bounded contracts for untrusted data, a closed Node execution grammar, and a separately closed workflow-shell and container grammar. Exact reviewed `snowflake/**` content from the default branch is the sole unprotected repository-code source admitted to the main-only, human-approved DEV Environment job. Prompt-controlled use of trusted `gh` capability remains separately held.

## Ordered PR plan

Delivery is thirteen serial thin units, each below the 400-line production cap:

1. 120a — classifier and local-action ban.
2. 120b — source, reachability, and data substrate.
3. 120c — Node execution closure.
4. 120d — workflow-shell and container closure.
5. 120e through 120i — factory-job activation, in recorded dependency order.
6. 120j — Dependency Review.
7. 120k — CI and Codecov.
8. 120l — CodeQL.
9. 120m — DEV Snowflake and final-state closure.

Only 120a was authorized immediately; every later unit depends on the preceding recorded order. Every unit routes through the factory-security lens, mandatory QA, and independent triage.

## Acceptance boundary

The plan must inventory every credential-reachable job and execution surface, enforce the two closed execution grammars, preserve fresh-runner credential cuts, reject unknown source or state, and demonstrate the constraints with adversarial tests. The pre-record review had already checked the Snowflake source class, workflow-shell/container verification, removal of mutable process execution from the OAuth-bearing implementation step, and a clean whitespace check.
