import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertPostableStatus,
  boundaryTimelineEvents,
  main,
  MAX_PAGES,
  type GithubRequest,
} from "../../scripts/factory/publish-codex-verdict-status.mts";
import type { NamespacedStatusPlan } from
  "../../scripts/factory/publish-codex-verdict-status-logic.mts";

const OWNER = "syamaner";
const REPO = "roastpilot-cloud";
const REPOSITORY = `${OWNER}/${REPO}`;
const PR = 42;
const HEAD = "a".repeat(40);
const CREATED = "2026-08-08T10:00:00Z";
const AFTER = "2026-08-08T10:02:00Z";
const BOT = "chatgpt-codex-connector[bot]";
const CLEAN_BODY = `Codex Review: Didn't find any major issues\n\nReviewed commit: ${HEAD}`;

interface RequestCall {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

interface Scenario {
  readonly pull?: unknown;
  readonly timeline?: readonly unknown[];
  readonly reviews?: readonly unknown[];
  readonly pullComments?: readonly unknown[];
  readonly issueComments?: readonly unknown[];
  readonly prReactions?: readonly unknown[];
  readonly commentReactions?: Readonly<Record<number, readonly unknown[]>>;
  readonly overflowPath?: string;
  readonly throwPath?: string;
  readonly nonArrayPath?: string;
}

function pageNumber(path: string): number {
  return Number(new URL(`https://example.invalid${path}`).searchParams.get("page"));
}

function barePath(path: string): string {
  return path.split("?", 1)[0];
}

function stub(scenario: Scenario = {}): {
  readonly request: GithubRequest;
  readonly calls: RequestCall[];
} {
  const calls: RequestCall[] = [];
  const request: GithubRequest = async <T>(
    _token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> => {
    calls.push({ method, path, body });
    if (scenario.throwPath !== undefined && path.includes(scenario.throwPath)) {
      throw new Error("injected request failure");
    }
    if (scenario.nonArrayPath !== undefined && path.includes(scenario.nonArrayPath)) {
      return {} as T;
    }
    const bare = barePath(path);
    let response: unknown;
    if (method === "POST") {
      response = {};
    } else if (bare === `/repos/${OWNER}/${REPO}/pulls/${PR}`) {
      response = scenario.pull ?? {
        head: { sha: HEAD, repo: { full_name: REPOSITORY } },
        draft: false,
        created_at: CREATED,
      };
    } else if (scenario.overflowPath === bare) {
      response = Array.from({ length: 100 }, (_, index) => ({
        user: { login: `reader-${index}` },
        commit_id: HEAD,
        submitted_at: AFTER,
        id: (pageNumber(path) - 1) * 100 + index + 1,
        state: "DISMISSED",
      }));
    } else if (bare === `/repos/${OWNER}/${REPO}/issues/${PR}/timeline`) {
      response = scenario.timeline ?? [];
    } else if (bare === `/repos/${OWNER}/${REPO}/pulls/${PR}/reviews`) {
      response = scenario.reviews ?? [];
    } else if (bare === `/repos/${OWNER}/${REPO}/pulls/${PR}/comments`) {
      response = scenario.pullComments ?? [];
    } else if (bare === `/repos/${OWNER}/${REPO}/issues/${PR}/comments`) {
      response = scenario.issueComments ?? [];
    } else if (bare === `/repos/${OWNER}/${REPO}/issues/${PR}/reactions`) {
      response = scenario.prReactions ?? [];
    } else {
      const match = /^\/repos\/syamaner\/roastpilot-cloud\/issues\/comments\/(\d+)\/reactions$/u
        .exec(bare);
      response = match === null
        ? []
        : scenario.commentReactions?.[Number(match[1])] ?? [];
    }
    return response as T;
  };
  return { request, calls };
}

function issueComment(overrides: Record<string, unknown> = {}): unknown {
  return {
    user: { login: BOT }, body: CLEAN_BODY, created_at: AFTER, id: 11,
    ...overrides,
  };
}

function posts(calls: readonly RequestCall[]): readonly RequestCall[] {
  return calls.filter((call) => call.method === "POST");
}

async function runCaught(request: GithubRequest): Promise<void> {
  try {
    await main(request);
  } catch (error) {
    console.error("publish-codex-verdict-status failed:", error);
    process.exitCode = 1;
  }
}

describe("credentialed Codex advisory-status publisher", () => {
  beforeEach(() => {
    process.env.GH_TOKEN = "test-token";
    process.env.GITHUB_REPOSITORY = REPOSITORY;
    process.env.TARGET_PR_NUMBER = String(PR);
    delete process.env.GITHUB_RUN_ID;
    process.exitCode = undefined;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_REPOSITORY;
    delete process.env.TARGET_PR_NUMBER;
    delete process.env.GITHUB_RUN_ID;
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("E1/G1/G2 posts clean despite realistic commented and committed timeline noise", async () => {
    const { request, calls } = stub({
      timeline: [
        { event: "ready_for_review", created_at: "2026-08-08T10:01:00Z" },
        { event: "commented", created_at: "2026-08-08T10:02:00Z" },
        { event: "committed", created_at: "2026-08-08T10:02:30Z" },
      ],
      issueComments: [issueComment()],
    });
    await main(request);
    expect(posts(calls)).toEqual([{
      method: "POST",
      path: `/repos/${OWNER}/${REPO}/statuses/${HEAD}`,
      body: {
        state: "success",
        context: `factory/codex-verdict-advisory/pr-${PR}`,
        description: "clean channel=clean-comment sha=aaaaaaa",
      },
    }]);
    expect(process.exitCode).toBeUndefined();
  });

  it("E2 posts findings without consulting a reactions endpoint", async () => {
    const { request, calls } = stub({
      reviews: [{
        user: { login: BOT }, commit_id: HEAD, submitted_at: AFTER,
        id: 7, state: "COMMENTED",
      }],
      pullComments: [{
        pull_request_review_id: 7, in_reply_to_id: null,
        user: { login: "reviewer" }, body: "thread", created_at: AFTER, id: 70,
      }],
    });
    await main(request);
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0].body).toMatchObject({
      state: "failure",
      description: "findings source=review sha=aaaaaaa count=1",
    });
    expect(calls.some((call) => call.path.includes("/reactions"))).toBe(false);
    expect(calls.filter((call) => barePath(call.path).endsWith(`/pulls/${PR}/comments`)))
      .toHaveLength(1);
  });

  it("E3 publishes draft as not applicable pending", async () => {
    const { request, calls } = stub({
      pull: {
        head: { sha: HEAD, repo: { full_name: REPOSITORY } },
        draft: true, created_at: CREATED,
      },
    });
    await main(request);
    expect(posts(calls)[0].body).toMatchObject({
      state: "pending",
      description: expect.stringContaining("advice=not-applicable-draft"),
    });
  });

  it("E4/G3 short-circuits a genuine fork without a POST or failure", async () => {
    const { request, calls } = stub({
      pull: {
        head: { sha: HEAD, repo: { full_name: "somebody/fork" } },
        draft: false, created_at: CREATED,
      },
    });
    await main(request);
    expect(posts(calls)).toEqual([]);
    expect(process.exitCode).toBeUndefined();
  });

  it("E5 treats malformed PR metadata as a failing no-write", async () => {
    const { request, calls } = stub({
      pull: { head: { sha: HEAD }, draft: false, created_at: CREATED },
    });
    await main(request);
    expect(posts(calls)).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it("E6 retracts stale success when a later same-repo fetch rejects", async () => {
    const { request, calls } = stub({ throwPath: `/pulls/${PR}/reviews` });
    await main(request);
    expect(posts(calls)).toEqual([{
      method: "POST",
      path: `/repos/${OWNER}/${REPO}/statuses/${HEAD}`,
      body: {
        state: "pending",
        context: `factory/codex-verdict-advisory/pr-${PR}`,
        description: "pending reasons=evaluation-failed; advice=retry",
      },
    }]);
    expect(process.exitCode).toBe(1);
  });

  it("does not retract a fork when a later fetch rejects", async () => {
    const { request, calls } = stub({
      pull: {
        head: { sha: HEAD, repo: { full_name: "somebody/fork" } },
        draft: false, created_at: CREATED,
      },
      throwPath: `/pulls/${PR}/reviews`,
    });
    await main(request);
    expect(posts(calls)).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it("cannot retract when the initial pull-request fetch rejects", async () => {
    const { request, calls } = stub({ throwPath: `/pulls/${PR}` });
    await runCaught(request);
    expect(posts(calls)).toEqual([]);
    expect(process.exitCode).toBe(1);
  });

  it("does not recursively retry when the retraction POST rejects", async () => {
    const { request, calls } = stub({ throwPath: `/statuses/${HEAD}` });
    await main(request);
    expect(posts(calls)).toHaveLength(2);
    expect(posts(calls)[0].body).toMatchObject({ state: "pending" });
    expect(posts(calls)[1].body).toMatchObject({
      state: "pending",
      description: "pending reasons=evaluation-failed; advice=retry",
    });
    expect(process.exitCode).toBe(1);
  });

  it("E7 scopes manual and PR reactions to their exact REST subjects", async () => {
    const manual = stub({
      issueComments: [issueComment({
        user: { login: "syamaner" }, body: "@codex review",
        created_at: "2026-08-08T10:01:00Z", id: 77,
      })],
    });
    await main(manual.request);
    expect(manual.calls.some((call) => barePath(call.path) ===
      `/repos/${OWNER}/${REPO}/issues/comments/77/reactions`)).toBe(true);
    expect(manual.calls.some((call) => barePath(call.path) ===
      `/repos/${OWNER}/${REPO}/issues/${PR}/comments/77/reactions`)).toBe(false);

    const pull = stub();
    await main(pull.request);
    expect(pull.calls.some((call) => barePath(call.path) ===
      `/repos/${OWNER}/${REPO}/issues/${PR}/reactions`)).toBe(true);
  });

  it("E8/G6 retains fifty pages but marks overflow incomplete", async () => {
    const overflowPath = `/repos/${OWNER}/${REPO}/pulls/${PR}/reviews`;
    const { request, calls } = stub({
      issueComments: [issueComment()], overflowPath,
    });
    await main(request);
    expect(calls.filter((call) => barePath(call.path) === overflowPath)).toHaveLength(MAX_PAGES);
    expect(posts(calls)[0].body).toMatchObject({
      state: "pending",
      description: expect.stringContaining("evidence-incomplete"),
    });
  });

  it.each([
    ["missing GH_TOKEN", undefined, REPOSITORY, String(PR)],
    ["malformed PR number", "test-token", REPOSITORY, "01"],
    ["unsafe PR number", "test-token", REPOSITORY, "9007199254740992"],
    ["malformed repository", "test-token", "owner/repo/extra", String(PR)],
  ])("E9 rejects %s before any fetch", async (_name, token, repository, number) => {
    if (token === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = token;
    process.env.GITHUB_REPOSITORY = repository;
    process.env.TARGET_PR_NUMBER = number;
    const { request, calls } = stub();
    await expect(main(request)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("E9 omits a cosmetic target URL when run id is malformed", async () => {
    process.env.GITHUB_RUN_ID = "not-a-run";
    const { request, calls } = stub({ issueComments: [issueComment()] });
    await main(request);
    expect(posts(calls)[0].body).not.toHaveProperty("target_url");
  });

  it("includes a literal-host target URL only for a canonical run id", async () => {
    process.env.GITHUB_RUN_ID = "123";
    const { request, calls } = stub({ issueComments: [issueComment()] });
    await main(request);
    expect(posts(calls)[0].body).toMatchObject({
      target_url: `https://github.com/${REPOSITORY}/actions/runs/123`,
    });
  });

  it("E10 keeps a complete bot eyes/plus-one pair pending under D148", async () => {
    const { request, calls } = stub({
      prReactions: [
        { user: { login: BOT }, content: "eyes", created_at: "2026-08-08T10:01:00Z" },
        { user: { login: BOT }, content: "+1", created_at: AFTER },
      ],
    });
    await main(request);
    expect(posts(calls)[0].body).toEqual({
      state: "pending",
      context: `factory/codex-verdict-advisory/pr-${PR}`,
      description: "pending reasons=reaction-clean-unconfirmed; advice=verify",
    });
  });

  it("E11 fails completeness closed for a deleted-account record", async () => {
    const { request, calls } = stub({
      issueComments: [issueComment()],
      reviews: [{
        user: null, commit_id: HEAD, submitted_at: AFTER,
        id: 7, state: "DISMISSED",
      }],
    });
    await main(request);
    expect(posts(calls)[0].body).toMatchObject({
      state: "pending",
      description: expect.stringContaining("evidence-incomplete"),
    });
  });

  it("keeps a malformed visible head-ref event fail-closed amid timeline noise", async () => {
    const { request, calls } = stub({
      timeline: [
        { event: "commented", created_at: AFTER },
        { event: "head_ref_force_pushed", created_at: "not-a-timestamp" },
        { event: "committed", created_at: AFTER },
      ],
      issueComments: [issueComment()],
    });
    await main(request);
    expect(posts(calls)[0].body).toMatchObject({
      state: "pending",
      description: expect.stringContaining("timeline-incomplete"),
    });
  });

  it("G7 removes an unauthorized trigger before boundary selection", async () => {
    const { request, calls } = stub({
      issueComments: [
        issueComment({ created_at: "2026-08-08T10:03:00Z", id: 12 }),
        issueComment({
          user: { login: "attacker" }, body: "@codex review",
          created_at: "2026-08-08T10:01:00Z", id: 77,
        }),
      ],
    });
    await main(request);
    expect(posts(calls)[0].body).toMatchObject({ state: "success" });
    expect(calls.some((call) => barePath(call.path) ===
      `/repos/${OWNER}/${REPO}/issues/comments/77/reactions`)).toBe(false);
    expect(calls.some((call) => barePath(call.path) ===
      `/repos/${OWNER}/${REPO}/issues/${PR}/reactions`)).toBe(true);
  });

  it("G8 ANDs ambiguous root classification into review completeness", async () => {
    const { request, calls } = stub({
      issueComments: [issueComment()],
      pullComments: [{
        pull_request_review_id: 7, in_reply_to_id: "ambiguous",
        user: { login: "reviewer" }, body: "reply", created_at: AFTER, id: 70,
      }],
    });
    await main(request);
    expect(posts(calls)[0].body).toMatchObject({
      state: "pending",
      description: expect.stringContaining("evidence-incomplete"),
    });
  });

  it("rejects a non-array page before posting", async () => {
    const { request, calls } = stub({ nonArrayPath: "/timeline" });
    await main(request);
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0].body).toMatchObject({
      state: "pending",
      description: "pending reasons=evaluation-failed; advice=retry",
    });
    expect(process.exitCode).toBe(1);
  });
});

describe("boundaryTimelineEvents", () => {
  it("keeps all five boundary types regardless of timestamp shape and drops noise", () => {
    const boundary = [
      { event: "ready_for_review", createdAt: "malformed-1" },
      { event: "convert_to_draft", createdAt: "malformed-2" },
      { event: "head_ref_force_pushed", createdAt: "malformed-3" },
      { event: "head_ref_deleted", createdAt: "malformed-4" },
      { event: "head_ref_restored", createdAt: "malformed-5" },
    ];
    expect(boundaryTimelineEvents([
      { event: "commented", createdAt: AFTER },
      ...boundary,
      { event: "committed", createdAt: AFTER },
      { event: undefined, createdAt: AFTER },
    ])).toEqual(boundary);
  });
});

describe("assertPostableStatus", () => {
  const valid: NamespacedStatusPlan = {
    kind: "write",
    state: "pending",
    context: `factory/codex-verdict-advisory/pr-${PR}`,
    description: "pending reasons=no-bot-signal; advice=wait",
  };

  it("accepts the closed post shape", () => {
    expect(() => assertPostableStatus(HEAD, valid, PR)).not.toThrow();
  });

  it.each([
    ["bad SHA", "bad", valid],
    ["no-write", HEAD, { kind: "no-write", reason: "fork-head" }],
    ["wrong context", HEAD, { ...valid, context: "wrong" }],
    ["bad state", HEAD, { ...valid, state: "error" }],
  ])("refuses %s", (_name, sha, plan) => {
    expect(() => assertPostableStatus(
      sha,
      plan as NamespacedStatusPlan,
      PR,
    )).toThrow(/refusing status POST/u);
  });

  it("G5 lets the top-level boundary fail a 141-character description", () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      assertPostableStatus(
        HEAD,
        { ...valid, description: "x".repeat(141) },
        PR,
      );
    } catch (error) {
      console.error("publish-codex-verdict-status failed:", error);
      process.exitCode = 1;
    }
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    errorLog.mockRestore();
  });
});
