import { describe, expect, it } from "vitest";

import {
  STORY_PLANNER_CONTRACT_MARKER,
  STORY_PLANNER_ESCALATE_MARKER,
} from "../../scripts/factory/post-story-planner-contract.mts";
import {
  READY_TO_SPEC_LABEL,
  computeSweepLabelOperations,
  decideSweepIssue,
  isIssueHandled,
} from "../../scripts/factory/story-planner-sweep-logic.mts";

const ISSUE_NUMBER = 383;
const BOT = { type: "Bot", login: "github-actions[bot]" } as const;

describe("story-planner sweep pure logic", () => {
  // remove guard G10 => this exact-operation test fails.
  it("G10 computes only a ready-to-spec remove and add, with no promotion", () => {
    const operations = computeSweepLabelOperations();
    expect(operations).toEqual([
      { method: "DELETE", label: READY_TO_SPEC_LABEL },
      { method: "POST", label: READY_TO_SPEC_LABEL },
    ]);
    const forbiddenReadiness = [
      "ready-to-implement",
      "ready-for-conventional-implementation",
      "needs-info",
      "wait-to-implement",
      "needs-triage",
      "wontfix",
    ];
    expect(operations.map(({ label }) => label)).not.toEqual(
      expect.arrayContaining(forbiddenReadiness),
    );
  });

  // remove guard G12 => dropping either marker branch re-sweeps its fixture.
  it.each([
    ["contract", STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER)],
    ["escalate", STORY_PLANNER_ESCALATE_MARKER(ISSUE_NUMBER)],
  ])("G12 skips an exact bot-owned terminal %s marker", (_kind, marker) => {
    const comments = [{ body: `trusted prefix\n${marker}`, user: BOT }];
    expect(isIssueHandled(comments, ISSUE_NUMBER)).toBe(true);
    expect(
      decideSweepIssue({ number: ISSUE_NUMBER, state: "open" }, comments),
    ).toEqual({ kind: "skip-handled" });
  });

  // remove guard G12 => loosening exact authorship or terminal anchoring fails.
  it("G12 sweeps only the neither fixture", () => {
    const marker = STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER);
    const neither = [
      { body: `${marker}\ntrailing`, user: BOT },
      { body: marker, user: { type: "User", login: "github-actions[bot]" } },
      { body: STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER + 1), user: BOT },
    ];
    expect(isIssueHandled(neither, ISSUE_NUMBER)).toBe(false);
    expect(
      decideSweepIssue({ number: ISSUE_NUMBER, state: "open" }, neither),
    ).toEqual({ kind: "relabel", operations: computeSweepLabelOperations() });
  });

  // remove guard G13 => permitting a closed relabel makes this test fail.
  it("G13 logs an unhandled closed issue without label operations", () => {
    expect(
      decideSweepIssue({ number: ISSUE_NUMBER, state: "closed" }, []),
    ).toEqual({ kind: "log-closed" });
  });
});
