# Public taster edge defence

The anonymous `/r/[slug]` page and its review submission route have different
failure directions. Keep reads available to people and link-preview crawlers;
reject uncertain writes before they can reach Snowflake. No login, session,
cookie or CAPTCHA is part of this path.

## Hobby-complete controls

- Layer 0, read cost: `/r/[slug]` uses on-demand static generation and a
  five-minute ISR cache. The cached roast reads use `unstable_cache`; slug
  validation and the existing negative-cache behaviour bound invalid and
  missing-roast traffic. Do not read request headers or call BotID in the page
  render path: that would make the page dynamic and remove this cost boundary.
- Layer 2, write cost: the review route validates the slug, content type and
  JSON before the honeypot. A filled honeypot silently returns the same 200 as
  a successful submission. Basic BotID then denies classified bots and fails
  closed if detection throws or returns an unknown shape. Only an allowed
  request reaches Zod validation, the C5 Upstash per-IP limiter and finally
  `submitReview` through the Snowflake SQL API. A BotID denial is a generic
  403 without a retry header or cookie; it never resumes the warehouse.

The client instrumentation attaches Basic BotID protection to POST review
requests and passive classification to GET `/r/*`. There is no BotID check or
blocking branch on the read renderer or Open Graph image. Humans and
link-unfurl crawlers can therefore use the cached read path even when BotID is
unavailable. This is the asymmetric Hobby decision in D-DoW-1 and D-C7-3.

## Verification and operations

Run lint, typecheck, coverage tests and `npm run build`. The build must report
`● SSG` for `/r/[slug]`; a dynamic classification is a release blocker. The
route tests verify honeypot, BotID, limiter and SQL ordering, fail-closed
detector outcomes, and absence of cookies and secret-bearing denials. Check
Basic BotID's live blocking behaviour on a Vercel preview before merging;
unit tests mock the detector and cannot prove its edge classification.

If BotID fails on writes, investigate the structured `botid_fail_closed` event
without logging request bodies or secrets. A read-side BotID outage must not
be treated as a reason to block the cached page or its preview image. Retain
the existing operational usage monitoring in §15 of the project plan.

## Pro-tier options, not adopted at Hobby

- Custom Vercel WAF rate-limit rules on both routes are **not adopted at
  Hobby** (D-C7-3). On a Pro upgrade, review crawler allowances and read
  availability before enabling any blocking read rule (D-DoW-1).
- BotID Deep Analysis is **not adopted at Hobby** (D-C7-3). Basic BotID is the
  current invisible gate; Deep Analysis needs a separate tier decision.
- A separate read/write warehouse is **not adopted at Hobby** (D-DoW-2).
  The current ISR and write gates remain the cost boundary without that split.
