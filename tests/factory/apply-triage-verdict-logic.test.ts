import { describe, expect, it } from "vitest";
import {
  TRIAGE_COMMENT_MARKER,
  buildFallbackCommentBody,
  buildTriageGenerationMarker,
  buildVerdictCommentBody,
  computeNewLabelSet,
  extractTriageGeneration,
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
  it("finds a prior comment from exactly github-actions[bot] carrying the marker", () => {
    const comments: ExistingComment[] = [
      {
        id: 1,
        body: "unrelated human comment",
        authorType: "User",
        authorLogin: "someone",
      },
      {
        id: 2,
        body: `**Automated triage verdict**\n\n${TRIAGE_COMMENT_MARKER}`,
        authorType: "Bot",
        authorLogin: "github-actions[bot]",
      },
    ];
    expect(findExistingTriageCommentId(comments)).toBe(2);
  });

  it("returns null when no matching comment carries the marker", () => {
    const comments: ExistingComment[] = [
      {
        id: 1,
        body: "unrelated",
        authorType: "User",
        authorLogin: "someone",
      },
    ];
    expect(findExistingTriageCommentId(comments)).toBeNull();
  });

  it("does NOT treat a human comment containing the marker string as our own comment", () => {
    // Defends against a decoy: an untrusted commenter (or a verdict's own
    // reasoning text, echoed back some other way) planting the literal
    // marker string in a non-bot comment. Only a github-actions[bot]
    // comment counts, regardless of body content.
    const comments: ExistingComment[] = [
      {
        id: 1,
        body: `I think this is ready. ${TRIAGE_COMMENT_MARKER}`,
        authorType: "User",
        authorLogin: "someone",
      },
    ];
    expect(findExistingTriageCommentId(comments)).toBeNull();
  });

  it("does NOT treat another bot's comment containing the marker as our own, even with type Bot", () => {
    // The P3 hardening: authorType === "Bot" alone is too broad — a
    // DIFFERENT installed GitHub App or bot could also carry type "Bot"
    // and, deliberately or otherwise, post a comment containing our
    // marker string. Matching on type alone would let apply mistake it
    // for its own prior comment and PATCH (overwrite) it. Only the exact
    // login this workflow's own token posts as counts.
    const comments: ExistingComment[] = [
      {
        id: 1,
        body: `Some other automated comment. ${TRIAGE_COMMENT_MARKER}`,
        authorType: "Bot",
        authorLogin: "dependabot[bot]",
      },
    ];
    expect(findExistingTriageCommentId(comments)).toBeNull();
  });

  it("ignores a matching-login comment that doesn't carry the marker", () => {
    const comments: ExistingComment[] = [
      {
        id: 1,
        body: "some other automated comment",
        authorType: "Bot",
        authorLogin: "github-actions[bot]",
      },
    ];
    expect(findExistingTriageCommentId(comments)).toBeNull();
  });
});

describe("buildVerdictCommentBody", () => {
  it("includes the readiness, reasoning, and marker", () => {
    const body = buildVerdictCommentBody(verdict, "123");
    expect(body).toContain("ready-to-implement");
    expect(body).toContain(verdict.reasoning);
    expect(body.endsWith(TRIAGE_COMMENT_MARKER)).toBe(true);
  });

  it("lists missing-info questions when present", () => {
    const body = buildVerdictCommentBody(
      {
        ...verdict,
        readiness: "needs-info",
        missing_info_questions: ["Which Snowflake role owns this?"],
      },
      "123",
    );
    expect(body).toContain("Which Snowflake role owns this?");
  });

  it("omits the questions section when there are none", () => {
    const body = buildVerdictCommentBody(verdict, "123");
    expect(body).not.toContain("Questions for a human");
  });

  it("tells a human to confirm and close on a wontfix verdict, never closing itself", () => {
    const body = buildVerdictCommentBody(
      {
        ...verdict,
        readiness: "wontfix",
        reasoning: "Superseded by #500.",
      },
      "123",
    );
    expect(body).toContain("maintainer should confirm");
    expect(body).toContain("does not close issues");
  });

  it("omits the wontfix close-confirmation note for other readiness values", () => {
    const body = buildVerdictCommentBody(verdict, "123");
    expect(body).not.toContain("does not close issues");
  });
});

describe("buildFallbackCommentBody", () => {
  it("lists every validation error and ends with the marker", () => {
    const body = buildFallbackCommentBody(
      [
        "readiness must be one of ...",
        "issue_number mismatch: ...",
      ],
      "123",
    );
    expect(body).toContain("readiness must be one of");
    expect(body).toContain("issue_number mismatch");
    expect(body).toContain("needs-triage");
    expect(body.endsWith(TRIAGE_COMMENT_MARKER)).toBe(true);
  });
});

describe("triage generation marker", () => {
  it("round-trips only the marker anchored beside the final factory marker", () => {
    const body =
      `untrusted ${buildTriageGenerationMarker("999")}\n` +
      `${TRIAGE_COMMENT_MARKER}\nordinary rationale\n` +
      buildVerdictCommentBody(verdict, "123");
    expect(extractTriageGeneration(body)).toBe("123");
  });

  it("uses none for legacy history and rejects malformed generation input", () => {
    expect(extractTriageGeneration(`legacy\n${TRIAGE_COMMENT_MARKER}`)).toBe(
      "none",
    );
    expect(() => buildTriageGenerationMarker("not-a-run")).toThrow(
      /positive decimal/,
    );
  });
});
