import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CODEX_TRIGGER_PHRASE,
  CODEX_VERDICT_CRITERION,
  renderTriggerPhraseInertly,
} from "../../scripts/factory/implement-patch-logic.mts";

/**
 * Contract tests for `CODEX_VERDICT_CRITERION`.
 *
 * WHY THIS FILE EXISTS, and why the obvious test is the wrong one.
 *
 * The criterion used to be restated at five operator-facing sites and drifted
 * at nearly every review round, so PR #155 collapsed it into one exported
 * constant. That removed drift BETWEEN the sites — and replaced it with drift
 * between the constant and AGENTS.md that nothing could detect, because every
 * assertion about the constant was `expect(site).toContain(CODEX_VERDICT_CRITERION)`:
 * the constant compared against itself. Those assertions prove each site
 * interpolates the constant, which is worth testing, and prove exactly nothing
 * about what the constant SAYS.
 *
 * The evidence that this mattered: three consecutive commits on #155 changed
 * the criterion's security semantics — two of them restoring a fail-open guard
 * that the collapse had silently dropped (the 👀-before-👍 ordering, then the
 * postdate-boundary rule) — and not one test failed or needed updating. An
 * adversarial review then replaced the whole constant with "a 👍 reaction is
 * enough, whenever it was left", re-opening both fail-opens at once, and the
 * full suite stayed green.
 *
 * So these tests state each condition INDEPENDENTLY, as a literal, and check
 * the same condition still stands in AGENTS.md's PR Merge Policy, which is the
 * source of truth. A condition dropped from either side now reddens CI. This
 * follows `factory-envelope-policy-contract.test.ts`, which binds documented
 * policy to code the same way.
 *
 * These are deliberately literal rather than semantic. A regex cannot judge
 * whether prose still means the same thing, but it CAN catch a condition being
 * deleted outright, which is the failure that actually happened, three times.
 */

const AGENTS_MD = readFileSync(new URL("../../AGENTS.md", import.meta.url), "utf8");

/**
 * Each row: the condition, a matcher against the constant, and a matcher
 * against AGENTS.md. Both must hold, so neither artifact can drop a condition
 * unilaterally.
 */
const CONDITIONS = [
  [
    "requires the Codex bot identity as the author",
    /AUTHORED BY `chatgpt-codex-connector\[bot\]`/,
    /ONLY\s+when authored by the Codex bot identity \(`chatgpt-codex-connector\[bot\]`\)/,
  ],
  [
    "says why identity matters: a public repo makes any channel spoofable",
    /public, so a comment or reaction from anyone else is\s+spoofable/,
    /bot-authorship is\s+required on BOTH channels: a reaction or comment content alone is spoofable/,
  ],
  [
    "names the clean COMMENT channel by its literal title",
    /Codex Review: Didn't find any major issues/,
    // `\s+` throughout the AGENTS.md matchers: it is hard-wrapped prose, so a
    // condition can sit across a line break and a literal-space regex would
    // report a missing condition that is present, which is worse than useless
    // on a test whose whole job is detecting a missing condition.
    /Codex Review: Didn't\s+find any major issues/,
  ],
  [
    "requires the comment to be top-level and carry a Reviewed commit line",
    /TOP-LEVEL comment[\s\S]*`Reviewed commit: <sha>` line whose sha matches/,
    /\*\*top-level "Codex Review: Didn't\s+find any major issues" comment carrying a `Reviewed commit: <sha>` line\*\* whose\s+sha matches the PR head/,
  ],
  [
    "requires the 👍 to follow the bot's own 👀",
    /👍 AFTER its own 👀/,
    // NOT a bare /👀/: that matches the emoji anywhere in the file, so the
    // ordering condition could be deleted outright and this would still pass.
    // Must require the preceding 👀 to be the BOT'S OWN. The earlier matcher
    // accepted any "👍 reaction (after the 👀)" wording, so AGENTS.md could
    // stay weaker than the constant while this contract reported the two as
    // aligned — and on a public repo a third party can supply that 👀
    // (Codex P2, #155).
    /👍 reaction \(after the bot's OWN 👀[\s\S]{0,200}must itself be\s+bot-authored/,
  ],
  [
    "records that a bare 👍 with no preceding 👀 is not a completed review",
    /👍\s+with no preceding 👀 is not a completed review/,
    /A 👀 reaction means the review is \*\*in\s+progress, keep waiting\*\*/,
  ],
  [
    "records that the 👍 carries no sha, so it holds only while the head is unchanged",
    /👍 carries no sha,\s+so it holds only while the head is unchanged/,
    /👍\s+reaction carries no sha, so it is valid only while the head stays unchanged/,
  ],
  [
    "requires the signal to postdate the event that started the review",
    /POSTDATE the event that started/,
    /must correspond to the current head AND postdate \*\*the event that\s+started the automatic review for this PR's shape\*\*/,
  ],
  [
    "names BOTH boundary events, since a PR created ready never emits ready_for_review",
    /`opened` for a PR created ready, `ready_for_review` for a\s+draft marked ready/,
    // Two separate assertions, not an alternation: an alternation is satisfied
    // by either branch, so deleting one boundary event from the policy would
    // leave this green while the rule became unsatisfiable for that PR shape.
    [
      /a PR \*\*created ready\*\*[\s\S]{0,120}emits `opened` and\s+NEVER emits `ready_for_review`, so `opened` is its boundary/,
      /a \*\*draft marked ready\*\* emits `ready_for_review`, and that is its\s+boundary/,
    ],
  ],
  [
    "records that a review carrying findings is not clean",
    /A review carrying findings is\s+NOT clean/,
    // TWO matchers, because the rule has two halves and only one was asserted
    // (Codex P2, #155). The inline-thread sentence alone left the load-bearing
    // top-level-comment clause unprotected: a findings review posted as a
    // top-level comment with NO inline threads blocks nothing mechanically, so
    // dropping that clause reopens exactly the merge-gate ambiguity this row
    // exists to close, while the row stayed green.
    [
      /A \*\*posted\s+`pull_request_review` with inline threads\*\* = findings/,
      /a review carrying findings is not clean even when posted as\s+a top-level comment with no inline threads/,
    ],
  ],
] as const;

describe("CODEX_VERDICT_CRITERION states every condition of the merge-wait rule", () => {
  it.each(CONDITIONS)("%s", (_condition, inConstant) => {
    expect(CODEX_VERDICT_CRITERION).toMatch(inConstant);
  });

  it.each(CONDITIONS)("AGENTS.md still carries: %s", (_condition, _inConstant, inAgentsMd) => {
    // A condition may need SEVERAL matchers when the policy states it in more
    // than one clause, and then EVERY one must hold. An alternation would be
    // satisfied by whichever half survived a deletion — which is exactly how
    // the first version of this file was too weak to do its own job: the
    // boundary-event row used /`ready_for_review`|created ready/, so removing
    // either boundary event from the policy left it green while the rule became
    // unsatisfiable for that PR shape (Codex P2, #155).
    const matchers = Array.isArray(inAgentsMd) ? inAgentsMd : [inAgentsMd];
    expect(matchers.length).toBeGreaterThan(0);
    for (const matcher of matchers) {
      expect(AGENTS_MD).toMatch(matcher);
    }
  });

  // The silent-fallback clause is the one place the criterion tells an operator
  // to ACT rather than wait, so its scope is load-bearing in both directions:
  // too broad and it instructs a second trigger on an already-triggered head
  // (the re-litigation the once-on-final rule forbids); too narrow and a review
  // that never started is waited on forever.
  it("scopes the silent-fallback trigger to a head with no trigger yet", () => {
    expect(CODEX_VERDICT_CRITERION).toMatch(/If NO trigger\s+has yet been posted for this head/);
    expect(CODEX_VERDICT_CRITERION).toMatch(/roughly 30 minutes/);
    // Codex P2, #155: the criterion is shared by notices that can land on a
    // DRAFT PR, so an unconditional "post the trigger" instruction contradicts
    // the draft rule wherever it is reused. A manual review on a draft can
    // never complete the clean-verdict flow, so the instruction must be gated
    // on the PR being ready — at the source, not per consumer.
    expect(CODEX_VERDICT_CRITERION).toMatch(/ONLY IF THIS PR IS\s+READY/);
    expect(CODEX_VERDICT_CRITERION).toMatch(/Marking the draft ready is what starts\s+the automatic review/);
  });

  // This constant is embedded in content the publisher POSTS to GitHub — a PR
  // body via buildImplementPrBody, a PR comment via
  // buildFallbackRefreshCommentBody — and it quotes the trigger phrase. The
  // connector matches that phrase inside posted comment bodies, backticks
  // included, so the notice can start the very review it tells the operator
  // nothing else will start, turning the operator's instructed trigger into the
  // second one the clause above forbids.
  it("warns that the notice itself may have started the review", () => {
    expect(CODEX_VERDICT_CRITERION).toMatch(/CHECK BEFORE YOU POST/);
    expect(CODEX_VERDICT_CRITERION).toMatch(/matches the trigger phrase inside posted\s+comment bodies/);
    // The observation, not just the claim: a rule with no evidence behind it is
    // the kind that gets quietly dropped in the next collapse.
    expect(CODEX_VERDICT_CRITERION).toMatch(/roastpilot-agent#682/);
  });

  it("refuses a second trigger only for the SAME head, not for a superseded one", () => {
    // Without "FOR THIS HEAD" this sentence tells an operator on a refreshed
    // head — who triggered on the previous head — not to trigger at all, so the
    // new head would never be reviewed.
    expect(CODEX_VERDICT_CRITERION).toMatch(/already been posted FOR THIS HEAD, do not post a second/);
    expect(CODEX_VERDICT_CRITERION).toMatch(/trigger on an EARLIER head does not count/);
    // The second exemption, and the subtler one (Codex P2, #155): a trigger
    // posted while the PR was a draft leaves the sha unchanged through
    // `ready_for_review`, so a head-only comparison reads it as current and
    // forbids the timeout re-trigger — while the draft review it started can
    // never supply a post-boundary clean verdict.
    expect(CODEX_VERDICT_CRITERION).toMatch(/trigger posted BEFORE this PR's\s+boundary event does not count/);
    expect(CODEX_VERDICT_CRITERION).toMatch(/Match the trigger to the boundary,\s+not merely to the sha/);
  });

  // Guards against this whole file passing vacuously if the import breaks or
  // the constant is emptied: every assertion above is a `toMatch`, and an
  // empty string would fail them, but an accidental re-export of some other
  // long string might not be caught by any single one.
  it("is a substantial operator-facing paragraph, not a stub", () => {
    expect(CODEX_VERDICT_CRITERION.length).toBeGreaterThan(800);
    expect(CONDITIONS.length).toBeGreaterThanOrEqual(10);
  });
});

describe("posted content cannot start the review it describes", () => {
  it("renders the trigger phrase inertly", () => {
    const rendered = renderTriggerPhraseInertly(`please post ${CODEX_TRIGGER_PHRASE} once`);
    expect(rendered).not.toContain(CODEX_TRIGGER_PHRASE);
    expect(rendered).toContain("the Codex review trigger comment");
  });

  it("strips EVERY occurrence, not just the first", () => {
    // The criterion quotes the phrase several times, so a first-match-only
    // implementation would still post a live trigger.
    const rendered = renderTriggerPhraseInertly(CODEX_VERDICT_CRITERION);
    expect(rendered).not.toContain(CODEX_TRIGGER_PHRASE);
    // Guard against passing vacuously if the criterion stops quoting it.
    expect(CODEX_VERDICT_CRITERION).toContain(CODEX_TRIGGER_PHRASE);
  });

  it("leaves text with no trigger phrase untouched", () => {
    const plain = "nothing to neutralise here";
    expect(renderTriggerPhraseInertly(plain)).toBe(plain);
  });
});
