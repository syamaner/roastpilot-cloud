import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GithubApiError } from "../../scripts/factory/github-api.mts";
import {
  MAX_OWNER_TASK_COMMENT_BYTES,
  MAX_OWNER_TASK_DIFF_BYTES,
  main,
  type GithubRequest,
} from "../../scripts/factory/apply-owner-task.mts";
import { buildTaskApplyMarker } from "../../scripts/factory/owner-task-patch-logic.mts";

const REPOSITORY = "syamaner/roastpilot-cloud";
const PR_NUMBER = 9;
const COMMENT_ID = 101;
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const TREE_OID = "c".repeat(40);
const DRIFTED_HEAD_SHA = "d".repeat(40);
const APPLIED_COMMIT_SHA = "e".repeat(40);
const ORPHANED_COMMIT_SHA = "f".repeat(40);
const OTHER_SHA = "1".repeat(40);
const PAYLOAD = " update tests";
const APPLIED_HEAD_CAVEAT =
  "This commit was pushed with the built-in GITHUB_TOKEN, which does not auto-trigger downstream workflows: no required check (CI, CodeQL) and no review lens (Claude, Codex) has run on this head. Do NOT merge yet. An operator must follow the applied-head re-validation procedure in docs/factory-runbook.md (\"Applied-head roster re-validation\") to re-trigger the required roster on this exact head and confirm every required check passes and every review lens completes per the PR Merge Policy. Branch protection blocks merge until required checks pass on this head.";

type RequestCall = {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
};

let root: string;
let bindingPath: string;
let patchPath: string;
let analysisDir: string;
let planDir: string;
let outputPath: string;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function taskBinding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    kind: "owner-task",
    prHeadSha: HEAD_SHA,
    prBaseSha: BASE_SHA,
    commandPayloadSha256: sha256(PAYLOAD),
    taskTruncated: false,
    ...overrides,
  };
}

function questionBinding(): Record<string, unknown> {
  return {
    version: 3,
    prHeadSha: HEAD_SHA,
    prBaseSha: BASE_SHA,
    titleSha256: "1".repeat(64),
    bodySha256: "2".repeat(64),
    commandPayloadSha256: sha256(PAYLOAD),
    questionTruncated: false,
    diffTruncated: false,
  };
}

function eligiblePr(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    head: {
      sha: HEAD_SHA,
      ref: "feature/owner-task",
      repo: { full_name: REPOSITORY, default_branch: "main" },
    },
    base: {
      sha: BASE_SHA,
      ref: "main",
      repo: { full_name: REPOSITORY, default_branch: "main" },
    },
    state: "open",
    merged: false,
    commits: 1,
    ...overrides,
  };
}

function prWithHeadSha(sha: string): Record<string, unknown> {
  return eligiblePr({
    head: {
      sha,
      ref: "feature/owner-task",
      repo: { full_name: REPOSITORY, default_branch: "main" },
    },
  });
}

function contentCommit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sha: APPLIED_COMMIT_SHA,
    commit: { tree: { sha: TREE_OID } },
    parents: [{ sha: HEAD_SHA }],
    ...overrides,
  };
}

function writeAnalysis(input: {
  readonly baseSha?: string;
  readonly treeOid?: string;
  readonly nameStatus?: string;
  readonly numstat?: string;
  readonly diff?: string;
} = {}): void {
  mkdirSync(analysisDir, { recursive: true });
  writeFileSync(join(analysisDir, "base_sha"), `${input.baseSha ?? HEAD_SHA}\n`);
  writeFileSync(join(analysisDir, "tree_oid"), `${input.treeOid ?? TREE_OID}\n`);
  writeFileSync(
    join(analysisDir, "name_status"),
    input.nameStatus ?? "M\0lib/change.ts\0",
  );
  writeFileSync(
    join(analysisDir, "numstat"),
    input.numstat ?? "1\t0\tlib/change.ts\0",
  );
  writeFileSync(
    join(analysisDir, "diff"),
    input.diff ?? "diff --git a/lib/change.ts b/lib/change.ts\n+safe\n",
  );
}

function requestHarness(overrides: {
  readonly comment?: unknown;
  readonly issue?: unknown;
  readonly pullRequest?: unknown;
  readonly comments?: unknown;
  readonly commits?: unknown;
  readonly appliedCommit?: unknown;
  readonly appliedCommitError?: unknown;
  readonly comparison?: unknown;
  readonly comparisonError?: unknown;
  readonly commentError?: unknown;
  readonly pullRequestError?: unknown;
  readonly branch?: unknown;
  readonly branchError?: unknown;
} = {}): { readonly request: GithubRequest; readonly calls: RequestCall[] } {
  const calls: RequestCall[] = [];
  const request: GithubRequest = async <T>(
    _token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> => {
    calls.push({ method, path, body });
    let response: unknown;
    if (method === "POST" && path.endsWith(`/issues/${PR_NUMBER}/comments`)) {
      response = { id: 500 };
    } else if (path.includes("/branches/")) {
      if (overrides.branchError !== undefined) throw overrides.branchError;
      response = overrides.branch ?? { protected: false };
    } else if (path.endsWith(`/issues/comments/${COMMENT_ID}`)) {
      if (overrides.commentError !== undefined) throw overrides.commentError;
      response = overrides.comment ?? {
        body: `@claude task${PAYLOAD}`,
        user: { login: "syamaner" },
      };
    } else if (path.endsWith(`/issues/${PR_NUMBER}`)) {
      response = overrides.issue ?? { pull_request: {} };
    } else if (path.includes(`/pulls/${PR_NUMBER}/commits?`)) {
      response = overrides.commits ?? [{
        sha: APPLIED_COMMIT_SHA,
        commit: { message: "initial" },
      }];
    } else if (/\/commits\/[0-9a-f]{40}$/u.test(path)) {
      if (overrides.appliedCommitError !== undefined) throw overrides.appliedCommitError;
      response = typeof overrides.appliedCommit === "function"
        ? overrides.appliedCommit(path)
        : overrides.appliedCommit ?? {
        sha: APPLIED_COMMIT_SHA,
        commit: {
          message: `applied\n\nOwner-Task-Comment: ${COMMENT_ID}`,
          tree: { sha: TREE_OID },
        },
        parents: [{ sha: HEAD_SHA }],
      };
    } else if (path.includes("/compare/")) {
      if (overrides.comparisonError !== undefined) throw overrides.comparisonError;
      response = typeof overrides.comparison === "function"
        ? overrides.comparison(path)
        : overrides.comparison ?? { status: "behind" };
    } else if (path.endsWith(`/pulls/${PR_NUMBER}`)) {
      if (overrides.pullRequestError !== undefined) throw overrides.pullRequestError;
      response = overrides.pullRequest ?? eligiblePr();
    } else if (path.includes(`/issues/${PR_NUMBER}/comments?`)) {
      response = overrides.comments ?? [];
    } else {
      throw new Error(`unexpected request ${method} ${path}`);
    }
    return response as T;
  };
  return { request, calls };
}

function posts(calls: readonly RequestCall[]): RequestCall[] {
  return calls.filter((call) => call.method === "POST");
}

function postedBody(calls: readonly RequestCall[]): string {
  return (posts(calls)[0]!.body as { body: string }).body;
}

function planFiles(): string[] {
  return existsSync(planDir) ? readdirSync(planDir).sort() : [];
}

function writeFinalizeArtifacts(): void {
  mkdirSync(planDir);
  writeFileSync(join(planDir, "annotations.json"), "[]");
  writeFileSync(join(planDir, "applied_commit"), `${APPLIED_COMMIT_SHA}\n`);
  writeFileSync(join(planDir, "tree_oid"), TREE_OID);
  writeFileSync(join(planDir, "parent_sha"), HEAD_SHA);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "apply-owner-task-"));
  bindingPath = join(root, "binding.json");
  patchPath = join(root, "patch.diff");
  analysisDir = join(root, "analysis");
  planDir = join(root, "plan");
  outputPath = join(root, "github-output.txt");
  vi.stubEnv("APPLY_PHASE", "decide");
  vi.stubEnv("GH_TOKEN", "test-token");
  vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
  vi.stubEnv("TARGET_PR_NUMBER", String(PR_NUMBER));
  vi.stubEnv("COMMENT_ID", String(COMMENT_ID));
  vi.stubEnv("GITHUB_RUN_ID", "12345");
  vi.stubEnv("BINDING_ARTIFACT_PATH", bindingPath);
  vi.stubEnv("PATCH_ARTIFACT_PATH", patchPath);
  vi.stubEnv("ANALYSIS_DIR", analysisDir);
  vi.stubEnv("PLAN_DIR", planDir);
  vi.stubEnv("GITHUB_OUTPUT", outputPath);
  writeFileSync(bindingPath, JSON.stringify(taskBinding()));
  writeFileSync(patchPath, "patch");
  writeAnalysis();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("apply-owner-task phase entrypoint", () => {
  it("T-U1.4 prepare emits the binding head as the sole base SHA source", async () => {
    vi.stubEnv("APPLY_PHASE", "prepare");
    const { request, calls } = requestHarness();

    await main(request);

    expect(readFileSync(outputPath, "utf8")).toBe(
      `proceed=true\nbase_sha=${HEAD_SHA}\n`,
    );
    expect(calls).toHaveLength(3);
  });

  it.each([
    ["ordinary issue", { issue: {} }],
    ["ineligible author", {
      comment: { body: `@claude task${PAYLOAD}`, user: { login: "attacker" } },
    }],
    ["question verb", {
      comment: { body: "@claude question why?", user: { login: "syamaner" } },
    }],
  ])("prepare emits proceed=false for an %s", async (_name, overrides) => {
    vi.stubEnv("APPLY_PHASE", "prepare");
    const { request } = requestHarness(overrides);

    await main(request);

    expect(readFileSync(outputPath, "utf8")).toBe("proceed=false\n");
  });

  it("prepare fails before output when its task binding mismatches", async () => {
    vi.stubEnv("APPLY_PHASE", "prepare");
    writeFileSync(bindingPath, JSON.stringify(taskBinding({
      commandPayloadSha256: "f".repeat(64),
    })));
    const { request } = requestHarness();

    await expect(main(request)).rejects.toThrow(/does not match/u);

    expect(existsSync(outputPath)).toBe(false);
  });

  it("prepare rejects a truncated task with feedback and no base SHA", async () => {
    vi.stubEnv("APPLY_PHASE", "prepare");
    const fullPayload = ` ${"x".repeat(4001)}`;
    const retainedPayload = [...fullPayload].slice(0, 4000).join("");
    writeFileSync(bindingPath, JSON.stringify(taskBinding({
      commandPayloadSha256: sha256(retainedPayload),
      taskTruncated: true,
    })));
    const { request, calls } = requestHarness({
      comment: { body: `@claude task${fullPayload}`, user: { login: "syamaner" } },
    });

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    expect(postedBody(calls)).toContain("owner task was truncated");
    expect(postedBody(calls).endsWith(buildTaskApplyMarker(COMMENT_ID))).toBe(true);
    expect(readFileSync(outputPath, "utf8")).toBe("proceed=false\n");
    expect(readFileSync(outputPath, "utf8")).not.toContain("base_sha=");
  });

  it("prepare rejects a blank task with feedback and no base SHA", async () => {
    vi.stubEnv("APPLY_PHASE", "prepare");
    const { request, calls } = requestHarness({
      comment: { body: "@claude task", user: { login: "syamaner" } },
    });

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    expect(postedBody(calls)).toContain("no actionable task description");
    expect(postedBody(calls).endsWith(buildTaskApplyMarker(COMMENT_ID))).toBe(true);
    expect(readFileSync(outputPath, "utf8")).toBe("proceed=false\n");
  });

  it("T-U1.5 decide/apply writes the exact immutable plan and posts nothing", async () => {
    const { request, calls } = requestHarness();

    await main(request);

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([
      "annotations.json",
      "kind",
      "lease_sha",
      "message.txt",
      "parent_sha",
      "ref_name",
      "tree_oid",
    ]);
    expect(readFileSync(join(planDir, "kind"), "utf8")).toBe("apply");
    expect(readFileSync(join(planDir, "tree_oid"), "utf8")).toBe(TREE_OID);
    expect(readFileSync(join(planDir, "parent_sha"), "utf8")).toBe(HEAD_SHA);
    expect(readFileSync(join(planDir, "lease_sha"), "utf8")).toBe(HEAD_SHA);
    expect(readFileSync(join(planDir, "ref_name"), "utf8")).toBe("feature/owner-task");
    expect(readFileSync(join(planDir, "message.txt"), "utf8")).toBe(
      "Owner task:  update tests\n\nOwner-Task-Comment: 101",
    );
    expect(JSON.parse(readFileSync(join(planDir, "annotations.json"), "utf8")))
      .toEqual({
        testFileEdits: [],
        coverageSuppressions: [],
        packageJsonTestScriptEdits: [],
        rootPytestConfigSections: [],
      });
    expect(readFileSync(outputPath, "utf8")).toBe("kind=apply\n");
    expect(calls.some((call) =>
      call.path.endsWith("/branches/feature%2Fowner-task")
    )).toBe(true);
    expect(calls.some((call) => call.path.includes("/compare/"))).toBe(false);
  });

  it("rejects an apply whose head ref is the repository default branch", async () => {
    const { request, calls } = requestHarness({
      pullRequest: eligiblePr({
        head: {
          sha: HEAD_SHA,
          ref: "main",
          repo: { full_name: REPOSITORY, default_branch: "main" },
        },
      }),
    });

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    expect(postedBody(calls)).toContain("repository default branch");
    expect(postedBody(calls).endsWith(buildTaskApplyMarker(COMMENT_ID))).toBe(true);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
    expect(calls.some((call) => call.path.includes("/branches/"))).toBe(false);
  });

  it("T-U1.5b rejects an apply whose base ref is not the repository default branch", async () => {
    const { request, calls } = requestHarness({
      pullRequest: eligiblePr({
        base: {
          sha: BASE_SHA,
          ref: "feature/stack-base",
          repo: { full_name: REPOSITORY, default_branch: "main" },
        },
      }),
    });

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    expect(postedBody(calls)).toContain("rejected at branch-boundary");
    expect(postedBody(calls)).toContain(
      "base is not the repository default branch",
    );
    expect(postedBody(calls).endsWith(buildTaskApplyMarker(COMMENT_ID))).toBe(true);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
    expect(calls.some((call) => call.path.includes("/branches/"))).toBe(false);
  });

  it("T-U1.5c byte-exactly rejects a base ref prefixed by the default branch", async () => {
    const { request, calls } = requestHarness({
      pullRequest: eligiblePr({
        base: {
          sha: BASE_SHA,
          ref: "main-stack",
          repo: { full_name: REPOSITORY, default_branch: "main" },
        },
      }),
    });

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    expect(postedBody(calls)).toContain("rejected at branch-boundary");
    expect(postedBody(calls)).toContain(
      "base is not the repository default branch",
    );
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
    expect(calls.some((call) => call.path.includes("/branches/"))).toBe(false);
  });

  it("rejects an apply whose non-default head ref is protected", async () => {
    const { request, calls } = requestHarness({
      branch: { protected: true },
    });

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    expect(postedBody(calls)).toContain("head is protected");
    expect(postedBody(calls).endsWith(buildTaskApplyMarker(COMMENT_ID))).toBe(true);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it.each([
    [404, "Not Found"],
    [500, "Internal Server Error"],
  ])("fails closed when the branch resource returns %i", async (status, statusText) => {
    const branchError = new GithubApiError(
      "GET",
      `/repos/${REPOSITORY}/branches/feature%2Fowner-task`,
      status,
      statusText,
    );
    const { request, calls } = requestHarness({ branchError });

    await expect(main(request)).rejects.toThrow(`failed: ${status}`);

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it.each([
    ["missing", {}],
    ["non-boolean", { protected: "false" }],
  ])("fails closed for a %s branch protected field", async (_name, branch) => {
    const { request, calls } = requestHarness({ branch });

    await expect(main(request)).rejects.toThrow(/malformed branch protection status/u);

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it.each([
    ["empty", ""],
    ["non-string", null],
  ])("fails closed for a %s repository default branch", async (_name, defaultBranch) => {
    const { request, calls } = requestHarness({
      pullRequest: eligiblePr({
        head: {
          sha: HEAD_SHA,
          ref: "feature/owner-task",
          repo: { full_name: REPOSITORY, default_branch: defaultBranch },
        },
        base: {
          sha: BASE_SHA,
          ref: "main",
          repo: { full_name: REPOSITORY, default_branch: defaultBranch },
        },
      }),
    });

    await expect(main(request)).rejects.toThrow(/malformed .* default branch/u);

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it.each([
    [
      "malformed repository records",
      eligiblePr({
        base: { sha: BASE_SHA, ref: "main", repo: null },
      }),
      /malformed pull-request repositories/u,
    ],
    [
      "omitted default-branch fields",
      eligiblePr({
        head: {
          sha: HEAD_SHA,
          ref: "feature/owner-task",
          repo: { full_name: REPOSITORY },
        },
        base: { sha: BASE_SHA, ref: "main", repo: { full_name: REPOSITORY } },
      }),
      /omitted the repository default branch/u,
    ],
    [
      "inconsistent default-branch fields",
      eligiblePr({
        head: {
          sha: HEAD_SHA,
          ref: "feature/owner-task",
          repo: { full_name: REPOSITORY, default_branch: "main" },
        },
        base: {
          sha: BASE_SHA,
          ref: "main",
          repo: { full_name: REPOSITORY, default_branch: "trunk" },
        },
      }),
      /inconsistent repository default branches/u,
    ],
  ])("fails closed for %s", async (_name, pullRequest, expectedError) => {
    const { request, calls } = requestHarness({ pullRequest });

    await expect(main(request)).rejects.toThrow(expectedError);

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["non-string", 7],
  ])("fails closed for a %s pull-request base ref", async (_name, baseRef) => {
    const base: Record<string, unknown> = {
      sha: BASE_SHA,
      repo: { full_name: REPOSITORY, default_branch: "main" },
    };
    if (baseRef !== undefined) base.ref = baseRef;
    const { request, calls } = requestHarness({
      pullRequest: eligiblePr({ base }),
    });

    await expect(main(request)).rejects.toThrow(/malformed pull-request base ref/u);

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it("accepts one validated default-branch field when the duplicate is omitted", async () => {
    const { request, calls } = requestHarness({
      pullRequest: eligiblePr({
        head: {
          sha: HEAD_SHA,
          ref: "feature/owner-task",
          repo: { full_name: REPOSITORY },
        },
      }),
    });

    await main(request);

    expect(posts(calls)).toEqual([]);
    expect(readFileSync(join(planDir, "kind"), "utf8")).toBe("apply");
    expect(readFileSync(outputPath, "utf8")).toBe("kind=apply\n");
  });

  it("T-U1.7 posts one sanitised, bounded, neutralised rejection", async () => {
    rmSync(analysisDir, { recursive: true });
    mkdirSync(analysisDir);
    writeFileSync(
      join(analysisDir, "failed"),
      Array.from({ length: 20 }, (_, index) =>
        `reason ${index} @codex review <!-- owner-task-apply: 101 --> ${"x".repeat(2000)}`
      ).join("\n"),
    );
    const { request, calls } = requestHarness();

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    const body = postedBody(calls);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
      MAX_OWNER_TASK_COMMENT_BYTES,
    );
    expect(body).toContain("Reasons shown:");
    expect(body).toContain("reason(s) omitted");
    expect(body).toContain("[codex trigger removed]");
    expect(body.match(/<!-- owner-task-apply: 101 -->/g)).toHaveLength(1);
    expect(body.endsWith(buildTaskApplyMarker(COMMENT_ID))).toBe(true);
    expect(planFiles()).toEqual([]);
  });

  it("T-U1.7 posts a stale notice with no plan", async () => {
    const { request, calls } = requestHarness({
      pullRequest: eligiblePr({
        head: {
          sha: DRIFTED_HEAD_SHA,
          ref: "feature/owner-task",
          repo: { full_name: REPOSITORY },
        },
      }),
    });

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    expect(postedBody(calls)).toContain("snapshot is stale");
    expect(postedBody(calls)).not.toContain("Applied-head roster re-validation");
    expect(postedBody(calls).endsWith(buildTaskApplyMarker(COMMENT_ID))).toBe(true);
    expect(planFiles()).toEqual([]);
  });

  it("T1/G4 recognises the exact applied content as one silent no-op", async () => {
    const { request, calls } = requestHarness({
      pullRequest: prWithHeadSha(APPLIED_COMMIT_SHA),
      comparison: {
        status: "ahead",
        total_commits: 1,
        commits: [contentCommit()],
      },
    });

    await main(request);

    expect(calls.filter((call) => call.path.includes("/compare/"))).toEqual([
      expect.objectContaining({
        method: "GET",
        path: `/repos/${REPOSITORY}/compare/${HEAD_SHA}...${APPLIED_COMMIT_SHA}`,
      }),
    ]);
    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it("T2/G2 keeps stale when only the tree matches", async () => {
    const { request, calls } = requestHarness({
      pullRequest: prWithHeadSha(APPLIED_COMMIT_SHA),
      comparison: {
        status: "ahead",
        total_commits: 1,
        commits: [contentCommit({ parents: [{ sha: OTHER_SHA }] })],
      },
    });

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    expect(postedBody(calls)).toContain("snapshot is stale");
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it("F1 byte-exactly rejects a parent with the same 39-hex prefix", async () => {
    const wrongParent = `${HEAD_SHA.slice(0, 39)}d`;
    const { request, calls } = requestHarness({
      pullRequest: prWithHeadSha(APPLIED_COMMIT_SHA),
      comparison: {
        status: "ahead",
        total_commits: 1,
        commits: [contentCommit({ parents: [{ sha: wrongParent }] })],
      },
    });

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    expect(postedBody(calls)).toContain("snapshot is stale");
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it("T3/G1 byte-exactly rejects a tree with the same 39-hex prefix", async () => {
    const wrongTree = `${TREE_OID.slice(0, 39)}d`;
    const { request, calls } = requestHarness({
      pullRequest: prWithHeadSha(APPLIED_COMMIT_SHA),
      comparison: {
        status: "ahead",
        total_commits: 1,
        commits: [contentCommit({ commit: { tree: { sha: wrongTree } } })],
      },
    });

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    expect(postedBody(calls)).toContain("snapshot is stale");
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it.each([
    ["non-record entry", null],
    ["bad commit SHA", contentCommit({ sha: "e".repeat(39) })],
    ["non-record commit", contentCommit({ commit: null })],
    ["non-record tree", contentCommit({ commit: { tree: null } })],
    [
      "bad tree SHA",
      contentCommit({ commit: { tree: { sha: "c".repeat(39) } } }),
    ],
    ["non-array parents", contentCommit({ parents: null })],
    ["non-record parent", contentCommit({ parents: [null] })],
    ["bad parent SHA", contentCommit({ parents: [{ sha: "a".repeat(39) }] })],
  ])("T4/G3 fails closed for a %s", async (_name, candidate) => {
    const { request, calls } = requestHarness({
      pullRequest: prWithHeadSha(APPLIED_COMMIT_SHA),
      comparison: {
        status: "ahead",
        total_commits: 1,
        commits: [candidate],
      },
    });

    await expect(main(request)).rejects.toThrow(TypeError);

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it("F4 rejects non-null non-array parent evidence at the array-shape guard", async () => {
    const { request, calls } = requestHarness({
      pullRequest: prWithHeadSha(APPLIED_COMMIT_SHA),
      comparison: {
        status: "ahead",
        total_commits: 1,
        commits: [contentCommit({ parents: "xx" })],
      },
    });

    await expect(main(request)).rejects.toThrow(
      /malformed comparison commit parents/u,
    );

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it("F5 validates malformed evidence after an earlier content match", async () => {
    const { request, calls } = requestHarness({
      pullRequest: prWithHeadSha(APPLIED_COMMIT_SHA),
      comparison: {
        status: "ahead",
        total_commits: 2,
        commits: [contentCommit(), null],
      },
    });

    await expect(main(request)).rejects.toThrow(TypeError);

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it("F6 validates every parent of a trailing multi-parent commit", async () => {
    const { request, calls } = requestHarness({
      pullRequest: prWithHeadSha(APPLIED_COMMIT_SHA),
      comparison: {
        status: "ahead",
        total_commits: 2,
        commits: [
          contentCommit(),
          contentCommit({
            sha: OTHER_SHA,
            parents: [{ sha: HEAD_SHA }, { sha: "z".repeat(40) }],
          }),
        ],
      },
    });

    await expect(main(request)).rejects.toThrow(
      /malformed comparison commit parent/u,
    );

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it.each([
    ["zero-parent", []],
    ["multi-parent", [{ sha: HEAD_SHA }, { sha: OTHER_SHA }]],
  ])("F3 skips a valid %s non-candidate", async (_name, parents) => {
    const { request, calls } = requestHarness({
      pullRequest: prWithHeadSha(APPLIED_COMMIT_SHA),
      comparison: {
        status: "ahead",
        total_commits: 1,
        commits: [contentCommit({ parents })],
      },
    });

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    expect(postedBody(calls)).toContain("snapshot is stale");
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it.each([
    [
      "unknown status",
      { status: "sideways", total_commits: 1, commits: [contentCommit()] },
    ],
    [
      "missing commits",
      { status: "ahead", total_commits: 1 },
    ],
    [
      "missing total_commits",
      { status: "ahead", commits: [contentCommit()] },
    ],
  ])("T5/G3/G6 rejects %s", async (_name, comparison) => {
    const { request, calls } = requestHarness({
      pullRequest: prWithHeadSha(APPLIED_COMMIT_SHA),
      comparison,
    });

    await expect(main(request)).rejects.toThrow(TypeError);

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it("T6/G7 rejects silently truncated comparison evidence", async () => {
    const { request, calls } = requestHarness({
      pullRequest: prWithHeadSha(APPLIED_COMMIT_SHA),
      comparison: {
        status: "ahead",
        total_commits: 2,
        commits: [contentCommit()],
      },
    });

    await expect(main(request)).rejects.toThrow(/truncated comparison commits/u);

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it("T6/G7 rejects comparisons beyond the replay window", async () => {
    const commits = Array.from({ length: 101 }, () => contentCommit());
    const { request, calls } = requestHarness({
      pullRequest: prWithHeadSha(APPLIED_COMMIT_SHA),
      comparison: {
        status: "ahead",
        total_commits: commits.length,
        commits,
      },
    });

    await expect(main(request)).rejects.toThrow(RangeError);

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it("T7/G5 does not compare when analysis is bound to another base", async () => {
    writeAnalysis({ baseSha: OTHER_SHA });
    const { request, calls } = requestHarness({
      pullRequest: prWithHeadSha(APPLIED_COMMIT_SHA),
      comparison: () => {
        throw new Error("recognition comparison must not be issued");
      },
    });

    await main(request);

    expect(calls.some((call) => call.path.includes("/compare/"))).toBe(false);
    expect(posts(calls)).toHaveLength(1);
    expect(postedBody(calls)).toContain("snapshot is stale");
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it("T9 keeps marker replay ahead of content recognition", async () => {
    const { request, calls } = requestHarness({
      pullRequest: prWithHeadSha(APPLIED_COMMIT_SHA),
      comments: [{
        user: { login: "github-actions[bot]" },
        body: `done\nApplied-Commit: ${APPLIED_COMMIT_SHA}\n${buildTaskApplyMarker(COMMENT_ID)}`,
      }],
      comparison: (path: string) => {
        if (path.endsWith(`/compare/${APPLIED_COMMIT_SHA}...${APPLIED_COMMIT_SHA}`)) {
          return { status: "identical" };
        }
        return {
          status: "ahead",
          total_commits: 1,
          commits: [contentCommit()],
        };
      },
    });

    await main(request);

    expect(calls.filter((call) => call.path.includes("/compare/"))).toEqual([
      expect.objectContaining({
        path: `/repos/${REPOSITORY}/compare/${APPLIED_COMMIT_SHA}...${APPLIED_COMMIT_SHA}`,
      }),
    ]);
    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it("T10 keeps a base-only drift stale on an identical comparison", async () => {
    const { request, calls } = requestHarness({
      pullRequest: eligiblePr({
        base: {
          sha: OTHER_SHA,
          ref: "main",
          repo: { full_name: REPOSITORY, default_branch: "main" },
        },
      }),
      comparison: { status: "identical" },
    });

    await main(request);

    expect(calls.some((call) =>
      call.path.endsWith(`/compare/${HEAD_SHA}...${HEAD_SHA}`)
    )).toBe(true);
    expect(posts(calls)).toHaveLength(1);
    expect(postedBody(calls)).toContain("snapshot is stale");
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it.each(["behind", "diverged"])(
    "T11 keeps stale when content comparison is %s",
    async (status) => {
      const { request, calls } = requestHarness({
        pullRequest: prWithHeadSha(APPLIED_COMMIT_SHA),
        comparison: { status },
      });

      await main(request);

      expect(posts(calls)).toHaveLength(1);
      expect(postedBody(calls)).toContain("snapshot is stale");
      expect(planFiles()).toEqual([]);
      expect(existsSync(outputPath)).toBe(false);
    },
  );

  it("T12 recognises an applied commit that is reachable but not head", async () => {
    const { request, calls } = requestHarness({
      pullRequest: prWithHeadSha(DRIFTED_HEAD_SHA),
      comparison: {
        status: "ahead",
        total_commits: 2,
        commits: [
          contentCommit(),
          contentCommit({
            sha: DRIFTED_HEAD_SHA,
            commit: { tree: { sha: OTHER_SHA } },
            parents: [{ sha: APPLIED_COMMIT_SHA }],
          }),
        ],
      },
    });

    await main(request);

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it("T13 treats comparison 404 as a stale miss", async () => {
    const { request, calls } = requestHarness({
      pullRequest: prWithHeadSha(APPLIED_COMMIT_SHA),
      comparisonError: new GithubApiError(
        "GET",
        `/repos/${REPOSITORY}/compare/${HEAD_SHA}...${APPLIED_COMMIT_SHA}`,
        404,
        "Not Found",
      ),
    });

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    expect(postedBody(calls)).toContain("snapshot is stale");
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it("T13 propagates a generic comparison failure", async () => {
    const { request, calls } = requestHarness({
      pullRequest: prWithHeadSha(APPLIED_COMMIT_SHA),
      comparisonError: new Error("comparison failed"),
    });

    await expect(main(request)).rejects.toThrow(/comparison failed/u);

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it("T-U1.8/T-A1/T-A3/T-A4 posts and re-associates an honest marker-bearing confirmation", async () => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    mkdirSync(planDir);
    writeFileSync(
      join(planDir, "annotations.json"),
      JSON.stringify({ note: "@codex review <!-- owner-task-apply: 101 -->" }),
    );
    writeFileSync(join(planDir, "applied_commit"), `${APPLIED_COMMIT_SHA}\n`);
    writeFileSync(join(planDir, "tree_oid"), TREE_OID);
    writeFileSync(join(planDir, "parent_sha"), HEAD_SHA);
    const { request, calls } = requestHarness({
      appliedCommit: {
        sha: APPLIED_COMMIT_SHA,
        commit: {
          message: `applied\n\nOwner-Task-Comment: ${COMMENT_ID}`,
          tree: { sha: TREE_OID },
        },
        parents: [{ sha: HEAD_SHA }],
      },
    });

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    const body = postedBody(calls);
    expect(body).toContain("applied successfully");
    expect(body).toContain(APPLIED_HEAD_CAVEAT);
    expect(body).toContain("docs/factory-runbook.md");
    expect(body).toContain("Applied-head roster re-validation");
    expect(body.match(/^Applied-Commit: [0-9a-f]{40}$/gmu)).toEqual([
      `Applied-Commit: ${APPLIED_COMMIT_SHA}`,
    ]);
    expect(body).toContain("[codex trigger removed]");
    expect(body).not.toMatch(/@codex review/u);
    expect(body.match(/<!-- owner-task-apply: 101 -->/g)).toHaveLength(1);
    expect(body.endsWith(buildTaskApplyMarker(COMMENT_ID))).toBe(true);

    const replay = requestHarness({
      comments: [{
        user: { login: "github-actions[bot]" },
        body,
      }],
    });
    await main(replay.request);
    expect(posts(replay.calls)).toEqual([]);
    expect(replay.calls.some((call) =>
      call.path.endsWith(`/commits/${APPLIED_COMMIT_SHA}`)
    )).toBe(true);
  });

  it("T-A2 keeps the trusted caveat intact with oversized annotations near their byte cap", async () => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    writeFinalizeArtifacts();
    writeFileSync(
      join(planDir, "annotations.json"),
      JSON.stringify({ note: "😀".repeat(16_000) }),
    );
    const { request, calls } = requestHarness();

    await main(request);

    const body = postedBody(calls);
    expect(body).toContain(APPLIED_HEAD_CAVEAT);
    expect(body.indexOf(APPLIED_HEAD_CAVEAT)).toBeLessThan(
      body.indexOf("Reasons shown:"),
    );
    expect(body).toContain("[truncated,");
    expect(body.endsWith(buildTaskApplyMarker(COMMENT_ID))).toBe(true);
  });

  it("T-A5 finalize records an honest marker-bearing notice after a base retarget", async () => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    writeFinalizeArtifacts();
    const retargetedPullRequest = eligiblePr({
      base: {
        sha: BASE_SHA,
        ref: "feature/retargeted-base",
        repo: { full_name: REPOSITORY, default_branch: "main" },
      },
    });
    const { request, calls } = requestHarness({
      pullRequest: retargetedPullRequest,
    });

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    const body = postedBody(calls);
    expect(body).toContain("base was retargeted after admission");
    expect(body).toContain("re-validation guarantee no longer holds");
    expect(body).toContain("Retarget the pull-request base back to the repository default branch");
    expect(body).toContain("close and reopen the pull request");
    expect(body).toContain("There is no alternate-base path");
    expect(body.indexOf("base was retargeted after admission")).toBeLessThan(
      body.indexOf("Reasons shown:"),
    );
    expect(body.match(/^Applied-Commit: [0-9a-f]{40}$/gmu)).toEqual([
      `Applied-Commit: ${APPLIED_COMMIT_SHA}`,
    ]);
    expect(body).not.toContain("applied successfully");
    expect(body).not.toContain("branch protection blocks merge");
    expect(body).not.toMatch(/@codex review/u);
    expect(body.endsWith(buildTaskApplyMarker(COMMENT_ID))).toBe(true);

    const replay = requestHarness({
      pullRequest: retargetedPullRequest,
      comments: [{
        user: { login: "github-actions[bot]" },
        body,
      }],
    });
    await main(replay.request);
    expect(posts(replay.calls)).toEqual([]);
    expect(replay.calls.some((call) =>
      call.path.endsWith(`/commits/${APPLIED_COMMIT_SHA}`)
    )).toBe(true);
  });

  // MUTATION-CHECK: T-A5b rejects a startsWith weakening of the authoritative
  // finalize base comparison by exercising a default-branch-prefixed base.
  it("T-A5b byte-exactly records the retarget notice for a prefixed base", async () => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    writeFinalizeArtifacts();
    const { request, calls } = requestHarness({
      pullRequest: eligiblePr({
        base: {
          sha: BASE_SHA,
          ref: "main-stack",
          repo: { full_name: REPOSITORY, default_branch: "main" },
        },
      }),
    });

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    const body = postedBody(calls);
    expect(body).toContain("base was retargeted after admission");
    expect(body.match(/^Applied-Commit: [0-9a-f]{40}$/gmu)).toEqual([
      `Applied-Commit: ${APPLIED_COMMIT_SHA}`,
    ]);
    expect(body).not.toContain("applied successfully");
    expect(body).not.toContain("branch protection blocks merge");
    expect(body.endsWith(buildTaskApplyMarker(COMMENT_ID))).toBe(true);
  });

  it("finalize fails closed on malformed bot-owned comment state", async () => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    const { request, calls } = requestHarness({
      comments: [{
        user: { login: "github-actions[bot]" },
        body: 7,
      }],
    });

    await expect(main(request)).rejects.toThrow("bot-authored comment has a malformed body");

    expect(posts(calls)).toEqual([]);
    expect(calls.some((call) => call.path.endsWith(`/issues/comments/${COMMENT_ID}`)))
      .toBe(false);
  });

  it.each([
    [
      "payload hash",
      { body: "@claude task changed task", user: { login: "syamaner" } },
      taskBinding(),
    ],
    [
      "truncation state",
      { body: `@claude task${PAYLOAD}`, user: { login: "syamaner" } },
      taskBinding({ taskTruncated: true }),
    ],
  ])("finalize posts stale instead of success when the source %s drifts", async (
    _name,
    comment,
    binding,
  ) => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    writeFinalizeArtifacts();
    writeFileSync(bindingPath, JSON.stringify(binding));
    const { request, calls } = requestHarness({ comment });

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    expect(postedBody(calls)).toContain("source is stale");
    expect(postedBody(calls)).not.toContain("applied successfully");
    expect(postedBody(calls)).not.toContain("Applied-head roster re-validation");
    expect(postedBody(calls).endsWith(buildTaskApplyMarker(COMMENT_ID))).toBe(true);
    expect(calls.some((call) => call.path.includes(`/commits/${APPLIED_COMMIT_SHA}`)))
      .toBe(false);
  });

  it("finalize does not duplicate a stale notice when a terminal bot marker exists", async () => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    writeFinalizeArtifacts();
    const { request, calls } = requestHarness({
      comments: [{
        user: { login: "github-actions[bot]" },
        body: `prior stale notice\n${buildTaskApplyMarker(COMMENT_ID)}`,
      }],
      comment: { body: "@claude question changed", user: { login: "syamaner" } },
    });

    await main(request);

    expect(posts(calls)).toEqual([]);
    expect(calls.some((call) => call.path.endsWith(`/issues/comments/${COMMENT_ID}`)))
      .toBe(true);
    expect(calls.some((call) => call.path.endsWith(`/commits/${APPLIED_COMMIT_SHA}`)))
      .toBe(false);
  });

  it.each([
    [
      "is no longer an eligible task",
      { comment: { body: "@claude question why?", user: { login: "syamaner" } } },
    ],
    [
      "was deleted",
      { commentError: new GithubApiError("GET", "/source-comment", 404, "Not Found") },
    ],
    [
      "pull request was deleted",
      { pullRequestError: new GithubApiError("GET", "/pull-request", 404, "Not Found") },
    ],
  ])("finalize posts stale when the source task %s", async (_name, overrides) => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    writeFinalizeArtifacts();
    const { request, calls } = requestHarness(overrides);

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    expect(postedBody(calls)).toContain("source");
    expect(postedBody(calls)).toContain("success was not recorded");
    expect(postedBody(calls).endsWith(buildTaskApplyMarker(COMMENT_ID))).toBe(true);
  });

  it.each([
    ["source comment", { commentError: new Error("source fetch failed") }],
    ["pull request", { pullRequestError: new Error("pull-request fetch failed") }],
  ])("finalize propagates a non-404 %s fetch failure without posting", async (
    _name,
    overrides,
  ) => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    writeFinalizeArtifacts();
    const { request, calls } = requestHarness(overrides);

    await expect(main(request)).rejects.toThrow(/fetch failed/u);

    expect(posts(calls)).toEqual([]);
  });

  it("finalize rejects a malformed current PR head SHA before targeted comparison", async () => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    writeFinalizeArtifacts();
    const { request, calls } = requestHarness({
      pullRequest: eligiblePr({
        head: {
          sha: "not-a-sha",
          ref: "feature/owner-task",
          repo: { full_name: REPOSITORY },
        },
      }),
    });

    await expect(main(request)).rejects.toThrow(/malformed pull-request head SHA/u);

    expect(posts(calls)).toEqual([]);
    expect(calls.some((call) => call.path.includes("/compare/"))).toBe(false);
  });

  it("N1 rejects the disjoint question-v3 binding with no output or comment", async () => {
    writeFileSync(bindingPath, JSON.stringify(questionBinding()));
    const { request, calls } = requestHarness();

    await expect(main(request)).rejects.toThrow(/binding artifact is malformed/u);

    expect(posts(calls)).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
    expect(planFiles()).toEqual([]);
  });

  it("N4 rejects a truncated task before reading any analysis artifact", async () => {
    const fullPayload = ` ${"x".repeat(4001)}`;
    const retainedPayload = [...fullPayload].slice(0, 4000).join("");
    writeFileSync(bindingPath, JSON.stringify(taskBinding({
      commandPayloadSha256: sha256(retainedPayload),
      taskTruncated: true,
    })));
    rmSync(analysisDir, { recursive: true });
    const { request, calls } = requestHarness({
      comment: { body: `@claude task${fullPayload}`, user: { login: "syamaner" } },
    });

    await main(request);

    expect(postedBody(calls)).toContain("owner task was truncated");
    expect(postedBody(calls)).not.toContain("analysis artifacts are invalid");
  });

  it.each(["@claude task", "@claude task    "])(
    "rejects a task with no actionable payload: %j",
    async (body) => {
      const { request, calls } = requestHarness({
        comment: { body, user: { login: "syamaner" } },
      });

      await main(request);

      expect(posts(calls)).toHaveLength(1);
      expect(postedBody(calls)).toContain("no actionable task description");
      expect(postedBody(calls).endsWith(buildTaskApplyMarker(COMMENT_ID))).toBe(true);
      expect(planFiles()).toEqual([]);
      expect(existsSync(outputPath)).toBe(false);
    },
  );

  it("N5 rejects a protected path from the applied index", async () => {
    writeAnalysis({
      nameStatus: "M\0scripts/factory/escape.mts\0",
      numstat: "1\t0\tscripts/factory/escape.mts\0",
    });
    const { request, calls } = requestHarness();

    await main(request);

    expect(postedBody(calls)).toContain("protected-path");
    expect(planFiles()).toEqual([]);
  });

  it.each([
    ["binary", "M\0lib/blob.bin\0", "-\t-\tlib/blob.bin\0"],
    ["oversized", "M\0lib/large.ts\0", "401\t0\tlib/large.ts\0"],
    [
      "inert mix",
      "M\0generated/schema.json\0M\0lib/change.ts\0",
      ["1\t0\tgenerated/schema.json\0", "1\t0\tlib/change.ts\0"].join(""),
    ],
  ])("N6 rejects the %s envelope", async (_name, nameStatus, numstat) => {
    writeAnalysis({ nameStatus, numstat });
    const { request, calls } = requestHarness();

    await main(request);

    expect(postedBody(calls)).toContain("envelope");
    expect(planFiles()).toEqual([]);
  });

  it("N7 re-derives an ineligible author and produces no plan or output", async () => {
    rmSync(analysisDir, { recursive: true });
    const { request, calls } = requestHarness({
      comment: { body: `@claude task${PAYLOAD}`, user: { login: "attacker" } },
    });

    await main(request);

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it.each([
    [
      "malformed numstat",
      { numstat: "not-numstat\0" },
      "numstat output contains a malformed record",
    ],
    [
      "different base",
      { baseSha: DRIFTED_HEAD_SHA },
      "patch analysis base does not match the authorised head",
    ],
    [
      "disagreeing streams",
      { numstat: "1\t0\tlib/other.ts\0" },
      "numstat contains a path absent from name-status",
    ],
  ])("N8 rejects shell-report forgery: %s", async (_name, analysis, reason) => {
    writeAnalysis(analysis);
    const { request, calls } = requestHarness();

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    expect(postedBody(calls)).toContain("rejected at patch-analysis");
    expect(postedBody(calls)).toContain(reason);
    expect(postedBody(calls).endsWith(buildTaskApplyMarker(COMMENT_ID))).toBe(true);
    expect(planFiles()).toEqual([]);
  });

  it("N9 marker replay produces no plan and no comment", async () => {
    rmSync(bindingPath);
    rmSync(patchPath);
    rmSync(analysisDir, { recursive: true });
    const { request, calls } = requestHarness({
      comments: [{
        user: { login: "github-actions[bot]" },
        body: `done\n${buildTaskApplyMarker(COMMENT_ID)}`,
      }],
    });

    await main(request);

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
  });

  it("marker replay with a reachable recorded SHA converges without re-applying", async () => {
    rmSync(bindingPath);
    rmSync(patchPath);
    rmSync(analysisDir, { recursive: true });
    const { request, calls } = requestHarness({
      comments: [
        null,
        { user: null, body: "malformed persisted comment" },
        {
          user: { login: "github-actions[bot]" },
          body: "ordinary bot comment without a terminal apply marker",
        },
        {
          user: { login: "github-actions[bot]" },
          body: `done\nApplied-Commit: ${APPLIED_COMMIT_SHA}\n${buildTaskApplyMarker(COMMENT_ID)}`,
        },
      ],
    });

    await main(request);

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(calls.some((call) => call.path.endsWith(`/commits/${APPLIED_COMMIT_SHA}`)))
      .toBe(true);
    expect(calls.some((call) => call.path.includes(`/compare/${HEAD_SHA}...${APPLIED_COMMIT_SHA}`)))
      .toBe(true);
  });

  it("marker replay uses the newest matching bot marker SHA", async () => {
    rmSync(bindingPath);
    rmSync(patchPath);
    rmSync(analysisDir, { recursive: true });
    const { request, calls } = requestHarness({
      comments: [
        {
          user: { login: "github-actions[bot]" },
          body: `old\nApplied-Commit: ${ORPHANED_COMMIT_SHA}\n${buildTaskApplyMarker(COMMENT_ID)}`,
        },
        {
          user: { login: "github-actions[bot]" },
          body: `new\nApplied-Commit: ${APPLIED_COMMIT_SHA}\n${buildTaskApplyMarker(COMMENT_ID)}`,
        },
      ],
    });

    await main(request);

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(calls.some((call) => call.path.endsWith(`/commits/${APPLIED_COMMIT_SHA}`)))
      .toBe(true);
    expect(calls.some((call) => call.path.endsWith(`/commits/${ORPHANED_COMMIT_SHA}`)))
      .toBe(false);
  });

  it("marker replay ignores a newer no-SHA bot notice and re-checks the last success SHA", async () => {
    const { request, calls } = requestHarness({
      comments: [
        {
          user: { login: "github-actions[bot]" },
          body: `applied\nApplied-Commit: ${APPLIED_COMMIT_SHA}\n${buildTaskApplyMarker(COMMENT_ID)}`,
        },
        {
          user: { login: "github-actions[bot]" },
          body: `Owner task rejected: stale input.\n${buildTaskApplyMarker(COMMENT_ID)}`,
        },
      ],
      comparison: { status: "diverged" },
    });

    await main(request);

    expect(calls.some((call) => call.path.endsWith(`/commits/${APPLIED_COMMIT_SHA}`)))
      .toBe(true);
    expect(calls.some((call) => call.path.includes(`/compare/${HEAD_SHA}...${APPLIED_COMMIT_SHA}`)))
      .toBe(true);
    expect(posts(calls)).toEqual([]);
    expect(readFileSync(join(planDir, "kind"), "utf8")).toBe("apply");
    expect(readFileSync(outputPath, "utf8")).toBe("kind=apply\n");
  });

  it.each(["diverged", "ahead"])(
    "marker replay re-applies when comparison status is %s",
    async (status) => {
      const { request, calls } = requestHarness({
        comments: [{
          user: { login: "github-actions[bot]" },
          body: `done\nApplied-Commit: ${APPLIED_COMMIT_SHA}\n${buildTaskApplyMarker(COMMENT_ID)}`,
        }],
        comparison: { status },
      });

      await main(request);

      expect(posts(calls)).toEqual([]);
      expect(readFileSync(join(planDir, "kind"), "utf8")).toBe("apply");
      expect(readFileSync(outputPath, "utf8")).toBe("kind=apply\n");
    },
  );

  it("marker replay re-applies when its recorded commit no longer exists", async () => {
    const { request, calls } = requestHarness({
      comments: [{
        user: { login: "github-actions[bot]" },
        body: `done\nApplied-Commit: ${APPLIED_COMMIT_SHA}\n${buildTaskApplyMarker(COMMENT_ID)}`,
      }],
      appliedCommitError: new GithubApiError(
        "GET",
        `/repos/${REPOSITORY}/commits/${APPLIED_COMMIT_SHA}`,
        404,
        "Not Found",
      ),
    });

    await main(request);

    expect(posts(calls)).toEqual([]);
    expect(readFileSync(join(planDir, "kind"), "utf8")).toBe("apply");
  });

  it("marker replay fails closed when compare returns 404 after commit fetch succeeds", async () => {
    const { request, calls } = requestHarness({
      comments: [{
        user: { login: "github-actions[bot]" },
        body: `done\nApplied-Commit: ${APPLIED_COMMIT_SHA}\n${buildTaskApplyMarker(COMMENT_ID)}`,
      }],
      comparisonError: new GithubApiError(
        "GET",
        `/repos/${REPOSITORY}/compare/${HEAD_SHA}...${APPLIED_COMMIT_SHA}`,
        404,
        "Not Found",
      ),
    });

    await expect(main(request)).rejects.toThrow(/compare.*failed: 404/u);

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(existsSync(outputPath)).toBe(false);
  });

  it.each([
    [
      "a non-404 targeted fetch failure",
      { appliedCommitError: new Error("targeted fetch failed") },
      /targeted fetch failed/u,
    ],
    [
      "a malformed comparison status",
      { comparison: { status: "sideways" } },
      /malformed commit comparison status/u,
    ],
  ])("marker replay fails closed on %s", async (_name, overrides, expectedError) => {
    const { request, calls } = requestHarness({
      comments: [{
        user: { login: "github-actions[bot]" },
        body: `done\nApplied-Commit: ${APPLIED_COMMIT_SHA}\n${buildTaskApplyMarker(COMMENT_ID)}`,
      }],
      ...overrides,
    });

    await expect(main(request)).rejects.toThrow(expectedError);

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
  });

  it("does not associate a non-bot Applied-Commit line with a legacy bot marker", async () => {
    rmSync(bindingPath);
    rmSync(patchPath);
    rmSync(analysisDir, { recursive: true });
    const { request, calls } = requestHarness({
      comments: [
        {
          user: { login: "attacker" },
          body: `Applied-Commit: ${APPLIED_COMMIT_SHA}\n${buildTaskApplyMarker(COMMENT_ID)}`,
        },
        {
          user: { login: "github-actions[bot]" },
          body: `legacy success\n${buildTaskApplyMarker(COMMENT_ID)}`,
        },
      ],
    });

    await main(request);

    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
    expect(calls.some((call) => call.path.endsWith(`/commits/${APPLIED_COMMIT_SHA}`)))
      .toBe(false);
  });

  it("N9 marker replay converges before the >100-commit window guard", async () => {
    rmSync(bindingPath);
    rmSync(patchPath);
    rmSync(analysisDir, { recursive: true });
    const { request, calls } = requestHarness({
      pullRequest: eligiblePr({ commits: 101 }),
      comments: [{
        user: { login: "github-actions[bot]" },
        body: `already converged\n${buildTaskApplyMarker(COMMENT_ID)}`,
      }],
    });

    await expect(main(request)).resolves.toBeUndefined();

    expect(calls.some((call) => call.path.includes("/commits?"))).toBe(false);
    expect(posts(calls)).toEqual([]);
    expect(planFiles()).toEqual([]);
  });

  it("ignores a forged task trailer and proceeds to the real apply decision", async () => {
    const { request, calls } = requestHarness({
      commits: [{ commit: { message: `subject\n\nOwner-Task-Comment: ${COMMENT_ID}` } }],
    });

    await main(request);

    expect(posts(calls)).toEqual([]);
    expect(readFileSync(join(planDir, "kind"), "utf8")).toBe("apply");
    expect(calls.some((call) => call.path.includes("/commits?"))).toBe(false);
  });

  it.each(["-oProxyCommand=x", "a..b", "a b", "x.lock", "@{u}", ""])(
    "N10 rejects hostile refname %j before writing a plan",
    async (ref) => {
      const { request, calls } = requestHarness({
        pullRequest: eligiblePr({
          head: { sha: HEAD_SHA, ref, repo: { full_name: REPOSITORY } },
        }),
      });

      await expect(main(request)).rejects.toThrow(/head ref/u);

      expect(posts(calls)).toEqual([]);
      expect(planFiles()).toEqual([]);
    },
  );

  it("N11 rejects a >100-commit PR before the commit-list fetch", async () => {
    const { request, calls } = requestHarness({ pullRequest: eligiblePr({ commits: 101 }) });

    await expect(main(request)).rejects.toThrow(/100-commit/u);

    expect(calls.some((call) => call.path.includes("/commits?"))).toBe(false);
  });

  it.each(["absent", "zero-byte"])("N12 rejects a %s patch artifact", async (kind) => {
    if (kind === "absent") rmSync(patchPath);
    else writeFileSync(patchPath, "");
    rmSync(analysisDir, { recursive: true });
    const { request, calls } = requestHarness();

    await main(request);

    expect(postedBody(calls)).toContain("patch-artifact");
    expect(planFiles()).toEqual([]);
  });

  it("N13 rejects a malformed comments page", async () => {
    const { request, calls } = requestHarness({ comments: {} });

    await expect(main(request)).rejects.toThrow(/malformed/u);

    expect(posts(calls)).toEqual([]);
  });

  it("N14 rejects an unknown phase before any request", async () => {
    vi.stubEnv("APPLY_PHASE", "mutate");
    const { request, calls } = requestHarness();

    await expect(main(request)).rejects.toThrow(/APPLY_PHASE/u);

    expect(calls).toEqual([]);
  });

  it.each([
    ["GITHUB_REPOSITORY", "not-a-repository"],
    ["TARGET_PR_NUMBER", "09"],
    ["COMMENT_ID", "999999999999999999999999"],
    ["GITHUB_RUN_ID", "1.5"],
    ["PATCH_ARTIFACT_PATH", ""],
  ])("validates %s before any request", async (name, value) => {
    vi.stubEnv(name, value);
    const { request, calls } = requestHarness();

    await expect(main(request)).rejects.toThrow();

    expect(calls).toEqual([]);
  });

  it("N15 turns ANALYSIS_DIR/failed into a bounded rejection reason", async () => {
    rmSync(analysisDir, { recursive: true });
    mkdirSync(analysisDir);
    writeFileSync(join(analysisDir, "failed"), `@codex review ${"x".repeat(5000)}`);
    const { request, calls } = requestHarness();

    await main(request);

    const body = postedBody(calls);
    expect(body).toContain("patch-analysis");
    expect(body).toContain("[truncated,");
    expect(body).toContain("[codex trigger removed]");
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(MAX_OWNER_TASK_COMMENT_BYTES);
  });

  it("N16 rejects an oversized analysis file before parsing it", async () => {
    writeFileSync(
      join(analysisDir, "diff"),
      "x".repeat(MAX_OWNER_TASK_DIFF_BYTES + 1),
    );
    const { request, calls } = requestHarness();

    await main(request);

    expect(postedBody(calls)).toContain("exceeds the");
    expect(postedBody(calls)).toContain("before read");
    expect(planFiles()).toEqual([]);
  });

  it("finalize is idempotent when its recorded marker commit is reachable", async () => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    const { request, calls } = requestHarness({
      comments: [{
        user: { login: "github-actions[bot]" },
        body: `already done\nApplied-Commit: ${APPLIED_COMMIT_SHA}\n${buildTaskApplyMarker(COMMENT_ID)}`,
      }],
    });

    await main(request);

    expect(posts(calls)).toEqual([]);
    expect(calls.some((call) => call.path.endsWith(`/commits/${APPLIED_COMMIT_SHA}`)))
      .toBe(true);
    expect(calls.some((call) => call.path.endsWith(`/issues/comments/${COMMENT_ID}`)))
      .toBe(false);
  });

  it("finalize re-records a valid replacement after the prior marker commit is orphaned", async () => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    writeFinalizeArtifacts();
    const { request, calls } = requestHarness({
      comments: [{
        user: { login: "github-actions[bot]" },
        body: `old success\nApplied-Commit: ${ORPHANED_COMMIT_SHA}\n${buildTaskApplyMarker(COMMENT_ID)}`,
      }],
      appliedCommit: (path: string) => path.endsWith(ORPHANED_COMMIT_SHA)
        ? { sha: ORPHANED_COMMIT_SHA }
        : {
          sha: APPLIED_COMMIT_SHA,
          commit: {
            message: `applied\n\nOwner-Task-Comment: ${COMMENT_ID}`,
            tree: { sha: TREE_OID },
          },
          parents: [{ sha: HEAD_SHA }],
        },
      comparison: (path: string) => ({
        status: path.endsWith(ORPHANED_COMMIT_SHA) ? "diverged" : "behind",
      }),
    });

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    expect(postedBody(calls)).toContain(`Applied-Commit: ${APPLIED_COMMIT_SHA}`);
    expect(postedBody(calls).endsWith(buildTaskApplyMarker(COMMENT_ID))).toBe(true);
    expect(calls.some((call) => call.path.endsWith(`/commits/${ORPHANED_COMMIT_SHA}`)))
      .toBe(true);
    expect(calls.some((call) => call.path.endsWith(`/commits/${APPLIED_COMMIT_SHA}`)))
      .toBe(true);
  });

  it("finalize re-records success when an existing marker has no applied SHA", async () => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    writeFinalizeArtifacts();
    const { request, calls } = requestHarness({
      comments: [{
        user: { login: "github-actions[bot]" },
        body: `legacy success\n${buildTaskApplyMarker(COMMENT_ID)}`,
      }],
    });

    await main(request);

    expect(posts(calls)).toHaveLength(1);
    expect(postedBody(calls)).toContain(`Applied-Commit: ${APPLIED_COMMIT_SHA}`);
    expect(postedBody(calls).endsWith(buildTaskApplyMarker(COMMENT_ID))).toBe(true);
  });

  it("finalize fails closed when existing-marker reachability errors", async () => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    const { request, calls } = requestHarness({
      comments: [{
        user: { login: "github-actions[bot]" },
        body: `old success\nApplied-Commit: ${ORPHANED_COMMIT_SHA}\n${buildTaskApplyMarker(COMMENT_ID)}`,
      }],
      appliedCommitError: new Error("existing marker reachability failed"),
    });

    await expect(main(request)).rejects.toThrow("existing marker reachability failed");

    expect(posts(calls)).toEqual([]);
    expect(calls.some((call) => call.path.endsWith(`/issues/comments/${COMMENT_ID}`)))
      .toBe(false);
  });
});
