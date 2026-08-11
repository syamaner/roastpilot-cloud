/**
 * Pure admission and idempotency logic for an authorised owner-task patch.
 * The Unit-2 entrypoint owns every filesystem, git, network, and comment side
 * effect; this module only classifies already-fetched or already-proven data.
 */
import { createHash } from "node:crypto";

import {
  findAddedCoverageSuppressions,
  findAddedPackageJsonTestScriptEdits,
  findAddedRootPytestConfigSections,
  findFactoryPatchEnvelopeViolations,
  findForbiddenPatchPaths,
  findTestFileEdits,
  type CoverageSuppressionMatch,
  type FactoryPatchLineStat,
} from "./implement-patch-logic.mts";
import {
  MAX_ANSWER_ARTIFACT_BYTES,
  deriveResponseAuthorization,
  type ResponseAuthorizationInput,
} from "./post-owner-command-response-logic.mts";
import {
  MAX_PATCH_BYTES,
  type AuthoritativePatchAnalysis,
} from "./patch-analysis-format.mts";
import {
  findCiSkipDirectives,
  sanitizeAndClampUntrustedTextForCommitMessage,
} from "./untrusted-text.mts";

const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const TASK_BINDING_KEYS =
  "commandPayloadSha256,kind,prBaseSha,prHeadSha,taskTruncated,version";
const MAX_TASK_COMMIT_SUBJECT_LENGTH = 120;
const TASK_COMMIT_SUBJECT_PREFIX = "Owner task: ";
const TASK_MARKER_SPOOF_REMOVED = "[owner-task marker removed]";
export const MAX_TRAILER_COMMIT_WINDOW = 100;

export type TaskBinding = {
  readonly version: 1;
  readonly kind: "owner-task";
  readonly prHeadSha: string;
  readonly prBaseSha: string;
  readonly commandPayloadSha256: string;
  readonly taskTruncated: boolean;
};

export type OwnerTaskPatchAnalysisResult =
  | {
      readonly status: "ok";
      readonly analysis: AuthoritativePatchAnalysis;
    }
  | {
      /** Encoding inspection or scratch-index apply/query failed closed. */
      readonly status: "failed";
      readonly reasons: readonly string[];
    };

export interface OwnerTaskGamingAnnotations {
  readonly testFileEdits: string[];
  readonly coverageSuppressions: CoverageSuppressionMatch[];
  readonly packageJsonTestScriptEdits: string[];
  readonly rootPytestConfigSections: string[];
}

export type OwnerTaskPatchDecision =
  | { readonly kind: "ignore" }
  | { readonly kind: "no-op-success" }
  | {
      readonly kind: "reject-notice";
      readonly stage: "patch-artifact" | "patch-analysis" | "protected-path" | "envelope";
      /** Full evidence; Unit 2 must sanitise and visibly bound it when posting. */
      readonly reasons: readonly string[];
    }
  | {
      readonly kind: "stale-notice";
      readonly expectedHeadSha: string;
      readonly currentHeadSha: string;
      readonly expectedBaseSha: string;
      readonly currentBaseSha: string;
    }
  | {
      readonly kind: "apply";
      readonly treeOid: string;
      readonly parent: string;
      readonly commitSubject: string;
      readonly trailer: string;
      readonly annotations: OwnerTaskGamingAnnotations;
      /**
       * Unit 2 must push with
       * `--force-with-lease=<ref>:<forceWithLeaseExpectedSha>`; a plain force
       * push or an unqualified lease does not satisfy this outcome contract.
       */
      readonly forceWithLeaseExpectedSha: string;
    };

export interface OwnerTaskPatchDecisionInput extends ResponseAuthorizationInput {
  readonly commentId: number;
  readonly bindingArtifact: string | null | undefined;
  readonly markerPresent: boolean;
  readonly trailerCommitPresent: boolean;
  readonly patchArtifactBytes: number;
  readonly patchAnalysis: OwnerTaskPatchAnalysisResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Parse the closed, version-disjoint owner-task binding grammar. */
export function parseTaskBinding(raw: string): TaskBinding {
  const parsed: unknown = JSON.parse(raw);
  // MUTATION-CHECK: removing exact key-set equality fails N17's unknown,
  // missing, and extra-key cases and would make the grammar open-ended.
  if (
    !isRecord(parsed) ||
    Object.keys(parsed).sort().join(",") !== TASK_BINDING_KEYS ||
    parsed.version !== 1 ||
    parsed.kind !== "owner-task" ||
    typeof parsed.prHeadSha !== "string" ||
    !FULL_SHA_PATTERN.test(parsed.prHeadSha) ||
    typeof parsed.prBaseSha !== "string" ||
    !FULL_SHA_PATTERN.test(parsed.prBaseSha) ||
    typeof parsed.commandPayloadSha256 !== "string" ||
    !SHA256_PATTERN.test(parsed.commandPayloadSha256) ||
    typeof parsed.taskTruncated !== "boolean"
  ) {
    // MUTATION-CHECK: weakening any type/version/hex/boolean guard fails the
    // corresponding N17/N18 malformed-binding table case.
    throw new TypeError("owner-task binding artifact is malformed");
  }
  return {
    version: 1,
    kind: "owner-task",
    prHeadSha: parsed.prHeadSha,
    prBaseSha: parsed.prBaseSha,
    commandPayloadSha256: parsed.commandPayloadSha256,
    taskTruncated: parsed.taskTruncated,
  };
}

function requireTaskCommentId(commentId: number): void {
  // MUTATION-CHECK: removing this identifier guard fails "builds byte-distinct
  // success/notice markers with guarded identifiers" and could emit ambiguity.
  if (!Number.isSafeInteger(commentId) || commentId <= 0) {
    throw new RangeError("commentId must be a positive safe integer");
  }
}

/** Build the task-application success marker, deliberately distinct from 9e. */
export function buildTaskApplySuccessMarker(commentId: number): string {
  requireTaskCommentId(commentId);
  return `<!-- owner-task-apply-success: ${commentId} -->`;
}

/** Build the task-application notice marker, deliberately distinct from success. */
export function buildTaskApplyNoticeMarker(commentId: number): string {
  requireTaskCommentId(commentId);
  return `<!-- owner-task-apply-notice: ${commentId} -->`;
}

function bodyEndsWithStandaloneMarker(body: string, marker: string): boolean {
  const lines = body.trimEnd().split(/\r?\n/);
  return lines[lines.length - 1]?.trim() === marker;
}

/** Detect only the named bot's terminal standalone task-apply marker. */
export function hasExistingTaskApply(
  comments: unknown,
  commentId: number,
  botLogin: string,
): boolean {
  const successMarker = buildTaskApplySuccessMarker(commentId);
  const noticeMarker = buildTaskApplyNoticeMarker(commentId);
  // MUTATION-CHECK: returning false for malformed persisted state fails N22's
  // malformed-fetch case and could duplicate an already-applied task.
  if (!Array.isArray(comments)) {
    throw new TypeError("comments must be an array");
  }
  // MUTATION-CHECK: removing this identity-input guard fails N22's malformed
  // replay-state test and would make an unspecified publisher matchable.
  if (botLogin.length === 0) {
    throw new TypeError("botLogin must be non-empty");
  }
  for (const comment of comments) {
    if (!isRecord(comment) || !isRecord(comment.user)) continue;
    if (comment.user.login !== botLogin) continue;
    // MUTATION-CHECK: skipping malformed bot-owned state fails N22's
    // malformed-body case and would turn unknown replay state into absence.
    if (typeof comment.body !== "string") {
      throw new TypeError("bot-authored comment has a malformed body");
    }
    // MUTATION-CHECK: accepting the retired/9e grammars or a non-terminal/glued
    // marker fails N22's closed-grammar and standalone-final-line cases.
    if (
      bodyEndsWithStandaloneMarker(comment.body, successMarker) ||
      bodyEndsWithStandaloneMarker(comment.body, noticeMarker)
    ) return true;
  }
  return false;
}

export function buildTaskTrailer(commentId: number): string {
  requireTaskCommentId(commentId);
  return `Owner-Task-Comment: ${commentId}`;
}

/** MERGE-style replay detection over the caller-bounded GitHub commit window. */
export function findTaskTrailerCommit(
  commits: unknown,
  commentId: number,
): boolean {
  const trailer = buildTaskTrailer(commentId);
  // MUTATION-CHECK: removing either persisted-state bound fails the bounded-
  // window and malformed-window tests, making replay evidence ambiguous.
  if (!Array.isArray(commits)) {
    throw new TypeError("commits must be an array");
  }
  if (commits.length > MAX_TRAILER_COMMIT_WINDOW) {
    throw new RangeError("commits exceeds the 100-commit replay window");
  }
  for (const item of commits) {
    // MUTATION-CHECK: skipping malformed commit records fails the malformed-
    // window test and could turn unknown persisted history into no replay.
    if (
      !isRecord(item) ||
      !isRecord(item.commit) ||
      typeof item.commit.message !== "string"
    ) {
      throw new TypeError("commit has a malformed message");
    }
    if (item.commit.message.split(/\r?\n/).some((line) => line.trim() === trailer)) {
      return true;
    }
  }
  return false;
}

/** Neutralise all current and retired owner-task marker grammars after rendering. */
export function neutralizeTaskMarkers(rendered: string): string {
  // MUTATION-CHECK: narrowing the optional suffixed task alternatives fails
  // N21's four-grammar count and could forge replay evidence in rendered text.
  return rendered.replace(
    /<!-- owner-(?:command-response|task-apply(?:-success|-notice)?): \d+ -->/g,
    TASK_MARKER_SPOOF_REMOVED,
  );
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function reject(
  stage: Extract<OwnerTaskPatchDecision, { kind: "reject-notice" }>["stage"],
  reasons: readonly string[],
): OwnerTaskPatchDecision {
  return { kind: "reject-notice", stage, reasons: [...reasons] };
}

function requirePullRequestSha(
  pullRequest: Record<string, unknown>,
  side: "head" | "base",
): string {
  const sideRecord = pullRequest[side];
  if (!isRecord(sideRecord)) {
    throw new TypeError(`current PR ${side} SHA is malformed`);
  }
  const sha = sideRecord.sha;
  if (typeof sha !== "string" || !FULL_SHA_PATTERN.test(sha)) {
    throw new TypeError(`current PR ${side} SHA is malformed`);
  }
  return sha;
}

function hasValidAnalysisShape(
  analysis: AuthoritativePatchAnalysis,
): boolean {
  // MUTATION-CHECK: weakening the top-level analysis checks fails "unknown,
  // malformed, or empty analysis state" and could admit an unproven tree.
  if (
    !FULL_SHA_PATTERN.test(analysis.baseSha) ||
    !FULL_SHA_PATTERN.test(analysis.treeOid) ||
    !Array.isArray(analysis.changedPaths) ||
    !analysis.changedPaths.every((path) => typeof path === "string") ||
    typeof analysis.diffText !== "string" ||
    !Array.isArray(analysis.lineStats)
  ) {
    return false;
  }
  // MUTATION-CHECK: weakening per-row validation fails that same malformed-
  // analysis test's empty-stat object case.
  return analysis.lineStats.every((stat: FactoryPatchLineStat) =>
    isRecord(stat) &&
    typeof stat.path === "string" &&
    (stat.sourcePath === undefined || typeof stat.sourcePath === "string") &&
    (stat.additions === null || typeof stat.additions === "number") &&
    (stat.deletions === null || typeof stat.deletions === "number")
  );
}

export function isRecognizableAppliedAnalysis(
  analysis: AuthoritativePatchAnalysis,
  expectedBaseSha: string,
): boolean {
  // MUTATION-CHECK: "recognition refuses inadmissible authoritative analysis"
  // kills removal of the shared forbidden-path or envelope admission gates.
  return (
    hasValidAnalysisShape(analysis) &&
    analysis.changedPaths.length > 0 &&
    analysis.baseSha === expectedBaseSha &&
    findForbiddenPatchPaths(analysis.changedPaths).length === 0 &&
    findFactoryPatchEnvelopeViolations(analysis.lineStats).length === 0
  );
}

/** Apply the ratified ten-row fail-closed decision table in order. */
export function decideOwnerTaskPatch(
  input: OwnerTaskPatchDecisionInput,
): OwnerTaskPatchDecision {
  // MUTATION-CHECK: trusting caller judgment or removing this re-derivation
  // fails "Fold 8: re-derives eligibility from raw fetched records" and would
  // let forged authorization reach repository mutation logic.
  const authorization = deriveResponseAuthorization(input);
  // MUTATION-CHECK: removing eligibility/verb checks fails Fold 8 / N12-N16
  // and would let an ineligible or question command reach mutation logic.
  if (
    authorization.proceed !== true ||
    authorization.command.verb !== "task"
  ) {
    return { kind: "ignore" };
  }

  if (
    typeof input.markerPresent !== "boolean" ||
    typeof input.trailerCommitPresent !== "boolean"
  ) {
    throw new TypeError("replay evidence must be boolean");
  }
  // MUTATION-CHECK: removing either replay arm fails T4's marker/trailer cases
  // and would permit a duplicate commit or comment.
  if (input.markerPresent || input.trailerCommitPresent) {
    return { kind: "no-op-success" };
  }

  // MUTATION-CHECK: weakening missing/byte-size/parse checks fails N17/N18;
  // replay intentionally precedes them so an already-applied task converges.
  if (typeof input.bindingArtifact !== "string") {
    throw new Error("owner-task binding artifact is missing");
  }
  if (
    new TextEncoder().encode(input.bindingArtifact).length >
      MAX_ANSWER_ARTIFACT_BYTES
  ) {
    throw new Error("owner-task binding artifact is oversized");
  }
  const binding = parseTaskBinding(input.bindingArtifact);
  // MUTATION-CHECK: removing either task-binding comparison fails N18's
  // payload-hash and truncation drift cases.
  if (
    sha256(authorization.command.payload) !==
      binding.commandPayloadSha256 ||
    authorization.command.truncated !== binding.taskTruncated
  ) {
    throw new Error("owner-task binding does not match the authorised command");
  }
  // MUTATION-CHECK: removing this fail-closed gate fails "Fold 10: rejects a
  // truncated owner task before artifact analysis" and would apply a prefix.
  if (authorization.command.truncated) {
    return reject("patch-artifact", [
      "owner task was truncated; reissue a shorter command",
    ]);
  }

  // MUTATION-CHECK: relaxing the non-positive size guard back to `< 0` fails
  // N10's zero-byte, otherwise-valid-analysis regression.
  if (
    !Number.isSafeInteger(input.patchArtifactBytes) ||
    input.patchArtifactBytes <= 0
  ) {
    return reject("patch-artifact", ["patch artifact is empty or has an invalid size"]);
  }
  // MUTATION-CHECK: removing or tightening the artifact cap fails N7's
  // oversized case or Fold 2's exact-MAX_PATCH_BYTES acceptance case.
  if (input.patchArtifactBytes > MAX_PATCH_BYTES) {
    return reject("patch-artifact", [
      `patch artifact exceeds the ${MAX_PATCH_BYTES}-byte limit`,
    ]);
  }
  // Authorization proceeding already proves this fetched value is a PR record.
  /* v8 ignore next 3 -- unreachable after deriveResponseAuthorization returns proceed:true. */
  if (!isRecord(input.pullRequest)) {
    throw new TypeError("current pull request record is malformed");
  }
  const currentHeadSha = requirePullRequestSha(input.pullRequest, "head");
  const currentBaseSha = requirePullRequestSha(input.pullRequest, "base");
  // MUTATION-CHECK: removing freshness fails N1/N2 and would apply a task to
  // a head other than the snapshot the owner and agent reviewed.
  if (currentHeadSha !== binding.prHeadSha) {
    return {
      kind: "stale-notice",
      expectedHeadSha: binding.prHeadSha,
      currentHeadSha,
      expectedBaseSha: binding.prBaseSha,
      currentBaseSha,
    };
  }
  // MUTATION-CHECK: removing base freshness fails "Fold 9: base drift is
  // stale even when the authorised head and command are unchanged".
  if (currentBaseSha !== binding.prBaseSha) {
    return {
      kind: "stale-notice",
      expectedHeadSha: binding.prHeadSha,
      currentHeadSha,
      expectedBaseSha: binding.prBaseSha,
      currentBaseSha,
    };
  }

  // MUTATION-CHECK: treating an encoding/apply/query failure as analyzable
  // fails row-6's rejection test and could admit an unproven tree.
  if (input.patchAnalysis.status === "failed") {
    return reject("patch-analysis", input.patchAnalysis.reasons);
  }
  if (input.patchAnalysis.status !== "ok") {
    // MUTATION-CHECK: removing this unknown-state rejection fails "unknown,
    // malformed, or empty analysis state" and could fall through to apply.
    return reject("patch-analysis", ["patch analysis has an unknown status"]);
  }
  const analysis = input.patchAnalysis.analysis;
  // MUTATION-CHECK: weakening shape/emptiness rejection fails "unknown,
  // malformed, or empty analysis state" for every malformed fixture.
  if (!hasValidAnalysisShape(analysis) || analysis.changedPaths.length === 0) {
    return reject("patch-analysis", ["patch analysis is malformed or empty"]);
  }
  // MUTATION-CHECK: removing the base binding fails "Fold 1: rejects analysis
  // based on a commit other than the authorised head" and admits a foreign tree.
  if (analysis.baseSha !== binding.prHeadSha) {
    return reject("patch-analysis", [
      "patch analysis base does not match the authorised head",
    ]);
  }

  const forbiddenPaths = findForbiddenPatchPaths(analysis.changedPaths);
  // MUTATION-CHECK: removing this authoritative-path guard fails every N4
  // protected category and N5's protected rename-source case.
  if (forbiddenPaths.length > 0) {
    return reject("protected-path", forbiddenPaths);
  }

  const envelopeViolations = findFactoryPatchEnvelopeViolations(
    analysis.lineStats,
  );
  // MUTATION-CHECK: removing this envelope gate fails N6/N7/N8's binary,
  // changed-line ceiling, and inert-output-mix cases.
  if (envelopeViolations.length > 0) {
    return reject("envelope", envelopeViolations);
  }

  // MUTATION-CHECK: dropping any classifier fails T7's matching annotation
  // case; these remain advisory and never change the apply outcome.
  const annotations: OwnerTaskGamingAnnotations = {
    testFileEdits: findTestFileEdits(analysis.changedPaths),
    coverageSuppressions: findAddedCoverageSuppressions(analysis.diffText),
    packageJsonTestScriptEdits:
      findAddedPackageJsonTestScriptEdits(analysis.diffText),
    rootPytestConfigSections:
      findAddedRootPytestConfigSections(analysis.diffText),
  };

  const commitSubject =
    TASK_COMMIT_SUBJECT_PREFIX +
    sanitizeAndClampUntrustedTextForCommitMessage(
      authorization.command.payload,
      MAX_TASK_COMMIT_SUBJECT_LENGTH - TASK_COMMIT_SUBJECT_PREFIX.length - 1,
    );
  const trailer = buildTaskTrailer(input.commentId);
  // Defensive backstop against a future regression in the independently-
  // tested shared commit-message sanitiser; unreachable while it holds.
  /* v8 ignore next 3 -- unreachable while the shared commit-message sanitiser upholds its independently-tested contract. */
  if (findCiSkipDirectives(`${commitSubject}\n\n${trailer}`).length > 0) {
    throw new Error("a CI-skip directive survived commit-message sanitisation");
  }

  return {
    kind: "apply",
    treeOid: analysis.treeOid,
    parent: binding.prHeadSha,
    commitSubject,
    trailer,
    annotations,
    forceWithLeaseExpectedSha: binding.prHeadSha,
  };
}
