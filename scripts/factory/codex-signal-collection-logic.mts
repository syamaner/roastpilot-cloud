import {
  CODEX_BOT_LOGIN,
  containsCodexTriggerPhrase,
  reduceCodexVerdict,
  type CodexVerdict,
} from "./codex-verdict-logic.mts";
import {
  FULL_SHA_PATTERN,
  LINE_SPLIT_PATTERN,
  parseStrictIsoUtc,
  type CodexBoundary,
  type CodexCommentRecord,
  type CodexEvidenceCompleteness,
  type CodexReactionRecord,
  type CodexReviewRecord,
  type CodexSignalInput,
  type CodexTriggerRecord,
} from "./codex-signal-schema.mts";

export const CODEX_ADVISORY_STATUS_CONTEXT =
  "factory/codex-verdict-advisory";
export const MAX_STATUS_DESCRIPTION_LENGTH = 140;
const FINDINGS_PROBE_BOUNDARY_AT = "0000-01-01T00:00:00Z";
const FINDINGS_PROBE_TIMESTAMP = "9999-12-31T23:59:59Z";

export interface RawPullRequest {
  readonly headSha?: unknown; readonly isDraft?: unknown;
  readonly headRepoIsSameRepo?: unknown; readonly createdAt?: unknown;
}
export interface RawReview {
  readonly authorLogin?: unknown; readonly commitSha?: unknown;
  readonly submittedAt?: unknown; readonly reviewId?: unknown; readonly state?: unknown;
}
export interface RawReviewComment { readonly pullRequestReviewId?: unknown }
export interface RawIssueComment {
  readonly authorLogin?: unknown; readonly body?: unknown;
  readonly createdAt?: unknown; readonly id?: unknown;
}
export interface RawPrReviewComment {
  readonly authorLogin?: unknown; readonly body?: unknown;
  readonly createdAt?: unknown; readonly id?: unknown;
}
export interface RawReaction {
  readonly authorLogin?: unknown; readonly content?: unknown; readonly createdAt?: unknown;
}
export interface RawTimelineEvent { readonly event?: unknown; readonly createdAt?: unknown }
export interface RawSourceCompleteness {
  readonly timelineEvents?: unknown; readonly reviews?: unknown; readonly reviewComments?: unknown;
  readonly issueComments?: unknown; readonly prReviewComments?: unknown;
  readonly reactions?: unknown;
}

export type ReactionSubject =
  | { readonly kind: "pull-request" }
  | { readonly kind: "issue-comment"; readonly commentId: number };
export interface RawCollectionInput {
  readonly pullRequest: RawPullRequest;
  readonly evaluatedAt?: unknown;
  readonly timelineEvents?: readonly RawTimelineEvent[];
  readonly reviews?: readonly RawReview[];
  readonly reviewComments?: readonly RawReviewComment[];
  readonly issueComments?: readonly RawIssueComment[];
  readonly prReviewComments?: readonly RawPrReviewComment[];
  /** Records fetched only from `reactionSubject`; mismatches are discarded. */
  readonly reactions?: readonly RawReaction[];
  readonly reactionSubject?: ReactionSubject;
  readonly sourceComplete?: RawSourceCompleteness;
}
export interface MappedSource<T> { readonly records: readonly T[]; readonly complete: boolean }
interface ValidIssueComment {
  readonly authorLogin: string; readonly body: string;
  readonly createdAt: string; readonly id: number;
}
export type BoundarySelection =
  | {
      readonly kind: "selected"; readonly boundary: CodexBoundary;
      readonly reactionSubject: ReactionSubject;
    }
  | { readonly kind: "no-valid-boundary"; readonly reason: "awaiting-retrigger" }
  | { readonly kind: "snapshot-inconsistent" }
  | {
      readonly kind: "indeterminate"; readonly reason:
        "timeline-incomplete" | "trigger-evidence-incomplete";
    };
export interface BoundarySelectionInput {
  readonly headSha: string; readonly prState: "draft" | "ready";
  readonly prCreatedAt: string; readonly reviews: readonly RawReview[];
  readonly timelineEvents: readonly RawTimelineEvent[]; readonly timelineComplete: boolean;
  readonly headChangedAt: string; readonly issueComments: readonly RawIssueComment[];
  readonly issueCommentsComplete: boolean;
}
export interface AssembleInputParts {
  readonly headSha: string; readonly prState: "draft" | "ready";
  readonly boundary: CodexBoundary; readonly headChangedAt: string;
  readonly reviews: readonly CodexReviewRecord[];
  readonly topLevelComments: readonly CodexCommentRecord[];
  readonly reactions: readonly CodexReactionRecord[];
  readonly evidenceComplete: CodexEvidenceCompleteness;
  readonly triggerComments: readonly CodexTriggerRecord[]; readonly evaluatedAt: string;
}
export type CollectionResult =
  | {
      readonly kind: "ready"; readonly input: CodexSignalInput;
      readonly reactionSubject: ReactionSubject;
    }
  | {
      readonly kind: "findings";
      readonly verdict: Extract<CodexVerdict, { verdict: "findings" }>;
    }
  | {
      readonly kind: "pending"; readonly reason:
        | "awaiting-retrigger" | "timeline-incomplete" | "trigger-evidence-incomplete"
        | "snapshot-inconsistent" | "malformed-evaluated-at" | "malformed-pr-metadata";
      readonly prState: "draft" | "ready";
    }
  | {
      readonly kind: "no-write"; readonly reason:
        | "malformed-pr" | "fork-head" | "internal-failure";
    };
export type StatusState = "success" | "failure" | "pending";
export interface StatusDetails {
  readonly context: typeof CODEX_ADVISORY_STATUS_CONTEXT;
  readonly state: StatusState; readonly description: string;
}
export type StatusPlan =
  | ({ readonly kind: "write" } & StatusDetails)
  | {
      readonly kind: "no-write";
      readonly reason:
        Extract<CollectionResult, { kind: "no-write" }>["reason"];
    };

function strictTimestamp(value: unknown): value is string {
  return typeof value === "string" && parseStrictIsoUtc(value) !== null;
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function arrayOrEmpty<T>(value: readonly T[] | undefined): readonly T[] {
  return Array.isArray(value) ? value : [];
}

function confirmed(value: unknown): boolean {
  return value === true;
}

function validateIssueComments(
  rawComments: readonly RawIssueComment[],
  fetchComplete: boolean,
): MappedSource<ValidIssueComment> {
  const records: ValidIssueComment[] = [];
  let allMapped = true;
  for (const raw of rawComments) {
    if (
      typeof raw?.authorLogin !== "string" ||
      typeof raw.body !== "string" ||
      !strictTimestamp(raw.createdAt) ||
      !positiveSafeInteger(raw.id)
    ) {
      allMapped = false;
      continue;
    }
    records.push({
      authorLogin: raw.authorLogin,
      body: raw.body,
      createdAt: raw.createdAt,
      id: raw.id,
    });
  }
  return { records, complete: fetchComplete === true && allMapped };
}

type VisibleHeadEvent =
  | "head_ref_force_pushed"
  | "head_ref_deleted"
  | "head_ref_restored";

function isVisibleHeadEvent(value: unknown): value is VisibleHeadEvent {
  return value === "head_ref_force_pushed" || value === "head_ref_deleted" ||
    value === "head_ref_restored";
}

/** Visible server-timestamped freshness floor, never a forgeable Git timestamp. */
export function deriveHeadChangedAt(
  prCreatedAt: string,
  timelineEvents: readonly RawTimelineEvent[],
): string {
  let latestValue = prCreatedAt;
  let latestAt = parseStrictIsoUtc(prCreatedAt);
  for (const event of timelineEvents) {
    if (!isVisibleHeadEvent(event?.event) || !strictTimestamp(event.createdAt)) continue;
    const instant = parseStrictIsoUtc(event.createdAt);
    if (instant !== null && (latestAt === null || instant > latestAt)) {
      latestAt = instant;
      latestValue = event.createdAt;
    }
  }
  return latestValue;
}

const REVIEWED_COMMIT_LINE = /^Reviewed commit: ([0-9a-f]{40})$/u;

export function singleReviewedCommitSha(body: string): string | null {
  const markerLines = body.split(LINE_SPLIT_PATTERN)
    .filter((line) => line.startsWith("Reviewed commit:"));
  if (markerLines.length === 0) return null;
  const shas = new Set<string>();
  for (const line of markerLines) {
    const match = REVIEWED_COMMIT_LINE.exec(line);
    if (match === null) return null;
    shas.add(match[1]);
  }
  return shas.size === 1 ? [...shas][0] : null;
}

function latestAdvanceEvidenceAt(
  currentHeadSha: string,
  timelineEvents: readonly RawTimelineEvent[],
  reviews: readonly RawReview[],
  issueComments: readonly RawIssueComment[],
  boundary: CodexBoundary,
): number | null {
  const boundaryAt = parseStrictIsoUtc(boundary.occurredAt);
  /* v8 ignore next -- selected boundaries contain strict timestamps. */
  if (boundaryAt === null) return null;
  let latest: number | null = null;
  const keepLatest = (instant: number): void => {
    if (instant >= boundaryAt && (latest === null || instant > latest)) latest = instant;
  };
  for (const event of timelineEvents) {
    if (!isVisibleHeadEvent(event?.event) || !strictTimestamp(event.createdAt)) continue;
    const instant = parseStrictIsoUtc(event.createdAt);
    /* v8 ignore next -- strictTimestamp already proved this parse. */
    if (instant !== null) keepLatest(instant);
  }
  for (const review of reviews) {
    if (
      review?.authorLogin !== CODEX_BOT_LOGIN ||
      typeof review.commitSha !== "string" ||
      !FULL_SHA_PATTERN.test(review.commitSha) ||
      review.commitSha === currentHeadSha ||
      !strictTimestamp(review.submittedAt)
    ) continue;
    const submittedAt = parseStrictIsoUtc(review.submittedAt);
    /* v8 ignore next -- strictTimestamp already proved this parse. */
    if (submittedAt !== null) keepLatest(submittedAt);
  }
  for (const comment of issueComments) {
    if (
      comment?.authorLogin !== CODEX_BOT_LOGIN ||
      typeof comment.body !== "string" ||
      !strictTimestamp(comment.createdAt)
    ) continue;
    const namedSha = singleReviewedCommitSha(comment.body);
    if (namedSha === null || namedSha === currentHeadSha) continue;
    const createdAt = parseStrictIsoUtc(comment.createdAt);
    /* v8 ignore next -- strictTimestamp already proved this parse. */
    if (createdAt !== null) keepLatest(createdAt);
  }
  return latest;
}

/** Visible head-ref events or stale SHA-bearing bot records prove advance. */
export function headAdvancedPastBoundary(
  currentHeadSha: string,
  timelineEvents: readonly RawTimelineEvent[],
  reviews: readonly RawReview[],
  issueComments: readonly RawIssueComment[],
  boundary: CodexBoundary,
): boolean {
  return latestAdvanceEvidenceAt(
    currentHeadSha,
    timelineEvents,
    reviews,
    issueComments,
    boundary,
  ) !== null;
}

/** Select the policy boundary and the only reaction subject valid for it. */
export function selectBoundary(input: BoundarySelectionInput): BoundarySelection {
  if (input.timelineComplete !== true) {
    return { kind: "indeterminate", reason: "timeline-incomplete" };
  }
  const events: {
    readonly event:
      | "ready_for_review" | "convert_to_draft" | "head_ref_force_pushed"
      | "head_ref_deleted" | "head_ref_restored";
    readonly createdAt: string; readonly instant: number;
  }[] = [];
  for (const raw of input.timelineEvents) {
    if (
      (raw?.event !== "ready_for_review" && raw?.event !== "convert_to_draft" &&
        raw?.event !== "head_ref_force_pushed" && raw?.event !== "head_ref_deleted" &&
        raw?.event !== "head_ref_restored") ||
      !strictTimestamp(raw.createdAt)
    ) {
      return { kind: "indeterminate", reason: "timeline-incomplete" };
    }
    const instant = parseStrictIsoUtc(raw.createdAt);
    /* v8 ignore next 3 -- strictTimestamp already proved this parse. */
    if (instant === null) {
      return { kind: "indeterminate", reason: "timeline-incomplete" };
    }
    events.push({ event: raw.event, createdAt: raw.createdAt, instant });
  }

  let baseBoundary: CodexBoundary = { kind: "opened", occurredAt: input.prCreatedAt };
  if (input.prState === "ready") {
    const readyEvents = events.filter((event) => event.event === "ready_for_review");
    const draftEvents = events.filter((event) => event.event === "convert_to_draft");
    const latestReady = readyEvents.reduce<typeof readyEvents[number] | null>(
      (latest, event) => latest === null || event.instant > latest.instant ? event : latest,
      null,
    );
    const latestDraft = draftEvents.reduce<typeof draftEvents[number] | null>(
      (latest, event) => latest === null || event.instant > latest.instant ? event : latest,
      null,
    );
    if (latestDraft !== null &&
      (latestReady === null || latestDraft.instant >= latestReady.instant)) {
      return { kind: "snapshot-inconsistent" };
    }
    if (latestReady !== null) {
      baseBoundary = { kind: "ready-for-review", occurredAt: latestReady.createdAt };
    }
  }

  const latestAdvanceAt = latestAdvanceEvidenceAt(
    input.headSha,
    events,
    input.reviews,
    input.issueComments,
    baseBoundary,
  );
  const advanced = latestAdvanceAt !== null;
  const comments = validateIssueComments(
    input.issueComments,
    input.issueCommentsComplete,
  );
  if (!comments.complete) {
    return { kind: "indeterminate", reason: "trigger-evidence-incomplete" };
  }
  const boundaryAt = parseStrictIsoUtc(baseBoundary.occurredAt);
  const headChangedAt = parseStrictIsoUtc(input.headChangedAt);
  const referenceAt = latestAdvanceAt !== null && boundaryAt !== null && headChangedAt !== null
    ? Math.max(boundaryAt, headChangedAt, latestAdvanceAt)
    : boundaryAt;
  const triggers = comments.records.filter((comment) => {
    const createdAt = parseStrictIsoUtc(comment.createdAt);
    return comment.authorLogin !== CODEX_BOT_LOGIN &&
      containsCodexTriggerPhrase(comment.body) && referenceAt !== null &&
      createdAt !== null && createdAt > referenceAt;
  }).sort((left, right) => {
    /* v8 ignore next 2 -- validated comments contain strict timestamps. */
    const timeOrder = (parseStrictIsoUtc(right.createdAt) ?? 0) -
      (parseStrictIsoUtc(left.createdAt) ?? 0);
    return timeOrder !== 0 ? timeOrder : right.id - left.id;
  });
  const latest = triggers[0];
  if (latest !== undefined) {
    return {
      kind: "selected",
      boundary: { kind: "manual-retrigger", occurredAt: latest.createdAt },
      reactionSubject: { kind: "issue-comment", commentId: latest.id },
    };
  }
  if (advanced) {
    return { kind: "no-valid-boundary", reason: "awaiting-retrigger" };
  }
  return {
    kind: "selected", boundary: baseBoundary,
    reactionSubject: { kind: "pull-request" },
  };
}

export function selectReactionSubject(
  selection: Extract<BoundarySelection, { kind: "selected" }>,
): ReactionSubject {
  return selection.reactionSubject;
}

const REVIEW_STATES = new Set([
  "APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED",
]);

export function mapReviews(
  rawReviews: readonly RawReview[],
  rawComments: readonly RawReviewComment[],
  reviewsComplete = false,
  commentsComplete = false,
): MappedSource<CodexReviewRecord> {
  const counts = new Map<number, number>();
  let commentsMapped = true;
  for (const comment of rawComments) {
    if (!positiveSafeInteger(comment?.pullRequestReviewId)) {
      commentsMapped = false;
      continue;
    }
    counts.set(
      comment.pullRequestReviewId,
      (counts.get(comment.pullRequestReviewId) ?? 0) + 1,
    );
  }
  const reviewIds = new Set<number>();
  const records: CodexReviewRecord[] = [];
  let reviewsMapped = true;
  for (const review of rawReviews) {
    if (
      typeof review?.authorLogin !== "string" ||
      typeof review.commitSha !== "string" ||
      !FULL_SHA_PATTERN.test(review.commitSha) ||
      !strictTimestamp(review.submittedAt) ||
      !positiveSafeInteger(review.reviewId) ||
      typeof review.state !== "string" ||
      !REVIEW_STATES.has(review.state)
    ) {
      reviewsMapped = false;
      continue;
    }
    reviewIds.add(review.reviewId);
    records.push({
      authorLogin: review.authorLogin,
      commitSha: review.commitSha,
      submittedAt: review.submittedAt,
      inlineThreadCount: counts.get(review.reviewId) ?? 0,
    });
  }
  if ([...counts.keys()].some((reviewId) => !reviewIds.has(reviewId))) {
    commentsMapped = false;
  }
  return {
    records,
    complete: reviewsComplete === true && commentsComplete === true &&
      reviewsMapped && commentsMapped,
  };
}

export function mapTopLevelComments(
  rawIssueComments: readonly RawIssueComment[],
  rawPrComments: readonly RawPrReviewComment[],
  issueCommentsComplete = false,
  prCommentsComplete = false,
): MappedSource<CodexCommentRecord> {
  const issues = validateIssueComments(rawIssueComments, issueCommentsComplete);
  const records: CodexCommentRecord[] = issues.records.map((comment) => ({
    authorLogin: comment.authorLogin,
    body: comment.body,
    createdAt: comment.createdAt,
    channel: "issue-comment",
  }));
  let prMapped = true;
  for (const raw of rawPrComments) {
    if (
      typeof raw?.authorLogin !== "string" ||
      typeof raw.body !== "string" ||
      !strictTimestamp(raw.createdAt) ||
      !positiveSafeInteger(raw.id)
    ) {
      prMapped = false;
      continue;
    }
    records.push({
      authorLogin: raw.authorLogin,
      body: raw.body,
      createdAt: raw.createdAt,
      channel: "review-thread-reply",
    });
  }
  return {
    records,
    complete: issues.complete && prCommentsComplete === true && prMapped,
  };
}

const REACTION_CONTENT = new Set([
  "+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes",
]);

function subjectKey(subject: ReactionSubject): string {
  return subject.kind === "pull-request"
    ? "pull-request"
    : `issue-comment:${subject.commentId}`;
}

function sameSubject(left: ReactionSubject | undefined, right: ReactionSubject): boolean {
  return left?.kind === right.kind &&
    (left?.kind === "pull-request" ||
      (left?.kind === "issue-comment" && right.kind === "issue-comment" &&
        left.commentId === right.commentId));
}

export function mapReactions(
  rawReactions: readonly RawReaction[],
  fetchedSubject: ReactionSubject | undefined,
  selectedSubject: ReactionSubject,
  fetchComplete = false,
): MappedSource<CodexReactionRecord> {
  if (!sameSubject(fetchedSubject, selectedSubject)) {
    return { records: [], complete: false };
  }
  const records: CodexReactionRecord[] = [];
  let allMapped = true;
  for (const raw of rawReactions) {
    if (
      typeof raw?.authorLogin !== "string" ||
      typeof raw.content !== "string" ||
      !REACTION_CONTENT.has(raw.content) ||
      !strictTimestamp(raw.createdAt)
    ) {
      allMapped = false;
      continue;
    }
    records.push({
      authorLogin: raw.authorLogin,
      content: raw.content === "eyes" || raw.content === "+1"
        ? raw.content
        : "other",
      createdAt: raw.createdAt,
      subjectId: subjectKey(selectedSubject),
    });
  }
  return { records, complete: fetchComplete === true && allMapped };
}

export function mapTriggerComments(
  rawComments: readonly RawIssueComment[],
  headSha: string,
  boundary: CodexBoundary,
  headChangedAt: string,
): readonly CodexTriggerRecord[] {
  const validated = validateIssueComments(rawComments, true);
  const reference = parseStrictIsoUtc(headChangedAt);
  if (!validated.complete || reference === null || !FULL_SHA_PATTERN.test(headSha)) {
    return [];
  }
  return validated.records.flatMap((comment) => {
    const createdAt = parseStrictIsoUtc(comment.createdAt);
    const selectedManualTrigger = boundary.kind === "manual-retrigger" &&
      comment.createdAt === boundary.occurredAt;
    return comment.authorLogin !== CODEX_BOT_LOGIN &&
        containsCodexTriggerPhrase(comment.body) && createdAt !== null &&
        (createdAt > reference || selectedManualTrigger)
      ? [{ createdAt: comment.createdAt, onHeadSha: headSha }]
      : [];
  });
}

export function assembleInput(parts: AssembleInputParts): CodexSignalInput {
  return {
    headSha: parts.headSha,
    prState: parts.prState,
    boundary: parts.boundary,
    headChangedAt: parts.headChangedAt,
    reviews: parts.reviews,
    topLevelComments: parts.topLevelComments,
    reactions: parts.reactions,
    evidenceComplete: parts.evidenceComplete,
    triggerComments: parts.triggerComments,
    evaluatedAt: parts.evaluatedAt,
  };
}

function pendingDescription(
  reasons: readonly string[],
  advice: "wait" | "due" | "eyes-stale-escalate" | "already-posted" |
    "not-applicable-draft" | "verify",
): string {
  const suffix = advice === "due" || advice === "eyes-stale-escalate"
    ? `; advice=${advice}; see AGENTS.md PR Merge Policy`
    : `; advice=${advice}`;
  const kept: string[] = [];
  for (let index = 0; index < reasons.length; index += 1) {
    const candidate = [...kept, reasons[index]];
    const omitted = reasons.length - candidate.length;
    const omission = omitted > 0 ? `; omitted=${omitted}` : "";
    const rendered = `pending reasons=${candidate.join(",")}${omission}${suffix}`;
    if (rendered.length > MAX_STATUS_DESCRIPTION_LENGTH) break;
    kept.push(reasons[index]);
  }
  const omitted = reasons.length - kept.length;
  return `pending reasons=${kept.join(",") || "malformed-input"}` +
    `${omitted > 0 ? `; omitted=${omitted}` : ""}${suffix}`;
}

function shortSha(value: string): string {
  /* v8 ignore else -- reducer evidence carries a validated full SHA. */
  if (FULL_SHA_PATTERN.test(value)) return value.slice(0, 7);
  /* v8 ignore next -- reducer evidence carries a validated full SHA. */
  return "invalid";
}

export function verdictToStatusPlan(verdict: CodexVerdict): StatusDetails {
  if (verdict.verdict === "clean") {
    if (verdict.evidence.channel === "reaction-pair") {
      return {
        context: CODEX_ADVISORY_STATUS_CONTEXT,
        state: "pending",
        description: pendingDescription(["reaction-clean-unconfirmed"], "verify"),
      };
    }
    return {
      context: CODEX_ADVISORY_STATUS_CONTEXT,
      state: "success",
      description: `clean channel=clean-comment sha=${shortSha(verdict.evidence.matchedSha)}`,
    };
  }
  if (verdict.verdict === "findings") {
    return {
      context: CODEX_ADVISORY_STATUS_CONTEXT,
      state: "failure",
      description: `findings source=${verdict.evidence.source} sha=${shortSha(verdict.evidence.matchedSha)} count=${
        verdict.evidence.source === "review" ? verdict.evidence.inlineThreadCount : 1
      }`,
    };
  }
  return {
    context: CODEX_ADVISORY_STATUS_CONTEXT,
    state: "pending",
    description: pendingDescription(verdict.reasons, verdict.manualTriggerAdvice),
  };
}

function probeCurrentHeadFindings(parts: {
  readonly headSha: string;
  readonly prState: "draft" | "ready";
  readonly evaluatedAt: string;
  readonly reviews: MappedSource<CodexReviewRecord>;
  readonly topLevelComments: MappedSource<CodexCommentRecord>;
}): Extract<CodexVerdict, { verdict: "findings" }> | null {
  const verdict = reduceCodexVerdict(assembleInput({
    headSha: parts.headSha,
    prState: parts.prState,
    boundary: { kind: "opened", occurredAt: FINDINGS_PROBE_BOUNDARY_AT },
    headChangedAt: parts.evaluatedAt,
    reviews: parts.reviews.records,
    topLevelComments: parts.topLevelComments.records,
    reactions: [],
    evidenceComplete: {
      reviews: parts.reviews.complete,
      topLevelComments: parts.topLevelComments.complete,
      reactions: false,
    },
    triggerComments: [],
    evaluatedAt: parts.evaluatedAt,
  }));
  return verdict.verdict === "findings" ? verdict : null;
}

/** Validate/map raw records, invoking the reducer only for closed verdict decisions. */
export function collectSignalInput(raw: RawCollectionInput): CollectionResult {
  try {
    const pr = raw?.pullRequest;
    if (
      typeof pr?.headSha !== "string" ||
      !FULL_SHA_PATTERN.test(pr.headSha) ||
      typeof pr.headRepoIsSameRepo !== "boolean"
    ) {
      return { kind: "no-write", reason: "malformed-pr" };
    }
    if (!pr.headRepoIsSameRepo) return { kind: "no-write", reason: "fork-head" };
    const isDraft = typeof pr.isDraft === "boolean" ? pr.isDraft : null;
    const createdAt = strictTimestamp(pr.createdAt) ? pr.createdAt : null;
    const evaluatedAt = strictTimestamp(raw.evaluatedAt) ? raw.evaluatedAt : null;

    const complete = raw.sourceComplete;
    const hasTimelineEvents = Array.isArray(raw.timelineEvents);
    const hasReviews = Array.isArray(raw.reviews);
    const hasReviewComments = Array.isArray(raw.reviewComments);
    const hasIssueComments = Array.isArray(raw.issueComments);
    const hasPrComments = Array.isArray(raw.prReviewComments);
    const hasReactions = Array.isArray(raw.reactions);
    const timelineEvents = arrayOrEmpty(raw.timelineEvents);
    const reviewsRaw = arrayOrEmpty(raw.reviews);
    const reviewCommentsRaw = arrayOrEmpty(raw.reviewComments);
    const issueComments = arrayOrEmpty(raw.issueComments);
    const prComments = arrayOrEmpty(raw.prReviewComments);
    const reactionsRaw = arrayOrEmpty(raw.reactions);
    const prState = isDraft === true ? "draft" : "ready";
    const reviews = mapReviews(
      reviewsRaw,
      reviewCommentsRaw,
      hasReviews && confirmed(complete?.reviews),
      hasReviewComments && confirmed(complete?.reviewComments),
    );
    const topLevelComments = mapTopLevelComments(
      issueComments,
      prComments,
      hasIssueComments && confirmed(complete?.issueComments),
      hasPrComments && confirmed(complete?.prReviewComments),
    );
    const findings = probeCurrentHeadFindings({
      headSha: pr.headSha,
      prState,
      evaluatedAt: evaluatedAt ?? createdAt ?? FINDINGS_PROBE_TIMESTAMP,
      reviews,
      topLevelComments,
    });
    if (findings !== null) return { kind: "findings", verdict: findings };
    if (isDraft === null || createdAt === null) {
      return { kind: "pending", reason: "malformed-pr-metadata", prState: "ready" };
    }
    if (evaluatedAt === null) {
      return { kind: "pending", reason: "malformed-evaluated-at", prState };
    }

    const headChangedAt = deriveHeadChangedAt(createdAt, timelineEvents);
    const selection = selectBoundary({
      headSha: pr.headSha,
      prState,
      prCreatedAt: createdAt,
      reviews: reviewsRaw,
      timelineEvents,
      timelineComplete: hasTimelineEvents && confirmed(complete?.timelineEvents),
      headChangedAt,
      issueComments,
      issueCommentsComplete: hasIssueComments && confirmed(complete?.issueComments),
    });
    if (selection.kind === "snapshot-inconsistent") {
      return { kind: "pending", reason: "snapshot-inconsistent", prState };
    }
    if (selection.kind === "indeterminate" || selection.kind === "no-valid-boundary") {
      return { kind: "pending", reason: selection.reason, prState };
    }
    const reactions = mapReactions(
      reactionsRaw,
      raw.reactionSubject,
      selection.reactionSubject,
      hasReactions && confirmed(complete?.reactions),
    );
    const input = assembleInput({
      headSha: pr.headSha,
      prState,
      boundary: selection.boundary,
      headChangedAt,
      reviews: reviews.records,
      topLevelComments: topLevelComments.records,
      reactions: reactions.records,
      evidenceComplete: {
        reviews: reviews.complete,
        topLevelComments: topLevelComments.complete,
        reactions: reactions.complete,
      },
      triggerComments: mapTriggerComments(
        issueComments,
        pr.headSha,
        selection.boundary,
        headChangedAt,
      ),
      evaluatedAt,
    });
    return { kind: "ready", input, reactionSubject: selection.reactionSubject };
  } catch {
    // Intentional defensive fallback: the pure callees are total for plain data.
    return { kind: "no-write", reason: "internal-failure" };
  }
}

/** End-to-end pure decision: no write is represented, never performed. */
export function collectAndPlan(raw: RawCollectionInput): StatusPlan {
  try {
    const collected = collectSignalInput(raw);
    if (collected.kind === "no-write") return collected;
    if (collected.kind === "findings") {
      return { kind: "write", ...verdictToStatusPlan(collected.verdict) };
    }
    if (collected.kind === "pending") {
      const advice = collected.prState === "draft"
        ? "not-applicable-draft"
        : collected.reason === "awaiting-retrigger" ? "due" : "wait";
      return {
        kind: "write",
        context: CODEX_ADVISORY_STATUS_CONTEXT,
        state: "pending",
        description: pendingDescription([collected.reason], advice),
      };
    }
    return { kind: "write", ...verdictToStatusPlan(reduceCodexVerdict(collected.input)) };
  } catch {
    /* v8 ignore next -- collected/reduced results are closed unions. */
    return { kind: "no-write", reason: "internal-failure" };
  }
}
