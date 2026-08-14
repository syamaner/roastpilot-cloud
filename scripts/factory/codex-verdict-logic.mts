import { CODEX_TRIGGER_PHRASE } from "./implement-patch-logic.mts";
import {
  FULL_SHA_PATTERN,
  LINE_SPLIT_PATTERN,
  isBoundary,
  isEvidenceComplete,
  isPlainRecord,
  isReactionRecord,
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
const REVIEWED_COMMIT_PREFIX = "Reviewed commit:";
export const CODEX_NON_VERDICT_NOTICE_LINES = [
  "Review queued.",
  "Review skipped.",
  "Review unable to review.",
  "Unable to review.",
] as const;

type ReviewedCommitResult =
  | { readonly kind: "none" }
  | { readonly kind: "single"; readonly sha: string }
  | { readonly kind: "conflicting" };

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

export type FindingsEvidence =
  | {
      readonly source: "review";
      readonly authorLogin: string;
      readonly matchedSha: string;
      readonly submittedAt: string;
      readonly inlineThreadCount: number;
      readonly boundaryKind: CodexBoundary["kind"];
      readonly boundaryOccurredAt: string;
    }
  | {
      readonly source: "comment";
      readonly authorLogin: string;
      readonly matchedSha: string;
      readonly createdAt: string;
      readonly boundaryKind: CodexBoundary["kind"];
      readonly boundaryOccurredAt: string;
    };

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
      readonly draft: boolean;
      /** Consumers may promote findings only when this value is exactly true. */
      readonly ratchetEligible: boolean;
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

function firstNonBlankLine(body: string): string | null {
  return body.split(LINE_SPLIT_PATTERN)
    .find((line) => !/^\s*$/u.test(line)) ?? null;
}

function hasCleanTitleLine(body: string): boolean {
  const firstNonBlank = firstNonBlankLine(body);
  if (firstNonBlank === null) return false;
  if (firstNonBlank === CODEX_CLEAN_COMMENT_TITLE) return true;
  const heading = /^(#{1,6}) /u.exec(firstNonBlank);
  return heading !== null &&
    firstNonBlank.slice(heading[0].length) === CODEX_CLEAN_COMMENT_TITLE;
}

/** Keep marker parsing and prefix detection on exactly the same line set. */
function isReviewedCommitPrefixedLine(line: string): boolean {
  return line.startsWith(REVIEWED_COMMIT_PREFIX);
}

function reviewedCommitSha(body: string): ReviewedCommitResult {
  const prefixedLines = body.split(LINE_SPLIT_PATTERN)
    .filter(isReviewedCommitPrefixedLine);
  if (prefixedLines.length === 0) return { kind: "none" };
  const shas = new Set<string>();
  for (const line of prefixedLines) {
    const match = line.match(REVIEWED_COMMIT_LINE_ANCHORED);
    if (match === null) return { kind: "conflicting" };
    shas.add(match[1]);
  }
  if (shas.size > 1) return { kind: "conflicting" };
  return { kind: "single", sha: [...shas][0] };
}

function hasReviewedCommitPrefix(body: string): boolean {
  return body.split(LINE_SPLIT_PATTERN)
    .some(isReviewedCommitPrefixedLine);
}

function isRecognizedNonVerdictNotice(body: string): boolean {
  const firstNonBlank = firstNonBlankLine(body);
  return firstNonBlank !== null &&
    CODEX_NON_VERDICT_NOTICE_LINES.includes(
      firstNonBlank as typeof CODEX_NON_VERDICT_NOTICE_LINES[number],
    );
}

interface CommentClassification {
  readonly comment: CodexCommentRecord;
  readonly reviewedCommit: ReviewedCommitResult;
  readonly cleanTitle: boolean;
  readonly cleanGrammar: boolean;
  readonly currentHeadMarker: boolean;
  readonly postBoundary: boolean;
  readonly clean: boolean;
  readonly findings: boolean;
  readonly blocksClean: boolean;
}

function classifyComment(
  comment: CodexCommentRecord,
  headSha: string,
  boundary: CodexBoundary,
  headChangedAt: string | null,
): CommentClassification {
  const reviewedCommit = reviewedCommitSha(comment.body);
  const botTopLevel = isCodexBot(comment.authorLogin) &&
    comment.channel === "issue-comment";
  const cleanTitle = hasCleanTitleLine(comment.body);
  const cleanGrammar = botTopLevel && cleanTitle &&
    reviewedCommit.kind === "single";
  const currentHeadMarker = reviewedCommit.kind === "single" &&
    reviewedCommit.sha === headSha;
  const postBoundary = postdatesBoundary(comment.createdAt, boundary);
  const clean = cleanGrammar && currentHeadMarker && postBoundary &&
    headChangedAt !== null && postdates(comment.createdAt, headChangedAt);
  const recognizedNotice = botTopLevel &&
    isRecognizedNonVerdictNotice(comment.body);
  const findings = botTopLevel && postBoundary && currentHeadMarker &&
    !cleanTitle && !recognizedNotice;
  const blocksClean = isCodexBot(comment.authorLogin) && postBoundary && !clean &&
    (currentHeadMarker || reviewedCommit.kind === "conflicting");
  return {
    comment,
    reviewedCommit,
    cleanTitle,
    cleanGrammar,
    currentHeadMarker,
    postBoundary,
    clean,
    findings,
    blocksClean,
  };
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
  return classifyComment(comment, headSha, boundary, headChangedAt).clean;
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
  // See reduceCodexVerdict's caller contract: reactions are review-object-scoped.
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
  const timeoutMilliseconds = CODEX_WAIT_TIMEOUT_MINUTES * 60 * 1000;
  const engagedEyesInstants: number[] = [];
  for (const reaction of input.reactions) {
    if (reaction.content !== "eyes" || !isCodexBot(reaction.authorLogin) ||
      !postdatesBoundary(reaction.createdAt, input.boundary)) continue;
    const instant = parseStrictIsoUtc(reaction.createdAt);
    /* v8 ignore next -- Defensive fail-closed: unreachable past isReactionRecord
     * (:311; schema codex-signal-schema.mts:141-142) and postdatesBoundary's
     * null-rejection (:117-121); kept so a lone eyes can never anchor "due" on
     * an unparsed time. */
    if (instant === null) return "wait";
    engagedEyesInstants.push(instant);
  }
  if (engagedEyesInstants.length > 0) {
    const eyesAt = Math.max(...engagedEyesInstants);
    return evaluatedAt - eyesAt >= timeoutMilliseconds ? "due" : "wait";
  }
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
 *
 * For the reaction channel, the caller (9d) MUST supply in `reactions` only
 * reactions belonging to the current-head review-request object initiated by
 * the boundary/review-trigger event, never reactions from other `@codex`
 * interactions (such as questions or address commands) on the same PR. With
 * correctly scoped input, same-`subjectId` and freshness pairing is sufficient;
 * the reducer cannot verify which subject is the review request because that
 * identity is intentionally outside this pure reducer's input and is tracked
 * for 9d.
 */
export function reduceCodexVerdict(input: CodexSignalInput): CodexVerdict {
  try {
    if (!isSignalInput(input)) return malformedVerdict(input);
    const commentClassifications = input.topLevelComments.map((comment) =>
      classifyComment(
        comment,
        input.headSha,
        input.boundary,
        input.headChangedAt,
      ));
    const findingsReview = input.reviews.find((review) =>
      isFindingsReview(review, input.headSha, input.boundary));
    const findingsComment = commentClassifications.find(
      (classification) => classification.findings,
    );
    if (findingsReview !== undefined) {
      return {
        verdict: "findings",
        evidence: {
          source: "review",
          authorLogin: findingsReview.authorLogin,
          matchedSha: findingsReview.commitSha,
          submittedAt: findingsReview.submittedAt,
          inlineThreadCount: findingsReview.inlineThreadCount,
          boundaryKind: input.boundary.kind,
          boundaryOccurredAt: input.boundary.occurredAt,
        },
        draft: input.prState === "draft",
        ratchetEligible: input.prState === "ready",
      };
    }
    if (findingsComment !== undefined &&
      findingsComment.reviewedCommit.kind === "single") {
      return {
        verdict: "findings",
        evidence: {
          source: "comment",
          authorLogin: findingsComment.comment.authorLogin,
          matchedSha: findingsComment.reviewedCommit.sha,
          createdAt: findingsComment.comment.createdAt,
          boundaryKind: input.boundary.kind,
          boundaryOccurredAt: input.boundary.occurredAt,
        },
        draft: input.prState === "draft",
        ratchetEligible: input.prState === "ready",
      };
    }
    if (input.prState !== "ready") {
      return {
        verdict: "unknown-pending",
        reasons: ["not-ready-draft"],
        manualTriggerAdvice: "not-applicable-draft",
        ratchetEligible: false,
      };
    }

    const evidenceComplete =
      input.evidenceComplete.reviews &&
      input.evidenceComplete.topLevelComments &&
      input.evidenceComplete.reactions;
    const blockingBotComment = commentClassifications.some(
      (classification) => classification.blocksClean,
    );
    const cleanComment = commentClassifications.find(
      (classification) => classification.clean,
    );
    if (cleanComment !== undefined && evidenceComplete && !blockingBotComment &&
      cleanComment.reviewedCommit.kind === "single") {
      const evidence: CleanEvidence = {
        channel: "clean-comment",
        authorLogin: cleanComment.comment.authorLogin,
        matchedSha: cleanComment.reviewedCommit.sha,
        signalAt: cleanComment.comment.createdAt,
        boundaryKind: input.boundary.kind,
        boundaryOccurredAt: input.boundary.occurredAt,
      };
      return { verdict: "clean", channel: "clean-comment", evidence, ratchetEligible: true };
    }

    const reactionPair = findCleanReactionPair(
      input.reactions, input.boundary, input.headChangedAt);
    if (reactionPair !== null && input.headChangedAt !== null && evidenceComplete &&
      !blockingBotComment) {
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

    const botComments = commentClassifications.filter((classification) =>
      isCodexBot(classification.comment.authorLogin));
    if (botComments.some((classification) =>
      !classification.cleanGrammar && !classification.findings)) {
      addReason(reasons, "unrecognised-bot-comment-only");
    }
    if (botComments.some((classification) =>
      classification.cleanTitle &&
      hasReviewedCommitPrefix(classification.comment.body) &&
      (classification.reviewedCommit.kind !== "single" ||
        classification.reviewedCommit.sha !== input.headSha))) {
      addReason(reasons, "stale-head-signal-only");
    }
    const currentHeadCleanGrammarComments = botComments.filter(
      (classification) => classification.cleanGrammar &&
        classification.currentHeadMarker,
    );
    if (currentHeadCleanGrammarComments.some((classification) =>
      !classification.postBoundary)) {
      addReason(reasons, "pre-boundary-signal-only");
    }
    const postBoundaryCurrentHeadBotComments =
      currentHeadCleanGrammarComments.filter(
        (classification) => classification.postBoundary,
      );
    if (postBoundaryCurrentHeadBotComments.length > 0) {
      if (input.headChangedAt === null) {
        addReason(reasons, "head-change-indeterminate");
      } else if (postBoundaryCurrentHeadBotComments.some((classification) =>
        !postdates(
          classification.comment.createdAt,
          input.headChangedAt as string,
        ))) {
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
