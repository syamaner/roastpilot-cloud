import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CODEX_BOT_LOGIN,
  CODEX_CLEAN_COMMENT_TITLE,
  CODEX_NON_VERDICT_NOTICE_LINES,
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

function findingsBody(sha = HEAD): string {
  return `Codex found major issues.\n\nReviewed commit: ${sha}`;
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
        source: "review", authorLogin: CODEX_BOT_LOGIN, matchedSha: HEAD,
        submittedAt: AFTER, inlineThreadCount: 1,
        boundaryKind: "opened", boundaryOccurredAt: BOUNDARY_AT,
      },
      draft: false,
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
  ])("keeps draft %s evidence pending and ratchet-ineligible", (_label, evidence) => {
    expect(reduceCodexVerdict(input({ prState: "draft", ...evidence }))).toEqual({
      verdict: "unknown-pending",
      reasons: ["not-ready-draft"],
      manualTriggerAdvice: "not-applicable-draft",
      ratchetEligible: false,
    });
  });

  it("preserves a draft findings review as ratchet-ineligible evidence", () => {
    expect(reduceCodexVerdict(input({
      prState: "draft", reviews: [review()],
    }))).toEqual({
      verdict: "findings",
      evidence: {
        source: "review", authorLogin: CODEX_BOT_LOGIN, matchedSha: HEAD,
        submittedAt: AFTER, inlineThreadCount: 1,
        boundaryKind: "opened", boundaryOccurredAt: BOUNDARY_AT,
      },
      draft: true,
      ratchetEligible: false,
    });
  });

  it("preserves a draft findings comment as ratchet-ineligible evidence", () => {
    expect(reduceCodexVerdict(input({
      prState: "draft", topLevelComments: [comment({ body: findingsBody() })],
    }))).toEqual({
      verdict: "findings",
      evidence: {
        source: "comment", authorLogin: CODEX_BOT_LOGIN, matchedSha: HEAD,
        createdAt: AFTER, boundaryKind: "opened",
        boundaryOccurredAt: BOUNDARY_AT,
      },
      draft: true,
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

  it("rejects conflicting reviewed-commit markers without dropping either", () => {
    const body = `${CODEX_CLEAN_COMMENT_TITLE}\nReviewed commit: ${HEAD}` +
      `\nReviewed commit: ${PREVIOUS_HEAD}`;
    const verdict = reduceCodexVerdict(input({
      topLevelComments: [comment({ body })],
      reactions: pair(),
    }));
    expectPending(verdict, "unrecognised-bot-comment-only");
    expect(verdict.ratchetEligible).toBe(false);
  });

  it.each([
    ["trailing whitespace", `Reviewed commit: ${PREVIOUS_HEAD} `],
    ["extra whitespace after the prefix", `Reviewed commit:  ${PREVIOUS_HEAD}`],
    ["uppercase SHA", `Reviewed commit: ${PREVIOUS_HEAD.toUpperCase()}`],
    ["seven-character SHA", `Reviewed commit: ${PREVIOUS_HEAD.slice(0, 7)}`],
    ["non-hex SHA", `Reviewed commit: ${"g".repeat(40)}`],
    ["trailing text", `Reviewed commit: ${PREVIOUS_HEAD} extra`],
  ])("rejects a valid marker plus a malformed marker with %s", (_label, malformedLine) => {
    const body = `${CODEX_CLEAN_COMMENT_TITLE}\nReviewed commit: ${HEAD}` +
      `\n${malformedLine}`;
    const verdict = reduceCodexVerdict(input({
      topLevelComments: [comment({ body })],
      reactions: pair(),
    }));
    expectPending(verdict, "unrecognised-bot-comment-only");
    expect(verdict.ratchetEligible).toBe(false);
  });

  it("treats a malformed-only reviewed-commit marker as conflicting", () => {
    const body = `${CODEX_CLEAN_COMMENT_TITLE}\nReviewed commit: ${HEAD} extra`;
    const verdict = reduceCodexVerdict(input({
      topLevelComments: [comment({ body })],
      reactions: pair(),
    }));
    expectPending(verdict, "unrecognised-bot-comment-only");
    expect(verdict.ratchetEligible).toBe(false);
  });

  it("keeps a single valid current-head reviewed-commit marker clean", () => {
    expect(reduceCodexVerdict(input({
      topLevelComments: [comment({ body: cleanBody() })],
    }))).toMatchObject({ verdict: "clean", channel: "clean-comment" });
  });

  it("accepts benign duplicate current-head reviewed-commit markers", () => {
    const body = `${cleanBody()}\nReviewed commit: ${HEAD}`;
    expect(reduceCodexVerdict(input({
      topLevelComments: [comment({ body })],
    }))).toMatchObject({ verdict: "clean", channel: "clean-comment" });
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

  it("blocks a clean comment when a current-head review-thread reply coexists", () => {
    const verdict = reduceCodexVerdict(input({
      topLevelComments: [comment(), comment({ channel: "review-thread-reply" })],
    }));
    expectPending(verdict, "unrecognised-bot-comment-only");
  });

  it("blocks a clean reaction pair when a current-head review-thread reply coexists", () => {
    const verdict = reduceCodexVerdict(input({
      topLevelComments: [comment({ channel: "review-thread-reply" })],
      reactions: pair(),
    }));
    expectPending(verdict, "unrecognised-bot-comment-only");
  });

  it("keeps a current-head review-thread reply pending, never findings", () => {
    const verdict = reduceCodexVerdict(input({
      topLevelComments: [comment({ channel: "review-thread-reply" })],
    }));
    expectPending(verdict, "unrecognised-bot-comment-only");
    expect(verdict.ratchetEligible).toBe(false);
  });

  it("does not let a stale-head review-thread reply block a fresh clean", () => {
    expect(reduceCodexVerdict(input({
      topLevelComments: [
        comment(),
        comment({
          channel: "review-thread-reply",
          body: cleanBody(PREVIOUS_HEAD),
        }),
      ],
    }))).toMatchObject({ verdict: "clean", channel: "clean-comment" });
  });

  it("does not let a stranger current-head comment suppress bot clean", () => {
    expect(reduceCodexVerdict(input({
      topLevelComments: [
        comment(),
        comment({ authorLogin: "stranger", body: findingsBody() }),
      ],
    }))).toMatchObject({ verdict: "clean", channel: "clean-comment" });
  });

  it("does not let stranger conflicting markers suppress bot clean", () => {
    const conflictingBody = `Stranger notice.\nReviewed commit: ${HEAD}` +
      `\nReviewed commit: ${PREVIOUS_HEAD}`;
    expect(reduceCodexVerdict(input({
      topLevelComments: [
        comment(),
        comment({ authorLogin: "stranger", body: conflictingBody }),
      ],
    }))).toMatchObject({ verdict: "clean", channel: "clean-comment" });
  });

  it("does not let a stranger current-head comment suppress reaction clean", () => {
    expect(reduceCodexVerdict(input({
      topLevelComments: [comment({
        authorLogin: "stranger", body: findingsBody(),
      })],
      reactions: pair(),
    }))).toMatchObject({ verdict: "clean", channel: "reaction-pair" });
  });

  it("T16 treats current-head near-miss titles as findings, never clean", () => {
    const nearMiss = cleanBody("a".repeat(40), "Codex Review: didn't find major issues");
    const embedded = cleanBody(HEAD, `Notice: ${CODEX_CLEAN_COMMENT_TITLE} today`);
    for (const body of [nearMiss, embedded]) {
      expect(reduceCodexVerdict(input({
        topLevelComments: [comment({ body })],
      }))).toMatchObject({ verdict: "findings", evidence: { source: "comment" } });
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

  it.each(["```", "~~~"])("treats a current-head title inside a %s fence as findings", (fence) => {
    const body = `${fence}text\n${CODEX_CLEAN_COMMENT_TITLE}\nReviewed commit: ${HEAD}\n${fence}`;
    expect(reduceCodexVerdict(input({
      topLevelComments: [comment({ body })],
    }))).toMatchObject({ verdict: "findings", evidence: { source: "comment" } });
  });

  it("requires the title as the first non-blank line and accepts both title forms", () => {
    for (const body of [
      `> ${CODEX_CLEAN_COMMENT_TITLE}\nReviewed commit: ${HEAD}`,
      `<pre>\n${CODEX_CLEAN_COMMENT_TITLE}\n</pre>\nReviewed commit: ${HEAD}`,
      `<blockquote>\n${CODEX_CLEAN_COMMENT_TITLE}\n</blockquote>\nReviewed commit: ${HEAD}`,
      `Some notice\n${CODEX_CLEAN_COMMENT_TITLE}\nReviewed commit: ${HEAD}`,
    ]) {
      expect(reduceCodexVerdict(input({
        topLevelComments: [comment({ body })],
      }))).toMatchObject({ verdict: "findings", evidence: { source: "comment" } });
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
  ])("treats a current-head non-authenticating %s as findings", (_label, body) => {
    expect(reduceCodexVerdict(input({
      topLevelComments: [comment({ body })],
    }))).toMatchObject({ verdict: "findings", evidence: { source: "comment" } });
  });

  it.each([
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

  it.each(CODEX_NON_VERDICT_NOTICE_LINES)(
    "T17 keeps the bot notice %j pending and suppresses clean",
    (notice) => {
      const body = `${notice}\nReviewed commit: ${HEAD}`;
      const verdict = reduceCodexVerdict(input({
        topLevelComments: [comment(), comment({ body })],
        reactions: pair(),
      }));
      expectPending(verdict, "unrecognised-bot-comment-only");
      expect(verdict.ratchetEligible).toBe(false);
    },
  );

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

  it("gives a findings comment precedence over a clean comment", () => {
    expect(reduceCodexVerdict(input({
      topLevelComments: [
        comment(),
        comment({ body: findingsBody(), createdAt: LATER }),
      ],
    }))).toEqual({
      verdict: "findings",
      evidence: {
        source: "comment", authorLogin: CODEX_BOT_LOGIN, matchedSha: HEAD,
        createdAt: LATER, boundaryKind: "opened",
        boundaryOccurredAt: BOUNDARY_AT,
      },
      draft: false,
      ratchetEligible: true,
    });
  });

  it("gives a findings comment precedence over a clean reaction pair", () => {
    expect(reduceCodexVerdict(input({
      topLevelComments: [comment({ body: findingsBody() })],
      reactions: pair(),
    }))).toMatchObject({
      verdict: "findings", evidence: { source: "comment" },
      ratchetEligible: true,
    });
  });

  it("suppresses clean when a current-head non-verdict notice coexists", () => {
    const verdict = reduceCodexVerdict(input({
      topLevelComments: [
        comment(),
        comment({ body: `Review skipped.\nReviewed commit: ${HEAD}` }),
      ],
      reactions: pair(),
    }));
    expectPending(verdict, "unrecognised-bot-comment-only");
    expect(verdict.ratchetEligible).toBe(false);
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

  it("T30 advises due when a lone engaged eyes is stale past 30 minutes", () => {
    const reactions: readonly CodexReactionRecord[] = [{
      ...pair()[0],
      createdAt: "2026-08-07T10:10:00Z",
    }];
    const engaged = input({ reactions, evaluatedAt: "2026-08-07T11:00:00Z" });
    expect(manualTriggerAdvice(engaged)).toBe("due");
    expect(reduceCodexVerdict(engaged)).toMatchObject({
      verdict: "unknown-pending", manualTriggerAdvice: "due",
    });
  });

  it("T31 keeps waiting on a fresh engaged eyes even past the boundary timeout", () => {
    const reactions: readonly CodexReactionRecord[] = [{
      ...pair()[0],
      createdAt: "2026-08-07T10:10:00Z",
    }];
    const engaged = input({ reactions, evaluatedAt: "2026-08-07T10:35:00Z" });
    expect(manualTriggerAdvice(engaged)).toBe("wait");
    expect(reduceCodexVerdict(engaged)).toMatchObject({
      verdict: "unknown-pending", manualTriggerAdvice: "wait",
    });
  });

  it("T32 trips the eyes bound at exactly 30 minutes (>= tie-break)", () => {
    expect(manualTriggerAdvice(input({
      reactions: [{ ...pair()[0], createdAt: "2026-08-07T10:10:00Z" }],
      evaluatedAt: "2026-08-07T10:40:00Z",
    }))).toBe("due");
  });

  it("T33 measures the bound from the latest of multiple engaged eyes", () => {
    const reactions: readonly CodexReactionRecord[] = [
      { ...pair()[0], createdAt: "2026-08-07T10:05:00Z", subjectId: "issue:1" },
      { ...pair()[0], createdAt: "2026-08-07T10:20:00Z", subjectId: "issue:2" },
    ];
    expect(manualTriggerAdvice(input({
      reactions,
      evaluatedAt: "2026-08-07T10:45:00Z",
    }))).toBe("wait");
    expect(manualTriggerAdvice(input({
      reactions,
      evaluatedAt: "2026-08-07T10:51:00Z",
    }))).toBe("due");
  });

  it("T34 fails closed to wait on a malformed eyes createdAt", () => {
    // Exercises the grammar gate (:303-315 via isReactionRecord); the inner
    // defensive guard is unreachable through the public surface.
    expect(manualTriggerAdvice({
      ...input(),
      reactions: [{ ...pair()[0], createdAt: "not-a-timestamp" }],
    } as unknown as CodexSignalInput)).toBe("wait");
  });

  it("ignores a head-agnostic non-verdict bot comment for fallback advice", () => {
    expect(manualTriggerAdvice(input({
      evaluatedAt: "2026-08-07T11:00:00Z", topLevelComments: [comment({
        body: "Review skipped.",
      })],
    }))).toBe("due");
  });

  it("ignores a stale-head bot review for current-head fallback advice", () => {
    expect(manualTriggerAdvice(input({
      evaluatedAt: "2026-08-07T11:00:00Z", reviews: [review({
      commitSha: PREVIOUS_HEAD,
    })] }))).toBe("due");
  });

  it("ignores a stale-head bot comment for current-head fallback advice", () => {
    expect(manualTriggerAdvice(input({
      evaluatedAt: "2026-08-07T11:00:00Z", topLevelComments: [comment({
        body: cleanBody(PREVIOUS_HEAD),
      })],
    }))).toBe("due");
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

  it("ignores bot reactions other than eyes for timeout advice", () => {
    expect(manualTriggerAdvice(input({
      reactions: [{ ...pair()[1] }],
      evaluatedAt: "2026-08-07T10:30:00Z",
    }))).toBe("due");
  });

  it.each([
    ["reviews", { reviews: [null] }],
    ["top-level comments", { topLevelComments: [null] }],
  ])("does not inspect unused standalone %s advice input", (_label, override) => {
    expect(manualTriggerAdvice({
      ...input({ evaluatedAt: "2026-08-07T11:00:00Z" }), ...override,
    } as unknown as CodexSignalInput)).toBe("due");
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

  it("T27 pins pending false and distinguishes draft from ready findings", () => {
    const pending = reduceCodexVerdict(input());
    const clean = reduceCodexVerdict(input({ topLevelComments: [comment()] }));
    const readyFindings = reduceCodexVerdict(input({ reviews: [review()] }));
    const draftFindings = reduceCodexVerdict(input({
      prState: "draft", reviews: [review()],
    }));
    if (pending.verdict === "unknown-pending") { const literal: false = pending.ratchetEligible; expect(literal).toBe(false); }
    if (clean.verdict === "clean") { const literal: true = clean.ratchetEligible; expect(literal).toBe(true); }
    if (readyFindings.verdict === "findings") {
      const eligibility: boolean = readyFindings.ratchetEligible;
      expect({ eligibility, draft: readyFindings.draft })
        .toEqual({ eligibility: true, draft: false });
    }
    if (draftFindings.verdict === "findings") {
      const eligibility: boolean = draftFindings.ratchetEligible;
      expect({ eligibility, draft: draftFindings.draft })
        .toEqual({ eligibility: false, draft: true });
    }
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
