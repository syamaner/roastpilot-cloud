# Factory operational runbook

Operational procedures for the `roastpilot-cloud` software factory
(`factory.md`, D98) — currently the kill-switch (F1-S10 slice 1,
factory.md §13 point 9). Grows as later F1-S10 slices and F1-S6's dry-run
runbook land; this is not meant to be "finished" before it's useful.

## Kill-switch: stopping the factory

Three independent mechanisms, numbered in the order you'd actually use them
for a full emergency halt (see that section below) — each covers a
different gap the others leave open. None depends on the implementing
agent's own behavior — all three are enforced by GitHub Actions itself,
before any agent code runs.

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

### 2. Cancel active/queued runs (stops what's ALREADY running)

**Neither the pause flag nor workflow-disable (below) touches a run
already in flight.** The pause flag only changes what the *next*
triggered job does; workflow-disable only stops *new* triggers from
starting a run at all — a run that's already queued or in progress keeps
going on either. This matters concretely for `implement-ready-issues.yml`:
its `publish` job deliberately runs with `cancel-in-progress: false` (an
in-flight publish must finish, never be cut off mid-push — see that
workflow's own comment) and holds `contents`/`pull-requests`/`issues`
write. An in-flight publish job can still push a branch, open a PR, and
post comments after you've paused — a true emergency halt needs this
cancellation step too.

**Do this BEFORE disabling the workflows (§3)** — `gh run list --workflow
<name>` cannot see a disabled workflow's runs at all without an extra
`-a/--all` flag (verified against `gh run list --help`), so cancelling
first, while the workflow is still enabled and its runs are trivially
listable, avoids that entirely.

**List active/queued runs on both factory workflows.** `--status` only
keeps the LAST value passed if you repeat the flag (a known `gh` CLI
limitation, cli/cli#7949) — `--status in_progress --status queued` would
silently only match `queued`. Filter both statuses in one call via
`--json`/`--jq` instead (verified: `gh run list --help` lists `status`
and `databaseId` as valid `--json` fields):

```bash
gh run list -R syamaner/roastpilot-cloud --workflow triage-issues.yml \
  --json databaseId,status --jq '.[] | select(.status == "in_progress" or .status == "queued") | .databaseId'
gh run list -R syamaner/roastpilot-cloud --workflow implement-ready-issues.yml \
  --json databaseId,status --jq '.[] | select(.status == "in_progress" or .status == "queued") | .databaseId'
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

### 3. Workflow disable (nuclear, one call, halts everything on that workflow)

**What it does:** GitHub's own "disable a workflow" REST endpoint. A
disabled workflow does not run at all — no jobs, no `pause-notice`, no
"skipped" rows, nothing — for ANY trigger, until explicitly re-enabled.
Use this when the pause flag isn't fast enough, or as a second, independent
lever if there's ever doubt the flag itself is being read correctly (it
doesn't depend on the workflow YAML's own `if:` logic at all). **Do this
AFTER cancelling active/queued runs (§2)** — see that section for why
disabling first would make the runs you need to cancel invisible to a
plain `gh run list --workflow` call.

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

### Emergency halt — do all three, IN THIS ORDER

For a live incident (or genuine doubt the pause flag alone is being
respected), don't stop at just the pause flag or just the disable call —
run all three, in this specific order, so nothing is left able to act
while you investigate AND every step can actually see what it needs to:

1. **Pause flag** (§1) — stops the *next* job's logic from doing anything,
   immediately, for any trigger that hasn't started a job yet.
2. **Cancel active/queued runs** (§2) — stops what's *already* running.
   **Deliberately done BEFORE disabling**: `gh run list --workflow <name>`
   only shows a DISABLED workflow's runs with an extra `-a/--all` flag —
   doing this step first, while both workflows are still enabled, means
   the plain (undecorated) list commands above just work, with one fewer
   thing to get right during an incident.
3. **Disable both workflows** (§3) — stops *new* triggers from starting a
   run at all, independent of the flag/YAML being read correctly. Safe to
   do last since step 2 already dealt with anything that was in flight.

### Which to use

| Situation | Use |
|---|---|
| Something looks wrong with a specific factory run; want the *next* one to not start while you look | Pause flag |
| A live incident, runaway loop, or genuine doubt the pause flag itself is being respected | **Emergency halt** — all three steps above, in order |
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

**The only reliable backfill method is re-running the triage runs that
fired (and did nothing) during the pause window** — not a manual label.
`triage-issues.yml` triggers ONLY on `issues: [opened]` (no `labeled`
trigger, no `workflow_dispatch`) — hand-adding the `needs-triage` label to
an affected issue does not, and cannot, re-fire triage; the label just
sits there with nothing left to react to it. Discovery should stay on the
RUN side too, for the same reason: `.github/ISSUE_TEMPLATE/story.yml`
applies `needs-triage` at creation time (part of the template itself), so
a "find issues missing a readiness label" filter would incorrectly
*exclude* exactly the template-filed issues you need to backfill — the
run side has no such trap, since every `Triage Issues` run inside the
exact pause window is, by definition, one that hit `pause-notice` instead
of the real chain.

**Step 1 — find every triage run that fired during the pause window**
(replace `<PAUSE_START>`/`<PAUSE_END>` with the actual timestamps you
paused/resumed at — `--created` accepts a GitHub search-style date range,
verified against `gh run list --help`):

```bash
gh run list -R syamaner/roastpilot-cloud --workflow triage-issues.yml \
  --created "<PAUSE_START>..<PAUSE_END>" --json databaseId,createdAt,event
```

**Step 2 — rerun each one found.** `gh run rerun` with no flags reruns
the ENTIRE run (verified against `gh run rerun --help`: `--failed` is a
separate, opt-in flag for "only failed jobs" — the default reruns every
job), and every job's `if:` condition is re-evaluated fresh against the
CURRENT `vars.FACTORY_PAUSED` value at rerun time, not the value frozen
when the run was first triggered. Since you've already flipped the flag
back to `false` before backfilling, this correctly re-fires the real
`seed` → `triage` → `apply` chain against the issue's still-current
state:

```bash
gh run rerun <run-id> -R syamaner/roastpilot-cloud
```

Do this for every run Step 1 found — there's no shortcut for a large
backlog beyond scripting the loop yourself; don't leave a paused-window
issue silently un-triaged.

## Cost/budget caps (operator-console, not code — tracked here for completeness)

factory.md §13 point 7 also calls for **aggregate** cost caps (a per-run
token cap alone can't see N runs × cap, or a runaway retry loop):

- [ ] Anthropic Console: a monthly spend hard limit + a lower usage alert.
- [ ] GitHub: an Actions minutes budget/alert on the organization or repo.

These are operator-set console configuration, not something a workflow
file or this repo's code can enforce — no PR closes this checklist. Mark
each item done here once set, with the date, so this stays the single
source of truth for "is the factory's blast radius actually bounded."
