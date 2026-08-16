# Authorized decision context

- Source: https://github.com/syamaner/roastpilot-cloud/issues/192
- Posted by: `syamaner`
- Posted at: `2026-08-01T10:42:38Z`
- Verdict boundary: `2026-08-01T14:17:16Z`
- Capture policy: the pre-existing D104 plan and escalation boundary are retained; disposition and readiness-label text are excluded.

## Prior authorized security boundary

The D104 contract for #192 established that the review job’s effective tool grant was broader than its workflow declaration and that Bash ran without the repository’s subprocess environment scrub. Its first mandatory unit was an evidence probe. The highest-priority probe asked whether the allowed PR-comment command admitted an arbitrary `--body-file`; a positive result was defined as a live provider-credential exfiltration primitive that must be separated and handled ahead of lower-impact work.

The contract required conventional execution because every remediation touches protected workflow configuration. It also required the factory-security lens on every unit, full local gates, exact-head independent review, and separate treatment from the held factory-bot admission decision.

## Exploit-specific unit derived from that boundary

Issue #194 supplied the positive source-grounded result and bounded the immediate fix: restrict fetched issue comments, review bodies, and inline review comments to the pull-request author by setting the action’s actor filter. This closes the post-trigger third-party comment channel without changing the tool grant being investigated elsewhere.

One focused PR must:

1. Add the pull-request-author actor filter to the review action invocation.
2. Add a workflow contract assertion for that exact binding.
3. Preserve the existing PR title/body threat model and explicitly avoid claiming closure of author-controlled text, broader tool grants, missing environment scrub, or collaborator-equivalent actors.

The change is a protected-workflow security unit with a small paired enforcement test. It has no schema, migration, application-data, or Snowflake surface.

## Verification and routing

Verification checks the actor filter across all three fetched comment channels and confirms the author identity is event-derived rather than hard-coded. The mandatory route is conventional implementation, factory-security review, local gates, exact-head independent review, and human merge.
