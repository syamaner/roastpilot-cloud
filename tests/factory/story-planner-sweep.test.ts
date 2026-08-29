import { afterEach, describe, expect, it, vi } from "vitest";

import {
  STORY_PLANNER_CONTRACT_MARKER,
  STORY_PLANNER_ESCALATE_MARKER,
} from "../../scripts/factory/post-story-planner-contract.mts";
import {
  MAX_LABEL_READD_ATTEMPTS,
  MAX_PAGES,
  enumerateReadyToSpecIssues,
  main,
  runSweep,
  type GithubRequest,
} from "../../scripts/factory/story-planner-sweep.mts";

const OWNER = "syamaner";
const REPO = "roastpilot-cloud";
const READ_TOKEN = "read-token";
const APP_TOKEN = "app-token";
const BOT = { type: "Bot", login: "github-actions[bot]" } as const;
const CONTRACT_REVISION = "a".repeat(64);

type RequestCall = readonly [string, string, string, unknown?];

function issue(number: number, state: "open" | "closed" = "open") {
  return { number, state, labels: [{ name: "ready-to-spec" }] };
}

function requestFrom(
  implementation: (...call: RequestCall) => Promise<unknown>,
): { readonly request: GithubRequest; readonly mock: ReturnType<typeof vi.fn> } {
  const mock = vi.fn(implementation);
  return {
    request: async <T>(token: string, method: string, path: string, body?: unknown) =>
      mock(token, method, path, body) as Promise<T>,
    mock,
  };
}

function enumerationResponse(path: string, openIssues: readonly unknown[]): unknown[] {
  return path.includes("state=open") ? [...openIssues] : [];
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("story-planner sweep I/O", () => {
  // remove guard AC12 => writing despite skip-handled makes this test fail.
  it.each([
    ["contract", STORY_PLANNER_CONTRACT_MARKER(31, CONTRACT_REVISION)],
    ["escalate", STORY_PLANNER_ESCALATE_MARKER(31)],
  ])("AC12 skips an open issue with an existing %s marker end-to-end", async (_kind, marker) => {
    const { request, mock } = requestFrom(async (_token, method, path) => {
      if (method === "GET" && path.includes("/issues?")) {
        return enumerationResponse(path, [issue(31)]);
      }
      if (method === "GET" && path.includes("/comments?")) {
        return [{ body: `owned\n${marker}`, user: BOT }];
      }
      throw new Error(`unexpected request: ${method} ${path}`);
    });
    const logs: string[] = [];

    await runSweep({
      request,
      ghToken: READ_TOKEN,
      appToken: APP_TOKEN,
      owner: OWNER,
      repo: REPO,
      log: (line) => logs.push(line),
    });

    expect(mock.mock.calls.filter((call) => call[1] !== "GET")).toEqual([]);
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { issue_number: 31, result: "already-handled" },
    ]);
  });

  // remove guard F2-main-repo => malformed repository wiring reaches GitHub.
  it("main rejects a non-canonical repository before any request", async () => {
    vi.stubEnv("GH_TOKEN", READ_TOKEN);
    vi.stubEnv("FACTORY_APP_TOKEN", APP_TOKEN);
    vi.stubEnv("GITHUB_REPOSITORY", "owner/repo/extra");
    const mock = vi.fn();

    await expect(main(mock as GithubRequest)).rejects.toThrow(
      'GITHUB_REPOSITORY must be canonical "owner/repo"',
    );
    expect(mock).not.toHaveBeenCalled();
  });

  // remove guard F2-main-happy => main no longer reaches the sweep enumeration.
  it("main wires valid environment and reaches the sweep", async () => {
    vi.stubEnv("GH_TOKEN", READ_TOKEN);
    vi.stubEnv("FACTORY_APP_TOKEN", APP_TOKEN);
    vi.stubEnv("GITHUB_REPOSITORY", `${OWNER}/${REPO}`);
    const { request, mock } = requestFrom(async () => []);

    await main(request);

    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls.every((call) => call[0] === READ_TOKEN)).toBe(true);
  });

  // remove guard F2-token-wiring => swapping GH_TOKEN and App token fails.
  it("main sends reads through GH_TOKEN and writes through FACTORY_APP_TOKEN", async () => {
    vi.stubEnv("GH_TOKEN", READ_TOKEN);
    vi.stubEnv("FACTORY_APP_TOKEN", APP_TOKEN);
    vi.stubEnv("GITHUB_REPOSITORY", `${OWNER}/${REPO}`);
    let commentReads = 0;
    const { request, mock } = requestFrom(async (_token, method, path) => {
      if (method === "GET" && path.includes("/issues?")) {
        return enumerationResponse(path, [issue(32)]);
      }
      if (method === "GET" && path.includes("/comments?")) {
        commentReads += 1;
        return commentReads === 1
          ? []
          : [{ body: STORY_PLANNER_CONTRACT_MARKER(32, CONTRACT_REVISION), user: BOT }];
      }
      if (method === "GET" && path.endsWith("/issues/32")) return issue(32);
      if (method === "DELETE" || method === "POST") return undefined;
      throw new Error(`unexpected request: ${method} ${path}`);
    });

    await main(request);

    const reads = mock.mock.calls.filter((call) => call[1] === "GET");
    const writes = mock.mock.calls.filter((call) => call[1] !== "GET");
    expect(reads.every((call) => call[0] === READ_TOKEN)).toBe(true);
    expect(writes).toEqual([
      [APP_TOKEN, "DELETE", `/repos/${OWNER}/${REPO}/issues/32/labels/ready-to-spec`, undefined],
      [APP_TOKEN, "POST", `/repos/${OWNER}/${REPO}/issues/32/labels`, { labels: ["ready-to-spec"] }],
    ]);
  });

  // remove guard F2-validation => malformed /issues rows enter the sweep.
  it.each([
    ["pull request row", { ...issue(1), pull_request: { url: "https://example.test" } }],
    ["missing number", { state: "open", labels: ["ready-to-spec"] }],
    ["non-integer number", issue(1.5)],
    ["number below one", issue(0)],
    ["missing labels", { number: 1, state: "open" }],
    ["invalid label entry", { number: 1, state: "open", labels: [null] }],
    ["missing ready-to-spec", { number: 1, state: "open", labels: ["bug"] }],
  ])("rejects a %s with zero writes", async (_name, row) => {
    const { request, mock } = requestFrom(async () => [row]);

    await expect(enumerateReadyToSpecIssues(
      request,
      READ_TOKEN,
      OWNER,
      REPO,
      "open",
    )).rejects.toThrow("malformed open ready-to-spec issue response");
    expect(mock.mock.calls.filter((call) => call[1] !== "GET")).toEqual([]);
  });

  // remove guard F3-list-shape => a non-array GitHub response is treated as issues.
  it("rejects a non-array issue enumeration response with zero writes", async () => {
    const { request, mock } = requestFrom(async () => ({ message: "unexpected shape" }));

    await expect(enumerateReadyToSpecIssues(
      request,
      READ_TOKEN,
      OWNER,
      REPO,
      "open",
    )).rejects.toThrow("malformed open ready-to-spec issue response");
    expect(mock.mock.calls.filter((call) => call[1] !== "GET")).toEqual([]);
  });

  // remove guard F2-comment-pagination => a page-two marker is missed and relabeled.
  it("fully scans multiple comment pages before deciding handled", async () => {
    const fullPage = Array.from({ length: 100 }, () => ({
      body: "ordinary",
      user: { type: "User", login: "reader" },
    }));
    const { request, mock } = requestFrom(async (_token, method, path) => {
      if (method === "GET" && path.includes("/issues?")) {
        return enumerationResponse(path, [issue(33)]);
      }
      if (method === "GET" && path.includes("/comments?") && path.endsWith("page=1")) {
        return fullPage;
      }
      if (method === "GET" && path.includes("/comments?")) {
        return [{ body: STORY_PLANNER_CONTRACT_MARKER(33, CONTRACT_REVISION), user: BOT }];
      }
      throw new Error(`unexpected request: ${method} ${path}`);
    });

    await runSweep({
      request,
      ghToken: READ_TOKEN,
      appToken: APP_TOKEN,
      owner: OWNER,
      repo: REPO,
    });

    expect(mock.mock.calls.filter((call) => String(call[2]).includes("/comments?"))).toHaveLength(2);
    expect(mock.mock.calls.filter((call) => call[1] !== "GET")).toEqual([]);
  });

  // remove guard F2-comment-bound => saturated comment pages loop or truncate silently.
  it("throws after the bounded comment-page scan", async () => {
    const fullPage = Array.from({ length: 100 }, () => ({ body: "ordinary", user: null }));
    const { request, mock } = requestFrom(async (_token, method, path) => {
      if (method === "GET" && path.includes("/issues?")) {
        return enumerationResponse(path, [issue(34)]);
      }
      if (method === "GET" && path.includes("/comments?")) return fullPage;
      throw new Error(`unexpected request: ${method} ${path}`);
    });

    await expect(runSweep({
      request,
      ghToken: READ_TOKEN,
      appToken: APP_TOKEN,
      owner: OWNER,
      repo: REPO,
    })).rejects.toThrow(`comment enumeration for #34 exceeded ${MAX_PAGES} pages`);
    expect(mock.mock.calls.filter((call) => String(call[2]).includes("/comments?"))).toHaveLength(MAX_PAGES);
  });

  // remove guard F2-issue-bound => saturated issue pages loop or truncate silently.
  it("throws after the bounded issue-page scan", async () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => issue(index + 1));
    const { request, mock } = requestFrom(async () => fullPage);

    await expect(enumerateReadyToSpecIssues(
      request,
      READ_TOKEN,
      OWNER,
      REPO,
      "open",
    )).rejects.toThrow(`ready-to-spec open issue enumeration exceeded ${MAX_PAGES} pages`);
    expect(mock).toHaveBeenCalledTimes(MAX_PAGES);
  });

  // remove guard F2-TOCTOU => malformed fresh state is treated as safely closed.
  it("propagates a malformed open-state recheck before writing", async () => {
    const { request, mock } = requestFrom(async (_token, method, path) => {
      if (method === "GET" && path.includes("/issues?")) {
        return enumerationResponse(path, [issue(35)]);
      }
      if (method === "GET" && path.includes("/comments?")) return [];
      if (method === "GET" && path.endsWith("/issues/35")) return { state: "open" };
      throw new Error(`unexpected request: ${method} ${path}`);
    });

    await expect(runSweep({
      request,
      ghToken: READ_TOKEN,
      appToken: APP_TOKEN,
      owner: OWNER,
      repo: REPO,
    })).rejects.toThrow("malformed open ready-to-spec issue response");
    expect(mock.mock.calls.filter((call) => call[1] !== "GET")).toEqual([]);
  });

  // remove guard F4-pre-readd-state => a close after DELETE still reaches POST.
  it("does not re-add when the issue closes between DELETE and POST", async () => {
    let stateReads = 0;
    const logs: string[] = [];
    const { request, mock } = requestFrom(async (_token, method, path) => {
      if (method === "GET" && path.includes("/issues?")) {
        return enumerationResponse(path, [issue(38)]);
      }
      if (method === "GET" && path.includes("/comments?")) return [];
      if (method === "GET" && path.endsWith("/issues/38")) {
        stateReads += 1;
        return stateReads === 1 ? issue(38) : issue(38, "closed");
      }
      if (method === "DELETE") return undefined;
      throw new Error(`unexpected request: ${method} ${path}`);
    });

    await expect(runSweep({
      request,
      ghToken: READ_TOKEN,
      appToken: APP_TOKEN,
      owner: OWNER,
      repo: REPO,
      log: (line) => logs.push(line),
    })).resolves.toBeUndefined();
    expect(mock.mock.calls.filter((call) => call[1] === "DELETE")).toHaveLength(1);
    expect(mock.mock.calls.filter((call) => call[1] === "POST")).toEqual([]);
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { issue_number: 38, result: "closed-after-delete-no-readd" },
    ]);
  });

  // remove guard F4-pre-readd-order => POST can occur without the fresh GET.
  it("rechecks still-open state after DELETE and before POST", async () => {
    let commentReads = 0;
    let stateReads = 0;
    const { request, mock } = requestFrom(async (_token, method, path) => {
      if (method === "GET" && path.includes("/issues?")) {
        return enumerationResponse(path, [issue(39)]);
      }
      if (method === "GET" && path.includes("/comments?")) {
        commentReads += 1;
        return commentReads === 1
          ? []
          : [{ body: STORY_PLANNER_CONTRACT_MARKER(39, CONTRACT_REVISION), user: BOT }];
      }
      if (method === "GET" && path.endsWith("/issues/39")) {
        stateReads += 1;
        return stateReads === 1 ? issue(39) : { ...issue(39), labels: [] };
      }
      if (method === "DELETE" || method === "POST") return undefined;
      throw new Error(`unexpected request: ${method} ${path}`);
    });

    await runSweep({
      request,
      ghToken: READ_TOKEN,
      appToken: APP_TOKEN,
      owner: OWNER,
      repo: REPO,
    });
    const stateAndWrites = mock.mock.calls.filter(
      (call) => String(call[2]).endsWith("/issues/39") || call[1] !== "GET",
    );
    expect(stateAndWrites).toEqual([
      [READ_TOKEN, "GET", `/repos/${OWNER}/${REPO}/issues/39`, undefined],
      [APP_TOKEN, "DELETE", `/repos/${OWNER}/${REPO}/issues/39/labels/ready-to-spec`, undefined],
      [READ_TOKEN, "GET", `/repos/${OWNER}/${REPO}/issues/39`, undefined],
      [APP_TOKEN, "POST", `/repos/${OWNER}/${REPO}/issues/39/labels`, { labels: ["ready-to-spec"] }],
    ]);
  });

  // remove guard F5-per-retry-recheck => retry POSTs after the issue closes.
  it("stops re-add retries when the issue closes after the first POST failure", async () => {
    let stateReads = 0;
    const logs: string[] = [];
    const { request, mock } = requestFrom(async (_token, method, path) => {
      if (method === "GET" && path.includes("/issues?")) {
        return enumerationResponse(path, [issue(40)]);
      }
      if (method === "GET" && path.includes("/comments?")) return [];
      if (method === "GET" && path.endsWith("/issues/40")) {
        stateReads += 1;
        return stateReads < 3 ? issue(40) : issue(40, "closed");
      }
      if (method === "DELETE") return undefined;
      if (method === "POST") throw new Error("first re-add failed");
      throw new Error(`unexpected request: ${method} ${path}`);
    });

    await expect(runSweep({
      request,
      ghToken: READ_TOKEN,
      appToken: APP_TOKEN,
      owner: OWNER,
      repo: REPO,
      log: (line) => logs.push(line),
    })).resolves.toBeUndefined();
    expect(mock.mock.calls.filter((call) => call[1] !== "GET")).toEqual([
      [APP_TOKEN, "DELETE", `/repos/${OWNER}/${REPO}/issues/40/labels/ready-to-spec`, undefined],
      [APP_TOKEN, "POST", `/repos/${OWNER}/${REPO}/issues/40/labels`, { labels: ["ready-to-spec"] }],
    ]);
    expect(stateReads).toBe(3);
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { issue_number: 40, result: "closed-after-delete-no-readd" },
    ]);
  });

  // remove guard F2-readd-bound => a successful DELETE can strand the issue silently.
  it.each(["injected", "default"] as const)(
    "retries a failed re-add to the bound, emits ::error:: via %s reporter, and throws",
    async (reporter) => {
    const errors: string[] = [];
    const defaultError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { request, mock } = requestFrom(async (_token, method, path) => {
      if (method === "GET" && path.includes("/issues?")) {
        return enumerationResponse(path, [issue(36)]);
      }
      if (method === "GET" && path.includes("/comments?")) return [];
      if (method === "GET" && path.endsWith("/issues/36")) return issue(36);
      if (method === "DELETE") return undefined;
      if (method === "POST") throw new Error("re-add unavailable");
      throw new Error(`unexpected request: ${method} ${path}`);
    });

    await expect(runSweep({
      request,
      ghToken: READ_TOKEN,
      appToken: APP_TOKEN,
      owner: OWNER,
      repo: REPO,
      ...(reporter === "injected" ? { error: (line: string) => errors.push(line) } : {}),
    })).rejects.toThrow("re-add unavailable");
    expect(mock.mock.calls.filter((call) => call[1] === "DELETE")).toHaveLength(1);
    expect(mock.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(
      MAX_LABEL_READD_ATTEMPTS,
    );
    expect(
      mock.mock.calls.filter((call) => String(call[2]).endsWith("/issues/36")),
    ).toHaveLength(1 + MAX_LABEL_READD_ATTEMPTS);
    const loudError = expect.stringMatching(
      /::error::.*issue #36.*Manually re-add ready-to-spec.*#36/,
    );
    if (reporter === "injected") {
      expect(errors).toEqual([loudError]);
      expect(defaultError).not.toHaveBeenCalled();
    } else {
      expect(errors).toEqual([]);
      expect(defaultError).toHaveBeenCalledWith(loudError);
    }
  });

  // remove guard F2-readd-recovery => one transient POST failure aborts after DELETE.
  it("restores the label when the re-add succeeds on retry", async () => {
    let commentReads = 0;
    let postAttempts = 0;
    const errors: string[] = [];
    const { request, mock } = requestFrom(async (_token, method, path) => {
      if (method === "GET" && path.includes("/issues?")) {
        return enumerationResponse(path, [issue(37)]);
      }
      if (method === "GET" && path.includes("/comments?")) {
        commentReads += 1;
        return commentReads === 1
          ? []
          : [{ body: STORY_PLANNER_CONTRACT_MARKER(37, CONTRACT_REVISION), user: BOT }];
      }
      if (method === "GET" && path.endsWith("/issues/37")) return issue(37);
      if (method === "DELETE") return undefined;
      if (method === "POST") {
        postAttempts += 1;
        if (postAttempts === 1) throw new Error("transient re-add failure");
        return undefined;
      }
      throw new Error(`unexpected request: ${method} ${path}`);
    });

    await expect(runSweep({
      request,
      ghToken: READ_TOKEN,
      appToken: APP_TOKEN,
      owner: OWNER,
      repo: REPO,
      error: (line) => errors.push(line),
    })).resolves.toBeUndefined();
    expect(mock.mock.calls.filter((call) => call[1] === "DELETE")).toHaveLength(1);
    expect(mock.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(2);
    expect(
      mock.mock.calls.filter((call) => String(call[2]).endsWith("/issues/37")),
    ).toHaveLength(3);
    expect(errors).toEqual([]);
  });
});
