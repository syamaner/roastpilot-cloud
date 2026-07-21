import { describe, expect, it } from "vitest";
import {
  buildAggregatedCriterionBlockersCommentBody,
  buildAggregatedUnreviewedClosingIssuesCommentBody,
  buildAnchorFallbackSummarySupplement,
  buildCriterionBlockerCommentBody,
  buildDiffTruncatedBlockerCommentBody,
  buildDroppedClosingIssueBlockerCommentBody,
  criterionBlockerCommentMarker,
  CRITERION_BLOCKERS_AGGREGATE_COMMENT_MARKER,
  DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER,
  MAX_INDIVIDUAL_CRITERION_BLOCKER_COMMENTS,
  MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS,
  planBlockerInlineComments,
  selectDeterministicBlockerAnchor,
  unreviewedClosingIssueCommentMarker,
  UNREVIEWED_ISSUES_AGGREGATE_COMMENT_MARKER,
} from "../../scripts/factory/publish-spec-grounding-blocker-logic.mts";
import type {
  JoinedCriterionResult,
  UnreviewedClosingIssueResult,
} from "../../scripts/factory/publish-spec-grounding-verdict-logic.mts";

function droppedIssue(issueNumber: number): UnreviewedClosingIssueResult {
  return { issueNumber, truncationKind: "fully-dropped" };
}

function partialIssue(issueNumber: number): UnreviewedClosingIssueResult {
  return { issueNumber, truncationKind: "partially-truncated" };
}

function joined(overrides: Partial<JoinedCriterionResult> = {}): JoinedCriterionResult {
  return {
    issueNumber: 12,
    kind: "closing",
    criterionId: "12:0",
    satisfied: false,
    rationale: "The diff does not add the requested validation.",
    addressedByReviewer: true,
    ...overrides,
  };
}

describe("selectDeterministicBlockerAnchor (F1-S9 slice 3b-iii-c, issue #12)", () => {
  it("returns the first added line's path and new-side line number", () => {
    const diff = [
      "diff --git a/lib/x.ts b/lib/x.ts",
      "index 111..222 100644",
      "--- a/lib/x.ts",
      "+++ b/lib/x.ts",
      "@@ -1,2 +1,3 @@",
      " context line",
      "+added line",
      " another context line",
    ].join("\n");
    expect(selectDeterministicBlockerAnchor(diff)).toEqual({ path: "lib/x.ts", line: 2 });
  });

  it("advances the new-side line number correctly across context lines before the addition", () => {
    const diff = [
      "diff --git a/lib/x.ts b/lib/x.ts",
      "+++ b/lib/x.ts",
      "@@ -10,3 +10,4 @@",
      " context 10",
      " context 11",
      " context 12",
      "+added at 13",
    ].join("\n");
    expect(selectDeterministicBlockerAnchor(diff)?.line).toBe(13);
  });

  it("does NOT advance the new-side counter for a removed (-) line", () => {
    const diff = [
      "diff --git a/lib/x.ts b/lib/x.ts",
      "+++ b/lib/x.ts",
      "@@ -1,2 +1,2 @@",
      "-removed line",
      " context line",
      "+added line",
    ].join("\n");
    // new side starts at 1: "context line" is new-line 1 (context doesn't
    // move for the removed line above it), "added line" is new-line 2.
    expect(selectDeterministicBlockerAnchor(diff)?.line).toBe(2);
  });

  it("does not crash on, and does not count toward either side for, a no-newline-at-end-of-file marker line that genuinely sits BEFORE the returned anchor (not skipped by an early return)", () => {
    const diff = [
      "diff --git a/lib/x.ts b/lib/x.ts",
      "+++ b/lib/x.ts",
      "@@ -1,1 +1,2 @@",
      "-old",
      "\\ No newline at end of file",
      "+new one",
      "+new two",
    ].join("\n");
    // The marker line sits between the removed line and the first added
    // line, so it MUST be processed (not skipped) for this test to mean
    // anything -- confirms it doesn't advance the new-side counter and
    // doesn't crash the parser.
    expect(selectDeterministicBlockerAnchor(diff)).toEqual({ path: "lib/x.ts", line: 1 });
  });

  it("skips a purely-deleted file (+++ /dev/null, nothing addable) and finds the next file's addition", () => {
    const diff = [
      "diff --git a/lib/deleted.ts b/lib/deleted.ts",
      "deleted file mode 100644",
      "--- a/lib/deleted.ts",
      "+++ /dev/null",
      "@@ -1,2 +0,0 @@",
      "-old line one",
      "-old line two",
      "diff --git a/lib/kept.ts b/lib/kept.ts",
      "+++ b/lib/kept.ts",
      "@@ -1,1 +1,2 @@",
      " context",
      "+new line",
    ].join("\n");
    expect(selectDeterministicBlockerAnchor(diff)).toEqual({ path: "lib/kept.ts", line: 2 });
  });

  it("resets the new-side counter at a SECOND hunk header within the same file", () => {
    const diff = [
      "diff --git a/lib/x.ts b/lib/x.ts",
      "+++ b/lib/x.ts",
      "@@ -1,1 +1,0 @@",
      "-old",
      "@@ -50,1 +50,2 @@",
      " context at 50",
      "+added at 51",
    ].join("\n");
    expect(selectDeterministicBlockerAnchor(diff)).toEqual({ path: "lib/x.ts", line: 51 });
  });

  it("moves to the SECOND file when the first file's diff has no addable line at all", () => {
    const diff = [
      "diff --git a/lib/only-removes.ts b/lib/only-removes.ts",
      "+++ b/lib/only-removes.ts",
      "@@ -1,2 +1,0 @@",
      "-removed one",
      "-removed two",
      "diff --git a/lib/x.ts b/lib/x.ts",
      "+++ b/lib/x.ts",
      "@@ -1,1 +1,2 @@",
      " context",
      "+the real anchor",
    ].join("\n");
    expect(selectDeterministicBlockerAnchor(diff)).toEqual({ path: "lib/x.ts", line: 2 });
  });

  it("recovers safely, without crashing or miscounting, when a hunk's OWN declared new-side count overstates its actual content -- a malformed/truncated hunk falls back to re-interpreting the unexpected line as the next structural line, and correctly finds the real anchor that follows", () => {
    const diff = [
      "diff --git a/lib/x.ts b/lib/x.ts",
      "+++ b/lib/x.ts",
      "@@ -1,1 +1,3 @@", // overstates: declares 3 new-side lines, but only the removal below follows
      "-old line",
      "diff --git a/lib/y.ts b/lib/y.ts",
      "+++ b/lib/y.ts",
      "@@ -1,1 +1,2 @@",
      " context",
      "+the real anchor is still found correctly after recovery",
    ].join("\n");
    expect(selectDeterministicBlockerAnchor(diff)).toEqual({
      path: "lib/y.ts",
      line: 2,
    });
  });

  it("defaults both old and new counts to 1 when a hunk header omits them (a single-line hunk, per the unified diff spec's own optional-count shorthand)", () => {
    const diff = [
      "diff --git a/lib/x.ts b/lib/x.ts",
      "+++ b/lib/x.ts",
      "@@ -1 +1 @@", // no ",count" on either side -- both default to 1
      "-old",
      "+new",
    ].join("\n");
    expect(selectDeterministicBlockerAnchor(diff)).toEqual({ path: "lib/x.ts", line: 1 });
  });

  it("returns null for an empty diff", () => {
    expect(selectDeterministicBlockerAnchor("")).toBeNull();
  });

  it("does not crash and does not return a null-path result when a +++ /dev/null (deleted) file's own hunk malformedly contains a '+' line -- keeps advancing past it to find the real anchor later, rather than treating the malformed addition as anchorable", () => {
    const diff = [
      "diff --git a/lib/deleted.ts b/lib/deleted.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,2 @@", // malformed: a deleted file's hunk should never declare new-side lines
      "+this should never happen in a real diff",
      "diff --git a/lib/kept.ts b/lib/kept.ts",
      "+++ b/lib/kept.ts",
      "@@ -1,1 +1,2 @@",
      " context",
      "+the real anchor",
    ].join("\n");
    expect(selectDeterministicBlockerAnchor(diff)).toEqual({
      path: "lib/kept.ts",
      line: 2,
    });
  });

  it("returns null for a diff that only deletes content across every file", () => {
    const diff = [
      "diff --git a/lib/x.ts b/lib/x.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-gone",
    ].join("\n");
    expect(selectDeterministicBlockerAnchor(diff)).toBeNull();
  });

  it("is NOT fooled by a content ADDED line whose own text looks like a hunk header -- classified by the line's real leading '+' byte, not its text (parsing-safety discipline, this module's own docstring)", () => {
    const diff = [
      "diff --git a/lib/x.ts b/lib/x.ts",
      "+++ b/lib/x.ts",
      "@@ -1,1 +1,2 @@",
      " context",
      "+@@ -1,1 +1,1 @@ this is fake hunk-header TEXT inside an added line",
    ].join("\n");
    // The fake text does not reset hunk state -- this is still line 2 of
    // the ONE real hunk (context=1, this added line=2), and it correctly
    // resolves as the anchor since it genuinely IS an added line.
    expect(selectDeterministicBlockerAnchor(diff)).toEqual({
      path: "lib/x.ts",
      line: 2,
    });
  });

  it("is NOT fooled by a content ADDED line whose own text looks like a new-file header -- does not switch the tracked path", () => {
    const diff = [
      "diff --git a/lib/x.ts b/lib/x.ts",
      "+++ b/lib/x.ts",
      "@@ -1,1 +1,2 @@",
      " context",
      "+++ b/lib/evil-injected-path.ts",
    ].join("\n");
    // The fake "+++ b/..." text is a '+' (added) content line, not a real
    // file header (a real one never has a leading '+' from the outer diff
    // -- it appears once per file, immediately after the "--- a/..." line,
    // never nested inside a hunk's own content). Still anchors to the
    // REAL current file, lib/x.ts.
    expect(selectDeterministicBlockerAnchor(diff)).toEqual({
      path: "lib/x.ts",
      line: 2,
    });
  });

  it("finds the anchor in the FIRST file, not the second, when both files have a valid addition (diff order wins, deterministically)", () => {
    const diff = [
      "diff --git a/lib/a.ts b/lib/a.ts",
      "+++ b/lib/a.ts",
      "@@ -1,1 +1,2 @@",
      " context",
      "+first file's addition",
      "diff --git a/lib/b.ts b/lib/b.ts",
      "+++ b/lib/b.ts",
      "@@ -1,1 +1,2 @@",
      " context",
      "+second file's addition",
    ].join("\n");
    expect(selectDeterministicBlockerAnchor(diff)?.path).toBe("lib/a.ts");
  });

  it("recognizes git's own QUOTED new-file header form (core.quotePath's default rendering for a non-ASCII path) and decodes it to the real path, rather than leaving currentPath null (PR #83 review, Codex, LOW -- a real-diff-format edge: a diff whose only added lines live in a non-ASCII-filename file previously false-reported anchorFallbackNeeded)", () => {
    const diff = [
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
      '+++ "b/caf\\303\\251.ts"',
      "@@ -1,1 +1,2 @@",
      " context",
      "+added to the non-ASCII-named file",
    ].join("\n");
    expect(selectDeterministicBlockerAnchor(diff)).toEqual({ path: "café.ts", line: 2 });
  });

  it("decodes a quoted path containing an escaped backslash, an escaped double quote, and an octal byte together, in the same path", () => {
    // Represents the real filename: back\slash"quote-é.ts
    const diff = [
      '+++ "b/back\\\\slash\\"quote-caf\\303\\251.ts"',
      "@@ -1,1 +1,2 @@",
      " context",
      "+added",
    ].join("\n");
    expect(selectDeterministicBlockerAnchor(diff)?.path).toBe('back\\slash"quote-café.ts');
  });

  it("decodes \\t and \\n escapes within a quoted path", () => {
    const diff = [
      '+++ "b/weird\\tname\\nfile.ts"',
      "@@ -1,1 +1,2 @@",
      " context",
      "+added",
    ].join("\n");
    expect(selectDeterministicBlockerAnchor(diff)?.path).toBe("weird\tname\nfile.ts");
  });

  it.each([
    ["\\a (bell)", "\\a", "\x07"],
    ["\\b (backspace)", "\\b", "\b"],
    ["\\f (form feed)", "\\f", "\f"],
    ["\\r (carriage return)", "\\r", "\r"],
    ["\\v (vertical tab)", "\\v", "\v"],
  ])(
    "decodes the %s escape within a quoted path -- git's own C-escape set is FIXED and now completed here (PR #83 review, LOW): an earlier version's fail-safe silently mis-decoded these five into a literal backslash + letter, the wrong path",
    (_label, rawEscape, expectedChar) => {
      const diff = [
        `+++ "b/weird${rawEscape}name.ts"`,
        "@@ -1,1 +1,2 @@",
        " context",
        "+added",
      ].join("\n");
      expect(selectDeterministicBlockerAnchor(diff)?.path).toBe(`weird${expectedChar}name.ts`);
    },
  );

  it("fails safe (passes the backslash through literally, does not crash) on a quoted path ending in a bare, unescaped trailing backslash -- a malformed/synthetic input a real git diff would never produce (a real filename's own backslash is always escaped as \\\\), but the parser must degrade gracefully rather than reading past the end of the string", () => {
    const diff = [
      '+++ "b/weird\\"',
      "@@ -1,1 +1,2 @@",
      " context",
      "+added",
    ].join("\n");
    expect(selectDeterministicBlockerAnchor(diff)?.path).toBe("weird\\");
  });

  it("fails safe (passes the backslash through literally, does not crash) on an unrecognized escape sequence inside a quoted path -- not a sequence a real git diff would ever produce, but the parser must degrade gracefully rather than throw", () => {
    const diff = [
      '+++ "b/weird\\qname.ts"',
      "@@ -1,1 +1,2 @@",
      " context",
      "+added",
    ].join("\n");
    expect(selectDeterministicBlockerAnchor(diff)?.path).toBe("weird\\qname.ts");
  });

  it("still resolves /dev/null to a null (unanchorable) path when it appears alongside a quoted path elsewhere in the same diff -- /dev/null is never quoted by git", () => {
    const diff = [
      "diff --git a/lib/deleted.ts b/lib/deleted.ts",
      "+++ /dev/null",
      "@@ -1,1 +0,0 @@",
      "-gone",
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
      '+++ "b/caf\\303\\251.ts"',
      "@@ -1,1 +1,2 @@",
      " context",
      "+kept",
    ].join("\n");
    expect(selectDeterministicBlockerAnchor(diff)).toEqual({ path: "café.ts", line: 2 });
  });

  it("strips git's own trailing TAB delimiter from an unquoted path containing a space (PR #83 review, FOLD 1): git doesn't quote a plain space, it tab-delimits instead -- `+++ b/space file.ts\\t`", () => {
    const diff = ["+++ b/space file.ts\t", "@@ -1,1 +1,2 @@", " context", "+added"].join("\n");
    expect(selectDeterministicBlockerAnchor(diff)?.path).toBe("space file.ts");
  });

  it("strips a tab-delimited TIMESTAMP suffix (not just a bare trailing tab) from an unquoted path", () => {
    const diff = [
      "+++ b/space file.ts\t2024-01-01 12:00:00.000000000 +0000",
      "@@ -1,1 +1,2 @@",
      " context",
      "+added",
    ].join("\n");
    expect(selectDeterministicBlockerAnchor(diff)?.path).toBe("space file.ts");
  });

  it("strips a trailing tab-delimited suffix from a QUOTED path too (PR #83 review, FOLD 1 -- both branches), without disturbing the closing-quote detection", () => {
    const diff = [
      '+++ "b/caf\\303\\251.ts"\t2024-01-01 12:00:00.000000000 +0000',
      "@@ -1,1 +1,2 @@",
      " context",
      "+added",
    ].join("\n");
    expect(selectDeterministicBlockerAnchor(diff)?.path).toBe("café.ts");
  });
});

describe("buildCriterionBlockerCommentBody (F1-S9 slice 3b-iii-c, issue #12)", () => {
  it("includes the issue number, criterionId, and the agent's rationale when addressed", () => {
    const body = buildCriterionBlockerCommentBody(
      joined({ issueNumber: 12, criterionId: "12:0", rationale: "Missing the retry wrapper." }),
    );
    expect(body).toContain("#12");
    expect(body).toContain("12:0");
    expect(body).toContain("Missing the retry wrapper.");
  });

  it("includes the safe-default explanation, not a fabricated rationale, when never addressed", () => {
    const body = buildCriterionBlockerCommentBody(
      joined({ addressedByReviewer: false, rationale: null }),
    );
    expect(body).toMatch(/not addressed/i);
    expect(body).toMatch(/unsatisfied/i);
  });

  it("always includes the self-describing anchor caveat", () => {
    const body = buildCriterionBlockerCommentBody(joined());
    expect(body).toMatch(/deterministic placement/i);
    expect(body).toMatch(/does not necessarily mark/i);
  });

  it("falls back to an empty rationale, not a crash, for the type-level-only case of addressedByReviewer:true with a null rationale -- unreachable via a real verdict (validateSpecGroundingVerdict requires a non-empty rationale string on every finding), defensive coverage only, same as publish-spec-grounding-verdict-logic.mts's own formatRationaleForDisplay", () => {
    const body = buildCriterionBlockerCommentBody(
      joined({ addressedByReviewer: true, rationale: null }),
    );
    expect(body).toContain("unsatisfied:");
  });

  it("embeds a stable, criterionId-keyed idempotency marker as its last line (PR #82 round 3 review, holistic pass, FOLD 4)", () => {
    const body = buildCriterionBlockerCommentBody(joined({ criterionId: "12:0" }));
    expect(body.endsWith(criterionBlockerCommentMarker("12:0"))).toBe(true);
  });

  it("gives two different criteria two DIFFERENT markers -- the marker is criterionId-keyed, not a fixed constant", () => {
    const bodyA = buildCriterionBlockerCommentBody(joined({ criterionId: "12:0" }));
    const bodyB = buildCriterionBlockerCommentBody(joined({ criterionId: "12:1" }));
    expect(criterionBlockerCommentMarker("12:0")).not.toBe(criterionBlockerCommentMarker("12:1"));
    expect(bodyA).not.toContain(criterionBlockerCommentMarker("12:1"));
    expect(bodyB).not.toContain(criterionBlockerCommentMarker("12:0"));
  });
});

describe("buildDroppedClosingIssueBlockerCommentBody (F1-S9 slice 3b-iii-c, issue #12; distinct messages PR #82 round 2 review, FOLD 1)", () => {
  it("for a FULLY-DROPPED issue, includes the issue number and explains it was never reviewed at all", () => {
    const body = buildDroppedClosingIssueBlockerCommentBody(droppedIssue(99));
    expect(body).toContain("#99");
    expect(body).toMatch(/never reviewed/i);
    expect(body).not.toMatch(/only partially reviewed/i);
  });

  it("for a PARTIALLY-TRUNCATED issue, includes the issue number and explains SOME criteria were reviewed and some were truncated -- a DIFFERENT message than the fully-dropped case", () => {
    const body = buildDroppedClosingIssueBlockerCommentBody(partialIssue(99));
    expect(body).toContain("#99");
    expect(body).toMatch(/only partially reviewed/i);
    expect(body).toMatch(/only SOME of that issue's acceptance criteria/i);
    expect(body).not.toMatch(/\*\*Blocking: issue #99 was never reviewed\*\*/);
  });

  it("always includes the self-describing anchor caveat, for both truncation kinds", () => {
    expect(buildDroppedClosingIssueBlockerCommentBody(droppedIssue(99))).toMatch(/deterministic placement/i);
    expect(buildDroppedClosingIssueBlockerCommentBody(partialIssue(99))).toMatch(/deterministic placement/i);
  });

  it("embeds a stable, issueNumber-keyed idempotency marker as its last line, for both truncation kinds (PR #82 round 3 review, holistic pass, FOLD 4)", () => {
    expect(buildDroppedClosingIssueBlockerCommentBody(droppedIssue(99)).endsWith(unreviewedClosingIssueCommentMarker(99))).toBe(true);
    expect(buildDroppedClosingIssueBlockerCommentBody(partialIssue(99)).endsWith(unreviewedClosingIssueCommentMarker(99))).toBe(true);
  });
});

describe("buildAggregatedUnreviewedClosingIssuesCommentBody (F1-S9 slice 3b-iii-c, issue #12, PR #82 round 2 review, FOLD 2, BLOCKER)", () => {
  it("names each issue with its own truncation kind, up to the listed cap", () => {
    const body = buildAggregatedUnreviewedClosingIssuesCommentBody([droppedIssue(1), partialIssue(2)]);
    expect(body).toContain("#1 (never reviewed)");
    expect(body).toContain("#2 (partially reviewed)");
    expect(body).toContain("2 more issue(s)");
  });

  it("bounds the listed issue count, reporting an 'and N more' note rather than naming every issue -- never lets a crafted PR body inflate this ONE comment's own length without bound", () => {
    const manyIssues = Array.from({ length: 50 }, (_unused, i) => droppedIssue(i + 1));
    const body = buildAggregatedUnreviewedClosingIssuesCommentBody(manyIssues);
    // Only the first 20 (MAX_AGGREGATE_LISTED_ISSUES) are named individually.
    expect(body).toContain("#1 (never reviewed)");
    expect(body).toContain("#20 (never reviewed)");
    expect(body).not.toContain("#21 (never reviewed)");
    expect(body).toMatch(/and 30 more/);
    expect(body).toContain("50 more issue(s)"); // the heading's own total count, unbounded
  });

  it("does not append an 'and N more' note when every entry fits within the listed cap", () => {
    const body = buildAggregatedUnreviewedClosingIssuesCommentBody([droppedIssue(1)]);
    expect(body).not.toMatch(/and \d+ more/);
  });

  it("always includes the self-describing anchor caveat", () => {
    expect(buildAggregatedUnreviewedClosingIssuesCommentBody([droppedIssue(1)])).toMatch(/deterministic placement/i);
  });

  it("embeds the FIXED aggregate idempotency marker as its last line, regardless of which entries the aggregate lists (PR #82 round 3 review, holistic pass, FOLD 4)", () => {
    const bodyA = buildAggregatedUnreviewedClosingIssuesCommentBody([droppedIssue(1)]);
    const bodyB = buildAggregatedUnreviewedClosingIssuesCommentBody([droppedIssue(2), partialIssue(3)]);
    expect(bodyA.endsWith(UNREVIEWED_ISSUES_AGGREGATE_COMMENT_MARKER)).toBe(true);
    expect(bodyB.endsWith(UNREVIEWED_ISSUES_AGGREGATE_COMMENT_MARKER)).toBe(true);
  });
});

describe("buildAggregatedCriterionBlockersCommentBody (F1-S9 slice 3b-iii-c, issue #12, PR #82 round 3 review, holistic pass, BLOCKER 1)", () => {
  it("names each criterion up to the listed cap", () => {
    const body = buildAggregatedCriterionBlockersCommentBody([
      joined({ issueNumber: 12, criterionId: "12:0" }),
      joined({ issueNumber: 34, criterionId: "34:0" }),
    ]);
    expect(body).toContain("issue #12 criterion `12:0`");
    expect(body).toContain("issue #34 criterion `34:0`");
    expect(body).toContain("2 more unmet acceptance criterion(a)");
  });

  it("bounds the listed criterion count, reporting an 'and N more' note rather than naming every criterion -- never lets a crafted PR body inflate this ONE comment's own length without bound", () => {
    const manyCriteria = Array.from({ length: 50 }, (_unused, i) =>
      joined({ issueNumber: 12, criterionId: `12:${i}` }),
    );
    const body = buildAggregatedCriterionBlockersCommentBody(manyCriteria);
    expect(body).toContain("issue #12 criterion `12:0`");
    expect(body).toContain("issue #12 criterion `12:19`");
    expect(body).not.toContain("issue #12 criterion `12:20`");
    expect(body).toMatch(/and 30 more/);
    expect(body).toContain("50 more unmet acceptance criterion(a)");
  });

  it("does not append an 'and N more' note when every entry fits within the listed cap", () => {
    const body = buildAggregatedCriterionBlockersCommentBody([joined()]);
    expect(body).not.toMatch(/and \d+ more/);
  });

  it("does NOT include each entry's own rationale -- deliberately lighter-weight than the individual-comment builder, pointing to the uploaded verdict artifact instead", () => {
    const body = buildAggregatedCriterionBlockersCommentBody([
      joined({ rationale: "SECRET_RATIONALE_TEXT" }),
    ]);
    expect(body).not.toContain("SECRET_RATIONALE_TEXT");
    expect(body).toMatch(/uploaded verdict artifact/i);
  });

  it("labels an addressed entry 'found unsatisfied' and an unaddressed entry 'not addressed by the reviewer', and points each at the artifact that actually has it (PR #83 review, FOLD 2 -- an earlier version labeled every listed entry 'found unsatisfied' and pointed all of them at the verdict artifact regardless, which is wrong for an unaddressed one: there is no verdict entry for it at all)", () => {
    const body = buildAggregatedCriterionBlockersCommentBody([
      joined({ issueNumber: 12, criterionId: "12:0", addressedByReviewer: true }),
      joined({ issueNumber: 12, criterionId: "12:1", addressedByReviewer: false }),
    ]);
    expect(body).toContain("issue #12 criterion `12:0` (found unsatisfied)");
    expect(body).toContain("issue #12 criterion `12:1` (not addressed by the reviewer)");
    expect(body).toMatch(/agent addressed has its own rationale in the uploaded verdict artifact/i);
    expect(body).toMatch(/agent never addressed at all only appears in the criteria-spine artifact/i);
  });

  it("always includes the self-describing anchor caveat", () => {
    expect(buildAggregatedCriterionBlockersCommentBody([joined()])).toMatch(/deterministic placement/i);
  });

  it("embeds the FIXED aggregate idempotency marker as its last line, regardless of which entries the aggregate lists", () => {
    const bodyA = buildAggregatedCriterionBlockersCommentBody([joined({ criterionId: "12:0" })]);
    const bodyB = buildAggregatedCriterionBlockersCommentBody([joined({ criterionId: "34:0" })]);
    expect(bodyA.endsWith(CRITERION_BLOCKERS_AGGREGATE_COMMENT_MARKER)).toBe(true);
    expect(bodyB.endsWith(CRITERION_BLOCKERS_AGGREGATE_COMMENT_MARKER)).toBe(true);
  });
});

describe("buildDiffTruncatedBlockerCommentBody (F1-S9 slice 3b-iii-c, issue #12, PR #82 round 3 review, holistic pass, FOLD 3)", () => {
  it("explains the diff was truncated and that even a satisfied criterion is unverifiable as a result", () => {
    const body = buildDiffTruncatedBlockerCommentBody();
    expect(body).toMatch(/diff was truncated/i);
    expect(body).toMatch(/including any marked satisfied/i);
    expect(body).toMatch(/unverifiable/i);
  });

  it("always includes the self-describing anchor caveat", () => {
    expect(buildDiffTruncatedBlockerCommentBody()).toMatch(/deterministic placement/i);
  });

  it("embeds the FIXED whole-run idempotency marker as its last line", () => {
    expect(buildDiffTruncatedBlockerCommentBody().endsWith(DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER)).toBe(true);
  });
});

describe("planBlockerInlineComments (F1-S9 slice 3b-iii-c, issue #12)", () => {
  const anchorableDiff = [
    "diff --git a/lib/x.ts b/lib/x.ts",
    "+++ b/lib/x.ts",
    "@@ -1,1 +1,2 @@",
    " context",
    "+added",
  ].join("\n");

  it("returns no comments and no fallback need when there are no blockers at all", () => {
    expect(planBlockerInlineComments([], [], anchorableDiff, false)).toEqual({
      comments: [],
      anchorFallbackNeeded: false,
    });
  });

  it("returns no comments and no fallback need for an empty diff when there are ALSO no blockers -- the anchor search never even needs to run", () => {
    expect(planBlockerInlineComments([], [], "", false)).toEqual({
      comments: [],
      anchorFallbackNeeded: false,
    });
  });

  it("plans one comment per criterion blocker, all sharing the same anchor, when the count is well under the individual cap", () => {
    const result = planBlockerInlineComments(
      [joined({ criterionId: "12:0" }), joined({ criterionId: "12:1" })],
      [],
      anchorableDiff,
      false,
    );
    expect(result.anchorFallbackNeeded).toBe(false);
    expect(result.comments).toHaveLength(2);
    expect(result.comments[0]?.path).toBe("lib/x.ts");
    expect(result.comments[0]?.line).toBe(2);
    expect(result.comments[1]?.path).toBe("lib/x.ts");
    expect(result.comments[1]?.line).toBe(2);
  });

  it("plans a comment for an unreviewed-closing-issue blocker too, sharing the same anchor", () => {
    const result = planBlockerInlineComments([], [droppedIssue(99)], anchorableDiff, false);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.body).toContain("#99");
  });

  it("combines criterion blockers and unreviewed-closing-issue blockers into one plan", () => {
    const result = planBlockerInlineComments(
      [joined({ criterionId: "12:0" })],
      [droppedIssue(99)],
      anchorableDiff,
      false,
    );
    expect(result.comments).toHaveLength(2);
  });

  it("signals anchorFallbackNeeded:true, with NO comments, when there are blockers but the diff has no anchor point", () => {
    const result = planBlockerInlineComments([joined()], [], "", false);
    expect(result).toEqual({ comments: [], anchorFallbackNeeded: true });
  });

  it("exposes each comment's own marker as a dedicated field, matching the SAME value embedded in its own body, for every comment kind (PR #12 d+e PR-plan review -- completes c's own contract so d can find-and-update without re-parsing body text)", () => {
    const manyCriteria = Array.from({ length: MAX_INDIVIDUAL_CRITERION_BLOCKER_COMMENTS + 1 }, (_unused, i) =>
      joined({ criterionId: `12:${i}` }),
    );
    const manyIssues = Array.from({ length: MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS + 1 }, (_unused, i) =>
      droppedIssue(i + 1),
    );
    const result = planBlockerInlineComments(manyCriteria, manyIssues, anchorableDiff, true);
    expect(result.comments.length).toBeGreaterThan(0);
    for (const comment of result.comments) {
      expect(comment.marker.length).toBeGreaterThan(0);
      expect(comment.body.endsWith(comment.marker)).toBe(true);
    }
  });

  it("gives an individual criterion-blocker comment its own criterionId-keyed marker, matching criterionBlockerCommentMarker directly", () => {
    const result = planBlockerInlineComments([joined({ criterionId: "12:0" })], [], anchorableDiff, false);
    expect(result.comments[0]?.marker).toBe(criterionBlockerCommentMarker("12:0"));
  });

  it("gives an individual unreviewed-closing-issue comment its own issueNumber-keyed marker, matching unreviewedClosingIssueCommentMarker directly", () => {
    const result = planBlockerInlineComments([], [droppedIssue(99)], anchorableDiff, false);
    expect(result.comments[0]?.marker).toBe(unreviewedClosingIssueCommentMarker(99));
  });

  it("gives the criterion-blockers aggregate comment the FIXED aggregate marker, and the unreviewed-issues aggregate comment the OTHER fixed marker -- never conflated", () => {
    const manyCriteria = Array.from({ length: MAX_INDIVIDUAL_CRITERION_BLOCKER_COMMENTS + 1 }, (_unused, i) =>
      joined({ criterionId: `12:${i}` }),
    );
    const manyIssues = Array.from({ length: MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS + 1 }, (_unused, i) =>
      droppedIssue(i + 1),
    );
    const result = planBlockerInlineComments(manyCriteria, manyIssues, anchorableDiff, false);
    const criteriaAggregate = result.comments.find((c) => c.marker === CRITERION_BLOCKERS_AGGREGATE_COMMENT_MARKER);
    const issuesAggregate = result.comments.find((c) => c.marker === UNREVIEWED_ISSUES_AGGREGATE_COMMENT_MARKER);
    expect(criteriaAggregate).toBeDefined();
    expect(issuesAggregate).toBeDefined();
  });

  it("gives the diff-truncated blocker comment the FIXED whole-run marker", () => {
    const result = planBlockerInlineComments([], [], anchorableDiff, true);
    expect(result.comments[0]?.marker).toBe(DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER);
  });

  it("plans one individual comment per unreviewed-closing-issue up to MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS, with NO aggregated comment, when the count is exactly at the cap (PR #82 round 2 review, FOLD 2)", () => {
    const issues = Array.from({ length: MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS }, (_unused, i) => droppedIssue(i + 1));
    const result = planBlockerInlineComments([], issues, anchorableDiff, false);
    expect(result.comments).toHaveLength(MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS);
    expect(result.comments.every((c) => !c.body.includes("more issue(s) not fully reviewed"))).toBe(true);
  });

  it("caps individual unreviewed-closing-issue comments and adds exactly ONE aggregated comment for the overflow, never scaling the comment count past the cap plus one (PR #82 round 2 review, FOLD 2, BLOCKER -- the API-abuse fix)", () => {
    // Simulates a crafted PR body naming far more closing issues than
    // MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS.
    const manyIssues = Array.from({ length: 500 }, (_unused, i) => droppedIssue(i + 1));
    const result = planBlockerInlineComments([], manyIssues, anchorableDiff, false);
    // Bounded regardless of how many issues the crafted body named: at
    // most MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS individual comments
    // plus exactly one aggregated comment -- never one comment per issue.
    expect(result.comments).toHaveLength(MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS + 1);
    const aggregated = result.comments[result.comments.length - 1];
    expect(aggregated?.body).toContain("495 more issue(s) not fully reviewed");
    expect(aggregated?.path).toBe("lib/x.ts");
    expect(aggregated?.line).toBe(2);
  });

  it("plans one individual comment per criterion blocker up to MAX_INDIVIDUAL_CRITERION_BLOCKER_COMMENTS, with NO aggregated comment, when the count is exactly at the cap (PR #82 round 3 review, holistic pass, BLOCKER 1)", () => {
    const criteria = Array.from({ length: MAX_INDIVIDUAL_CRITERION_BLOCKER_COMMENTS }, (_unused, i) =>
      joined({ criterionId: `12:${i}` }),
    );
    const result = planBlockerInlineComments(criteria, [], anchorableDiff, false);
    expect(result.comments).toHaveLength(MAX_INDIVIDUAL_CRITERION_BLOCKER_COMMENTS);
    expect(result.comments.every((c) => !c.body.includes("more unmet acceptance criterion"))).toBe(true);
  });

  it("caps individual criterion-blocker comments and adds exactly ONE aggregated comment for the overflow, never scaling the comment count past the cap plus one (PR #82 round 3 review, holistic pass, BLOCKER 1 -- the docstring's prior 'inherently bounded' claim was false: the ~1000-criterion ceiling is fully attacker-controlled)", () => {
    const manyCriteria = Array.from({ length: 500 }, (_unused, i) => joined({ criterionId: `12:${i}` }));
    const result = planBlockerInlineComments(manyCriteria, [], anchorableDiff, false);
    expect(result.comments).toHaveLength(MAX_INDIVIDUAL_CRITERION_BLOCKER_COMMENTS + 1);
    const aggregated = result.comments[result.comments.length - 1];
    expect(aggregated?.body).toContain("495 more unmet acceptance criterion(a)");
    expect(aggregated?.path).toBe("lib/x.ts");
    expect(aggregated?.line).toBe(2);
  });

  it("mixes criterion blockers, individual unreviewed-closing-issue comments, and the aggregated overflow comment together, all sharing the same anchor", () => {
    const manyIssues = Array.from({ length: MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS + 3 }, (_unused, i) =>
      droppedIssue(i + 1),
    );
    const result = planBlockerInlineComments(
      [joined({ criterionId: "12:0" })],
      manyIssues,
      anchorableDiff,
      false,
    );
    // 1 criterion blocker + MAX individual issue comments + 1 aggregated overflow comment.
    expect(result.comments).toHaveLength(1 + MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS + 1);
    expect(result.comments.every((c) => c.path === "lib/x.ts" && c.line === 2)).toBe(true);
  });

  it("mixes BOTH categories' overflow aggregates together with individual comments from each, never conflating the two aggregate comments into one", () => {
    const manyCriteria = Array.from({ length: MAX_INDIVIDUAL_CRITERION_BLOCKER_COMMENTS + 2 }, (_unused, i) =>
      joined({ criterionId: `12:${i}` }),
    );
    const manyIssues = Array.from({ length: MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS + 2 }, (_unused, i) =>
      droppedIssue(i + 1),
    );
    const result = planBlockerInlineComments(manyCriteria, manyIssues, anchorableDiff, false);
    // MAX individual criteria + 1 criteria-aggregate + MAX individual issues + 1 issues-aggregate.
    expect(result.comments).toHaveLength(
      MAX_INDIVIDUAL_CRITERION_BLOCKER_COMMENTS + 1 + MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS + 1,
    );
    const criteriaAggregate = result.comments.find((c) => c.body.includes(CRITERION_BLOCKERS_AGGREGATE_COMMENT_MARKER));
    const issuesAggregate = result.comments.find((c) => c.body.includes(UNREVIEWED_ISSUES_AGGREGATE_COMMENT_MARKER));
    expect(criteriaAggregate).toBeDefined();
    expect(issuesAggregate).toBeDefined();
    expect(criteriaAggregate?.body).not.toBe(issuesAggregate?.body);
  });

  it("does NOT add a diff-truncated blocker comment when diffTruncationBlocksClosingClaim is false, even with other blockers present", () => {
    const result = planBlockerInlineComments([joined({ criterionId: "12:0" })], [], anchorableDiff, false);
    expect(result.comments.some((c) => c.body.includes(DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER))).toBe(false);
  });

  it("adds exactly ONE diff-truncated blocker comment when diffTruncationBlocksClosingClaim is true, alongside any other blockers, sharing the same anchor (PR #82 round 3 review, holistic pass, FOLD 3)", () => {
    const result = planBlockerInlineComments([joined({ criterionId: "12:0" })], [droppedIssue(99)], anchorableDiff, true);
    const diffTruncatedComments = result.comments.filter((c) => c.body.includes(DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER));
    expect(diffTruncatedComments).toHaveLength(1);
    expect(diffTruncatedComments[0]?.path).toBe("lib/x.ts");
    expect(diffTruncatedComments[0]?.line).toBe(2);
    // Total: 1 criterion + 1 issue + 1 diff-truncated.
    expect(result.comments).toHaveLength(3);
  });

  it("plans a lone diff-truncated blocker comment even when there are NO criterion blockers and NO unreviewed closing issues at all -- diffTruncationBlocksClosingClaim alone is enough to produce a comment (a run where every closing criterion was marked satisfied, but the diff itself was truncated)", () => {
    const result = planBlockerInlineComments([], [], anchorableDiff, true);
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0]?.body).toContain(DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER);
  });

  it("signals anchorFallbackNeeded:true, with NO comments, when diffTruncationBlocksClosingClaim alone is true but the diff has no anchor point", () => {
    const result = planBlockerInlineComments([], [], "", true);
    expect(result).toEqual({ comments: [], anchorFallbackNeeded: true });
  });
});

describe("buildAnchorFallbackSummarySupplement (F1-S9 slice 3b-iii-c, issue #12)", () => {
  it("returns an empty string for no blockers at all", () => {
    expect(buildAnchorFallbackSummarySupplement([], [], false)).toBe("");
  });

  it("lists a criterion blocker's full detail, since there is no inline thread for it in this fallback path", () => {
    const body = buildAnchorFallbackSummarySupplement(
      [joined({ issueNumber: 12, criterionId: "12:0", rationale: "Missing the retry wrapper." })],
      [],
      false,
    );
    expect(body).toContain("#12");
    expect(body).toContain("12:0");
    expect(body).toContain("Missing the retry wrapper.");
    expect(body).toMatch(/could not be posted as inline comments/i);
  });

  it("uses the safe-default explanation for an unaddressed criterion blocker, not a fabricated rationale", () => {
    const body = buildAnchorFallbackSummarySupplement(
      [joined({ addressedByReviewer: false, rationale: null })],
      [],
      false,
    );
    expect(body).toMatch(/not addressed by the reviewer's verdict/i);
  });

  it("falls back to an empty rationale, not a crash, for the type-level-only case of addressedByReviewer:true with a null rationale -- unreachable via a real verdict, defensive coverage only (same reasoning as buildCriterionBlockerCommentBody's own identical fallback)", () => {
    const body = buildAnchorFallbackSummarySupplement(
      [joined({ issueNumber: 12, criterionId: "12:0", addressedByReviewer: true, rationale: null })],
      [],
      false,
    );
    expect(body).toContain("unsatisfied");
  });

  it("lists a fully-dropped unreviewed-closing-issue blocker", () => {
    const body = buildAnchorFallbackSummarySupplement([], [droppedIssue(99)], false);
    expect(body).toContain("#99");
    expect(body).toMatch(/never reviewed at all/i);
  });

  it("lists a partially-truncated unreviewed-closing-issue blocker with a DIFFERENT message than the fully-dropped case (PR #82 round 2 review, FOLD 1)", () => {
    const body = buildAnchorFallbackSummarySupplement([], [partialIssue(99)], false);
    expect(body).toContain("#99");
    expect(body).toMatch(/only partially reviewed/i);
    expect(body).not.toMatch(/never reviewed at all/i);
  });

  it("lists both kinds together", () => {
    const body = buildAnchorFallbackSummarySupplement([joined({ issueNumber: 12 })], [droppedIssue(99)], false);
    expect(body).toContain("#12");
    expect(body).toContain("#99");
  });

  it("caps individually-listed unreviewed-closing-issues at MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS, reporting an omitted count rather than listing every issue without bound (proactive extension of PR #82 round 2 review's FOLD 2 to this fallback path)", () => {
    const manyIssues = Array.from({ length: 500 }, (_unused, i) => droppedIssue(i + 1));
    const body = buildAnchorFallbackSummarySupplement([], manyIssues, false);
    expect(body).toContain(`#${MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS}:`);
    expect(body).not.toContain(`#${MAX_INDIVIDUAL_UNREVIEWED_ISSUE_COMMENTS + 1}:`);
    expect(body).toMatch(/495 more issue\(s\) also not fully reviewed/);
  });

  it("does not report an omitted-issue count when every unreviewed-closing-issue fits within the individual cap", () => {
    const body = buildAnchorFallbackSummarySupplement([], [droppedIssue(1)], false);
    expect(body).not.toMatch(/more issue\(s\) also not fully reviewed/);
  });

  it("caps individually-listed criterion blockers at MAX_INDIVIDUAL_CRITERION_BLOCKER_COMMENTS, reporting an omitted count rather than listing every one without bound (PR #82 round 3 review, holistic pass, BLOCKER 1's twin fix -- an EARLIER version left this loop entirely unbounded even after planBlockerInlineComments was capped)", () => {
    const manyCriteria = Array.from({ length: 500 }, (_unused, i) => joined({ criterionId: `12:${i}` }));
    const body = buildAnchorFallbackSummarySupplement(manyCriteria, [], false);
    expect(body).toContain(`\`12:${MAX_INDIVIDUAL_CRITERION_BLOCKER_COMMENTS - 1}\``);
    expect(body).not.toContain(`\`12:${MAX_INDIVIDUAL_CRITERION_BLOCKER_COMMENTS}\``);
    expect(body).toMatch(/495 more unmet acceptance criterion\(a\) also unsatisfied/);
  });

  it("does not report an omitted-criterion count when every criterion blocker fits within the individual cap", () => {
    const body = buildAnchorFallbackSummarySupplement([joined()], [], false);
    expect(body).not.toMatch(/more unmet acceptance criterion\(a\) also unsatisfied/);
  });

  it("returns a non-empty string reporting the diff-truncation blocker even when there are NO criterion blockers and NO unreviewed closing issues at all (PR #82 round 3 review, holistic pass, FOLD 3)", () => {
    const body = buildAnchorFallbackSummarySupplement([], [], true);
    expect(body).not.toBe("");
    expect(body).toMatch(/diff was truncated/i);
    expect(body).toMatch(/at least one closing-kind reference/i);
  });

  it("does NOT report the diff-truncation blocker when diffTruncationBlocksClosingClaim is false", () => {
    const body = buildAnchorFallbackSummarySupplement([joined()], [], false);
    expect(body).not.toMatch(/diff was truncated/i);
  });

  it("reports the diff-truncation blocker ALONGSIDE other blocker detail when all three are present", () => {
    const body = buildAnchorFallbackSummarySupplement([joined({ issueNumber: 12 })], [droppedIssue(99)], true);
    expect(body).toContain("#12");
    expect(body).toContain("#99");
    expect(body).toMatch(/diff was truncated/i);
  });
});
