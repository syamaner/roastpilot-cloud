import { describe, expect, it } from "vitest";
import {
  TRIAGE_COMMENT_MARKER,
  buildFallbackCommentBody,
  buildVerdictCommentBody,
  computeNewLabelSet,
  findExistingTriageCommentId,
  type ExistingComment,
} from "../../scripts/factory/apply-triage-verdict-logic.mts";
import type { TriageVerdict } from "../../scripts/factory/triage-verdict-schema.mts";

const verdict: TriageVerdict = {
  issue_number: 42,
  readiness: "ready-to-implement",
  reasoning: "Plan link, acceptance criteria, scope, and size are all present.",
  missing_info_questions: [],
};

describe("computeNewLabelSet", () => {
  it("adds the readiness label when none was present", () => {
    expect(computeNewLabelSet(["epic:C2"], "ready-to-implement")).toEqual([
      "epic:C2",
      "ready-to-implement",
    ]);
  });

  it("replaces an existing readiness label, preserving non-readiness labels", () => {
    const result = computeNewLabelSet(
      ["needs-triage", "epic:F1"],
      "ready-to-implement",
    );
    expect(result.sort()).toEqual(["epic:F1", "ready-to-implement"].sort());
  });

  it("never produces more than one readiness label even if the issue somehow had several", () => {
    const result = computeNewLabelSet(
      ["needs-triage", "needs-info", "epic:C3"],
      "ready-to-spec",
    );
    const readinessCount = result.filter((l) =>
      ["needs-triage", "ready-to-implement", "ready-to-spec", "needs-info", "wait-to-implement", "wontfix"].includes(l),
    ).length;
    expect(readinessCount).toBe(1);
    expect(result).toContain("ready-to-spec");
    expect(result).toContain("epic:C3");
  });

  it("is idempotent: re-running with the same readiness produces the same set", () => {
    const first = computeNewLabelSet(["epic:C2"], "wait-to-implement");
    const second = computeNewLabelSet(first, "wait-to-implement");
    expect(second.sort()).toEqual(first.sort());
  });
});

describe("findExistingTriageCommentId", () => {
  it("finds a prior bot comment carrying the marker", () => {
    const comments: ExistingComment[] = [
      { id: 1, body: "unrelated human comment", authorType: "User" },
      {
        id: 2,
        body: `**Automated triage verdict**\n\n${TRIAGE_COMMENT_MARKER}`,
        authorType: "Bot",
      },
    ];
    expect(findExistingTriageCommentId(comments)).toBe(2);
  });

  it("returns null when no bot comment carries the marker", () => {
    const comments: ExistingComment[] = [
      { id: 1, body: "unrelated", authorType: "User" },
    ];
    expect(findExistingTriageCommentId(comments)).toBeNull();
  });

  it("does NOT treat a human comment containing the marker string as our own comment", () => {
    // Defends against a decoy: an untrusted commenter (or a verdict's own
    // reasoning text, echoed back some other way) planting the literal
    // marker string in a non-bot comment. Only a Bot-authored comment
    // counts, regardless of body content.
    const comments: ExistingComment[] = [
      {
        id: 1,
        body: `I think this is ready. ${TRIAGE_COMMENT_MARKER}`,
        authorType: "User",
      },
    ];
    expect(findExistingTriageCommentId(comments)).toBeNull();
  });

  it("ignores a bot comment that doesn't carry the marker", () => {
    const comments: ExistingComment[] = [
      { id: 1, body: "some other automated comment", authorType: "Bot" },
    ];
    expect(findExistingTriageCommentId(comments)).toBeNull();
  });
});

describe("buildVerdictCommentBody", () => {
  it("includes the readiness, reasoning, and marker", () => {
    const body = buildVerdictCommentBody(verdict);
    expect(body).toContain("ready-to-implement");
    expect(body).toContain(verdict.reasoning);
    expect(body.endsWith(TRIAGE_COMMENT_MARKER)).toBe(true);
  });

  it("lists missing-info questions when present", () => {
    const body = buildVerdictCommentBody({
      ...verdict,
      readiness: "needs-info",
      missing_info_questions: ["Which Snowflake role owns this?"],
    });
    expect(body).toContain("Which Snowflake role owns this?");
  });

  it("omits the questions section when there are none", () => {
    const body = buildVerdictCommentBody(verdict);
    expect(body).not.toContain("Questions for a human");
  });
});

describe("buildFallbackCommentBody", () => {
  it("lists every validation error and ends with the marker", () => {
    const body = buildFallbackCommentBody([
      "readiness must be one of ...",
      "issue_number mismatch: ...",
    ]);
    expect(body).toContain("readiness must be one of");
    expect(body).toContain("issue_number mismatch");
    expect(body).toContain("needs-triage");
    expect(body.endsWith(TRIAGE_COMMENT_MARKER)).toBe(true);
  });
});
