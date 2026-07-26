<!-- One PR per planned review unit. Branch: feature/{issue-number}-{slug}[-{slice}] -->

## Story

Closes #<!-- issue this PR FULLY resolves (auto-closes on merge) -->
<!-- Use "Refs #N" / "Part of #N" instead for partial or related work,
     so an unfinished issue is never auto-closed. -->

## Review-unit plan

<!-- Rough changed logic/test lines. If materially larger than the ~400-line
     guide, explain why the available splits reduce reviewability. State this
     unit's dependency/order within a multi-PR story. Factory-authored PRs
     cannot use the larger-unit exception. -->

## What changed

-

## How it was verified

<!-- Which gates and suites ran; anything manual. Factory PRs: the
     implement run's local gate output is linked from the PR body. -->

## Review routing

<!-- Diffs touching snowflake/migrations, roles/grants, secure views, or
     stored procedures: call it out for schema-migration-reviewer.
     Diffs touching routes/components/procs handling reviewer data, IPs,
     visibility, or deletion: call it out for privacy-auditor.
     Diffs touching .github/**, scripts/factory/**, privileged glue, CODEOWNERS,
     or branch protection: call it out for factory-security-reviewer.
     Test diffs over 600 lines or otherwise load-bearing test quality: call it
     out for qa. -->
