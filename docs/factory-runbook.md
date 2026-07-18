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
**A paused factory silently drops issues opened during the pause window
out of triage — see "Resuming after a pause" below before you assume
flipping the flag back is the whole story.**

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

### 3. Cancel active/queued runs (stops what's ALREADY running)

**Neither of the above touches a run already in flight.** The pause flag
only changes what the *next* triggered job does; workflow-disable only
stops *new* triggers from starting a run at all — a run that's already
queued or in progress keeps going on either. This matters concretely for
`implement-ready-issues.yml`: its `publish` job deliberately runs with
`cancel-in-progress: false` (an in-flight publish must finish, never be
cut off mid-push — see that workflow's own comment) and holds
`contents`/`pull-requests`/`issues` write. An in-flight publish job can
still push a branch, open a PR, and post comments **after** you've both
paused and disabled — a true emergency halt needs this third step too.

**List active/queued runs on both factory workflows:**

```bash
gh run list -R syamaner/roastpilot-cloud --workflow triage-issues.yml \
  --status in_progress --status queued --json databaseId,status,event --jq '.[]'
gh run list -R syamaner/roastpilot-cloud --workflow implement-ready-issues.yml \
  --status in_progress --status queued --json databaseId,status,event --jq '.[]'
```

**Cancel each one found:**

```bash
gh run cancel <run-id> -R syamaner/roastpilot-cloud
```

**If a normal cancel doesn't take** (the run ignores the cancellation
signal — can happen mid-`git push` or mid-API-call, where the runner
process doesn't check for cancellation until its next step boundary):

```bash
gh api -X POST repos/syamaner/roastpilot-cloud/actions/runs/<run-id>/force-cancel
```

### Emergency halt — do all three, in this order

For a live incident (or genuine doubt the pause flag alone is being
respected), don't stop at just the pause flag or just the disable call —
run all three, in this order, so nothing is left able to act while you
investigate:

1. **Pause flag** (§1) — stops the *next* job's logic from doing anything,
   immediately, for any trigger that hasn't started a job yet.
2. **Disable both workflows** (§2) — stops *new* triggers from starting a
   run at all, independent of the flag/YAML being read correctly.
3. **Cancel active/queued runs** (§3) — stops what's *already* running,
   closing the gap the first two steps don't cover.

### Which to use

| Situation | Use |
|---|---|
| Something looks wrong with a specific factory run; want the *next* one to not start while you look | Pause flag |
| A live incident, runaway loop, or genuine doubt the pause flag itself is being respected | **Emergency halt** — all three steps above |
| Routine "we're not touching the factory this week" | Pause flag (cheaper to reverse, doesn't need re-enabling both workflows by ID) |

## Resuming after a pause — don't skip the backfill

**Flipping `FACTORY_PAUSED` back to `false` (or re-enabling the workflows)
is not the whole resume procedure.** `triage-issues.yml` triggers on
`issues: [opened]` — GitHub still fires and CONSUMES that event while the
factory is paused, it just runs the `pause-notice` job instead of
`seed`/`triage`/`apply`. GitHub does **not** replay a past event once you
resume: any issue opened during the pause window never gets the
`needs-triage` seed label, never gets judged, and silently drops out of
the factory's inbox — it just sits there looking like any other
unlabelled issue, with no error, no comment, nothing pointing at what
happened.

**Step 1 — find what was missed.** Two ways, pick whichever is faster for
the actual pause window:

- **From the issue side** — issues opened during the pause with none of
  the six readiness labels (factory.md §4's taxonomy) never got seeded:

  ```bash
  gh issue list -R syamaner/roastpilot-cloud --state open \
    --search "created:<PAUSE_START>..<PAUSE_END>" \
    --json number,title,labels --jq \
    '.[] | select([.labels[].name] | any(. == "needs-triage" or . == "ready-to-implement" or . == "ready-to-spec" or . == "needs-info" or . == "wait-to-implement" or . == "wontfix") | not)'
  ```

- **From the run side** — every `Triage Issues` run that fired during the
  pause window completed successfully (the `pause-notice` job "succeeds"
  by design) but did no real work:

  ```bash
  gh run list -R syamaner/roastpilot-cloud --workflow triage-issues.yml \
    --status completed --json databaseId,createdAt,event --jq \
    '.[] | select(.createdAt > "<PAUSE_START>" and .createdAt < "<PAUSE_END>")'
  ```

**Step 2 — backfill, either way:**

- **Re-run the skipped workflow run** (re-fires the full
  seed → triage → apply chain against the still-current issue state):

  ```bash
  gh run rerun <run-id> -R syamaner/roastpilot-cloud
  ```

- **Or, label manually** if rerunning feels riskier than a direct fix (e.g.
  you'd rather not re-trigger the read-only triage agent on a batch of
  issues right now):

  ```bash
  gh issue edit <issue-number> -R syamaner/roastpilot-cloud --add-label needs-triage
  ```

  A `needs-triage`-labelled issue with no other readiness label will be
  picked up correctly by the next `triage-issues.yml` run for that issue
  (the seed job only seeds when no readiness label is present — adding
  `needs-triage` by hand is exactly the state the seed job would have left
  it in).

Either path is fine; re-running is closer to "as if the pause never
happened," manual labelling is faster for a large backlog. Don't leave a
paused-window issue silently un-triaged either way.

## Cost/budget caps (operator-console, not code — tracked here for completeness)

factory.md §13 point 7 also calls for **aggregate** cost caps (a per-run
token cap alone can't see N runs × cap, or a runaway retry loop):

- [ ] Anthropic Console: a monthly spend hard limit + a lower usage alert.
- [ ] GitHub: an Actions minutes budget/alert on the organization or repo.

These are operator-set console configuration, not something a workflow
file or this repo's code can enforce — no PR closes this checklist. Mark
each item done here once set, with the date, so this stays the single
source of truth for "is the factory's blast radius actually bounded."
