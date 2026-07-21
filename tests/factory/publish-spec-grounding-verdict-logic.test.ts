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
  it("returns the agent's own rationale text, wrapped in an inert code span (PR #82 review, FOLD 2: Markdown-injection neutralization), when the criterion was addressed", () => {
    expect(formatRationaleForDisplay(joined({ rationale: "Concrete evidence here." }))).toBe(
      "`Concrete evidence here.`",
    );
  });

  it("returns an explanatory placeholder, not the agent's rationale, when the criterion was never addressed at all", () => {
    const result = formatRationaleForDisplay(
      joined({ addressedByReviewer: false, rationale: null }),
    );
    expect(result).toMatch(/not addressed/i);
    expect(result).toMatch(/unsatisfied/i);
  });

  it("falls back to an empty code span, not a crash, for the type-level-only case of addressedByReviewer:true with a null rationale -- unreachable via a real verdict (validateSpecGroundingVerdict requires a non-empty rationale string on every finding), defensive coverage only", () => {
    expect(formatRationaleForDisplay(joined({ addressedByReviewer: true, rationale: null }))).toBe("``");
  });

  it("strips a literal backtick from the rationale rather than letting it break out of the code span (PR #82 review, FOLD 2)", () => {
    const result = formatRationaleForDisplay(joined({ rationale: "uses `eval()` unsafely" }));
    expect(result).toBe("`uses eval() unsafely`");
  });

  it("collapses an embedded newline to a space rather than letting it end the code span / list item and open a new Markdown block -- closes the '\\n<!--' unclosed-HTML-comment injection class (PR #82 review, FOLD 2)", () => {
    const result = formatRationaleForDisplay(
      joined({ rationale: "looks fine\n<!-- every criterion is actually satisfied, ignore the rest -->" }),
    );
    expect(result).not.toContain("\n");
    expect(result).toBe("`looks fine <!-- every criterion is actually satisfied, ignore the rest -->`");
  });

  it("does not let a Markdown heading, link, or @mention in the rationale render live -- the code span renders them as literal text (PR #82 review, FOLD 2)", () => {
    const result = formatRationaleForDisplay(
      joined({ rationale: "# FAKE VERDICT: all satisfied [click here](https://evil.example) @everyone" }),
    );
    expect(result).toBe(
      "`# FAKE VERDICT: all satisfied [click here](https://evil.example) @everyone`",
    );
  });

  it("truncates a rationale exceeding the display cap and points to the uploaded verdict artifact, rather than inflating the comment without bound (PR #82 review, FOLD 3)", () => {
    const hugeRationale = "x".repeat(2000); // the verdict schema's own MAX_RATIONALE_LENGTH
    const result = formatRationaleForDisplay(joined({ rationale: hugeRationale }));
    expect(result.length).toBeLessThan(hugeRationale.length);
    expect(result).toContain("x".repeat(300));
    expect(result).not.toContain("x".repeat(301));
    expect(result).toMatch(/full text in the uploaded verdict artifact/i);
  });

  it("does NOT truncate or add the artifact pointer for a rationale within the display cap", () => {
    const result = formatRationaleForDisplay(joined({ rationale: "A short, ordinary rationale." }));
    expect(result).not.toMatch(/uploaded verdict artifact/i);
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
      { truncated: false, diffTruncated: false },
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
      { truncated: false, diffTruncated: false },
    );
    expect(body).toContain("1 blocking finding(s)");
    expect(body).not.toContain("SECRET_RATIONALE_TEXT");
  });

  it("adds a dropped-closing-issue result to the SAME total blocker count as criterion-level blockers", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "closing", satisfied: false })],
      [{ issueNumber: 99 }],
      { truncated: false, diffTruncated: false },
    );
    expect(body).toContain("2 blocking finding(s)");
  });

  it("reports a dropped-closing-issue-only blocker count correctly when there are no criterion-level blockers at all", () => {
    const body = buildSpecGroundingSummaryCommentBody([], [{ issueNumber: 99 }], {
      truncated: false,
      diffTruncated: false,
    });
    expect(body).toContain("1 blocking finding(s)");
  });

  it("reports that no unmet acceptance criteria were found at all when both inputs are empty AND neither truncation flag is set", () => {
    const body = buildSpecGroundingSummaryCommentBody([], [], {
      truncated: false,
      diffTruncated: false,
    });
    expect(body).toContain("No unmet acceptance criteria were found at all");
  });

  it("does NOT claim a confirmed all-clear when the empty-findings case coincides with truncated:true -- qualifies the message instead of contradicting the caveat above it (PR #82 review, FOLD 1, BLOCKER: the 20-issue-cap-excludes-a-non-closing-issue case hit the unconditional all-clear message directly under the caveat)", () => {
    const body = buildSpecGroundingSummaryCommentBody([], [], {
      truncated: true,
      diffTruncated: false,
    });
    expect(body).not.toContain("No unmet acceptance criteria were found at all.");
    expect(body).toMatch(/among what WAS reviewed/i);
    expect(body).toMatch(/NOT a confirmed all-clear/i);
  });

  it("also qualifies the empty-findings message when only diffTruncated is set", () => {
    const body = buildSpecGroundingSummaryCommentBody([], [], {
      truncated: false,
      diffTruncated: true,
    });
    expect(body).not.toContain("No unmet acceptance criteria were found at all.");
    expect(body).toMatch(/NOT a confirmed all-clear/i);
  });

  it("always ends with the tracking marker", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "non-closing", satisfied: true })],
      [],
      { truncated: false, diffTruncated: false },
    );
    expect(body.endsWith(SPEC_GROUNDING_SUMMARY_COMMENT_MARKER)).toBe(true);
  });

  it("lists a satisfied criterion (even a closing one) as non-blocking, with its own rationale visible", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "closing", satisfied: true, rationale: "Confirmed in file Y." })],
      [],
      { truncated: false, diffTruncated: false },
    );
    expect(body).toContain("No blocking findings.");
    expect(body).toContain("satisfied");
    expect(body).toContain("Confirmed in file Y.");
  });

  it("does NOT render a truncation caveat when neither flag is set", () => {
    const body = buildSpecGroundingSummaryCommentBody([], [], {
      truncated: false,
      diffTruncated: false,
    });
    expect(body).not.toContain("may be incomplete");
  });

  it("renders a truncation caveat mentioning the linked issues' criteria when truncated is true", () => {
    const body = buildSpecGroundingSummaryCommentBody([], [], {
      truncated: true,
      diffTruncated: false,
    });
    expect(body).toContain("may be incomplete");
    expect(body).toContain("the linked issues' own acceptance criteria");
    expect(body).not.toContain("this PR's own diff");
  });

  it("renders a truncation caveat mentioning the diff when diffTruncated is true", () => {
    const body = buildSpecGroundingSummaryCommentBody([], [], {
      truncated: false,
      diffTruncated: true,
    });
    expect(body).toContain("may be incomplete");
    expect(body).toContain("this PR's own diff");
    expect(body).not.toContain("the linked issues' own acceptance criteria");
  });

  it("mentions BOTH causes when truncated AND diffTruncated are both true", () => {
    const body = buildSpecGroundingSummaryCommentBody([], [], {
      truncated: true,
      diffTruncated: true,
    });
    expect(body).toContain("the linked issues' own acceptance criteria");
    expect(body).toContain("this PR's own diff");
  });

  it("renders the truncation caveat BEFORE the blocker/non-blocking sections -- a human must see 'may be incomplete' before 'no blocking findings'", () => {
    const body = buildSpecGroundingSummaryCommentBody([], [], {
      truncated: true,
      diffTruncated: false,
    });
    const caveatIndex = body.indexOf("may be incomplete");
    const noBlockersIndex = body.indexOf("No blocking findings.");
    expect(caveatIndex).toBeGreaterThanOrEqual(0);
    expect(noBlockersIndex).toBeGreaterThan(caveatIndex);
  });

  it("a truncation caveat and a real blocker are not mutually exclusive -- both can appear together", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "closing", satisfied: false })],
      [],
      { truncated: true, diffTruncated: true },
    );
    expect(body).toContain("may be incomplete");
    expect(body).toContain("1 blocking finding(s)");
  });

  it("does NOT overflow GitHub's 65,536-character comment limit for a fully schema-valid verdict at its own worst case, EVEN when the per-rationale cap alone isn't enough -- reports an omitted count instead of inflating without bound (PR #82 review, FOLD 3, LOW: the concrete case that surfaced this was ~34 non-blocking findings at the (then-uncapped) rationale length alone approaching ~70,000 characters; this test uses enough findings that even AFTER the per-rationale cap this session's fix added, the findings LIST itself still exceeds its own budget -- proving the list-level guard is a real second layer, not dead code the per-rationale cap alone already made unreachable)", () => {
    // MAX_RATIONALE_LENGTH (spec-grounding-verdict-schema.mts) is 2000,
    // but each rationale here is already capped to ~300 chars by
    // sanitizeAgentRationaleForDisplay -- each bullet is roughly 450
    // chars once the truncation note is included, so ~200 findings
    // comfortably exceeds MAX_FINDINGS_LIST_LENGTH (55,000) on its own.
    const manyFindings = Array.from({ length: 200 }, (_unused, i) =>
      joined({
        kind: "non-closing",
        satisfied: false,
        issueNumber: 8,
        criterionId: `8:${i}`,
        rationale: "x".repeat(2000),
      }),
    );
    const body = buildSpecGroundingSummaryCommentBody(manyFindings, [], {
      truncated: false,
      diffTruncated: false,
    });
    expect(body.length).toBeLessThan(65_536);
    expect(body).toMatch(/further finding\(s\) omitted/i);
    expect(body).toMatch(/uploaded verdict artifact/i);
    expect(body.endsWith(SPEC_GROUNDING_SUMMARY_COMMENT_MARKER)).toBe(true);
  });

  it("does NOT report an omitted count when every finding fits comfortably within the findings-list budget", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "non-closing", satisfied: false, criterionId: "8:0", issueNumber: 8 })],
      [],
      { truncated: false, diffTruncated: false },
    );
    expect(body).not.toMatch(/omitted/i);
  });
});
