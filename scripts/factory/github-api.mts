/**
 * A thin, shared authenticated-JSON wrapper over the GitHub REST API, used
 * by every privileged factory script (`apply-triage-verdict.mts`,
 * `publish-implement-patch.mts`, ...). Deliberately minimal — no SDK
 * dependency, no retry/backoff (none of the privileged jobs make enough
 * calls per run to need it; see factory.md §13 point 8's note that
 * 429/Retry-After handling is deferred to F1-S10/#13).
 *
 * Extracted from `apply-triage-verdict.mts` (F1-S2) when F1-S3 needed the
 * identical helper — kept in one place rather than duplicated.
 */

const GITHUB_API = "https://api.github.com";

/**
 * Reads a required environment variable, throwing a clear error if it's
 * missing or empty — used for every input a privileged script's caller
 * (the workflow YAML) is expected to always provide.
 *
 * @param name - The environment variable's name.
 * @returns Its value.
 * @throws If the variable is unset or empty.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Makes an authenticated JSON request against the GitHub REST API.
 *
 * @param token - The bearer token (a job's own `secrets.GITHUB_TOKEN`,
 *   scoped by that job's `permissions:` block — never a broader token).
 * @param method - The HTTP method.
 * @param path - The API path, e.g. `/repos/{owner}/{repo}/issues/{n}`.
 * @param body - An optional JSON-serializable request body.
 * @returns The parsed JSON response, or `undefined` for a 204.
 * @throws If the response status is not ok (2xx).
 */
export async function githubRequest<T>(
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
    // The .catch() fallback only runs if response.text() itself throws
    // (e.g. a corrupted/already-consumed stream) — not meaningfully
    // triggerable against a mocked Response in tests, kept as a defensive
    // fallback so a real occurrence still produces a readable error.
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
