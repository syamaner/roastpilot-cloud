import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearStaleInlineBlockerComments,
  InlineBlockerCleanupError,
  reconcileObsoleteInlineBlockerComments,
  findExistingInlineCommentId,
  findExistingInlineComments,
  postInlineCommentPlan,
  upsertInlineComment,
} from "../../scripts/factory/publish-spec-grounding-inline-comment-io.mts";
import {
  criterionBlockerCommentMarker,
  CRITERION_BLOCKERS_AGGREGATE_COMMENT_MARKER,
  DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER,
  inlineBlockerGenerationMarker,
  unreviewedClosingIssueCommentMarker,
  UNREVIEWED_ISSUES_AGGREGATE_COMMENT_MARKER,
} from "../../scripts/factory/publish-spec-grounding-blocker-logic.mts";
import type { BlockerCommentPlan } from "../../scripts/factory/publish-spec-grounding-blocker-logic.mts";
import type { ExistingComment } from "../../scripts/factory/publish-spec-grounding-verdict-logic.mts";

/**
 * Direct unit tests for the inline blocker comment I/O module,
 * independent of the privileged entrypoint that will consume it (slice
 * 3b-iii-d4's own wiring, not yet built) — same mockFetch harness as
 * `publish-spec-grounding-comment-io.test.ts`'s own precedent.
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

const TRUSTED_HEAD_SHA = "trusted-head";
const REVIEWED_BASE_SHA = "reviewed-base";

function prSnapshotResponse(
  body: string,
  overrides: { readonly headSha?: string; readonly baseSha?: string } = {},
): Response {
  return jsonResponse({
    body,
    head: { sha: overrides.headSha ?? TRUSTED_HEAD_SHA },
    base: { sha: overrides.baseSha ?? REVIEWED_BASE_SHA },
  });
}

function errorResponse(status: number, body = "error"): Response {
  return new Response(body, { status, headers: { "content-type": "text/plain" } });
}

function plan(overrides: Partial<BlockerCommentPlan> = {}): BlockerCommentPlan {
  return {
    path: "scripts/factory/foo.mts",
    line: 5,
    body: "**Blocking: unmet criterion**",
    marker: criterionBlockerCommentMarker("12:0"),
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("findExistingInlineComments", () => {
  it("returns every comment on the PR, paginated", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      body: `comment ${i}`,
      user: { type: "User", login: "someone" },
    }));
    const page2 = [{ id: 999, body: "last one", user: { type: "Bot", login: "github-actions[bot]" } }];
    const { fetchMock } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () => jsonResponse(page1),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=2": () => jsonResponse(page2),
    });
    vi.stubGlobal("fetch", fetchMock);

    const all = await findExistingInlineComments("token", "o", "r", 5);
    expect(all).toHaveLength(101);
    expect(all[100]).toEqual({ id: 999, body: "last one", authorType: "Bot", authorLogin: "github-actions[bot]" });
  });

  it("stops after the last (partial) page", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([{ id: 1, body: "x", user: { type: "User", login: "someone" } }]),
    });
    vi.stubGlobal("fetch", fetchMock);

    await findExistingInlineComments("token", "o", "r", 5);
    expect(calls.some((c) => c.url.includes("page=2"))).toBe(false);
  });

  it("returns an empty array when the PR has no inline comments at all", async () => {
    const { fetchMock } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () => jsonResponse([]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const all = await findExistingInlineComments("token", "o", "r", 5);
    expect(all).toEqual([]);
  });

  it("warns and stops after MAX_COMMENT_PAGES full pages, rather than looping unboundedly", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      body: "x",
      user: { type: "User", login: "someone" },
    }));
    const fetchMock = vi.fn(async () => jsonResponse(fullPage));
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const all = await findExistingInlineComments("token", "o", "r", 5);

    expect(all).toHaveLength(5000);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringMatching(/scanned 50 pages/i));
    warnSpy.mockRestore();
  });
});

describe("findExistingInlineCommentId", () => {
  it("matches by bot identity AND structural marker line", () => {
    const marker = criterionBlockerCommentMarker("12:0");
    const existing: readonly ExistingComment[] = [
      { id: 42, body: `some body\n${marker}`, authorType: "Bot", authorLogin: "github-actions[bot]" },
    ];
    expect(findExistingInlineCommentId(existing, plan({ marker }))).toBe(42);
  });

  it("does not match a different bot's comment carrying the marker as a substring, not a standalone line", () => {
    const marker = criterionBlockerCommentMarker("12:0");
    const existing: readonly ExistingComment[] = [
      { id: 7, body: `unrelated ${marker} mid-line`, authorType: "Bot", authorLogin: "some-other-app[bot]" },
    ];
    expect(findExistingInlineCommentId(existing, plan({ marker }))).toBeNull();
  });

  it("does not match a DIFFERENT planned comment's own marker", () => {
    const existing: readonly ExistingComment[] = [
      {
        id: 1,
        body: `some body\n${criterionBlockerCommentMarker("99:0")}`,
        authorType: "Bot",
        authorLogin: "github-actions[bot]",
      },
    ];
    expect(findExistingInlineCommentId(existing, plan({ marker: criterionBlockerCommentMarker("12:0") }))).toBeNull();
  });

  it("returns null when existing is empty", () => {
    expect(findExistingInlineCommentId([], plan())).toBeNull();
  });
});

describe("upsertInlineComment", () => {
  it("POSTs a new comment, anchored to the plan's own path/line/commit_id, when none exists", async () => {
    const { fetchMock, calls } = mockFetch({
      "POST /repos/o/r/pulls/5/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await upsertInlineComment("token", "o", "r", 5, "abc123", [], plan());

    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({
      body: "**Blocking: unmet criterion**",
      commit_id: "abc123",
      path: "scripts/factory/foo.mts",
      line: 5,
      side: "RIGHT",
    });
  });

  it("PATCHes the existing comment (body only, no path/line/commit_id) when one is found", async () => {
    const marker = criterionBlockerCommentMarker("12:0");
    const existing: readonly ExistingComment[] = [
      { id: 88, body: `prior\n${marker}`, authorType: "Bot", authorLogin: "github-actions[bot]" },
    ];
    const { fetchMock, calls } = mockFetch({
      "PATCH /repos/o/r/pulls/comments/88": () => jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await upsertInlineComment("token", "o", "r", 5, "abc123", existing, plan({ marker }));

    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.body).toEqual({ body: "**Blocking: unmet criterion**" });
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });
});

describe("postInlineCommentPlan -- the 422 probe-then-degrade", () => {
  it("returns ok:true immediately for an empty plan, without any fetch call at all", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await postInlineCommentPlan("token", "o", "r", 5, "abc123", []);
    expect(result.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts every comment in order when all succeed", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/o/r/pulls/5/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await postInlineCommentPlan("token", "o", "r", 5, "abc123", [
      plan({ marker: criterionBlockerCommentMarker("12:0"), body: "first" }),
      plan({ marker: criterionBlockerCommentMarker("12:1"), body: "second" }),
    ]);

    expect(result.ok).toBe(true);
    // F1-S9 slice 90.6a, issue #90's own #378: every marker this call
    // actually posted, in plan order. Both entries here are fresh
    // CREATEs, so createdMarkers equals postedMarkers exactly (PR #99
    // review, Codex, cid 3627282617 -- see the sibling PATCH-based tests
    // below for the case where they diverge).
    expect(result).toEqual({
      ok: true,
      postedMarkers: [criterionBlockerCommentMarker("12:0"), criterionBlockerCommentMarker("12:1")],
      createdMarkers: [criterionBlockerCommentMarker("12:0"), criterionBlockerCommentMarker("12:1")],
    });
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect((posts[0]?.body as { body: string }).body).toBe("first");
    expect((posts[1]?.body as { body: string }).body).toBe("second");
  });

  it("returns EMPTY postedMarkers and createdMarkers for the trivial empty-plan case (F1-S9 slice 90.6a, issue #90's own #378)", async () => {
    const result = await postInlineCommentPlan("token", "o", "r", 5, "abc123", []);
    expect(result).toEqual({ ok: true, postedMarkers: [], createdMarkers: [] });
  });

  it("abandons the whole plan (never attempts comment 2+) when the FIRST comment 422s -- postedMarkers and createdMarkers are BOTH EMPTY, since nothing succeeded before the rejection", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/o/r/pulls/5/comments": () => errorResponse(422, "Unprocessable Entity"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await postInlineCommentPlan("token", "o", "r", 5, "abc123", [
      plan({ marker: criterionBlockerCommentMarker("12:0"), body: "first" }),
      plan({ marker: criterionBlockerCommentMarker("12:1"), body: "second" }),
    ]);

    expect(result.ok).toBe(false);
    // The discriminated reason (PR #87 review round 4, Codex, P1), not
    // just a bare boolean -- the caller's own summary wording branches on
    // it. postedMarkers/createdMarkers (F1-S9 slice 90.6a, #378) are both
    // empty here -- the very first entry is the one that 422'd, so
    // nothing posted before it.
    expect(result).toEqual({ ok: false, reason: "anchor-rejected-422", postedMarkers: [], createdMarkers: [] });
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });


  it("propagates a NON-422 failure on the first comment as a genuine error, not a degrade", async () => {
    const { fetchMock } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/o/r/pulls/5/comments": () => errorResponse(403, "forbidden"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      postInlineCommentPlan("token", "o", "r", 5, "abc123", [plan()]),
    ).rejects.toThrow(/403/);
  });

  it("propagates a 422 on a NON-first comment as a genuine error, not a degrade -- only the first comment's own 422 is diagnostic of the shared anchor", async () => {
    let postCount = 0;
    const { fetchMock } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/o/r/pulls/5/comments": () => {
        postCount += 1;
        return postCount === 1 ? jsonResponse({ id: 1 }, 201) : errorResponse(422, "unexpected");
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      postInlineCommentPlan("token", "o", "r", 5, "abc123", [
        plan({ marker: criterionBlockerCommentMarker("12:0") }),
        plan({ marker: criterionBlockerCommentMarker("12:1") }),
      ]),
    ).rejects.toThrow(/422/);
  });

  it("probes the FIRST actual CREATE (POST), not literal plan index 0 -- when entries 0 and 1 both match existing comments and PATCH, entry 2's own POST is the diagnostic one, and postedMarkers accumulates BOTH successful PATCHes before the degrade, but createdMarkers stays EMPTY (F1-S9 slice 90.6a, issue #90's own #378; postedMarkers/createdMarkers distinction PR #99 review, Codex, cid 3627282617, P2 -- proves createdMarkers is PROVABLY EMPTY whenever this function degrades: a PATCH never touches firstCreateSucceeded, so nothing here counts as a fresh create)", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 88,
            body: `prior\n${criterionBlockerCommentMarker("12:0")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
          {
            id: 89,
            body: `prior\n${criterionBlockerCommentMarker("12:1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "PATCH /repos/o/r/pulls/comments/88": () => jsonResponse({}),
      "PATCH /repos/o/r/pulls/comments/89": () => jsonResponse({}),
      "POST /repos/o/r/pulls/5/comments": () => errorResponse(422, "Unprocessable Entity"),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await postInlineCommentPlan("token", "o", "r", 5, "abc123", [
      plan({ marker: criterionBlockerCommentMarker("12:0"), body: "update 1" }),
      plan({ marker: criterionBlockerCommentMarker("12:1"), body: "update 2" }),
      plan({ marker: criterionBlockerCommentMarker("12:2"), body: "create" }),
      plan({ marker: criterionBlockerCommentMarker("12:3"), body: "never attempted" }),
    ]);

    expect(result.ok).toBe(false);
    // Entries 0 and 1's own PATCHes succeeded (never a degrade signal at
    // all -- a PATCH never even reaches the probe check); entry 2's own
    // POST is the first genuine create attempt, and its 422 correctly
    // degrades the whole plan; entry 3 is never attempted. postedMarkers
    // (F1-S9 slice 90.6a, #378) reports BOTH already-live PATCHed
    // comments, in plan order -- the caller needs this to know those two
    // already have real inline threads, even though this run's own
    // overall posting degraded.
    expect(result).toEqual({
      ok: false,
      reason: "anchor-rejected-422",
      postedMarkers: [criterionBlockerCommentMarker("12:0"), criterionBlockerCommentMarker("12:1")],
      // Both successes were PATCHes, never a fresh CREATE -- createdMarkers
      // is EMPTY, not the two PATCHed markers.
      createdMarkers: [],
    });
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("on a FULLY successful mixed plan, createdMarkers is the SUBSET of postedMarkers that were fresh CREATEs -- PATCHes stay out of createdMarkers even when everything succeeds (F1-S9 slice 90.6a, issue #90's own #378, PR #99 review, Codex, cid 3627282617, P2)", async () => {
    const { fetchMock } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 88,
            body: `prior\n${criterionBlockerCommentMarker("12:0")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "PATCH /repos/o/r/pulls/comments/88": () => jsonResponse({}),
      "POST /repos/o/r/pulls/5/comments": () => jsonResponse({ id: 2 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await postInlineCommentPlan("token", "o", "r", 5, "abc123", [
      plan({ marker: criterionBlockerCommentMarker("12:0"), body: "update" }),
      plan({ marker: criterionBlockerCommentMarker("12:1"), body: "create" }),
    ]);

    expect(result).toEqual({
      ok: true,
      postedMarkers: [criterionBlockerCommentMarker("12:0"), criterionBlockerCommentMarker("12:1")],
      createdMarkers: [criterionBlockerCommentMarker("12:1")],
    });
  });

  it("propagates a PATCH's own 422 as a genuine error, never as a degrade signal -- a PATCH never re-validates the anchor at all", async () => {
    const { fetchMock } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 88,
            body: `prior\n${criterionBlockerCommentMarker("12:0")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "PATCH /repos/o/r/pulls/comments/88": () => errorResponse(422, "unexpected"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      postInlineCommentPlan("token", "o", "r", 5, "abc123", [plan({ marker: criterionBlockerCommentMarker("12:0") })]),
    ).rejects.toThrow(/422/);
  });

  it("fetches the existing-comments list only ONCE per run, reused for every planned comment's own match", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () => jsonResponse([]),
      "POST /repos/o/r/pulls/5/comments": () => jsonResponse({ id: 1 }, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await postInlineCommentPlan("token", "o", "r", 5, "abc123", [
      plan({ marker: criterionBlockerCommentMarker("12:0") }),
      plan({ marker: criterionBlockerCommentMarker("12:1") }),
      plan({ marker: criterionBlockerCommentMarker("12:2") }),
    ]);

    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
  });
});

describe("clearStaleInlineBlockerComments (PR #86 review, Codex, P2)", () => {
  const alwaysSafe = async (): Promise<boolean> => true;

  it("deletes every prior inline comment carrying any one of the five blocker markers, ignoring non-blocker comments", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body:
              `stale criterion blocker\n${criterionBlockerCommentMarker("12:0")}\n` +
              inlineBlockerGenerationMarker("1"),
            user: { type: "Bot", login: "github-actions[bot]" },
          },
          {
            id: 2,
            body:
              `stale diff-truncated blocker\n${DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER}\n` +
              inlineBlockerGenerationMarker("2"),
            user: { type: "Bot", login: "github-actions[bot]" },
          },
          {
            id: 3,
            body: "an unrelated human review comment",
            user: { type: "User", login: "someone" },
          },
        ]),
      "DELETE /repos/o/r/pulls/comments/1": () => new Response(null, { status: 204 }),
      "DELETE /repos/o/r/pulls/comments/2": () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await clearStaleInlineBlockerComments("token", "o", "r", 5, 2, alwaysSafe);

    expect(result).toEqual({ ok: true, deletedCount: 2 });
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/comments/1"))).toBe(true);
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/comments/2"))).toBe(true);
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/comments/3"))).toBe(false);
  });

  it("returns 0 and deletes nothing when there are no prior blocker comments at all", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () => jsonResponse([]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await clearStaleInlineBlockerComments("token", "o", "r", 5, 2, alwaysSafe);

    expect(result).toEqual({ ok: true, deletedCount: 0 });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("tolerates a 404 on an individual DELETE as a benign no-op (a human already resolved/deleted that thread) and still deletes the rest", async () => {
    const { fetchMock } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body: `stale\n${criterionBlockerCommentMarker("12:0")}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
          {
            id: 2,
            body: `stale\n${criterionBlockerCommentMarker("12:1")}\n${inlineBlockerGenerationMarker("2")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "DELETE /repos/o/r/pulls/comments/1": () => errorResponse(404, "Not Found"),
      "DELETE /repos/o/r/pulls/comments/2": () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await clearStaleInlineBlockerComments("token", "o", "r", 5, 2, alwaysSafe);

    // Only the genuinely-deleted one counts -- the 404'd one was already
    // gone, tolerated as a no-op, not counted as a delete this run made.
    expect(result).toEqual({ ok: true, deletedCount: 1 });
  });

  it("propagates a genuine (non-404) DELETE failure rather than silently swallowing it", async () => {
    const { fetchMock } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body: `stale\n${criterionBlockerCommentMarker("12:0")}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "DELETE /repos/o/r/pulls/comments/1": () => errorResponse(403, "Forbidden"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(clearStaleInlineBlockerComments("token", "o", "r", 5, 2, alwaysSafe)).rejects.toThrow(/403/);
  });

  it("retains newer, missing, and malformed generations while deleting only current-or-older bot-owned blockers", async () => {
    const marker = criterionBlockerCommentMarker("12:0");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body: `older\n${marker}\n${inlineBlockerGenerationMarker("4")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
          {
            id: 2,
            body: `current\n${marker}\n${inlineBlockerGenerationMarker("5")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
          {
            id: 3,
            body: `newer\n${marker}\n${inlineBlockerGenerationMarker("6")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
          {
            id: 4,
            body: `legacy without generation\n${marker}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
          {
            id: 5,
            body:
              `malformed generation\n${marker}\n` +
              "<!-- roastpilot-factory:spec-grounding-blocker:generation:not-a-number:do-not-edit -->",
            user: { type: "Bot", login: "github-actions[bot]" },
          },
          {
            id: 6,
            body: `generation only\n${inlineBlockerGenerationMarker("4")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
          {
            id: 7,
            body: `wrong bot\n${marker}\n${inlineBlockerGenerationMarker("4")}`,
            user: { type: "Bot", login: "some-other-bot" },
          },
        ]),
      "DELETE /repos/o/r/pulls/comments/1": () => new Response(null, { status: 204 }),
      "DELETE /repos/o/r/pulls/comments/2": () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await clearStaleInlineBlockerComments("token", "o", "r", 5, 5, alwaysSafe);

    expect(result).toEqual({ ok: true, deletedCount: 2 });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      expect.stringMatching(/comments\/1$/),
      expect.stringMatching(/comments\/2$/),
    ]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid current generation %s before reading or deleting comments",
    async (currentGeneration) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        clearStaleInlineBlockerComments("token", "o", "r", 5, currentGeneration, alwaysSafe),
      ).rejects.toThrow(/positive safe integer/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("stops before the first DELETE when the destructive-boundary recheck detects drift after pagination", async () => {
    const marker = criterionBlockerCommentMarker("12:0");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body: `stale\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await clearStaleInlineBlockerComments("token", "o", "r", 5, 2, async () => false);

    expect(result).toEqual({ ok: false, deletedCount: 0 });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("reports partial progress and stops before a subsequent DELETE when state drifts between candidates", async () => {
    const marker = criterionBlockerCommentMarker("12:0");
    let preDeleteChecks = 0;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse(
          [1, 2].map((id) => ({
            id,
            body: `stale ${id}\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          })),
        ),
      "DELETE /repos/o/r/pulls/comments/1": () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await clearStaleInlineBlockerComments("token", "o", "r", 5, 2, async () => {
      preDeleteChecks += 1;
      return preDeleteChecks === 1;
    });

    expect(result).toEqual({ ok: false, deletedCount: 1 });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      expect.stringMatching(/comments\/1$/),
    ]);
  });

  it("preserves partial progress when a subsequent destructive-boundary recheck fails", async () => {
    const marker = criterionBlockerCommentMarker("12:0");
    let preDeleteChecks = 0;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse(
          [1, 2].map((id) => ({
            id,
            body: `stale ${id}\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          })),
        ),
      "DELETE /repos/o/r/pulls/comments/1": () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = clearStaleInlineBlockerComments("token", "o", "r", 5, 2, async () => {
      preDeleteChecks += 1;
      if (preDeleteChecks === 2) {
        throw new Error("recheck unavailable");
      }
      return true;
    });

    await expect(promise).rejects.toMatchObject({
      name: "InlineBlockerCleanupError",
      message: "recheck unavailable",
      deletedCount: 1,
    });
    await expect(promise).rejects.toBeInstanceOf(InlineBlockerCleanupError);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      expect.stringMatching(/comments\/1$/),
    ]);
  });

  it("preserves partial progress when a subsequent DELETE fails with a non-404 response", async () => {
    const marker = criterionBlockerCommentMarker("12:0");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse(
          [1, 2].map((id) => ({
            id,
            body: `stale ${id}\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          })),
        ),
      "DELETE /repos/o/r/pulls/comments/1": () => new Response(null, { status: 204 }),
      "DELETE /repos/o/r/pulls/comments/2": () => new Response("forbidden", { status: 403 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const promise = clearStaleInlineBlockerComments("token", "o", "r", 5, 2, alwaysSafe);

    await expect(promise).rejects.toMatchObject({
      name: "InlineBlockerCleanupError",
      message: expect.stringMatching(/403/),
      deletedCount: 1,
    });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      expect.stringMatching(/comments\/1$/),
      expect.stringMatching(/comments\/2$/),
    ]);
  });

  it("does not retry a rate-limited DELETE without another destructive-boundary recheck", async () => {
    const marker = criterionBlockerCommentMarker("12:0");
    let preDeleteChecks = 0;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body: `stale\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "DELETE /repos/o/r/pulls/comments/1": () =>
        new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      clearStaleInlineBlockerComments("token", "o", "r", 5, 2, async () => {
        preDeleteChecks += 1;
        return true;
      }),
    ).rejects.toMatchObject({
      name: "InlineBlockerCleanupError",
      deletedCount: 0,
    });
    expect(preDeleteChecks).toBe(1);
    expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
  });
});

describe("reconcileObsoleteInlineBlockerComments (F1-S9 slices 90.4 and 90.6a-3)", () => {
  it("deletes a criterion blocker's own comment for an issue that is NO LONGER closing-referenced at all (de-referenced)", async () => {
    const marker = criterionBlockerCommentMarker("12:0");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse(""),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body: `de-referenced\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "DELETE /repos/o/r/pulls/comments/1": () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments("token", "o", "r", 5, TRUSTED_HEAD_SHA, REVIEWED_BASE_SHA, new Set(), new Set(), true, 1);

    expect(result).toEqual({ ok: true, deletedCount: 1 });
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/comments/1"))).toBe(true);
  });

  it("deletes an unreviewed-closing-issue blocker's own comment for an issue that is NO LONGER closing-referenced (issue-level marker, not just criterion-level)", async () => {
    const marker = unreviewedClosingIssueCommentMarker(99);
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse(""),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body: `de-referenced\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "DELETE /repos/o/r/pulls/comments/1": () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments("token", "o", "r", 5, TRUSTED_HEAD_SHA, REVIEWED_BASE_SHA, new Set(), new Set(), true, 1);

    expect(result).toEqual({ ok: true, deletedCount: 1 });
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/comments/1"))).toBe(true);
  });

  it("deletes a DOWNGRADED issue's own comment (still referenced in the body, but no longer with a closing keyword) -- covered by the SAME 'not in currentlyClosingIssueNumbers' test as an outright de-reference", async () => {
    const marker = criterionBlockerCommentMarker("34:0");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse("Closes #12"),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body: `downgraded to Refs\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "DELETE /repos/o/r/pulls/comments/1": () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    // #34 is not in the current closing set (it's still referenced, just
    // as a non-closing keyword) -- this function has no visibility into
    // WHY an issue is absent from the set, only that it is.
    const result = await reconcileObsoleteInlineBlockerComments("token", "o", "r", 5, TRUSTED_HEAD_SHA, REVIEWED_BASE_SHA, new Set([12]), new Set([12]), true, 1);

    expect(result).toEqual({ ok: true, deletedCount: 1 });
    expect(calls.some((c) => c.method === "DELETE" && c.url.endsWith("/comments/1"))).toBe(true);
  });

  it("KEEPS a comment whose own issue IS STILL closing-referenced, even though the underlying criterion is now satisfied -- the operator's #801 anti-gaming ruling: a verdict-satisfied blocker for a live closing obligation is never auto-cleared, a human resolves it", async () => {
    const marker = criterionBlockerCommentMarker("12:0");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse("Closes #12"),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body: `now satisfied, but #12 is STILL a closing reference\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments("token", "o", "r", 5, TRUSTED_HEAD_SHA, REVIEWED_BASE_SHA, new Set([12]), new Set([12]), true, 1);

    expect(result).toEqual({ ok: true, deletedCount: 0 });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it.each([
    ["the criteria-blockers aggregate marker", CRITERION_BLOCKERS_AGGREGATE_COMMENT_MARKER],
    ["the unreviewed-issues aggregate marker", UNREVIEWED_ISSUES_AGGREGATE_COMMENT_MARKER],
  ])(
    "NEVER deletes %s, even when none of its own (unencoded) issues remain closing-referenced -- no per-issue number to test membership for at all, conservative by construction",
    async (_label, aggregateMarker) => {
      const { fetchMock, calls } = mockFetch({
        "GET /repos/o/r/pulls/5": () => prSnapshotResponse(""),
        "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
          jsonResponse([
            {
              id: 1,
              body: `an overflow/whole-run comment\n${aggregateMarker}\n${inlineBlockerGenerationMarker("1")}`,
              user: { type: "Bot", login: "github-actions[bot]" },
            },
          ]),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await reconcileObsoleteInlineBlockerComments("token", "o", "r", 5, TRUSTED_HEAD_SHA, REVIEWED_BASE_SHA, new Set(), new Set(), false, 1);

      expect(result).toEqual({ ok: true, deletedCount: 0 });
      expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    },
  );

  it("deletes the exact diff-truncation aggregate when no closing references remain, its current-state applicability is false, and its generation is not newer", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse("Refs #12"),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body:
              `obsolete whole-run blocker\n${DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER}\n` +
              inlineBlockerGenerationMarker("7"),
            user: { type: "Bot", login: "github-actions[bot]" },
          },
          {
            id: 2,
            body: `obsolete individual\n${criterionBlockerCommentMarker("34:0")}\n${inlineBlockerGenerationMarker("7")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "DELETE /repos/o/r/pulls/comments/1": () => new Response(null, { status: 204 }),
      "DELETE /repos/o/r/pulls/comments/2": () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments(
      "token",
      "o",
      "r",
      5,
      TRUSTED_HEAD_SHA,
      REVIEWED_BASE_SHA,
      new Set(),
      new Set([12]),
      false,
      7,
    );

    expect(result).toEqual({ ok: true, deletedCount: 2 });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      expect.stringMatching(/comments\/1$/),
      expect.stringMatching(/comments\/2$/),
    ]);
  });

  it("keeps a diff-truncation aggregate when a closing reference remains even if this run's current predicate is false, preserving #77 across unobservable linked-issue edits", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse("Closes #12 and Refs #13"),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body:
              `prior blocker may cover criteria edited after this run\n${DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER}\n` +
              inlineBlockerGenerationMarker("1"),
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments(
      "token",
      "o",
      "r",
      5,
      TRUSTED_HEAD_SHA,
      REVIEWED_BASE_SHA,
      new Set([12]),
      new Set([12, 13]),
      false,
      1,
    );

    expect(result).toEqual({ ok: true, deletedCount: 0 });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("keeps the diff-truncation aggregate while its current-state applicability remains true", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse("Closes #12"),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body:
              `still applicable\n${DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER}\n` +
              inlineBlockerGenerationMarker("1"),
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments(
      "token",
      "o",
      "r",
      5,
      TRUSTED_HEAD_SHA,
      REVIEWED_BASE_SHA,
      new Set([12]),
      new Set([12]),
      true,
      1,
    );

    expect(result).toEqual({ ok: true, deletedCount: 0 });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("keeps an obsolete diff-truncation aggregate from a newer generation", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse("Refs #12"),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body:
              `newer aggregate\n${DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER}\n` +
              inlineBlockerGenerationMarker("8"),
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments(
      "token",
      "o",
      "r",
      5,
      TRUSTED_HEAD_SHA,
      REVIEWED_BASE_SHA,
      new Set(),
      new Set([12]),
      false,
      7,
    );

    expect(result).toEqual({ ok: true, deletedCount: 0 });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("does not treat a non-standalone look-alike as the diff-truncation aggregate marker", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse(""),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body:
              `prefix ${DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER} suffix\n` +
              inlineBlockerGenerationMarker("1"),
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments(
      "token",
      "o",
      "r",
      5,
      TRUSTED_HEAD_SHA,
      REVIEWED_BASE_SHA,
      new Set(),
      new Set(),
      false,
      1,
    );

    expect(result).toEqual({ ok: true, deletedCount: 0 });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("fails closed before deleting an obsolete aggregate when the linked-reference snapshot changed during pagination", async () => {
    const { fetchMock, calls } = mockFetch({
      // The caller saw Refs #12 and computed aggregate applicability=false;
      // the fresh pre-delete fetch sees Closes #12 instead.
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse("Closes #12"),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body:
              `candidate from the stale snapshot\n${DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER}\n` +
              inlineBlockerGenerationMarker("1"),
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments(
      "token",
      "o",
      "r",
      5,
      TRUSTED_HEAD_SHA,
      REVIEWED_BASE_SHA,
      new Set(),
      new Set([12]),
      false,
      1,
    );

    expect(result).toEqual({ ok: false, reason: "linked-references-changed", deletedCount: 0 });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("re-verifies immediately before an aggregate DELETE and never deletes an earlier individual first", async () => {
    let prFetchCount = 0;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5": () => {
        prFetchCount += 1;
        return prSnapshotResponse(prFetchCount === 1 ? "Refs #12" : "Closes #12");
      },
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body: `API-ordered individual\n${criterionBlockerCommentMarker("34:0")}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
          {
            id: 2,
            body:
              `aggregate must be rechecked first\n${DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER}\n` +
              inlineBlockerGenerationMarker("1"),
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments(
      "token",
      "o",
      "r",
      5,
      TRUSTED_HEAD_SHA,
      REVIEWED_BASE_SHA,
      new Set(),
      new Set([12]),
      false,
      1,
    );

    expect(result).toEqual({ ok: false, reason: "linked-references-changed", deletedCount: 0 });
    expect(prFetchCount).toBe(2);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("reports partial duplicate-aggregate cleanup and leaves later blockers when state changes between aggregate DELETEs", async () => {
    let prFetchCount = 0;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5": () => {
        prFetchCount += 1;
        return prSnapshotResponse(prFetchCount < 3 ? "Refs #12" : "Closes #12");
      },
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body: `individual remains\n${criterionBlockerCommentMarker("34:0")}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
          ...[2, 3].map((id) => ({
            id,
            body:
              `duplicate aggregate ${id}\n${DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER}\n` +
              inlineBlockerGenerationMarker("1"),
            user: { type: "Bot", login: "github-actions[bot]" },
          })),
        ]),
      "DELETE /repos/o/r/pulls/comments/2": () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments(
      "token",
      "o",
      "r",
      5,
      TRUSTED_HEAD_SHA,
      REVIEWED_BASE_SHA,
      new Set(),
      new Set([12]),
      false,
      1,
    );

    expect(result).toEqual({ ok: false, reason: "linked-references-changed", deletedCount: 1 });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      expect.stringMatching(/pulls\/comments\/2$/),
    ]);
  });

  it("re-verifies after aggregate cleanup before deleting any obsolete individual", async () => {
    let prFetchCount = 0;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5": () => {
        prFetchCount += 1;
        return prSnapshotResponse(prFetchCount < 3 ? "Refs #12" : "Closes #12");
      },
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body: `individual remains\n${criterionBlockerCommentMarker("34:0")}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
          {
            id: 2,
            body:
              `aggregate deletes first\n${DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER}\n` +
              inlineBlockerGenerationMarker("1"),
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "DELETE /repos/o/r/pulls/comments/2": () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments(
      "token",
      "o",
      "r",
      5,
      TRUSTED_HEAD_SHA,
      REVIEWED_BASE_SHA,
      new Set(),
      new Set([12]),
      false,
      1,
    );

    expect(result).toEqual({ ok: false, reason: "linked-references-changed", deletedCount: 1 });
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.url)).toEqual([
      expect.stringMatching(/pulls\/comments\/2$/),
    ]);
  });

  it.each([
    ["head SHA", "head-sha-changed", { headSha: "moved-head" }],
    ["base SHA", "base-sha-changed", { baseSha: "moved-base" }],
  ] as const)(
    "fails closed before deleting an obsolete aggregate when the %s changes but linked references do not",
    async (_dimension, reason, overrides) => {
      const { fetchMock, calls } = mockFetch({
        "GET /repos/o/r/pulls/5": () => prSnapshotResponse("Refs #12", overrides),
        "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
          jsonResponse([
            {
              id: 1,
              body:
                `candidate from the stale identity\n${DIFF_TRUNCATED_BLOCKER_COMMENT_MARKER}\n` +
                inlineBlockerGenerationMarker("1"),
              user: { type: "Bot", login: "github-actions[bot]" },
            },
          ]),
      });
      vi.stubGlobal("fetch", fetchMock);

      const result = await reconcileObsoleteInlineBlockerComments(
        "token",
        "o",
        "r",
        5,
        TRUSTED_HEAD_SHA,
        REVIEWED_BASE_SHA,
        new Set(),
        new Set([12]),
        false,
        1,
      );

      expect(result).toEqual({ ok: false, reason, deletedCount: 0 });
      expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    },
  );

  it("never deletes a NEWER-generation comment -- an older run must never delete a newer run's own thread", async () => {
    const marker = criterionBlockerCommentMarker("12:0");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse(""),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            // Posted by a NEWER run (generation 5) for an issue THIS
            // (older, generation 1) run's own current-body read never knew about.
            body: `newer finding\n${marker}\n${inlineBlockerGenerationMarker("5")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments("token", "o", "r", 5, TRUSTED_HEAD_SHA, REVIEWED_BASE_SHA, new Set(), new Set(), true, 1);

    expect(result).toEqual({ ok: true, deletedCount: 0 });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("deletes a comment at EXACTLY this run's own generation (the boundary is inclusive, not exclusive)", async () => {
    const marker = criterionBlockerCommentMarker("12:0");
    const { fetchMock } = mockFetch({
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse(""),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body: `de-referenced\n${marker}\n${inlineBlockerGenerationMarker("7")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "DELETE /repos/o/r/pulls/comments/1": () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments("token", "o", "r", 5, TRUSTED_HEAD_SHA, REVIEWED_BASE_SHA, new Set(), new Set(), true, 7);

    expect(result).toEqual({ ok: true, deletedCount: 1 });
  });

  it("NEVER deletes a comment with a NULL/unparseable generation -- a pre-90.3 comment, or a corrupted one, fails closed by being left in place", async () => {
    const marker = criterionBlockerCommentMarker("12:0");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse(""),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            // No generation marker line at all -- a pre-90.3 comment.
            body: `de-referenced\n${marker}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments("token", "o", "r", 5, TRUSTED_HEAD_SHA, REVIEWED_BASE_SHA, new Set(), new Set(), true, 1);

    expect(result).toEqual({ ok: true, deletedCount: 0 });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("ignores a non-blocker comment (no blocker marker at all), even if bot-owned", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse(""),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          { id: 1, body: "an unrelated bot comment", user: { type: "Bot", login: "github-actions[bot]" } },
        ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments("token", "o", "r", 5, TRUSTED_HEAD_SHA, REVIEWED_BASE_SHA, new Set(), new Set(), true, 1);

    expect(result).toEqual({ ok: true, deletedCount: 0 });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("ignores a comment carrying a blocker-marker-shaped string but authored by someone else entirely (never mistaken for ours)", async () => {
    const marker = criterionBlockerCommentMarker("12:0");
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse(""),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body: `not actually ours\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "User", login: "someone" },
          },
        ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments("token", "o", "r", 5, TRUSTED_HEAD_SHA, REVIEWED_BASE_SHA, new Set(), new Set(), true, 1);

    expect(result).toEqual({ ok: true, deletedCount: 0 });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("returns 0 and deletes nothing when there are no existing comments at all", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse(""),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () => jsonResponse([]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments("token", "o", "r", 5, TRUSTED_HEAD_SHA, REVIEWED_BASE_SHA, new Set(), new Set(), true, 1);

    expect(result).toEqual({ ok: true, deletedCount: 0 });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("tolerates a 404 on an individual DELETE as a benign no-op (a human already resolved/deleted that thread) and still deletes the rest", async () => {
    const markerA = criterionBlockerCommentMarker("12:0");
    const markerB = criterionBlockerCommentMarker("12:1");
    const { fetchMock } = mockFetch({
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse(""),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body: `de-referenced\n${markerA}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
          {
            id: 2,
            body: `de-referenced\n${markerB}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "DELETE /repos/o/r/pulls/comments/1": () => errorResponse(404, "Not Found"),
      "DELETE /repos/o/r/pulls/comments/2": () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments("token", "o", "r", 5, TRUSTED_HEAD_SHA, REVIEWED_BASE_SHA, new Set(), new Set(), true, 1);

    expect(result).toEqual({ ok: true, deletedCount: 1 });
  });

  it("propagates a genuine (non-404) DELETE failure rather than silently swallowing it", async () => {
    const marker = criterionBlockerCommentMarker("12:0");
    const { fetchMock } = mockFetch({
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse(""),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body: `de-referenced\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "DELETE /repos/o/r/pulls/comments/1": () => errorResponse(403, "Forbidden"),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(reconcileObsoleteInlineBlockerComments("token", "o", "r", 5, TRUSTED_HEAD_SHA, REVIEWED_BASE_SHA, new Set(), new Set(), true, 1)).rejects.toThrow(/403/);
  });

  it("re-verifies the closing-reference set AFTER pagination, IMMEDIATELY before the first DELETE (F1-S9 slice 90.4, PR #95 review round 4, Codex, P1, cid 3625635476) -- returns ok:false and deletes NOTHING when the fresh set no longer matches the caller's own snapshot", async () => {
    const marker = criterionBlockerCommentMarker("12:0");
    const { fetchMock, calls } = mockFetch({
      // The caller's own snapshot said #12 was de-referenced (empty set),
      // but the FRESH re-fetch (this function's own, after pagination)
      // now shows #12 as closing-referenced again -- a race landed.
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse("Closes #12"),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body: `was de-referenced\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments("token", "o", "r", 5, TRUSTED_HEAD_SHA, REVIEWED_BASE_SHA, new Set(), new Set(), true, 1);

    expect(result).toEqual({ ok: false, reason: "linked-references-changed", deletedCount: 0 });
    // The comment fetch (pagination) DID happen -- the mismatch is only
    // detected AFTER it -- but no DELETE is ever attempted once detected.
    expect(calls.some((c) => c.method === "GET" && c.url.includes("/pulls/5/comments"))).toBe(true);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("re-verify detects a SAME-SIZE-but-different-element mismatch too, not just a size change", async () => {
    const marker = criterionBlockerCommentMarker("34:0");
    const { fetchMock, calls } = mockFetch({
      // Snapshot said {34} was de-referenced (so #34 is absent from the
      // caller's own set); the fresh re-fetch shows {99} instead -- same
      // SIZE (one closing reference) but a genuinely different issue.
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse("Closes #99"),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body: `was de-referenced\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    // The caller's own snapshot (empty -- #34 was de-referenced) is used
    // here; the function's own fresh re-fetch finds {99}, a mismatch.
    const result = await reconcileObsoleteInlineBlockerComments("token", "o", "r", 5, TRUSTED_HEAD_SHA, REVIEWED_BASE_SHA, new Set(), new Set(), true, 1);

    expect(result).toEqual({ ok: false, reason: "linked-references-changed", deletedCount: 0 });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("does NOT spuriously report a mismatch when the fresh MULTI-ELEMENT set matches the snapshot exactly (order-independent set equality, not just a size check)", async () => {
    const marker = criterionBlockerCommentMarker("99:0");
    const { fetchMock } = mockFetch({
      // #12 and #56 are both STILL closing-referenced -- the caller's
      // own snapshot below is the identical {12, 56} set. #99 is a
      // SEPARATE, genuinely de-referenced issue this test proves still
      // gets deleted once the (matching) multi-element re-verify passes.
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse("Closes #12 and closes #56"),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body: `de-referenced\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "DELETE /repos/o/r/pulls/comments/1": () => new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments("token", "o", "r", 5, TRUSTED_HEAD_SHA, REVIEWED_BASE_SHA, new Set([12, 56]), new Set([12, 56]), true, 1);

    expect(result).toEqual({ ok: true, deletedCount: 1 });
  });

  it("FAILS CLOSED on an ANY-KIND-ONLY mismatch, even when the closing set is UNCHANGED (PR #96 review round 2, Codex, cid 3626169271) -- a plain, non-closing reference removed entirely between the snapshot and this re-verify would otherwise slip past a closing-only re-check", async () => {
    const marker = criterionBlockerCommentMarker("12:0");
    const { fetchMock, calls } = mockFetch({
      // #34's own "Refs #34" reference has been removed entirely since
      // the snapshot -- the CLOSING set is unchanged (empty in both), but
      // the ANY-KIND set shrank from {34} to {} -- a real change a
      // closing-only re-verify would never detect.
      "GET /repos/o/r/pulls/5": () => prSnapshotResponse(""),
      "GET /repos/o/r/pulls/5/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 1,
            body: `de-referenced\n${marker}\n${inlineBlockerGenerationMarker("1")}`,
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await reconcileObsoleteInlineBlockerComments(
      "token",
      "o",
      "r",
      5,
      TRUSTED_HEAD_SHA,
      REVIEWED_BASE_SHA,
      new Set(), // closing set: unchanged, empty both times
      new Set([34]), // any-kind snapshot: #34 was referenced (non-closing) at snapshot time
      true,
      1,
    );

    expect(result).toEqual({ ok: false, reason: "linked-references-changed", deletedCount: 0 });
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
  });
});
