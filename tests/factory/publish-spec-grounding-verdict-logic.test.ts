import { describe, expect, it } from "vitest";
import {
  buildDroppedClosingIssueResults,
  buildSpecGroundingSummaryCommentBody,
  deriveSeverity,
  findExistingSpecGroundingSummaryCommentId,
  formatRationaleForDisplay,
  joinFindingsToSpine,
  SPEC_GROUNDING_COMMENT_AUTHOR_LOGIN,
  SPEC_GROUNDING_SUMMARY_COMMENT_MARKER,
  type ExistingComment,
  type JoinedCriterionResult,
} from "../../scripts/factory/publish-spec-grounding-verdict-logic.mts";
import type { CriteriaSpineEntry } from "../../scripts/factory/spec-grounding-runner-logic.mts";
import type { SpecGroundingVerdict } from "../../scripts/factory/spec-grounding-verdict-schema.mts";

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

describe("joinFindingsToSpine (F1-S9 slice 3b-iii, issue #12)", () => {
  it("joins a matching finding's satisfied/rationale onto its spine entry, carrying kind from the SPINE", () => {
    const spine: CriteriaSpineEntry[] = [{ issueNumber: 12, kind: "closing", criterionId: "12:0" }];
    const verdict: SpecGroundingVerdict = {
      findings: [{ criterionId: "12:0", satisfied: true, rationale: "Handled in file X." }],
    };
    expect(joinFindingsToSpine(spine, verdict)).toEqual([
      {
        issueNumber: 12,
        kind: "closing",
        criterionId: "12:0",
        satisfied: true,
        rationale: "Handled in file X.",
        addressedByReviewer: true,
      },
    ]);
  });

  it("defaults a spine entry with NO matching finding to satisfied:false, rationale:null, addressedByReviewer:false -- the over-match-safe direction", () => {
    const spine: CriteriaSpineEntry[] = [{ issueNumber: 12, kind: "closing", criterionId: "12:0" }];
    const verdict: SpecGroundingVerdict = { findings: [] };
    expect(joinFindingsToSpine(spine, verdict)).toEqual([
      {
        issueNumber: 12,
        kind: "closing",
        criterionId: "12:0",
        satisfied: false,
        rationale: null,
        addressedByReviewer: false,
      },
    ]);
  });

  it("silently ignores an agent-invented criterionId that was never in the spine at all -- never looked up, per spec-grounding-verdict-schema.mts's own documented contract", () => {
    const spine: CriteriaSpineEntry[] = [{ issueNumber: 12, kind: "closing", criterionId: "12:0" }];
    const verdict: SpecGroundingVerdict = {
      findings: [
        { criterionId: "12:0", satisfied: true, rationale: "Handled." },
        { criterionId: "999:0", satisfied: false, rationale: "An invented ID the agent made up." },
      ],
    };
    const result = joinFindingsToSpine(spine, verdict);
    expect(result).toHaveLength(1);
    expect(result[0]?.criterionId).toBe("12:0");
  });

  it("preserves the spine's own order and produces exactly one result per spine entry", () => {
    const spine: CriteriaSpineEntry[] = [
      { issueNumber: 12, kind: "closing", criterionId: "12:0" },
      { issueNumber: 12, kind: "closing", criterionId: "12:1" },
      { issueNumber: 8, kind: "non-closing", criterionId: "8:0" },
    ];
    const verdict: SpecGroundingVerdict = {
      findings: [{ criterionId: "12:1", satisfied: true, rationale: "Done." }],
    };
    const result = joinFindingsToSpine(spine, verdict);
    expect(result.map((r) => r.criterionId)).toEqual(["12:0", "12:1", "8:0"]);
    expect(result[1]?.satisfied).toBe(true);
  });
});

describe("deriveSeverity (F1-S9 slice 3b-iii, issue #12)", () => {
  it("escalates a CLOSING, unsatisfied result to blocker", () => {
    expect(deriveSeverity(joined({ kind: "closing", satisfied: false }))).toBe("blocker");
  });

  it("does NOT escalate a CLOSING, satisfied result", () => {
    expect(deriveSeverity(joined({ kind: "closing", satisfied: true }))).toBe("non-blocking");
  });

  it("does NOT escalate a NON-CLOSING, unsatisfied result", () => {
    expect(deriveSeverity(joined({ kind: "non-closing", satisfied: false }))).toBe("non-blocking");
  });

  it("does NOT escalate a NON-CLOSING, satisfied result", () => {
    expect(deriveSeverity(joined({ kind: "non-closing", satisfied: true }))).toBe("non-blocking");
  });

  it("escalates a CLOSING criterion the agent never addressed at all (defaulted satisfied:false) exactly like an explicitly unsatisfied one", () => {
    expect(
      deriveSeverity(
        joined({ kind: "closing", satisfied: false, rationale: null, addressedByReviewer: false }),
      ),
    ).toBe("blocker");
  });
});

describe("formatRationaleForDisplay (F1-S9 slice 3b-iii, issue #12)", () => {
  it("returns the agent's own rationale text when the criterion was addressed", () => {
    expect(formatRationaleForDisplay(joined({ rationale: "Concrete evidence here." }))).toBe(
      "Concrete evidence here.",
    );
  });

  it("returns an explanatory placeholder, not the agent's rationale, when the criterion was never addressed at all", () => {
    const result = formatRationaleForDisplay(
      joined({ addressedByReviewer: false, rationale: null }),
    );
    expect(result).toMatch(/not addressed/i);
    expect(result).toMatch(/unsatisfied/i);
  });
});

describe("findExistingSpecGroundingSummaryCommentId (F1-S9 slice 3b-iii, issue #12)", () => {
  function comment(overrides: Partial<ExistingComment> = {}): ExistingComment {
    return {
      id: 1,
      body: `some text\n${SPEC_GROUNDING_SUMMARY_COMMENT_MARKER}`,
      authorType: "Bot",
      authorLogin: SPEC_GROUNDING_COMMENT_AUTHOR_LOGIN,
      ...overrides,
    };
  }

  it("finds the prior summary comment by marker + bot identity + exact login", () => {
    expect(findExistingSpecGroundingSummaryCommentId([comment({ id: 42 })])).toBe(42);
  });

  it("returns null when no comment carries the marker", () => {
    expect(findExistingSpecGroundingSummaryCommentId([comment({ body: "unrelated" })])).toBeNull();
  });

  it("does NOT match a comment carrying the marker from a DIFFERENT bot login -- closes the same spoof/echo risk apply-triage-verdict-logic.mts's own identical check closes", () => {
    expect(
      findExistingSpecGroundingSummaryCommentId([comment({ authorLogin: "some-other-bot[bot]" })]),
    ).toBeNull();
  });

  it("does NOT match a comment carrying the marker from a non-Bot author type", () => {
    expect(findExistingSpecGroundingSummaryCommentId([comment({ authorType: "User" })])).toBeNull();
  });

  it("returns null for an empty comment list", () => {
    expect(findExistingSpecGroundingSummaryCommentId([])).toBeNull();
  });
});

describe("buildDroppedClosingIssueResults (F1-S9 slice 3b-iii, issue #12, PR #76 review, L181)", () => {
  it("maps each dropped issue number to its own result", () => {
    expect(buildDroppedClosingIssueResults([12, 34])).toEqual([
      { issueNumber: 12 },
      { issueNumber: 34 },
    ]);
  });

  it("returns an empty array for an empty input", () => {
    expect(buildDroppedClosingIssueResults([])).toEqual([]);
  });
});

describe("buildSpecGroundingSummaryCommentBody (F1-S9 slice 3b-iii, issue #12)", () => {
  it("reports 'no blocking findings' and lists non-blocking findings when there are no blockers at all", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "non-closing", satisfied: false, criterionId: "8:0", issueNumber: 8 })],
      [],
    );
    expect(body).toContain("No blocking findings.");
    expect(body).toContain("Issue #8");
    expect(body).toContain("unsatisfied");
    expect(body.endsWith(SPEC_GROUNDING_SUMMARY_COMMENT_MARKER)).toBe(true);
  });

  it("counts a criterion-level blocker in the total, WITHOUT repeating its rationale in the summary", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "closing", satisfied: false, rationale: "SECRET_RATIONALE_TEXT" })],
      [],
    );
    expect(body).toContain("1 blocking finding(s)");
    expect(body).not.toContain("SECRET_RATIONALE_TEXT");
  });

  it("adds a dropped-closing-issue result to the SAME total blocker count as criterion-level blockers", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "closing", satisfied: false })],
      [{ issueNumber: 99 }],
    );
    expect(body).toContain("2 blocking finding(s)");
  });

  it("reports a dropped-closing-issue-only blocker count correctly when there are no criterion-level blockers at all", () => {
    const body = buildSpecGroundingSummaryCommentBody([], [{ issueNumber: 99 }]);
    expect(body).toContain("1 blocking finding(s)");
  });

  it("reports that no unmet acceptance criteria were found at all when both inputs are empty", () => {
    const body = buildSpecGroundingSummaryCommentBody([], []);
    expect(body).toContain("No unmet acceptance criteria were found at all");
  });

  it("always ends with the tracking marker", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "non-closing", satisfied: true })],
      [],
    );
    expect(body.endsWith(SPEC_GROUNDING_SUMMARY_COMMENT_MARKER)).toBe(true);
  });

  it("lists a satisfied criterion (even a closing one) as non-blocking, with its own rationale visible", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "closing", satisfied: true, rationale: "Confirmed in file Y." })],
      [],
    );
    expect(body).toContain("No blocking findings.");
    expect(body).toContain("satisfied");
    expect(body).toContain("Confirmed in file Y.");
  });
});
