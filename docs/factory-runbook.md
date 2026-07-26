# Factory operational runbook

Operational procedures for the `roastpilot-cloud` software factory
(`factory.md`, D98) — currently the kill-switch (F1-S10 slice 1,
factory.md §13 point 9). Grows as later F1-S10 slices and F1-S6's dry-run
runbook land; this is not meant to be "finished" before it's useful.

## Deployment prerequisite: readiness labels

Provision the conventional-delivery readiness label before deploying a
triage schema that can return it. GitHub does not create unknown repository
labels when the apply job replaces an issue's label set. This is an explicit
operator-owned deployment prerequisite rather than a write repeated by every
triage run:

```bash
gh label create ready-for-conventional-implementation \
  --repo syamaner/roastpilot-cloud \
  --color 0E8A16 \
  --description "Triaged for conventional delivery; does not authorize factory dispatch" \
  --force
gh api repos/syamaner/roastpilot-cloud/labels/ready-for-conventional-implementation \
  --jq '{name, color, description}'
```

## Factory dispatch eligibility limits

Factory-dispatchable work must fit one issue, one publisher commit, and one PR;
at most 400 combined changed textual lines across every path category; and a
captured patch artifact no larger than 2 MiB. It may not contain a binary patch
or mix allowlisted output with logic/tests. Allowlisted output still counts
toward the textual ceiling because a repository path does not prove the file is
unreachable from production code. Route any expected line- or byte-limit
overage to conventional execution before dispatch.

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
   nothing runs at all regardless of the flag:

   ```bash
   gh api -X PUT repos/syamaner/roastpilot-cloud/actions/workflows/315461463/enable
   gh api -X PUT repos/syamaner/roastpilot-cloud/actions/workflows/315533067/enable
   ```
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

> **Staged generation rollout:** while the 51b-2b generation producer and
> manual dispatch slices are deployed without the 51b-3 exact-generation
> consumer, leave the factory paused. The prerequisite publisher fence
> deliberately rejects every generation during that interval. Resume and
> backfill only after the exact-generation consumer is deployed.

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

**Step 2 — dispatch and watch the current `main` workflow once per issue.**
This fetches the issue's current title/body plus bounded,
provenance-filtered clarifications and re-runs the full
`seed` → `triage` → `apply` chain. Keep `--ref main` explicit: the
workflow intentionally runs no job for a dispatch from another ref. Run
issues serially so each result is attributable and a broken backfill does
not fan out:

```bash
ISSUE_NUMBER=<ISSUE_NUMBER>
DISPATCH_STARTED=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run triage-issues.yml \
  --repo syamaner/roastpilot-cloud \
  --ref main \
  -f issue_number="$ISSUE_NUMBER"

run_id=""
for _ in {1..12}; do
  run_id=$(gh run list --repo syamaner/roastpilot-cloud \
    --workflow triage-issues.yml --event workflow_dispatch --branch main \
    --limit 100 --json databaseId,displayTitle,createdAt \
    --jq "map(select(.displayTitle == \"Triage issue #$ISSUE_NUMBER\" and .createdAt >= \"$DISPATCH_STARTED\")) | sort_by(.createdAt) | last | .databaseId // empty")
  [ -n "$run_id" ] && break
  sleep 5
done
test -n "$run_id"
gh run watch "$run_id" --repo syamaner/roastpilot-cloud --exit-status
```

Do this for every open issue from Step 1. Closed issues are deliberately
excluded and the workflow rejects them again before any write. Do not
substitute a `reopened` or manual readiness-label change: neither is the
backfill contract, and a label write intentionally does not trigger triage.

**Step 3 — verify the issue state before counting that issue as
backfilled.** A green workflow run is necessary but not the state contract.
Require exactly one readiness label and exactly one bot-owned terminal
triage comment with this run's dotted `<run_id>.<run_attempt>` generation;
a `hold:` generation or duplicate bot comments is a failed backfill:

```bash
issue=$(gh api "repos/syamaner/roastpilot-cloud/issues/$ISSUE_NUMBER")
comments=$(gh api --paginate \
  "repos/syamaner/roastpilot-cloud/issues/$ISSUE_NUMBER/comments?per_page=100" \
  --slurp)
jq -e '
  [.labels[].name
   | select(IN(
       "needs-triage", "ready-to-spec", "needs-info",
       "ready-to-implement", "ready-for-conventional-implementation",
       "wait-to-implement", "wontfix"
     ))]
  | length == 1
' <<< "$issue"
jq -e --arg generation "$run_id.1" '
  [
    .[][]
    | select(
        .user.type == "Bot"
        and .user.login == "github-actions[bot]"
        and (
          .body == "<!-- roastpilot-factory:triage-verdict:do-not-edit -->"
          or (
            .body
            | endswith(
                "\n<!-- roastpilot-factory:triage-verdict:do-not-edit -->"
              )
          )
        )
      )
  ] as $owned
  | ($owned | length) == 1
    and (
      $owned[0].body
      | endswith(
          "<!-- roastpilot-factory:triage-generation:"
          + $generation
          + ":do-not-edit -->\n"
          + "<!-- roastpilot-factory:triage-verdict:do-not-edit -->"
        )
    )
' <<< "$comments"
```

If the run or either assertion fails, investigate it and start a fresh
`workflow_dispatch` from Step 2 after the fault is corrected. Do not rerun
the old backfill run: a partial rerun can preserve the seed's original
generation while increasing the workflow attempt, and it no longer proves
that the repaired workflow came from current `main`. Every accepted
backfill therefore has a fresh run ID and the `.1` generation shown above.
Do not dispatch the next issue until the current one passes both assertions.

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
