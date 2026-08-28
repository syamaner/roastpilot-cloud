import {
  isEligibleFactoryOwnerAuthor,
  isPullRequestIssue,
  parseOwnerCommand,
  type OwnerCommand,
} from "./owner-command-logic.mts";

type IssueOwnerCommand = Extract<
  OwnerCommand,
  { verb: "approve" | "respec" }
>;

export type DerivedIssueCommandAuthorization =
  | { proceed: false }
  | { proceed: true; command: IssueOwnerCommand };

export interface IssueCommandAuthorizationInput {
  issue: unknown;
  repository: unknown;
  author: unknown;
  commentBody: unknown;
  githubRepository: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireFetchedRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TypeError(`GitHub API returned a malformed ${label}`);
  }
  return value;
}

/**
 * Re-derive issue-command eligibility entirely from fetched GitHub records.
 * Unknown record shapes throw so an API contract drift is loud, while valid
 * but ineligible records return the inert authorization result.
 */
export function deriveIssueCommandAuthorization(
  input: IssueCommandAuthorizationInput,
): DerivedIssueCommandAuthorization {
  const issue = requireFetchedRecord(input.issue, "issue");
  const repository = requireFetchedRecord(input.repository, "repository");
  const author = requireFetchedRecord(input.author, "issue comment author");
  if (
    typeof input.githubRepository !== "string" ||
    input.githubRepository.length === 0 ||
    typeof repository.full_name !== "string" ||
    typeof repository.fork !== "boolean" ||
    typeof issue.state !== "string" ||
    typeof author.login !== "string" ||
    typeof input.commentBody !== "string"
  ) {
    throw new TypeError("GitHub API returned malformed issue authorization fields");
  }
  if (
    Object.prototype.hasOwnProperty.call(issue, "pull_request") &&
    !isPullRequestIssue(issue)
  ) {
    throw new TypeError("GitHub API returned a malformed pull request marker");
  }

  // MUTATION-CHECK M-PR: removing this guard admits issue verbs on PRs.
  if (isPullRequestIssue(issue)) return { proceed: false };
  // MUTATION-CHECK M-REPO: either byte mismatch or fork status is ineligible.
  if (
    repository.full_name !== input.githubRepository ||
    repository.fork !== false
  ) return { proceed: false };
  // MUTATION-CHECK M-OPEN: only a fetched open issue is eligible.
  if (issue.state !== "open") return { proceed: false };
  // MUTATION-CHECK M-OWNER: a public-repo stranger must remain inert.
  if (!isEligibleFactoryOwnerAuthor(author)) return { proceed: false };

  const command = parseOwnerCommand(input.commentBody);
  if (command === null) return { proceed: false };
  // MUTATION-CHECK M-SUBSET: PR-only verbs are closed out explicitly.
  if (command.verb !== "approve" && command.verb !== "respec") {
    return { proceed: false };
  }
  return { proceed: true, command };
}
