# Factory operational runbook

Operational procedures for the `roastpilot-cloud` software factory
(`factory.md`, D98) — currently the kill-switch (F1-S10 slice 1,
factory.md §13 point 9). Grows as later F1-S10 slices and F1-S6's dry-run
runbook land; this is not meant to be "finished" before it's useful.

## Kill-switch: stopping the factory

**The pause flag is the primary halt mechanism for anything not yet
started, but it is not reliably race-free against a run that is already
queued or in progress at the moment you set it.** Every factory job
(`triage-issues.yml`'s `seed`, `triage`, `apply`;
`implement-ready-issues.yml`'s `implement`, `publish`) has
`if: vars.FACTORY_PAUSED != 'true'` as its own job-level condition. This
reliably neutralizes any run *created after* you set the flag — that
job's `if:` check reads the new value and no-ops, with no exceptions.
**It does not reliably neutralize a run that was already queued or
in-progress at flag-set time**: GitHub Actions is understood to snapshot
repo variables at run-queue time, so such a run's `if:` check may still
see the OLD value and proceed regardless of what you just set the flag
to (the exact snapshot-timing behavior needs live verification — tracked
in #52 — but treat it as unreliable until proven otherwise, since
assuming otherwise is the unsafe direction). **Because of this, cancelling
(§2) is a REQUIRED step, not optional, whenever any factory run already
exists — queued or in-progress — at the moment you set the flag.** Only
skip §2 if you're certain no factory run was live when you paused.

This is scoped to the **factory** workflows only — `CI`, `CodeQL`,
`Dependency Review`, and `Claude Code Review` are unaffected, so ordinary
human development and PR review keep working while the factory is
paused.

A `pause-notice` job in both workflows is gated the OPPOSITE way
(`if: vars.FACTORY_PAUSED == 'true'`) purely for visibility: when paused,
it's the one job that runs, and it posts a `::warning::` annotation plus a
`$GITHUB_STEP_SUMMARY` line explaining why nothing else ran. It has no
side effects and doesn't change the actual enforcement — the real jobs'
own `if:` conditions are what stops them, unconditionally, whether or not
this notice job exists.

### 1. Set the pause flag (do this first, always)

```bash
gh variable set FACTORY_PAUSED --body true --repo syamaner/roastpilot-cloud
```

**Check current state:**

```bash
gh variable list --repo syamaner/roastpilot-cloud
```

Reliably covers any run whose job-level `if:` is evaluated *after* this
point — new issues opened, new `workflow_dispatch` calls. **Do not assume
it also stops a run that was already queued or in-progress when you ran
this command — check for and cancel those explicitly (§2, required, not
optional).** **A paused factory silently drops issues opened during the
pause window out of triage — see "Resuming after a pause" below before
you assume flipping the flag back is the whole story.**

### 2. Cancel any run already queued or in-progress (REQUIRED whenever one exists)

**Treat this as a required step, not an optional follow-up**, whenever
any factory run is queued or in-progress at the moment you set the flag
— per the caveat above, the flag alone may not stop it. This is
especially true for `implement-ready-issues.yml`'s `publish` job, which
deliberately runs with `cancel-in-progress: false` (an in-flight publish
must finish, never be cut off mid-push — see that workflow's own
comment) and holds `contents`/`pull-requests`/`issues` write: if one was
already pushing a branch, opening a PR, or posting a comment, it can keep
doing so even after you've paused. Check for this and cancel it
explicitly; never assume the flag alone caught everything.

Because you have not disabled the workflows at this point, their runs
are trivially listable with a plain `gh run list --workflow <name>` —
no `-a/--all` flag needed (that flag only matters once a workflow is
*disabled*, see §3).

**List active/queued/pending runs on both factory workflows.** `--status`
only keeps the LAST value passed if you repeat the flag (a known `gh` CLI
limitation, cli/cli#7949) — `--status in_progress --status queued` would
silently only match `queued`. Filter all three statuses — including
`pending`, the state a run sits in while queued behind another run's
concurrency group (e.g. behind that non-cancellable `publish` job) — in
one call via `--json`/`--jq` instead (verified: `gh run list --help`
lists `status` and `databaseId` as valid `--json` fields, and lists
`pending` as a status value distinct from `queued`/`in_progress`).
`--limit`/`-L` defaults to 20 (verified against `gh run list --help`,
which offers no separate pagination flag — `--limit` is the only lever),
which would silently truncate a runaway with more in-flight runs than
that — pass a higher explicit limit; for an exceptionally large incident
where even that isn't enough, raise it further rather than trust the
default:

```bash
gh run list -R syamaner/roastpilot-cloud --workflow triage-issues.yml --limit 200 \
  --json databaseId,status --jq '.[] | select(.status == "in_progress" or .status == "queued" or .status == "pending") | .databaseId'
gh run list -R syamaner/roastpilot-cloud --workflow implement-ready-issues.yml --limit 200 \
  --json databaseId,status --jq '.[] | select(.status == "in_progress" or .status == "queued" or .status == "pending") | .databaseId'
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

### 3. Disable the workflows (optional — extra insurance, not required)

**What it does:** GitHub's own "disable a workflow" REST endpoint. A
disabled workflow does not run at all — no jobs, no `pause-notice`, no
"skipped" rows, nothing — for ANY trigger, until explicitly re-enabled.

**This step is optional for NEW runs** — the pause flag (§1) already
reliably stops any run created from here on, so a disabled workflow's
jobs would have no-op'd via the flag anyway. It does **not** substitute
for cancelling (§2) — disabling stops future triggers, not something
already queued or in-progress. Reach for it if you want a second,
independent lever that doesn't depend on the flag/YAML being read
correctly at all, or to stop *new* runs from starting so they stop
adding `pause-notice` noise during a busy incident. **If you do disable,
do it after cancelling (§2)** — or pass `-a/--all` to `gh run list` if
you need to look at a workflow's runs after it's already disabled (a
disabled workflow's runs are otherwise invisible to a plain
`--workflow <name>` list, verified against `gh run list --help`).

```bash
gh api -X PUT repos/syamaner/roastpilot-cloud/actions/workflows/315461463/disable   # Triage Issues
gh api -X PUT repos/syamaner/roastpilot-cloud/actions/workflows/315533067/disable   # Implement Ready Issues
```

**Check current state (look for `"state": "active"` vs `"disabled_manually"`):**

```bash
gh api repos/syamaner/roastpilot-cloud/actions/workflows --jq '.workflows[] | {name, id, state}'
```

Workflow IDs are stable for the life of the workflow file (renaming the
file changes the path, not the ID) — re-verify with the command above if
these ever look wrong, don't assume they're permanent across a repo
migration or a workflow file being deleted and recreated.

### Emergency halt — full procedure

1. **Set the pause flag** (§1) first, always — instant, and reliably
   stops the inflow of any run created from this point on.
2. **Check for and cancel any run already queued or in-progress** (§2) —
   **required**, not optional, whenever any factory run exists at the
   moment you set the flag: the flag alone is not proven to stop a run
   that started before it was set (see §1's caveat; #52 tracks getting a
   definitive answer on GitHub's exact vars-snapshot timing). Skip this
   only if you're certain nothing was live.
3. **Disable the workflows** (§3), optionally — for extra insurance or to
   stop new-run noise; not required for the halt to be effective once
   steps 1 and 2 are both done.

### Which to use

| Situation | Use |
|---|---|
| Nothing is currently running; want the *next* trigger to not start while you look | Pause flag (§1) alone |
| A live incident, runaway loop, or ANY factory run already queued/in-progress | Pause flag (§1) **+ required cancel** (§2) of anything already live |
| Extra insurance, or you want new triggers to stop adding noise | Add disable (§3) on top |
| Routine "we're not touching the factory this week" with nothing in flight | Pause flag (§1) alone (cheaper to reverse than re-enabling workflows by ID) |

## Resuming after a pause — clear the flag, then don't skip the backfill

**Resuming has three steps, and skipping any one of them leaves the
factory in a wrong state:**

1. **Re-enable the workflows, if you disabled them** (§3) — otherwise
   nothing runs at all regardless of the flag.
2. **Set `FACTORY_PAUSED` back to `false`.** This is the step that
   actually restarts the factory — re-enabling the workflows alone does
   **not** resume anything, because every job's `if:` condition still
   gates on the flag regardless of whether the workflow itself is
   enabled or disabled:

   ```bash
   gh variable set FACTORY_PAUSED --body false --repo syamaner/roastpilot-cloud
   ```

3. **Backfill issues opened during the outage** (below) — the flag and
   workflow state going back to normal does not retroactively process
   anything that was dropped while paused/disabled.

**Why backfill is needed at all:** GitHub consumes `issues: [opened]`
events while the factory is paused and creates no run while the workflow
is disabled. It does not replay either missed event after resumption.
`triage-issues.yml` therefore exposes a manual `workflow_dispatch` with a
required `issue_number`; this re-runs the current workflow from `main`
without changing issue lifecycle state or relying on label events.

**Step 1 — find every issue opened during the pause/disabled window.**
Replace `<PAUSE_START>`/`<PAUSE_END>` with the exact UTC timestamps.
Search by creation time, not readiness labels: the story template itself
adds `needs-triage`, so a missing-label filter would exclude affected
template-filed issues. `--limit` defaults to 30; raise it above the
maximum possible issues in the window:

```bash
gh issue list --repo syamaner/roastpilot-cloud --state open --limit 200 \
  --search "created:<PAUSE_START>..<PAUSE_END>" \
  --json number,title,createdAt,state
```

**Step 2 — dispatch the current `main` workflow once per issue.** This
fetches the issue's current title/body plus bounded, provenance-filtered
clarifications and re-runs the full
`seed` → `triage` → `apply` chain. Keep `--ref main` explicit: the
workflow intentionally runs no job for a dispatch from another ref.

```bash
gh workflow run triage-issues.yml \
  --repo syamaner/roastpilot-cloud \
  --ref main \
  -f issue_number=<ISSUE_NUMBER>
```

Do this for every open issue from Step 1. Closed issues are deliberately
excluded and the workflow rejects them again before any write. Do not
substitute a `reopened` or manual readiness-label change: neither is the
backfill contract, and a label write intentionally does not trigger triage.

## Cost/budget caps — N/A by billing model (D102)

factory.md §13 point 7 called for **aggregate** cost caps (a per-run token
cap alone can't see N runs × cap, or a runaway retry loop) — **reconciled
by D102 (18 Jul 2026): there is no metered spend to cap, so this checklist
is closed by the billing model, not by console configuration.**

- Anthropic: the factory runs on the flat-fee Claude Code subscription
  token, not the pay-per-token API — there is no dollar spend limit to
  set. Runaway protection is the factory's own controls instead: the
  per-run `max_turns` cap plus the kill-switch (F1-S10, this doc's own
  first section).
- GitHub Actions: free/unlimited on this **public** repo with **no
  payment method on file**, so it cannot incur charges — fail-safe by
  construction, nothing to budget or alert on.

**REVISIT if any of these change** — repo goes private (Actions minutes
become metered), a payment method is ever added, or the factory switches
to metered Anthropic API billing. At that point, set a real Anthropic
monthly spend limit + usage alert and a GitHub Actions minutes budget,
and reopen this checklist.
