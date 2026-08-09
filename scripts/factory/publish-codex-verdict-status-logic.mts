import {
  CODEX_ADVISORY_STATUS_CONTEXT,
  type RawIssueComment,
  type RawReviewComment,
  type StatusDetails,
  type StatusPlan,
} from "./codex-signal-collection-logic.mts";
import {
  CODEX_BOT_LOGIN,
  containsCodexTriggerPhrase,
} from "./codex-verdict-logic.mts";
import {
  isPlainRecord,
  parseStrictIsoUtc,
} from "./codex-signal-schema.mts";
import {
  FACTORY_OWNER_LOGINS,
  isFactoryOwnerLogin,
} from "./factory-owner-allowlist.mts";

export const CODEX_RETRIGGER_AUTHORIZED_LOGINS: ReadonlySet<string> =
  FACTORY_OWNER_LOGINS;

/** Authorize a trigger author by exact, unnormalised login bytes. */
export function isAuthorizedTriggerAuthor(login: unknown): boolean {
  return isFactoryOwnerLogin(login);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isStrictTimestamp(value: unknown): value is string {
  return typeof value === "string" && parseStrictIsoUtc(value) !== null;
}

/**
 * Remove only well-formed trigger comments from known-unauthorized authors.
 * Malformed trigger-shaped records remain so downstream collection degrades
 * completeness instead of laundering an incomplete snapshot.
 */
export function filterAuthorizedTriggerComments(
  comments: readonly RawIssueComment[],
): readonly RawIssueComment[] {
  return comments.filter((comment) => {
    if (!isPlainRecord(comment)) return true;
    const unauthorizedTrigger =
      typeof comment.authorLogin === "string" &&
      comment.authorLogin !== CODEX_BOT_LOGIN &&
      !isAuthorizedTriggerAuthor(comment.authorLogin) &&
      typeof comment.body === "string" &&
      containsCodexTriggerPhrase(comment.body) &&
      isStrictTimestamp(comment.createdAt) &&
      isPositiveSafeInteger(comment.id);
    return !unauthorizedTrigger;
  });
}

/** Raw fetched review-comment shape before root/reply classification. */
export interface RawReviewCommentRecord extends RawReviewComment {
  readonly inReplyToId?: unknown;
}

/** Keep roots, exclude replies, and fail completeness closed on ambiguity. */
export function filterRootReviewComments(
  raw: readonly RawReviewCommentRecord[],
): { readonly records: readonly RawReviewComment[]; readonly complete: boolean } {
  const records: RawReviewComment[] = [];
  let complete = true;
  for (const candidate of raw) {
    if (!isPlainRecord(candidate)) {
      complete = false;
      continue;
    }
    const inReplyToId = candidate.inReplyToId;
    if (inReplyToId === undefined || inReplyToId === null) {
      records.push({ pullRequestReviewId: candidate.pullRequestReviewId });
      continue;
    }
    if (!isPositiveSafeInteger(inReplyToId)) complete = false;
  }
  return { records, complete };
}

export interface NamespacedStatusDetails {
  readonly context: string;
  readonly state: StatusDetails["state"];
  readonly description: StatusDetails["description"];
}

export type NamespacedStatusPlan =
  | ({ readonly kind: "write" } & NamespacedStatusDetails)
  | Extract<StatusPlan, { kind: "no-write" }>;

/** Return the status context scoped to exactly one positive-integer PR. */
export function namespacedStatusContext(prNumber: number): string | null {
  return isPositiveSafeInteger(prNumber)
    ? `${CODEX_ADVISORY_STATUS_CONTEXT}/pr-${prNumber}`
    : null;
}

/** Replace a write plan's base context with its PR-scoped context. */
export function toNamespacedPlan(
  plan: StatusPlan,
  prNumber: number,
): NamespacedStatusPlan {
  if (plan.kind === "no-write") return plan;
  const context = namespacedStatusContext(prNumber);
  if (context === null) {
    return { kind: "no-write", reason: "internal-failure" };
  }
  return {
    kind: "write",
    context,
    state: plan.state,
    description: plan.description,
  };
}
