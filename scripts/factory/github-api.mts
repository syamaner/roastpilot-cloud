/**
 * A thin, shared authenticated-JSON wrapper over the GitHub REST API, used
 * by every privileged factory script (`apply-triage-verdict.mts`,
 * `publish-implement-patch.mts`, ...). Deliberately minimal — no SDK
 * dependency.
 *
 * Extracted from `apply-triage-verdict.mts` (F1-S2) when F1-S3 needed the
 * identical helper — kept in one place rather than duplicated.
 *
 * F1-S10 (#13, factory.md §13 point 8) added bounded rate-limit backoff,
 * completed for GitHub's documented REST response shapes by D114/#54 — see
 * {@link githubRequest}'s own doc for the retry behavior. Applying it here,
 * in the one shared client, covers every privileged call this factory makes
 * (PR create/refresh, issue/PR comments, labels, triage verdicts) rather than
 * bolting retry logic onto individual call sites.
 */

const GITHUB_API = "https://api.github.com";

/**
 * Thrown by {@link githubRequest} for a non-2xx response, carrying the
 * HTTP status code as a structured field (F1-S9 slice 3b-i, issue #12,
 * PR #72 review — Codex finding: a caller that needs to distinguish a
 * verified 404 from every OTHER failure — 403, 429 past the retry budget,
 * a 5xx, a network error — for a fail-closed decision had no reliable way
 * to do so against the previous plain `Error`, short of regex-parsing its
 * message. `spec-grounding-runner.mts`'s per-issue fetch is exactly this
 * case: only a genuine 404 may degrade to "issue not found"; anything
 * else must fail the whole run rather than silently omit that issue's
 * unmet criteria from the anti-gaming gate).
 */
export class GithubApiError extends Error {
  readonly status: number;

  constructor(method: string, path: string, status: number, bodyText: string) {
    super(`GitHub API ${method} ${path} failed: ${status} ${bodyText}`);
    this.name = "GithubApiError";
    this.status = status;
  }
}

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
 * Upper bound on a single rate-limit wait, in seconds. This bounds
 * `Retry-After`, primary reset timestamps, and the headerless-response
 * fallback alike: GitHub's response headers are not attacker-controlled in
 * the normal security sense, but a job must not stall unboundedly on timing
 * input it did not choose.
 */
export const MAX_RETRY_AFTER_SECONDS = 60;

/**
 * GitHub's minimum wait when a rate-limit response carries neither a usable
 * `Retry-After` nor a usable primary-limit reset tuple.
 */
export const MIN_RATE_LIMIT_FALLBACK_SECONDS = 60;

/** The timing signal that determined a rate-limit decision. */
export type RateLimitWaitSource = "retry-after" | "rate-limit-reset" | "fallback";

/**
 * A complete decision for one GitHub REST response.
 *
 * `give-up` preserves the server-requested wait rather than clamping it and
 * retrying before GitHub says the limit has cleared.
 */
export type RateLimitDecision =
  | { readonly kind: "not-rate-limited" }
  | {
      readonly kind: "retry";
      readonly waitMs: number;
      readonly source: RateLimitWaitSource;
    }
  | {
      readonly kind: "give-up";
      readonly waitMs: number;
      readonly source: RateLimitWaitSource;
    };

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
 * decideRateLimitResponse} turns an above-cap value into a `give-up`
 * decision rather than retrying early.
 *
 * @param headerValue - The raw header value, or `null` if the response
 *   had none.
 * @returns The wait, in milliseconds, exactly as the server requested;
 *   `null` if the value is missing, non-numeric, or negative.
 */
export function parseRetryAfterMs(headerValue: string | null): number | null {
  if (headerValue === null || !/^\d+$/.test(headerValue)) {
    return null;
  }
  const seconds = Number(headerValue);
  return seconds * 1000;
}

/**
 * Parses GitHub's `X-RateLimit-Reset` UTC epoch timestamp into a wait.
 *
 * @param headerValue - The raw reset header, in UTC epoch seconds.
 * @param nowMs - The current UTC epoch time in milliseconds.
 * @returns Milliseconds until reset (zero when reset is at or before
 *   `nowMs`), or `null` for an invalid timestamp or clock value.
 */
export function parseRateLimitResetWaitMs(
  headerValue: string | null,
  nowMs: number,
): number | null {
  if (
    headerValue === null ||
    !/^\d+$/.test(headerValue) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0
  ) {
    return null;
  }
  const resetSeconds = Number(headerValue);
  const resetMs = resetSeconds * 1000;
  if (!Number.isSafeInteger(resetSeconds) || !Number.isSafeInteger(resetMs)) {
    return null;
  }
  return Math.max(0, resetMs - nowMs);
}

function boundedRateLimitDecision(
  waitMs: number,
  source: RateLimitWaitSource,
): RateLimitDecision {
  if (waitMs > MAX_RETRY_AFTER_SECONDS * 1000) {
    return { kind: "give-up", waitMs, source };
  }
  return { kind: "retry", waitMs, source };
}

/**
 * Classifies one GitHub REST response using GitHub's documented precedence.
 *
 * A valid `Retry-After` wins. Otherwise a zero remaining count plus a valid
 * reset timestamp identifies primary exhaustion. A bare `429` without either
 * usable signal starts at GitHub's minimum 60-second fallback and doubles on
 * a continued failure; because the second wait exceeds this client's ceiling,
 * that second response gives up rather than retrying early. A `403` without a
 * usable rate-limit signal remains an ordinary authorization failure.
 *
 * @param status - The response's HTTP status code.
 * @param retryAfterHeader - Raw `Retry-After`, or `null`.
 * @param remainingHeader - Raw `X-RateLimit-Remaining`, or `null`.
 * @param resetHeader - Raw `X-RateLimit-Reset`, or `null`.
 * @param nowMs - Current UTC epoch time in milliseconds.
 * @param attempt - Zero-based retry attempt number.
 * @returns The retry, give-up, or non-rate-limit decision.
 */
export function decideRateLimitResponse(
  status: number,
  retryAfterHeader: string | null,
  remainingHeader: string | null,
  resetHeader: string | null,
  nowMs: number,
  attempt = 0,
): RateLimitDecision {
  if (status !== 403 && status !== 429) {
    return { kind: "not-rate-limited" };
  }

  const retryAfterMs = parseRetryAfterMs(retryAfterHeader);
  if (retryAfterMs !== null) {
    return boundedRateLimitDecision(retryAfterMs, "retry-after");
  }

  if (remainingHeader?.trim() === "0") {
    const resetWaitMs = parseRateLimitResetWaitMs(resetHeader, nowMs);
    if (resetWaitMs !== null) {
      return boundedRateLimitDecision(resetWaitMs, "rate-limit-reset");
    }
  }

  if (status === 429) {
    return boundedRateLimitDecision(
      MIN_RATE_LIMIT_FALLBACK_SECONDS * 1000 * 2 ** attempt,
      "fallback",
    );
  }

  return { kind: "not-rate-limited" };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Optional per-call overrides for {@link githubRequest} — retry behavior,
 * the request's media type / response parsing, and the text-response size
 * ceiling. Every field defaults to a real, production-sane value, so
 * `options` itself is never REQUIRED; some fields exist for test
 * convenience (`sleepFn`, `nowFn`, `maxRateLimitRetries`,
 * `maxTextResponseLength` let a test swap in a fast sleep or fixed clock,
 * shrink the retry budget, or shrink the size ceiling, instead of waiting
 * out a real backoff or generating a multi-megabyte fixture), others
 * (`accept`, `responseType`) are needed in production too, for a non-JSON
 * endpoint like the PR diff fetch.
 */
export interface GithubRequestOptions {
  /** Overrides {@link MAX_RATE_LIMIT_RETRIES}. */
  readonly maxRateLimitRetries?: number;
  /** Overrides the real `setTimeout`-based wait — test-only. */
  readonly sleepFn?: (ms: number) => Promise<void>;
  /** Overrides `Date.now()` for deterministic reset-time tests. */
  readonly nowFn?: () => number;
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
  /**
   * Overrides {@link MAX_TEXT_RESPONSE_LENGTH} — test-only; only applies
   * when `responseType` is `"text"`.
   */
  readonly maxTextResponseLength?: number;
}

/**
 * Hard ceiling on a `responseType: "text"` response (security-reviewer
 * finding, F1-S9 slice 3b-i, issue #12, PR #72 review, LOW — cheap to
 * close even though the severity is low: GitHub's own server-side caps
 * and this running in ephemeral CI both already bound the worst case).
 * Without a ceiling here, an unusually large diff forces `response.text()`
 * to buffer the WHOLE body into memory, and
 * `spec-grounding-runner-logic.mts`'s `neutralizeDiffDelimiterBreakout`
 * then runs a full-length scan over it BEFORE `truncateToByteBudget` ever
 * gets a chance to bound the work — the truncation happening AFTER the
 * scan (not before) is itself correct (truncating first could cut mid-
 * breakout-attempt and miss it), so the fix is a ceiling on the INPUT
 * size here, not a reorder downstream.
 *
 * ENFORCED IN TWO LAYERS (Codex finding, PR #72 review round 4 — a real
 * gap in the first version of this cap: checking `rawText.length` AFTER
 * `response.text()` had already fully buffered the body meant the
 * documented "memory bound" was not actually bounding memory at all, only
 * bounding what the CALLER received back):
 *
 * 1. `githubRequest` reads the response's `Content-Length` header (a
 *    genuine, GitHub-supplied byte count on these REST endpoints, never
 *    attacker-influenced content this module is parsing) and rejects the
 *    request BEFORE ever calling `response.text()` if that header already
 *    exceeds this ceiling — the body is never buffered at all in the
 *    common case, which is what actually makes the bound real.
 * 2. If `Content-Length` is absent (chunked transfer encoding is
 *    possible, if unlikely, on these endpoints) the length is still
 *    checked and truncated AFTER `response.text()`, as before — a
 *    weaker, buffer-then-check fallback (does not itself prevent an
 *    OOM against a truly pathological, header-less response; a full
 *    streaming read stopped at this ceiling would close that residual
 *    gap too, but is not required given the already-small blast radius
 *    this finding is LOW severity for).
 *
 * A generous multiple of `spec-grounding-runner-logic.mts`'s own
 * `MAX_PR_DIFF_BYTES` (200KiB) — comfortably above any diff that cap will
 * ever let through unflagged, comfortably below a pathological response.
 */
export const MAX_TEXT_RESPONSE_LENGTH = 2_000_000;

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
 * Retries a rate-limited response (see {@link decideRateLimitResponse}) with
 * bounded waits, up to
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
 * @returns The parsed JSON response (or raw text, with `responseType:
 *   "text"`, capped at {@link MAX_TEXT_RESPONSE_LENGTH} UTF-16 code
 *   units), or `undefined` for a 204.
 * @throws A {@link GithubApiError} (carrying the response's status code)
 *   if the response status is not ok (2xx) and either isn't rate
 *   limiting, the server's requested wait exceeds
 *   {@link MAX_RETRY_AFTER_SECONDS},
 *   or the retry budget is exhausted. Also throws a plain `Error` (not a
 *   `GithubApiError` — this is a client-side rejection, not an HTTP
 *   response) for a `responseType: "text"` call whose response declares
 *   a `Content-Length` exceeding {@link MAX_TEXT_RESPONSE_LENGTH}, BEFORE
 *   the body is ever read into memory.
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
  const nowFn = options?.nowFn ?? Date.now;
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
    const rateLimitDecision = decideRateLimitResponse(
      response.status,
      retryAfterHeader,
      response.headers.get("x-ratelimit-remaining"),
      response.headers.get("x-ratelimit-reset"),
      nowFn(),
      attempt,
    );
    if (
      rateLimitDecision.kind === "retry" &&
      attempt < maxRetries
    ) {
      console.warn(
        `GitHub API ${method} ${path} rate-limited (status ${response.status}); ` +
          `retrying in ${rateLimitDecision.waitMs}ms from ${rateLimitDecision.source} ` +
          `(attempt ${attempt + 1}/${maxRetries})`,
      );
      await sleepFn(rateLimitDecision.waitMs);
      continue;
    }

    if (rateLimitDecision.kind === "give-up") {
      console.warn(
        `GitHub API ${method} ${path} rate-limited (status ${response.status}); ` +
          `${rateLimitDecision.source} requires ${rateLimitDecision.waitMs}ms, exceeding ` +
          `the ${MAX_RETRY_AFTER_SECONDS}s cap — giving up rather than retrying early.`,
      );
    }

    if (!response.ok) {
      // The .catch() fallback only runs if response.text() itself throws
      // (e.g. a corrupted/already-consumed stream) — not meaningfully
      // triggerable against a mocked Response in tests, kept as a defensive
      // fallback so a real occurrence still produces a readable error.
      const text = await response.text().catch(() => "<unreadable body>");
      throw new GithubApiError(method, path, response.status, text);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    if (responseType === "text") {
      const maxLength = options?.maxTextResponseLength ?? MAX_TEXT_RESPONSE_LENGTH;
      // Layer 1: reject BEFORE ever buffering the body, using GitHub's own
      // Content-Length header — see MAX_TEXT_RESPONSE_LENGTH's own
      // docstring for why checking only AFTER `response.text()` (layer 2,
      // below) does not actually bound memory use at all.
      const contentLengthHeader = response.headers.get("content-length");
      if (contentLengthHeader !== null) {
        const contentLength = Number(contentLengthHeader);
        if (Number.isFinite(contentLength) && contentLength > maxLength) {
          throw new Error(
            `GitHub API ${method} ${path} response declares Content-Length ` +
              `${contentLength}, exceeding the ${maxLength}-character text-response ` +
              "cap — rejected before buffering the body into memory.",
          );
        }
      }
      // Layer 2: a weaker buffer-then-check fallback for the rare case
      // where Content-Length was absent (chunked transfer encoding).
      const rawText = await response.text();
      return (rawText.length > maxLength ? rawText.slice(0, maxLength) : rawText) as T;
    }
    return (await response.json()) as T;
  }
}
