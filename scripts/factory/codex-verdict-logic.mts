import { CODEX_TRIGGER_PHRASE } from "./implement-patch-logic.mts";
import {
  FULL_SHA_PATTERN,
  LINE_SPLIT_PATTERN,
  isBoundary,
  isCommentRecord,
  isEvidenceComplete,
  isPlainRecord,
  isReactionRecord,
  isReviewRecord,
  isSignalInput,
  isTriggerRecord,
  parseStrictIsoUtc,
  type CodexBoundary,
  type CodexCommentRecord,
  type CodexReactionRecord,
  type CodexReviewRecord,
  type CodexSignalInput,
} from "./codex-signal-schema.mts";

export const CODEX_BOT_LOGIN = "chatgpt-codex-connector[bot]";
export const CODEX_CLEAN_COMMENT_TITLE =
  "Codex Review: Didn't find any major issues";
export const CODEX_WAIT_TIMEOUT_MINUTES = 30;

const REVIEWED_COMMIT_LINE_ANCHORED = /^Reviewed commit: ([0-9a-f]{40})$/u;

export type PendingReason =
  | "malformed-input"
  | "not-ready-draft"
  | "evidence-incomplete"
  | "no-bot-signal"
  | "stale-head-signal-only"
  | "pre-boundary-signal-only"
  | "non-bot-author-signal-only"
  | "unpaired-or-misordered-reactions"
  | "head-change-indeterminate"
  | "unrecognised-bot-comment-only";

export type ManualTriggerAdvice =
  | "wait"
  | "due"
  | "already-posted"
  | "not-applicable-draft";

export type CleanEvidence =
  | {
      readonly channel: "clean-comment";
      readonly authorLogin: string;
      readonly matchedSha: string;
      readonly signalAt: string;
      readonly boundaryKind: CodexBoundary["kind"];
      readonly boundaryOccurredAt: string;
    }
  | {
      readonly channel: "reaction-pair";
      readonly authorLogin: string;
      readonly subjectId: string;
      readonly eyesAt: string;
      readonly plusOneAt: string;
      readonly headChangedAt: string;
      readonly boundaryKind: CodexBoundary["kind"];
      readonly boundaryOccurredAt: string;
    };

export interface FindingsEvidence {
  readonly authorLogin: string;
  readonly matchedSha: string;
  readonly submittedAt: string;
  readonly inlineThreadCount: number;
  readonly boundaryKind: CodexBoundary["kind"];
  readonly boundaryOccurredAt: string;
}

export type CodexVerdict =
  | {
      readonly verdict: "clean";
      readonly channel: "clean-comment" | "reaction-pair";
      readonly evidence: CleanEvidence;
      readonly ratchetEligible: true;
    }
  | {
      readonly verdict: "findings";
      readonly evidence: FindingsEvidence;
      readonly ratchetEligible: true;
    }
  | {
      readonly verdict: "unknown-pending";
      readonly reasons: readonly PendingReason[];
      readonly manualTriggerAdvice: ManualTriggerAdvice;
      readonly ratchetEligible: false;
    };

/** Return true only when both strict UTC instants parse and `a` is later. */
export function postdates(a: string, b: string): boolean {
  const left = parseStrictIsoUtc(a);
  const right = parseStrictIsoUtc(b);
  return left !== null && right !== null && left > right;
}

/** Exact bot identity check; intentionally no normalization of untrusted text. */
export function isCodexBot(login: string): boolean {
  return login === CODEX_BOT_LOGIN;
}

function hasCleanTitleLine(body: string): boolean {
  const firstNonBlankLine = body.split(LINE_SPLIT_PATTERN)
    .find((line) => !/^\s*$/u.test(line));
  if (firstNonBlankLine === undefined) return false;
  if (firstNonBlankLine === CODEX_CLEAN_COMMENT_TITLE) return true;
  const heading = /^(#{1,6}) /u.exec(firstNonBlankLine);
  return heading !== null &&
    firstNonBlankLine.slice(heading[0].length) === CODEX_CLEAN_COMMENT_TITLE;
}

function reviewedCommitSha(body: string): string | null {
  for (const line of body.split(LINE_SPLIT_PATTERN)) {
    const match = line.match(REVIEWED_COMMIT_LINE_ANCHORED);
    if (match !== null) return match[1];
  }
  return null;
}

function hasReviewedCommitPrefix(body: string): boolean {
  return body.split(LINE_SPLIT_PATTERN).some((line) =>
    line.startsWith("Reviewed commit:"));
}

/**
 * Test a comment against the accepted clean-comment grammar. The first
 * non-blank title line authenticates the verdict comment. Its reviewed-commit
 * line may then occur anywhere because exact SHA, freshness, and completeness
 * checks independently gate acceptance; no Markdown/HTML location heuristic
 * is needed.
 */
export function isCleanComment(
  comment: CodexCommentRecord,
  headSha: string,
  boundary: CodexBoundary,
  headChangedAt: string | null,
): boolean {
  const reviewedCommit = reviewedCommitSha(comment.body);
  return (
    isCodexBot(comment.authorLogin) &&
    comment.channel === "issue-comment" &&
    hasCleanTitleLine(comment.body) &&
    reviewedCommit === headSha &&
    postdatesBoundary(comment.createdAt, boundary) &&
    headChangedAt !== null &&
    postdates(comment.createdAt, headChangedAt)
  );
}

/** Apply the caller-declared PR-shape boundary with strict `>` semantics. */
export function postdatesBoundary(
  signalAt: string,
  boundary: CodexBoundary,
): boolean {
  return postdates(signalAt, boundary.occurredAt);
}

function findCleanReactionPair(
  reactions: readonly CodexReactionRecord[],
  boundary: CodexBoundary,
  headChangedAt: string | null,
): readonly [CodexReactionRecord, CodexReactionRecord] | null {
  if (headChangedAt === null || parseStrictIsoUtc(headChangedAt) === null) return null;
  for (const eyes of reactions) {
    if (eyes.content !== "eyes" || !isCodexBot(eyes.authorLogin)) continue;
    for (const plusOne of reactions) {
      if (
        plusOne.content === "+1" &&
        isCodexBot(plusOne.authorLogin) &&
        eyes.subjectId.length > 0 &&
        plusOne.subjectId === eyes.subjectId &&
        postdates(plusOne.createdAt, eyes.createdAt) &&
        postdatesBoundary(eyes.createdAt, boundary) &&
        postdatesBoundary(plusOne.createdAt, boundary) &&
        postdates(plusOne.createdAt, headChangedAt)
      ) {
        return [eyes, plusOne];
      }
    }
  }
  return null;
}

/** Test bot-authored, same-subject, ordered reactions against head freshness. */
export function isCleanReactionPair(
  reactions: readonly CodexReactionRecord[],
  boundary: CodexBoundary,
  headChangedAt: string | null,
): boolean {
  return findCleanReactionPair(reactions, boundary, headChangedAt) !== null;
}

/** Every current-head, post-boundary bot review is findings, even with no threads. */
export function isFindingsReview(
  review: CodexReviewRecord,
  headSha: string,
  boundary: CodexBoundary,
): boolean {
  return (
    isCodexBot(review.authorLogin) &&
    review.commitSha === headSha &&
    postdatesBoundary(review.submittedAt, boundary)
  );
}

/** Substring matching deliberately over-detects the connector trigger safely. */
export function containsCodexTriggerPhrase(body: string): boolean {
  return body.includes(CODEX_TRIGGER_PHRASE);
}

/** Compute operator advice without ever changing the evidence verdict. */
export function manualTriggerAdvice(input: CodexSignalInput): ManualTriggerAdvice {
  if (input.prState === "draft") return "not-applicable-draft";
  if (
    input.prState !== "ready" ||
    !FULL_SHA_PATTERN.test(input.headSha) ||
    !isBoundary(input.boundary) ||
    parseStrictIsoUtc(input.evaluatedAt) === null ||
    !Array.isArray(input.reviews) ||
    !input.reviews.every(isReviewRecord) ||
    !Array.isArray(input.topLevelComments) ||
    !input.topLevelComments.every(isCommentRecord) ||
    !Array.isArray(input.triggerComments) ||
    !input.triggerComments.every(isTriggerRecord) ||
    !Array.isArray(input.reactions) ||
    !input.reactions.every(isReactionRecord) ||
    !isEvidenceComplete(input.evidenceComplete)
  ) {
    return "wait";
  }
  if (
    input.triggerComments.some(
      (trigger) =>
        trigger.onHeadSha === input.headSha &&
        (postdatesBoundary(trigger.createdAt, input.boundary) ||
          (input.boundary.kind === "manual-retrigger" &&
            trigger.createdAt === input.boundary.occurredAt)),
    )
  ) {
    return "already-posted";
  }
  if (!(input.evidenceComplete.reviews &&
    input.evidenceComplete.topLevelComments &&
    input.evidenceComplete.reactions)) return "wait";
  const evaluatedAt = parseStrictIsoUtc(input.evaluatedAt);
  const boundaryAt = parseStrictIsoUtc(input.boundary.occurredAt);
  if (evaluatedAt === null || boundaryAt === null) return "wait";
  const botSignalEngaged = [
    ...input.reviews.map((review) => ({
      authorLogin: review.authorLogin,
      occurredAt: review.submittedAt,
    })),
    ...input.topLevelComments.map((comment) => ({
      authorLogin: comment.authorLogin,
      occurredAt: comment.createdAt,
    })),
    ...input.reactions.map((reaction) => ({
      authorLogin: reaction.authorLogin,
      occurredAt: reaction.createdAt,
    })),
  ].some((signal) =>
    isCodexBot(signal.authorLogin) &&
    postdatesBoundary(signal.occurredAt, input.boundary));
  if (botSignalEngaged) return "wait";
  const timeoutMilliseconds = CODEX_WAIT_TIMEOUT_MINUTES * 60 * 1000;
  return evaluatedAt - boundaryAt >= timeoutMilliseconds
    ? "due"
    : "wait";
}

function malformedVerdict(value: unknown): CodexVerdict {
  const draft = isPlainRecord(value) && value.prState === "draft";
  return {
    verdict: "unknown-pending",
    reasons: ["malformed-input"],
    manualTriggerAdvice: draft ? "not-applicable-draft" : "wait",
    ratchetEligible: false,
  };
}

function addReason(reasons: PendingReason[], reason: PendingReason): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

/**
 * Reduce validated public PR metadata to the fail-closed Codex merge-wait state.
 * Findings outrank clean evidence; timeout affects advice only. This function
 * catches malformed runtime values despite the caller-facing TypeScript type.
 * Per P5, the reducer trusts the caller-declared boundary: after any head push
 * that postdates the prior boundary, the caller MUST supply a manual-retrigger
 * boundary rather than reusing `opened` or `ready-for-review`.
 */
export function reduceCodexVerdict(input: CodexSignalInput): CodexVerdict {
  try {
    if (!isSignalInput(input)) return malformedVerdict(input);
    if (input.prState !== "ready") {
      return {
        verdict: "unknown-pending",
        reasons: ["not-ready-draft"],
        manualTriggerAdvice: "not-applicable-draft",
        ratchetEligible: false,
      };
    }

    const findings = input.reviews.find((review) =>
      isFindingsReview(review, input.headSha, input.boundary));
    if (findings !== undefined) {
      return {
        verdict: "findings",
        evidence: {
          authorLogin: findings.authorLogin,
          matchedSha: findings.commitSha,
          submittedAt: findings.submittedAt,
          inlineThreadCount: findings.inlineThreadCount,
          boundaryKind: input.boundary.kind,
          boundaryOccurredAt: input.boundary.occurredAt,
        },
        ratchetEligible: true,
      };
    }

    const evidenceComplete =
      input.evidenceComplete.reviews &&
      input.evidenceComplete.topLevelComments &&
      input.evidenceComplete.reactions;
    const cleanComment = input.topLevelComments.find((comment) =>
      isCleanComment(comment, input.headSha, input.boundary, input.headChangedAt));
    if (cleanComment !== undefined && evidenceComplete) {
      const matchedSha = reviewedCommitSha(cleanComment.body);
      if (matchedSha !== null) {
        const evidence: CleanEvidence = {
          channel: "clean-comment",
          authorLogin: cleanComment.authorLogin,
          matchedSha,
          signalAt: cleanComment.createdAt,
          boundaryKind: input.boundary.kind,
          boundaryOccurredAt: input.boundary.occurredAt,
        };
        return { verdict: "clean", channel: "clean-comment", evidence, ratchetEligible: true };
      }
    }

    const reactionPair = findCleanReactionPair(
      input.reactions, input.boundary, input.headChangedAt);
    if (reactionPair !== null && input.headChangedAt !== null && evidenceComplete) {
      const [eyes, plusOne] = reactionPair;
      const evidence: CleanEvidence = {
        channel: "reaction-pair",
        authorLogin: plusOne.authorLogin,
        subjectId: plusOne.subjectId,
        eyesAt: eyes.createdAt,
        plusOneAt: plusOne.createdAt,
        headChangedAt: input.headChangedAt,
        boundaryKind: input.boundary.kind,
        boundaryOccurredAt: input.boundary.occurredAt,
      };
      return { verdict: "clean", channel: "reaction-pair", evidence, ratchetEligible: true };
    }

    const reasons: PendingReason[] = [];
    if (!evidenceComplete) addReason(reasons, "evidence-incomplete");
    const relevantReactions = input.reactions.filter((reaction) => reaction.content !== "other");
    const relevantRecords = [
      ...input.reviews,
      ...input.topLevelComments,
      ...relevantReactions,
    ];
    const botRecords = relevantRecords.filter((record) => isCodexBot(record.authorLogin));
    if (relevantRecords.length === 0) addReason(reasons, "no-bot-signal");
    else if (botRecords.length === 0) addReason(reasons, "non-bot-author-signal-only");

    const botComments = input.topLevelComments.filter((comment) => isCodexBot(comment.authorLogin));
    const verdictShapedBotComments = botComments.filter((comment) =>
      comment.channel === "issue-comment" &&
      hasCleanTitleLine(comment.body) &&
      reviewedCommitSha(comment.body) !== null);
    const currentHeadBotComments = verdictShapedBotComments.filter((comment) =>
      reviewedCommitSha(comment.body) === input.headSha);
    if (botComments.length > verdictShapedBotComments.length) {
      addReason(reasons, "unrecognised-bot-comment-only");
    }
    if (botComments.some((comment) =>
      hasCleanTitleLine(comment.body) &&
      hasReviewedCommitPrefix(comment.body) &&
      reviewedCommitSha(comment.body) !== input.headSha)) {
      addReason(reasons, "stale-head-signal-only");
    }
    if (currentHeadBotComments.some((comment) =>
      !postdatesBoundary(comment.createdAt, input.boundary))) {
      addReason(reasons, "pre-boundary-signal-only");
    }
    const postBoundaryCurrentHeadBotComments = currentHeadBotComments.filter((comment) =>
      postdatesBoundary(comment.createdAt, input.boundary));
    if (postBoundaryCurrentHeadBotComments.length > 0) {
      if (input.headChangedAt === null) {
        addReason(reasons, "head-change-indeterminate");
      } else if (postBoundaryCurrentHeadBotComments.some((comment) =>
        !postdates(comment.createdAt, input.headChangedAt as string))) {
        addReason(reasons, "stale-head-signal-only");
      }
    }

    const botReviews = input.reviews.filter((review) => isCodexBot(review.authorLogin));
    if (botReviews.some((review) => review.commitSha !== input.headSha)) {
      addReason(reasons, "stale-head-signal-only");
    }
    if (botReviews.some((review) =>
      review.commitSha === input.headSha &&
      !postdatesBoundary(review.submittedAt, input.boundary))) {
      addReason(reasons, "pre-boundary-signal-only");
    }

    const orderedCurrentPairs: readonly (readonly [CodexReactionRecord, CodexReactionRecord])[] =
      input.reactions.flatMap((eyes) =>
        input.reactions
          .filter((plusOne) =>
            eyes.content === "eyes" && plusOne.content === "+1" &&
            isCodexBot(eyes.authorLogin) && isCodexBot(plusOne.authorLogin) &&
            eyes.subjectId.length > 0 &&
            eyes.subjectId === plusOne.subjectId &&
            postdates(plusOne.createdAt, eyes.createdAt) &&
            postdatesBoundary(eyes.createdAt, input.boundary) &&
            postdatesBoundary(plusOne.createdAt, input.boundary))
          .map((plusOne) => [eyes, plusOne] as const));
    if (relevantReactions.length > 0 && orderedCurrentPairs.length === 0) {
      const orderedBotPairBeforeBoundary = input.reactions.some((eyes) =>
        input.reactions.some((plusOne) =>
          eyes.content === "eyes" && plusOne.content === "+1" &&
          isCodexBot(eyes.authorLogin) && isCodexBot(plusOne.authorLogin) &&
          eyes.subjectId.length > 0 &&
          eyes.subjectId === plusOne.subjectId && postdates(plusOne.createdAt, eyes.createdAt) &&
          (!postdatesBoundary(eyes.createdAt, input.boundary) ||
            !postdatesBoundary(plusOne.createdAt, input.boundary))));
      if (orderedBotPairBeforeBoundary) addReason(reasons, "pre-boundary-signal-only");
      else addReason(reasons, "unpaired-or-misordered-reactions");
    }
    if (orderedCurrentPairs.length > 0) {
      if (input.headChangedAt === null) {
        addReason(reasons, "head-change-indeterminate");
      } else if (orderedCurrentPairs.every(([, plusOne]) =>
        !postdates(plusOne.createdAt, input.headChangedAt as string))) {
        addReason(reasons, "stale-head-signal-only");
      }
    }
    // Intentional defensive fallback: validated evidence should be classified above.
    if (reasons.length === 0) addReason(reasons, "no-bot-signal");
    return {
      verdict: "unknown-pending",
      reasons,
      manualTriggerAdvice: manualTriggerAdvice(input),
      ratchetEligible: false,
    };
  } catch {
    return {
      verdict: "unknown-pending",
      reasons: ["malformed-input"],
      manualTriggerAdvice: "wait",
      ratchetEligible: false,
    };
  }
}
