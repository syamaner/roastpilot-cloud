# RoastPilot Cloud

Cloud data plane for [RoastPilot](https://github.com/syamaner/roastpilot-agent):
roast sharing via unlisted links, no-account tasting reviews from friends,
and reference-roast summaries fed back to the roasting advisor.

**Status**: planned (Milestone 2, built after the agent harness M1). Prep
complete: plan revised, factory specced, C1/F1 stories filed (16 Jul 2026).

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
