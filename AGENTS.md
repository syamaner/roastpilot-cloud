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
