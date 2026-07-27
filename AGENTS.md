# AGENTS.md — roastpilot-cloud

Project rules for coding agents (factory or interactive) working in this
repository. Source of truth for anything beyond this file: the plan repo,
`~/git/roastpilot-plan/roastpilot-cloud/`
([`plan.md`](https://github.com/syamaner/roastpilot-plan/blob/main/roastpilot-cloud/plan.md),
[`factory.md`](https://github.com/syamaner/roastpilot-plan/blob/main/roastpilot-cloud/factory.md)).
If this file and the plan repo disagree, the plan repo wins — file a
correction, don't silently follow the stale copy.

## Architecture Invariants

These hold for every change, in every epic. A PR that weakens one is wrong by
definition, and any diff touching one routes to a domain reviewer (see the
rubric below) before it opens.

- **No grants to `PUBLIC`, anywhere.** Every Snowflake privilege is scoped to
  `ROASTPILOT_AGENT` or `PUBLIC_WEB`; a migration that grants to `PUBLIC` is a
  blocker regardless of what it grants.
- **`PUBLIC_WEB`'s surface stays exactly two secure views (roast-by-slug,
  reviews-by-roast) plus the right to call `SUBMIT_REVIEW`.** That right is
  granted as `USAGE ON PROCEDURE` (Snowflake's actual call privilege —
  `EXECUTE` is not a procedure object-privilege), together with the
  prerequisite `USAGE` on the containing database/schema and the shared
  warehouse. Nothing beyond that, ever — a compromised web app must not be
  able to read a base table or call another proc.
- **Secure views embed `visibility <> 'private'`.** The filter lives in the
  view definition, not in application code that might forget to add a
  `WHERE` clause.
- **Snowflake enforces only `NOT NULL`.** Primary/unique/foreign keys and
  `CHECK` constraints are declared for documentation but not enforced. Every
  range/enum rule (ratings 1–5, sliders 0–100, visibility values) must exist
  in **both** the Zod schema (Vercel route) and the Pydantic model (agent
  connector), and the two must reject the same malformed payloads
  (contract-tested — see Testing below). Idempotency is `MERGE ... ON
  idempotency_key`, never a unique constraint.
- **Deletion is a procedural cascade.** `delete_roast` explicitly removes
  reviews, telemetry, artifact rows, and stage files — there is no `ON DELETE
  CASCADE` to lean on.
- **IP addresses are stored hashed, never raw, and purged at ≥30 days.** No
  other reviewer PII beyond an optional free-text name.
- **Temperatures are Celsius everywhere** — schema, API, UI, tests. No
  Fahrenheit value or conversion, ever.
- **The public taster surface (`/r/[slug]`) stays anonymous.** No login, no
  session, no account concept anywhere in that path.

## Stack Rules

- TypeScript strict (`tsconfig.json` `strict: true`) — no `any` escape
  hatches without a comment justifying why.
- **Zod validation on every route input.** A route handler that trusts an
  unvalidated body or query param is a review blocker.
- Vitest for unit and contract tests; Playwright for e2e against Vercel
  preview deploys.
- schemachange (pinned in `snowflake/requirements.txt`) for all Snowflake
  DDL — no ad hoc `ALTER` run by hand outside a migration.
- Next.js App Router; the public roast page is a server component with ISR,
  not client-fetched.
- Node/npm; lockfile (`package-lock.json`) always committed alongside a
  dependency change.

## Quick Commands

```bash
npm install
npm run dev          # local dev server
npm run lint         # eslint
npm run typecheck    # tsc --noEmit
npm run test          # vitest run (npm run test -- --coverage to match CI — the `--` is required, `npm run test --coverage` silently drops the flag)
npm run test:e2e     # playwright (requires: npx playwright install chromium)
npm run build
```

Snowflake migrations (`snowflake/`, Python tool, never added to
`package.json`/`npm ci` — see `snowflake/README.md` for the full connection
story):

```bash
cd snowflake
python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt
python3 validate_migrations.py          # offline: filename + Jinja-render check, no connection — this is what CI runs
python3 with_connection_env.py schemachange deploy --schemachange-create-change-history-table   # NOT bare `schemachange` — with_connection_env.py bridges the `snow` CLI's config.toml into the SNOWFLAKE_* env vars schemachange reads; applies to SNOWFLAKE_DATABASE (default ROASTPILOT_DEV)
```

CI does not connect to Snowflake yet (offline render/lint only); a
live-connecting contract check against `ROASTPILOT_DEV` with a CI-scoped key
is human-gated behind a required-reviewer Environment (factory.md §8,
F1-S8) — don't add a live Snowflake step to CI without that gate.

## Repository Layout

```text
roastpilot-cloud/
├── app/
│   ├── r/[slug]/page.tsx                 # public roast page (SSR + ISR)
│   ├── r/[slug]/opengraph-image.tsx      # OG preview image
│   └── api/r/[slug]/reviews/route.ts     # POST (public) — the only API route
├── components/                            # ReviewForm, StarRating, RoastCurve, FlavorSliders
├── lib/                                   # sqlapi.ts (SQL API + key-pair JWT), ratelimit.ts, zod schemas
├── snowflake/
│   ├── migrations/                        # schemachange DDL: roles/grants, secure views, procs
│   └── fixtures/                          # contract fixtures (real MCP exports)
├── tests/                                 # Vitest unit + contract tests
├── e2e/                                   # Playwright, against preview deploys
├── streamlit/                             # C8 (optional): operator analysis app
└── docs/state/registry.md                 # active epic / story pointer
```

Plan reference for the full data model and sync contract: plan.md §4–§9.

## Testing

Contract tests are the load-bearing suite for the invariants above: Zod and
Pydantic reject the same malformed payloads, `MERGE` replay returns the same
`{cloud_roast_id, public_slug}`, `PUBLIC_WEB` cannot read a private row or a
base table, and `data_quality_violations` stays empty. See plan.md §10 for
the full suite table — a PR touching schema or validation should be able to
point at which row of that table proves it.

## Factory Context

C1 (this repo's scaffold) and F1 (the factory itself) are built
conventionally — an interactive agent, this file, a human at the keyboard.
**C2 onward is factory-first** (`factory.md`): issues are triaged and
implemented by agents on GitHub Actions, and this `AGENTS.md` is what the
implementing agent reads for stack rules, gates, and review routing, the same
way any Claude Code session would. **Merging is always human** — the factory
ends at "PR open, CI green, reviews in"; nothing in this repo auto-merges
(factory.md §2, §9).

**Decomposition (`to-issues`, F1-S5) runs at each epic's kickoff, never
bulk-up-front.** C2's stories don't exist until someone runs the
`to-issues` skill (`.claude/skills/to-issues/`) against C2's plan section,
right before C2 starts — same for C3…C8 in turn. Its output is always a
**PM-reviewed draft**: the skill writes no file and files no GitHub issue
itself; a human (the PM) reads the drafted batch, edits it if needed, and
files each story by hand (or runs it back through `triage` first). Treat a
`to-issues` draft the same way you'd treat any other unreviewed proposal —
it is not itself an authorization to build anything, and no story it drafts
is `ready-to-implement` until a human or the `triage` skill says so against
the issue as actually filed.

**Plan-small readiness bar (D104, revised by D119).** A story earns
`ready-to-implement` only
with an explicit **PR plan**: one or more ordered coherent review units,
normally targeting about 400 changed **logic** lines each (tests are excluded
from the estimate), dependencies/order named, and the **domain reviewer** each
diff triggers tagged (rubric below). A materially larger unit must explain why
splitting would reduce reviewability. "Build X" without the ordered, sized,
reviewer-tagged plan bounces back `ready-to-spec` — reviewability is decided at
decomposition, not discovered at review. The plan must also name its execution
path:

- **Factory-dispatchable** means one issue, one publisher commit, and one PR
  today. Until the publisher has an independent pre-publish diff-review stage,
  its technical envelope is exact and fail-closed: at most 400 combined changed
  textual lines across every path category; a captured patch artifact no larger
  than 2 MiB; no binary patch; and no mix of allowlisted inert
  data/fixtures/generated/design-doc output with logic or tests. Allowlisted
  output still counts toward the textual ceiling because path names cannot prove
  runtime inertness. Migrations and operational or unknown documentation are
  logic. The publisher classifies the captured patch encoding and applied
  scratch-index diff before pushing. Route a materially larger, oversized,
  mixed-output, or otherwise pre-open-`qa`-triggering shape to conventional
  execution instead.
- **Conventional/interactive** may plan multiple ordered slice PRs and may use a
  justified materially-larger unit, because the lead can run the required
  independent pre-open review and create separate commits. A triage-complete
  conventional issue receives `ready-for-conventional-implementation`, never
  the factory-authorizing `ready-to-implement` label.

## Rigour Calibration

Security rigor is mandatory; implementation depth is proportional to the live
exposure and failure direction (factory.md D139):

- **Run the direction test.** Distinguish unsafe admission (false negative),
  safe work rejected (false positive), and pure availability loss. Treat a
  failure as availability-only only after proving it cannot skip or bypass an
  authoritative gate. Unknown execution, provenance, credential/identity/
  permission, persisted-state, or data-crossing forms fail closed.
- **Reject what is not used.** Measure the live corpus first. A zero-instance
  execution class stays rejected until the change introducing its first real
  use owns the reviewed contract and adversarial tests.
- **Prefer static constraints.** Use a simpler base-controlled platform or
  structural constraint when it provides the property. Do not build a computed
  policy producer before its enforcing consumer has a ratified contract; if
  there is no consumer, do not build the producer yet. An Environment-only
  named secret is durably withheld when `environment:` is removed, but the
  built-in `GITHUB_TOKEN` is not.
- **Assess both blast-radius axes.** Record data confidentiality, integrity,
  and sensitivity separately from principal scope, lifetime, revocability, and
  capability. Credential-reachable does not make read-only public data
  equivalent to a publisher key or write-capable identity.
- **Stop kickoff structurally.** Record the base/head SHA, deterministic corpus
  query or source paths, observed counts, and cited closed key/form table.
  Decide that boundary once, then stop; revalidate at final head after a rebase
  or relevant surface change.
- **Triage by failure direction, not finding count.** One credible fail-open or
  credential-identity finding outweighs many availability findings. Counts do
  not replace mechanism and consequence analysis.
- **Trip on scope creep.** A new execution class, consumer, credential,
  identity, operator action, or other zero-instance surface stops the slice for
  re-scoping. Adjacent hardening is not folded merely because it is nearby.

For every newly admitted or claimed-compliant path, the floor does not move:
unknowns fail closed; evidence/state is never silently dropped or truncated;
credentials do not cross into unreviewed mutable execution; a human merges;
applicable full gates and domain reviews run; and tests assert real behavior.
Current OAuth, Codecov, and built-in-token paths recorded on #120 are held
residuals, not proof that the live corpus meets that admission floor. D139 does
not authorize, retire, or schedule the separately held 120d-2 decision.

## PR Merge Policy

Full policy: `factory.md` §9, identical to the agent repo's, no factory
exception. The load-bearing points:

- **Green CI is necessary but not sufficient.** Read every review comment
  before claiming mergeable — `gh pr checks` alone is not a merge signal.
- **Every inline review thread must be resolved** (branch protection:
  `required_conversation_resolution`). Fix it, or state in-thread why it's
  not being actioned.
- **Codex is advisory-but-triaged, not a required check.** Codex reviews
  automatically the moment a PR is opened ready-for-review, or the moment a
  draft is marked ready; it does not trigger on opening a draft (confirmed
  against PR #150, 27 Jul 2026, and part of a wider pattern, see D103 below:
  the whole review roster, not just Codex, is suppressed while a PR sits in
  draft and fires together at ready). A manual `@codex review` comment is
  not needed for that first review; it remains the way to re-trigger a
  review on a new head after the automatic one, once, on the final commit,
  never on intermediate pushes. A 👀 reaction means the review is **in
  progress, keep waiting** (bounded ~30 min from the 👀); it does **not**
  clear the merge by itself. A CLEAN verdict, **in either channel, and ONLY
  when authored by the Codex bot identity (`chatgpt-codex-connector[bot]`)**,
  is either a **👍 reaction (after the 👀)** OR a **top-level "Codex Review: Didn't
  find any major issues" comment carrying a `Reviewed commit: <sha>` line** whose
  sha matches the PR head. The repo is public, so anyone can add a 👍 reaction OR
  post a comment copying that title plus the visible head sha; **bot-authorship is
  required on BOTH channels: a reaction or comment content alone is spoofable.**
  A watcher MUST verify the reaction's / comment's author is the Codex bot (the
  reactions API returns each reaction's `user.login`); one polling only reviews +
  reactions is also blind to the comment channel entirely. A **posted
  `pull_request_review` with inline threads** = findings.
  The signal must correspond to the current head AND postdate **the event that
  started the automatic review for this PR's shape**, which is not the same
  event in both cases (Codex P1, #155):
  - a PR **created ready** (every factory-authored PR, #62) emits `opened` and
    NEVER emits `ready_for_review`, so `opened` is its boundary. Requiring a
    `ready_for_review` timestamp here would be unsatisfiable and would block
    every untouched factory PR permanently;
  - a **draft marked ready** emits `ready_for_review`, and that is its
    boundary;
  - after any later push, the boundary becomes the fresh single re-trigger on
    that new final commit.

  Head-match alone is NOT enough, and that is a real hole rather than a
  theoretical one (Codex P1 on the agent repo's copy, #682): a manually
  requested review on the DRAFT posts findings against the very same sha, so
  if nothing needed changing before marking ready, a head-match-only rule
  would let that pre-ready verdict satisfy the wait while the automatic review
  the ready transition just started is still in flight. A comment or review
  naming an earlier commit sha does not satisfy the wait either, and a 👍
  reaction carries no sha, so it is valid only while the head stays unchanged
  since it was left. Do not arm auto-merge on green CI alone.

  **What the draft phase is and is not.** The AUTOMATIC trigger does not fire
  on a draft, so a draft cannot converge the review roster on its own. But a
  manual `@codex review` on a draft is NOT inert (Codex P1, #155; D105): it
  runs and posts findings against the draft head, and those findings are real
  and worth folding. What it cannot do is complete the clean-verdict flow, so
  a draft waiting for a clean signal waits forever. Both facts hold because
  they describe different mechanisms. The once-on-final discipline governs the
  single automatic trigger at ready; only a later push needs a manual
  re-trigger, once, on its new final commit.
- **`pr-triage` adjudicates independently of the author.** Under the factory,
  the author is always an agent; it never self-triages its own PR's review
  comments (D23). The lead (or the `pr-triage` sub-agent) decides what counts
  as resolved.
- **Coverage regressions must be sorted, not waved through** — add the test
  or tag a genuinely unreachable line, never lower a threshold.

## PR Hygiene

- **Thin slices**: target about 400 changed logic lines. This is a planning and
  reviewability guide, not an automatic pass/fail threshold. Slice by coherent
  responsibility, security boundary, dependency order, and reviewer load; do
  not manufacture interfaces or extra PRs merely to hit the target. A
  materially larger diff must record in the story plan and PR body why it is
  more reviewable than the available splits, and must pass applicable domain
  review plus independent pre-open triage. That exception is available only on
  the conventional/interactive path until the factory has an independent
  pre-publish diff-review stage; route a factory candidate that needs it to
  conventional execution. A large unexplained diff is replanned; a justified
  cohesive diff may proceed. `factory.md` §5 uses this target during triage.
  Test files are excluded from the logic estimate, but a test-file diff over
  600 lines (exact threshold), or otherwise load-bearing test quality, requires
  a `qa` reviewer pass pre-open. The factory's stricter combined 400-line
  envelope routes such a candidate to conventional execution before that
  trigger is reached.
  Measure from the branch's merge base with
  `origin/main`: use `git diff --numstat origin/main...HEAD` as the per-file
  inventory, exclude test files and qualifying separately delivered data/
  fixture/generated/doc files, then sum additions plus deletions for the
  remaining logic rows. Do not use the advancing branch tip or net line count.
- **Separate data from logic**: fixtures, snapshots, and generated output go
  in their own PR when independently reviewable. Conventional PRs may keep
  inseparable data in the same PR only as a dedicated commit, never a logic
  commit. Factory-authored work must use a separate issue/PR because its
  publisher creates one commit. Their exclusion from the logic-size estimate
  applies only when separated this way.
- **`Closes #N`** only for the issue a PR fully resolves; `Refs #N` / `Part
  of #N` otherwise, so an unfinished issue isn't auto-closed.
- No post-open lint/format churn — run the gates before opening.

### Shift-left: fold runner-gate findings before the review roster fires (D103)

The build's rework used to be dominated by review findings landing *after* a
PR was marked ready, F1-S8 alone took **5 Codex rounds, ~15 real P1s, all
post-open**, on a security keystone that two Opus `safety-reviewer` passes
called clean. This section originally justified opening as a draft by
iterating with Codex there before marking it ready; that mechanism does not
exist, confirmed against PR #150 (27 Jul 2026): Codex does not review a
draft PR at all, so a draft cannot converge a diverse-lens loop even in
principle. The corrected mechanism, and the reason draft is still the right
phase, is a clean split observed directly on PR #150:

- **Draft.** Only the build/correctness gates run (CI lint/typecheck/unit,
  Playwright, Snowflake migrations offline, CodeQL, dependency review,
  codecov, mutation testing); every review lens (Codex, Claude Code Review,
  spec-grounded review) is suppressed. On PR #150's draft phase,
  `claude-review`, `Spec-grounded review (read-only)`, and `Publish
  spec-grounded review (privileged)` all reported SKIPPED, and Codex did
  not review.
- **Ready.** Marking the PR ready fires the whole review roster on that
  head in one step, not just Codex. On PR #150, marking it ready started a
  new Claude Code Review run, ran spec-grounded review to SUCCESS, started
  the privileged publish step, and made Codex's automatic review due.

So the draft phase is the window to fold runner-only findings without
spending any review lens; mark ready only once the head is expected to
hold, because that transition commits the entire roster to it. PR #150's
own mutation-gate failure is the proof case: the baseline was
environment-dependent (a mutant on `shutil.which("schemachange")` is
behaviourally invisible on the runner, because pip installs the console
script exactly where the code's fallback looks), so five identical local
runs still produced the wrong number and only CI could reveal it; it was
found and fixed on the draft before any review lens had been spent.

The Codex-spend count is a supporting illustration, not the rule: opening
ready immediately would have had Codex review head `07f1802`, then CI
failed the mutation gate, forcing a push to `4d26670` and stranding the
verdict on a dead head, needing a manual re-trigger (2 spends). Opening as
a draft let CI fail first, folded the fix there, and Codex reviewed only
`4d26670` once ready (1 spend). A local `codex review --base main` (Axis A
below) still provides the cross-family lens earliest of all, before the
branch is even pushed; it does not replace the roster's own automatic pass
on the ready PR.

Wait for the verdict per the **Codex-wait rule in the Merge Policy** (its
single source of truth) before treating the PR as reviewed; don't restate
that rule here. **Factory-authored PRs** don't use the draft phase for this
purpose: the read-only implementing agent can't drive an open→ready
transition, so the privileged publisher opens the PR non-draft and the
*same* review roster runs **post-open** by design (the App-identity wiring
exists precisely so CI + Codex + Claude Code Review fire on the opened
PR), with the human merge as the gate the draft→ready step would otherwise
be. Whether the publisher should open factory PRs as drafts and have
`pr-triage` mark them ready post-fold is a factory-design question tracked
separately, not this rule.
- **Fix the CLASS, sweep the repo — pre-open.** When a finding is one instance
  of a class (a sanitizer that misses one escape, one un-byte-compared
  identifier, one un-audited grant target), fix the class in one place and
  `grep` the whole repo for siblings before pushing. Per-symptom patching is the
  round-2..N rework engine — one categorical fix collapses the round trip.
- **Snowflake grant-boundary checklist** — run on any diff touching grants,
  roles, or `snowflake/migrations/**`; it folds the recurring F1-S8 class up
  front instead of rediscovering it per PR:
  - no `GRANT ... TO PUBLIC`, and PUBLIC is **audited**, not assumed clean (its
    audit's completeness limit under a minimal role is documented, #59);
  - `USE SECONDARY ROLES NONE` is a **statement**, not a session parameter;
  - the CI user's `DEFAULT_SECONDARY_ROLES` is **verified** empty by the assert
    script, not assumed from a one-off manual `ALTER`;
  - **future** grants (`SHOW FUTURE GRANTS TO ROLE`) are audited, not only
    current grants;
  - identifier matches are **exact byte compares** (quoted identifiers preserve
    case + whitespace; unquoted fold to uppercase).

## Code Review Rubric

The review roster (Claude Code Review + Codex, advisory-but-triaged, plus any
human reviewer) reviews against this rubric. Inline comments are
merge-blocking (branch protection requires every thread resolved) — reserve
inline for genuine must-fix/should-fix, each tagged **blocker** / **medium**
/ **low**. Nits, praise, and questions go in the summary comment, never
inline.

**Must-block (the Architecture Invariants above):**

- a grant to `PUBLIC`, anywhere;
- `PUBLIC_WEB` gaining access to anything beyond the two secure views + one
  proc;
- a secure view missing the `visibility <> 'private'` filter;
- a range/enum rule present in Zod or Pydantic but not both, or a mismatch
  between them;
- a deletion path that doesn't cascade stage files as well as rows;
- an unhashed or unpurged IP address;
- any Fahrenheit value or conversion;
- a login/session/account concept reachable from `/r/[slug]`.

**Review routing:**

- Any diff touching `snowflake/migrations/**`, grants, secure views, or
  Zod/Pydantic validation rules → **`schema-migration-reviewer`**.
- Any diff touching routes, components, stored procs, or anything handling
  reviewer data, IP addresses, visibility, or deletion → **`privacy-auditor`**.
- Any diff touching the factory's own pipeline — anything under `.github/**`
  (workflows AND composite actions), `scripts/factory/**`, any privileged glue /
  publisher script wherever it lives, CODEOWNERS, or branch-protection config →
  **`factory-security-reviewer`**. (This must cover the full protected surface the
  pipeline-self-modification invariant below names, not just workflows.)
  This is an adversarial red-team: its job is to produce a working exploit, not
  to assess. The F1-S3 implement workflow shipped an EXPLOITABLE pipeline-guard
  that only this lens caught, so a factory-pipeline diff without this pass is not
  ready to merge.
- Any test-file diff over 600 lines, or a change whose acceptance criteria make
  test quality unusually load-bearing → **`qa`**. It verifies behavioral
  assertions, negative cases, acceptance-criterion coverage, and coverage
  quality rather than relying on a line percentage. This pass is pre-open, so
  factory candidates that trigger it route to conventional execution until the
  publisher gains an independent pre-publish review stage.

**Also verify**: tests assert real behavior, not a smoke check; new code is
covered or carries a documented reason for an uncovered line.

**Fix the CLASS, not the instance (review rubric rule, D104 package).** When a
finding is one instance of a class — one un-parameterised query, one route
missing Zod, one grant to the wrong role, one missing object-level authz check,
one unsanitized interpolation — the fix is categorical: fix it once (a shared
helper or pattern) and `grep` the repo for every sibling **before the PR leaves
draft**. A reviewer seeing a per-symptom patch for a class-shaped finding should
say so; N review rounds over one class is the failure mode this rule removes
(the #64 sanitizer/bypass arc and the agent repo's #587 are the proof cases).

**Pipeline self-modification (factory.md §13):** any **factory
implementing-agent patch** — a manually-dispatched stage-1 run or an
F1-stage-2 chained `ready-to-implement` run alike, i.e. anything the
privileged publisher pushes on an agent's behalf — must never touch
`.github/**`, CODEOWNERS, branch-protection config, **the privileged
glue/publisher scripts**, any recognized agent instruction/configuration
basename at any depth (`AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`,
`CLAUDE.local.md`, `.claudeignore`, `.mcp.json`, `.npmrc`), `.claude/**`,
`.codex/**`, or `docs/state/registry.md`. That diff is a review blocker on any
such PR, full stop. The applied-tree guard, not a prompt instruction, enforces
the repository paths. The registry may enter a factory PR only through trusted
deterministic transition logic or a conventional human-directed amendment in
that same PR; without one, the slice may not land because D135 is not waived.
This does **not** ban these paths from changing in general: F1 itself (building
the factory workflows and glue scripts) and any human-directed
branch-protection or CI change are conventional, human-reviewed work and are
expected to touch them. The invariant is "a factory implementing agent can't
grant itself more pipeline power," not "pipeline files are frozen."

## Reviewing a Factory-Authored PR

Applies to every PR the factory's publish job actually opened — the scope
key is **"did the privileged publisher open this PR"**, never a milestone
like "C2 onward". C1/F1 story PRs are conventionally authored by a human or
an interactive agent and reviewed like any interactive-agent PR, so this
section doesn't apply to them — but factory.md §11's F1-S6 end-to-end dry
run has the publish job open a real, agent-authored PR on a sacrificial
issue *before* C2 starts, and that PR is squarely in scope here: the author
is an agent, so every rule below applies, milestone or not. (Codex P2
finding on this section's first draft, #38 — a scope keyed on "C2 onward"
would have let F1-S6's own dry-run PR slip through un-reviewed by the exact
rules this section exists to enforce.) The author of a factory PR is
*always* an agent; this section exists because that fact changes what
"reviewed" has to mean, not because the rubric above stops applying —
everything in Code Review Rubric still applies in full.

### The roster

The table below describes the roster as it lands once every F1-S4 sibling
PR merges (#35 Claude Code Review, #36 CodeQL, #37 dependency review, #39
codecov, #40 the publisher-identity switch — all `Refs #7`). As of any one
of those PRs landing alone, a row it names may not exist on `main` yet;
this is a same-batch sequencing artifact, not a claim that the roster is
already fully wired the moment this file changes.

| Lens | Gate type | What it covers |
|---|---|---|
| CI (`Lint, typecheck, unit tests`, `Playwright smoke`, `Snowflake migrations (offline)`) | Required status check | Build/lint/typecheck/unit correctness; branch protection blocks merge on red |
| `Mutation testing (security-critical Python)` | Required status check | Mutation testing over the grant-boundary Python (`assert_dev_ci_grants.py`, `check_forbidden_grants.py`, `validate_migrations.py` — the last is a genuine dependency of `check_forbidden_grants.py`'s own migration-file discovery, added F1-S9 slice 2, issue #12, ready round) fails on a dropped score, a risen unresolved-mutant count, or a dropped total mutant count against the committed baseline — see `snowflake/check_mutation_score.py`. Wired into branch protection's required-status-checks list (added same day this row was written). |
| `codecov/patch` | Required status check, once wired | No coverage regression on changed lines |
| CodeQL (`.github/workflows/codeql.yml`) | Not a required status check — surfaces as code-scanning alerts | Security vulnerabilities (taint flows, injection patterns) in the diff |
| Dependency review (`.github/workflows/dependency-review.yml`) | Blocking job on `pull_request` (fails on high-severity advisory or a denied license) | Supply-chain risk on any `package.json`/`package-lock.json` change |
| Claude Code Review (`.github/workflows/claude-code-review.yml`) | **NOT** a required status check. On a workflow-edit PR the action **skips and reports SUCCESS** — observed on PR #140, whose log ends `Action skipped due to workflow validation error… Exiting due to workflow validation skip`. Read that green as **"no review ran"**, never as "reviewed and clean": it exits before the plugin marketplace is loaded, so a workflow-edit PR can never verify its own review path (#139) | Inline findings tagged blocker/medium/low against this file's Code Review Rubric; the real gate is the inline threads + `required_conversation_resolution`, not the check |
| Codex | Advisory-but-triaged, not a required check | Cross-family second opinion — the diverse-lens catch the agent-repo retros keep finding a same-family reviewer misses; see the wait-for-verdict rule in PR Merge Policy above (already ported verbatim from the agent repo — not re-pasted here to avoid two copies drifting) |
| Domain sub-agents (`schema-migration-reviewer`, `privacy-auditor`, `factory-security-reviewer`, `qa`) | Rubric-routed, human/PM-invoked | The escalation lenses named in Code Review Rubric's routing table above; not auto-run on every factory PR yet (factory.md §13 decision (ii) — rubric-routed to start, automate later is a live option) |

### Codex — operator decision (recorded 18 Jul 2026, updated 18 Jul 2026, F1-S4)

**Codex is installed and active on this repo** — confirmed live: it
reviewed #38 (this very PR) with a `chatgpt-codex-connector[bot]` reaction
and posted real findings, several of which this section itself was folded
from. (Superseded finding, kept for the record: this section originally
recorded Codex as "not yet installed" with a recommendation to enable it —
that was accurate at F1-S4's start but went stale within the same story;
Codex's own review of #38 is what caught the drift, per its P2 "Remove
stale Codex-not-installed guidance" finding.) The roster above runs WITH
the Codex row live, not without it. The wait-for-verdict rule in **PR
Merge Policy** above applies now, unconditionally, on every factory PR — it
was already copied verbatim from the agent repo's `AGENTS.md` at C1-S4 and
is the single source of truth for that rule in this repo; do not create a
second copy here.

### The structural rule (D23) — never self-triaged

**The implement agent's job ends at producing the diff.** It never resolves,
dismisses, or adjudicates a review finding on its own PR — not even one that
looks trivially correct or clearly a false positive. A human, or the
`pr-triage` sub-agent acting on the human's behalf, decides what counts as
resolved, every single time.

This is stricter than the interactive-agent operating model in the agent
repo, where an engineer at least drives its own PR under a human's real-time
oversight and can self-fix a lint nit without derailing anything. In the
factory, the author is *always* an agent and nobody is watching the
implement run in real time — so independent triage is the only thing that
keeps a factory PR's review from being self-graded. It is also the direct
answer to `factory.md` §13's headline finding: the automation that authors a
PR must not also be the thing that decides the PR is fine. See `factory.md`
§13 for the full incident (`#34`'s CI-stall / Codex-skip / CCR-skip failure
mode) this rule is a structural fix for, not a courtesy.

## Agent Topology and Model Selection

Every delegation decision has **three axes**, and they are chosen together, in
one breath — never topology first and model as an afterthought.

### The roster (`.claude/agents/`)

| Agent | Model | Fires on |
|---|---|---|
| `factory-security-reviewer` | `opus` | The factory's own pipeline — **the Code Review Rubric's routing list above is authoritative**; do not read this cell as a narrower restatement of it. That surface is all of `.github/**` (workflows **and** composite actions), `scripts/factory/**`, any privileged glue or publisher script wherever it lives, CODEOWNERS, and branch-protection config. Its job is to BREAK the pipeline, not assess it. |
| `schema-migration-reviewer` | `opus` | `snowflake/migrations/**`, grants, secure views, and the Zod/Pydantic validation standing in for constraints Snowflake will not enforce. |
| `privacy-auditor` | `sonnet` | routes, components, procs, reviewer data, IP addresses, visibility, deletion. |
| `qa` | `sonnet` | test quality beyond coverage; run pre-open when test-file churn exceeds 600 lines. |
| `pr-triage` | `sonnet` | independent adjudication of review feedback, so the author never self-triages (D23). |

**Pins are mandatory and enforced.** An agent with no `model:` **inherits the
parent**, so an unpinned definition spawned from an Opus main loop silently runs
Opus across a whole fan-out. `tests/factory/agent-model-pin.test.ts` asserts
every definition carries an explicit `model:` from the allowed set, that the two
adversarial security reviewers stay on `opus`, and that an empty roster fails
rather than passing vacuously. A documented default that nothing enforces is not
a default.

**Two tiers only — `opus` and `sonnet`.** No Haiku tier: nothing here is both
high-volume and correctness-insensitive, and mechanical extraction is better
served by `gh`/`grep` than by a third model to get wrong.

**The Opus triggers are not narrowed to save budget** (operator, 27 Jul 2026).
Both adversarial reviewers fire on S6's first slice, and that is accepted:
quality and safety lead. Narrowing a security trigger is a *permissive* scope
change under the Rigour Calibration direction test, so it needs an explicit
operator decision, not a cost argument. Monitor and re-evaluate with evidence.

### Axis A — which harness

Codex is available locally (`codex mcp-server`; `codex review --base <branch>`)
and draws on a **separate, weekly-capped subscription**.

- **Decisions, contracts, and ambiguous design → the interactive agent.**
  **Excluding adjudication of review feedback on a PR the interactive agent
  itself authored** — that always goes to a human or the `pr-triage` role, even
  for a finding that looks trivially correct or clearly a false positive (D23).
  The author's job ends at producing the diff and folding the fixes. Codex burns its budget on *ambiguity, not volume*: it ships settled
  contracts efficiently, while an unsettled one costs a full design round every
  time. Every decision settled before delegating converts an expensive round
  into a cheap one. This is the main budget lever.
- **Fully-specified implementation → Codex**, when the acceptance criteria,
  tests, closed grammar, and fail-closed behaviour are already written down.
- **Pre-open adversarial review → `codex review --base main`**, on diffs
  touching the credential or pipeline boundary. This is cheaper than the same
  findings arriving post-open as merge-blocking threads that need stale
  re-posts hand-resolved. Do **not** run it on docs or registry PRs; it draws
  the same quota.
- **Routine review (`qa`, `privacy-auditor`, `pr-triage`) → Claude sub-agents.**
  Cheap, and they do not touch the Codex quota at all.
- A local `codex review` **never** satisfies the Codex merge wait — that needs a
  bot-authored signal on the PR itself, validated per channel exactly as the PR
  Merge Policy above defines it (a commit-naming review or clean comment, or a
  👍 reaction, which carries no sha and is valid only while the head is
  unchanged). Do not collapse that into a blanket "must name the head sha";
  the reaction channel cannot carry one.
- **Budget stop rule:** check the remaining Codex allowance before delegating.
  Below roughly 20%, stop delegating implementation entirely and reserve the
  remainder for pre-open review on boundary-touching slices; review is the
  higher-value-per-token use, and the interactive agent can absorb the
  implementation.

### Axis B — which topology

- **Inline on the main loop** when the judgment *is* the work — which is most F1
  slices. They are small and security-dense, so a sub-agent costs a context
  handoff the slice cannot amortise.
- **Sub-agent** for bounded, well-specified, or read-only fan-out work:
  inventories, corpus sweeps, multi-file searches, the review lenses above.
- **Never fan out for its own sake.** Parallelism is justified by separable
  work, not by the size of the task list.
- Give each delegated implementation its **own git worktree**, so a bad
  delegation is `git worktree remove` rather than a mess in the root. Each fresh
  worktree needs its own `npm ci --ignore-scripts`; sharing only `.bin` breaks
  ESM resolution.

### Axis C — which model

- **`opus`** for adversarial security reasoning and hard adjudication, where a
  miss is the expensive failure.
- **`sonnet`** for scoped implementation, routine review, test-quality judgment,
  triage, and inventories.

When unsure, pick `sonnet` and escalate a specific spawn to `opus` with a stated
reason — never leave the model unset to "let it decide".
