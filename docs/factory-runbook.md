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

## Interpreting local factory test output

The factory integration tests intentionally exercise rejected and failing
subprocess paths. A successful `npm run test -- --coverage` may therefore print
temporary-repository warnings such as `You appear to have cloned an empty
repository`, deliberate `jq` errors, or `No valid patches in input`. Treat that
stderr as expected only when the enclosing Vitest assertion and the final test
command both pass. Do not suppress it globally or infer success from a familiar
warning: a non-zero command exit still fails the gate.

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
`Dependency Review`, `Claude Code Review`, and
`dev-snowflake-contract.yml` are unaffected. Ordinary human development
and PR review keep working while the factory is paused; the credentialed
Snowflake workflow has its own handling below.

A `pause-notice` job in both workflows is gated the OPPOSITE way
(`if: vars.FACTORY_PAUSED == 'true'`) purely for visibility: when paused,
it's the one job that runs, and it posts a `::warning::` annotation plus a
`$GITHUB_STEP_SUMMARY` line explaining why nothing else ran. It has no
side effects and doesn't change the actual enforcement — the real jobs'
own `if:` conditions are what stops them, unconditionally, whether or not
this notice job exists.

### 1. Set the pause flag (do this first, always)

```bash
PAUSE_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'PAUSE_START=%s\n' "$PAUSE_START"
gh variable set FACTORY_PAUSED --body true --repo syamaner/roastpilot-cloud
```

Record the conservative `PAUSE_START` immediately before sending the pause
write, as shown above. This covers the request/acknowledgement interval in
which GitHub can persist the pause before `gh` returns; a slightly early lower
bound only over-includes events. `PAUSE_END` is captured just after the
successful `FACTORY_PAUSED` → `false` unpause write in resume step 2 — the
upper-bound dual of the conservative pre-write `PAUSE_START`. Recording it after
the write returns safely over-includes the request/acknowledgement interval in
which GitHub can still suppress an event before the unpause persists; a slightly
late upper bound only over-includes events. It is the upper bound for every
backfill.
Use this exact conservative `PAUSE_START` as the lower-bound anchor for every
backfill: the Step 1 issue sweep, the 9d enabled-interval/PR sweep, and the 9e
comment sweep's conservative lookback. Never replace it with the later pause
acknowledgement time. Immediately after the pause write, read and record the
persisted values of
`CODEX_ADVISORY_STATUS_ENABLED`, `OWNER_COMMAND_INTAKE_ENABLED`, and
`OWNER_TASK_APPLY_ENABLED` as start-of-window evidence. Capture each variable's
`updated_at` at the same time and record every change to any of the three during
the pause. Setting the pause flag does not alter these enable variables, so
capturing them immediately afterward does not itself change their state or
delay the kill switch. However, the post-write value alone does not prove the
value at `PAUSE_START`: a concurrent enable-variable write can cross that
boundary. If a variable's `updated_at` is at or after `PAUSE_START`, or its
change history across the pause cannot be fully audited, classify it as
**unknown → enabled** for interval reconstruction and use the resulting
over-inclusive backfill inventory. An enable variable may be treated as
disabled at `PAUSE_START` only when audited state proves it was disabled and
that no write crossed the boundary. Record a confirmed absent variable as
absent rather than silently coercing it to a value. These are read-only state
captures; do not create or update any enable variable as part of the halt.
Ambiguous capture or history never authorizes capability-ambiguous task replay.

**Check current state:**

```bash
gh variable list --repo syamaner/roastpilot-cloud

gh api repos/syamaner/roastpilot-cloud/actions/variables/CODEX_ADVISORY_STATUS_ENABLED --jq '{name, value, updated_at}'
gh api repos/syamaner/roastpilot-cloud/actions/variables/OWNER_COMMAND_INTAKE_ENABLED --jq '{name, value, updated_at}'
gh api repos/syamaner/roastpilot-cloud/actions/variables/OWNER_TASK_APPLY_ENABLED --jq '{name, value, updated_at}'
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

Enumerate runs repository-wide rather than naming only today's factory
workflows. The output includes each run's workflow path so the operator can
map it to the halt inventory in §3, the unaffected-workflow list above, or the
special Snowflake exclusion below. An unrecognized path is an operator stop:
classify it before cancelling or resuming anything.

Two `gh run list` caveats are the reason this procedure uses the REST endpoint
directly. First, `--status` only keeps the LAST value passed if the flag is
repeated (a known `gh` CLI limitation, cli/cli#7949). Second, `--limit`/`-L`
defaults to 20 and is the command's only pagination lever (both facts verified
against `gh run list --help`). An allowlist of today's known active states is
also unsafe: `pending` is distinct from `queued`/`in_progress` and is used
while a run waits behind a concurrency group, while `requested`, `waiting`,
`action_required`, or a future status could otherwise be missed. Select active
runs by exclusion: every status other than `completed` requires classification.
The REST runs endpoint includes runs from disabled workflows, so this same
enumeration remains complete if §3 was applied early.

**List every non-completed run, without a silent cap:**

```bash
gh api --paginate 'repos/syamaner/roastpilot-cloud/actions/runs?per_page=100' \
  --jq '.workflow_runs[] | select(.status != "completed") | [.id, .status, .path] | @tsv'
```

**Also reconcile recently completed runs whose activity crossed the pause
boundary.** Record `CLASSIFICATION_TIME` when the non-completed query above
starts, then run this companion paginated query. `updated_at >= PAUSE_START`
deliberately over-includes runs whose terminal activity might have occurred
after the pause began, including a run that changed from active to `completed`
before the first query observed it. The cutoff filters on `created_at`, not
`run_started_at`, precisely because a run already queued at `CLASSIFICATION_TIME`
but not yet started has no or a later `run_started_at`; keying on `created_at`
keeps every run that existed when classification began in one of the two
inventories. The completed status is selected in jq, not with a server-side
`status=completed` URL filter, because GitHub's List-workflow-runs endpoint caps
a `status`-filtered search at 1,000 results — so `--paginate` cannot complete it
and, under a long pause with more than 1,000 completed runs, older
boundary-crossing publisher or task runs would be dropped server-side before the
window predicates apply. This mirrors the reason the primary non-completed query
also fetches the unfiltered endpoint and filters status in jq:

```bash
PAUSE_START=<RECORDED_PAUSE_START>
CLASSIFICATION_TIME=<TIMESTAMP_WHEN_THE_NON_COMPLETED_QUERY_STARTED>
gh api --paginate \
  'repos/syamaner/roastpilot-cloud/actions/runs?per_page=100' \
  --slurp |
jq -r --arg pause_start "$PAUSE_START" --arg classification_time "$CLASSIFICATION_TIME" '
  .[] | .workflow_runs[]
  | select(.status == "completed")
  | select(.created_at <= $classification_time)
  | select(.updated_at >= $pause_start)
  | [.id, .status, .conclusion, .created_at, .run_started_at, .updated_at, .path]
  | @tsv
'
```

**`gh api --paginate` is not an atomic snapshot.** It fetches pages
sequentially, so while it walks the pages a concurrent mutation—the unaffected
CI and review workflows keep creating runs, and runs can be deleted—can shift
entries across page boundaries. To make the inventory robust to this, do not
treat a single pass as authoritative: REPEAT both the primary (non-completed)
and companion (completed boundary-crossing) sweeps and take their union,
DEDUPLICATED BY RUN ID, until two consecutive full passes return the same set of
run IDs — a stable fixed point — before proceeding to cancellation. Only then
treat the enumerated set as complete. Direction of the risk: with the default
newest-first ordering a concurrent ADDITION pushes older runs toward later,
as-yet-unread pages, so it typically yields a harmless DUPLICATE (removed by the
run-ID dedup) rather than a miss; the repeat-to-stable-fixed-point rule
additionally covers deletion-induced or reordering shifts, so an active
write-capable run cannot slip through unread. This is the same fail-closed
spirit as the "a cancellation request by itself never closes the step" rule
below: the enumeration is complete only when it is stable.

Classify every boundary-crossing row. For each side-effecting run—including an
`implement-ready-issues.yml` publisher, an `owner-command-intake.yml`
`task-apply`, or an advisory-status write—verify its conclusion and its durable
terminal marker or effect. Reconcile every non-`success` conclusion and every
write whose durable terminal effect is absent before resume; use the #236
procedure for a task apply that pushed without its marker. This reconciliation
is required even if Conditional Step 4 or Step 5 would otherwise be recorded
as a no-op.

**After classifying every row, classify the active job before cancelling each
gated factory run found.** Do not blanket-cancel the unaffected workflows or
the Snowflake exclusion below, and do not proceed past an unknown workflow
path. Treat the entire `Validate and publish the implement patch` step in
`implement-ready-issues.yml` as a protected write window: its push, PR
create/refresh, fallback and anti-gaming labels, annotations, and catch-block
partial-publish diagnostic must finish together. For
`owner-command-intake.yml`, protect one atomic push-to-marker window spanning
both `Apply the admitted owner-task commit` and `Finalize owner-task apply`.
The apply step performs `git push --force-with-lease` and writes
`applied_commit`; the finalize step verifies reachability and posts the
`github-actions[bot]` comment-bound marker. Once a task-apply run enters the
apply step, do not interrupt it: wait for the run to reach terminal through the
end of the finalize step. Reconcile every non-success result before completing
the halt. If the push landed without its marker, use the [#236 idempotency
procedure](https://github.com/syamaner/roastpilot-cloud/issues/236) before
proceeding so replay cannot apply the same source command again. Cancel the
remaining targeted runs normally:

```bash
gh run cancel <run-id> -R syamaner/roastpilot-cloud
```

Cancellation is asynchronous: a successful request does not prove the runner
has stopped. After each request, repeatedly re-query that exact run until it
reports terminal `status: "completed"`; do not proceed to §3, resume, or an
activation write while any targeted run remains non-completed:

```bash
gh api repos/syamaner/roastpilot-cloud/actions/runs/<run-id> \
  --jq '{status, conclusion}'
```

Classification cannot close the race for **any** side-effecting or credentialed
factory run. For every such run that receives a cancellation request or
terminates with a non-`success` conclusion, regardless of the step on which it
was observed, wait for terminal state and then either prove it never entered a
write step or verify its intended durable effect and reconcile every partial
effect before resume. This rule covers every run that can push, open or refresh
a PR, or write labels, comments, or status—including the publisher, privileged
triage apply, owner-task apply, and advisory-status writer—and future factory
write surfaces inherit it automatically.

Check the workflow-specific durable effect: for a publisher, reconcile the
pushed branch and PR state; for triage apply, reconcile the issue labels and
comments; for advisory status, reconcile the expected status context; and for
task apply, bind the run to its source comment and require the comment-bound
terminal marker from exactly `github-actions[bot]`. Task apply remains the
named #236 instance: if `git push --force-with-lease` landed without that
marker, complete the #236 reconciliation before resume. A run observed before
its write step can enter that step before asynchronous cancellation takes
effect, so a non-atomic step observation never proves any cancelled or failed
side-effecting run safe.

**If a normal cancel doesn't take** (the run ignores the cancellation
signal — can happen mid-API-call, where the runner process doesn't check for
cancellation until its next step boundary), force-cancel it:

```bash
gh api -X POST repos/syamaner/roastpilot-cloud/actions/runs/<run-id>/force-cancel
```

The exceptions are an `implement-ready-issues.yml` job executing its entire
side-effecting `Validate and publish the implement patch` step and an
`owner-command-intake.yml` job anywhere from entry into
`Apply the admitted owner-task commit` through completion of
`Finalize owner-task apply`: never force-cancel either protected write window.
Wait for the entire applicable step span and run to finish, verify the run is
terminal with the same query, and reconcile every non-success result; for
`task-apply`, also complete the #236 reconciliation above before treating it as
settled. After a
force-cancel, also keep re-querying until the run reports
`status: "completed"`. Section §2 is complete only when every enumerated gated
run is terminal, every protected write window is reconciled, and every
cancelled or non-success side-effecting run has been terminal-reconciled or
proven never to have entered its write step; a cancellation request by itself
never closes the step.

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
do it after cancelling (§2)**. The repo-wide REST enumeration in §2 includes
disabled-workflow runs. The `-a/--all` caveat applies only if you optionally
inspect one workflow with `gh run list --workflow <name>` after disabling it:
without `-a/--all`, that inspection hides a disabled workflow's runs (verified
against `gh run list --help`).

**Before running any disable command, capture the pre-halt workflow state.**
First run the state-check command shown immediately below the disable block
(`gh api --paginate 'repos/syamaner/roastpilot-cloud/actions/workflows?per_page=100'
--jq '.workflows[] | {name, id, state}'`) and record which of these four
workflow IDs are `active`. On resume, re-enable only workflows this halt
provably transitions from `active` to `disabled_manually`. Bind each transition
to this halt with audit evidence for this halt's own disable action and
timestamp, or serialize the state changes so no concurrent operator can cause
the transition between snapshot and request. A post-check showing only
`disabled_manually` does not establish which actor disabled it. A workflow that
was already `disabled_manually`, or whose transition cannot be bound to this
halt, may be a deliberate disarm and must be left out of the resume set. If the
pre-halt state, actor, or transition evidence is missing or ambiguous, fail
closed: leave that workflow disabled until a separate deliberate decision.

```bash
gh api -X PUT repos/syamaner/roastpilot-cloud/actions/workflows/315461463/disable   # triage-issues.yml
gh api -X PUT repos/syamaner/roastpilot-cloud/actions/workflows/315533067/disable   # implement-ready-issues.yml
gh api -X PUT repos/syamaner/roastpilot-cloud/actions/workflows/330152328/disable   # codex-verdict-status.yml — currently dark — listed for completeness before 9h activation
gh api -X PUT repos/syamaner/roastpilot-cloud/actions/workflows/330592310/disable   # owner-command-intake.yml — currently dark — listed for completeness before 9h activation
```

**After disabling, re-run the state check to confirm the intended transitions
(look for `"state": "active"` vs `"disabled_manually"`):**

```bash
gh api --paginate 'repos/syamaner/roastpilot-cloud/actions/workflows?per_page=100' \
  --jq '.workflows[] | {name, id, state}'
```

Workflow IDs are stable for the life of the workflow file (renaming the
file changes the path, not the ID) — re-verify with the command above if
these ever look wrong, don't assume they're permanent across a repo
migration or a workflow file being deleted and recreated.

#### Exclusion: `dev-snowflake-contract.yml`

`dev-snowflake-contract.yml` is credentialed and side-effecting: it runs a
writable `schemachange deploy`. Its required-reviewer
`dev-snowflake-ci` Environment, not the factory pause flag, gates access to its
credential, and it is `workflow_dispatch`-only. It is therefore **EXCLUDED**
from the blanket §2 cancel and §3 disable procedures.

If its run is awaiting Environment approval, reject or withhold approval; that
is the safest halt. If it is already in flight, let it complete inside its
20-minute timeout because cancelling mid-migration can leave partially applied,
auto-committed DDL. Check the terminal conclusion and treat every result other
than `success`—including `failure`, `timed_out`, or `cancelled`, whether or not
force-cancellation was involved—as incomplete: the schemachange change-history
table records which changes applied, but the post-deploy grants audit might not
have run. Reconcile the recorded changes and re-dispatch the workflow once it
is safe to finish the contract check.

### Emergency halt — full procedure

1. **Record the conservative `PAUSE_START`, then set the pause flag** (§1)
   first, always — the timestamp capture is local and the immediately following
   write reliably stops the inflow of any run created from that point on.
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

**Resuming has three always-applicable steps plus two conditional event
backfills. Skipping an applicable step leaves the factory in a wrong state:**

1. **Re-enable the workflows you disabled—but only the subset you recorded as
   `active` before the halt and whose disable transition is provably bound to
   this halt** (§3). The fenced block below is the full candidate set; run only
   the lines for that halt-bound subset. A workflow already
   `disabled_manually` before the incident was deliberately disarmed and must
   remain disabled. A transition that cannot be attributed to this halt is
   ambiguous and must also remain disabled; never undo a possibly concurrent
   deliberate disarm. Blanket-enabling either case—especially a credentialed
   workflow such as `owner-command-intake.yml`—could re-arm its jobs when the
   pause flag is later cleared. When the pre-halt state or halt ownership is
   unknown, leave the workflow disabled and re-enable it only through a
   separate deliberate decision:

   ```bash
   gh api -X PUT repos/syamaner/roastpilot-cloud/actions/workflows/315461463/enable   # triage-issues.yml
   gh api -X PUT repos/syamaner/roastpilot-cloud/actions/workflows/315533067/enable   # implement-ready-issues.yml
   gh api -X PUT repos/syamaner/roastpilot-cloud/actions/workflows/330152328/enable   # codex-verdict-status.yml — currently dark — listed for completeness before 9h activation
   gh api -X PUT repos/syamaner/roastpilot-cloud/actions/workflows/330592310/enable   # owner-command-intake.yml — currently dark — listed for completeness before 9h activation
   ```
2. **Set `FACTORY_PAUSED` back to `false`.** This is the step that
   actually restarts the factory — re-enabling the workflows alone does
   **not** resume anything, because every job's `if:` condition still
   gates on the flag regardless of whether the workflow itself is
   enabled or disabled:

   ```bash
   gh variable set FACTORY_PAUSED --body false --repo syamaner/roastpilot-cloud
   PAUSE_END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
   printf 'PAUSE_END=%s\n' "$PAUSE_END"
   ```

   Record `PAUSE_END` only after the unpause command returns, as shown — the
   upper-bound dual of §1's conservative pre-write `PAUSE_START`. An event
   arriving after the write is issued but before GitHub persists the unpause is
   still suppressed, so a `PAUSE_END` taken before the command returns would end
   the window early and omit it; capturing it afterward safely over-includes
   that request/acknowledgement interval.

   **Close each workflow's recovery window at that workflow's own return to
   service, not automatically at global `PAUSE_END`.** For a workflow re-enabled
   in resume step 1, the pause flag remains its final blocker, so its outage end
   is `PAUSE_END`. For a workflow left disabled under the fail-closed §3 rule,
   or otherwise re-enabled later, record its eventual deliberate re-enable
   timestamp as `WORKFLOW_OUTAGE_END`, captured conservatively immediately AFTER
   that workflow's `…/enable` PUT returns
   (`WORKFLOW_OUTAGE_END="$(date -u +%Y-%m-%dT%H:%M:%SZ)"`), so it over-includes
   the enable request/acknowledgement interval in which GitHub can still suppress
   an event before the enablement persists — the per-workflow dual of §1's
   conservative pre-write `PAUSE_START` and resume step 2's post-unpause
   `PAUSE_END`. Until then, its recovery obligation
   remains explicitly open and cannot be marked complete. Use the conservative
   `PAUSE_START` as its outage start for this halt, or an earlier recorded
   disable timestamp when recovery must cover a pre-existing disable. Extend
   that consumer's inventory through its actual `WORKFLOW_OUTAGE_END`; never
   truncate it at the global unpause.

   Apply this rule to every consumer below: use `TRIAGE_OUTAGE_END` for the
   Step 1 issue inventory, `CODEX_STATUS_OUTAGE_END` for 9d, and
   `OWNER_COMMAND_OUTAGE_END` for 9e. Each equals `PAUSE_END` only when that
   workflow was re-enabled in step 1. If one remains disabled, retain an owed
   recovery record, continue extending its upper bound, and perform the final
   backfill only after its deliberate re-enable.

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

**Step 1 — find every issue opened during the pause/disabled window.** Use the
conservative pre-write `PAUSE_START` recorded in §1, never the later pause
acknowledgement time. In the command below, retain `<PAUSE_END>` as the
upper-bound placeholder but replace it with the workflow-specific
`TRIAGE_OUTAGE_END` defined above—not the global `PAUSE_END` when
`triage-issues.yml` remained disabled. Replace both placeholders with exact UTC
timestamps.
Search by creation time, not readiness labels: the story template itself
adds `needs-triage`, so a missing-label filter would exclude affected
template-filed issues. `--limit` defaults to 30; raise it above the
maximum possible issues in the window:

```bash
gh issue list --repo syamaner/roastpilot-cloud --state open --limit 200 \
  --search "created:<PAUSE_START>..<PAUSE_END>" \
  --json number,title,createdAt,state
```

Tripwire: if the returned count equals the 200-item limit, raise the limit and
re-run before dispatching anything; equality means the inventory may have been
silently truncated.

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

**Conditional Step 4 (9d) — backfill advisory status events.** Use the
conservative pre-write `PAUSE_START`, the start-of-window capture, and the
recorded change history through `CODEX_STATUS_OUTAGE_END` to identify every
sub-interval in which `CODEX_ADVISORY_STATUS_ENABLED` was `true` while the
workflow was paused or disabled.
Normalize every captured value and change-history value to lowercase before
classifying those intervals, matching the workflow gate's case-insensitive
string comparison. Record this step as a no-op only when the gate was confirmed
false or absent for the entire workflow-specific outage. If its change history
cannot be fully reconstructed, treat the entire
`PAUSE_START`–`CODEX_STATUS_OUTAGE_END` window as one enabled interval rather
than narrowing it; over-inclusion is the safe direction. If the gate state or
workflow-specific boundary is truly unknown, stop rather than treating it as
disabled.
GitHub does not replay the PR/review/comment events consumed during an enabled
interval, so when any such interval exists sweep
**every currently open PR**. Do not filter the inventory by `updated_at`: a
later title, label, or other non-triggering update can move a genuinely missed
PR past `CODEX_STATUS_OUTAGE_END`. The workflow-specific outage window is only
an optional prioritisation hint for which PRs to inspect first, never a filter
that can drop an entry.
Over-inclusion is the safe direction because each dispatch recomputes the
current snapshot and overwrites the single PR-scoped status context:

```bash
gh api --paginate \
  'repos/syamaner/roastpilot-cloud/pulls?state=open&sort=updated&direction=asc&per_page=100' \
  --jq '.[] | [.number, .updated_at, .html_url] | @tsv'

PR_NUMBER=<PR_NUMBER>
gh workflow run codex-verdict-status.yml --ref main --repo syamaner/roastpilot-cloud -f pr_number="$PR_NUMBER"
```

Work through the resulting PR inventory one at a time. Queuing the dispatch is
not completion: capture its run ID, wait for that exact run to reach a terminal
conclusion, and confirm that it wrote a status record on the PR snapshot with
the exact context `factory/codex-verdict-advisory/pr-<PR_NUMBER>` and a
`target_url` for that run. A failed run, a run skipped because the enable
variable is now false, or a terminal run without that status effect remains
owed; record it as still-owed, not done. Every inventoried PR must end with
either this verified effect or an operator-recorded skip with a reason; an
empty result must be recorded too. Never silently drop an entry.

**Conditional Step 5 (9e) — backfill owner commands.** Use the conservative
pre-write `PAUSE_START`, the start-of-window capture, and the recorded change
history through `OWNER_COMMAND_OUTAGE_END` to identify every sub-interval in
which `OWNER_COMMAND_INTAKE_ENABLED` was `true` while the workflow was paused
or disabled.
Normalize every captured value and change-history value to lowercase before
classifying those intervals, matching the workflow gate's case-insensitive
string comparison. Record this step as a no-op only when the gate was confirmed
false or absent for the entire workflow-specific outage. If its change history
cannot be fully reconstructed, treat the entire
`PAUSE_START`–`OWNER_COMMAND_OUTAGE_END` window as one enabled interval rather
than narrowing it; over-inclusion is the safe direction for inventory, but it
does not authorize
automatic replay when one comment's interval membership remains ambiguous.
If the gate state or workflow-specific boundary is truly unknown, stop rather
than treating it as disabled. This workflow has no dispatch path. Reconstruct
`FACTORY_OWNER_LOGINS` from its change history over
the sweep window and determine whether each comment author was authorized at
that comment's `created_at` timestamp. Never filter historical comments using
only the current allowlist: that would omit removed owners and prematurely
admit newly added owners. If the allowlist history cannot be reconstructed,
stop or record every affected command-looking comment as owed for
investigation, never for automatic replay; never infer issuance-time
authorization from today's value. Build the authoritative
inventory from comments by sweeping every enabled
sub-interval plus a conservative lookback before the first enabled interval,
covering any command whose run could have been queued or in flight at
`PAUSE_START`. If the lookback bound is uncertain, widen it; over-inclusion is
the safe direction. First enumerate every candidate comment whose visible
leading content is `@claude question` or `@claude task`, then apply
issuance-time authorization:

```bash
COMMENT_SWEEP_START=<CONSERVATIVE_LOOKBACK_START>
COMMENT_SWEEP_END=<OWNER_COMMAND_OUTAGE_END>
gh api --paginate \
  "repos/syamaner/roastpilot-cloud/issues/comments?since=$COMMENT_SWEEP_START&per_page=100" \
  --slurp |
jq -r --arg start "$COMMENT_SWEEP_START" --arg end "$COMMENT_SWEEP_END" '
    .[][]
    | select(.created_at >= $start and .created_at <= $end)
    | select(
        .body
        | gsub("\\r\\n?"; "\\n")
        | test("^\\n*@claude[ \\t]+(question|task)(\\s|$)"; "i")
      )
    | [.id, .created_at, .updated_at, .user.login, .issue_url, .html_url, .body]
    | @json
  '
```

This leading-command grammar mirrors `parseOwnerCommand`; re-copy it here if
that parser's leading-command grammar changes. The command deliberately emits
all matching author identities; apply the reconstructed, time-versioned
allowlist to classify each row after enumeration, retaining ambiguous rows as
owed for investigation rather than automatic replay.

Deduplicate the candidate comment sweep by source comment ID. A comment is an
owed re-issue candidate only after it passes the same runtime admission
predicates. Confirm that the comment belongs to a same-repository, open,
unmerged, non-fork PR—not an ordinary issue—mirroring `isPullRequestIssue`,
`isSameRepositoryPullRequest`, and `isEligiblePullRequestState` in
`scripts/factory/owner-command-logic.mts`. Parse its visible leading content
with the exact `parseOwnerCommand` grammar as a supported `@claude question`
or `@claude task`; for a task, require a non-empty parsed payload. This mirrors
the admission enforced by `deriveResponseAuthorization` and
`intake-owner-command.mts`, rather than treating the sweep's coarse regex as
admission evidence. A comment failing any runtime predicate is not owed: record
it as `not-admissible`, not as a permanently owed entry or invented skip.

**Admission is derived from the comment as CREATED, never from a possibly-edited
current body.** `owner-command-intake.yml` triggers only on
`issue_comment.created`; an edit never triggers intake, so the created body is
the only body the trigger ever saw. The sweep parses each comment's current
body, so a comment created with harmless text and later edited to begin with
`@claude task`/`@claude question` would be emitted and parsed as a command that
was never present in the triggering event. Therefore treat any comment whose
`updated_at != created_at` (edited after creation — the added `updated_at`
output column surfaces this) as **ambiguous**: do not derive admission from its
current body, withhold automatic replay, and record it for explicit operator
investigation, UNLESS creation-time body evidence proves the created (not
edited) body was itself a valid command in an enabled, authorized interval. An
edited comment without such creation-time evidence is never auto-re-issued.

After runtime admission, a comment is an owed re-issue candidate only when all
three additional conditions hold: its `created_at` falls inside a reconstructed
interval where `OWNER_COMMAND_INTAKE_ENABLED` was enabled, its author was
authorized at that exact issuance time, and its verified terminal effect is
absent. Apply both time-varying filters per comment; the outer query bounds
alone prove neither condition. A comment in a disabled gap was never admitted,
is not owed, and must not be re-issued.

For a candidate `@claude question`, verify whether a response authored by
exactly `github-actions[bot]` already ends with the comment-bound terminal marker
`<!-- owner-command-response: <commentId> -->`. For each enumerated
`@claude task`, apply the existing capability-safe rule below and verify the
acknowledged or applied terminal effect required for that task's capability.
A different bot or App does not prove completion; this exact-identity rule
mirrors the runtime `RESPONSE_BOT_LOGIN` check.
A fully eligible command with its verified effect is already processed; record
it done. A fully eligible command without that effect remains owed and must be
re-issued or receive a recorded operator skip.

A comment from the conservative pre-window lookback is owed only when §2
boundary-crossing or in-flight run evidence binds that specific source comment
to a command that was actually consumed or in flight. The same run-bound proof
is required when interval membership is ambiguous. Without it, record the
comment for explicit operator investigation and do not auto-re-issue it; an
unadmitted command must never gain capability through backfill.

Use the §2 owner-command run rows only as a cross-check, never as the primary
run-to-comment inventory: a run record does not persist its triggering comment
ID, and a run can finish before the §2 enumeration response is evaluated.
Every §2-enumerated row whose path is
`.github/workflows/owner-command-intake.yml` should correspond to a command in
the comment sweep. If a row does not map to any enumerated comment, flag it for
explicit operator investigation and widen the lookback when that can resolve
the gap. Record the investigation disposition; neither silently drop the row
nor permanently block the deterministic comment inventory. Deduplicate all
matched commands by source comment ID.

Before re-issuing each `@claude task`, establish the task-apply capability when
that source command was originally issued from the start-of-window capture and the
incident record of capability changes, then read its current value. If
`OWNER_TASK_APPLY_ENABLED` differs, do not silently re-issue the task: require
explicit operator reauthorization under the current capability or record a
skip with its reason. This prevents an acknowledgement-only task from gaining
mutation authority on replay, and prevents a formerly write-enabled task from
being counted done after only an acknowledgement. `@claude question` is
unaffected because it carries no mutation capability. If issuance-time or
replay-time capability is ambiguous, fail closed: withhold the replay and
record it still owed, never replay it under an unverified capability.

For every owed command, the same authorized owner must re-issue the
original command as a fresh PR comment after resumption. Never edit the old
comment: edits do not retrigger `owner-command-intake.yml`. Posting the fresh
comment is not completion: capture its comment ID, confirm that
`owner-command-intake.yml` ran for it and reached a terminal conclusion, and
verify the workflow's documented response effect for that exact fresh comment
(including its comment-ID-bound terminal marker) before recording it done. A
failed run, a run skipped because the enable variable is now false, or a fresh
comment with no workflow response remains owed; record it as still-owed, not
done. Every inventoried comment must end with either this verified effect or an
operator-recorded skip with a reason; an empty result must be recorded too.
Never silently drop an entry.

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

## F1-S6 dry-run runbook (skeleton — 9h fills from observed behaviour)

### Stuck states and recovery

(To be filled during the supervised 9h session from observed behaviour; do not fill from speculation.)

### Half-published branches

(To be filled during the supervised 9h session from observed behaviour; do not fill from speculation.)

### Malformed verdicts

(To be filled during the supervised 9h session from observed behaviour; do not fill from speculation.)

### Where the logs live

(To be filled during the supervised 9h session from observed behaviour; do not fill from speculation.)

### Cost and usage record

(To be filled during the supervised 9h session from observed behaviour; do not fill from speculation.)

### Rollback (C7 cross-link)

(To be filled during the supervised 9h session from observed behaviour; do not fill from speculation.)

## Metrics baseline capture (9b)

Capture one record immediately after each factory-authored PR merges. Use the
merged PR's final head, not a later branch tip, and retain the command output or
downloaded artifact with the operator's capture notes. Gather each field as
follows:

| Manifest field | Evidence and gathering procedure |
|---|---|
| `prNumber`, `headSha` | `gh pr view <PR> -R syamaner/roastpilot-cloud --json number,headRefOid` on the merged PR. |
| `issueNumber` | Read the PR's closing/reference declaration with `gh pr view <PR> -R syamaner/roastpilot-cloud --json body,closingIssuesReferences`; record the single issue the factory dispatch implemented. |
| `issueType` | Determine the issue's scope against the closed enum (`feature`, `security-fix`, `hardening`, `documentation`, `migration`, `schema`) and record the operator's classification rationale in the capture notes. Stop if the scope is ambiguous. |
| `execution` | Record `factory` only when the PR is attributable to the factory implementation/publisher run; retain the run URL and verify the publisher identity with `gh pr view <PR> -R syamaner/roastpilot-cloud --json author`. Otherwise record `conventional`. |
| `securitySurface` | Save `gh pr diff <PR> -R syamaner/roastpilot-cloud --name-only` and apply the `factory-security-reviewer` routing set in `AGENTS.md` to that exact path list. |
| `triageOverridden` | Compare the bot-owned terminal triage verdict and readiness label with the human's final triage disposition in the issue timeline (`gh api --paginate repos/syamaner/roastpilot-cloud/issues/<ISSUE>/timeline`). Record true for a human override, never infer agreement from missing evidence. |
| `firstPassCiGreen` | From the first post-open PR head, query `gh api repos/syamaner/roastpilot-cloud/commits/<SHA>/check-runs`; record true only when every applicable CI check passed on that first head without a corrective push. |
| `postOpenReviewRounds` | Use `gh api --paginate repos/syamaner/roastpilot-cloud/pulls/<PR>/commits`, `/reviews`, and `/comments`; count completed review/fix rounds after the PR opened, retaining the timestamps and head SHAs used for the count. |
| `humanTouchMinutes` | Start and stop an operator timer for issue/PR intervention, review handling, and recovery; record the elapsed minutes in the capture notes before entering the finite non-negative total. |
| `reviewFindings` | Read every check result, submitted review, inline thread, and top-level reviewer verdict. Normalize each substantive finding to its byte-exact lens, severity, description, and counterfactual; retain links to the source review or run artifact. |
| `lensCosts` | Record token usage from each lens's own usage artifact when available and wall-clock time from the corresponding Actions job timestamps (`gh run view <RUN> --json jobs`). Use explicit `null` when a measurement is unavailable; never substitute zero. |
| `sampledForAudit` | Apply the committed seed and `deterministicAuditSampleDraw(prNumber, seed, 20)` before audit assignment and record the returned boolean. Security-surface audit obligation is separate and remains unconditional. |

A formal issue-type label (ISSUE_TEMPLATE field plus triage support) is a candidate future enhancement for automated capture, not a requirement for human-driven R1 capture.

The canonical manifest location is
`scripts/factory/metrics/pr-baseline.json`. Load its complete text, construct
the fully evidenced `FactoryPrRecord`, and pass both to `upsertPrRecord`. Write
the returned text only when the result is `ok`. An identical replay is a
byte-preserving no-op; a malformed manifest or conflicting record is an
operator stop, never an overwrite. Commit baseline data separately from logic.

## Promotion ratchet (9b)

The autonomy ladder advances no more than one rung per successful evaluation:

| Rung | Dispatch | Chaining | Merge |
|---|---|---|---|
| R0 | Paused | Off | Human |
| R1 | Human dispatch | Off | Human |
| R2 | Shadow execution | Draft-for-audit | Human |
| R3 | Automatic | Triage-to-implement | Human |

Merge is never automatic at any rung. R3 is the top rung; an evaluation there
holds rather than inventing another level.

The caller MUST evaluate only factory records since the last recorded rung
change. Mechanical enforcement of that cutoff belongs to the consumer slice,
which owns persisted rung state; this pure-logic layer does not infer it.
Conventional records never enlarge the window. The ratified defaults are: at least K=35
factory PRs, at least three distinct issue types, override rate at most 10%,
first-pass CI-green rate at least 80%, post-open review-round median at most 1,
random audit sample 20%, and Wilson z=1.96. The override gate uses the 95%
Wilson lower bound for agreement (`n - overrides`) and requires at least 0.90.
K=35 is the break-even for a flawless window: 34/34 has lower bound about
0.8985 and still holds, while 35/35 is about 0.9011 and can advance. Every
other rule is evaluated in the same pass, so the hold report preserves all
observed failures rather than stopping at the first.

### Consumer-slice enforcement (deferred)

The ratchet consumer slice, not this pure-logic layer, must enforce all three
operator-ratified input preconditions:

1. mechanically window records at the last persisted rung change;
2. verify each `sampledForAudit` value against the committed audit-sample seed;
3. require positive review-completion evidence, rejecting an empty recorded-lens
   set or a zero review-round count caused by a skipped roster as promotable
   evidence.

## Audit sampling and ledger (9b)

Every security-surface PR is audited (100%), whether or not it wins the random
draw. For each non-security factory PR, use the exact committed sampling seed
and call `deterministicAuditSampleDraw(prNumber, seed, 20)`; do not redraw with
a new seed after seeing the result. Preserve the committed seed with the
metrics data so another operator can reproduce the selection.

Each audit-ledger entry has exactly `prNumber`, `auditor`, `performedAt`, and
`outcome`. The timestamp is UTC at second precision and the outcome is one of
`clean`, `findings-fixed`, or `escape`; unknown outcomes fail closed. Rotate
the assigned human auditor procedurally so the same operator does not
repeatedly audit their own capture, and record the assignment before the audit
begins. Multiple entries for a PR are allowed when follow-up evidence warrants
them.

Before ratchet evaluation, join every security-surface or randomly sampled
window record to the ledger by PR number. If any owed audit has no ledger
entry, the ratchet refuses promotion and reports the missing PR number. Any
recorded `escape` in the window independently refuses promotion.

## Advisory Codex status (9d)

The dark advisory publisher writes only the PR-scoped context
`factory/codex-verdict-advisory/pr-<n>`. Its description is one of these three
bounded forms:

- `clean channel=clean-comment sha=<7-hex>` for a confirmed clean bot comment;
- `findings source=<review|comment> sha=<7-hex> count=<n>` for findings; or
- `pending reasons=<reason[,reason...]>[; omitted=<n>]; advice=<advice>` (with
  the Merge Policy pointer when `advice=due`) when a verdict cannot close.

The operator invariant is: **no `factory/codex-verdict-advisory*` context ever enters the required-checks list**.
This status is informational and must remain separate from branch-protection
requirements.

The workflow is inert until both base-owned gates hold:
`vars.CODEX_ADVISORY_STATUS_ENABLED == 'true'` and
`vars.FACTORY_PAUSED != 'true'`. The enable variable is deliberately absent
during this dark launch. Creating or enabling it is the separate 9h hard stop,
not an action authorized by this wiring PR.

| Stuck `pending` state | Operator action |
|---|---|
| `awaiting-retrigger; advice=due` | Follow the Merge Policy: post the single manual re-trigger allowed for the unchanged head, then wait for its verdict. |
| `evidence-incomplete` | Check the run log for a 50-page-cap overflow or malformed/deleted-account records; correct the evidence source before re-running. |
| `reaction-clean-unconfirmed; advice=verify` | D148 requires a human to read the PR; reactions alone never certify clean. |
| `snapshot-inconsistent` or `timeline-incomplete` | Re-run against a fresh, internally consistent GitHub snapshot. |

For recovery, run `workflow_dispatch` from the `main` ref and supply the
positive decimal `pr_number`. Dispatches from any other ref are rejected by the
job gate. A recovery run recomputes from GitHub's current PR snapshot and does
not accept a caller-supplied SHA, context, or event payload.

## Owner command intake (9e)

The dark owner-command pipeline lets an authorised factory owner from the
single-source `FACTORY_OWNER_LOGINS` allowlist (currently `syamaner`) comment
`@claude question ...` or `@claude task ...` on an eligible PR. Per D149, the
command must be the visible leading content of the comment. A `question`
receives exactly one bounded, sanitised bot comment; a `task` receives only the
fixed acknowledgement that task execution is not yet enabled (9f/9g) and no
patch was produced.

The four jobs keep untrusted command data separate from authority:

- `resolve-trusted-revision` uses the byte-identical shared resolver with
  `permissions: {}` to select the trusted base-owned revision.
- `intake` is read-only. It applies a coarse eligibility pre-filter, builds a
  nonce-fenced prompt that labels the owner question and PR diff as untrusted
  DATA, and records the authorised PR and command snapshot in `binding.json`.
- `answer-agent` is read-only and receives no write token. It restores
  base-owned configuration from the trusted revision, invokes the pinned
  `claude-code-action`, and permits `Edit(answer-output/answer.md)` plus the
  `ToolSearch` discovery residual (the same deliberate §1.3 residual as
  `claude-review`); every model file reader, Bash, network/egress tool, and
  other write sink is denied by name. `ToolSearch` adds no reachable capability
  here: it can surface only schemas for already-denied tools, while the sole
  capability-bearing invocable tool is the scoped `Edit`. Whether to
  additionally deny and runtime-verify `ToolSearch` with a step-C-style catalog
  assertion (the #212 class) was not settled by the 11 Aug 2026 credential-class
  ratification and remains an open #212-class hardening item, not an action
  enabled by this dark wiring. The untrusted DATA arrives through
  `--append-system-prompt-file`.
- `publish` has `pull-requests: write` as its only write permission. It
  independently re-fetches the source records and re-derives authorization,
  enforces the `binding.json` snapshot, and posts exactly one response or the
  fixed stale-snapshot notice when the source has drifted.

The workflow is inert until both base-owned gates hold:
`vars.OWNER_COMMAND_INTAKE_ENABLED == 'true'` and
`vars.FACTORY_PAUSED != 'true'`. The enable variable is deliberately absent
during this dark launch.

The answer-agent's `CLAUDE_CODE_OAUTH_TOKEN` was operator-ratified under its
own D140 platform disposition on 11 Aug 2026. This is a distinct
external-identity credential job class; it could not inherit D140 by analogy
and is not the built-in-token equivalence.

The authoritative, fail-safe activation order—including the mandatory
persisted-state preflight that reads both enable variables—is the single
consolidated sequence in [Owner task apply (9g)](#owner-task-apply-9g). Follow
that ordered path for any enablement, question or task, rather than a standalone
question-only procedure. That sequence is the operator-ratification hard stop
at 9h and is **not** authorized by this dark wiring.

Unpausing `FACTORY_PAUSED`, if and when the broader factory is unpaused, remains
a separate operator decision; setting either enable variable to `true` does not
authorize that transition.

Unlike the 9d advisory workflow, this workflow declares no
`workflow_dispatch`; it is triggered only by a newly created `issue_comment`.
There is no manual recovery dispatch, so the owner's recovery path is to
re-issue the command.

For a `question`, publish enforces the `binding.json` snapshot: head, base,
title, body, question-payload, or truncation-state drift after intake produces
the fixed notice that the command or pull request changed after the run started
and asks the owner to re-issue the command instead of posting a stale answer. A
truncated question or diff carries a deterministic truncation disclosure. Verb
edits are directional on the apply-disabled path
(`vars.OWNER_TASK_APPLY_ENABLED != 'true'`): a task→question edit produces the
stale notice, while a question→task edit produces the fixed task
acknowledgement; task commands do not enforce the snapshot binding. When task
apply is enabled, `task-apply` handles the task path and a task→question edit
observed before the apply decision currently produces no stale or superseded
notice, as bounded in the [#239 limitation](#owner-task-apply-9g). Because
comment edits do not retrigger the workflow, recovery requires a fresh comment
using the intended current verb: `@claude question` if an answer is now wanted,
or `@claude task` if a patch is still wanted.

## Owner task apply (9g)

The dark owner-task apply path extends `owner-command-intake.yml` from four to
six jobs. When an authorised owner's `@claude task` on an eligible pull request
is admitted and task apply is enabled, the read-only `task-agent` checks out the
authorised PR-head snapshot with `contents: read`. It restores base-owned
protected configuration at any depth from the trusted revision before Claude
edits the working tree. After the model exits, a trusted step resets the local
`.git/config` and captures the resulting tree delta as a patch.

The credentialed `task-apply` job has `contents: write` and
`pull-requests: write`. It independently re-fetches the source records and
re-derives authority, analyses the captured patch against one scratch-index
apply, and evaluates the merged owner-task decision table. An accepted patch is
applied as one `commit-tree` commit and pushed with
`git push --force-with-lease` using the reviewed head as the compare-and-swap
expectation. This is boundary (b): the Node entrypoint plans the operation, but
raw Git executes only in base-owned shell steps. The
[#236](https://github.com/syamaner/roastpilot-cloud/issues/236) crash-window
idempotency gap is resolved in the dark path by content-based replay recognition
(root 1, [#247](https://github.com/syamaner/roastpilot-cloud/issues/247)) plus
per-outcome success/notice marker sentinels and an honest late success record
(roots 2 and 3, [#250](https://github.com/syamaner/roastpilot-cloud/issues/250)).
On a rerun, decide recognises the already-applied commit from PR compare history
by byte-exact parent and tree, then converges to a silent no-op, posting an
honest late success record when the owner-task trailer is present, instead of
re-binding to the new head and re-applying. The four availability-only residuals
are tracked in [#249](https://github.com/syamaner/roastpilot-cloud/issues/249).

Both new jobs are unschedulable unless all three base-owned gates hold:
`vars.OWNER_COMMAND_INTAKE_ENABLED == 'true'`,
`vars.OWNER_TASK_APPLY_ENABLED == 'true'`, and
`vars.FACTORY_PAUSED != 'true'`. The two enable variables are deliberately
separate: `OWNER_COMMAND_INTAKE_ENABLED` controls question answering, while
`OWNER_TASK_APPLY_ENABLED` additionally controls task mutation. This lets 9h
light up question answering without enabling mutation. Neither variable was
created during the dark launch, so both jobs are unschedulable today.

### Applied-head roster re-validation (#238 decided path)

For every owner-task commit pushed by `task-apply`, complete this procedure on
the current PR head that contains the applied work before merge. Owner-task
apply admits only pull requests targeting the protected default branch, which
is why branch protection mechanically gates CI, CodeQL, and mutation testing
on the applied head. Dependency review and `codecov/patch` are operator-verified
gates rather than branch-protection-required status checks:

The trigger rule is categorical: CI, CodeQL, and dependency review use the
default `pull_request` activity types (`opened`, `synchronize`, and `reopened`).
They do not run on `ready_for_review` or `edited`; only the Claude review
workflow explicitly subscribes to `ready_for_review`. Closing and reopening the
PR is therefore the only way to re-run these pull-request-triggered checks on
an unchanged head. Marking a draft ready and retargeting the base do not re-run
them.

This gate assumes the default branch is protected by classic protection or a
ruleset with the required checks required. That global factory invariant,
tracked in [#245](https://github.com/syamaner/roastpilot-cloud/issues/245), is
now satisfied with nine required status contexts. This path relies on that
contract rather than re-verifying it: it confirms that the currently required
contexts pass, not that the contract still lists all nine, so a dropped context
would shrink the checked set undetected. Deterministic re-verification of the
contract, at enable time and on each applied head, is tracked in
[#254](https://github.com/syamaner/roastpilot-cloud/issues/254).

1. Read the current PR head with `gh pr view <n> --json headRefOid` and treat
   that `headRefOid` as the re-validation target. Locate the applied commit from
   the `Applied-Commit:` SHA in the finalize comment, then confirm that SHA is
   the current head or an ancestor of it. Fetch the current head object first
   with `git fetch origin <headRefOid>`, then run
   `git merge-base --is-ancestor <applied-sha> <headRefOid>`. This ancestry
   check is commit-provenance evidence only: it proves that the applied commit
   is in the current head's history. It does not prove that the intended change
   is retained in the tree that will merge, because a later commit may revert
   or overwrite it. Separately inspect the relevant paths or diff to confirm
   that the intended change is present in the current head's tree. The current
   head SHA remains the re-validation target.
2. Re-trigger the required roster without changing the head, using only the
   existing trigger surfaces. For a draft PR, close and reopen it while it is
   still a draft. The `reopened` event re-runs CI, CodeQL, and dependency review
   on the unchanged draft head, while the Claude jobs skip under their
   `draft == false` guards. Wait for the required checks and dependency review
   to complete on the stable head, then have the independent operator mark the
   PR ready exactly once. The `ready_for_review` event fires the Claude and
   Codex review lenses once on that same head. For an already-ready PR, close
   and reopen it once; that single `reopened` boundary re-runs the required
   checks, dependency review, and the Claude review lens together. These paths
   add no dispatch or App identity. For
   Codex, the re-validation boundary is the ready transition on the draft path
   and the reopened event on the already-ready path. If the connector shows no
   bot-authored signal associated with the current head and postdating the
   applicable boundary within the PR Merge Policy's approximately 30-minute
   timeout, post `@codex review` once on the unchanged head as that policy
   directs. A stale reaction or review from before the applicable boundary is
   not completion evidence. `AGENTS.md` is the single source of truth for
   accepted verdict channels.
3. Re-read `headRefOid` and `baseRefName` after the trigger with
   `gh pr view <n> --json headRefOid,baseRefName`. If a new push landed and the
   head drifted, restart from step 1 on the new head. Confirm that `baseRefName`
   still byte-equals the protected default branch. A base retarget invalidates
   the required-check and dependency-review evidence because CodeQL and
   dependency review do not run on another base. If the base is not the default
   branch, do not merge. Retarget it back to the default branch, then close and
   reopen the PR to re-run the pull-request-triggered checks on the applied
   head. The `edited` event from retargeting alone is insufficient; there is no
   alternate-base path. On the stable current head SHA, verify that every
   required status check is green and every review lens has a current-head
   clean verdict postdating the re-validation boundary on an accepted channel
   per the PR Merge Policy. Also verify that every inline thread is resolved,
   but do not treat the absence of unresolved inline threads as sufficient
   evidence that a review lens completed cleanly. Also confirm the
   `dependency-review` and `codecov/patch` results on that applied head. Treat a
   red dependency-review result or a coverage regression as blocking for merge
   even though branch protection does not mechanically stop it. Branch
   protection blocks merge on the required checks. The advisory review lenses
   are operator-enforced. Conversation resolution gates inline findings only;
   it does not substitute for a clean verdict in a top-level comment.
4. A stale-notice head that received a push is equally un-revalidated and
   follows these same steps if it is ever merged. Because the terminal stale
   notice has no `Applied-Commit:` line, recover the applied SHA from the head
   branch's latest commit carrying the matching `Owner-Task-Comment: <id>`
   trailer. Find it with `git log` or `git show` after fetching the head branch,
   or use the GitHub commits API. Then apply the same current-head re-validation
   procedure.
5. Confirm the re-trigger mechanism's live behaviour during the supervised 9h
   session, per this runbook's fill-from-observed rule. The item-3 checklist is
   load-bearing either way.
6. After all required checks, operator-verified gates, and review lenses have
   completed, immediately re-read `headRefOid` and `baseRefName` with
   `gh pr view <n> --json headRefOid,baseRefName` before declaring
   re-validation complete. Declare completion only when `headRefOid` matches
   the head on which that evidence ran and `baseRefName` still byte-equals the
   repository default branch. If the head differs, it drifted during the wait;
   restart from step 1 on the new head. If the base differs, it was retargeted
   during the wait; retarget it back to the default branch, then restart from
   step 1 and close and reopen the PR as that procedure requires.

The following ordered items are the fail-safe activation path and are **not**
authorized by this dark wiring:

1. Before any enabling action, verify through the GitHub API that
   `vars.FACTORY_PAUSED` is exactly the literal `true` (not absent or `false`):
   `gh api repos/syamaner/roastpilot-cloud/actions/variables/FACTORY_PAUSED --jq '.value'`
   must print exactly `true`. Read the persisted command-enable state with
   `gh api repos/syamaner/roastpilot-cloud/actions/variables/OWNER_COMMAND_INTAKE_ENABLED --jq '.value'`
   and the persisted task-enable state with
   `gh api repos/syamaner/roastpilot-cloud/actions/variables/OWNER_TASK_APPLY_ENABLED --jq '.value'`.
   As a mandatory part of this item-1 preflight, complete the queued-run sweep
   and required cancellation procedure in §2 before any enable-variable write
   in item 3 or item 5. [#232](https://github.com/syamaner/roastpilot-cloud/issues/232)
   requires this ordering because an `owner-command-intake.yml` run queued
   before the pause can retain snapshotted stale gates and later reach the
   write-capable `task-apply` path. Do not proceed to either write until every
   enumerated run is classified and every applicable queued or in-progress run
   is cancelled and verified terminal per §2. In this activation context the
   pause flag was set earlier, so run §2's enumerate-and-cancel mechanics
   verbatim against the already-paused state.
   Normalize each successful enable-variable read to lowercase before comparing
   it, matching the workflow gates' case-insensitive string semantics. For
   either variable, a confirmed absent-variable `404`, or a successful response
   whose normalized value is not `true`, establishes that it is not already
   enabled; any other read failure stops activation. If
   `OWNER_COMMAND_INTAKE_ENABLED` normalizes to `true`, the answer-agent
   preconditions in item 2 are already required and must be confirmed complete
   before proceeding. If `OWNER_TASK_APPLY_ENABLED` normalizes to `true`, the
   task-specific preconditions in item 4 are already required and must be
   completed before item 3. The comparison polarity is deliberately different:
   `FACTORY_PAUSED` must be the exact literal `true`, so any deviation halts the
   must-be-paused check, while enable values are normalized so every enabled
   case variant is caught by the must-not-already-be-enabled checks. The
   symmetric command-state read is defense in depth: the `FACTORY_PAUSED`
   master gate prevents a drifted variable from firing a job while paused, and
   the answer-agent is read-only, so this closes a same-capability disposition
   skip rather than a cross-capability escalation. This ordering prevents
   persisted state from bypassing either activation sequence. The item-1
   snapshot is not sufficient on its own: a variable can change between this
   initial read and an enable-variable write. Immediately before each write in
   items 3 and 5, repeat the exact-literal `FACTORY_PAUSED` check and both
   case-normalized enable-variable reads, applying all the same rules above; if
   the sibling enable variable now normalizes to `true`, its preconditions are
   already required and must be complete before the write proceeds. This
   immediate re-read narrows the time-of-check/time-of-use window as
   operator-procedure defense in depth; it is not a mechanical guarantee
   against a truly concurrent actor. The load-bearing `FACTORY_PAUSED` master
   gate keeps every job unschedulable while paused regardless of enable-variable
   drift.
2. Before enabling question answering, complete the answer-agent activation
   preconditions in [Owner command intake (9e)](#owner-command-intake-9e). The
   answer-agent's `CLAUDE_CODE_OAUTH_TOKEN` credential class was
   operator-ratified under its own D140 platform disposition on 11 Aug 2026.
3. Only after the answer-agent preconditions—and, when item 1 found
   `OWNER_TASK_APPLY_ENABLED` already `true`, after all task-specific
   preconditions in item 4—set `vars.OWNER_COMMAND_INTAKE_ENABLED` to `true`,
   when it is not already enabled, as the last deliberate enabling action for
   question answering. Immediately before the write, perform the item-1
   re-check of `FACTORY_PAUSED` and both enable variables; if
   `OWNER_TASK_APPLY_ENABLED` now normalizes to `true`, complete item 4 before
   proceeding. Then run:
   `gh variable set OWNER_COMMAND_INTAKE_ENABLED --body true --repo syamaner/roastpilot-cloud`.
   This creates the variable after a confirmed `404`, or updates an existing
   variable whose normalized value is not `true`. If item 1 or the immediate
   re-check finds it already enabled, no write is required; proceed only after
   confirming the same prerequisites rather than treating persisted state as
   satisfying them.
4. Before enabling task mutation, additionally resolve the remaining hard 9h
   task precondition: [#237](https://github.com/syamaner/roastpilot-cloud/issues/237);
   [#245](https://github.com/syamaner/roastpilot-cloud/issues/245) is resolved,
   with the default branch configured with nine required status contexts as of
   11 Aug 2026. Because that protection is mutable and the `task-apply` path
   checks only the target-branch identity, confirming that the #245
   branch-protection contract still holds remains a fail-closed precondition of
   enabling task mutation; its deterministic live re-verification is tracked in
   [#254](https://github.com/syamaner/roastpilot-cloud/issues/254). #237
   must verify that neither `CLAUDE_CODE_OAUTH_TOKEN` nor the built-in
   `GITHUB_TOKEN` is reachable by the task-agent model's process through either
   its process environment or `.git/config`, or must structurally isolate the
   credential from the reader. [#238](https://github.com/syamaner/roastpilot-cloud/issues/238)
   is resolved by the documented
   [manual re-validation procedure](#applied-head-roster-re-validation-238-decided-path)
   plus the honest finalize signal. Branch protection mechanically blocks merge
   until the applied head's required status checks (CI, CodeQL, and mutation)
   pass. A built-in `GITHUB_TOKEN` push runs none of them on that head, so they
   cannot be green until the roster is re-triggered on it.
   The advisory review lenses (Claude Code Review and Codex) are not required
   status checks and are not mechanically enforced. The operator runs the
   documented procedure and explicitly verifies a current-head clean verdict
   for each lens on an accepted channel per the PR Merge Policy; conversation
   resolution alone is insufficient. The first live execution is observed
   during the supervised 9h session. Ratify the task-agent's
   `CLAUDE_CODE_OAUTH_TOKEN` credential class under its own D140 platform
   disposition; this new external-identity credential job class cannot inherit
   the answer-agent's disposition by analogy. The `task-apply` job's own D140
   platform disposition for its built-in `GITHUB_TOKEN` scope was
   operator-ratified on 11 Aug 2026: `contents: write` and
   `pull-requests: write`, covering pushes to non-default PR branches and PR
   comments. The base-owned enable
   variables hold this credential-reachable job dark but do not replace its
   per-job disposition; that disposition is distinct from #237, #238, and the
   task-agent OAuth disposition. The fresh disposition was required because
   `task-apply` introduces the novel `contents: write` push scope, performing
   `commit-tree` and the lease-qualified push with a materially larger blast
   radius than comment posting. The `publish` job's `pull-requests: write`
   single-comment scope remains covered by the pre-existing built-in-token
   disposition established in the 9e path and is not separately
   re-dispositioned here.
5. Only after the task-specific preconditions, set
   `vars.OWNER_TASK_APPLY_ENABLED` to `true`, when it is not already enabled,
   as the last deliberate enabling action for task mutation. Immediately before
   the write, perform the item-1 re-check of `FACTORY_PAUSED` and both enable
   variables; if `OWNER_COMMAND_INTAKE_ENABLED` now normalizes to `true`, its
   item-2 preconditions must be complete before proceeding. Then run:
   `gh variable set OWNER_TASK_APPLY_ENABLED --body true --repo syamaner/roastpilot-cloud`.
   This creates the variable after a confirmed `404`, or updates an existing
   variable whose normalized value is not `true`. If item 1 or the immediate
   re-check finds it already enabled, no write is required because item 4 was
   already mandatory. The task jobs require both
   `OWNER_COMMAND_INTAKE_ENABLED` and `OWNER_TASK_APPLY_ENABLED`.

Unpausing `FACTORY_PAUSED` remains a separate operator decision; setting an
enable variable to `true` does not authorize unpausing.

Known availability limitation [#239](https://github.com/syamaner/roastpilot-cloud/issues/239):
a `task` comment edited to `question` after intake produces no stale or
superseded notice only when the edit is observed in the pre-decision
prepare/decide window; `prepare` re-derives the verb, stops the run, and the
later decide/apply/finalize phases are skipped. An edit after the apply
decision—including after the push—but before `finalize` is caught by its source
re-check, which posts the stale-source notice. The earlier notice gap belongs in
the merged entrypoint's prepare phase. Because comment edits do not retrigger
the workflow, recovery requires a fresh comment using the intended current verb:
`@claude question` if an answer is now wanted, or `@claude task` if a patch is
still wanted.
