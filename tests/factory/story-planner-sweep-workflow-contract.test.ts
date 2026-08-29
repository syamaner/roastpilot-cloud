import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";

import { STORY_PLANNER_CONTRACT_MARKER } from "../../scripts/factory/post-story-planner-contract.mts";
import {
  MAX_CONFIRMATION_ATTEMPTS,
  enumerateReadyToSpecIssues,
  runSweep,
  type GithubRequest,
} from "../../scripts/factory/story-planner-sweep.mts";

const WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/story-planner-sweep.yml", import.meta.url),
);
const WORKFLOW_SOURCE = readFileSync(WORKFLOW_PATH, "utf8");
const ENTRYPOINT_PATH = fileURLToPath(
  new URL("../../scripts/factory/story-planner-sweep.mts", import.meta.url),
);
const BOT = { type: "Bot", login: "github-actions[bot]" } as const;
const CONTRACT_REVISION = "b".repeat(64);

type Mapping = Record<string, unknown>;
type RequestCall = readonly [string, string, string, unknown?];

function mapping(value: unknown): Mapping {
  expect(value).toBeTypeOf("object");
  expect(value).not.toBeNull();
  return value as Mapping;
}

function workflow(): Mapping {
  const document = parseDocument(WORKFLOW_SOURCE);
  expect(document.errors).toEqual([]);
  return document.toJS() as Mapping;
}

function namedStep(job: Mapping, name: string): Mapping {
  const steps = job.steps as unknown[];
  const step = steps.find((candidate) => mapping(candidate).name === name);
  expect(step, `missing workflow step ${name}`).toBeDefined();
  return mapping(step);
}

function issue(number: number, state: "open" | "closed") {
  return { number, state, labels: [{ name: "ready-to-spec" }] };
}

describe("story-planner sweep workflow contract", () => {
  // remove guard G14 => dropping main-ref admission or adding a pause conjunct fails.
  it("G14 is dispatch-only and dark on the enable variable plus main ref", () => {
    const root = workflow();
    expect(root.on).toEqual({ workflow_dispatch: null });
    expect(mapping(root.permissions)).toEqual({});
    expect(mapping(root.concurrency)).toEqual({
      group: "story-planner-sweep",
      "cancel-in-progress": false,
    });
    const sweep = mapping(mapping(root.jobs).sweep);
    expect(sweep.if).toBe(
      "vars.STORY_PLANNER_ENABLED == 'true' && github.ref == 'refs/heads/main'",
    );
    expect(WORKFLOW_SOURCE).not.toContain("FACTORY_PAUSED");
    expect(mapping(sweep.permissions)).toEqual({
      contents: "read",
      issues: "read",
    });
    expect(mapping(namedStep(sweep, "Checkout sweep scripts only").with)).toEqual({
      "persist-credentials": false,
      ref: "main",
      "sparse-checkout": "scripts/factory",
    });
  });

  // remove guard G11 => changing the issues-only App mint shape fails.
  it("G11 pins the triage-equivalent issues-only App mint and App env", () => {
    const sweep = mapping(mapping(workflow().jobs).sweep);
    const mint = namedStep(sweep, "Mint factory App token");
    expect(mint).toMatchObject({
      id: "factory_token",
      if: "${{ vars.FACTORY_PUBLISHER_APP_ID != '' }}",
      "continue-on-error": true,
      uses:
        "actions/create-github-app-token@fee1f7d63c2ff003460e3d139729b119787bc349",
    });
    expect(mapping(mint.with)).toEqual({
      "app-id": "${{ vars.FACTORY_PUBLISHER_APP_ID }}",
      "private-key": "${{ secrets.FACTORY_PUBLISHER_PRIVATE_KEY }}",
      "permission-issues": "write",
    });
    const sweepStep = namedStep(sweep, "Sweep unplanned ready-to-spec issues");
    expect(sweepStep.run).toBe(
      "node --experimental-strip-types scripts/factory/story-planner-sweep.mts",
    );
    expect(mapping(sweepStep.env)).toEqual({
      GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      FACTORY_APP_TOKEN: "${{ steps.factory_token.outputs.token }}",
      GITHUB_REPOSITORY: "${{ github.repository }}",
    });
  });

  // remove guard G11 => an empty App-token fallback makes a request and fails.
  it("G11 rejects an empty App token before any read or label write", async () => {
    const mock = vi.fn();
    await expect(runSweep({
      request: mock as GithubRequest,
      ghToken: "read-token",
      appToken: "",
      owner: "syamaner",
      repo: "roastpilot-cloud",
    })).rejects.toThrow("FACTORY_APP_TOKEN is required");
    expect(mock).not.toHaveBeenCalled();
  });

  // remove guard G11 => deleting the direct-run failure boundary exits zero.
  it("G11 makes the production entrypoint exit non-zero without the App token", () => {
    const environment = { ...process.env };
    delete environment.FACTORY_APP_TOKEN;
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", ENTRYPOINT_PATH],
      {
        encoding: "utf8",
        env: {
          ...environment,
          GH_TOKEN: "read-token",
          GITHUB_REPOSITORY: "syamaner/roastpilot-cloud",
        },
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "missing required environment variable: FACTORY_APP_TOKEN",
    );
  });

  // remove guard G13 => dropping state=open or page advancement fails.
  it("G13 fully paginates the open-only relabel enumeration", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => issue(index + 1, "open"));
    const mock = vi.fn(async (...call: RequestCall) =>
      String(call[2]).endsWith("page=1") ? firstPage : [issue(101, "open")],
    );
    const issues = await enumerateReadyToSpecIssues(
      mock as GithubRequest,
      "read-token",
      "syamaner",
      "roastpilot-cloud",
      "open",
    );
    expect(issues).toHaveLength(101);
    expect(mock).toHaveBeenNthCalledWith(
      1,
      "read-token",
      "GET",
      "/repos/syamaner/roastpilot-cloud/issues?labels=ready-to-spec&state=open&per_page=100&page=1",
    );
    expect(mock).toHaveBeenNthCalledWith(
      2,
      "read-token",
      "GET",
      "/repos/syamaner/roastpilot-cloud/issues?labels=ready-to-spec&state=open&per_page=100&page=2",
    );
  });

  // remove guard G13 => accepting a closed row in the open enumeration fails.
  it("G13 fails closed if the open enumeration returns a closed issue", async () => {
    const request: GithubRequest = async <T>() => [issue(1, "closed")] as T;
    await expect(enumerateReadyToSpecIssues(
      request,
      "read-token",
      "syamaner",
      "roastpilot-cloud",
      "open",
    )).rejects.toThrow("malformed open ready-to-spec issue response");
  });

  // remove guards G10/G11/G13 => token, operation, or closed-write drift fails.
  it("G10/G11/G13 uses App for the exact relabel and only logs closed work", async () => {
    let openCommentReads = 0;
    const mock = vi.fn(async (...call: RequestCall): Promise<unknown> => {
      const [, method, path] = call;
      if (method === "GET" && path.includes("/issues?")) {
        return path.includes("state=open") ? [issue(1, "open")] : [issue(2, "closed")];
      }
      if (method === "GET" && path.includes("/issues/2/comments")) return [];
      if (method === "GET" && path.includes("/issues/1/comments")) {
        openCommentReads += 1;
        return openCommentReads === 1
          ? []
          : [{ body: STORY_PLANNER_CONTRACT_MARKER(1, CONTRACT_REVISION), user: BOT }];
      }
      if (method === "GET" && path.endsWith("/issues/1")) return issue(1, "open");
      return undefined;
    });
    const logs: string[] = [];
    await runSweep({
      request: mock as GithubRequest,
      ghToken: "read-token",
      appToken: "app-token",
      owner: "syamaner",
      repo: "roastpilot-cloud",
      log: (message) => logs.push(message),
      sleep: async () => undefined,
    });
    const writes = mock.mock.calls.filter((call) => call[1] !== "GET");
    expect(writes).toEqual([
      ["app-token", "DELETE", "/repos/syamaner/roastpilot-cloud/issues/1/labels/ready-to-spec"],
      ["app-token", "POST", "/repos/syamaner/roastpilot-cloud/issues/1/labels", { labels: ["ready-to-spec"] }],
    ]);
    expect(mock.mock.calls.filter((call) => call[1] === "GET").every((call) => call[0] === "read-token")).toBe(true);
    expect(logs.map((line) => JSON.parse(line))).toEqual([
      { issue_number: 2, result: "closed-unplanned-no-write" },
      { issue_number: 1, result: "planned" },
    ]);
  });

  // remove guard G15 => unbounded or early-stopping confirmation fails.
  it("G15 retries to the bound, records absence, and completes", async () => {
    const mock = vi.fn(async (...call: RequestCall): Promise<unknown> => {
      const [, method, path] = call;
      if (method === "GET" && path.includes("/issues?")) {
        return path.includes("state=open") ? [issue(7, "open")] : [];
      }
      if (method === "GET" && path.includes("/comments?")) return [];
      if (method === "GET" && path.endsWith("/issues/7")) return issue(7, "open");
      return undefined;
    });
    const sleeps = vi.fn(async () => undefined);
    const logs: string[] = [];
    await runSweep({
      request: mock as GithubRequest,
      ghToken: "read-token",
      appToken: "app-token",
      owner: "syamaner",
      repo: "roastpilot-cloud",
      sleep: sleeps,
      log: (message) => logs.push(message),
    });
    const commentReads = mock.mock.calls.filter((call) => String(call[2]).includes("/comments?"));
    expect(commentReads).toHaveLength(1 + MAX_CONFIRMATION_ATTEMPTS);
    expect(sleeps).toHaveBeenCalledTimes(MAX_CONFIRMATION_ATTEMPTS - 1);
    expect(JSON.parse(logs.at(-1)!)).toEqual({
      issue_number: 7,
      result: "still-unplanned-after-bounded-confirmation",
    });
  });

  // remove guard G13 => omitting the fresh open-state check makes writes appear.
  it("G13 logs an issue closed after enumeration without relabeling it", async () => {
    const mock = vi.fn(async (...call: RequestCall): Promise<unknown> => {
      const [, method, path] = call;
      if (method === "GET" && path.includes("/issues?")) {
        return path.includes("state=open") ? [issue(9, "open")] : [];
      }
      if (method === "GET" && path.includes("/comments?")) return [];
      if (method === "GET" && path.endsWith("/issues/9")) return issue(9, "closed");
      return undefined;
    });
    const logs: string[] = [];
    await runSweep({
      request: mock as GithubRequest,
      ghToken: "read-token",
      appToken: "app-token",
      owner: "syamaner",
      repo: "roastpilot-cloud",
      log: (message) => logs.push(message),
    });
    expect(mock.mock.calls.filter((call) => call[1] !== "GET")).toEqual([]);
    expect(JSON.parse(logs.at(-1)!)).toEqual({
      issue_number: 9,
      result: "closed-before-write-no-write",
    });
  });
});
