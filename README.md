# RoastPilot Cloud

Cloud data plane for [RoastPilot](https://github.com/syamaner/roastpilot-agent):
roast sharing via unlisted links, no-account tasting reviews from friends,
and reference-roast summaries fed back to the roasting advisor.

**Status**: in build (updated 27 Aug 2026). C1 (scaffold) and F1 (the software
factory) are complete, and the factory operates on GitHub Actions with triage,
implementation, and review stages under human-gated merge. The C2 data-plane
schema epic (base DDL, secure views, stored procedures, and the roles/grants
boundary) is largely delivered and validated against a live Snowflake gate;
C3 onward are pending. F2, the issue-driven spec chain that decomposes and
specs stories automatically (to-issues, story-planner, triage), is landing
incrementally, with the story-planner stage shipped dark behind an enable flag.
Live epic and story pointers are in `docs/state/registry.md`; the plan repo
remains the source of truth.

**Stack** (D97): **Snowflake** (tables, stages, telemetry-in-SQL, stored-proc
aggregation, operator analytics) + Next.js (App Router) on **Vercel** for the
public taster surface only. Snowflake cannot serve anonymous users, so the
share pages and review form live outside it by design.

**Build process** (D98): epics C2–C8 are built **factory-first**: a
GitHub-issue-driven agent pipeline (triage → implement → review) where the
human specs, clarifies, and merges. C1 (scaffold) and F1 (the factory
itself) are conventional. Labels, issue templates, and milestones in this
repo are that pipeline's substrate; see the factory spec for the label
taxonomy and what each readiness state means.

**Plans** (source of truth, in
[`roastpilot-plan`](https://github.com/syamaner/roastpilot-plan)):

- [`roastpilot-cloud/plan.md`](https://github.com/syamaner/roastpilot-plan/blob/main/roastpilot-cloud/plan.md)
  — component plan: architecture, schema, sync contract, public surface,
  epics, cost model (§15).
- [`roastpilot-cloud/factory.md`](https://github.com/syamaner/roastpilot-plan/blob/main/roastpilot-cloud/factory.md)
  — software factory spec: pipeline, security model, autonomy ratchet.

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
