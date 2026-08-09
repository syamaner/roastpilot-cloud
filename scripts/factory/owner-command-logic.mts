import { isFactoryOwnerLogin } from "./factory-owner-allowlist.mts";

export type OwnerCommand = {
  verb: "question" | "task";
  payload: string;
  truncated: boolean;
};

/** Mirrors spec-grounding-logic.mts's 256 KiB structural-input bound. */
const MAX_STRUCTURAL_INPUT_BYTES = 256 * 1024;
export const MAX_OWNER_COMMAND_PAYLOAD_CODE_POINTS = 4000;

const LEADING_COMMAND_PATTERN =
  /^@[cC][lL][aA][uU][dD][eE][ \t]+([^\t\n\v\f\r ]+)/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** A GitHub issue comment belongs to a PR only when its PR marker is present. */
export function isPullRequestIssue(issue: unknown): boolean {
  return isRecord(issue) && isRecord(issue.pull_request);
}

/** Exclude forks and missing head repositories by exact repository-name bytes. */
export function isSameRepositoryPullRequest(
  pullRequest: unknown,
  githubRepository: string,
): boolean {
  if (!isRecord(pullRequest) || !isRecord(pullRequest.head)) return false;
  const repo = pullRequest.head.repo;
  return isRecord(repo) && repo.full_name === githubRepository;
}

/** Only an open, unmerged PR is eligible; draft status is deliberately irrelevant. */
export function isEligiblePullRequestState(pullRequest: unknown): boolean {
  return isRecord(pullRequest) &&
    pullRequest.state === "open" &&
    pullRequest.merged === false;
}

/** Authorize an already-fetched GitHub author record through the shared allowlist. */
export function isEligibleFactoryOwnerAuthor(author: unknown): boolean {
  return isRecord(author) && isFactoryOwnerLogin(author.login);
}

function normalizeLineEndings(body: string): string {
  return body.replace(/\r\n?/g, "\n");
}

function asciiFold(value: string): string {
  return value.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 0x20));
}

function truncateCodePoints(value: string): Pick<OwnerCommand, "payload" | "truncated"> {
  const codePoints = [...value];
  return {
    payload: codePoints.slice(0, MAX_OWNER_COMMAND_PAYLOAD_CODE_POINTS).join(""),
    truncated: codePoints.length > MAX_OWNER_COMMAND_PAYLOAD_CODE_POINTS,
  };
}

/**
 * Parse only an ASCII-strict `@claude` command at the visible document lead.
 * Only leading LF blank lines are ignorable; every container/formatting lead
 * fails closed before command derivation.
 */
export function parseOwnerCommand(body: string): OwnerCommand | null {
  const normalized = normalizeLineEndings(body);
  if (new TextEncoder().encode(normalized).length > MAX_STRUCTURAL_INPUT_BYTES) {
    return null;
  }
  const lead = normalized.replace(/^\n+/, "");
  const match = LEADING_COMMAND_PATTERN.exec(lead);
  if (match === null) return null;

  const foldedVerb = asciiFold(match[1]!);
  if (foldedVerb !== "question" && foldedVerb !== "task") return null;

  const verbEnd = normalized.length - lead.length + match[0].length;
  const boundedPayload = truncateCodePoints(
    normalized.slice(verbEnd),
  );
  return {
    verb: foldedVerb,
    ...boundedPayload,
  };
}
