/**
 * A thin, shared authenticated-JSON wrapper over the GitHub REST API, used
 * by every privileged factory script (`apply-triage-verdict.mts`,
 * `publish-implement-patch.mts`, ...). Deliberately minimal — no SDK
 * dependency.
 *
 * Extracted from `apply-triage-verdict.mts` (F1-S2) when F1-S3 needed the
 * identical helper — kept in one place rather than duplicated.
 *
 * F1-S10 (#13, factory.md §13 point 8) added 429/`Retry-After` backoff
 * (previously deferred — this module's own prior docstring said so) —
 * see {@link githubRequest}'s own doc for the retry behavior. Applying it
 * here, in the one shared client, covers every privileged call this
 * factory makes (PR create/refresh, issue/PR comments, labels, triage
 * verdicts) rather than bolting retry logic onto individual call sites.
 */

const GITHUB_API = "https://api.github.com";

/**
 * Upper bound on additional attempts `githubRequest` makes after an
 * initial rate-limited response, before giving up and letting the
 * failure surface for real. GitHub's own guidance is to honor
 * `Retry-After` rather than hammer the API, but an unbounded retry loop
 * would let a sustained outage or a misconfigured limit stall a job
 * indefinitely — this caps it at a handful of attempts instead.
 */
export const MAX_RATE_LIMIT_RETRIES = 5;

/**
 * Upper bound on a single `Retry-After`-driven wait, in seconds. GitHub's
 * real values are typically single-digit-to-low-double-digit seconds;
 * this exists purely to bound an unexpectedly large or malformed header
 * value (still GitHub's own API, not attacker-controlled in the security
 * sense, but a job should never stall unboundedly on any header value it
 * didn't itself choose).
 */
export const MAX_RETRY_AFTER_SECONDS = 60;

/**
 * True when a GitHub API response represents rate limiting this client
 * should back off and retry for, rather than fail immediately.
 *
 * A bare 429 is GitHub's documented shape for BOTH primary and secondary
 * rate limiting, so it always qualifies. A 403 only qualifies when it
 * carries a `Retry-After` header — GitHub's documented secondary-rate-
 * limit response can be either status code, but an ORDINARY permissions
 * 403 (a genuinely unauthorized/expired token, a scope the token lacks)
 * never carries that header, and must still fail immediately rather than
 * be retried into a slow, misleading timeout.
 *
 * @param status - The response's HTTP status code.
 * @param retryAfterHeader - The response's `Retry-After` header value, or
 *   `null` if absent.
 * @returns Whether this response should be retried with backoff.
 */
export function isRateLimitedResponse(
  status: number,
  retryAfterHeader: string | null,
): boolean {
  if (status === 429) {
    return true;
  }
  return status === 403 && retryAfterHeader !== null;
}

/**
 * Parses a `Retry-After` header's value into milliseconds to wait.
 * GitHub's REST API always sends this as a plain integer number of
 * seconds (RFC 9110 §10.2.3's delay-seconds form) — the alternative
 * HTTP-date form the spec also allows is not handled, since GitHub never
 * sends it here and a caller falling back to its own backoff for an
 * unparseable value is the safe default either way.
 *
 * Deliberately NOT clamped to {@link MAX_RETRY_AFTER_SECONDS} (Codex P2,
 * #53's first review round): an earlier version of this function clamped
 * an oversized value down to the cap and returned it as a wait, which
 * made the retry loop wait the CAPPED amount and then retry anyway —
 * firing the retry attempt BEFORE the server's own requested delay had
 * actually elapsed, burning part of the retry budget against a request
 * that was still guaranteed to be rejected. This function's job is only
 * to report what the server actually asked for; {@link
 * shouldGiveUpOnRateLimit} is the caller's signal for "this wait is
 * longer than we're willing to retry for at all — stop, don't retry
 * early instead."
 *
 * @param headerValue - The raw header value, or `null` if the response
 *   had none.
 * @returns The wait, in milliseconds, exactly as the server requested;
 *   `null` if the value is missing, non-numeric, or negative.
 */
export function parseRetryAfterMs(headerValue: string | null): number | null {
  if (headerValue === null) {
    return null;
  }
  const seconds = Number(headerValue);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }
  return seconds * 1000;
}

/**
 * True when a rate-limited response's `Retry-After` header requests a
 * wait LONGER than {@link MAX_RETRY_AFTER_SECONDS} — the caller must
 * give up (let the failure surface) rather than retry at all.
 *
 * The cap bounds how long this client is willing to sit idle waiting on
 * GitHub; it does not license retrying EARLY against a genuine,
 * longer-than-usual wait GitHub explicitly asked for. Clamping the wait
 * down to the cap and retrying anyway (the bug this replaces, Codex P2,
 * #53) would hit the server again before its own requested delay
 * elapsed — a wasted attempt against a request still guaranteed to be
 * rejected. Giving up cleanly is the safe choice once the legitimately-
 * requested wait exceeds what this client will wait for.
 *
 * A missing or unparseable header returns `false` — that's a genuinely
 * different situation (no real guidance from the server at all), handled
 * instead by {@link computeBackoffMs}'s own capped exponential fallback.
 *
 * @param headerValue - The rate-limited response's `Retry-After` header
 *   value, or `null`.
 * @returns Whether the caller should give up rather than retry.
 */
export function shouldGiveUpOnRateLimit(headerValue: string | null): boolean {
  const ms = parseRetryAfterMs(headerValue);
  return ms !== null && ms > MAX_RETRY_AFTER_SECONDS * 1000;
}

/**
 * Computes how long to wait before the next retry attempt.
 *
 * Prefers the response's own `Retry-After` header when present and
 * parseable — GitHub telling us exactly how long to wait is always
 * better than guessing. Falls back to a capped exponential backoff
 * (500ms doubling per attempt, capped at {@link MAX_RETRY_AFTER_SECONDS})
 * when the header is absent or unparseable, so a retry still makes
 * bounded forward progress even when GitHub's response is silent on
 * timing.
 *
 * Callers MUST check {@link shouldGiveUpOnRateLimit} first and never call
 * this when it returns `true` — this function does not re-check the cap
 * against a header-provided value, since by the time it's called that
 * value is already guaranteed (by the caller's own prior check) to be
 * within {@link MAX_RETRY_AFTER_SECONDS}.
 *
 * @param retryAfterHeader - The rate-limited response's `Retry-After`
 *   header value, or `null`.
 * @param attempt - The zero-based retry attempt number (0 for the first
 *   retry after the initial request).
 * @returns The wait, in milliseconds.
 */
export function computeBackoffMs(
  retryAfterHeader: string | null,
  attempt: number,
): number {
  const fromHeader = parseRetryAfterMs(retryAfterHeader);
  if (fromHeader !== null) {
    return fromHeader;
  }
  const exponential = 500 * 2 ** attempt;
  return Math.min(exponential, MAX_RETRY_AFTER_SECONDS * 1000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Optional per-call overrides for {@link githubRequest}'s retry behavior
 * — never needed in production (both fields default to the real,
 * production-sane values), but lets a test swap in a fast/no-op sleep
 * function so a retry-path test doesn't need to wait out a real backoff,
 * and lets a test shrink the retry budget to exercise "exhausted retries"
 * without 5 real (mocked) round-trips.
 */
export interface GithubRequestOptions {
  /** Overrides {@link MAX_RATE_LIMIT_RETRIES}. */
  readonly maxRateLimitRetries?: number;
  /** Overrides the real `setTimeout`-based wait — test-only. */
  readonly sleepFn?: (ms: number) => Promise<void>;
  /**
   * Overrides the default `Accept: application/vnd.github+json` header
   * (F1-S9 slice 3b, issue #12): the pulls endpoint serves the raw unified
   * diff, instead of the normal JSON resource, when asked with
   * `application/vnd.github.v3.diff` — slice 3b-i's runner needs exactly
   * that to fetch a PR's diff text. Defaults to the JSON media type, so
   * every existing caller is unaffected.
   */
  readonly accept?: string;
  /**
   * Whether to parse the response body as JSON (the default, and every
   * existing caller's behavior) or return it as raw text (F1-S9 slice 3b —
   * the diff fetch above; GitHub's diff media type is plain text, not
   * JSON, and `response.json()` would throw trying to parse it).
   */
  readonly responseType?: "json" | "text";
}

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
 * Retries a rate-limited response (see {@link isRateLimitedResponse}) with
 * backoff (see {@link computeBackoffMs}), up to
 * {@link MAX_RATE_LIMIT_RETRIES} additional attempts, before surfacing it
 * as a real failure. This is always safe to retry regardless of HTTP
 * method: a rate-limited response means GitHub rejected the request
 * BEFORE processing it (nothing was created/modified), so a retry can
 * never double up a PR, comment, or label — it either lands once, on
 * whichever attempt GitHub finally accepts, or exhausts retries and
 * throws, same as an unretried failure would.
 *
 * @param token - The bearer token (a job's own `secrets.GITHUB_TOKEN`,
 *   scoped by that job's `permissions:` block — never a broader token).
 * @param method - The HTTP method.
 * @param path - The API path, e.g. `/repos/{owner}/{repo}/issues/{n}`.
 * @param body - An optional JSON-serializable request body.
 * @param options - Retry overrides (test-only), and the `accept`/
 *   `responseType` overrides a non-JSON endpoint (e.g. a PR diff) needs;
 *   see {@link GithubRequestOptions}.
 * @returns The parsed JSON response (or raw text, with
 *   `responseType: "text"`), or `undefined` for a 204.
 * @throws If the response status is not ok (2xx) and either isn't rate
 *   limiting, the server's requested wait exceeds
 *   {@link MAX_RETRY_AFTER_SECONDS} (see {@link shouldGiveUpOnRateLimit}),
 *   or the retry budget is exhausted.
 */
export async function githubRequest<T>(
  token: string,
  method: string,
  path: string,
  body?: unknown,
  options?: GithubRequestOptions,
): Promise<T> {
  const maxRetries = options?.maxRateLimitRetries ?? MAX_RATE_LIMIT_RETRIES;
  const sleepFn = options?.sleepFn ?? sleep;
  const accept = options?.accept ?? "application/vnd.github+json";
  const responseType = options?.responseType ?? "json";

  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${GITHUB_API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const retryAfterHeader = response.headers.get("retry-after");
    if (
      isRateLimitedResponse(response.status, retryAfterHeader) &&
      attempt < maxRetries &&
      !shouldGiveUpOnRateLimit(retryAfterHeader)
    ) {
      const waitMs = computeBackoffMs(retryAfterHeader, attempt);
      console.warn(
        `GitHub API ${method} ${path} rate-limited (status ${response.status}); ` +
          `retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`,
      );
      await sleepFn(waitMs);
      continue;
    }

    if (
      isRateLimitedResponse(response.status, retryAfterHeader) &&
      shouldGiveUpOnRateLimit(retryAfterHeader)
    ) {
      console.warn(
        `GitHub API ${method} ${path} rate-limited (status ${response.status}) with a ` +
          `Retry-After of ${retryAfterHeader}s, exceeding the ${MAX_RETRY_AFTER_SECONDS}s ` +
          `cap — giving up rather than retrying before that wait elapses.`,
      );
    }

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
    if (responseType === "text") {
      return (await response.text()) as T;
    }
    return (await response.json()) as T;
  }
}
