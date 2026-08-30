import { describe, expect, it } from "vitest";

import {
  STORY_PLANNER_CONTRACT_ISSUE_PREFIX,
  STORY_PLANNER_CONTRACT_MARKER,
  STORY_PLANNER_ESCALATE_MARKER,
} from "../../scripts/factory/post-story-planner-contract.mts";
import {
  extractStoryPlannerContractRevision,
  isStoryPlannerBotMarkerComment,
  isStoryPlannerBotMarkerPrefixComment,
} from "../../scripts/factory/story-planner-marker.mts";
import {
  READY_TO_SPEC_LABEL,
  computeSweepLabelOperations,
  decideSweepIssue,
  isIssueHandled,
} from "../../scripts/factory/story-planner-sweep-logic.mts";

const ISSUE_NUMBER = 383;
const BOT = { type: "Bot", login: "github-actions[bot]" } as const;
const CONTRACT_REVISION = "c".repeat(64);
const DIFFERENT_REVISION = "d".repeat(64);

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
    ["contract", STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER, CONTRACT_REVISION)],
    ["escalate", STORY_PLANNER_ESCALATE_MARKER(ISSUE_NUMBER)],
  ])("G12 skips a bot-owned terminal %s marker", (_kind, marker) => {
    const comments = [{ body: `trusted prefix\n${marker}`, user: BOT }];
    expect(isIssueHandled(comments, ISSUE_NUMBER, CONTRACT_REVISION)).toBe(true);
    expect(
      decideSweepIssue({
        number: ISSUE_NUMBER,
        state: "open",
        currentRevision: CONTRACT_REVISION,
      }, comments),
    ).toEqual({ kind: "skip-handled" });
  });

  it("G12 matches the jq oracle's terminal-newline matrix", () => {
    const contractMarker = STORY_PLANNER_CONTRACT_MARKER(
      ISSUE_NUMBER,
      CONTRACT_REVISION,
    );
    const contractPrefix = STORY_PLANNER_CONTRACT_ISSUE_PREFIX(ISSUE_NUMBER);
    const escalationMarker = STORY_PLANNER_ESCALATE_MARKER(ISSUE_NUMBER);
    const cases = [
      ["", true],
      ["\n", true],
      ["\r\n", false],
      ["\r", false],
      ["\n\n", false],
    ] as const;

    for (const [suffix, expected] of cases) {
      const contract = { body: `${contractMarker}${suffix}`, user: BOT };
      const escalation = { body: `${escalationMarker}${suffix}`, user: BOT };
      expect(isStoryPlannerBotMarkerPrefixComment(contract, contractPrefix)).toBe(
        expected,
      );
      expect(isStoryPlannerBotMarkerComment(escalation, escalationMarker)).toBe(
        expected,
      );
      if (suffix === "\r\n" || suffix === "\r") {
        expect(() => isIssueHandled([contract], ISSUE_NUMBER, CONTRACT_REVISION)).toThrow(
          "malformed story-planner contract marker",
        );
      } else {
        expect(isIssueHandled([contract], ISSUE_NUMBER, CONTRACT_REVISION)).toBe(expected);
      }
      expect(isIssueHandled([escalation], ISSUE_NUMBER, CONTRACT_REVISION)).toBe(expected);
    }
  });

  // remove guard G12 => loosening exact authorship or terminal anchoring fails.
  it("G12 sweeps only the neither fixture", () => {
    const marker = STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER, CONTRACT_REVISION);
    const neither = [
      { body: `${marker}\ntrailing`, user: BOT },
      { body: marker, user: { type: "User", login: "github-actions[bot]" } },
      {
        body: STORY_PLANNER_CONTRACT_MARKER(
          ISSUE_NUMBER + 1,
          DIFFERENT_REVISION,
        ),
        user: BOT,
      },
    ];
    expect(isIssueHandled(neither, ISSUE_NUMBER, CONTRACT_REVISION)).toBe(false);
    expect(
      decideSweepIssue({
        number: ISSUE_NUMBER,
        state: "open",
        currentRevision: CONTRACT_REVISION,
      }, neither),
    ).toEqual({ kind: "relabel", operations: computeSweepLabelOperations() });
  });

  it("G-H3-sweep treats a stale marker as unhandled so planning can recover", () => {
    const comments = [{
      body: STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER, DIFFERENT_REVISION),
      user: BOT,
    }];
    expect(isIssueHandled(comments, ISSUE_NUMBER, CONTRACT_REVISION)).toBe(false);
    expect(decideSweepIssue({
      number: ISSUE_NUMBER,
      state: "open",
      currentRevision: CONTRACT_REVISION,
    }, comments)).toEqual({
      kind: "relabel",
      operations: computeSweepLabelOperations(),
    });
  });

  it("G12 rejects an issue-prefix marker without the required terminator", () => {
    const markerWithoutTerminator =
      `${STORY_PLANNER_CONTRACT_ISSUE_PREFIX(ISSUE_NUMBER)}` +
      `rev-${CONTRACT_REVISION}`;
    const comment = { body: markerWithoutTerminator, user: BOT };

    expect(
      isStoryPlannerBotMarkerPrefixComment(
        comment,
        STORY_PLANNER_CONTRACT_ISSUE_PREFIX(ISSUE_NUMBER),
      ),
    ).toBe(false);
  });

  // remove guard G13 => permitting a closed relabel makes this test fail.
  it("G13 logs an unhandled closed issue without label operations", () => {
    expect(
      decideSweepIssue({
        number: ISSUE_NUMBER,
        state: "closed",
        currentRevision: CONTRACT_REVISION,
      }, []),
    ).toEqual({ kind: "log-closed" });
  });

  it("T-H3-extract returns only this issue's exact bot-authored terminal revision", () => {
    const marker = STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER, CONTRACT_REVISION);
    expect(extractStoryPlannerContractRevision({ body: `contract\n${marker}`, user: BOT }, ISSUE_NUMBER))
      .toBe(CONTRACT_REVISION);
    expect(extractStoryPlannerContractRevision({ body: marker, user: BOT }, ISSUE_NUMBER + 1))
      .toBeNull();
    expect(extractStoryPlannerContractRevision({
      body: marker,
      user: { type: "User", login: "github-actions[bot]" },
    }, ISSUE_NUMBER)).toBeNull();
    expect(extractStoryPlannerContractRevision({ body: "ordinary", user: BOT }, ISSUE_NUMBER))
      .toBeNull();
  });

  it("T-H3-malformed-marker rejects a malformed bot-owned contract prefix", () => {
    const malformed = {
      body: `${STORY_PLANNER_CONTRACT_ISSUE_PREFIX(ISSUE_NUMBER)}rev-not-hex -->`,
      user: BOT,
    };
    expect(() => extractStoryPlannerContractRevision(malformed, ISSUE_NUMBER)).toThrow(
      "malformed story-planner contract marker",
    );
    expect(() => isIssueHandled([malformed], ISSUE_NUMBER, CONTRACT_REVISION)).toThrow(
      "malformed story-planner contract marker",
    );
  });
});
