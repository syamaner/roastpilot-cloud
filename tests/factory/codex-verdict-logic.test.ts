import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CODEX_BOT_LOGIN,
  CODEX_CLEAN_COMMENT_TITLE,
  CODEX_WAIT_TIMEOUT_MINUTES,
  REVIEWED_COMMIT_LINE,
  containsCodexTriggerPhrase,
  isCleanComment,
  isCleanReactionPair,
  isCodexBot,
  isFindingsReview,
  manualTriggerAdvice,
  parseStrictIsoUtc,
  postdates,
  postdatesBoundary,
  reduceCodexVerdict,
  type CodexBoundary,
  type CodexCommentRecord,
  type CodexReactionRecord,
  type CodexReviewRecord,
  type CodexSignalInput,
  type CodexVerdict,
} from "../../scripts/factory/codex-verdict-logic.mts";
import {
  CODEX_TRIGGER_PHRASE,
  CODEX_VERDICT_CRITERION,
} from "../../scripts/factory/implement-patch-logic.mts";

const HEAD = "a".repeat(40);
const PREVIOUS_HEAD = "b".repeat(40);
const BOUNDARY_AT = "2026-08-07T10:00:00Z";
const BEFORE = "2026-08-07T09:59:00Z";
const AFTER = "2026-08-07T10:01:00Z";
const LATER = "2026-08-07T10:02:00Z";
const OPENED: CodexBoundary = { kind: "opened", occurredAt: BOUNDARY_AT };

function cleanBody(sha = HEAD, title = CODEX_CLEAN_COMMENT_TITLE): string {
  return `${title}\n\nReviewed commit: ${sha}`;
}

function comment(overrides: Partial<CodexCommentRecord> = {}): CodexCommentRecord {
  return {
    authorLogin: CODEX_BOT_LOGIN,
    body: cleanBody(),
    createdAt: AFTER,
    channel: "issue-comment",
    ...overrides,
  };
}

function review(overrides: Partial<CodexReviewRecord> = {}): CodexReviewRecord {
  return {
    authorLogin: CODEX_BOT_LOGIN,
    commitSha: HEAD,
    submittedAt: AFTER,
    inlineThreadCount: 1,
    ...overrides,
  };
}

function pair(overrides: {
  eyes?: Partial<CodexReactionRecord>;
  plusOne?: Partial<CodexReactionRecord>;
} = {}): readonly CodexReactionRecord[] {
  return [
    { authorLogin: CODEX_BOT_LOGIN, content: "eyes", createdAt: AFTER, subjectId: "issue:1", ...overrides.eyes },
    { authorLogin: CODEX_BOT_LOGIN, content: "+1", createdAt: LATER, subjectId: "issue:1", ...overrides.plusOne },
  ];
}

function input(overrides: Partial<CodexSignalInput> = {}): CodexSignalInput {
  return {
    headSha: HEAD,
    prState: "ready",
    boundary: OPENED,
    headChangedAt: BEFORE,
    reviews: [],
    topLevelComments: [],
    reactions: [],
    triggerComments: [],
    evaluatedAt: "2026-08-07T10:10:00Z",
    ...overrides,
  };
}

function expectPending(verdict: CodexVerdict, reason?: string): void {
  expect(verdict.verdict).toBe("unknown-pending");
  if (verdict.verdict === "unknown-pending" && reason !== undefined) {
    expect(verdict.reasons).toContain(reason);
  }
}

describe("accepted Codex verdict evidence", () => {
  it("T1 accepts a clean top-level comment after an opened boundary", () => {
    const signal = comment();
    expect(isCodexBot(signal.authorLogin)).toBe(true);
    expect(isCleanComment(signal, HEAD, OPENED)).toBe(true);
    expect(postdatesBoundary(signal.createdAt, OPENED)).toBe(true);
    expect(reduceCodexVerdict(input({ topLevelComments: [signal] }))).toMatchObject({
      verdict: "clean", channel: "clean-comment", ratchetEligible: true,
      evidence: { matchedSha: HEAD, boundaryKind: "opened" },
    });
  });

  it("T2 accepts a same-subject, ordered bot reaction pair", () => {
    const reactions = pair();
    expect(isCleanReactionPair(reactions, OPENED, BEFORE)).toBe(true);
    expect(reduceCodexVerdict(input({ reactions }))).toMatchObject({
      verdict: "clean", channel: "reaction-pair", ratchetEligible: true,
      evidence: { subjectId: "issue:1", eyesAt: AFTER, plusOneAt: LATER },
    });
  });

  it("T3 returns findings for a current bot review with inline threads", () => {
    const finding = review();
    expect(isFindingsReview(finding, HEAD, OPENED)).toBe(true);
    expect(reduceCodexVerdict(input({ reviews: [finding] }))).toMatchObject({
      verdict: "findings", ratchetEligible: true,
      evidence: { matchedSha: HEAD, inlineThreadCount: 1 },
    });
  });

  it("T4 uses opened for a PR created ready without ready_for_review metadata", () => {
    expect(reduceCodexVerdict(input({
      boundary: { kind: "opened", occurredAt: BOUNDARY_AT },
      topLevelComments: [comment()],
    }))).toMatchObject({ verdict: "clean", channel: "clean-comment" });
  });

  it("T5 uses the ready-for-review boundary for a draft marked ready", () => {
    const boundary: CodexBoundary = { kind: "ready-for-review", occurredAt: BOUNDARY_AT };
    expect(reduceCodexVerdict(input({ boundary, topLevelComments: [comment()] })).verdict).toBe("clean");
    expectPending(reduceCodexVerdict(input({
      boundary,
      topLevelComments: [comment({ createdAt: BEFORE })],
    })), "pre-boundary-signal-only");
  });

  it("T6 counts only signals after a manual-retrigger boundary", () => {
    const boundary: CodexBoundary = { kind: "manual-retrigger", occurredAt: BOUNDARY_AT };
    expectPending(reduceCodexVerdict(input({ boundary, topLevelComments: [comment({ createdAt: BEFORE })] })), "pre-boundary-signal-only");
    expect(reduceCodexVerdict(input({ boundary, topLevelComments: [comment()] })).verdict).toBe("clean");
  });

  it("T7 changes timeout advice at 30 minutes without changing the verdict", () => {
    const due = input({ evaluatedAt: "2026-08-07T10:30:00Z" });
    const waiting = input({ evaluatedAt: "2026-08-07T10:29:00Z" });
    expect(manualTriggerAdvice(due)).toBe("due");
    expect(reduceCodexVerdict(due)).toMatchObject({ verdict: "unknown-pending", manualTriggerAdvice: "due" });
    expect(reduceCodexVerdict(waiting)).toMatchObject({ verdict: "unknown-pending", manualTriggerAdvice: "wait" });
  });
});

describe("adversarial evidence fails closed", () => {
  it("T8 rejects a stranger-authored perfect clean comment by byte-exact identity", () => {
    expect(isCodexBot(CODEX_BOT_LOGIN.toUpperCase())).toBe(false);
    expectPending(reduceCodexVerdict(input({
      topLevelComments: [comment({ authorLogin: "stranger" })],
    })), "non-bot-author-signal-only");
  });

  it("T9 rejects a stranger thumbs-up after a genuine bot eyes", () => {
    expectPending(reduceCodexVerdict(input({ reactions: pair({ plusOne: { authorLogin: "stranger" } }) })), "unpaired-or-misordered-reactions");
  });

  it("T10 rejects a bot thumbs-up after a stranger eyes", () => {
    expectPending(reduceCodexVerdict(input({ reactions: pair({ eyes: { authorLogin: "stranger" } }) })), "unpaired-or-misordered-reactions");
  });

  it("T11 rejects a bare thumbs-up and a thumbs-up before eyes", () => {
    expectPending(reduceCodexVerdict(input({ reactions: [pair()[1]] })), "unpaired-or-misordered-reactions");
    expectPending(reduceCodexVerdict(input({
      reactions: pair({ eyes: { createdAt: LATER }, plusOne: { createdAt: AFTER } }),
    })), "unpaired-or-misordered-reactions");
  });

  it.each([
    ["previous full head", PREVIOUS_HEAD],
    ["short head", HEAD.slice(0, 7)],
    ["uppercase head", HEAD.toUpperCase()],
  ])("T12 rejects a Reviewed commit naming a %s", (_label, sha) => {
    expectPending(reduceCodexVerdict(input({ topLevelComments: [comment({ body: cleanBody(sha) })] })), "stale-head-signal-only");
  });

  it("T12 excludes a bot review on a previous head", () => {
    expectPending(reduceCodexVerdict(input({
      reviews: [review({ commitSha: PREVIOUS_HEAD })],
    })), "stale-head-signal-only");
  });

  it("T13 rejects a current-head clean comment before the boundary", () => {
    expectPending(reduceCodexVerdict(input({
      topLevelComments: [comment({ createdAt: BEFORE })],
    })), "pre-boundary-signal-only");
    expectPending(reduceCodexVerdict(input({
      reviews: [review({ submittedAt: BEFORE })],
    })), "pre-boundary-signal-only");
  });

  it("T14 rejects equality at the boundary because postdating is strict", () => {
    expect(postdates(BOUNDARY_AT, BOUNDARY_AT)).toBe(false);
    expectPending(reduceCodexVerdict(input({
      topLevelComments: [comment({ createdAt: BOUNDARY_AT })],
    })), "pre-boundary-signal-only");
  });

  it("T15 rejects clean text in a review-thread reply", () => {
    expectPending(reduceCodexVerdict(input({
      topLevelComments: [comment({ channel: "review-thread-reply" })],
    })), "unrecognised-bot-comment-only");
  });

  it("T16 rejects a near-miss title and the exact title embedded in prose", () => {
    const nearMiss = cleanBody("a".repeat(40), "Codex Review: didn't find major issues");
    const embedded = cleanBody(HEAD, `Notice: ${CODEX_CLEAN_COMMENT_TITLE} today`);
    for (const body of [nearMiss, embedded]) {
      expectPending(reduceCodexVerdict(input({ topLevelComments: [comment({ body })] })), "unrecognised-bot-comment-only");
    }
    expect(isCleanComment(comment({ body: cleanBody(HEAD, `## ${CODEX_CLEAN_COMMENT_TITLE}`) }), HEAD, OPENED)).toBe(true);
  });

  it.each(["queued", "skipped", "unable to review"])("T17 rejects a bot head-naming %s notice", (state) => {
    const body = `Review ${state}.\nReviewed commit: ${HEAD}`;
    expectPending(reduceCodexVerdict(input({ topLevelComments: [comment({ body })] })), "unrecognised-bot-comment-only");
  });

  it("T18 rejects bot reactions on different subjects", () => {
    expectPending(reduceCodexVerdict(input({
      reactions: pair({ plusOne: { subjectId: "issue:2" } }),
    })), "unpaired-or-misordered-reactions");
  });

  it("T19 requires determinate proof that thumbs-up follows the current head push", () => {
    expectPending(reduceCodexVerdict(input({ reactions: pair(), headChangedAt: null })), "head-change-indeterminate");
    expectPending(reduceCodexVerdict(input({
      reactions: pair(), headChangedAt: "2026-08-07T10:03:00Z",
    })), "stale-head-signal-only");
  });

  it("T20 treats a posted bot review with zero inline threads as findings, never clean", () => {
    expect(reduceCodexVerdict(input({ reviews: [review({ inlineThreadCount: 0 })] }))).toMatchObject({
      verdict: "findings", evidence: { inlineThreadCount: 0 },
    });
  });

  it("T21 gives findings precedence over coexisting clean evidence", () => {
    expect(reduceCodexVerdict(input({
      reviews: [review()], topLevelComments: [comment()], reactions: pair(),
    })).verdict).toBe("findings");
  });

  it("T22 keeps empty evidence pending with no-bot-signal and waits inside timeout", () => {
    expect(reduceCodexVerdict(input())).toMatchObject({
      verdict: "unknown-pending", reasons: ["no-bot-signal"],
      manualTriggerAdvice: "wait", ratchetEligible: false,
    });
  });
});

describe("closed input grammar and operator advice", () => {
  it.each([
    ["headSha", { headSha: "short" }],
    ["boundary kind", { boundary: { kind: "unknown", occurredAt: BOUNDARY_AT } }],
    ["PR state", { prState: "merged" }],
    ["timestamp", { evaluatedAt: "August 7, 2026 10:10 UTC" }],
    ["reaction content", { reactions: [{ ...pair()[0], content: "heart" }] }],
  ])("T23 returns malformed-input without throwing for malformed %s", (_label, override) => {
    const malformed = { ...input(), ...override } as unknown as CodexSignalInput;
    expect(() => reduceCodexVerdict(malformed)).not.toThrow();
    expect(reduceCodexVerdict(malformed)).toEqual({
      verdict: "unknown-pending", reasons: ["malformed-input"],
      manualTriggerAdvice: "wait", ratchetEligible: false,
    });
  });

  it("T23 rejects non-calendar dates and non-UTC ISO lookalikes", () => {
    expect(parseStrictIsoUtc("2026-02-30T10:00:00Z")).toBeNull();
    expect(parseStrictIsoUtc("2026-08-07T10:00:00+00:00")).toBeNull();
    expect(parseStrictIsoUtc(BOUNDARY_AT)).not.toBeNull();
    expect(manualTriggerAdvice({ ...input(), headSha: "short" })).toBe("wait");
    expect(reduceCodexVerdict(null as unknown as CodexSignalInput)).toEqual({
      verdict: "unknown-pending", reasons: ["malformed-input"],
      manualTriggerAdvice: "wait", ratchetEligible: false,
    });
  });

  it("T23 contains hostile structural access without throwing", () => {
    const hostile = new Proxy(input(), {
      ownKeys: () => { throw new Error("untrusted structure"); },
    });
    expect(() => reduceCodexVerdict(hostile)).not.toThrow();
    expect(reduceCodexVerdict(hostile)).toEqual({
      verdict: "unknown-pending", reasons: ["malformed-input"],
      manualTriggerAdvice: "wait", ratchetEligible: false,
    });
  });

  it("T24 never advises a manual trigger while the PR is a draft", () => {
    expect(reduceCodexVerdict(input({
      prState: "draft", evaluatedAt: "2026-08-07T11:00:00Z",
    }))).toMatchObject({ verdict: "unknown-pending", manualTriggerAdvice: "not-applicable-draft" });
  });

  it("T25 does not count a current-sha trigger posted before the boundary", () => {
    expect(reduceCodexVerdict(input({
      evaluatedAt: "2026-08-07T10:30:00Z",
      triggerComments: [{ createdAt: BEFORE, onHeadSha: HEAD }],
    }))).toMatchObject({ verdict: "unknown-pending", manualTriggerAdvice: "due" });
  });

  it("T26 counts only a post-boundary trigger on this head", () => {
    const earlierHead = input({
      evaluatedAt: "2026-08-07T10:30:00Z",
      triggerComments: [{ createdAt: AFTER, onHeadSha: PREVIOUS_HEAD }],
    });
    const thisHead = input({
      evaluatedAt: "2026-08-07T11:00:00Z",
      triggerComments: [{ createdAt: AFTER, onHeadSha: HEAD }],
    });
    expect(manualTriggerAdvice(earlierHead)).toBe("due");
    expect(manualTriggerAdvice(thisHead)).toBe("already-posted");
    expect(containsCodexTriggerPhrase(`please ${CODEX_TRIGGER_PHRASE} now`)).toBe(true);
    expect(containsCodexTriggerPhrase("please review")).toBe(false);
  });

  it("T27 pins ratchet eligibility as literal false for pending and true otherwise", () => {
    const pending = reduceCodexVerdict(input());
    const clean = reduceCodexVerdict(input({ topLevelComments: [comment()] }));
    const findings = reduceCodexVerdict(input({ reviews: [review()] }));
    if (pending.verdict === "unknown-pending") { const literal: false = pending.ratchetEligible; expect(literal).toBe(false); }
    if (clean.verdict === "clean") { const literal: true = clean.ratchetEligible; expect(literal).toBe(true); }
    if (findings.verdict === "findings") { const literal: true = findings.ratchetEligible; expect(literal).toBe(true); }
  });

  it("T28 is deterministic and the pure module has no time, randomness, fs, or network capability", () => {
    const sample = input({ topLevelComments: [comment()], reactions: pair() });
    expect(reduceCodexVerdict(sample)).toEqual(reduceCodexVerdict(sample));
    const source = readFileSync(new URL("../../scripts/factory/codex-verdict-logic.mts", import.meta.url), "utf8");
    for (const banned of ["Date.now", "Math.random", "node:fs", "node:http", "node:https", "fetch("]) {
      expect(source).not.toContain(banned);
    }
  });

  it("T29 keeps reducer machine constants in lockstep with the operator criterion", () => {
    expect(CODEX_VERDICT_CRITERION).toContain(CODEX_BOT_LOGIN);
    expect(CODEX_VERDICT_CRITERION).toContain(CODEX_CLEAN_COMMENT_TITLE);
    expect(CODEX_VERDICT_CRITERION).toContain("Reviewed commit:");
    expect(REVIEWED_COMMIT_LINE.source).toContain("Reviewed commit:");
    expect(CODEX_WAIT_TIMEOUT_MINUTES).toBe(30);
  });
});
