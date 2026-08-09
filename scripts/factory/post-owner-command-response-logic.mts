import {
  isEligibleFactoryOwnerAuthor,
  isEligiblePullRequestState,
  isPullRequestIssue,
  isSameRepositoryPullRequest,
  parseOwnerCommand,
  type OwnerCommand,
} from "./owner-command-logic.mts";
import {
  renderBoundedUntrustedMultilineBlock,
  sanitizeUntrustedTextForPostedBody,
} from "./untrusted-text.mts";

/** Hard structural-input limit for a question-answer artifact. */
export const MAX_ANSWER_ARTIFACT_BYTES = 256 * 1024;

/** GitHub identity under which the later publisher will post responses. */
export const RESPONSE_BOT_LOGIN = "github-actions[bot]";

/** Generous display bound; truncation remains explicit in the rendered block. */
const MAX_RENDERED_ANSWER_CODE_POINTS = 8000;

const TASK_ACKNOWLEDGEMENT =
  "task recognised from an authorised owner; task execution is not yet enabled (9f/9g); no patch produced";

const RESPONSE_MARKER_SPOOF_REMOVED =
  "[owner-command response marker removed]";

export type DerivedAuthorization =
  | { proceed: false }
  | { proceed: true; command: OwnerCommand };

export interface ResponseAuthorizationInput {
  issue: unknown;
  pullRequest: unknown;
  author: unknown;
  commentBody: string;
  githubRepository: string;
}

export type ArtifactValidation =
  | { ok: false; reason: "missing" | "empty" | "oversized" }
  | { ok: true; text: string };

type OwnerCommandVariant = {
  [Verb in OwnerCommand["verb"]]: Omit<OwnerCommand, "verb"> & { verb: Verb };
}[OwnerCommand["verb"]];

type QuestionOwnerCommand = Extract<
  OwnerCommandVariant,
  { verb: "question" }
>;

export interface QuestionResponseInput {
  commentId: number;
  command: QuestionOwnerCommand;
  answerText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Build the stable per-source-comment response marker.
 *
 * Invalid identifiers throw before any marker is emitted. This lets the I/O
 * caller turn malformed event data into a loud, fail-closed exit instead of
 * posting a marker containing an ambiguous numeric sentinel.
 */
export function buildResponseMarker(commentId: number): string {
  if (!Number.isSafeInteger(commentId) || commentId <= 0) {
    throw new RangeError("commentId must be a positive safe integer");
  }
  return `<!-- owner-command-response: ${commentId} -->`;
}

/**
 * Match the ratified standalone-line marker semantics inline, without pulling
 * higher-level verdict logic into this leaf's closure, tightened to the final
 * body line.
 */
function bodyEndsWithStandaloneMarker(body: string, marker: string): boolean {
  const lines = body.trimEnd().split(/\r?\n/);
  return lines[lines.length - 1]?.trim() === marker;
}

/**
 * Detect only this publisher identity's prior response to the same command.
 * A malformed top-level fetch or malformed bot-owned body throws. Unmodeled
 * elements and comments not confirmed as ours are skipped.
 */
export function hasExistingResponse(
  comments: unknown,
  commentId: number,
): boolean {
  const marker = buildResponseMarker(commentId);
  // MUTATION-CHECK: reverting this persisted-state guard to `return false`
  // fails the malformed-fetch test and would permit a duplicate POST.
  if (!Array.isArray(comments)) {
    throw new TypeError("comments must be an array");
  }

  for (const comment of comments) {
    if (!isRecord(comment) || !isRecord(comment.user)) continue;
    if (comment.user.login !== RESPONSE_BOT_LOGIN) continue;
    // MUTATION-CHECK: changing this ambiguous bot-owned state from throw to
    // skip fails the malformed-bot-body regression.
    if (typeof comment.body !== "string") {
      throw new TypeError("bot-authored comment has a malformed body");
    }
    // MUTATION-CHECK M7: removing bot identity fails Q3; reverting this helper
    // to trimEnd().endsWith(marker) fails the glued-prefix regression.
    if (bodyEndsWithStandaloneMarker(comment.body, marker)) return true;
  }
  return false;
}

/**
 * Re-derive every owner-command eligibility fact from fetched source records.
 * There is deliberately no upstream `proceed` input to trust or propagate.
 */
export function deriveResponseAuthorization(
  input: ResponseAuthorizationInput,
): DerivedAuthorization {
  // MUTATION-CHECK M6: removing/inverting this guard fails Q4 non-PR issue.
  if (!isPullRequestIssue(input.issue)) {
    return { proceed: false };
  }

  // MUTATION-CHECK M6: removing/inverting this guard fails Q4 fork.
  if (!isSameRepositoryPullRequest(
    input.pullRequest,
    input.githubRepository,
  )) {
    return { proceed: false };
  }

  // MUTATION-CHECK M6: removing/inverting this guard fails the independent Q4
  // closed-PR and merged-PR sub-tests.
  if (!isEligiblePullRequestState(input.pullRequest)) {
    return { proceed: false };
  }

  // MUTATION-CHECK M6: removing/inverting this guard fails Q4 non-owner.
  // MUTATION-CHECK M13: trusting a claimed authorization instead fails the Q4
  // spoof sub-case because the actual fetched author is re-checked here.
  if (!isEligibleFactoryOwnerAuthor(input.author)) {
    return { proceed: false };
  }

  const command = parseOwnerCommand(input.commentBody);
  if (command === null) {
    return { proceed: false };
  }

  return { proceed: true, command };
}

/** Classify a fetched question-answer artifact without performing any I/O. */
export function validateAnswerArtifact(
  raw: string | null | undefined,
): ArtifactValidation {
  // MUTATION-CHECK M10: each rejection tier has its own Q6 assertion.
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "missing" };
  }
  if (raw.trim().length === 0) {
    return { ok: false, reason: "empty" };
  }
  if (new TextEncoder().encode(raw).length > MAX_ANSWER_ARTIFACT_BYTES) {
    return { ok: false, reason: "oversized" };
  }
  return { ok: true, text: raw };
}

/** Build the fixed non-executing acknowledgement for an eligible task. */
export function buildTaskResponseBody(commentId: number): string {
  // MUTATION-CHECK M11: altering the acknowledgement or introducing patch
  // content fails Q2's byte-exact and negative assertions.
  return `${TASK_ACKNOWLEDGEMENT}\n\n${buildResponseMarker(commentId)}`;
}

/**
 * Remove every well-formed owner-command response marker from already-
 * sanitised untrusted text. The non-`u` regular expression deliberately makes
 * `\d` ASCII-only, exactly matching buildResponseMarker's positive-integer
 * output form. This preserves the one-marker body invariant even when an owner
 * command or answer predicts another source comment ID. Raw untrusted text
 * never reaches this helper: callers first route through the required
 * rendering primitive, whose transforms may rejoin a split marker.
 */
function neutralizeResponseMarkerSpoof(rendered: string): string {
  return rendered.replace(
    /<!-- owner-command-response: \d+ -->/g,
    RESPONSE_MARKER_SPOOF_REMOVED,
  );
}

/** Build the bounded, inert response body for an eligible owner question. */
export function buildQuestionResponseBody(
  input: QuestionResponseInput,
): string {
  // MUTATION-CHECK: removing this belt-and-braces verb guard fails the task-
  // command cast regression and would bypass the mandatory fixed task ack.
  if (input.command.verb !== "question") {
    throw new TypeError(
      "buildQuestionResponseBody requires a question command",
    );
  }

  const marker = buildResponseMarker(input.commentId);

  // MUTATION-CHECK M9: raw/interpolated payload instead fails Q8. The returned
  // value already owns its Markdown code-span wrapper; do not wrap it again.
  const safePayload = neutralizeResponseMarkerSpoof(
    sanitizeUntrustedTextForPostedBody(input.command.payload),
  );

  // MUTATION-CHECK M8: raw/interpolated answer text instead fails Q5. This is
  // the only route by which answerText reaches the posted body.
  const safeAnswer = neutralizeResponseMarkerSpoof(
    renderBoundedUntrustedMultilineBlock(
      input.answerText,
      MAX_RENDERED_ANSWER_CODE_POINTS,
      "the run log",
    ),
  );

  return [
    "**Owner question response**",
    "",
    `**Command:** ${safePayload}`,
    "",
    "**Answer:**",
    safeAnswer,
    "",
    marker,
  ].join("\n");
}
