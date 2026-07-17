# roastpilot-cloud — State Registry

Pointer doc, not a narrative. Read this, then the active epic in the plan
repo, then the GitHub issue, before starting any story.

## Active epic

**C1 Scaffold** (conventional build, per D98). Next epic in sequence: **F1
Factory**.

Plan: `roastpilot-plan/roastpilot-cloud/plan.md` §11 (epic table).

## C1 story status

| Story | Issue | Status |
|---|---|---|
| C1-S1 Next.js scaffold + CI gates | [#1](https://github.com/syamaner/roastpilot-cloud/issues/1) | Done — merged via #15 |
| C1-S2 Snowflake account, `ROASTPILOT_DEV`, schemachange bootstrap, resource monitor | [#2](https://github.com/syamaner/roastpilot-cloud/issues/2) | In progress |
| C1-S3 Vercel project + preview deploys | [#3](https://github.com/syamaner/roastpilot-cloud/issues/3) | Open, ready-to-implement |
| C1-S4 AGENTS.md, state docs, sub-agents, branch protection | [#4](https://github.com/syamaner/roastpilot-cloud/issues/4) | In progress (this PR covers the docs/sub-agent half; branch protection is applied separately by the lead) |

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
