import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CODEX_ADVISORY_STATUS_CONTEXT,
  MAX_STATUS_DESCRIPTION_LENGTH,
  collectAndPlan,
  collectSignalInput,
  deriveHeadChangedAt,
  headAdvancedPastBoundary,
  mapReactions,
  mapReviews,
  mapTopLevelComments,
  mapTriggerComments,
  selectBoundary,
  selectReactionSubject,
  singleReviewedCommitSha,
  verdictToStatusPlan,
  type RawCollectionInput,
  type RawIssueComment,
  type RawSourceCompleteness,
  type StatusPlan,
} from "../../scripts/factory/codex-signal-collection-logic.mts";
import {
  CODEX_BOT_LOGIN,
  CODEX_CLEAN_COMMENT_TITLE,
  reduceCodexVerdict,
  type CodexVerdict,
  type PendingReason,
} from "../../scripts/factory/codex-verdict-logic.mts";
import type {
  CodexBoundary,
  CodexSignalInput,
} from "../../scripts/factory/codex-signal-schema.mts";
import { CODEX_TRIGGER_PHRASE } from "../../scripts/factory/implement-patch-logic.mts";

const HEAD = "a".repeat(40);
const OLD_HEAD = "b".repeat(40);
const BEFORE_CREATED = "2026-08-08T09:59:00Z";
const CREATED = "2026-08-08T10:00:00Z";
const EARLY = "2026-08-08T10:02:00Z";
const PRE_READY = "2026-08-08T10:05:00Z";
const READY_AT = "2026-08-08T10:10:00Z";
const AFTER = "2026-08-08T10:11:00Z";
const LATER = "2026-08-08T10:12:00Z";
const LATEST = "2026-08-08T10:13:00Z";
const EVALUATED = "2026-08-08T11:00:00Z";
const OPENED: CodexBoundary = { kind: "opened", occurredAt: CREATED };
const STATUS_GRAMMAR = /^(?:clean channel=clean-comment sha=[0-9a-f]{7}|findings source=(?:review|comment) sha=[0-9a-f]{7} count=\d+|pending reasons=[a-z-]+(?:,[a-z-]+)*(?:; omitted=\d+)?; advice=(?:wait|already-posted|not-applicable-draft|due|verify)(?:; see AGENTS\.md PR Merge Policy)?)$/u;
type RetiredSuiteKey = `check${"Suites"}`;
type CollectionRejectsRetiredSuiteKey = RetiredSuiteKey extends keyof RawCollectionInput
  ? false
  : true;
const COLLECTION_REJECTS_RETIRED_SUITE_KEY: CollectionRejectsRetiredSuiteKey = true;

const COMPLETE: RawSourceCompleteness = {
  timelineEvents: true,
  reviews: true,
  reviewComments: true,
  issueComments: true,
  prReviewComments: true,
  reactions: true,
};

function cleanBody(sha = HEAD, suffix = ""): string {
  return `${CODEX_CLEAN_COMMENT_TITLE}\n\nReviewed commit: ${sha}${suffix}`;
}

function issueComment(overrides: Partial<RawIssueComment> = {}): RawIssueComment {
  return {
    authorLogin: CODEX_BOT_LOGIN,
    body: cleanBody(),
    createdAt: AFTER,
    id: 11,
    ...overrides,
  };
}

function reactionPair(eyesAt = EARLY, plusOneAt = "2026-08-08T10:03:00Z") {
  return [
    { authorLogin: CODEX_BOT_LOGIN, content: "eyes", createdAt: eyesAt },
    { authorLogin: CODEX_BOT_LOGIN, content: "+1", createdAt: plusOneAt },
  ] as const;
}

function review(commitSha = HEAD, submittedAt = AFTER) {
  return {
    authorLogin: CODEX_BOT_LOGIN,
    commitSha,
    submittedAt,
    reviewId: 7,
    state: "COMMENTED",
  } as const;
}

function reducerMarkerSha(body: string): string | null {
  const input: CodexSignalInput = {
    headSha: HEAD,
    prState: "ready",
    boundary: OPENED,
    headChangedAt: CREATED,
    reviews: [],
    topLevelComments: [{
      authorLogin: CODEX_BOT_LOGIN,
      body,
      createdAt: AFTER,
      channel: "issue-comment",
    }],
    reactions: [],
    evidenceComplete: { reviews: true, topLevelComments: true, reactions: true },
    triggerComments: [],
    evaluatedAt: EVALUATED,
  };
  const verdict = reduceCodexVerdict(input);
  return verdict.verdict === "clean" && verdict.evidence.channel === "clean-comment"
    ? verdict.evidence.matchedSha
    : null;
}

function raw(overrides: Partial<RawCollectionInput> = {}): RawCollectionInput {
  return {
    pullRequest: {
      headSha: HEAD,
      isDraft: false,
      headRepoIsSameRepo: true,
      createdAt: CREATED,
    },
    evaluatedAt: EVALUATED,
    timelineEvents: [],
    reviews: [],
    reviewComments: [],
    issueComments: [],
    prReviewComments: [],
    reactions: [],
    reactionSubject: { kind: "pull-request" },
    sourceComplete: COMPLETE,
    ...overrides,
  };
}

function withComplete(
  input: RawCollectionInput,
  overrides: Partial<RawSourceCompleteness>,
): RawCollectionInput {
  return { ...input, sourceComplete: { ...COMPLETE, ...overrides } };
}

function expectWrite(plan: StatusPlan, state: "success" | "failure" | "pending") {
  expect(plan).toMatchObject({
    kind: "write",
    context: CODEX_ADVISORY_STATUS_CONTEXT,
    state,
  });
  return plan.kind === "write" ? plan : null;
}

function expectDescription(plan: StatusPlan, state: "success" | "failure" | "pending") {
  const write = expectWrite(plan, state);
  expect(write?.description).toMatch(STATUS_GRAMMAR);
  expect(write?.description.length).toBeLessThanOrEqual(MAX_STATUS_DESCRIPTION_LENGTH);
  return write;
}

describe("f-1 head-freshness and boundary regressions", () => {
  it("T1 created-ready-not-awaiting-retrigger: no signals stays no-bot pending", () => {
    const write = expectDescription(collectAndPlan(raw()), "pending");
    expect(write?.description).toContain("no-bot-signal");
    expect(write?.description).not.toContain("awaiting-retrigger");
    expect(collectSignalInput(raw())).toMatchObject({
      kind: "ready",
      input: { boundary: OPENED, headChangedAt: CREATED },
      reactionSubject: { kind: "pull-request" },
    });
  });

  it("T1 created-ready-not-awaiting-retrigger: clean head-naming comment succeeds", () => {
    const write = expectDescription(collectAndPlan(raw({
      issueComments: [issueComment({ createdAt: EARLY })],
    })), "success");
    expect(write?.description).toBe(`clean channel=clean-comment sha=${HEAD.slice(0, 7)}`);
    expect(write?.description).not.toContain(HEAD);
  });

  it("T1 created-ready-not-awaiting-retrigger: reaction clean is pending verify", () => {
    const write = expectDescription(collectAndPlan(raw({
      reactions: reactionPair(),
    })), "pending");
    expect(write?.description).toBe(
      "pending reasons=reaction-clean-unconfirmed; advice=verify",
    );
  });

  it("T2 clean-comment success remains a byte-exact current-head check", () => {
    const current = expectDescription(collectAndPlan(raw({
      issueComments: [issueComment({ body: cleanBody(HEAD), createdAt: EARLY })],
    })), "success");
    expect(current?.description).toBe(`clean channel=clean-comment sha=${HEAD.slice(0, 7)}`);
    const stale = expectDescription(collectAndPlan(raw({
      issueComments: [issueComment({ body: cleanBody(OLD_HEAD), createdAt: EARLY })],
    })), "pending");
    expect(stale?.description).toContain("awaiting-retrigger");
  });

  it("T3 stale-sha bot comment corroborates advance", () => {
    const stale = issueComment({ body: cleanBody(OLD_HEAD), createdAt: AFTER });
    expect(headAdvancedPastBoundary(HEAD, [], [], [stale], OPENED)).toBe(true);
    expect(headAdvancedPastBoundary(HEAD, [], [], [{
      ...stale, authorLogin: "attacker",
    }], OPENED)).toBe(false);
    expect(headAdvancedPastBoundary(HEAD, [], [], [{
      ...stale, body: `${cleanBody(OLD_HEAD)}\nReviewed commit: ${HEAD}`,
    }], OPENED)).toBe(false);
    const write = expectDescription(collectAndPlan(raw({ issueComments: [stale] })), "pending");
    expect(write?.description).toContain("awaiting-retrigger");
  });

  it("T4 pre-ready verdict is rejected at the ready-for-review boundary", () => {
    const write = expectDescription(collectAndPlan(raw({
      timelineEvents: [{ event: "ready_for_review", createdAt: READY_AT }],
      issueComments: [issueComment({ createdAt: PRE_READY })],
    })), "pending");
    expect(write?.description).toContain("pre-boundary-signal-only");
  });

  it("CLASS P1 pre-ready current-head bot review remains findings", () => {
    const write = expectDescription(collectAndPlan(raw({
      timelineEvents: [{ event: "ready_for_review", createdAt: READY_AT }],
      reviews: [review(HEAD, PRE_READY)],
    })), "failure");
    expect(write?.description).toBe(
      `findings source=review sha=${HEAD.slice(0, 7)} count=0`,
    );
  });

  it("CLASS P1 current-head findings tied with PR creation are never dropped", () => {
    const write = expectDescription(collectAndPlan(raw({
      reviews: [review(HEAD, CREATED)],
      reviewComments: [{ pullRequestReviewId: 7 }],
    })), "failure");
    expect(write?.description).toBe(
      `findings source=review sha=${HEAD.slice(0, 7)} count=1`,
    );
  });

  it("T5 append-with-a-stale-findings-review corroborates advance only", () => {
    const stale = review(OLD_HEAD, AFTER);
    expect(headAdvancedPastBoundary(HEAD, [], [stale], [], OPENED)).toBe(true);
    expect(headAdvancedPastBoundary(HEAD, [], [{
      ...stale, authorLogin: "attacker",
    }], [], OPENED)).toBe(false);
    const write = expectDescription(collectAndPlan(raw({ reviews: [stale] })), "pending");
    expect(write?.description).toContain("awaiting-retrigger");
  });

  it("P1-b surfaces a current-head bot findings review while awaiting retrigger", () => {
    const staleAdvance = { ...review(OLD_HEAD, AFTER), reviewId: 8 };
    const currentFindings = { ...review(HEAD, LATER), reviewId: 7 };
    const input = raw({
      reviews: [staleAdvance, currentFindings],
      reviewComments: [
        { pullRequestReviewId: 7 },
        { pullRequestReviewId: 7 },
      ],
    });
    expect(collectSignalInput(input)).toMatchObject({
      kind: "findings",
      verdict: {
        verdict: "findings",
        evidence: {
          source: "review",
          matchedSha: HEAD,
          inlineThreadCount: 2,
        },
      },
    });
    expect(collectAndPlan(input)).toEqual({
      kind: "write",
      context: CODEX_ADVISORY_STATUS_CONTEXT,
      state: "failure",
      description: `findings source=review sha=${HEAD.slice(0, 7)} count=2`,
    });
  });

  it("P1-b surfaces a current-head bot findings comment while awaiting retrigger", () => {
    const findingsBody = `Codex Review: Found issues\n\nReviewed commit: ${HEAD}`;
    const input = raw({
      reviews: [review(OLD_HEAD, AFTER)],
      issueComments: [issueComment({ body: findingsBody, createdAt: LATER })],
    });
    expect(collectAndPlan(input)).toEqual({
      kind: "write",
      context: CODEX_ADVISORY_STATUS_CONTEXT,
      state: "failure",
      description: `findings source=comment sha=${HEAD.slice(0, 7)} count=1`,
    });
  });

  it("P1-b leaves stale old-head findings pending while awaiting retrigger", () => {
    const input = raw({
      reviews: [review(OLD_HEAD, AFTER)],
      reviewComments: [{ pullRequestReviewId: 7 }],
    });
    expect(collectAndPlan(input)).toEqual({
      kind: "write",
      context: CODEX_ADVISORY_STATUS_CONTEXT,
      state: "pending",
      description: "pending reasons=awaiting-retrigger; advice=due; see AGENTS.md PR Merge Policy",
    });
  });

  it("P1-b never promotes a current-head clean signal while awaiting retrigger", () => {
    const input = raw({
      reviews: [review(OLD_HEAD, AFTER)],
      issueComments: [issueComment({ body: cleanBody(HEAD), createdAt: LATER })],
    });
    expect(collectSignalInput(input)).toEqual({
      kind: "pending",
      reason: "awaiting-retrigger",
      prState: "ready",
    });
    expect(collectAndPlan(input)).toEqual({
      kind: "write",
      context: CODEX_ADVISORY_STATUS_CONTEXT,
      state: "pending",
      description: "pending reasons=awaiting-retrigger; advice=due; see AGENTS.md PR Merge Policy",
    });
  });

  it("P2-a excludes a trigger older than the latest corroborated advance evidence", () => {
    const oldTrigger = issueComment({
      authorLogin: "operator", body: CODEX_TRIGGER_PHRASE,
      createdAt: PRE_READY, id: 77,
    });
    const staleComment = issueComment({
      body: cleanBody(OLD_HEAD), createdAt: AFTER, id: 78,
    });
    const currentCleanBeforeAdvance = issueComment({ createdAt: READY_AT, id: 79 });
    const issueComments = [oldTrigger, staleComment, currentCleanBeforeAdvance];
    const reviews = [review(OLD_HEAD, EARLY)];
    expect(selectBoundary({
      headSha: HEAD,
      prState: "ready",
      prCreatedAt: CREATED,
      reviews,
      timelineEvents: [],
      timelineComplete: true,
      headChangedAt: CREATED,
      issueComments,
      issueCommentsComplete: true,
    })).toEqual({ kind: "no-valid-boundary", reason: "awaiting-retrigger" });
    const write = expectDescription(collectAndPlan(raw({
      reviews,
      issueComments,
      reactionSubject: { kind: "issue-comment", commentId: 77 },
    })), "pending");
    expect(write?.description).toContain("awaiting-retrigger");
  });

  it("P2-a selects a trigger posted after the latest corroborated advance evidence", () => {
    const staleComment = issueComment({
      body: cleanBody(OLD_HEAD), createdAt: AFTER, id: 78,
    });
    const trigger = issueComment({
      authorLogin: "operator", body: CODEX_TRIGGER_PHRASE,
      createdAt: LATER, id: 88,
    });
    const input = raw({
      reviews: [review(OLD_HEAD, EARLY)],
      issueComments: [staleComment, trigger, issueComment({ createdAt: LATEST, id: 89 })],
      reactionSubject: { kind: "issue-comment", commentId: 88 },
    });
    expect(collectSignalInput(input)).toMatchObject({
      kind: "ready",
      input: { boundary: { kind: "manual-retrigger", occurredAt: LATER } },
      reactionSubject: { kind: "issue-comment", commentId: 88 },
    });
    expectDescription(collectAndPlan(input), "success");
  });

  it("coverage: latest advance evidence filters the boundary and retains the maximum", () => {
    const readyBoundary: CodexBoundary = {
      kind: "ready-for-review", occurredAt: READY_AT,
    };
    const timelineEvents = [
      { event: "ready_for_review", createdAt: READY_AT },
      { event: "head_ref_force_pushed", createdAt: PRE_READY },
    ];
    const reviews = [review(OLD_HEAD, AFTER), review(OLD_HEAD, AFTER)];
    const issueComments = [
      issueComment({ body: cleanBody(OLD_HEAD), createdAt: LATER, id: 90 }),
      issueComment({
        authorLogin: "operator", body: CODEX_TRIGGER_PHRASE,
        createdAt: "2026-08-08T10:11:30Z", id: 91,
      }),
    ];
    expect(headAdvancedPastBoundary(
      HEAD, timelineEvents, reviews, issueComments, readyBoundary,
    )).toBe(true);
    expect(selectBoundary({
      headSha: HEAD,
      prState: "ready",
      prCreatedAt: CREATED,
      reviews,
      timelineEvents,
      timelineComplete: true,
      headChangedAt: PRE_READY,
      issueComments,
      issueCommentsComplete: true,
    })).toEqual({ kind: "no-valid-boundary", reason: "awaiting-retrigger" });
  });

  it("T6 invisible-append-stale-pair-never-success: exact shipped fail-open is demoted", () => {
    const shippedFailOpen = raw({ reactions: reactionPair(AFTER, LATER) });
    const write = expectDescription(collectAndPlan(shippedFailOpen), "pending");
    expect(write?.description).toBe(
      "pending reasons=reaction-clean-unconfirmed; advice=verify",
    );
  });

  it("T7 reused-sha-force-push rejects both pre-push clean channels", () => {
    const forcePush = { event: "head_ref_force_pushed", createdAt: PRE_READY };
    expect(deriveHeadChangedAt(CREATED, [forcePush])).toBe(PRE_READY);
    expect(headAdvancedPastBoundary(HEAD, [forcePush], [], [], OPENED)).toBe(true);
    const stalePair = raw({
      timelineEvents: [forcePush],
      reactions: reactionPair(EARLY, "2026-08-08T10:03:00Z"),
    });
    const staleComment = raw({
      timelineEvents: [forcePush],
      issueComments: [issueComment({ createdAt: "2026-08-08T10:04:00Z" })],
    });
    for (const input of [stalePair, staleComment]) {
      const write = expectDescription(collectAndPlan(input), "pending");
      expect(write?.description).toContain("awaiting-retrigger");
    }
  });

  it("P1 visible force-push tied with the opened boundary requires retrigger", () => {
    const input = raw({
      timelineEvents: [{ event: "head_ref_force_pushed", createdAt: CREATED }],
      issueComments: [issueComment({ body: cleanBody(HEAD), createdAt: EARLY })],
    });
    expect(collectSignalInput(input)).toEqual({
      kind: "pending",
      reason: "awaiting-retrigger",
      prState: "ready",
    });
    expect(collectAndPlan(input)).toEqual({
      kind: "write",
      context: CODEX_ADVISORY_STATUS_CONTEXT,
      state: "pending",
      description: "pending reasons=awaiting-retrigger; advice=due; see AGENTS.md PR Merge Policy",
    });
  });

  it("P1 visible force-push tied with the ready boundary requires retrigger", () => {
    const input = raw({
      timelineEvents: [
        { event: "ready_for_review", createdAt: READY_AT },
        { event: "head_ref_force_pushed", createdAt: READY_AT },
      ],
      issueComments: [issueComment({ body: cleanBody(HEAD), createdAt: AFTER })],
    });
    const write = expectDescription(collectAndPlan(input), "pending");
    expect(write?.description).toContain("awaiting-retrigger");
  });

  it("P1 visible head event strictly before the ready boundary is not an advance", () => {
    const input = raw({
      timelineEvents: [
        { event: "head_ref_force_pushed", createdAt: PRE_READY },
        { event: "ready_for_review", createdAt: READY_AT },
      ],
      issueComments: [issueComment({ body: cleanBody(HEAD), createdAt: AFTER })],
    });
    expect(selectBoundary({
      headSha: HEAD,
      prState: "ready",
      prCreatedAt: CREATED,
      reviews: [],
      timelineEvents: input.timelineEvents ?? [],
      timelineComplete: true,
      headChangedAt: PRE_READY,
      issueComments: input.issueComments ?? [],
      issueCommentsComplete: true,
    })).toMatchObject({
      kind: "selected",
      boundary: { kind: "ready-for-review", occurredAt: READY_AT },
    });
    expectDescription(collectAndPlan(input), "success");
  });

  it.each(["review", "comment"] as const)(
    "CLASS P1 tied stale-SHA %s advances at opened and ready boundaries",
    (source) => {
      for (const shape of ["opened", "ready"] as const) {
        const boundaryAt = shape === "opened" ? CREATED : READY_AT;
        const timelineEvents = shape === "opened"
          ? []
          : [{ event: "ready_for_review", createdAt: READY_AT }];
        const stale = issueComment({
          body: cleanBody(OLD_HEAD), createdAt: boundaryAt, id: 90,
        });
        const input = raw({
          timelineEvents,
          reviews: source === "review" ? [review(OLD_HEAD, boundaryAt)] : [],
          issueComments: source === "comment"
            ? [stale, issueComment({ body: cleanBody(HEAD), createdAt: AFTER, id: 91 })]
            : [issueComment({ body: cleanBody(HEAD), createdAt: AFTER, id: 91 })],
        });
        const write = expectDescription(collectAndPlan(input), "pending");
        expect(write?.description, shape).toContain("awaiting-retrigger");
      }
    },
  );

  it("CLASS P1 stale-SHA records strictly before a boundary remain non-advancing", () => {
    for (const [boundary, before] of [
      [OPENED, BEFORE_CREATED],
      [{ kind: "ready-for-review", occurredAt: READY_AT } as const, PRE_READY],
    ] as const) {
      expect(headAdvancedPastBoundary(
        HEAD,
        [],
        [review(OLD_HEAD, before)],
        [issueComment({ body: cleanBody(OLD_HEAD), createdAt: before })],
        boundary,
      )).toBe(false);
    }
  });

  it("T8 manual-retrigger episode accepts only a post-trigger clean comment", () => {
    const trigger = issueComment({
      authorLogin: "operator",
      body: CODEX_TRIGGER_PHRASE,
      createdAt: EARLY,
      id: 77,
    });
    const cleanInput = raw({
      issueComments: [trigger, issueComment({ createdAt: PRE_READY, id: 78 })],
      reactionSubject: { kind: "issue-comment", commentId: 77 },
    });
    const collected = collectSignalInput(cleanInput);
    expect(collected).toMatchObject({
      kind: "ready",
      input: { boundary: { kind: "manual-retrigger", occurredAt: EARLY } },
      reactionSubject: { kind: "issue-comment", commentId: 77 },
    });
    if (collected.kind === "ready") {
      expect(selectReactionSubject({
        kind: "selected",
        boundary: collected.input.boundary,
        reactionSubject: collected.reactionSubject,
      })).toEqual({ kind: "issue-comment", commentId: 77 });
    }
    expectDescription(collectAndPlan(cleanInput), "success");

    const pairInput = raw({
      issueComments: [trigger],
      reactions: reactionPair(PRE_READY, "2026-08-08T10:06:00Z"),
      reactionSubject: { kind: "issue-comment", commentId: 77 },
    });
    const pair = expectDescription(collectAndPlan(pairInput), "pending");
    expect(pair?.description).toBe(
      "pending reasons=reaction-clean-unconfirmed; advice=verify",
    );
  });

  it("CLASS P1 current-head findings precede a selected manual boundary and later clean", () => {
    const findings = issueComment({
      body: `Codex Review: Found issues\n\nReviewed commit: ${HEAD}`,
      createdAt: PRE_READY,
      id: 76,
    });
    const trigger = issueComment({
      authorLogin: "operator", body: CODEX_TRIGGER_PHRASE,
      createdAt: AFTER, id: 77,
    });
    const clean = issueComment({ body: cleanBody(HEAD), createdAt: LATER, id: 78 });
    expect(selectBoundary({
      headSha: HEAD,
      prState: "ready",
      prCreatedAt: CREATED,
      reviews: [],
      timelineEvents: [],
      timelineComplete: true,
      headChangedAt: CREATED,
      issueComments: [findings, trigger, clean],
      issueCommentsComplete: true,
    })).toMatchObject({
      kind: "selected",
      boundary: { kind: "manual-retrigger", occurredAt: AFTER },
    });
    expect(collectAndPlan(raw({
      issueComments: [findings, trigger, clean],
      reactionSubject: { kind: "issue-comment", commentId: 77 },
    }))).toEqual({
      kind: "write",
      context: CODEX_ADVISORY_STATUS_CONTEXT,
      state: "failure",
      description: `findings source=comment sha=${HEAD.slice(0, 7)} count=1`,
    });
  });

  it("T9 retrigger-reference-max excludes a draft-phase trigger after corroborated advance", () => {
    const trigger = issueComment({
      authorLogin: "operator", body: CODEX_TRIGGER_PHRASE,
      createdAt: PRE_READY, id: 77,
    });
    const staleReview = review(OLD_HEAD, AFTER);
    const input = raw({
      timelineEvents: [{ event: "ready_for_review", createdAt: READY_AT }],
      reviews: [staleReview],
      issueComments: [trigger],
    });
    expect(selectBoundary({
      headSha: HEAD,
      prState: "ready",
      prCreatedAt: CREATED,
      reviews: [staleReview],
      timelineEvents: [{ event: "ready_for_review", createdAt: READY_AT }],
      timelineComplete: true,
      headChangedAt: CREATED,
      issueComments: [trigger],
      issueCommentsComplete: true,
    })).toEqual({ kind: "no-valid-boundary", reason: "awaiting-retrigger" });
    const write = expectDescription(collectAndPlan(input), "pending");
    expect(write?.description).toContain("awaiting-retrigger");
  });

  it("T10 legacy evidence is inert and never reaches the reducer input", () => {
    expect(COLLECTION_REJECTS_RETIRED_SUITE_KEY).toBe(true);
    const input = raw();
    const legacyKey = ["check", "Suites"].join("");
    const polluted = {
      ...input,
      [legacyKey]: [{ headSha: OLD_HEAD, createdAt: AFTER }],
    } as RawCollectionInput;
    expect(collectAndPlan(polluted)).toEqual(collectAndPlan(input));
    const collected = collectSignalInput(polluted);
    expect(collected.kind).toBe("ready");
    if (collected.kind === "ready") {
      expect(Object.keys(collected.input)).not.toContain(legacyKey);
    }
  });

  it("orders eligible manual triggers by time and then descending id", () => {
    const comments = [
      issueComment({ authorLogin: "operator", body: CODEX_TRIGGER_PHRASE, createdAt: EARLY, id: 7 }),
      issueComment({ authorLogin: "operator", body: CODEX_TRIGGER_PHRASE, createdAt: AFTER, id: 8 }),
      issueComment({ authorLogin: "operator", body: CODEX_TRIGGER_PHRASE, createdAt: AFTER, id: 9 }),
      issueComment({ body: CODEX_TRIGGER_PHRASE, createdAt: LATER, id: 10 }),
    ];
    expect(selectBoundary({
      headSha: HEAD,
      prState: "ready",
      prCreatedAt: CREATED,
      reviews: [],
      timelineEvents: [],
      timelineComplete: true,
      headChangedAt: CREATED,
      issueComments: comments,
      issueCommentsComplete: true,
    })).toEqual({
      kind: "selected",
      boundary: { kind: "manual-retrigger", occurredAt: AFTER },
      reactionSubject: { kind: "issue-comment", commentId: 9 },
    });
  });

  it("T12 snapshot-inconsistent never falls back to opened", () => {
    const plan = collectAndPlan(raw({
      timelineEvents: [
        { event: "ready_for_review", createdAt: EARLY },
        { event: "convert_to_draft", createdAt: PRE_READY },
      ],
    }));
    expect(plan).toEqual({
      kind: "write",
      context: CODEX_ADVISORY_STATUS_CONTEXT,
      state: "pending",
      description: "pending reasons=snapshot-inconsistent; advice=wait",
    });
  });

  it("CLASS P1 snapshot-inconsistent still surfaces current-head findings", () => {
    const plan = collectAndPlan(raw({
      timelineEvents: [
        { event: "ready_for_review", createdAt: EARLY },
        { event: "convert_to_draft", createdAt: PRE_READY },
      ],
      reviews: [review(HEAD, AFTER)],
      reviewComments: [{ pullRequestReviewId: 7 }],
    }));
    expect(plan).toEqual({
      kind: "write",
      context: CODEX_ADVISORY_STATUS_CONTEXT,
      state: "failure",
      description: `findings source=review sha=${HEAD.slice(0, 7)} count=1`,
    });
  });

  it("CLASS P1 snapshot-inconsistent clean-only remains pending", () => {
    const plan = collectAndPlan(raw({
      timelineEvents: [
        { event: "ready_for_review", createdAt: EARLY },
        { event: "convert_to_draft", createdAt: PRE_READY },
      ],
      issueComments: [issueComment({ body: cleanBody(HEAD), createdAt: AFTER })],
    }));
    expect(plan).toEqual({
      kind: "write",
      context: CODEX_ADVISORY_STATUS_CONTEXT,
      state: "pending",
      description: "pending reasons=snapshot-inconsistent; advice=wait",
    });
  });

  it("FIX C selects the latest ready event after an earlier draft conversion", () => {
    const timelineEvents = [
      { event: "ready_for_review", createdAt: EARLY },
      { event: "convert_to_draft", createdAt: PRE_READY },
      { event: "ready_for_review", createdAt: READY_AT },
    ];
    expect(selectBoundary({
      headSha: HEAD,
      prState: "ready",
      prCreatedAt: CREATED,
      reviews: [],
      timelineEvents,
      timelineComplete: true,
      headChangedAt: CREATED,
      issueComments: [],
      issueCommentsComplete: true,
    })).toEqual({
      kind: "selected",
      boundary: { kind: "ready-for-review", occurredAt: READY_AT },
      reactionSubject: { kind: "pull-request" },
    });
  });

  it("qa gap-1 selects max-instant ready and draft events from non-monotonic input", () => {
    const timelineEvents = [
      { event: "ready_for_review", createdAt: LATER },
      { event: "convert_to_draft", createdAt: READY_AT },
      { event: "ready_for_review", createdAt: EARLY },
      { event: "convert_to_draft", createdAt: PRE_READY },
    ];
    expect(selectBoundary({
      headSha: HEAD,
      prState: "ready",
      prCreatedAt: CREATED,
      reviews: [],
      timelineEvents,
      timelineComplete: true,
      headChangedAt: CREATED,
      issueComments: [],
      issueCommentsComplete: true,
    })).toEqual({
      kind: "selected",
      boundary: { kind: "ready-for-review", occurredAt: LATER },
      reactionSubject: { kind: "pull-request" },
    });
  });

  it.each(["head_ref_deleted", "head_ref_restored"] as const)(
    "T13 %s visibly advances the head episode",
    (event) => {
      const timeline = [{ event, createdAt: PRE_READY }];
      expect(deriveHeadChangedAt(CREATED, timeline)).toBe(PRE_READY);
      expect(headAdvancedPastBoundary(HEAD, timeline, [], [], OPENED)).toBe(true);
      const write = expectDescription(collectAndPlan(raw({ timelineEvents: timeline })), "pending");
      expect(write?.description).toContain("awaiting-retrigger");
    },
  );

  it("FIX A uses the latest visible event and retains the PR-created floor", () => {
    expect(deriveHeadChangedAt(CREATED, [
      { event: "head_ref_deleted", createdAt: EARLY },
      { event: "ready_for_review", createdAt: EVALUATED },
      { event: "head_ref_restored", createdAt: LATER },
      { event: "head_ref_force_pushed", createdAt: "2026-08-08T09:59:00Z" },
    ])).toBe(LATER);
  });

  it("T15 draft advice is not-applicable when visible advance awaits retrigger", () => {
    const plan = collectAndPlan(raw({
      pullRequest: {
        headSha: HEAD, isDraft: true, headRepoIsSameRepo: true, createdAt: CREATED,
      },
      timelineEvents: [{ event: "head_ref_force_pushed", createdAt: PRE_READY }],
    }));
    expect(plan).toEqual({
      kind: "write",
      context: CODEX_ADVISORY_STATUS_CONTEXT,
      state: "pending",
      description: "pending reasons=awaiting-retrigger; advice=not-applicable-draft",
    });
  });
});

describe("T14 completeness, malformed resources, and findings precedence", () => {
  it("[661] untrustworthy head and fork targets remain exact no-write", () => {
    expect(collectAndPlan(raw({
      pullRequest: {
        headSha: "bad", isDraft: false, headRepoIsSameRepo: true, createdAt: CREATED,
      },
    }))).toEqual({ kind: "no-write", reason: "malformed-pr" });
    expect(collectAndPlan(raw({
      pullRequest: {
        headSha: HEAD, isDraft: false, headRepoIsSameRepo: "yes", createdAt: CREATED,
      },
    }))).toEqual({ kind: "no-write", reason: "malformed-pr" });
    expect(collectAndPlan(raw({
      pullRequest: {
        headSha: HEAD, isDraft: false, headRepoIsSameRepo: false, createdAt: CREATED,
      },
    }))).toEqual({ kind: "no-write", reason: "fork-head" });
  });

  const malformedMetadataCases = [
    { label: "string draft", isDraft: "yes", createdAt: CREATED },
    { label: "numeric draft", isDraft: 1, createdAt: CREATED },
    { label: "missing draft", isDraft: undefined, createdAt: CREATED },
    { label: "malformed creation time", isDraft: false, createdAt: "bad" },
  ] as const;

  it.each(malformedMetadataCases)(
    "[661] $label still surfaces a current-head finding",
    ({ isDraft, createdAt }) => {
      expect(collectAndPlan(raw({
        pullRequest: {
          headSha: HEAD, isDraft, headRepoIsSameRepo: true, createdAt,
        },
        reviews: [review(HEAD, AFTER)],
        reviewComments: [{ pullRequestReviewId: 7 }],
      }))).toEqual({
        kind: "write",
        context: CODEX_ADVISORY_STATUS_CONTEXT,
        state: "failure",
        description: `findings source=review sha=${HEAD.slice(0, 7)} count=1`,
      });
    },
  );

  it("[661]/[665] malformed creation and evaluation times still surface findings", () => {
    expect(collectAndPlan(raw({
      pullRequest: {
        headSha: HEAD, isDraft: false, headRepoIsSameRepo: true, createdAt: "bad",
      },
      evaluatedAt: "bad",
      reviews: [review(HEAD, AFTER)],
      reviewComments: [{ pullRequestReviewId: 7 }],
    }))).toEqual({
      kind: "write",
      context: CODEX_ADVISORY_STATUS_CONTEXT,
      state: "failure",
      description: `findings source=review sha=${HEAD.slice(0, 7)} count=1`,
    });
  });

  it.each(malformedMetadataCases)(
    "[661] $label with clean-only evidence writes pending",
    ({ isDraft, createdAt }) => {
      expect(collectAndPlan(raw({
        pullRequest: {
          headSha: HEAD, isDraft, headRepoIsSameRepo: true, createdAt,
        },
        issueComments: [issueComment({ body: cleanBody(HEAD), createdAt: AFTER })],
      }))).toEqual({
        kind: "write",
        context: CODEX_ADVISORY_STATUS_CONTEXT,
        state: "pending",
        description: "pending reasons=malformed-pr-metadata; advice=wait",
      });
    },
  );

  it.each(malformedMetadataCases)(
    "[661] $label without findings writes pending",
    ({ isDraft, createdAt }) => {
      expect(collectAndPlan(raw({
        pullRequest: {
          headSha: HEAD, isDraft, headRepoIsSameRepo: true, createdAt,
        },
      }))).toEqual({
        kind: "write",
        context: CODEX_ADVISORY_STATUS_CONTEXT,
        state: "pending",
        description: "pending reasons=malformed-pr-metadata; advice=wait",
      });
    },
  );

  it("[661] a fully valid PR keeps its clean-comment result unchanged", () => {
    expect(collectAndPlan(raw({
      issueComments: [issueComment({ body: cleanBody(HEAD), createdAt: AFTER })],
    }))).toEqual({
      kind: "write",
      context: CODEX_ADVISORY_STATUS_CONTEXT,
      state: "success",
      description: `clean channel=clean-comment sha=${HEAD.slice(0, 7)}`,
    });
  });

  it.each(["review", "comment"] as const)(
    "[665] malformed evaluatedAt still surfaces current-head %s findings",
    (source) => {
      const findingsBody = `Codex Review: Found issues\n\nReviewed commit: ${HEAD}`;
      const input = raw({
        evaluatedAt: "bad",
        reviews: source === "review" ? [review(HEAD, AFTER)] : [],
        reviewComments: source === "review" ? [{ pullRequestReviewId: 7 }] : [],
        issueComments: source === "comment"
          ? [issueComment({ body: findingsBody, createdAt: AFTER })]
          : [],
      });
      expect(collectAndPlan(input)).toEqual({
        kind: "write",
        context: CODEX_ADVISORY_STATUS_CONTEXT,
        state: "failure",
        description: `findings source=${source} sha=${HEAD.slice(0, 7)} count=1`,
      });
    },
  );

  it("[665] malformed evaluatedAt without findings writes pending", () => {
    const input = raw({ evaluatedAt: "bad" });
    expect(collectSignalInput(input)).toEqual({
      kind: "pending", reason: "malformed-evaluated-at", prState: "ready",
    });
    expect(collectAndPlan(input)).toEqual({
      kind: "write",
      context: CODEX_ADVISORY_STATUS_CONTEXT,
      state: "pending",
      description: "pending reasons=malformed-evaluated-at; advice=wait",
    });
  });

  it("[665] malformed evaluatedAt with a clean comment cannot succeed", () => {
    expect(collectAndPlan(raw({
      evaluatedAt: "bad",
      issueComments: [issueComment({ body: cleanBody(HEAD), createdAt: AFTER })],
    }))).toEqual({
      kind: "write",
      context: CODEX_ADVISORY_STATUS_CONTEXT,
      state: "pending",
      description: "pending reasons=malformed-evaluated-at; advice=wait",
    });
  });

  it("timeline and trigger-source incompleteness return exact collection pending", () => {
    expect(collectSignalInput(withComplete(raw(), { timelineEvents: false }))).toEqual({
      kind: "pending", reason: "timeline-incomplete", prState: "ready",
    });
    expect(collectSignalInput(withComplete(raw(), { issueComments: false }))).toEqual({
      kind: "pending", reason: "trigger-evidence-incomplete", prState: "ready",
    });
  });

  it.each(["review", "comment"] as const)(
    "P2 indeterminate timeline still surfaces current-head %s findings",
    (source) => {
      const findingsBody = `Codex Review: Found issues\n\nReviewed commit: ${HEAD}`;
      const input = source === "review"
        ? raw({
            reviews: [review(HEAD, AFTER)],
            reviewComments: [{ pullRequestReviewId: 7 }],
          })
        : raw({
            issueComments: [issueComment({ body: findingsBody, createdAt: AFTER })],
          });
      const write = expectDescription(collectAndPlan(withComplete(
        input, { timelineEvents: false },
      )), "failure");
      expect(write?.description).toBe(
        `findings source=${source} sha=${HEAD.slice(0, 7)} count=1`,
      );
    },
  );

  it("P2 indeterminate timeline cannot promote a current-head clean signal", () => {
    const plan = collectAndPlan(withComplete(raw({
      issueComments: [issueComment({ body: cleanBody(HEAD), createdAt: AFTER })],
    }), { timelineEvents: false }));
    expect(plan).toEqual({
      kind: "write",
      context: CODEX_ADVISORY_STATUS_CONTEXT,
      state: "pending",
      description: "pending reasons=timeline-incomplete; advice=wait",
    });
  });

  it("P2 indeterminate timeline does not surface old-head findings", () => {
    const plan = collectAndPlan(withComplete(raw({
      reviews: [review(OLD_HEAD, AFTER)],
      reviewComments: [{ pullRequestReviewId: 7 }],
    }), { timelineEvents: false }));
    expect(plan).toEqual({
      kind: "write",
      context: CODEX_ADVISORY_STATUS_CONTEXT,
      state: "pending",
      description: "pending reasons=timeline-incomplete; advice=wait",
    });
  });

  it.each([
    "timelineEvents", "reviews", "reviewComments", "issueComments",
    "prReviewComments", "reactions",
  ] as const)("an absent %s array cannot be made complete by its claim bit", (source) => {
    const input = raw({
      [source]: undefined,
      issueComments: source === "issueComments"
        ? undefined
        : [issueComment({ createdAt: EARLY })],
    });
    const plan = expectDescription(collectAndPlan(input), "pending");
    expect(plan?.description).toMatch(
      source === "timelineEvents" ? /timeline-incomplete/u
        : source === "issueComments" ? /trigger-evidence-incomplete/u
          : /evidence-incomplete/u,
    );
  });

  it("no incomplete evidence condition can promote a clean comment", () => {
    for (const source of ["reviews", "reviewComments", "prReviewComments", "reactions"] as const) {
      const write = expectDescription(collectAndPlan(withComplete(raw({
        issueComments: [issueComment({ createdAt: EARLY })],
      }), { [source]: false })), "pending");
      expect(write?.description).toContain("evidence-incomplete");
    }
    for (const claimed of [undefined, 1, "true"]) {
      const write = expectDescription(collectAndPlan(raw({
        issueComments: [issueComment({ createdAt: EARLY })],
        sourceComplete: { ...COMPLETE, reactions: claimed },
      })), "pending");
      expect(write?.description).toContain("evidence-incomplete");
    }
  });

  it("current-head findings remain failure, including on a draft", () => {
    const finding = review(HEAD, AFTER);
    const ready = expectDescription(collectAndPlan(raw({ reviews: [finding] })), "failure");
    expect(ready?.description).toBe(`findings source=review sha=${HEAD.slice(0, 7)} count=0`);
    const draft = expectDescription(collectAndPlan(raw({
      pullRequest: {
        headSha: HEAD, isDraft: true, headRepoIsSameRepo: true, createdAt: CREATED,
      },
      reviews: [finding],
    })), "failure");
    expect(draft?.description).toBe(`findings source=review sha=${HEAD.slice(0, 7)} count=0`);

    const findingBody = `Codex Review: Found issues\n\nReviewed commit: ${HEAD}\nattacker text`;
    const comment = expectDescription(collectAndPlan(raw({
      issueComments: [issueComment({ body: findingBody })],
    })), "failure");
    expect(comment?.description).toBe(
      `findings source=comment sha=${HEAD.slice(0, 7)} count=1`,
    );
    expect(comment?.description).not.toContain("attacker text");
  });

  it("unexpected property access is caught as internal failure", () => {
    const hostile = new Proxy({} as RawCollectionInput, {
      get() { throw new Error("unexpected"); },
    });
    expect(collectAndPlan(hostile)).toEqual({ kind: "no-write", reason: "internal-failure" });
  });
});

describe("supporting mapping and structural-scope guards", () => {
  it("P2-b keeps reviewed-commit marker parsing in behavioral parity with the reducer", () => {
    const cases = [
      { name: "identical-dup", body: `${cleanBody()}\nReviewed commit: ${HEAD}`, sha: HEAD },
      { name: "conflicting-dup", body: `${cleanBody()}\nReviewed commit: ${OLD_HEAD}`, sha: null },
      { name: "single-valid", body: cleanBody(), sha: HEAD },
      { name: "single-malformed", body: cleanBody(HEAD, " trailing"), sha: null },
      { name: "none", body: CODEX_CLEAN_COMMENT_TITLE, sha: null },
    ];
    for (const { name, body, sha } of cases) {
      expect(singleReviewedCommitSha(body), name).toBe(sha);
      expect(reducerMarkerSha(body), name).toBe(sha);
    }
  });

  it("qa gap-3 rejects a malformed reviewed-commit suffix without throwing", () => {
    const body = `Reviewed commit: ${HEAD} attacker-suffix`;
    expect(() => singleReviewedCommitSha(body)).not.toThrow();
    expect(singleReviewedCommitSha(body)).toBeNull();
  });

  it("drops invalid reviews and orphan or malformed review-thread records", () => {
    const valid = review();
    expect(mapReviews([valid], [{ pullRequestReviewId: 99 }], true, true).complete).toBe(false);
    expect(mapReviews([valid], [{ pullRequestReviewId: "7" }], true, true).complete).toBe(false);
    expect(mapReviews([{
      ...valid, state: "PENDING",
    }], [], true, true)).toEqual({ records: [], complete: false });
    expect(mapReviews([], [], true, true)).toEqual({ records: [], complete: true });

    const withOrphan = collectAndPlan(raw({
      issueComments: [issueComment({ createdAt: EARLY })],
      reviewComments: [{ pullRequestReviewId: 99 }],
    }));
    expect(expectDescription(withOrphan, "pending")?.description)
      .toContain("evidence-incomplete");
  });

  it("maps both comment channels and fails completeness on malformed siblings", () => {
    const mapped = mapTopLevelComments(
      [issueComment({ authorLogin: "CaseExact" })],
      [{ authorLogin: CODEX_BOT_LOGIN, body: "reply", createdAt: AFTER, id: 9 }],
      true,
      true,
    );
    expect(mapped).toEqual({
      complete: true,
      records: [
        expect.objectContaining({ authorLogin: "CaseExact", channel: "issue-comment" }),
        expect.objectContaining({ authorLogin: CODEX_BOT_LOGIN, channel: "review-thread-reply" }),
      ],
    });
    expect(mapTopLevelComments(
      [issueComment()],
      [{ authorLogin: "x", body: "bad", createdAt: "bad", id: 9 }],
      true,
      true,
    ).complete).toBe(false);
  });

  it("reaction subjects remain structurally scoped and byte-exact", () => {
    expect(mapReactions(
      reactionPair(), { kind: "pull-request" },
      { kind: "issue-comment", commentId: 77 }, true,
    )).toEqual({ records: [], complete: false });
    expect(mapReactions(
      reactionPair(), { kind: "issue-comment", commentId: 77 },
      { kind: "pull-request" }, true,
    )).toEqual({ records: [], complete: false });
    expect(mapReactions(
      [{ authorLogin: "x", content: "heart", createdAt: AFTER }],
      { kind: "pull-request" }, { kind: "pull-request" }, true,
    )).toEqual({
      complete: true,
      records: [{
        authorLogin: "x", content: "other", createdAt: AFTER, subjectId: "pull-request",
      }],
    });
    expect(mapReactions(
      [{ authorLogin: "x", content: "not-a-reaction", createdAt: AFTER }],
      { kind: "pull-request" }, { kind: "pull-request" }, true,
    )).toEqual({ records: [], complete: false });
  });

  it("bot-authored trigger text is excluded and malformed siblings suppress attribution", () => {
    const bot = issueComment({ body: CODEX_TRIGGER_PHRASE, createdAt: EARLY });
    const human = issueComment({
      authorLogin: "operator", body: CODEX_TRIGGER_PHRASE,
      createdAt: EARLY, id: 77,
    });
    expect(mapTriggerComments([bot], HEAD, OPENED, CREATED)).toEqual([]);
    expect(mapTriggerComments([human], HEAD, OPENED, CREATED)).toEqual([
      { createdAt: EARLY, onHeadSha: HEAD },
    ]);
    expect(mapTriggerComments([human, issueComment({ id: null })], HEAD, OPENED, CREATED))
      .toEqual([]);
    expect(selectBoundary({
      headSha: HEAD,
      prState: "ready",
      prCreatedAt: CREATED,
      reviews: [],
      timelineEvents: [],
      timelineComplete: true,
      headChangedAt: CREATED,
      issueComments: [bot],
      issueCommentsComplete: true,
    })).toEqual({
      kind: "selected",
      boundary: OPENED,
      reactionSubject: { kind: "pull-request" },
    });
  });

  it("qa gap-2 retains the selected manual trigger at the boundary despite a later head floor", () => {
    const trigger = issueComment({
      authorLogin: "operator", body: CODEX_TRIGGER_PHRASE,
      createdAt: EARLY, id: 77,
    });
    const boundary: CodexBoundary = { kind: "manual-retrigger", occurredAt: EARLY };
    const triggerComments = mapTriggerComments([trigger], HEAD, boundary, AFTER);
    expect(triggerComments).toEqual([{ createdAt: EARLY, onHeadSha: HEAD }]);
    expect(reduceCodexVerdict({
      headSha: HEAD,
      prState: "ready",
      boundary,
      headChangedAt: AFTER,
      reviews: [],
      topLevelComments: [],
      reactions: [],
      evidenceComplete: { reviews: true, topLevelComments: true, reactions: true },
      triggerComments,
      evaluatedAt: EVALUATED,
    })).toMatchObject({
      verdict: "unknown-pending",
      manualTriggerAdvice: "already-posted",
    });
  });

  it("an unknown or malformed timeline record is indeterminate", () => {
    for (const timelineEvents of [
      [{ event: "closed", createdAt: AFTER }],
      [{ event: "ready_for_review", createdAt: "not-an-instant" }],
    ]) {
      expect(selectBoundary({
        headSha: HEAD,
        prState: "ready",
        prCreatedAt: CREATED,
        reviews: [],
        timelineEvents,
        timelineComplete: true,
        headChangedAt: CREATED,
        issueComments: [],
        issueCommentsComplete: true,
      })).toEqual({ kind: "indeterminate", reason: "timeline-incomplete" });
    }
  });
});

describe("status mapping and output grammar", () => {
  it("reaction-pair clean is the only clean verdict shape demoted", () => {
    const reactionVerdict: CodexVerdict = {
      verdict: "clean",
      channel: "reaction-pair",
      evidence: {
        channel: "reaction-pair",
        authorLogin: CODEX_BOT_LOGIN,
        subjectId: "pull-request",
        eyesAt: EARLY,
        plusOneAt: PRE_READY,
        headChangedAt: CREATED,
        boundaryKind: "opened",
        boundaryOccurredAt: CREATED,
      },
      ratchetEligible: true,
    };
    expect(verdictToStatusPlan(reactionVerdict)).toEqual({
      context: CODEX_ADVISORY_STATUS_CONTEXT,
      state: "pending",
      description: "pending reasons=reaction-clean-unconfirmed; advice=verify",
    });
  });

  it("every reducer pending reason remains pending", () => {
    const reasons: PendingReason[] = [
      "malformed-input", "not-ready-draft", "evidence-incomplete", "no-bot-signal",
      "stale-head-signal-only", "pre-boundary-signal-only",
      "non-bot-author-signal-only", "unpaired-or-misordered-reactions",
      "head-change-indeterminate", "unrecognised-bot-comment-only",
    ];
    for (const reason of reasons) {
      expect(verdictToStatusPlan({
        verdict: "unknown-pending",
        reasons: [reason],
        manualTriggerAdvice: "wait",
        ratchetEligible: false,
      }).state).toBe("pending");
    }
  });

  it("T16 closed-description-grammar never reflects attacker-controlled comment text", () => {
    const attackerBody = [
      "# [markdown](https://evil.invalid)",
      `Reviewed commit: ${HEAD}`,
      "@everyone",
      CODEX_TRIGGER_PHRASE,
    ].join("\n");
    const write = expectDescription(collectAndPlan(raw({
      issueComments: [issueComment({
        authorLogin: "attacker", body: attackerBody, createdAt: EARLY, id: 99,
      })],
    })), "pending");
    for (const fragment of [
      "markdown", "evil.invalid", "Reviewed commit:", "@everyone", CODEX_TRIGGER_PHRASE,
    ]) expect(write?.description).not.toContain(fragment);
  });

  it("descriptions remain deterministic and bounded at the maximum reason set", () => {
    const verdict: CodexVerdict = {
      verdict: "unknown-pending",
      reasons: [
        "malformed-input", "not-ready-draft", "evidence-incomplete", "no-bot-signal",
        "stale-head-signal-only", "pre-boundary-signal-only",
        "non-bot-author-signal-only", "unpaired-or-misordered-reactions",
        "head-change-indeterminate", "unrecognised-bot-comment-only",
      ],
      manualTriggerAdvice: "due",
      ratchetEligible: false,
    };
    const first = verdictToStatusPlan(verdict);
    expect(first.description).toMatch(STATUS_GRAMMAR);
    expect(first.description.length).toBeLessThanOrEqual(MAX_STATUS_DESCRIPTION_LENGTH);
    expect(first.description).toContain("omitted=");
    expect(verdictToStatusPlan(verdict)).toEqual(first);
  });

  it("coverage: overlong pending reasons truncate deterministically with an omission count", () => {
    const reasons = Array.from(
      { length: 20 },
      () => "unpaired-or-misordered-reactions" as const,
    );
    const verdict: CodexVerdict = {
      verdict: "unknown-pending",
      reasons,
      manualTriggerAdvice: "due",
      ratchetEligible: false,
    };
    const first = verdictToStatusPlan(verdict);
    expect(first.description).toMatch(STATUS_GRAMMAR);
    expect(first.description.length).toBeLessThanOrEqual(MAX_STATUS_DESCRIPTION_LENGTH);
    expect(first.description).toMatch(/; omitted=\d+; advice=due;/u);
    expect(verdictToStatusPlan(verdict)).toEqual(first);
  });

  it("coverage: an empty typed pending-reason list uses the malformed-input fallback", () => {
    expect(verdictToStatusPlan({
      verdict: "unknown-pending",
      reasons: [],
      manualTriggerAdvice: "wait",
      ratchetEligible: false,
    })).toEqual({
      context: CODEX_ADVISORY_STATUS_CONTEXT,
      state: "pending",
      description: "pending reasons=malformed-input; advice=wait",
    });
  });
});

describe("determinism and purity", () => {
  it("returns byte-identical results for byte-identical input", () => {
    const input = raw({ issueComments: [issueComment({ createdAt: EARLY })] });
    expect(JSON.stringify(collectAndPlan(input))).toBe(JSON.stringify(collectAndPlan(input)));
  });

  it("T17 no forgeable-time-source or impure identifier exists in the module", () => {
    const source = readFileSync(
      new URL("../../scripts/factory/codex-signal-collection-logic.mts", import.meta.url),
      "utf8",
    );
    expect(source).not.toMatch(
      /Date\.now|new\s+Date|Math\.random|node:fs|\bfetch\s*\(|\bgithubRequest\b|git(?:Commit|Author)|committedAt/u,
    );
  });
});
