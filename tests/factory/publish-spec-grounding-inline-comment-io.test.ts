import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findExistingInlineCommentId,
  findExistingInlineComments,
  postInlineCommentPlan,
  upsertInlineComment,
} from "../../scripts/factory/publish-spec-grounding-inline-comment-io.mts";
import { criterionBlockerCommentMarker } from "../../scripts/factory/publish-spec-grounding-blocker-logic.mts";
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
    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect((posts[0]?.body as { body: string }).body).toBe("first");
    expect((posts[1]?.body as { body: string }).body).toBe("second");
  });

  it("abandons the whole plan (never attempts comment 2+) when the FIRST comment 422s", async () => {
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
