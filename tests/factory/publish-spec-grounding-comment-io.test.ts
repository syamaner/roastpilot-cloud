import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearStaleSpecGroundingSummary,
  findExistingSummaryComment,
  neutralizeReasonForLog,
  publishFallback,
  upsertSummaryComment,
} from "../../scripts/factory/publish-spec-grounding-comment-io.mts";
import { SPEC_GROUNDING_SUMMARY_COMMENT_MARKER } from "../../scripts/factory/publish-spec-grounding-verdict-logic.mts";

/**
 * Direct unit tests for the comment I/O module, independent of the
 * privileged entrypoint that consumes it (`publish-spec-grounding-
 * verdict.mts`, slice d3, split from this module for AGENTS.md's
 * 400-logic-line PR-hygiene cap) — same mockFetch harness as
 * `apply-triage-verdict.test.ts`'s own precedent.
 */

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function mockFetch(
  handlers: Record<string, (call: FetchCall) => Response>,
): { fetchMock: ReturnType<typeof vi.fn>; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const call: FetchCall = { url, method, body };
    calls.push(call);
    const key = `${method} ${url.replace("https://api.github.com", "")}`;
    const handler = handlers[key];
    if (!handler) {
      throw new Error(`unexpected fetch call: ${key}`);
    }
    return handler(call);
  });
  return { fetchMock, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("findExistingSummaryComment", () => {
  it("returns null when no comment on the PR carries the marker", async () => {
    const { fetchMock } = mockFetch({
      "GET /repos/o/r/issues/5/comments?per_page=100&page=1": () =>
        jsonResponse([{ id: 1, body: "unrelated", user: { type: "User", login: "someone" } }]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const found = await findExistingSummaryComment("token", "o", "r", 5);
    expect(found).toBeNull();
  });

  it("does not crash and correctly finds no match when a comment's own user field is null (a deleted-account ghost comment) -- authorType/authorLogin fall back to null rather than throwing on the missing user object", async () => {
    const { fetchMock } = mockFetch({
      "GET /repos/o/r/issues/5/comments?per_page=100&page=1": () =>
        jsonResponse([{ id: 1, body: `unrelated\n${SPEC_GROUNDING_SUMMARY_COMMENT_MARKER}`, user: null }]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const found = await findExistingSummaryComment("token", "o", "r", 5);
    // A null user can never be authorType:"Bot" -- never mistaken for our
    // own prior comment even if its body happens to carry the marker.
    expect(found).toBeNull();
  });

  it("finds this run's own prior comment by bot identity + structural marker match", async () => {
    const { fetchMock } = mockFetch({
      "GET /repos/o/r/issues/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 42,
            body: `prior summary\n${SPEC_GROUNDING_SUMMARY_COMMENT_MARKER}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const found = await findExistingSummaryComment("token", "o", "r", 5);
    expect(found).toBe(42);
  });

  it("does not match a DIFFERENT bot's comment carrying the marker as a substring, not a standalone line", async () => {
    const { fetchMock } = mockFetch({
      "GET /repos/o/r/issues/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 7,
            body: `unrelated content embedding ${SPEC_GROUNDING_SUMMARY_COMMENT_MARKER} mid-line`,
            user: { type: "Bot", login: "some-other-app[bot]" },
          },
        ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const found = await findExistingSummaryComment("token", "o", "r", 5);
    expect(found).toBeNull();
  });

  it("paginates through every page, finding the marker on a later page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      body: `unrelated ${i}`,
      user: { type: "User", login: "someone" },
    }));
    const page2 = [
      {
        id: 999,
        body: `prior summary\n${SPEC_GROUNDING_SUMMARY_COMMENT_MARKER}`,
        user: { type: "Bot", login: "github-actions[bot]" },
      },
    ];
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/issues/5/comments?per_page=100&page=1": () => jsonResponse(page1),
      "GET /repos/o/r/issues/5/comments?per_page=100&page=2": () => jsonResponse(page2),
    });
    vi.stubGlobal("fetch", fetchMock);

    const found = await findExistingSummaryComment("token", "o", "r", 5);
    expect(found).toBe(999);
    expect(calls.some((c) => c.url.includes("page=2"))).toBe(true);
  });

  it("stops after the last (partial) page rather than requesting a nonexistent next one", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/issues/5/comments?per_page=100&page=1": () =>
        jsonResponse([{ id: 1, body: "unrelated", user: { type: "User", login: "someone" } }]),
    });
    vi.stubGlobal("fetch", fetchMock);

    await findExistingSummaryComment("token", "o", "r", 5);
    expect(calls.some((c) => c.url.includes("page=2"))).toBe(false);
  });
});

describe("upsertSummaryComment", () => {
  it("PATCHes the existing comment when one is found", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/issues/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 55,
            body: `prior\n${SPEC_GROUNDING_SUMMARY_COMMENT_MARKER}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "PATCH /repos/o/r/issues/comments/55": () => jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await upsertSummaryComment("token", "o", "r", 5, "new body");

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeDefined();
    expect((patch?.body as { body: string }).body).toBe("new body");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("POSTs a new comment when none exists yet", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/issues/5/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/o/r/issues/5/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await upsertSummaryComment("token", "o", "r", 5, "new body");

    const post = calls.find((c) => c.method === "POST");
    expect(post).toBeDefined();
    expect((post?.body as { body: string }).body).toBe("new body");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});

describe("publishFallback", () => {
  it("posts a fallback comment carrying every given reason", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/issues/5/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/o/r/issues/5/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await publishFallback("token", "o", "r", 5, ["reason one", "reason two"]);

    const post = calls.find((c) => c.method === "POST");
    const body = (post?.body as { body: string }).body;
    expect(body).toContain("reason one");
    expect(body).toContain("reason two");
    expect(body).toContain(SPEC_GROUNDING_SUMMARY_COMMENT_MARKER);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("neutralizes a workflow-command injection attempt in a reason before logging it (PR #85 review, Codex, MEDIUM) -- GitHub Actions parses ::command:: lines anywhere in stdout, so a malformed verdict's own reason could otherwise spoof an annotation on a SECOND log line", async () => {
    const { fetchMock } = mockFetch({
      "GET /repos/o/r/issues/5/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/o/r/issues/5/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await publishFallback("token", "o", "r", 5, ['unexpected key(s): "\n::error title=spoofed::message"']);

    const loggedText = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    // The reason's own embedded newline never reaches the log as a real
    // line break -- the injected "::error ...::" text stays glued onto
    // the SAME line as the reason's own leading text, and the "::" marker
    // itself is also stripped, so it could never be parsed as a workflow
    // command even if it somehow did start a line.
    expect(loggedText).not.toMatch(/\n::error/);
    expect(loggedText).not.toContain("::");
    errorSpy.mockRestore();
  });

  it("bounds the TOTAL logged reasons list, reporting the remainder as an omitted count, rather than emitting an unbounded log entry for a malformed artifact with many findings (PR #85 review round 3, Codex, MEDIUM)", async () => {
    const { fetchMock } = mockFetch({
      "GET /repos/o/r/issues/5/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/o/r/issues/5/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    // Each reason is well under the per-reason cap, but there are enough
    // of them that the TOTAL would otherwise be unbounded.
    const manyReasons = Array.from({ length: 2000 }, (_, i) => `reason number ${i}`);
    await publishFallback("token", "o", "r", 5, manyReasons);

    const loggedText = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(loggedText.length).toBeLessThan(30_000);
    expect(loggedText).toMatch(/further reason\(s\) omitted to keep this log entry bounded/);
    errorSpy.mockRestore();
  });

  it("logs the reasons BEFORE attempting the comment write, so the diagnostic survives a write failure (PR #85 review round 3, Codex, MEDIUM)", async () => {
    const { fetchMock } = mockFetch({
      "GET /repos/o/r/issues/5/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/o/r/issues/5/comments": () => {
        throw new Error("simulated transient API failure");
      },
    });
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(publishFallback("token", "o", "r", 5, ["the real reason"])).rejects.toThrow(
      "simulated transient API failure",
    );

    // The write threw, but the diagnostic still made it to the log.
    const loggedText = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(loggedText).toContain("the real reason");
    errorSpy.mockRestore();
  });
});

describe("neutralizeReasonForLog", () => {
  it("passes an already-inert single-line string through unchanged", () => {
    expect(neutralizeReasonForLog("plain reason text")).toBe("plain reason text");
  });

  it("collapses embedded newlines (and CRLF) so injected text can never start its own log line", () => {
    expect(neutralizeReasonForLog("first line\nsecond line")).toBe("first line second line");
    expect(neutralizeReasonForLog("first line\r\nsecond line")).toBe("first line second line");
  });

  it("strips the literal :: marker as defense-in-depth, even mid-line", () => {
    expect(neutralizeReasonForLog("unexpected key(s): ::add-mask::secret")).toBe(
      "unexpected key(s):  add-mask secret",
    );
  });

  it("neutralizes a full workflow-command injection attempt exported for reuse outside publishFallback -- this is the same primitive slice 3b-iii-d3 reuses on the entrypoint's own top-level catch-all, not just fallback reasons", () => {
    const attempt = 'stack trace: something failed\n::error title=spoofed::message\n::add-mask::secret';
    const neutralized = neutralizeReasonForLog(attempt);
    expect(neutralized).not.toMatch(/\n::error/);
    expect(neutralized).not.toContain("::");
  });

  it("renders an ANSI escape sequence visibly instead of letting it manipulate the terminal viewer (PR #85 review round 2, Codex, MEDIUM)", () => {
    // ESC [ 31 m is a real "set foreground red" ANSI SGR sequence.
    const neutralized = neutralizeReasonForLog("before\x1b[31mafter");
    expect(neutralized).not.toContain("\x1b");
    expect(neutralized).toContain("[U+001B]");
  });

  it("renders a bidi override character visibly instead of letting it reorder the logged text", () => {
    const neutralized = neutralizeReasonForLog("safe-looking\u202etxt.exe");
    expect(neutralized).not.toContain("\u202e");
    expect(neutralized).toContain("[U+202E]");
  });

  it("bounds an oversized reason to MAX_LOGGED_REASON_LENGTH code points with a truncation marker, rather than emitting a multi-megabyte log line", () => {
    const oversized = "x".repeat(5000);
    const neutralized = neutralizeReasonForLog(oversized);
    expect(neutralized.length).toBeLessThan(oversized.length);
    expect(neutralized.endsWith("…(truncated)")).toBe(true);
  });

  it("neutralizes and bounds an ANSI escape, a bidi override, AND a newline-based command-injection attempt together, in one oversized reason", () => {
    const attempt = `${"a".repeat(2000)}\x1b[31m\u202e\n::error title=spoofed::message`;
    const neutralized = neutralizeReasonForLog(attempt);
    expect(neutralized).not.toContain("\x1b");
    expect(neutralized).not.toContain("\u202e");
    expect(neutralized).not.toMatch(/\n::error/);
    expect(neutralized).not.toContain("::");
    expect(neutralized.endsWith("…(truncated)")).toBe(true);
  });
});

describe("clearStaleSpecGroundingSummary (PR #86 review, Codex, P2)", () => {
  it("does nothing and returns false when no prior summary comment exists", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/issues/5/comments?per_page=100&page=1": () => jsonResponse([]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const cleared = await clearStaleSpecGroundingSummary("token", "o", "r", 5);

    expect(cleared).toBe(false);
    expect(calls.some((c) => c.method === "PATCH" || c.method === "POST")).toBe(false);
  });

  it("PATCHes the prior summary/fallback comment in place with the cleared body when one exists", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/issues/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 55,
            body: `prior blockers\n${SPEC_GROUNDING_SUMMARY_COMMENT_MARKER}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "PATCH /repos/o/r/issues/comments/55": () => jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    const cleared = await clearStaleSpecGroundingSummary("token", "o", "r", 5);

    expect(cleared).toBe(true);
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeDefined();
    const body = (patch?.body as { body: string }).body;
    expect(body).toMatch(/no linked-issue acceptance criteria remain/i);
    expect(body).toContain(SPEC_GROUNDING_SUMMARY_COMMENT_MARKER);
  });
});
