/**
 * CLI entrypoint for the privileged `apply` job in
 * `.github/workflows/triage-issues.yml`.
 *
 * This is the ONLY piece of the triage pipeline that holds a writable
 * GitHub token, and it never executes anything the agent produced — it
 * reads a JSON artifact written by the read-only `triage` job, validates it
 * with {@link validateTriageVerdict} (schema.mts), and if (and only if)
 * that passes, makes two deterministic GitHub REST API calls: replace the
 * issue's label set, and upsert a tracking comment. All agent-controlled
 * text (the verdict's `reasoning` / `missing_info_questions`) reaches
 * GitHub only as a JSON request body over `fetch` — never through a shell
 * command — so there is no shell-interpolation injection surface.
 *
 * On a missing or invalid verdict, the seeded `needs-triage` label (applied
 * by the `seed` job before `triage` ever ran) is left untouched — the
 * fail-safe resting state — and this script exits non-zero purely for
 * workflow-run visibility (so a broken triage run shows red in Actions,
 * not just a silent no-op).
 *
 * Required environment variables:
 * - `GH_TOKEN` — the job's `permissions: issues: write` token.
 * - `GITHUB_REPOSITORY` — `owner/repo` (set automatically by Actions).
 * - `TRUSTED_ISSUE_NUMBER` — from `github.event.issue.number`, never from
 *   the verdict artifact.
 * - `VERDICT_PATH` — path to the downloaded artifact file (may not exist).
 */

import { readFile } from "node:fs/promises";
import {
  validateTriageVerdict,
  type TriageVerdictValidationResult,
} from "./triage-verdict-schema.mts";
import {
  buildFallbackCommentBody,
  buildVerdictCommentBody,
  computeNewLabelSet,
  findExistingTriageCommentId,
  type ExistingComment,
} from "./apply-triage-verdict-logic.mts";

const GITHUB_API = "https://api.github.com";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

interface GitHubIssueLabel {
  readonly name: string;
}

interface GitHubComment {
  readonly id: number;
  readonly body: string;
  readonly user: { readonly type: string } | null;
}

/** Thin wrapper: authenticated JSON request against the GitHub REST API. */
async function githubRequest<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "<unreadable body>");
    throw new Error(
      `GitHub API ${method} ${path} failed: ${response.status} ${text}`,
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

/** Reads and JSON-parses the verdict artifact, tolerating a missing file. */
async function readVerdictArtifact(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(
      `triage artifact not found at ${path} (triage job likely failed or ` +
        `produced no output): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `triage artifact at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function upsertComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  const comments = await githubRequest<GitHubComment[]>(
    token,
    "GET",
    `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`,
  );
  const existing: ExistingComment[] = comments.map((c) => ({
    id: c.id,
    body: c.body,
    authorType: c.user?.type ?? null,
  }));
  const existingId = findExistingTriageCommentId(existing);

  if (existingId !== null) {
    await githubRequest(
      token,
      "PATCH",
      `/repos/${owner}/${repo}/issues/comments/${existingId}`,
      { body },
    );
  } else {
    await githubRequest(
      token,
      "POST",
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { body },
    );
  }
}

async function applyValidVerdict(
  token: string,
  owner: string,
  repo: string,
  result: Extract<TriageVerdictValidationResult, { ok: true }>,
): Promise<void> {
  const { verdict } = result;

  const currentLabels = await githubRequest<GitHubIssueLabel[]>(
    token,
    "GET",
    `/repos/${owner}/${repo}/issues/${verdict.issue_number}/labels?per_page=100`,
  );
  const newLabelSet = computeNewLabelSet(
    currentLabels.map((l) => l.name),
    verdict.readiness,
  );
  await githubRequest(
    token,
    "PUT",
    `/repos/${owner}/${repo}/issues/${verdict.issue_number}/labels`,
    { labels: newLabelSet },
  );

  await upsertComment(
    token,
    owner,
    repo,
    verdict.issue_number,
    buildVerdictCommentBody(verdict),
  );

  console.log(
    `Applied verdict for #${verdict.issue_number}: readiness=${verdict.readiness}, ` +
      `labels=[${newLabelSet.join(", ")}]`,
  );
}

async function applyFallback(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  errors: readonly string[],
): Promise<void> {
  await upsertComment(
    token,
    owner,
    repo,
    issueNumber,
    buildFallbackCommentBody(errors),
  );
  console.error(
    `Triage verdict for #${issueNumber} was invalid; needs-triage label left ` +
      `unchanged. Errors:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
  );
}

export async function main(): Promise<void> {
  const token = requireEnv("GH_TOKEN");
  const [owner, repo] = requireEnv("GITHUB_REPOSITORY").split("/");
  if (!owner || !repo) {
    throw new Error(
      `GITHUB_REPOSITORY must be "owner/repo", got ${process.env.GITHUB_REPOSITORY}`,
    );
  }
  const trustedIssueNumber = Number(requireEnv("TRUSTED_ISSUE_NUMBER"));
  const verdictPath = process.env.VERDICT_PATH ?? "triage-output/verdict.json";

  let raw: unknown;
  let readError: string | null = null;
  try {
    raw = await readVerdictArtifact(verdictPath);
  } catch (err) {
    readError = err instanceof Error ? err.message : String(err);
  }

  if (readError !== null) {
    await applyFallback(token, owner, repo, trustedIssueNumber, [readError]);
    process.exitCode = 1;
    return;
  }

  const result = validateTriageVerdict(raw, trustedIssueNumber);
  if (!result.ok) {
    await applyFallback(token, owner, repo, trustedIssueNumber, result.errors);
    process.exitCode = 1;
    return;
  }

  await applyValidVerdict(token, owner, repo, result);
}

// Only self-invoke when run directly (`node apply-triage-verdict.mts`), not
// when imported by a test. Genuinely uncovered by unit tests (they import
// `main` directly rather than exec'ing the file) — exercised instead by
// running the script directly, as documented in the PR description.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error("apply-triage-verdict failed:", err);
    process.exitCode = 1;
  });
}
