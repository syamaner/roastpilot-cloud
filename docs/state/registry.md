# roastpilot-cloud — State Registry

Pointer doc, not a narrative. Read this, then the active epic in the plan
repo, then the GitHub issue, before starting any story.

## Active epic

**F1 Factory** (conventional build, per D98 — the factory itself is built by
hand before any issue is triaged/implemented automatically). C1 Scaffold is
complete.

Plan: `roastpilot-plan/roastpilot-cloud/plan.md` §11 (epic table);
factory pipeline/security model/label taxonomy: `factory.md`.

## C1 story status — complete

| Story | Issue | Status |
|---|---|---|
| C1-S1 Next.js scaffold + CI gates | [#1](https://github.com/syamaner/roastpilot-cloud/issues/1) | Done — merged via #15 |
| C1-S2 Snowflake account, `ROASTPILOT_DEV`, schemachange bootstrap, resource monitor | [#2](https://github.com/syamaner/roastpilot-cloud/issues/2) | Done — merged via #17 |
| C1-S3 Vercel project + preview deploys | [#3](https://github.com/syamaner/roastpilot-cloud/issues/3) | Done — operator-configured (Vercel dashboard, GitHub integration; no code, no PR) |
| C1-S4 AGENTS.md, state docs, sub-agents, branch protection | [#4](https://github.com/syamaner/roastpilot-cloud/issues/4) | Done — merged via #16 |

## F1 story status

Order (operator): S5 → S10 → S8 → S9 → S7 (operator actions remain) → **S6 (in progress)** → S11 → C2 draft.

| Story | Issue | Status |
|---|---|---|
| F1-S1 Labels, issue templates, milestones, story issues for C1/F1 | — (no issue; done at prep, 16 Jul 2026) | Done |
| F1-S2 `triage-issues.yml` + triage skill (seed/triage/apply, JSON contract, concurrency) | [#5](https://github.com/syamaner/roastpilot-cloud/issues/5) | Done — merged via #19 (5 review rounds + a `workflow_dispatch` probe, #20, that empirically settled the verdict-write permission rule — `Edit(path)`, not `Write(path)`, no pre-touch needed). A live dry-run against a real issue is the operator's next step. |
| F1-S3 `implement-ready-issues.yml` (read-only agent + privileged publisher, dispatch-first) | [#6](https://github.com/syamaner/roastpilot-cloud/issues/6) | Done — merged via #24. Since extended by F1-S4 (publisher-identity switch), F1-S9/#40 fix-forwards, and F1-S10 (#50/#53/#55). |
| F1-S4 Review workflow port + repo `AGENTS.md` review rubric section | [#7](https://github.com/syamaner/roastpilot-cloud/issues/7) | Done — merged via #35–#40, #46/#49 fix-forward |
| F1-S5 `to-issues` skill + dry-run decomposition of C2 (PM-reviewed) | [#8](https://github.com/syamaner/roastpilot-cloud/issues/8) | **Done.** #8 is closed and its project item is Done; C2 delivery remains a separate kickoff activity.<br>Merged: [#48](https://github.com/syamaner/roastpilot-cloud/pull/48). |
| F1-S6 End-to-end dry run + runbook + metrics baseline | [#9](https://github.com/syamaner/roastpilot-cloud/issues/9) | **In progress.** Operator confirmation given 27 Jul 2026; the eight-slice D136 plan is the active backlog item. **Slice 9a is done** ([#58](https://github.com/syamaner/roastpilot-cloud/issues/58), merged via [#150](https://github.com/syamaner/roastpilot-cloud/pull/150)): the `umask`/`mktemp` ordering fix and a closed unquoted-identifier guard on the two values `assert_dev_ci_grants.py` interpolates into `SHOW` statements. Slices 9b-9h remain. The activation boundary still holds: no slice that unpauses the factory or executes a credentialed factory job proceeds without separate operator confirmation, and each new credential-reachable job needs an operator-ratified platform disposition. `FACTORY_PAUSED` remains exactly `true`.<br>Decisions: [D136, D140](https://github.com/syamaner/roastpilot-plan/blob/main/roastpilot-cloud/factory.md). |
| F1-S7 Pipeline supply-chain + self-modification hardening | [#10](https://github.com/syamaner/roastpilot-cloud/issues/10) | **In progress.** [#120](https://github.com/syamaner/roastpilot-cloud/issues/120) is closed/Done: analyzers freeze at 120d-1b2a as evidence-only drift detection; reusable-workflow jobs and job container/service forms reject; 120d-1b3 stays cut; and 120d-2 is held from implementation or further design. The accepted residual is conditional on exact `FACTORY_PAUSED=true`. Operator work remains to disable Actions PR approvals before enabling required CODEOWNERS review and to restore `codecov/patch` as required. [#151](https://github.com/syamaner/roastpilot-cloud/issues/151) is open: the `dev-snowflake-contract` summary step splices repository variables into a `run:` body, found by the pre-open adversarial review of #150 and deliberately not folded into that slice.<br>**[#47](https://github.com/syamaner/roastpilot-cloud/issues/47) decided, 1 Aug 2026: Option B on both its sub-decisions** (`claude-review` and `spec-grounded-review` allowlisting) — the factory bot stays un-allowlisted on both jobs; the issue stays open as the pending enable decision, not resolved. That review surfaced **[#192](https://github.com/syamaner/roastpilot-cloud/issues/192)** (open, `ready-for-conventional-implementation`): `claude-review`'s live tool grant exceeds its own documented residual (tag-mode `Set`-union of tools, missing `ENV_SCRUB`). Its Unit-0 probe workflow is built in draft [PR #193](https://github.com/syamaner/roastpilot-cloud/pull/193), on hold pending a CI-counter fold + an unanswered sub-question found by `factory-security-reviewer`. That same review also surfaced a P0, **[#194](https://github.com/syamaner/roastpilot-cloud/issues/194)** (open by design): `claude-review`'s comment-injection TOCTOU filter is a no-op for `pull_request` events, live on every PR today. Fast-tracked and merged same day as [PR #195](https://github.com/syamaner/roastpilot-cloud/pull/195) (squash `96b64df6`) — a partial, deliberately non-closing fix (`include_comments_by_actor`); real closure needs #192's tool-grant work, which is why #194 stays open (verified via GitHub's `closingIssuesReferences` API, not just PR wording).<br>Merged: [#100](https://github.com/syamaner/roastpilot-cloud/pull/100), [#101](https://github.com/syamaner/roastpilot-cloud/pull/101), [#113](https://github.com/syamaner/roastpilot-cloud/pull/113), [#117](https://github.com/syamaner/roastpilot-cloud/pull/117), [#118](https://github.com/syamaner/roastpilot-cloud/pull/118), [#119](https://github.com/syamaner/roastpilot-cloud/pull/119), [#122](https://github.com/syamaner/roastpilot-cloud/pull/122), [#130](https://github.com/syamaner/roastpilot-cloud/pull/130), [#131](https://github.com/syamaner/roastpilot-cloud/pull/131), [#133](https://github.com/syamaner/roastpilot-cloud/pull/133), [#134](https://github.com/syamaner/roastpilot-cloud/pull/134), [#135](https://github.com/syamaner/roastpilot-cloud/pull/135), [#136](https://github.com/syamaner/roastpilot-cloud/pull/136), [#137](https://github.com/syamaner/roastpilot-cloud/pull/137), [#138](https://github.com/syamaner/roastpilot-cloud/pull/138), [#140](https://github.com/syamaner/roastpilot-cloud/pull/140), [#141](https://github.com/syamaner/roastpilot-cloud/pull/141), [#143](https://github.com/syamaner/roastpilot-cloud/pull/143), [#144](https://github.com/syamaner/roastpilot-cloud/pull/144), [#145](https://github.com/syamaner/roastpilot-cloud/pull/145), [#195](https://github.com/syamaner/roastpilot-cloud/pull/195). Decisions: [D100, D108-D140](https://github.com/syamaner/roastpilot-plan/blob/main/roastpilot-cloud/factory.md). |
| F1-S8 DEV-Snowflake-secret CI isolation (human-gated Environment) | [#11](https://github.com/syamaner/roastpilot-cloud/issues/11) | **Blocked.** Implementation is merged; the first supervised DEV `workflow_dispatch` is pending operator action in F1-S6.<br>Merged: [#57](https://github.com/syamaner/roastpilot-cloud/pull/57). Decisions: [D136](https://github.com/syamaner/roastpilot-plan/blob/main/roastpilot-cloud/factory.md). |
| F1-S9 Anti-gaming quality gates (mutation testing + test-edit rule) | [#12](https://github.com/syamaner/roastpilot-cloud/issues/12) | Done — mutation testing (#68), the anti-gaming diff classifier (#64), and the spec-grounded review pipeline (read-only agent #74/#82/#83/#86/#87, privileged publish wiring #91) all merged. Reconciliation/revalidation completeness (#88/#89/#90) is complete, including complete reviewed-closing provenance, all-paths reference checks, generation-safe delete ownership, current-applicable reporting, and resolution-aware fallback exclusion. Publish is wired but NOT yet enabled for factory PRs; #47 remains the enable/security story and is no longer blocked on this completeness axis. |
| F1-S10 Factory operational safety (kill-switch, idempotency guards, provenance trailer) | [#13](https://github.com/syamaner/roastpilot-cloud/issues/13) | Done — 3 slices: kill-switch + runbook merged via #50; 429/Retry-After idempotency backoff merged via #53, with D114/#54 completing the bounded primary-reset and headerless-429 response contract; full provenance trailer (model ID, prompt/skill version, `Co-Authored-By`/`Signed-off-by`) merged via [#55](https://github.com/syamaner/roastpilot-cloud/pull/55). D116/#51 completes deterministic pause/disabled-window triage backfill with exact-generation authorization across its seven thin slices. Aggregate cost caps (factory.md §13 point 7) are **N/A by billing model, not a pending operator task** (D102, 18 Jul 2026 — no metered Anthropic/Actions spend to cap; see `docs/factory-runbook.md`). |
| F1-S11 Factory regression-eval harness | [#14](https://github.com/syamaner/roastpilot-cloud/issues/14) | **Not started.** The eight-slice D136 plan follows the observed F1-S6 baseline; under D140, every new credential-reachable evaluation job requires an operator-ratified platform disposition and either exact `FACTORY_PAUSED=true` semantics or the separate fail-closed evaluation pause selected by 14a before activation.<br>Decisions: [D136, D140](https://github.com/syamaner/roastpilot-plan/blob/main/roastpilot-cloud/factory.md). |

This registry is authoritative for current delivery status. Verify GitHub
issue, project, label, and PR fields against it before and after each
transition, and reconcile any discrepancy under D135.

## Epic order

C1 Scaffold → F1 Factory → C2 Schema → C3 Sync → C4 Public page → C5 Reviews
→ C6 References → C7 Ops → C8 Analysis (optional).

C2–C8 story issues are not pre-created; decomposition (`to-issues`, F1-S5) is
itself factory work, PM-reviewed per-epic at kickoff.

## Build process

- **C1 and F1**: conventional — an interactive agent or human, one PR per
  planned review unit, same as the agent repo's operating model.
- **C2 onward**: factory-first (`factory.md`) — issue-driven agent pipeline
  (triage → implement → review); a human specs, clarifies, and always merges.

Full pipeline, security model, and label taxonomy:
`roastpilot-plan/roastpilot-cloud/factory.md`.

## Working rules

1. Read `roastpilot-plan/roastpilot-cloud/plan.md` (the relevant epic
   section) before starting.
2. Read this registry for current story status.
3. Read the GitHub issue and any comments; confirm acceptance criteria.
4. Branch: `feature/{issue-number}-{slug}`.
5. One PR per planned review unit. The PR that completes a story updates this
   table in the same PR — file state and GitHub state must never drift.
6. Full rules, stack conventions, PR hygiene, and the review rubric:
   [`AGENTS.md`](../../AGENTS.md).

## Protected branches (never delete)

These carry commits that exist nowhere else. Both were swept from the remote
by mistake on 27 Jul 2026 and restored from a local clone the same day,
verified sha-for-sha. The reason they were protected had only ever been
recorded in session context, which is why the sweep looked routine. It is
recorded here instead.

| Branch | Head | Why protected |
|---|---|---|
| `feature/12-spec-grounded-publish-90-1-base-sha` | `4b089ed` | [PR #92](https://github.com/syamaner/roastpilot-cloud/pull/92) was **closed, not merged**; carries 1 commit not in `main`. |
| `feature/12-spec-grounded-publish-90-5-kind-aware-revalidation` | `a7d278d` | Never had a PR at all; carries 1 commit not in `main`. |

Neither may be deleted until someone confirms its content is genuinely
superseded and records that confirmation here.

**Before deleting any remote branch**, treat it as a manual, careful operator
action. There is deliberately no script and no copy-pasteable recipe here, and
that is the conclusion of PR #156 rather than an omission.

Two attempts were made to make this safe and repeatable. The first was an
executable check; it took twelve rounds of adversarial review, found real
defects at a steady rate, never converged, and failed the one live case it was
used on — asked about a squash-merged branch it reported 30 unique commits and
refused, because squash-merging breaks ancestry. The second was a documented
shell procedure replacing it; adversarial review found three issues, then
seven, then nine, several of them re-treads of hazards the script had already
fixed. Removing the script had not removed the hazards, because they live in
git rather than in the tool, and a copy-pasteable recipe is executed as
literally as a script while being reviewed less.

The hazards are real and worth knowing before you delete anything:

- **A squash-merged branch's commits are not reachable from `main`**, so a
  reachability count calls them unique. GitHub's merge state is the signal —
  but a merged branch can be reused, and the historical PR still reports
  `MERGED` while the new commits exist nowhere else.
- **The evidence you gather describes the FETCH repository; the delete acts on
  the PUSH one.** Divergent or multiple push URLs, `receivepack`/`uploadpack`
  overrides, `core.sshCommand`, `GIT_SSH_COMMAND`, and `ext::` helpers can each
  make those two different repositories.
- **Several repository states silently falsify the count**: graft files,
  `refs/replace/*` entries, shallow boundaries, and symbolic refs on either the
  remote or the local side. An alias to `main` reports zero unique commits, and
  deleting it takes main's target with it.
- **Nothing binds your check to your delete** unless you lease it, and a branch
  name or commit subject is untrusted input to whatever terminal you read the
  evidence in.

Each of those has a worked reproduction in **PR #156's review history**. Read
it before deleting anything you are not certain about, and prefer asking to
guessing — the two branches above were deleted by mistake exactly once, by a
sweep that looked routine.
