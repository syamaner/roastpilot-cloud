# Factory operational runbook

Operational procedures for the `roastpilot-cloud` software factory
(`factory.md`, D98) — currently the kill-switch (F1-S10 slice 1,
factory.md §13 point 9). Grows as later F1-S10 slices and F1-S6's dry-run
runbook land; this is not meant to be "finished" before it's useful.

## Kill-switch: stopping the factory

Two independent mechanisms, in order of how fast/broad they act. Neither
depends on the implementing agent's own behavior — both are enforced by
GitHub Actions itself, before any agent code runs.

### 1. Pause flag (fast, reversible, factory-only)

**What it does:** every factory job (`triage-issues.yml`'s `seed`,
`triage`, `apply`; `implement-ready-issues.yml`'s `implement`, `publish`)
has `if: vars.FACTORY_PAUSED != 'true'` as its own job-level condition —
evaluated by GitHub Actions before the job starts, so a paused job never
runs a single step, let alone any agent code. This is scoped to the
**factory** workflows only — `CI`, `CodeQL`, `Dependency Review`, and
`Claude Code Review` are unaffected, so ordinary human development and PR
review keep working while the factory is paused.

A `pause-notice` job in both workflows is gated the OPPOSITE way
(`if: vars.FACTORY_PAUSED == 'true'`) purely for visibility: when paused,
it's the one job that runs, and it posts a `::warning::` annotation plus a
`$GITHUB_STEP_SUMMARY` line explaining why nothing else ran. It has no
side effects and doesn't change the actual enforcement — the real jobs'
own `if:` conditions are what stops them, unconditionally, whether or not
this notice job exists.

**To pause:**

```bash
gh variable set FACTORY_PAUSED --body true --repo syamaner/roastpilot-cloud
```

**To resume:**

```bash
gh variable set FACTORY_PAUSED --body false --repo syamaner/roastpilot-cloud
```

**Check current state:**

```bash
gh variable list --repo syamaner/roastpilot-cloud
```

Takes effect on the **next** triggered run (a new issue opened, or the
next `workflow_dispatch`) — it does not cancel a run already in progress.

### 2. Workflow disable (nuclear, one call, halts everything on that workflow)

**What it does:** GitHub's own "disable a workflow" REST endpoint. A
disabled workflow does not run at all — no jobs, no `pause-notice`, no
"skipped" rows, nothing — for ANY trigger, until explicitly re-enabled.
Use this when the pause flag isn't fast enough, or as a second, independent
lever if there's ever doubt the flag itself is being read correctly (it
doesn't depend on the workflow YAML's own `if:` logic at all).

**Halt everything (both factory workflows):**

```bash
gh api -X PUT repos/syamaner/roastpilot-cloud/actions/workflows/315461463/disable   # Triage Issues
gh api -X PUT repos/syamaner/roastpilot-cloud/actions/workflows/315533067/disable   # Implement Ready Issues
```

**Resume:**

```bash
gh api -X PUT repos/syamaner/roastpilot-cloud/actions/workflows/315461463/enable
gh api -X PUT repos/syamaner/roastpilot-cloud/actions/workflows/315533067/enable
```

**Check current state (look for `"state": "active"` vs `"disabled_manually"`):**

```bash
gh api repos/syamaner/roastpilot-cloud/actions/workflows --jq '.workflows[] | {name, id, state}'
```

Workflow IDs are stable for the life of the workflow file (renaming the
file changes the path, not the ID) — re-verify with the command above if
these ever look wrong, don't assume they're permanent across a repo
migration or a workflow file being deleted and recreated.

### Which to use

| Situation | Use |
|---|---|
| Something looks wrong with a specific factory run; want the *next* one to not start while you look | Pause flag |
| A live incident, runaway loop, or genuine doubt the pause flag itself is being respected | Workflow disable (both) |
| Routine "we're not touching the factory this week" | Pause flag (cheaper to reverse, doesn't need re-enabling both workflows by ID) |

## Cost/budget caps (operator-console, not code — tracked here for completeness)

factory.md §13 point 7 also calls for **aggregate** cost caps (a per-run
token cap alone can't see N runs × cap, or a runaway retry loop):

- [ ] Anthropic Console: a monthly spend hard limit + a lower usage alert.
- [ ] GitHub: an Actions minutes budget/alert on the organization or repo.

These are operator-set console configuration, not something a workflow
file or this repo's code can enforce — no PR closes this checklist. Mark
each item done here once set, with the date, so this stays the single
source of truth for "is the factory's blast radius actually bounded."
