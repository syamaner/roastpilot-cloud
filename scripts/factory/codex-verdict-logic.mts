import { CODEX_TRIGGER_PHRASE } from "./implement-patch-logic.mts";

export const CODEX_BOT_LOGIN = "chatgpt-codex-connector[bot]";
export const CODEX_CLEAN_COMMENT_TITLE =
  "Codex Review: Didn't find any major issues";
export const REVIEWED_COMMIT_LINE = /^Reviewed commit: ([0-9a-f]{40})$/m;
export const CODEX_WAIT_TIMEOUT_MINUTES = 30;

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const STRICT_ISO_UTC_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?Z$/;

export interface CodexBoundary {
  readonly kind: "opened" | "ready-for-review" | "manual-retrigger";
  readonly occurredAt: string;
}

export interface CodexSignalInput {
  readonly headSha: string;
  readonly prState: "draft" | "ready";
  readonly boundary: CodexBoundary;
  readonly headChangedAt: string | null;
  readonly reviews: readonly CodexReviewRecord[];
  readonly topLevelComments: readonly CodexCommentRecord[];
  readonly reactions: readonly CodexReactionRecord[];
  readonly evidenceComplete: CodexEvidenceCompleteness;
  readonly triggerComments: readonly CodexTriggerRecord[];
  readonly evaluatedAt: string;
}

export interface CodexEvidenceCompleteness {
  readonly reviews: boolean;
  readonly topLevelComments: boolean;
  readonly reactions: boolean;
}

export interface CodexReviewRecord {
  readonly authorLogin: string;
  readonly commitSha: string;
  readonly submittedAt: string;
  readonly inlineThreadCount: number;
}

export interface CodexCommentRecord {
  readonly authorLogin: string;
  readonly body: string;
  readonly createdAt: string;
  readonly channel: "issue-comment" | "review-thread-reply";
}

export interface CodexReactionRecord {
  readonly authorLogin: string;
  readonly content: "eyes" | "+1" | "other";
  readonly createdAt: string;
  readonly subjectId: string;
}

export interface CodexTriggerRecord {
  readonly createdAt: string;
  readonly onHeadSha: string;
}

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

/** Parse only calendar-valid ISO-8601 instants in the explicit UTC `Z` form. */
export function parseStrictIsoUtc(value: string): number | null {
  const match = STRICT_ISO_UTC_PATTERN.exec(value);
  if (match === null) return null;
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return null;
  const date = new Date(instant);
  const fields = match.slice(1, 7).map(Number);
  const observed = [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ];
  return observed.every((field, index) => field === fields[index])
    ? instant
    : null;
}

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

function visibleTopLevelLines(body: string): readonly string[] {
  const visible: string[] = [];
  let fence: { readonly marker: "`" | "~"; readonly length: number } | null = null;
  let htmlCommentOpen = false;
  for (const line of body.split(/\r?\n/u)) {
    if (fence !== null) {
      const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      if (
        delimiter !== null &&
        delimiter[1][0] === fence.marker &&
        delimiter[1].length >= fence.length &&
        delimiter[2].trim().length === 0
      ) {
        fence = null;
      }
      continue;
    }
    if (!htmlCommentOpen) {
      const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
      if (delimiter !== null) {
        fence = {
          marker: delimiter[1][0] as "`" | "~",
          length: delimiter[1].length,
        };
        continue;
      }
      if (/^ {0,3}>/u.test(line)) continue;
    }

    let cursor = 0;
    let intersectsHtmlComment = htmlCommentOpen;
    while (cursor <= line.length) {
      if (htmlCommentOpen) {
        const closeAt = line.indexOf("-->", cursor);
        if (closeAt === -1) break;
        htmlCommentOpen = false;
        cursor = closeAt + 3;
        continue;
      }
      const openAt = line.indexOf("<!--", cursor);
      if (openAt === -1) break;
      intersectsHtmlComment = true;
      htmlCommentOpen = true;
      cursor = openAt + 4;
    }
    if (!intersectsHtmlComment) visible.push(line);
  }
  return visible;
}

function hasCleanTitleLine(body: string): boolean {
  return visibleTopLevelLines(body).some((line) => {
    if (line === CODEX_CLEAN_COMMENT_TITLE) return true;
    const heading = /^(#{1,6}) /u.exec(line);
    return heading !== null &&
      line.slice(heading[0].length) === CODEX_CLEAN_COMMENT_TITLE;
  });
}

function reviewedCommitSha(body: string): string | null {
  for (const line of visibleTopLevelLines(body)) {
    const match = line.match(REVIEWED_COMMIT_LINE);
    if (match !== null) return match[1];
  }
  return null;
}

function hasReviewedCommitPrefix(body: string): boolean {
  return visibleTopLevelLines(body).some((line) =>
    line.startsWith("Reviewed commit:"));
}

/** Test a comment against the one accepted top-level clean-comment grammar. */
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
    !input.reactions.every(isReactionRecord)
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
  const evaluatedAt = parseStrictIsoUtc(input.evaluatedAt);
  const boundaryAt = parseStrictIsoUtc(input.boundary.occurredAt);
  if (evaluatedAt === null || boundaryAt === null) return "wait";
  const latestPostBoundaryBotEyesAt = input.reactions.reduce(
    (latest, reaction) => {
      if (
        reaction.content !== "eyes" ||
        !isCodexBot(reaction.authorLogin) ||
        !postdatesBoundary(reaction.createdAt, input.boundary)
      ) {
        return latest;
      }
      return Math.max(latest, parseStrictIsoUtc(reaction.createdAt)!);
    },
    boundaryAt,
  );
  const timeoutMilliseconds = CODEX_WAIT_TIMEOUT_MINUTES * 60 * 1000;
  return evaluatedAt - latestPostBoundaryBotEyesAt >= timeoutMilliseconds
    ? "due"
    : "wait";
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isBoundary(value: unknown): value is CodexBoundary {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["kind", "occurredAt"])) return false;
  return (
    (value.kind === "opened" ||
      value.kind === "ready-for-review" ||
      value.kind === "manual-retrigger") &&
    typeof value.occurredAt === "string" &&
    parseStrictIsoUtc(value.occurredAt) !== null
  );
}

function isReviewRecord(value: unknown): value is CodexReviewRecord {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["authorLogin", "commitSha", "submittedAt", "inlineThreadCount"])) return false;
  return (
    typeof value.authorLogin === "string" &&
    typeof value.commitSha === "string" &&
    typeof value.submittedAt === "string" &&
    parseStrictIsoUtc(value.submittedAt) !== null &&
    Number.isSafeInteger(value.inlineThreadCount) &&
    (value.inlineThreadCount as number) >= 0
  );
}

function isCommentRecord(value: unknown): value is CodexCommentRecord {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["authorLogin", "body", "createdAt", "channel"])) return false;
  return (
    typeof value.authorLogin === "string" &&
    typeof value.body === "string" &&
    typeof value.createdAt === "string" &&
    parseStrictIsoUtc(value.createdAt) !== null &&
    (value.channel === "issue-comment" || value.channel === "review-thread-reply")
  );
}

function isReactionRecord(value: unknown): value is CodexReactionRecord {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["authorLogin", "content", "createdAt", "subjectId"])) return false;
  return (
    typeof value.authorLogin === "string" &&
    (value.content === "eyes" || value.content === "+1" || value.content === "other") &&
    typeof value.createdAt === "string" &&
    parseStrictIsoUtc(value.createdAt) !== null &&
    typeof value.subjectId === "string"
  );
}

function isTriggerRecord(value: unknown): value is CodexTriggerRecord {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["createdAt", "onHeadSha"])) return false;
  return (
    typeof value.createdAt === "string" &&
    parseStrictIsoUtc(value.createdAt) !== null &&
    typeof value.onHeadSha === "string"
  );
}

function isEvidenceComplete(value: unknown): value is CodexEvidenceCompleteness {
  if (!isPlainRecord(value) ||
    !hasExactKeys(value, ["reviews", "topLevelComments", "reactions"])) return false;
  return (
    typeof value.reviews === "boolean" &&
    typeof value.topLevelComments === "boolean" &&
    typeof value.reactions === "boolean"
  );
}

function isSignalInput(value: unknown): value is CodexSignalInput {
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    "headSha", "prState", "boundary", "headChangedAt", "reviews",
    "topLevelComments", "reactions", "evidenceComplete", "triggerComments",
    "evaluatedAt",
  ])) return false;
  return (
    typeof value.headSha === "string" &&
    FULL_SHA_PATTERN.test(value.headSha) &&
    (value.prState === "draft" || value.prState === "ready") &&
    isBoundary(value.boundary) &&
    (value.headChangedAt === null ||
      (typeof value.headChangedAt === "string" && parseStrictIsoUtc(value.headChangedAt) !== null)) &&
    Array.isArray(value.reviews) && value.reviews.every(isReviewRecord) &&
    Array.isArray(value.topLevelComments) && value.topLevelComments.every(isCommentRecord) &&
    Array.isArray(value.reactions) && value.reactions.every(isReactionRecord) &&
    isEvidenceComplete(value.evidenceComplete) &&
    Array.isArray(value.triggerComments) && value.triggerComments.every(isTriggerRecord) &&
    typeof value.evaluatedAt === "string" &&
    parseStrictIsoUtc(value.evaluatedAt) !== null
  );
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
