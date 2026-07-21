import { describe, expect, it } from "vitest";
import {
  bodyContainsMarkerAsStandaloneLine,
  buildSpecGroundingFallbackCommentBody,
  buildSpecGroundingSummaryCommentBody,
  deriveSeverity,
  findExistingSpecGroundingSummaryCommentId,
  formatRationaleForDisplay,
  isDiffTruncationUnverifiableForClosing,
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

describe("isDiffTruncationUnverifiableForClosing (F1-S9 slice 3b-iii, issue #12, PR #82 round 3 review, holistic pass, FOLD 3)", () => {
  it("returns false when diffTruncated is false, regardless of closing references present", () => {
    expect(
      isDiffTruncationUnverifiableForClosing([joined({ kind: "closing" })], [], false),
    ).toBe(false);
  });

  it("returns false when diffTruncated is true but this run has NO closing-kind reference at all", () => {
    expect(
      isDiffTruncationUnverifiableForClosing([joined({ kind: "non-closing" })], [], true),
    ).toBe(false);
  });

  it("returns true when diffTruncated is true and a joined entry is closing-kind, EVEN when satisfied:true -- a satisfied closing criterion is exactly the case this escalation exists to catch", () => {
    expect(
      isDiffTruncationUnverifiableForClosing(
        [joined({ kind: "closing", satisfied: true })],
        [],
        true,
      ),
    ).toBe(true);
  });

  it("returns true when diffTruncated is true and a joined entry is closing-kind and unsatisfied", () => {
    expect(
      isDiffTruncationUnverifiableForClosing(
        [joined({ kind: "closing", satisfied: false })],
        [],
        true,
      ),
    ).toBe(true);
  });

  it("returns true when diffTruncated is true and there are NO joined entries at all, but there IS an unreviewed closing issue -- a fully/partially-dropped closing issue still counts as a closing reference", () => {
    expect(
      isDiffTruncationUnverifiableForClosing([], [{ issueNumber: 99, truncationKind: "fully-dropped" }], true),
    ).toBe(true);
  });

  it("returns false when diffTruncated is true but joined has only non-closing entries and unreviewedClosingIssues is empty", () => {
    expect(
      isDiffTruncationUnverifiableForClosing(
        [joined({ kind: "non-closing" }), joined({ kind: "non-closing" })],
        [],
        true,
      ),
    ).toBe(false);
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

  it("neutralizes a bidi override character into a visible [U+XXXX] marker rather than letting it survive inside the code span (PR #82 round 2 review, FOLD 3, BLOCKER -- a code span stops Markdown/HTML interpretation but NOT Unicode bidi visual reordering, a Trojan-Source-style spoof under the bot's own identity)", () => {
    const result = formatRationaleForDisplay(
      joined({ rationale: "looks fine \u202eflaw a is siht\u202c really" }),
    );
    expect(result).not.toContain("\u202e");
    expect(result).not.toContain("\u202c");
    expect(result).toContain("[U+202E]");
    expect(result).toContain("[U+202C]");
  });

  it.each([
    ["LRE (U+202A)", "\u202a"],
    ["RLE (U+202B)", "\u202b"],
    ["RLO (U+202E)", "\u202e"],
    ["LRI (U+2066)", "\u2066"],
    ["PDI (U+2069)", "\u2069"],
  ])("neutralizes %s, not just the one bidi character round 2's finding named explicitly -- the shared categorical primitive covers the whole bidi-control range, not an ad-hoc enumeration", (_label, ch) => {
    const result = formatRationaleForDisplay(joined({ rationale: `before${ch}after` }));
    expect(result).not.toContain(ch);
    expect(result).toMatch(/\[U\+[0-9A-F]{4}\]/);
  });

  it("truncates on a CODE POINT boundary, never splitting a surrogate pair into an unpaired half (PR #82 round 2 review, FOLD 4, LOW)", () => {
    // 299 ASCII characters, then an astral emoji (U+1F600, a surrogate
    // pair in UTF-16) straddling the naive .slice(0, 300) cut point --
    // a plain UTF-16-unit slice would split the emoji's own surrogate
    // pair in half, leaving a lone unpaired surrogate.
    const rationale = "x".repeat(299) + "\u{1F600}" + "y".repeat(50);
    const result = formatRationaleForDisplay(joined({ rationale }));
    // A lone unpaired surrogate makes JSON.stringify throw when strict,
    // or round-trips as U+FFFD -- assert the emoji is either wholly
    // present or wholly absent, never split.
    const hasWholeEmoji = result.includes("\u{1F600}");
    const hasLoneHighSurrogate = /\ud83d(?!\ude00)/.test(result);
    const hasLoneLowSurrogate = /(?<!\ud83d)\ude00/.test(result);
    expect(hasLoneHighSurrogate).toBe(false);
    expect(hasLoneLowSurrogate).toBe(false);
    // With exactly 300 code points allowed and 299 ASCII chars before it,
    // the emoji IS the 300th code point and should be included whole.
    expect(hasWholeEmoji).toBe(true);
  });

  it("counts an astral character as ONE code point toward the display cap, not two UTF-16 units -- confirms the cap is measured in code points consistently (PR #82 round 2 review, FOLD 4)", () => {
    // 300 astral emoji = 300 code points but 600 UTF-16 code units --
    // if the cap were still measured in .length (UTF-16 units), this
    // would incorrectly truncate at 150 emoji, not 300.
    const rationale = "\u{1F600}".repeat(300);
    const result = formatRationaleForDisplay(joined({ rationale }));
    expect(result).not.toMatch(/uploaded verdict artifact/i);
    expect(result).toBe(`\`${rationale}\``);
  });
});

describe("bodyContainsMarkerAsStandaloneLine (F1-S9 slice 3b-iii, issue #12, PR #82 round 4 review, Codex, FOLD 1, BLOCKER)", () => {
  it("matches when the marker is its own whole line", () => {
    expect(bodyContainsMarkerAsStandaloneLine(`some text\n${SPEC_GROUNDING_SUMMARY_COMMENT_MARKER}`, SPEC_GROUNDING_SUMMARY_COMMENT_MARKER)).toBe(true);
  });

  it("matches when the marker's line has ordinary surrounding whitespace", () => {
    expect(
      bodyContainsMarkerAsStandaloneLine(`some text\n  ${SPEC_GROUNDING_SUMMARY_COMMENT_MARKER}  \n`, SPEC_GROUNDING_SUMMARY_COMMENT_MARKER),
    ).toBe(true);
  });

  it("does NOT match when the marker is only a SUBSTRING of a longer line -- the cross-feature hijack this closes: implement-patch-logic.mts's buildGamingFlagAnnotation renders attacker-influenced content through a sanitizer that PRESERVES literal marker strings, so a flagged line could embed our marker mid-line without being our own comment", () => {
    expect(
      bodyContainsMarkerAsStandaloneLine(
        `- somepath.ts: line contains ${SPEC_GROUNDING_SUMMARY_COMMENT_MARKER} embedded mid-line`,
        SPEC_GROUNDING_SUMMARY_COMMENT_MARKER,
      ),
    ).toBe(false);
  });

  it("does NOT match a body that never contains the marker at all", () => {
    expect(bodyContainsMarkerAsStandaloneLine("unrelated content", SPEC_GROUNDING_SUMMARY_COMMENT_MARKER)).toBe(false);
  });

  it("does NOT match when the marker is only a PREFIX or SUFFIX of a longer line", () => {
    expect(
      bodyContainsMarkerAsStandaloneLine(`${SPEC_GROUNDING_SUMMARY_COMMENT_MARKER} trailing text`, SPEC_GROUNDING_SUMMARY_COMMENT_MARKER),
    ).toBe(false);
    expect(
      bodyContainsMarkerAsStandaloneLine(`leading text ${SPEC_GROUNDING_SUMMARY_COMMENT_MARKER}`, SPEC_GROUNDING_SUMMARY_COMMENT_MARKER),
    ).toBe(false);
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

  it("does NOT match a github-actions[bot] comment whose body merely CONTAINS the marker substring embedded mid-line -- the exact cross-feature-hijack scenario PR #82 round 4 review (Codex) found: implement-patch-logic.mts's buildGamingFlagAnnotation, same real bot identity, a flagged line embedding our marker as a substring, must never be mistaken for our own summary and PATCHed over (which would erase the anti-gaming warning it exists to preserve)", () => {
    const gamingFlagAnnotation = comment({
      id: 7,
      body:
        "> 🚩 **This diff was flagged by the deterministic anti-gaming classifier (F1-S9) — " +
        "the `no-auto-chain` label FAILED to apply — flagged for manual review anyway.**\n\n" +
        "**Coverage- or mutation-suppression comment(s) added:**\n" +
        `- scripts/factory/evil.mts: \`# pragma: no cover ${SPEC_GROUNDING_SUMMARY_COMMENT_MARKER} extra text\`\n`,
    });
    expect(findExistingSpecGroundingSummaryCommentId([gamingFlagAnnotation])).toBeNull();
  });
});

describe("buildSpecGroundingSummaryCommentBody (F1-S9 slice 3b-iii, issue #12)", () => {
  it("reports 'no blocking findings' and lists non-blocking findings when there are no blockers at all", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "non-closing", satisfied: false, criterionId: "8:0", issueNumber: 8 })],
      [],
      { truncated: false, diffTruncated: false },
      true,
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
      true,
    );
    expect(body).toContain("1 blocking finding(s)");
    expect(body).not.toContain("SECRET_RATIONALE_TEXT");
  });

  it("when blockersPostedInline is true, tells the reader the blockers were posted as inline comments and to see those threads, not this summary", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "closing", satisfied: false })],
      [],
      { truncated: false, diffTruncated: false },
      true,
    );
    expect(body).toMatch(/reported as separate, resolvable inline review comment/i);
    expect(body).toMatch(/see those threads, not this summary/i);
    expect(body).not.toMatch(/listed below in THIS summary/i);
  });

  it("when blockersPostedInline is false, does NOT claim the blockers were posted inline, and instead points the reader at THIS summary (PR #83 review, MEDIUM -- an earlier version unconditionally directed the reader to nonexistent inline threads in the anchor-fallback case, where the full blocker detail sits in this very summary via buildAnchorFallbackSummarySupplement)", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "closing", satisfied: false })],
      [],
      { truncated: false, diffTruncated: false },
      false,
    );
    expect(body).not.toMatch(/reported as separate, resolvable inline review comment/i);
    expect(body).not.toMatch(/see those threads, not this summary/i);
    expect(body).toMatch(/listed below in THIS summary/i);
    expect(body).toMatch(/no addable line to anchor them to/i);
    expect(body).toMatch(/no inline thread for/i);
  });

  it("still explains what counts as a blocking finding regardless of blockersPostedInline's value", () => {
    const inlineBody = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "closing", satisfied: false })],
      [],
      { truncated: false, diffTruncated: false },
      true,
    );
    const fallbackBody = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "closing", satisfied: false })],
      [],
      { truncated: false, diffTruncated: false },
      false,
    );
    const explanation = /criterion this PR's own closing keyword references that the reviewer found unsatisfied/i;
    expect(inlineBody).toMatch(explanation);
    expect(fallbackBody).toMatch(explanation);
  });

  it("adds an unreviewed-closing-issue result to the SAME total blocker count as criterion-level blockers", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "closing", satisfied: false })],
      [{ issueNumber: 99, truncationKind: "fully-dropped" }],
      { truncated: false, diffTruncated: false },
      true,
    );
    expect(body).toContain("2 blocking finding(s)");
  });

  it("reports a dropped-closing-issue-only blocker count correctly when there are no criterion-level blockers at all", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [],
      [{ issueNumber: 99, truncationKind: "fully-dropped" }],
      { truncated: false, diffTruncated: false },
      true,
    );
    expect(body).toContain("1 blocking finding(s)");
  });

  it("reports that no unmet acceptance criteria were found at all when both inputs are empty AND neither truncation flag is set", () => {
    const body = buildSpecGroundingSummaryCommentBody([], [], { truncated: false, diffTruncated: false }, true);
    expect(body).toContain("No unmet acceptance criteria were found at all");
  });

  it("does NOT claim a confirmed all-clear when the empty-findings case coincides with truncated:true -- qualifies the message instead of contradicting the caveat above it (PR #82 review, FOLD 1, BLOCKER: the 20-issue-cap-excludes-a-non-closing-issue case hit the unconditional all-clear message directly under the caveat)", () => {
    const body = buildSpecGroundingSummaryCommentBody([], [], { truncated: true, diffTruncated: false }, true);
    expect(body).not.toContain("No unmet acceptance criteria were found at all.");
    expect(body).toMatch(/among what WAS reviewed/i);
    expect(body).toMatch(/NOT a confirmed all-clear/i);
  });

  it("also qualifies the empty-findings message when only diffTruncated is set", () => {
    const body = buildSpecGroundingSummaryCommentBody([], [], { truncated: false, diffTruncated: true }, true);
    expect(body).not.toContain("No unmet acceptance criteria were found at all.");
    expect(body).toMatch(/NOT a confirmed all-clear/i);
  });

  it("always ends with the tracking marker", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "non-closing", satisfied: true })],
      [],
      { truncated: false, diffTruncated: false },
      true,
    );
    expect(body.endsWith(SPEC_GROUNDING_SUMMARY_COMMENT_MARKER)).toBe(true);
  });

  it("lists a satisfied criterion (even a closing one) as non-blocking, with its own rationale visible", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "closing", satisfied: true, rationale: "Confirmed in file Y." })],
      [],
      { truncated: false, diffTruncated: false },
      true,
    );
    expect(body).toContain("No blocking findings.");
    expect(body).toContain("satisfied");
    expect(body).toContain("Confirmed in file Y.");
  });

  it("does NOT render a truncation caveat when neither flag is set", () => {
    const body = buildSpecGroundingSummaryCommentBody([], [], { truncated: false, diffTruncated: false }, true);
    expect(body).not.toContain("may be incomplete");
  });

  it("renders a truncation caveat mentioning the linked issues' criteria when truncated is true", () => {
    const body = buildSpecGroundingSummaryCommentBody([], [], { truncated: true, diffTruncated: false }, true);
    expect(body).toContain("may be incomplete");
    expect(body).toContain("the linked issues' own acceptance criteria");
    expect(body).not.toContain("this PR's own diff");
  });

  it("renders a truncation caveat mentioning the diff when diffTruncated is true", () => {
    const body = buildSpecGroundingSummaryCommentBody([], [], { truncated: false, diffTruncated: true }, true);
    expect(body).toContain("may be incomplete");
    expect(body).toContain("this PR's own diff");
    expect(body).not.toContain("the linked issues' own acceptance criteria");
  });

  it("mentions BOTH causes when truncated AND diffTruncated are both true", () => {
    const body = buildSpecGroundingSummaryCommentBody([], [], { truncated: true, diffTruncated: true }, true);
    expect(body).toContain("the linked issues' own acceptance criteria");
    expect(body).toContain("this PR's own diff");
  });

  it("renders the truncation caveat BEFORE the blocker/non-blocking sections -- a human must see 'may be incomplete' before 'no blocking findings'", () => {
    const body = buildSpecGroundingSummaryCommentBody([], [], { truncated: true, diffTruncated: false }, true);
    const caveatIndex = body.indexOf("may be incomplete");
    const noBlockersIndex = body.indexOf("No blocking findings.");
    expect(caveatIndex).toBeGreaterThanOrEqual(0);
    expect(noBlockersIndex).toBeGreaterThan(caveatIndex);
  });

  it("a truncation caveat and a real blocker are not mutually exclusive -- both can appear together", () => {
    // diffTruncated stays false here specifically so this test isolates
    // its own original intent (caveat + criterion blocker coexisting)
    // from the diffTruncated-adds-its-own-blocker mechanic, which has
    // its own dedicated tests below.
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "closing", satisfied: false })],
      [],
      { truncated: true, diffTruncated: false },
      true,
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
    const body = buildSpecGroundingSummaryCommentBody(manyFindings, [], { truncated: false, diffTruncated: false }, true);
    expect(body.length).toBeLessThan(65_536);
    expect(body).toMatch(/further finding\(s\) omitted/i);
    // PR #82 round 4 review, Codex, FOLD 2, LOW: points to BOTH artifacts,
    // not only the verdict -- an omitted UNADDRESSED finding has no entry
    // in the verdict artifact at all, only in criteria-spine.
    expect(body).toMatch(/uploaded criteria-spine and verdict artifacts/i);
    expect(body.endsWith(SPEC_GROUNDING_SUMMARY_COMMENT_MARKER)).toBe(true);
  });

  it("explains why an unaddressed finding specifically needs the criteria-spine artifact, not just the verdict, in the omitted-count note (PR #82 round 4 review, Codex, FOLD 2, LOW -- an unaddressed finding has no verdict entry at all)", () => {
    // Many UNADDRESSED closing... no, non-closing (non-blocking) findings,
    // each with a long-enough surrounding bullet that the list budget is
    // exceeded -- addressedByReviewer:false entries have no rationale of
    // their own at all, so this specifically exercises the omitted-count
    // note's own claim about unaddressed findings.
    const manyUnaddressed = Array.from({ length: 2000 }, (_unused, i) =>
      joined({
        kind: "non-closing",
        satisfied: false,
        issueNumber: 8,
        criterionId: `8:${i}`,
        addressedByReviewer: false,
        rationale: null,
      }),
    );
    const body = buildSpecGroundingSummaryCommentBody(manyUnaddressed, [], { truncated: false, diffTruncated: false }, true);
    expect(body).toMatch(/further finding\(s\) omitted/i);
    expect(body).toMatch(/never addressed at all only appears in the criteria-spine artifact/i);
  });

  it("does NOT report an omitted count when every finding fits comfortably within the findings-list budget", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "non-closing", satisfied: false, criterionId: "8:0", issueNumber: 8 })],
      [],
      { truncated: false, diffTruncated: false },
      true,
    );
    expect(body).not.toMatch(/omitted/i);
  });

  it("counts the diff-truncation blocker in the total when diffTruncated is true and this run has a closing reference, EVEN when that criterion is satisfied and there are no other blockers at all (PR #82 round 3 review, holistic pass, FOLD 3)", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "closing", satisfied: true })],
      [],
      { truncated: false, diffTruncated: true },
      true,
    );
    expect(body).toContain("1 blocking finding(s)");
    expect(body).not.toContain("No blocking findings.");
  });

  it("does NOT count a diff-truncation blocker when diffTruncated is true but this run has no closing reference at all", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "non-closing", satisfied: false })],
      [],
      { truncated: false, diffTruncated: true },
      true,
    );
    expect(body).toContain("No blocking findings.");
  });

  it("adds the diff-truncation blocker ON TOP of an existing criterion blocker's own count, when both apply", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "closing", satisfied: false })],
      [],
      { truncated: false, diffTruncated: true },
      true,
    );
    expect(body).toContain("2 blocking finding(s)");
  });

  it("mentions the diff-truncation blocker class in the blocking-findings paragraph", () => {
    const body = buildSpecGroundingSummaryCommentBody(
      [joined({ kind: "closing", satisfied: true })],
      [],
      { truncated: false, diffTruncated: true },
      true,
    );
    expect(body).toMatch(/diff having been itself truncated/i);
  });
});

describe("buildSpecGroundingFallbackCommentBody (F1-S9 slice 3b-iii-d, issue #12)", () => {
  it("lists every reason given, not just the first", () => {
    const body = buildSpecGroundingFallbackCommentBody([
      "the review pipeline did not complete",
      "the verdict artifact was malformed",
    ]);
    expect(body).toContain("the review pipeline did not complete");
    expect(body).toContain("the verdict artifact was malformed");
  });

  it("explains this PR is NOT reviewed and needs a manual check", () => {
    const body = buildSpecGroundingFallbackCommentBody(["some reason"]);
    expect(body).toMatch(/could not run to completion/i);
    expect(body).toMatch(/NOT yet reviewed/i);
  });

  it("ends with the SAME marker a normal summary uses, so a later successful rerun upserts over this fallback rather than leaving both comments behind", () => {
    const body = buildSpecGroundingFallbackCommentBody(["some reason"]);
    expect(bodyContainsMarkerAsStandaloneLine(body, SPEC_GROUNDING_SUMMARY_COMMENT_MARKER)).toBe(true);
  });

  it("is found by findExistingSpecGroundingSummaryCommentId, exactly like a normal summary comment would be", () => {
    const body = buildSpecGroundingFallbackCommentBody(["some reason"]);
    const comments: ExistingComment[] = [
      { id: 42, body, authorType: "Bot", authorLogin: SPEC_GROUNDING_COMMENT_AUTHOR_LOGIN },
    ];
    expect(findExistingSpecGroundingSummaryCommentId(comments)).toBe(42);
  });

  it("truncates a single reason exceeding the per-reason display cap, rather than echoing an untrusted-sized value verbatim (PR #84 review, Codex, FOLD 2)", () => {
    const hugeReason = "x".repeat(10_000);
    const body = buildSpecGroundingFallbackCommentBody([hugeReason]);
    expect(body.length).toBeLessThan(2000);
    expect(body).toContain("…");
    expect(body).not.toContain(hugeReason);
  });

  it("caps a single reason on a CODE POINT boundary, never splitting a surrogate pair (same discipline as sanitizeAgentRationaleForDisplay)", () => {
    // An astral emoji (2 UTF-16 units, 1 code point) placed exactly at the
    // 500-code-point cap boundary -- a naive UTF-16 .slice() would split it.
    const reason = "a".repeat(499) + "\u{1F600}" + "b".repeat(50);
    const body = buildSpecGroundingFallbackCommentBody([reason]);
    // No lone surrogate anywhere in the body.
    for (let i = 0; i < body.length; i++) {
      const code = body.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = body.charCodeAt(i + 1);
        expect(next).toBeGreaterThanOrEqual(0xdc00);
        expect(next).toBeLessThanOrEqual(0xdfff);
      }
    }
  });

  it("does NOT truncate a reason within the per-reason display cap", () => {
    const reason = "a short, ordinary reason";
    const body = buildSpecGroundingFallbackCommentBody([reason]);
    expect(body).toContain(reason);
    expect(body).not.toContain(`${reason}…`);
  });

  it("bounds the TOTAL reasons list length even when every individual reason is within its own per-reason cap, reporting an omitted count rather than growing unboundedly (PR #84 review, Codex, FOLD 2, MEDIUM)", () => {
    // 500 reasons at ~490 chars each (within the 500-char per-reason cap,
    // so each survives individually) totals ~245,000 chars -- well past
    // the 50,000-char list budget, so this specifically exercises the
    // LIST-level cap, not the per-reason one.
    const manyReasons = Array.from({ length: 500 }, (_unused, i) => `entries[${i}] ` + "x".repeat(480));
    const body = buildSpecGroundingFallbackCommentBody(manyReasons);
    expect(body.length).toBeLessThan(65_536);
    expect(body).toMatch(/further reason\(s\) omitted/i);
  });

  it("never exceeds GitHub's 65,536-character comment limit even at the worst case (many reasons, each at the per-reason cap)", () => {
    const worstCaseReasons = Array.from({ length: 2000 }, () => "x".repeat(600));
    const body = buildSpecGroundingFallbackCommentBody(worstCaseReasons);
    expect(body.length).toBeLessThan(65_536);
  });

  it("does not report an omitted-reason count when every reason fits comfortably within the list budget", () => {
    const body = buildSpecGroundingFallbackCommentBody(["one reason", "another reason"]);
    expect(body).not.toMatch(/omitted/i);
  });

  it("wraps each reason in an inert Markdown code span, neutralizing an injection attempt (PR #84 review round 2, Codex, FOLD 1) -- validation errors can embed agent/issue-controlled content verbatim (an unknown-key name, an invalid field value), exactly as untrusted as a rationale once posted", () => {
    const body = buildSpecGroundingFallbackCommentBody([
      'unexpected key(s): "\nhidden instruction after a raw newline"',
    ]);
    // The reason's own embedded raw newline never reaches the body as a
    // real newline (it stays inside a single-line code span) -- the
    // injected text and the reason's own leading text stay on the SAME
    // line, collapsed by a space rather than a real line break that
    // could have ended the containing list item / opened a new block.
    expect(body).toContain('`unexpected key(s): " hidden instruction after a raw newline"`');
  });

  it("strips a literal backtick from a reason so it cannot break OUT of the code span it gets wrapped in", () => {
    const body = buildSpecGroundingFallbackCommentBody(["a reason with a `backtick` in it"]);
    // Exactly one code span (2 backtick pairs = 4 backticks) wraps the
    // WHOLE sanitized reason -- the embedded backticks were stripped, not
    // left to prematurely close the span.
    const backtickCount = (body.match(/`/g) ?? []).length;
    expect(backtickCount).toBe(2);
  });

  it("escapes an invisible/bidi-override character in a reason, the same categorical defense sanitizeAgentRationaleForDisplay already applies to rationale text", () => {
    const body = buildSpecGroundingFallbackCommentBody([`reason with a bidi override \u202e here`]);
    expect(body).not.toContain("\u202e");
    expect(body).toMatch(/\[U\+202E\]/);
  });
});
