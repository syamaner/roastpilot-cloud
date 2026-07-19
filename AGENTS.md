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

## PR Merge Policy

Full policy: `factory.md` §9, identical to the agent repo's, no factory
exception. The load-bearing points:

- **Green CI is necessary but not sufficient.** Read every review comment
  before claiming mergeable — `gh pr checks` alone is not a merge signal.
- **Every inline review thread must be resolved** (branch protection:
  `required_conversation_resolution`). Fix it, or state in-thread why it's
  not being actioned.
- **Codex is advisory-but-triaged, not a required check.** Trigger it once
  on the final commit (`@codex review`). A 👀 reaction means the review is
  **in progress — keep waiting** (bounded ~30 min from the 👀); it does
  **not** clear the merge by itself. Only a **posted review** (findings) or
  a **👍** (nothing found), postdating the final commit, satisfies the wait.
  Do not arm auto-merge on green CI alone.
- **`pr-triage` adjudicates independently of the author.** Under the factory,
  the author is always an agent; it never self-triages its own PR's review
  comments (D23). The lead (or the `pr-triage` sub-agent) decides what counts
  as resolved.
- **Coverage regressions must be sorted, not waved through** — add the test
  or tag a genuinely unreachable line, never lower a threshold.

## PR Hygiene

- **Thin slices**: target ≤ ~400 changed lines; the story issue's size
  declaration should already reflect this (factory.md §5 enforces it at
  triage).
- **Separate data from logic**: fixtures, snapshots, and generated output go
  in their own commit or PR, never bundled with review-worthy logic.
- **`Closes #N`** only for the issue a PR fully resolves; `Refs #N` / `Part
  of #N` otherwise, so an unfinished issue isn't auto-closed.
- No post-open lint/format churn — run the gates before opening.

### Shift-left: fold the diverse lens BEFORE "ready" (D103)

The build's rework is dominated by review findings landing *after* a PR is
marked ready — F1-S8 alone took **5 Codex rounds, ~15 real P1s, all post-open**,
on a security keystone that two Opus `safety-reviewer` passes called clean. The
fix is to move the lens that catches them to before the merge gate ever sees the
PR.

- **Diverse-lens pre-open loop (the flagship, interactive/human-authored PRs).**
  Open a review-worthy PR as a **draft**, trigger `@codex review` on it, fold
  every real finding, and only then mark it **ready**. Codex is a *different
  model family* from the Claude authoring/review lenses, and same-family lenses
  co-accept a bug the author has already rationalised — that is the exact ~15-P1
  gap F1-S8 exposed. A finding folded on the draft is not rework; the identical
  finding after "ready" is. Wait for the verdict per the **Codex-wait rule in
  the Merge Policy** (its single source of truth) before flipping to ready —
  don't restate that rule here. **Factory-authored PRs** don't use this
  draft loop: the read-only implementing agent can't drive an open→ready
  transition, so the privileged publisher opens the PR and the *same* diverse
  lens runs **post-open** by design (the App-identity wiring exists precisely so
  CI + Codex + Claude Code Review fire on the opened PR), with the human merge as
  the gate the draft→ready step would otherwise be. Whether the publisher should
  open factory PRs as drafts and have `pr-triage` mark them ready post-fold is a
  factory-design question tracked separately, not this rule.
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

**Also verify**: tests assert real behavior, not a smoke check; new code is
covered or carries a documented reason for an uncovered line.

**Pipeline self-modification (factory.md §13):** any **factory
implementing-agent patch** — a manually-dispatched stage-1 run or an
F1-stage-2 chained `ready-to-implement` run alike, i.e. anything the
privileged publisher pushes on an agent's behalf — must never touch
`.github/**`, CODEOWNERS, branch-protection config, **or the privileged
glue/publisher scripts** (the label-write, branch-push, PR-create, and
comment-post logic the factory's privileged jobs run — per factory.md's
read-only-agent/privileged-publisher split, these scripts may live outside
`.github/**`). That diff is a review blocker on any such PR, full stop. This
does **not** ban these paths from changing in general: F1 itself (building
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
| `codecov/patch` | Required status check, once wired | No coverage regression on changed lines |
| CodeQL (`.github/workflows/codeql.yml`) | Not a required status check — surfaces as code-scanning alerts | Security vulnerabilities (taint flows, injection patterns) in the diff |
| Dependency review (`.github/workflows/dependency-review.yml`) | Blocking job on `pull_request` (fails on high-severity advisory or a denied license) | Supply-chain risk on any `package.json`/`package-lock.json` change |
| Claude Code Review (`.github/workflows/claude-code-review.yml`) | **NOT** a required status check (fails by design on workflow-edit PRs, per the agent-repo lesson) | Inline findings tagged blocker/medium/low against this file's Code Review Rubric; the real gate is the inline threads + `required_conversation_resolution`, not the check |
| Codex | Advisory-but-triaged, not a required check | Cross-family second opinion — the diverse-lens catch the agent-repo retros keep finding a same-family reviewer misses; see the wait-for-verdict rule in PR Merge Policy above (already ported verbatim from the agent repo — not re-pasted here to avoid two copies drifting) |
| Domain sub-agents (`schema-migration-reviewer`, `privacy-auditor`, `factory-security-reviewer`) | Rubric-routed, human/PM-invoked | The escalation lenses named in Code Review Rubric's routing table above; not auto-run on every factory PR yet (factory.md §13 decision (ii) — rubric-routed to start, automate later is a live option) |

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
