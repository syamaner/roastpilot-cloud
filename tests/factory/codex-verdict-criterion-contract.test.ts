import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CODEX_VERDICT_CRITERION } from "../../scripts/factory/implement-patch-logic.mts";

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
    /chatgpt-codex-connector\[bot\]/,
  ],
  [
    "says why identity matters: a public repo makes any channel spoofable",
    /public, so a comment or reaction from anyone else is\s+spoofable/,
    /spoofable/,
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
    /top-level[\s\S]*`Reviewed commit: <sha>` line/,
  ],
  [
    "requires the 👍 to follow the bot's own 👀",
    /👍 AFTER its own 👀/,
    /👀/,
  ],
  [
    "records that a bare 👍 with no preceding 👀 is not a completed review",
    /👍\s+with no preceding 👀 is not a completed review/,
    /in\s+progress, keep waiting/,
  ],
  [
    "records that the 👍 carries no sha, so it holds only while the head is unchanged",
    /👍 carries no sha,\s+so it holds only while the head is unchanged/,
    /carries no sha/,
  ],
  [
    "requires the signal to postdate the event that started the review",
    /POSTDATE the event that started/,
    /must postdate the final-commit trigger|postdate/i,
  ],
  [
    "names both boundary events, since a PR created ready never emits ready_for_review",
    /`opened` for a PR created ready, `ready_for_review` for a\s+draft marked ready/,
    /`ready_for_review`|created ready/,
  ],
  [
    "records that a review carrying findings is not clean",
    /A review carrying findings is\s+NOT clean/,
    /inline threads\*\* = findings/,
  ],
] as const;

describe("CODEX_VERDICT_CRITERION states every condition of the merge-wait rule", () => {
  it.each(CONDITIONS)("%s", (_condition, inConstant) => {
    expect(CODEX_VERDICT_CRITERION).toMatch(inConstant);
  });

  it.each(CONDITIONS)("AGENTS.md still carries: %s", (_condition, _inConstant, inAgentsMd) => {
    expect(AGENTS_MD).toMatch(inAgentsMd);
  });

  // The silent-fallback clause is the one place the criterion tells an operator
  // to ACT rather than wait, so its scope is load-bearing in both directions:
  // too broad and it instructs a second trigger on an already-triggered head
  // (the re-litigation the once-on-final rule forbids); too narrow and a review
  // that never started is waited on forever.
  it("scopes the silent-fallback trigger to a head with no trigger yet", () => {
    expect(CODEX_VERDICT_CRITERION).toMatch(/If NO trigger\s+has yet been posted for this head/);
    expect(CODEX_VERDICT_CRITERION).toMatch(/roughly 30 minutes/);
  });

  it("refuses a second trigger only for the SAME head, not for a superseded one", () => {
    // Without "FOR THIS HEAD" this sentence tells an operator on a refreshed
    // head — who triggered on the previous head — not to trigger at all, so the
    // new head would never be reviewed.
    expect(CODEX_VERDICT_CRITERION).toMatch(/already been posted FOR THIS HEAD, do not post a second/);
    expect(CODEX_VERDICT_CRITERION).toMatch(/trigger posted on an earlier head does not count/);
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
