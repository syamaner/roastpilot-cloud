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

| Story | Issue | Status |
|---|---|---|
| F1-S1 Labels, issue templates, milestones, story issues for C1/F1 | — (no issue; done at prep, 16 Jul 2026) | Done |
| F1-S2 `triage-issues.yml` + triage skill (seed/triage/apply, JSON contract, concurrency) | [#5](https://github.com/syamaner/roastpilot-cloud/issues/5) | Done — merged via #19 (5 review rounds + a `workflow_dispatch` probe, #20, that empirically settled the verdict-write permission rule — `Edit(path)`, not `Write(path)`, no pre-touch needed). A live dry-run against a real issue is the operator's next step. |
| F1-S3 `implement-ready-issues.yml` (read-only agent + privileged publisher, dispatch-first) | [#6](https://github.com/syamaner/roastpilot-cloud/issues/6) | Done — merged via #24. Since extended by F1-S4 (publisher-identity switch), F1-S9/#40 fix-forwards, and F1-S10 (#50/#53/#55). |
| F1-S4 Review workflow port + repo `AGENTS.md` review rubric section | [#7](https://github.com/syamaner/roastpilot-cloud/issues/7) | Done — merged via #35–#40, #46/#49 fix-forward |
| F1-S5 `to-issues` skill + dry-run decomposition of C2 (PM-reviewed) | [#8](https://github.com/syamaner/roastpilot-cloud/issues/8) | Done — merged via #48 |
| F1-S6 End-to-end dry run + factory runbook | — | Not started |
| F1-S10 Factory operational safety (kill-switch, idempotency guards, provenance trailer) | [#13](https://github.com/syamaner/roastpilot-cloud/issues/13) | Done — 3 slices: kill-switch + runbook merged via #50; 429/Retry-After idempotency backoff merged via #53; full provenance trailer (model ID, prompt/skill version, `Co-Authored-By`/`Signed-off-by`) merged via [#55](https://github.com/syamaner/roastpilot-cloud/pull/55). Aggregate cost caps (factory.md §13 point 7) are **N/A by billing model, not a pending operator task** (D102, 18 Jul 2026 — no metered Anthropic/Actions spend to cap; see `docs/factory-runbook.md`). |

Check `gh issue view <n>` for current state before relying on this table —
it is a pointer, not a live sync.

## Epic order

C1 Scaffold → F1 Factory → C2 Schema → C3 Sync → C4 Public page → C5 Reviews
→ C6 References → C7 Ops → C8 Analysis (optional).

C2–C8 story issues are not pre-created; decomposition (`to-issues`, F1-S5) is
itself factory work, PM-reviewed per-epic at kickoff.

## Build process

- **C1 and F1**: conventional — an interactive agent or human, one PR per
  story, same as the agent repo's operating model.
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
5. One PR per story. The completing PR updates this table in the same PR —
   file state and GitHub state must never drift.
6. Full rules, stack conventions, PR hygiene, and the review rubric:
   [`AGENTS.md`](../../AGENTS.md).
