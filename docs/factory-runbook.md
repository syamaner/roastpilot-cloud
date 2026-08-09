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
  capability-bearing invocable tool is the scoped `Edit`. Whether to deny and
  runtime-verify `ToolSearch` with a step-C-style catalog assertion (the #212
  class) is a hardening decision for the 9h D140 credential-class ratification,
  not an action enabled by this dark wiring. The untrusted DATA arrives through
  `--append-system-prompt-file`.
- `publish` has `pull-requests: write` as its only write permission. It
  independently re-fetches the source records and re-derives authorization,
  enforces the `binding.json` snapshot, and posts exactly one response or the
  fixed stale-snapshot notice when the source has drifted.

The workflow is inert until both base-owned gates hold:
`vars.OWNER_COMMAND_INTAKE_ENABLED == 'true'` and
`vars.FACTORY_PAUSED != 'true'`. The enable variable is deliberately absent
during this dark launch.

The following three ordered items are the separate operator-ratification hard
stop at 9h and are **not** authorized by this wiring:

1. Before any enabling action, verify through the GitHub API that
   `vars.FACTORY_PAUSED` is exactly the literal `true` (not absent or `false`):
   `gh api repos/syamaner/roastpilot-cloud/actions/variables/FACTORY_PAUSED --jq '.value'`
   must print exactly `true`.
2. Ratify the answer-agent's `CLAUDE_CODE_OAUTH_TOKEN` under its own D140
   platform disposition. This is a new external-identity credential job class;
   it cannot inherit D140 by analogy and is not the built-in-token equivalence.
3. Only after both preceding items, create
   `vars.OWNER_COMMAND_INTAKE_ENABLED` as the last deliberate enabling action.

Unpausing `FACTORY_PAUSED`, if and when the broader factory is unpaused, remains
a separate operator decision; creating the enable variable does not authorize
that transition.

Unlike the 9d advisory workflow, this workflow declares no
`workflow_dispatch`; it is triggered only by a newly created `issue_comment`.
There is no manual recovery dispatch, so the owner's recovery path is to
re-issue the command.

For a `question`, publish enforces the `binding.json` snapshot: head, base,
title, body, question-payload, or truncation-state drift after intake produces
the fixed notice that the command or pull request changed after the run started
and asks the owner to re-issue the command instead of posting a stale answer. A
truncated question or diff carries a deterministic truncation disclosure. Verb
edits are directional: a task→question edit produces the stale notice, while a
question→task edit produces the fixed task acknowledgement; task commands do
not enforce the snapshot binding.
