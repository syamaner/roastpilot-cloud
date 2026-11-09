# Public taster edge defence

The anonymous `/r/[slug]` page and its review submission route have different
failure directions. Keep reads available to people and link-preview crawlers;
reject uncertain writes before they can reach Snowflake. No login, session,
cookie or CAPTCHA is part of this path.

## Hobby-complete controls

- Layer 0, read cost: `/r/[slug]` and its preview render on demand from
  uncached reads (D228). Slug validation bounds invalid traffic; missing roasts
  are uncached not-found reads with no negative cache. Extra Snowflake reads,
  latency and cost are accepted unmeasured trade-offs with no numeric budget.
  Do not read request headers or call BotID in the page render path.
- Layer 2, write cost: the review route validates the slug, content type and
  JSON before the honeypot. A filled honeypot silently returns the same 200 as
  a successful submission. Basic BotID then denies classified bots and fails
  closed if detection throws or returns an unknown shape. Only an allowed
  request reaches Zod validation, the C5 Upstash per-IP limiter and finally
  `submitReview` through the Snowflake SQL API. A BotID denial is a generic
  403 without a retry header or cookie; it never resumes the warehouse.

The client instrumentation protects only POST review requests. The read path
is deliberately not wired to BotID client protection, so a BotID outage cannot
make a uncached read fail closed. There is no BotID check or blocking branch on
the read renderer or Open Graph image. Humans and link-unfurl crawlers retain
the uncached read path; read enforcement remains a Pro-tier WAF step. This is
the asymmetric Hobby decision in D-DoW-1 and D-C7-3.

## Verification and operations

Run lint, typecheck, coverage tests and `npm run build`. The build must report
the dynamic marker `ƒ` for `/r/[slug]` and `/r/[slug]/opengraph-image`; a
static classification is a release blocker. The
route tests verify honeypot, BotID, limiter and SQL ordering, fail-closed
detector outcomes, and absence of cookies and secret-bearing denials. Check
Basic BotID's live blocking behaviour on a Vercel preview before merging;
unit tests mock the detector and cannot prove its edge classification.

If BotID fails on writes, investigate the structured `botid_fail_closed` event
without logging request bodies or secrets. A read-side BotID outage must not
be treated as a reason to block the uncached page or its preview image. Retain
the existing operational usage monitoring in §15 of the project plan.

## Pro-tier options, not adopted at Hobby

- Custom Vercel WAF rate-limit rules on both routes are **not adopted at
  Hobby** (D-C7-3). On a Pro upgrade, review crawler allowances and read
  availability before enabling any blocking read rule (D-DoW-1).
- BotID Deep Analysis is **not adopted at Hobby** (D-C7-3). Basic BotID is the
  current invisible gate; Deep Analysis needs a separate tier decision.
- A separate read/write warehouse is **not adopted at Hobby** (D-DoW-2).
  The existing layered read controls and write gates remain without that split; read cost is not cache-bounded.
