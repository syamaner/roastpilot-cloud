# RoastPilot Cloud

Cloud data plane for [RoastPilot](https://github.com/syamaner/roastpilot-agent):
roast sharing via unlisted links, no-account tasting reviews from friends,
and reference-roast summaries fed back to the roasting advisor.

**Status**: planned (Milestone 2 — built after the agent harness M1).
Component plan lives in the private `roastpilot-plan` repository
(`agreed-plan/roastpilot-cloud/plan.md`).

Stack: Next.js (App Router) on Vercel + Supabase (Postgres, Storage).
Design principles: the cloud never controls the roaster, is never required
for an active roast, and never makes safety decisions.
