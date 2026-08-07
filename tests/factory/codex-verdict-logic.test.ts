import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CODEX_BOT_LOGIN,
  CODEX_CLEAN_COMMENT_TITLE,
  CODEX_WAIT_TIMEOUT_MINUTES,
  containsCodexTriggerPhrase,
  isCleanComment,
  isCleanReactionPair,
  isCodexBot,
  isFindingsReview,
  manualTriggerAdvice,
  postdates,
  postdatesBoundary,
  reduceCodexVerdict,
  type CodexVerdict,
} from "../../scripts/factory/codex-verdict-logic.mts";
import {
  parseStrictIsoUtc,
  type CodexBoundary,
  type CodexCommentRecord,
  type CodexReactionRecord,
  type CodexReviewRecord,
  type CodexSignalInput,
} from "../../scripts/factory/codex-signal-schema.mts";
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
    evidenceComplete: { reviews: true, topLevelComments: true, reactions: true },
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

function expectMalformed(value: unknown, advice: "wait" | "not-applicable-draft" = "wait"): void {
  expect(reduceCodexVerdict(value as CodexSignalInput)).toEqual({
    verdict: "unknown-pending",
    reasons: ["malformed-input"],
    manualTriggerAdvice: advice,
    ratchetEligible: false,
  });
}

describe("accepted Codex verdict evidence", () => {
  it("T1 accepts a clean top-level comment after an opened boundary", () => {
    const signal = comment();
    expect(isCodexBot(signal.authorLogin)).toBe(true);
    expect(isCleanComment(signal, HEAD, OPENED, BEFORE)).toBe(true);
    expect(postdatesBoundary(signal.createdAt, OPENED)).toBe(true);
    expect(reduceCodexVerdict(input({ topLevelComments: [signal] }))).toEqual({
      verdict: "clean",
      channel: "clean-comment",
      evidence: {
        channel: "clean-comment", authorLogin: CODEX_BOT_LOGIN,
        matchedSha: HEAD, signalAt: AFTER, boundaryKind: "opened",
        boundaryOccurredAt: BOUNDARY_AT,
      },
      ratchetEligible: true,
    });
  });

  it("T2 accepts a same-subject, ordered bot reaction pair", () => {
    const boundary: CodexBoundary = {
      kind: "ready-for-review", occurredAt: BOUNDARY_AT,
    };
    const reactions = pair();
    expect(isCleanReactionPair(reactions, boundary, BEFORE)).toBe(true);
    expect(reduceCodexVerdict(input({ boundary, reactions }))).toEqual({
      verdict: "clean",
      channel: "reaction-pair",
      evidence: {
        channel: "reaction-pair", authorLogin: CODEX_BOT_LOGIN,
        subjectId: "issue:1", eyesAt: AFTER, plusOneAt: LATER,
        headChangedAt: BEFORE, boundaryKind: "ready-for-review",
        boundaryOccurredAt: BOUNDARY_AT,
      },
      ratchetEligible: true,
    });
  });

  it("T3 returns findings for a current bot review with inline threads", () => {
    const finding = review();
    expect(isFindingsReview(finding, HEAD, OPENED)).toBe(true);
    expect(reduceCodexVerdict(input({ reviews: [finding] }))).toEqual({
      verdict: "findings",
      evidence: {
        authorLogin: CODEX_BOT_LOGIN, matchedSha: HEAD,
        submittedAt: AFTER, inlineThreadCount: 1,
        boundaryKind: "opened", boundaryOccurredAt: BOUNDARY_AT,
      },
      ratchetEligible: true,
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
    for (const source of ["reviews", "topLevelComments", "reactions"] as const) {
      const evidenceComplete = { ...due.evidenceComplete, [source]: false };
      expect(manualTriggerAdvice(input({ ...due, evidenceComplete }))).toBe("wait");
    }
    expect(reduceCodexVerdict(due)).toMatchObject({ verdict: "unknown-pending", manualTriggerAdvice: "due" });
    expect(reduceCodexVerdict(waiting)).toMatchObject({ verdict: "unknown-pending", manualTriggerAdvice: "wait" });
  });

  it.each([
    ["clean comment", { topLevelComments: [comment()] }],
    ["reaction pair", { reactions: pair() }],
    ["findings review", { reviews: [review()] }],
  ])("gates draft %s evidence from every ratchet-eligible verdict", (_label, evidence) => {
    expect(reduceCodexVerdict(input({ prState: "draft", ...evidence }))).toEqual({
      verdict: "unknown-pending",
      reasons: ["not-ready-draft"],
      manualTriggerAdvice: "not-applicable-draft",
      ratchetEligible: false,
    });
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

  it("deduplicates the same pending reason produced by comment and review channels", () => {
    const verdict = reduceCodexVerdict(input({
      topLevelComments: [comment({ body: cleanBody(PREVIOUS_HEAD) })],
      reviews: [review({ commitSha: PREVIOUS_HEAD })],
    }));
    expectPending(verdict, "stale-head-signal-only");
    if (verdict.verdict === "unknown-pending") {
      expect(verdict.reasons.filter((reason) =>
        reason === "stale-head-signal-only")).toHaveLength(1);
    }
  });

  it("G-c requires full SHA equality rather than a shared seven-character prefix", () => {
    const samePrefixHead = `${HEAD.slice(0, 7)}${"b".repeat(33)}`;
    expectPending(reduceCodexVerdict(input({
      topLevelComments: [comment({ body: cleanBody(samePrefixHead) })],
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

  it("requires a current-head clean comment to strictly postdate the head push", () => {
    for (const headChangedAt of [AFTER, LATER]) {
      expectPending(reduceCodexVerdict(input({
        headChangedAt, topLevelComments: [comment({ createdAt: AFTER })],
      })), "stale-head-signal-only");
    }
    expectPending(reduceCodexVerdict(input({
      headChangedAt: null, topLevelComments: [comment()],
    })), "head-change-indeterminate");
    expect(reduceCodexVerdict(input({
      headChangedAt: AFTER, topLevelComments: [comment({ createdAt: LATER })],
    }))).toMatchObject({ verdict: "clean", channel: "clean-comment" });
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
    expect(isCleanComment(
      comment({ body: cleanBody(HEAD, `## ${CODEX_CLEAN_COMMENT_TITLE}`) }),
      HEAD,
      OPENED,
      BEFORE,
    )).toBe(true);
  });

  it.each(["", " \t"])("rejects an empty or whitespace-only title body", (body) => {
    expectPending(reduceCodexVerdict(input({
      topLevelComments: [comment({ body })],
    })), "unrecognised-bot-comment-only");
  });

  it.each(["```", "~~~"])("rejects an exact title quoted inside a %s fence", (fence) => {
    const body = `${fence}text\n${CODEX_CLEAN_COMMENT_TITLE}\nReviewed commit: ${HEAD}\n${fence}`;
    expectPending(reduceCodexVerdict(input({
      topLevelComments: [comment({ body })],
    })), "unrecognised-bot-comment-only");
  });

  it("requires the title as the first non-blank line and accepts both title forms", () => {
    for (const body of [
      `> ${CODEX_CLEAN_COMMENT_TITLE}\nReviewed commit: ${HEAD}`,
      `<pre>\n${CODEX_CLEAN_COMMENT_TITLE}\n</pre>\nReviewed commit: ${HEAD}`,
      `<blockquote>\n${CODEX_CLEAN_COMMENT_TITLE}\n</blockquote>\nReviewed commit: ${HEAD}`,
      `Some notice\n${CODEX_CLEAN_COMMENT_TITLE}\nReviewed commit: ${HEAD}`,
    ]) {
      expectPending(reduceCodexVerdict(input({ topLevelComments: [comment({ body })] })), "unrecognised-bot-comment-only");
    }
    for (const title of [CODEX_CLEAN_COMMENT_TITLE, `## ${CODEX_CLEAN_COMMENT_TITLE}`]) {
      expect(reduceCodexVerdict(input({
        topLevelComments: [comment({ body: `\n \t\n${cleanBody(HEAD, title)}` })],
      }))).toMatchObject({ verdict: "clean", channel: "clean-comment" });
    }
  });

  it.each([
    ["single-line HTML-comment title", `<!-- ${CODEX_CLEAN_COMMENT_TITLE} -->\nReviewed commit: ${HEAD}`],
    ["multi-line HTML-comment title", `<!--\n${CODEX_CLEAN_COMMENT_TITLE}\n-->\nReviewed commit: ${HEAD}`],
    ["U+2028-prefixed reviewed-commit", `${CODEX_CLEAN_COMMENT_TITLE}\njunk\u2028Reviewed commit: ${HEAD}`],
    ["U+2029-prefixed reviewed-commit", `${CODEX_CLEAN_COMMENT_TITLE}\njunk\u2029Reviewed commit: ${HEAD}`],
    ["Markdown-prefixed reviewed-commit", `${CODEX_CLEAN_COMMENT_TITLE}\n> Reviewed commit: ${HEAD}`],
  ])("rejects clean grammar with a non-authenticating %s", (_label, body) => {
    expectPending(reduceCodexVerdict(input({ topLevelComments: [comment({ body })] })), "unrecognised-bot-comment-only");
  });

  it.each([
    ["fenced reviewed-commit", `${CODEX_CLEAN_COMMENT_TITLE}\n\`\`\`\nReviewed commit: ${HEAD}\n\`\`\``],
    ["lone-CR fenced reviewed-commit", `${CODEX_CLEAN_COMMENT_TITLE}\r\`\`\`\rReviewed commit: ${HEAD}\r\`\`\``],
    ["HTML-comment reviewed-commit", `${CODEX_CLEAN_COMMENT_TITLE}\n<!--\nReviewed commit: ${HEAD}\n-->`],
    ["preformatted reviewed-commit", `${CODEX_CLEAN_COMMENT_TITLE}\n<pre>\nReviewed commit: ${HEAD}\n</pre>`],
    ["HTML-blockquoted reviewed-commit", `${CODEX_CLEAN_COMMENT_TITLE}\n<blockquote>\nReviewed commit: ${HEAD}\n</blockquote>`],
  ])("accepts an authenticated title with a %s anywhere", (_label, body) => {
    expect(reduceCodexVerdict(input({ topLevelComments: [comment({ body })] })))
      .toMatchObject({ verdict: "clean", channel: "clean-comment" });
  });

  it("accepts visible clean grammar alongside unrelated hidden markdown", () => {
    const body = [CODEX_CLEAN_COMMENT_TITLE, "<!-- one -->", "<!-- two -->", "```text",
      "example", "```", "> quote", `Reviewed commit: ${HEAD}`].join("\n");
    expect(reduceCodexVerdict(input({ topLevelComments: [comment({ body })] })))
      .toMatchObject({ verdict: "clean", channel: "clean-comment" });
    expect(reduceCodexVerdict(input({
      topLevelComments: [comment({ body: cleanBody().replaceAll("\n", "\r") })],
    }))).toMatchObject({ verdict: "clean", channel: "clean-comment" });
  });

  it.each(["queued", "skipped", "unable to review"])("T17 rejects a bot head-naming %s notice", (state) => {
    const body = `Review ${state}.\nReviewed commit: ${HEAD}`;
    expectPending(reduceCodexVerdict(input({ topLevelComments: [comment({ body })] })), "unrecognised-bot-comment-only");
  });

  it("T18 rejects bot reactions on different or empty subjects", () => {
    expectPending(reduceCodexVerdict(input({
      reactions: pair({ plusOne: { subjectId: "issue:2" } }),
    })), "unpaired-or-misordered-reactions");
    const verdict = reduceCodexVerdict(input({
      reactions: pair({ eyes: { subjectId: "" }, plusOne: { subjectId: "" } }),
    }));
    expectPending(verdict, "unpaired-or-misordered-reactions");
    expect(verdict.ratchetEligible).toBe(false);
  });

  it("T19 requires determinate proof that thumbs-up follows the current head push", () => {
    expectPending(reduceCodexVerdict(input({ reactions: pair(), headChangedAt: null })), "head-change-indeterminate");
    expectPending(reduceCodexVerdict(input({
      reactions: pair(), headChangedAt: "2026-08-07T10:03:00Z",
    })), "stale-head-signal-only");
  });

  it("G-e classifies an ordered bot pair before a manual-retrigger as pre-boundary", () => {
    const boundary: CodexBoundary = {
      kind: "manual-retrigger",
      occurredAt: "2026-08-07T10:03:00Z",
    };
    expectPending(reduceCodexVerdict(input({ boundary, reactions: pair() })), "pre-boundary-signal-only");
  });

  it("T20 treats a posted bot review with zero inline threads as findings, never clean", () => {
    expect(reduceCodexVerdict(input({ reviews: [review({ inlineThreadCount: 0 })] }))).toMatchObject({
      verdict: "findings", evidence: { inlineThreadCount: 0 },
    });
  });

  it("G-d rejects a non-bot findings review on the current head after the boundary", () => {
    expectPending(reduceCodexVerdict(input({
      reviews: [review({ authorLogin: "stranger" })],
    })), "non-bot-author-signal-only");
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

  it.each(["reviews", "topLevelComments", "reactions"] as const)(
    "gates clean when %s evidence is incomplete",
    (source) => {
      const evidenceComplete = { ...input().evidenceComplete, [source]: false };
      expectPending(reduceCodexVerdict(input({
        evidenceComplete, topLevelComments: [comment()],
      })), "evidence-incomplete");
    },
  );

  it("accepts complete clean evidence but does not completeness-gate findings", () => {
    expect(reduceCodexVerdict(input({ topLevelComments: [comment()] }))).toMatchObject({ verdict: "clean" });
    expectPending(reduceCodexVerdict(input({
      evidenceComplete: { reviews: false, topLevelComments: true, reactions: true }, reactions: pair(),
    })), "evidence-incomplete");
    expect(reduceCodexVerdict(input({
      evidenceComplete: { reviews: false, topLevelComments: true, reactions: true },
      reviews: [review()],
    }))).toMatchObject({ verdict: "findings" });
  });
});

describe("closed input grammar and operator advice", () => {
  it.each([
    ["headSha", { headSha: "short" }],
    ["non-hex 40-character headSha", { headSha: "g".repeat(40) }],
    ["boundary kind", { boundary: { kind: "unknown", occurredAt: BOUNDARY_AT } }],
    ["PR state", { prState: "merged" }],
    ["timestamp", { evaluatedAt: "August 7, 2026 10:10 UTC" }],
    ["reaction content", { reactions: [{ ...pair()[0], content: "heart" }] }],
    ["review commit SHA", { reviews: [review({ commitSha: HEAD.slice(0, 7) })] }],
    ["non-hex 40-character review SHA", { reviews: [review({ commitSha: "g".repeat(40) })] }],
    ["trigger head SHA", { triggerComments: [{ createdAt: AFTER, onHeadSha: "not-hex" }] }],
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

  it.each([
    ["null boundary", { boundary: null }],
    ["string boundary", { boundary: "opened" }],
    ["array boundary", { boundary: [] }],
    ["null review", { reviews: [null] }],
    ["string comment", { topLevelComments: ["x"] }],
    ["numeric reaction", { reactions: [42] }],
    ["array trigger", { triggerComments: [[]] }],
  ])("G-a rejects a non-object nested value: %s", (_label, override) => {
    expectMalformed({ ...input(), ...override });
  });

  it("G-b rejects extra and missing keys at top-level and in nested records", () => {
    const extraTop = { ...input(), unexpected: true };
    const extraNested = {
      ...input(),
      topLevelComments: [{ ...comment(), unexpected: true }],
    };
    const missingTop: Record<string, unknown> = { ...input() };
    delete missingTop.evaluatedAt;
    const missingReview: Record<string, unknown> = { ...review() };
    delete missingReview.commitSha;
    const missingNested = { ...input(), reviews: [missingReview] };
    for (const malformed of [extraTop, extraNested, missingTop, missingNested]) {
      expectMalformed(malformed);
    }
  });

  it("G-f preserves draft-only advice when another field makes the input malformed", () => {
    expectMalformed({ ...input(), prState: "draft", headSha: "short" }, "not-applicable-draft");
  });

  it("rejects malformed evidence-completeness records", () => {
    expect(manualTriggerAdvice({ ...input(), evidenceComplete: null } as unknown as CodexSignalInput)).toBe("wait");
    const missing: Record<string, unknown> = { ...input().evidenceComplete };
    delete missing.reactions;
    for (const evidenceComplete of [
      missing,
      { ...input().evidenceComplete, unexpected: true },
      { ...input().evidenceComplete, reviews: "yes" },
    ]) {
      expectMalformed({ ...input(), evidenceComplete });
    }
  });

  it("T24 never advises a manual trigger while the PR is a draft", () => {
    const draft = input({
      prState: "draft", evaluatedAt: "2026-08-07T11:00:00Z",
    });
    expect(manualTriggerAdvice(draft)).toBe("not-applicable-draft");
    expect(reduceCodexVerdict(draft)).toMatchObject({
      verdict: "unknown-pending", manualTriggerAdvice: "not-applicable-draft",
    });
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

  it("never advises due after a bot eyes engages the review", () => {
    const reactions: readonly CodexReactionRecord[] = [{
      ...pair()[0],
      createdAt: "2026-08-07T10:10:00Z",
    }];
    const engaged = input({ reactions, evaluatedAt: "2026-08-07T11:00:00Z" });
    expect(manualTriggerAdvice(engaged)).toBe("wait");
    expect(reduceCodexVerdict(engaged)).toMatchObject({
      verdict: "unknown-pending", manualTriggerAdvice: "wait",
    });
  });

  it("waits after any post-boundary bot evidence, even non-verdict or stale", () => {
    const evaluatedAt = "2026-08-07T11:00:00Z";
    expect(manualTriggerAdvice(input({ evaluatedAt, topLevelComments: [comment({
      body: "Review queued.",
    })] }))).toBe("wait");
    expect(manualTriggerAdvice(input({ evaluatedAt, reviews: [review({
      commitSha: PREVIOUS_HEAD,
    })] }))).toBe("wait");
  });

  it("ignores stranger and pre-boundary bot signals for timeout advice", () => {
    expect(manualTriggerAdvice(input({
      reactions: [
        { ...pair()[0], createdAt: BEFORE },
        { ...pair()[0], authorLogin: "stranger", createdAt: "2026-08-07T10:20:00Z" },
      ],
      evaluatedAt: "2026-08-07T10:30:00Z",
    }))).toBe("due");
  });

  it.each([
    ["reviews", { reviews: [null] }],
    ["top-level comments", { topLevelComments: [null] }],
  ])("returns wait for malformed standalone %s advice input", (_label, override) => {
    expect(manualTriggerAdvice({
      ...input({ evaluatedAt: "2026-08-07T11:00:00Z" }), ...override,
    } as unknown as CodexSignalInput)).toBe("wait");
  });

  it("treats the trigger defining a manual-retrigger boundary as already posted", () => {
    const boundary: CodexBoundary = {
      kind: "manual-retrigger",
      occurredAt: BOUNDARY_AT,
    };
    const boundaryTrigger = input({
      boundary,
      evaluatedAt: "2026-08-07T11:00:00Z",
      triggerComments: [{ createdAt: BOUNDARY_AT, onHeadSha: HEAD }],
    });
    expect(manualTriggerAdvice(boundaryTrigger)).toBe("already-posted");
    expect(reduceCodexVerdict(boundaryTrigger)).toMatchObject({
      verdict: "unknown-pending", manualTriggerAdvice: "already-posted",
    });
    expect(manualTriggerAdvice(input({
      evaluatedAt: "2026-08-07T10:30:00Z",
      triggerComments: [{ createdAt: BOUNDARY_AT, onHeadSha: HEAD }],
    }))).toBe("due");
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
    for (const filename of ["codex-verdict-logic.mts", "codex-signal-schema.mts"]) {
      const source = readFileSync(new URL(`../../scripts/factory/${filename}`, import.meta.url), "utf8");
      for (const banned of ["Date.now", "Math.random", "node:fs", "node:http", "node:https", "fetch("]) {
        expect(source).not.toContain(banned);
      }
    }
  });

  it("T29 keeps reducer machine constants in lockstep with the operator criterion", () => {
    expect(CODEX_VERDICT_CRITERION).toContain(CODEX_BOT_LOGIN);
    expect(CODEX_VERDICT_CRITERION).toContain(CODEX_CLEAN_COMMENT_TITLE);
    expect(CODEX_VERDICT_CRITERION).toContain("Reviewed commit:");
    expect(CODEX_WAIT_TIMEOUT_MINUTES).toBe(30);
  });
});
