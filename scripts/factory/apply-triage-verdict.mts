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
 * On a missing or invalid verdict, readiness is explicitly RESET to
 * `needs-triage` (not just left as whatever it already was — a rerun could
 * find a stale `ready-to-implement` from an earlier valid verdict or manual
 * pre-labelling, and leaving that in place while triage has just failed
 * would let a later implement stage build it despite no successful triage
 * having run) — the fail-safe resting state — and this script exits
 * non-zero purely for workflow-run visibility (so a broken triage run shows
 * red in Actions, not just a silent no-op).
 *
 * Required environment variables:
 * - `GH_TOKEN` — the job's `permissions: issues: write` token.
 * - `GITHUB_REPOSITORY` — `owner/repo` (set automatically by Actions).
 * - `TRUSTED_ISSUE_NUMBER` — from `github.event.issue.number`, never from
 *   the verdict artifact.
 * - `VERDICT_PATH` — path to the downloaded artifact file (may not exist).
 */

import { readFile, stat } from "node:fs/promises";
import {
  MAX_PAYLOAD_BYTES,
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

/**
 * Reads and JSON-parses the verdict artifact, tolerating a missing file.
 *
 * Checks the file's size via `stat` BEFORE reading its contents into
 * memory or handing them to `JSON.parse` — a runaway or adversarial
 * multi-GB artifact must be rejected without ever being fully read, or it
 * could OOM/stall this privileged job before the fail-closed path even
 * runs. The same {@link MAX_PAYLOAD_BYTES} bound the schema validator uses
 * for the in-memory verdict applies here to the on-disk file.
 */
async function readVerdictArtifact(path: string): Promise<unknown> {
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(path);
  } catch (err) {
    throw new Error(
      `triage artifact not found at ${path} (triage job likely failed or ` +
        `produced no output): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (fileStat.size > MAX_PAYLOAD_BYTES) {
    throw new Error(
      `triage artifact at ${path} is ${fileStat.size} bytes, exceeds the ` +
        `${MAX_PAYLOAD_BYTES}-byte limit — rejected before being read into ` +
        `memory`,
    );
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    // Narrow TOCTOU race (stat succeeds, the file vanishes/becomes
    // unreadable before readFile runs) — not meaningfully triggerable in
    // this single-shot CI job, so not exercised by a unit test; kept as a
    // defensive branch so a real occurrence still fails closed with a
    // clear error instead of an unhandled rejection.
    throw new Error(
      `triage artifact at ${path} could not be read after a successful ` +
        `stat (possible race with another process): ${err instanceof Error ? err.message : String(err)}`,
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

const COMMENT_PAGE_SIZE = 100;
/**
 * Upper bound on how many comment pages to scan looking for a prior
 * triage comment (~5,000 comments) — pathologically high for a factory
 * issue, but a sane cap against an unbounded loop rather than trusting the
 * API to always terminate cleanly.
 */
const MAX_COMMENT_PAGES = 50;

/**
 * Finds this job's own prior triage comment, if any, paginating through
 * every page of comments rather than only the first. An issue with more
 * than one page of comments (>100) could otherwise have its marker
 * comment missed, causing a duplicate post on a rerun instead of an edit.
 */
async function findExistingTriageComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
): Promise<number | null> {
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const comments = await githubRequest<GitHubComment[]>(
      token,
      "GET",
      `/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=${COMMENT_PAGE_SIZE}&page=${page}`,
    );
    const existing: ExistingComment[] = comments.map((c) => ({
      id: c.id,
      body: c.body,
      authorType: c.user?.type ?? null,
    }));
    const found = findExistingTriageCommentId(existing);
    if (found !== null) {
      return found;
    }
    if (comments.length < COMMENT_PAGE_SIZE) {
      return null; // Last page: no more comments to check.
    }
  }
  console.warn(
    `Scanned ${MAX_COMMENT_PAGES} pages of comments on #${issueNumber} ` +
      `without finding a prior triage comment; posting a new one rather ` +
      `than risking missing a marker beyond this page limit.`,
  );
  return null;
}

async function upsertComment(
  token: string,
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  const existingId = await findExistingTriageComment(
    token,
    owner,
    repo,
    issueNumber,
  );

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

/**
 * Applies a validated verdict: swaps the readiness label and upserts the
 * tracking comment. Deliberately never calls the issue-close API, for any
 * readiness value including `wontfix` — see
 * {@link buildVerdictCommentBody}'s docstring for why.
 */
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
  // Fail closed on readiness, not just on comment content: a rerun could
  // find the issue already carrying a stale ready-to-implement (from an
  // earlier, since-superseded valid verdict, or manual pre-labelling) —
  // leaving that in place while triage has just failed would let F1-S3
  // pick it up as buildable despite no successful triage having run. Reset
  // to needs-triage explicitly, the same way `seed` would have, every time.
  const currentLabels = await githubRequest<GitHubIssueLabel[]>(
    token,
    "GET",
    `/repos/${owner}/${repo}/issues/${issueNumber}/labels?per_page=100`,
  );
  const resetLabelSet = computeNewLabelSet(
    currentLabels.map((l) => l.name),
    "needs-triage",
  );
  await githubRequest(
    token,
    "PUT",
    `/repos/${owner}/${repo}/issues/${issueNumber}/labels`,
    { labels: resetLabelSet },
  );

  await upsertComment(
    token,
    owner,
    repo,
    issueNumber,
    buildFallbackCommentBody(errors),
  );
  console.error(
    `Triage verdict for #${issueNumber} was invalid; readiness reset to ` +
      `needs-triage. Errors:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
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
