# RoastPilot Cloud

Cloud data plane for [RoastPilot](https://github.com/syamaner/roastpilot-agent):
roast sharing via unlisted links, no-account tasting reviews from friends,
and reference-roast summaries fed back to the roasting advisor.

**Status** (updated 16 Sep 2026): epic **C7 Ops** is the active epic — kicked
off, with its story batch filed and awaiting build (see the registry). The
autonomous CI
factory (C1's sibling epic F1, and the F2 spec chain) is **decommissioned**
permanently on ToS grounds; its workflows remain in-tree as dormant machinery,
and physically deleting them is an available cleanup follow-up. See
`docs/state/registry.md` for the authoritative epic and story status and the
validation record; the plan repo remains the source of truth.

**Stack** (D97): **Snowflake** (tables, stages, telemetry-in-SQL, stored-proc
aggregation, operator analytics) + Next.js (App Router) on **Vercel** for the
public taster surface only. Snowflake cannot serve anonymous users, so the
share pages and review form live outside it by design.

**Build process**: work ships through the compliant interactive model.
Interactive Claude Code is the PM / orchestrator (it plans and reviews, and does
not implement); Codex-MCP is the default delegated implementer with a Claude
implementer as fallback; Claude sub-agents provide the cross-family
safety-review floor; and a human merges. This supersedes D98's original
factory-first plan (epics C2–C8 built by an autonomous GitHub Actions pipeline):
that autonomous CI factory is **decommissioned** permanently on ToS grounds.
Some early C2 stories had shipped factory-first before the pause; C-UI and all
work since ship through the interactive model. `factory.md` is retained as a
historical design archive.

**Plans** (source of truth, in
[`roastpilot-plan`](https://github.com/syamaner/roastpilot-plan)):

- [`roastpilot-cloud/plan.md`](https://github.com/syamaner/roastpilot-plan/blob/main/roastpilot-cloud/plan.md)
  — component plan: architecture, schema, sync contract, public surface,
  epics, cost model (§15).
- [`roastpilot-cloud/factory.md`](https://github.com/syamaner/roastpilot-plan/blob/main/roastpilot-cloud/factory.md)
  — software factory spec (decommissioned 15 Sep 2026, retained as a historical
  design archive): pipeline, security model, autonomy ratchet. The autonomous
  pipeline is obsolete, but some rules it documents (the merge policy, the CI
  security model, and protected-path reviewer routing) remain in force, reframed
  in this repo's `AGENTS.md`. Per the plan-repo precedence rule, the plan repo
  still wins on any genuine disagreement beyond the documented decommission
  correction.

Design principles: the cloud never controls the roaster, is never required
for an active roast, and never makes safety decisions.

## Development

```bash
npm install
npm run dev        # serves the placeholder page at http://localhost:3000
npm run lint
npm run typecheck
npm run test        # Vitest unit tests
npm run test:e2e    # Playwright boot smoke spec (requires: npx playwright install chromium)
npm run build
```
