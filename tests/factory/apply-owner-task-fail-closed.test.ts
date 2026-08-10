import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_OWNER_TASK_ANALYSIS_FILE_BYTES,
  MAX_OWNER_TASK_COMMENT_BYTES,
  MAX_PLAN_ANNOTATIONS_BYTES,
  buildBoundedMarkedComment,
  main,
  readOptionalCappedFile,
  readPatchAnalysis,
  type GithubRequest,
} from "../../scripts/factory/apply-owner-task.mts";
import { buildTaskApplyMarker } from "../../scripts/factory/owner-task-patch-logic.mts";

const REPOSITORY = "syamaner/roastpilot-cloud";
const PR_NUMBER = 9;
const COMMENT_ID = 101;
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const TREE_OID = "c".repeat(40);
const APPLIED_COMMIT_SHA = "e".repeat(40);
const PAYLOAD = " update tests";

let root: string;
let bindingPath: string;
let patchPath: string;
let analysisDir: string;
let planDir: string;
let outputPath: string;

type RequestCall = {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function binding(): Record<string, unknown> {
  return {
    version: 1,
    kind: "owner-task",
    prHeadSha: HEAD_SHA,
    prBaseSha: BASE_SHA,
    commandPayloadSha256: sha256(PAYLOAD),
    taskTruncated: false,
  };
}

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    head: {
      sha: HEAD_SHA,
      ref: "feature/owner-task",
      repo: { full_name: REPOSITORY, default_branch: "main" },
    },
    base: {
      sha: BASE_SHA,
      repo: { full_name: REPOSITORY, default_branch: "main" },
    },
    state: "open",
    merged: false,
    commits: 1,
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
  writeFileSync(join(analysisDir, "name_status"), input.nameStatus ?? "M\0lib/x.ts\0");
  writeFileSync(join(analysisDir, "numstat"), input.numstat ?? "1\t0\tlib/x.ts\0");
  writeFileSync(join(analysisDir, "diff"), input.diff ?? "+safe\n");
}

function writePlanIdentity(
  treeOid = TREE_OID,
  parentSha = HEAD_SHA,
): void {
  writeFileSync(join(planDir, "tree_oid"), treeOid);
  writeFileSync(join(planDir, "parent_sha"), parentSha);
}

function writeFinalizeArtifacts(): void {
  mkdirSync(planDir);
  writeFileSync(join(planDir, "annotations.json"), "[]");
  writeFileSync(join(planDir, "applied_commit"), `${APPLIED_COMMIT_SHA}\n`);
  writePlanIdentity();
}

function harness(overrides: {
  readonly comment?: unknown;
  readonly issue?: unknown;
  readonly pullRequest?: unknown;
  readonly comments?: unknown | ((page: number) => unknown);
  readonly commits?: unknown;
  readonly appliedCommit?: unknown;
  readonly comparison?: unknown;
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
    if (method === "POST") response = { id: 500 };
    else if (path.includes("/branches/")) {
      if (overrides.branchError !== undefined) throw overrides.branchError;
      response = overrides.branch ?? { protected: false };
    } else if (path.endsWith(`/issues/comments/${COMMENT_ID}`)) {
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
      response = overrides.appliedCommit ?? {
        sha: APPLIED_COMMIT_SHA,
        commit: {
          message: `applied\n\nOwner-Task-Comment: ${COMMENT_ID}`,
          tree: { sha: TREE_OID },
        },
        parents: [{ sha: HEAD_SHA }],
      };
    } else if (path.includes("/compare/")) {
      response = overrides.comparison ?? { status: "behind" };
    } else if (path.endsWith(`/pulls/${PR_NUMBER}`)) {
      response = overrides.pullRequest ?? pullRequest();
    } else if (path.includes(`/issues/${PR_NUMBER}/comments?`)) {
      const page = Number(new URL(`https://example.test${path}`).searchParams.get("page"));
      response = typeof overrides.comments === "function"
        ? overrides.comments(page)
        : overrides.comments ?? [];
    } else throw new Error(`unexpected request ${method} ${path}`);
    return response as T;
  };
  return { request, calls };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "apply-owner-task-fail-closed-"));
  bindingPath = join(root, "binding.json");
  patchPath = join(root, "patch.diff");
  analysisDir = join(root, "analysis");
  planDir = join(root, "plan");
  outputPath = join(root, "output");
  vi.stubEnv("APPLY_PHASE", "decide");
  vi.stubEnv("GH_TOKEN", "token");
  vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
  vi.stubEnv("TARGET_PR_NUMBER", String(PR_NUMBER));
  vi.stubEnv("COMMENT_ID", String(COMMENT_ID));
  vi.stubEnv("GITHUB_RUN_ID", "123");
  vi.stubEnv("BINDING_ARTIFACT_PATH", bindingPath);
  vi.stubEnv("PATCH_ARTIFACT_PATH", patchPath);
  vi.stubEnv("ANALYSIS_DIR", analysisDir);
  vi.stubEnv("PLAN_DIR", planDir);
  vi.stubEnv("GITHUB_OUTPUT", outputPath);
  writeFileSync(bindingPath, JSON.stringify(binding()));
  writeFileSync(patchPath, "patch");
  writeAnalysis();
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("owner-task git report grammar", () => {
  it("accepts real zero-padded partial rename/copy scores and preserves both paths", () => {
    writeAnalysis({
      nameStatus: [
        "R087\0tests/old.test.ts\0tests/new.test.ts\0",
        "C075\0tests/source.test.ts\0tests/copy.test.ts\0",
      ].join(""),
      numstat: [
        "1\t1\t\0tests/old.test.ts\0tests/new.test.ts\0",
        "2\t0\ttests/copy.test.ts\0",
      ].join(""),
    });

    expect(readPatchAnalysis(analysisDir)).toEqual({
      status: "ok",
      analysis: {
        baseSha: HEAD_SHA,
        treeOid: TREE_OID,
        changedPaths: [
          "tests/old.test.ts",
          "tests/new.test.ts",
          "tests/source.test.ts",
          "tests/copy.test.ts",
        ],
        diffText: "+safe\n",
        lineStats: [
          {
            path: "tests/new.test.ts",
            sourcePath: "tests/old.test.ts",
            additions: 1,
            deletions: 1,
          },
          {
            path: "tests/copy.test.ts",
            additions: 2,
            deletions: 0,
          },
        ],
      },
    });
  });

  it.each([
    ["plain modification", "M\0lib/x.ts\0"],
    ["copy destination", "C075\0lib/source.ts\0lib/copy.ts\0"],
    ["rename source and destination", "R087\0lib/old.ts\0lib/new.ts\0"],
  ])("rejects incomplete numstat coverage for a %s", (_name, nameStatus) => {
    writeAnalysis({ nameStatus, numstat: "" });

    expect(readPatchAnalysis(analysisDir)).toMatchObject({
      status: "failed",
      reasons: [expect.stringContaining("incomplete numstat")],
    });
  });

  it.each(["R09", "Z", "R1000"])("rejects malformed status %s", (status) => {
    writeAnalysis({ nameStatus: `${status}\0old\0new\0` });

    expect(readPatchAnalysis(analysisDir)).toMatchObject({
      status: "failed",
      reasons: [expect.stringContaining("invalid status")],
    });
  });

  it.each([
    ["non-NUL-terminated", "M\0lib/x.ts", "not NUL-terminated"],
    ["missing rename path", "R087\0old\0", "missing path"],
    ["empty single path", "M\0\0", "missing path"],
  ])("rejects %s name-status output", (_name, nameStatus, reason) => {
    writeAnalysis({ nameStatus });

    expect(readPatchAnalysis(analysisDir)).toMatchObject({
      status: "failed",
      reasons: [expect.stringContaining(reason)],
    });
  });

  it("accepts structurally empty streams for the decision layer to reject", () => {
    writeAnalysis({ nameStatus: "", numstat: "" });

    expect(readPatchAnalysis(analysisDir)).toMatchObject({
      status: "ok",
      analysis: { changedPaths: [], lineStats: [] },
    });
  });

  it("accepts a regenerated diff larger than the input-patch cap", () => {
    writeAnalysis({ diff: "x".repeat(MAX_OWNER_TASK_ANALYSIS_FILE_BYTES + 1) });

    expect(readPatchAnalysis(analysisDir)).toMatchObject({ status: "ok" });
  });
});

describe("owner-task fail-closed artifacts and API state", () => {
  it("rejects a file truncated after fstat instead of returning its prefix", () => {
    writeFileSync(bindingPath, "complete");
    let truncated = false;

    expect(() => readOptionalCappedFile(
      bindingPath,
      64,
      (fd, buffer, offset, length, position) => {
        if (!truncated) {
          truncateSync(bindingPath, 2);
          truncated = true;
        }
        return readSync(fd, buffer, offset, length, position);
      },
    )).toThrow(`artifact at ${bindingPath} changed size during read`);
  });

  it.each([
    ["comment record", { comment: [] }, /malformed issue comment/u],
    ["issue record", { issue: [] }, /malformed issue/u],
    ["pull-request record", { pullRequest: [] }, /malformed pull request/u],
    ["comment body", { comment: { body: 7, user: { login: "syamaner" } } }, /malformed issue comment/u],
    ["comment user", { comment: { body: `@claude task${PAYLOAD}`, user: null } }, /malformed issue comment/u],
  ])("rejects malformed fetched %s", async (_name, overrides, pattern) => {
    const { request } = harness(overrides);

    await expect(main(request)).rejects.toThrow(pattern);
  });

  it.each([
    ["missing", () => rmSync(bindingPath), /binding artifact is missing/u],
    ["directory", () => {
      rmSync(bindingPath);
      mkdirSync(bindingPath);
    }, /not a regular file/u],
    ["oversized", () => writeFileSync(bindingPath, "x".repeat(256 * 1024 + 1)), /exceeds the/u],
    ["invalid UTF-8", () => writeFileSync(bindingPath, Buffer.from([0xff])), /encoded data/u],
    ["non-ENOENT open failure", () => {
      vi.stubEnv("BINDING_ARTIFACT_PATH", join(bindingPath, "child"));
    }, /ENOTDIR|not a directory/iu],
  ])("prepare rejects a %s binding artifact", async (_name, arrange, pattern) => {
    vi.stubEnv("APPLY_PHASE", "prepare");
    arrange();
    const { request } = harness();

    await expect(main(request)).rejects.toThrow(pattern);
  });

  it.each([
    ["missing required diff", () => rmSync(join(analysisDir, "diff")), "required artifact is missing"],
    ["directory artifact", () => {
      rmSync(join(analysisDir, "diff"));
      mkdirSync(join(analysisDir, "diff"));
    }, "not a regular file"],
    ["bad base SHA", () => writeFileSync(join(analysisDir, "base_sha"), "bad\n"), "not a full SHA"],
    ["oversized name-status", () => writeFileSync(
      join(analysisDir, "name_status"),
      "x".repeat(MAX_OWNER_TASK_ANALYSIS_FILE_BYTES + 1),
    ), "before read"],
    ["shape-invalid numstat", () => writeFileSync(join(analysisDir, "numstat"), "bad\0"), "malformed record"],
    ["disagreeing streams", () => writeFileSync(
      join(analysisDir, "numstat"),
      "1\t0\tlib/other.ts\0",
    ), "absent from name-status"],
  ])("returns failed analysis for %s", (_name, arrange, reason) => {
    arrange();

    expect(readPatchAnalysis(analysisDir)).toMatchObject({
      status: "failed",
      reasons: [expect.stringContaining(reason)],
    });
  });

  it("supplies an explicit reason when the failed sentinel is empty", () => {
    writeFileSync(join(analysisDir, "failed"), "");

    expect(readPatchAnalysis(analysisDir)).toEqual({
      status: "failed",
      reasons: ["patch analysis failed without a diagnostic reason"],
    });
  });

  it("rejects non-array comments and the 50-page completeness overflow", async () => {
    const malformed = harness({ comments: {} });
    await expect(main(malformed.request)).rejects.toThrow(/malformed issue comments/u);

    const fullPage = Array.from({ length: 100 }, () => ({
      user: { login: "someone" },
      body: "unrelated",
    }));
    const overflowing = harness({ comments: () => fullPage });
    await expect(main(overflowing.request)).rejects.toThrow(/pagination exceeded/u);
    expect(overflowing.calls.filter((call) => call.path.includes("/comments?")))
      .toHaveLength(50);
  });

  it.each([undefined, "1", -1, 1.5])(
    "rejects malformed PR commit count %s",
    async (commits) => {
      const { request } = harness({ pullRequest: pullRequest({ commits }) });

      await expect(main(request)).rejects.toThrow(/commit count/u);
    },
  );

  it("treats a directory patch artifact as empty", async () => {
    rmSync(patchPath);
    mkdirSync(patchPath);
    const directory = harness();
    await main(directory.request);
    expect(directory.calls.some((call) => call.method === "POST")).toBe(true);
  });

  it("propagates a non-ENOENT patch stat failure", async () => {
    vi.stubEnv("PATCH_ARTIFACT_PATH", join(bindingPath, "child"));
    const { request } = harness();

    await expect(main(request)).rejects.toThrow(/ENOTDIR|not a directory/iu);
  });
});

describe("owner-task bounded comments and plan guards", () => {
  it("drops reasons at the byte cap with a visible omission count", () => {
    const reasons = Array.from({ length: 10 }, () => "😀".repeat(1200));

    const body = buildBoundedMarkedComment("heading", reasons, COMMENT_ID);
    const shown = Number(/Reasons shown: (\d+) of 10/u.exec(body)?.[1]);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(10);
    expect(body).toContain(`${10 - shown} reason(s) omitted`);
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(MAX_OWNER_TASK_COMMENT_BYTES);
    expect(body.endsWith(buildTaskApplyMarker(COMMENT_ID))).toBe(true);
  });

  it("rejects trusted framing that alone exceeds the byte cap", () => {
    expect(() => buildBoundedMarkedComment(
      "x".repeat(MAX_OWNER_TASK_COMMENT_BYTES + 1),
      [],
      COMMENT_ID,
    )).toThrow(/framing exceeds/u);
  });

  it.each([
    { sha: HEAD_SHA, ref: 7, repo: { full_name: REPOSITORY } },
    { sha: HEAD_SHA, ref: "/leading", repo: { full_name: REPOSITORY } },
    { sha: HEAD_SHA, ref: "trailing/", repo: { full_name: REPOSITORY } },
    { sha: HEAD_SHA, ref: "trailing.", repo: { full_name: REPOSITORY } },
    { sha: HEAD_SHA, ref: "a//b", repo: { full_name: REPOSITORY } },
    { sha: HEAD_SHA, ref: ".hidden/x", repo: { full_name: REPOSITORY } },
  ])("rejects malformed or unsafe head ref %#", async (head) => {
    const { request } = harness({ pullRequest: pullRequest({ head }) });

    await expect(main(request)).rejects.toThrow(/head ref/u);
  });

  it("refuses to write over a non-empty plan directory", async () => {
    mkdirSync(planDir);
    writeFileSync(join(planDir, "stale"), "do not overwrite");
    const { request } = harness();

    await expect(main(request)).rejects.toThrow(/PLAN_DIR must be empty/u);
    expect(readFileSync(join(planDir, "stale"), "utf8")).toBe("do not overwrite");
  });

  it("bounds oversized plan annotations and finalize still posts convergence", async () => {
    const hugeTestPath = `tests/${"x".repeat(MAX_PLAN_ANNOTATIONS_BYTES)}.test.ts`;
    writeAnalysis({
      nameStatus: `M\0${hugeTestPath}\0`,
      numstat: `1\t0\t${hugeTestPath}\0`,
    });
    const applyRun = harness();

    await main(applyRun.request);

    const rawAnnotations = readFileSync(join(planDir, "annotations.json"), "utf8");
    expect(Buffer.byteLength(rawAnnotations, "utf8"))
      .toBeLessThanOrEqual(MAX_PLAN_ANNOTATIONS_BYTES);
    const boundedAnnotations = JSON.parse(rawAnnotations) as Record<string, unknown>;
    expect(boundedAnnotations).toEqual(expect.objectContaining({
      bounded: true,
      disclosure: expect.stringContaining("full advisory annotations exceeded"),
      originalBytes: expect.any(Number),
      counts: expect.objectContaining({ testFileEdits: 1 }),
    }));
    expect(boundedAnnotations.originalBytes).toBeTypeOf("number");
    expect(boundedAnnotations.originalBytes as number)
      .toBeGreaterThan(MAX_PLAN_ANNOTATIONS_BYTES);

    writeFileSync(join(planDir, "applied_commit"), `${APPLIED_COMMIT_SHA}\n`);
    vi.stubEnv("APPLY_PHASE", "finalize");
    const finalizeRun = harness({
      appliedCommit: {
        sha: APPLIED_COMMIT_SHA,
        commit: {
          message: `applied\n\nOwner-Task-Comment: ${COMMENT_ID}`,
          tree: { sha: TREE_OID },
        },
        parents: [{ sha: HEAD_SHA }],
      },
    });
    await main(finalizeRun.request);
    const post = finalizeRun.calls.find((call) => call.method === "POST");
    const body = (post?.body as { body?: unknown } | undefined)?.body;
    expect(body).toEqual(expect.stringContaining("full advisory annotations exceeded"));
    expect(body).toEqual(expect.stringMatching(/<!-- owner-task-apply: 101 -->$/u));
  });

  it("decide exits silently for an ordinary issue through the ignore handler", async () => {
    const { request, calls } = harness({ issue: {} });

    await main(request);

    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
});

describe("owner-task replay-window and finalize convergence", () => {
  it("reserves commit 100 for replay instead of emitting an apply plan", async () => {
    const commits = Array.from({ length: 100 }, () => ({
      commit: { message: "existing commit" },
    }));
    const { request, calls } = harness({
      pullRequest: pullRequest({ commits: 100 }),
      commits,
    });

    await main(request);

    const posts = calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
    expect((posts[0]!.body as { body: string }).body).toContain(
      "PR has too many commits for the owner-task replay window; reduce commits and re-issue",
    );
    expect((posts[0]!.body as { body: string }).body.endsWith(
      buildTaskApplyMarker(COMMENT_ID),
    )).toBe(true);
    expect(() => readFileSync(join(planDir, "kind"), "utf8")).toThrow();
    expect(() => readFileSync(outputPath, "utf8")).toThrow();
  });

  it("allows an apply at commit 99", async () => {
    const commits = Array.from({ length: 99 }, () => ({
      commit: { message: "existing commit" },
    }));
    const { request, calls } = harness({
      pullRequest: pullRequest({ commits: 99 }),
      commits,
    });

    await main(request);

    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
    expect(readFileSync(join(planDir, "kind"), "utf8")).toBe("apply");
    expect(readFileSync(outputPath, "utf8")).toBe("kind=apply\n");
  });

  it("does not trust a forged trailer at the 100-commit apply boundary", async () => {
    const commits = Array.from({ length: 100 }, (_, index) => ({
      commit: {
        message: index === 99
          ? `applied\n\nOwner-Task-Comment: ${COMMENT_ID}`
          : "existing commit",
      },
    }));
    const { request, calls } = harness({
      pullRequest: pullRequest({ commits: 100 }),
      commits,
    });

    await main(request);

    const posts = calls.filter((call) => call.method === "POST");
    expect(posts).toHaveLength(1);
    expect((posts[0]!.body as { body: string }).body).toContain("replay window");
    expect((posts[0]!.body as { body: string }).body).not.toContain("already applied");
    expect(calls.some((call) => call.path.includes("/commits?"))).toBe(false);
    expect(() => readFileSync(join(planDir, "kind"), "utf8")).toThrow();
  });

  it("finalize fails closed when applied_commit is absent", async () => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    mkdirSync(planDir);
    writeFileSync(join(planDir, "annotations.json"), "[]");
    const { request, calls } = harness();

    await expect(main(request)).rejects.toThrow(/required artifact is missing/u);

    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("finalize fails closed when the task binding is absent", async () => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    rmSync(bindingPath);
    mkdirSync(planDir);
    writeFileSync(join(planDir, "annotations.json"), "[]");
    writeFileSync(join(planDir, "applied_commit"), `${APPLIED_COMMIT_SHA}\n`);
    const { request, calls } = harness();

    await expect(main(request)).rejects.toThrow(/binding artifact is missing/u);

    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("finalize fails closed when applied_commit is not an ancestor of PR head", async () => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    mkdirSync(planDir);
    writeFileSync(join(planDir, "annotations.json"), "[]");
    writeFileSync(join(planDir, "applied_commit"), `${APPLIED_COMMIT_SHA}\n`);
    const { request, calls } = harness({ comparison: { status: "diverged" } });

    await expect(main(request)).rejects.toThrow(/not an ancestor/u);

    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it.each([
    [
      "does not carry the task trailer",
      { message: "existing parent commit" },
      /expected owner-task trailer/u,
    ],
    ["has a malformed message", {}, /malformed message/u],
  ])("finalize fails closed when the reachable commit %s", async (
    _name,
    commit,
    expectedError,
  ) => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    mkdirSync(planDir);
    writeFileSync(join(planDir, "annotations.json"), "[]");
    writeFileSync(join(planDir, "applied_commit"), `${APPLIED_COMMIT_SHA}\n`);
    const { request, calls } = harness({
      appliedCommit: { sha: APPLIED_COMMIT_SHA, commit },
    });

    await expect(main(request)).rejects.toThrow(expectedError);

    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it.each([
    [
      "tree differs from the admitted plan",
      {
        sha: APPLIED_COMMIT_SHA,
        commit: {
          message: `applied\n\nOwner-Task-Comment: ${COMMENT_ID}`,
          tree: { sha: BASE_SHA },
        },
        parents: [{ sha: HEAD_SHA }],
      },
      /tree does not match the admitted plan/u,
    ],
    [
      "single parent differs from the admitted plan",
      {
        sha: APPLIED_COMMIT_SHA,
        commit: {
          message: `applied\n\nOwner-Task-Comment: ${COMMENT_ID}`,
          tree: { sha: TREE_OID },
        },
        parents: [{ sha: BASE_SHA }],
      },
      /parent does not match the admitted plan/u,
    ],
    [
      "has multiple parents",
      {
        sha: APPLIED_COMMIT_SHA,
        commit: {
          message: `applied\n\nOwner-Task-Comment: ${COMMENT_ID}`,
          tree: { sha: TREE_OID },
        },
        parents: [{ sha: HEAD_SHA }, { sha: BASE_SHA }],
      },
      /exactly one parent/u,
    ],
    [
      "has a malformed tree field",
      {
        sha: APPLIED_COMMIT_SHA,
        commit: {
          message: `applied\n\nOwner-Task-Comment: ${COMMENT_ID}`,
          tree: { sha: "not-a-sha" },
        },
        parents: [{ sha: HEAD_SHA }],
      },
      /malformed tree/u,
    ],
    [
      "has a malformed parents field",
      {
        sha: APPLIED_COMMIT_SHA,
        commit: {
          message: `applied\n\nOwner-Task-Comment: ${COMMENT_ID}`,
          tree: { sha: TREE_OID },
        },
        parents: {},
      },
      /malformed parents/u,
    ],
    [
      "has a malformed parent SHA",
      {
        sha: APPLIED_COMMIT_SHA,
        commit: {
          message: `applied\n\nOwner-Task-Comment: ${COMMENT_ID}`,
          tree: { sha: TREE_OID },
        },
        parents: [{ sha: "not-a-sha" }],
      },
      /malformed parent/u,
    ],
  ])("finalize fails closed when the reachable commit %s", async (
    _name,
    appliedCommit,
    expectedError,
  ) => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    writeFinalizeArtifacts();
    const { request, calls } = harness({ appliedCommit });

    await expect(main(request)).rejects.toThrow(expectedError);

    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("finalize rejects malformed commit records without posting a marker", async () => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    mkdirSync(planDir);
    writeFileSync(join(planDir, "annotations.json"), "[]");
    writeFileSync(join(planDir, "applied_commit"), `${APPLIED_COMMIT_SHA}\n`);
    const { request, calls } = harness({
      appliedCommit: { sha: "not-a-sha", commit: { message: "initial" } },
    });

    await expect(main(request)).rejects.toThrow(/wrong applied commit/u);

    expect(calls.filter((call) => call.method === "POST")).toEqual([]);
  });

  it("finalize validates the targeted applied commit after PR history grows past 100", async () => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    mkdirSync(planDir);
    writeFileSync(join(planDir, "annotations.json"), "[]");
    writeFileSync(join(planDir, "applied_commit"), `${APPLIED_COMMIT_SHA}\n`);
    writePlanIdentity();
    const { request, calls } = harness({
      pullRequest: pullRequest({ commits: 101 }),
    });

    await main(request);

    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
    expect(calls.some((call) => call.path.includes("/pulls/9/commits?"))).toBe(false);
    expect(calls.some((call) => call.path.includes(`/commits/${APPLIED_COMMIT_SHA}`)))
      .toBe(true);
  });

  it("finalize accepts the applied commit as the current PR head", async () => {
    vi.stubEnv("APPLY_PHASE", "finalize");
    mkdirSync(planDir);
    writeFileSync(join(planDir, "annotations.json"), "[]");
    writeFileSync(join(planDir, "applied_commit"), `${APPLIED_COMMIT_SHA}\n`);
    writePlanIdentity();
    const { request, calls } = harness({
      pullRequest: pullRequest({
        head: {
          sha: APPLIED_COMMIT_SHA,
          ref: "feature/owner-task",
          repo: { full_name: REPOSITORY },
        },
      }),
      comparison: { status: "identical" },
    });

    await main(request);

    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
});
