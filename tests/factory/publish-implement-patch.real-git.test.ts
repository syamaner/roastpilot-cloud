import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../scripts/factory/publish-implement-patch.mts";

/**
 * Proves the actual git plumbing AND the patch-path guard genuinely work
 * — against a real temporary repository and a real bare "remote", not a
 * mock. This is deliberate: the guard this file exercises was rewritten
 * specifically because an earlier version re-parsed diff text instead of
 * asking `git apply` what it would actually do, and diverged from it
 * (the `zz/`-prefix exploit below). Mocking `execFileSync`'s numstat/
 * summary output would just reintroduce the same class of risk one layer
 * up — trusting an assumption about git's output instead of git itself.
 * `publish-implement-patch.test.ts` covers the rejection paths that never
 * reach git at all (job-result gate, missing/oversized artifact); this
 * file is everything downstream of "a `git apply --numstat`-parseable
 * patch exists".
 */

const VALID_DIFF = `diff --git a/lib/new-file.ts b/lib/new-file.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/lib/new-file.ts
@@ -0,0 +1,1 @@
+export const x = 1;
`;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function writePatch(scratchDir: string, name: string, content: string): Promise<string> {
  const path = join(scratchDir, name);
  await fsWriteFile(path, content);
  return path;
}

let scratchDir: string;
let bareRemoteDir: string;
let localCloneDir: string;
let patchPath: string;
let originalCwd: string;

beforeEach(async () => {
  scratchDir = await mkdtemp(join(tmpdir(), "publish-real-git-"));
  bareRemoteDir = join(scratchDir, "remote.git");
  localCloneDir = join(scratchDir, "local");

  execFileSync("git", ["init", "--bare", "-q", bareRemoteDir]);
  execFileSync("git", ["clone", "-q", bareRemoteDir, localCloneDir]);
  git(localCloneDir, ["config", "user.name", "Test"]);
  git(localCloneDir, ["config", "user.email", "test@example.com"]);
  await writeInitialCommit(localCloneDir);
  // Force-rename to "main" regardless of git's configured init default
  // branch name (varies by environment) — idempotent, no error either way.
  git(localCloneDir, ["branch", "-M", "main"]);
  git(localCloneDir, ["push", "-u", "origin", "main"]);

  patchPath = await writePatch(scratchDir, "patch.diff", VALID_DIFF);

  originalCwd = process.cwd();
  process.chdir(localCloneDir);

  process.env.GH_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "syamaner/roastpilot-cloud";
  process.env.TRUSTED_ISSUE_NUMBER = "6";
  process.env.IMPLEMENT_JOB_RESULT = "success";
  process.env.RUN_URL = "https://github.com/o/r/actions/runs/1";
  process.env.PATCH_PATH = patchPath;
  process.exitCode = undefined;
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(scratchDir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.TRUSTED_ISSUE_NUMBER;
  delete process.env.IMPLEMENT_JOB_RESULT;
  delete process.env.RUN_URL;
  delete process.env.PATCH_PATH;
  process.exitCode = undefined;
});

async function writeInitialCommit(dir: string): Promise<void> {
  await fsWriteFile(join(dir, "README.md"), "# scratch repo\n");
  const ciPath = join(dir, ".github", "workflows", "ci.yml");
  await mkdir(dirname(ciPath), { recursive: true });
  await fsWriteFile(ciPath, "on: push\n");
  const glueScriptPath = join(dir, "scripts", "factory", "publish-implement-patch.mts");
  await mkdir(dirname(glueScriptPath), { recursive: true });
  await fsWriteFile(glueScriptPath, "export const marker = 1;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "initial commit"]);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A fetch mock for tests that expect `main()` to reject BEFORE ever
 * reaching the issue-fetch/PR-lookup/PR-create calls (every forbidden-path
 * guard-rejection test below) — the only calls it needs to answer are
 * `postFailureComment`'s own upsert lookup (GET comments — answered empty,
 * "no prior comment") and its resulting POST. Replaces a bare
 * `vi.fn(async () => jsonResponse({}, 201))`, which broke once
 * `postFailureComment` started GETting comments first (Codex round 3): an
 * unconditional `{}` response isn't the array `findExistingImplementFailureComment`
 * expects to `.map()` over.
 */
function rejectionOnlyFetchMock(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("/comments")) {
      return jsonResponse([]);
    }
    if (method === "POST" && url.includes("/comments")) {
      return jsonResponse({}, 201);
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

/** A fetch mock covering the issue-fetch + PR-list + PR-create calls a successful run makes. */
function stubHappyPathFetch(options?: {
  existingPrs?: Array<{
    number: number;
    head: { ref: string; repo?: { full_name: string } | null };
    base?: { ref: string };
  }>;
  createResponse?: { number: number; html_url: string };
  issueTitle?: string;
  /**
   * Simulates a prior implement-failure comment already on the issue
   * (Codex round-3 upsert idempotency) — when set, the mocked
   * `GET .../comments` returns exactly this one comment (marked, from our
   * bot login), so `postFailureComment` should PATCH it rather than POST
   * a new one.
   */
  existingFailureComment?: { id: number; body: string };
}) {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method === "GET" && url.match(/\/issues\/\d+$/)) {
      return jsonResponse({
        title: options?.issueTitle ?? "[F1-S3] Implement workflow",
      });
    }
    if (method === "GET" && url.includes("/pulls?state=open")) {
      // Defaults every existingPrs entry's head.repo to THIS repo, and its
      // base.ref to "main", unless a test explicitly overrides them —
      // preserves every pre-Codex-round-7/round-4 test's implicit
      // assumption that an "existing PR" fixture means a real factory PR
      // (this repo, targeting main), while letting the fork-scoping and
      // base-ref tests opt into something else.
      const prs = (options?.existingPrs ?? []).map((pr) => ({
        number: pr.number,
        head: {
          ref: pr.head.ref,
          repo:
            pr.head.repo === undefined
              ? { full_name: "syamaner/roastpilot-cloud" }
              : pr.head.repo,
        },
        base: pr.base ?? { ref: "main" },
      }));
      return jsonResponse(prs);
    }
    if (method === "POST" && url.endsWith("/pulls")) {
      return jsonResponse(
        options?.createResponse ?? {
          number: 99,
          html_url: "https://github.com/o/r/pull/99",
        },
        201,
      );
    }
    if (method === "GET" && url.includes("/comments")) {
      // postFailureComment's upsert now looks this up BEFORE ever
      // POSTing/PATCHing — reached on every failure path, not just the
      // ones a test is specifically targeting, so this must always
      // answer (empty by default: "no prior comment, POST a fresh one").
      return jsonResponse(options?.existingFailureComment ? [
        {
          id: options.existingFailureComment.id,
          body: options.existingFailureComment.body,
          user: { type: "Bot", login: "github-actions[bot]" },
        },
      ] : []);
    }
    if (method === "PATCH" && url.includes("/issues/comments/")) {
      return jsonResponse({}, 200);
    }
    if (method === "POST" && url.includes("/comments")) {
      // Reached only on a post-guard failure (e.g. a real git-apply
      // error) — not part of the "happy" path per se, but harmless to
      // handle here so callers testing that specific failure mode don't
      // need their own bespoke fetch mock.
      return jsonResponse({}, 201);
    }
    // Adjudicated F2 (#40 rework): applyNoReviewAutomationLabel's two
    // calls. The more specific /issues/{n}/labels check must come first —
    // both URLs end with "/labels".
    if (method === "POST" && url.includes("/issues/") && url.endsWith("/labels")) {
      return jsonResponse([{ name: "no-review-automation" }], 200);
    }
    if (method === "POST" && url.endsWith("/labels")) {
      return jsonResponse({ name: "no-review-automation" }, 201);
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("publish-implement-patch — real git plumbing (happy path)", () => {
  it("applies the patch, commits, and pushes a real branch to the bare remote", async () => {
    stubHappyPathFetch();

    await main();

    expect(process.exitCode).toBeUndefined();

    // Verify against the BARE REMOTE, not the local clone — proves the
    // push genuinely landed, not just that the local branch was created.
    const branches = execFileSync(
      "git",
      ["branch", "--list", "feature/6-implement-workflow"],
      { cwd: bareRemoteDir, encoding: "utf8" },
    );
    expect(branches).toContain("feature/6-implement-workflow");

    const verifyDir = join(scratchDir, "verify");
    execFileSync("git", [
      "clone",
      "-q",
      "--branch",
      "feature/6-implement-workflow",
      bareRemoteDir,
      verifyDir,
    ]);
    const content = await readFile(join(verifyDir, "lib", "new-file.ts"), "utf8");
    expect(content).toBe("export const x = 1;\n");

    const log = execFileSync("git", ["log", "-1", "--format=%s%n%b"], {
      cwd: verifyDir,
      encoding: "utf8",
    });
    expect(log).toContain("Implement #6");
    expect(log).toContain("Closes #6");
  });

  it("force-pushes cleanly on a re-run against an already-existing remote branch (idempotent re-dispatch)", async () => {
    stubHappyPathFetch({
      existingPrs: [{ number: 50, head: { ref: "feature/6-implement-workflow" } }],
    });

    await main();
    expect(process.exitCode).toBeUndefined();

    process.chdir(originalCwd);
    const secondCloneDir = join(scratchDir, "local2");
    execFileSync("git", ["clone", "-q", bareRemoteDir, secondCloneDir]);
    git(secondCloneDir, ["checkout", "main"]);
    git(secondCloneDir, ["config", "user.name", "Test"]);
    git(secondCloneDir, ["config", "user.email", "test@example.com"]);
    process.chdir(secondCloneDir);

    await main();

    expect(process.exitCode).toBeUndefined();
    const branches = execFileSync(
      "git",
      ["branch", "--list", "feature/6-implement-workflow"],
      { cwd: bareRemoteDir, encoding: "utf8" },
    );
    expect(branches).toContain("feature/6-implement-workflow");
  });
});

describe("publish-implement-patch — adjudicated F2 (#40 rework): GITHUB_TOKEN fallback surfaced on the PR", () => {
  afterEach(() => {
    delete process.env.PUBLISHED_VIA_FALLBACK;
  });

  it("PUBLISHED_VIA_FALLBACK=true: PR body carries the warning and both label calls happen", async () => {
    process.env.PUBLISHED_VIA_FALLBACK = "true";
    const fetchMock = stubHappyPathFetch();

    await main();

    expect(process.exitCode).toBeUndefined();

    const calls = fetchMock.mock.calls as Array<[string | URL, RequestInit | undefined]>;
    const prCreateCall = calls.find(
      ([url, init]) => String(url).endsWith("/pulls") && init?.method === "POST",
    );
    expect(prCreateCall).toBeDefined();
    const prBody = JSON.parse((prCreateCall?.[1]?.body as string) ?? "{}") as { body: string };
    expect(prBody.body).toContain("GITHUB_TOKEN fallback");
    expect(prBody.body).toContain("no-review-automation");

    const ensureLabelCall = calls.find(
      ([url, init]) =>
        !String(url).includes("/issues/") &&
        String(url).endsWith("/labels") &&
        init?.method === "POST",
    );
    expect(ensureLabelCall).toBeDefined();

    const applyLabelCall = calls.find(
      ([url, init]) =>
        String(url).includes("/issues/") &&
        String(url).endsWith("/labels") &&
        init?.method === "POST",
    );
    expect(applyLabelCall).toBeDefined();
    const applyLabelBody = JSON.parse((applyLabelCall?.[1]?.body as string) ?? "{}") as {
      labels: string[];
    };
    expect(applyLabelBody.labels).toEqual(["no-review-automation"]);
  });

  it("PUBLISHED_VIA_FALLBACK unset: PR body has no warning and no label calls happen", async () => {
    const fetchMock = stubHappyPathFetch();

    await main();

    expect(process.exitCode).toBeUndefined();

    const calls = fetchMock.mock.calls as Array<[string | URL, RequestInit | undefined]>;
    const prCreateCall = calls.find(
      ([url, init]) => String(url).endsWith("/pulls") && init?.method === "POST",
    );
    const prBody = JSON.parse((prCreateCall?.[1]?.body as string) ?? "{}") as { body: string };
    expect(prBody.body).not.toContain("GITHUB_TOKEN fallback");

    const anyLabelCall = calls.find(
      ([url, init]) => String(url).endsWith("/labels") && init?.method === "POST",
    );
    expect(anyLabelCall).toBeUndefined();
  });

  it("a label-application failure does not fail the whole publish (the PR is the load-bearing artifact)", async () => {
    process.env.PUBLISHED_VIA_FALLBACK = "true";
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.match(/\/issues\/\d+$/)) {
        return jsonResponse({ title: "[F1-S3] Implement workflow" });
      }
      if (method === "GET" && url.includes("/pulls?state=open")) {
        return jsonResponse([]);
      }
      if (method === "POST" && url.endsWith("/pulls")) {
        return jsonResponse({ number: 99, html_url: "https://github.com/o/r/pull/99" }, 201);
      }
      if (method === "POST" && url.endsWith("/labels")) {
        // Simulates the label-endpoint failing for any reason other than
        // "already exists" — must not take down an otherwise-successful
        // publish.
        return new Response("server error", { status: 500 });
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await main();

    expect(process.exitCode).toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to apply the"));
    errorSpy.mockRestore();
  });
});

describe("publish-implement-patch — Codex round 3: binary patches round-trip", () => {
  it("applies and pushes a real binary file byte-for-byte when the capture step used --binary (round-trip proof)", async () => {
    // Reproduces exactly what the FIXED capture step
    // (`git diff --cached --binary`) produces for a real binary file —
    // not a hand-crafted patch, for the same reason the rename-exploit
    // tests use real `git mv`: don't trust an assumption about what git's
    // output looks like when you can just ask git. A few arbitrary
    // non-UTF8 bytes stand in for e.g. a small image/font a story might
    // add.
    const binaryBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
    await fsWriteFile(join(localCloneDir, "asset.bin"), binaryBytes);
    git(localCloneDir, ["add", "-A"]);
    const binaryDiff = execFileSync("git", ["diff", "--cached", "--binary"], {
      cwd: localCloneDir,
      encoding: "utf8",
    });
    expect(binaryDiff).toContain("GIT binary patch");
    git(localCloneDir, ["reset", "--hard", "-q", "HEAD"]); // undo before main() runs against the same checkout

    process.env.PATCH_PATH = await writePatch(scratchDir, "binary.diff", binaryDiff);
    stubHappyPathFetch();

    await main();

    expect(process.exitCode).toBeUndefined();

    const verifyDir = join(scratchDir, "verify-binary");
    execFileSync("git", [
      "clone",
      "-q",
      "--branch",
      "feature/6-implement-workflow",
      bareRemoteDir,
      verifyDir,
    ]);
    const roundTripped = await readFile(join(verifyDir, "asset.bin"));
    expect(roundTripped.equals(binaryBytes)).toBe(true);
  });

  it("REJECTS (git apply fails) the OLD non---binary form as a sanity check that this test would have caught the bug", async () => {
    // Not testing our own code here — proving the counterfactual: the
    // PRE-fix `git diff --cached` (no --binary) form really does fail to
    // apply, so the fix above is provably necessary, not just cosmetic.
    const binaryBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
    await fsWriteFile(join(localCloneDir, "asset.bin"), binaryBytes);
    git(localCloneDir, ["add", "-A"]);
    const placeholderDiff = execFileSync("git", ["diff", "--cached"], {
      cwd: localCloneDir,
      encoding: "utf8",
    });
    expect(placeholderDiff).toContain("Binary files");
    git(localCloneDir, ["reset", "--hard", "-q", "HEAD"]);

    process.env.PATCH_PATH = await writePatch(scratchDir, "binary-placeholder.diff", placeholderDiff);
    const fetchMock = rejectionOnlyFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const assetExists = await readFile(join(localCloneDir, "asset.bin")).catch(() => null);
    expect(assetExists).toBeNull();
  });
});

describe("publish-implement-patch — Codex round 3 (mechanism corrected by a live-dispatch-test finding): publisher-side scratch-dir removal survives an edited .gitignore, and doesn't collide with an INTACT one", () => {
  it("REPRODUCES the live-dispatch-test bug: with .gitignore's entries left INTACT (the ordinary, non-adversarial case), the run still succeeds and never commits patch-output/", async () => {
    // The exact gap the pathspec-exclude form of this fix had, found only
    // on the real runner: `git add -A -- ':!issue-context'
    // ':!patch-output'` refuses (exit 1, "paths are ignored ... use -f")
    // when .gitignore ALREADY ignores those paths and they're ALSO named
    // in the pathspec — which is the ORDINARY case (no attack, no
    // .gitignore tampering at all), not the adversarial one the test
    // below exercises. Every prior test in this file used execFileSync
    // directly against a real git binary too, but none of them had BOTH
    // a pre-existing .gitignore ignoring these exact paths AND
    // patch-output/ physically present on disk AND an intact (untouched)
    // .gitignore at git-add time — the precise three-way interaction
    // this bug needed. This test has all three.
    await fsWriteFile(join(localCloneDir, ".gitignore"), "/issue-context\n/patch-output\n");
    git(localCloneDir, ["add", "-A"]);
    git(localCloneDir, ["commit", "-q", "-m", "add .gitignore"]);

    // Simulate the "Download patch artifact" step, same as the
    // adversarial test below.
    await mkdir(join(localCloneDir, "patch-output"), { recursive: true });
    await fsWriteFile(join(localCloneDir, "patch-output", "patch.diff"), "leftover artifact\n");

    // An ORDINARY patch — no .gitignore edit, nothing adversarial at all.
    process.env.PATCH_PATH = await writePatch(scratchDir, "ordinary.diff", VALID_DIFF);
    stubHappyPathFetch();

    await main();

    // The decisive assertion: this must SUCCEED, not fail with exit 1.
    expect(process.exitCode).toBeUndefined();

    const verifyDir = join(scratchDir, "verify-ordinary");
    execFileSync("git", [
      "clone",
      "-q",
      "--branch",
      "feature/6-implement-workflow",
      bareRemoteDir,
      verifyDir,
    ]);
    const newFile = await readFile(join(verifyDir, "lib", "new-file.ts"), "utf8");
    expect(newFile).toBe("export const x = 1;\n");
    const scratchArtifact = await readFile(
      join(verifyDir, "patch-output", "patch.diff"),
    ).catch(() => null);
    expect(scratchArtifact).toBeNull();
  });

  it("does NOT commit patch-output/patch.diff into the factory PR, even when the patch itself edits .gitignore to un-ignore it", async () => {
    // Seed a .gitignore matching the real repo's (issue-context/ and
    // patch-output/ both ignored) — the baseline this test's patch will
    // attempt to defeat.
    await fsWriteFile(join(localCloneDir, ".gitignore"), "/issue-context\n/patch-output\n");
    git(localCloneDir, ["add", "-A"]);
    git(localCloneDir, ["commit", "-q", "-m", "add .gitignore"]);

    // Simulate the "Download patch artifact" step: patch-output/patch.diff
    // already sits on disk in the publish job's OWN checkout by the time
    // applyPatchAndPush's `git add -A` runs — this is what makes the
    // vulnerability live for THIS job specifically (unlike issue-context/,
    // which never exists here at all).
    await mkdir(join(localCloneDir, "patch-output"), { recursive: true });
    await fsWriteFile(join(localCloneDir, "patch-output", "patch.diff"), "leftover artifact\n");

    // A patch that (a) makes an ordinary, allowed change AND (b) edits
    // .gitignore to un-ignore /patch-output — nothing stops a patch from
    // touching .gitignore; it isn't a pipeline-protected path.
    const diff = `diff --git a/.gitignore b/.gitignore
index abc1234..def5678 100644
--- a/.gitignore
+++ b/.gitignore
@@ -1,2 +1,1 @@
 /issue-context
-/patch-output
diff --git a/lib/new-file.ts b/lib/new-file.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/lib/new-file.ts
@@ -0,0 +1,1 @@
+export const x = 1;
`;
    process.env.PATCH_PATH = await writePatch(scratchDir, "gitignore-tamper.diff", diff);
    stubHappyPathFetch();

    await main();

    expect(process.exitCode).toBeUndefined();

    // Verify against the pushed branch on the bare remote: the ordinary
    // change landed, but the scratch artifact never did — even though
    // .gitignore no longer protects it. A pre-fix `git add -A` (no
    // pathspec exclude) would have staged and committed it.
    const verifyDir = join(scratchDir, "verify-pathspec");
    execFileSync("git", [
      "clone",
      "-q",
      "--branch",
      "feature/6-implement-workflow",
      bareRemoteDir,
      verifyDir,
    ]);
    const newFile = await readFile(join(verifyDir, "lib", "new-file.ts"), "utf8");
    expect(newFile).toBe("export const x = 1;\n");
    const scratchArtifact = await readFile(
      join(verifyDir, "patch-output", "patch.diff"),
    ).catch(() => null);
    expect(scratchArtifact).toBeNull();
  });
});

describe("publish-implement-patch — Codex round 3: implement-failure comment idempotency (upsert)", () => {
  it("PATCHes the existing marked comment on a re-dispatch instead of posting a duplicate", async () => {
    const diff = `diff --git a/.github/workflows/evil.yml b/.github/workflows/evil.yml
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/.github/workflows/evil.yml
@@ -0,0 +1,1 @@
+on: pull_request_target
`;
    process.env.PATCH_PATH = await writePatch(scratchDir, "evil.diff", diff);
    const fetchMock = stubHappyPathFetch({
      existingFailureComment: {
        id: 777,
        body: `some earlier failure\n\n<!-- roastpilot-factory:implement-failure:do-not-edit -->`,
      },
    });

    await main();

    expect(process.exitCode).toBe(1);
    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCall).toBeDefined();
    const [patchUrl, patchInit] = patchCall!;
    expect(String(patchUrl)).toContain("/issues/comments/777");
    const patchBody = JSON.parse((patchInit as RequestInit).body as string) as {
      body: string;
    };
    expect(patchBody.body).toContain(".github/workflows/evil.yml");

    // Decisively: no fresh POST comment was made — this was an edit, not
    // a duplicate.
    const postCommentCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).includes("/comments") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCommentCall).toBeUndefined();
  });

  it("POSTs a fresh comment (no prior marked comment exists — first failure for this issue)", async () => {
    const diff = `diff --git a/.github/workflows/evil.yml b/.github/workflows/evil.yml
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/.github/workflows/evil.yml
@@ -0,0 +1,1 @@
+on: pull_request_target
`;
    process.env.PATCH_PATH = await writePatch(scratchDir, "evil.diff", diff);
    const fetchMock = stubHappyPathFetch();

    await main();

    expect(process.exitCode).toBe(1);
    const postCommentCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).includes("/comments") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCommentCall).toBeDefined();
    const patchCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patchCall).toBeUndefined();
  });

  it("stops after MAX_COMMENT_PAGES (50) full pages without finding a marked comment, warns, and POSTs a fresh one", async () => {
    // Every page returns exactly 100 unrelated (unmarked) comments — a
    // full page every time, so pagination never naturally terminates via
    // the "short page" signal and must instead hit the MAX_COMMENT_PAGES
    // bound, mirroring the PR-listing exhaustion test above.
    const unrelatedFullPage = Array.from({ length: 100 }, (_, i) => ({
      id: 3000 + i,
      body: `unrelated comment ${i}`,
      user: { type: "User", login: "someone" },
    }));
    const diff = `diff --git a/.github/workflows/evil.yml b/.github/workflows/evil.yml
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/.github/workflows/evil.yml
@@ -0,0 +1,1 @@
+on: pull_request_target
`;
    process.env.PATCH_PATH = await writePatch(scratchDir, "evil.diff", diff);

    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("/comments")) {
        return jsonResponse(unrelatedFullPage);
      }
      if (method === "POST" && url.includes("/comments")) {
        return jsonResponse({}, 201);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await main();

    expect(process.exitCode).toBe(1);
    const commentCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/comments"),
    );
    // 50 GET pages + 1 POST.
    expect(commentCalls).toHaveLength(51);
    expect(
      commentCalls.some(([input]) => String(input).includes("page=50")),
    ).toBe(true);
    expect(
      commentCalls.some(([input]) => String(input).includes("page=51")),
    ).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Scanned 50 pages of comments"),
    );
    const postCommentCall = commentCalls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "POST",
    );
    expect(postCommentCall).toBeDefined();

    warnSpy.mockRestore();
  });
});

describe("publish-implement-patch — FIX 7: idempotency keys off issue number, not title", () => {
  it("reuses the EXISTING branch (found by issue-number prefix) rather than deriving a new one when the title changed since the first dispatch", async () => {
    // The existing PR's branch reflects an OLD title's slug
    // ("feature/6-old-title-slug"), while the issue's CURRENT title (as
    // fetched this run) would derive a totally different slug. A naive
    // "derive branch name from today's title, then look for a PR with
    // that exact name" would miss this PR and open a duplicate.
    stubHappyPathFetch({
      existingPrs: [{ number: 50, head: { ref: "feature/6-old-title-slug" } }],
      issueTitle: "[F1-S3] A completely different, edited title now",
    });

    // Create the branch the "existing PR" claims to point at, so the
    // force-push has something real to land on.
    git(localCloneDir, ["checkout", "-b", "feature/6-old-title-slug"]);
    await fsWriteFile(join(localCloneDir, "placeholder.txt"), "old\n");
    git(localCloneDir, ["add", "-A"]);
    git(localCloneDir, ["commit", "-q", "-m", "old dispatch"]);
    git(localCloneDir, ["push", "-u", "origin", "feature/6-old-title-slug"]);
    git(localCloneDir, ["checkout", "main"]);

    await main();

    expect(process.exitCode).toBeUndefined();
    // Pushed to the OLD branch name, not a fresh title-derived one.
    const oldBranch = execFileSync(
      "git",
      ["branch", "--list", "feature/6-old-title-slug"],
      { cwd: bareRemoteDir, encoding: "utf8" },
    );
    expect(oldBranch).toContain("feature/6-old-title-slug");
    const newTitleBranch = execFileSync(
      "git",
      [
        "branch",
        "--list",
        "feature/6-a-completely-different-edited-title-now",
      ],
      { cwd: bareRemoteDir, encoding: "utf8" },
    );
    expect(newTitleBranch.trim()).toBe("");
  });

  it("is NOT fooled by a different issue's branch that merely shares a numeric prefix (e.g. issue 6 vs issue 60)", async () => {
    stubHappyPathFetch({
      existingPrs: [{ number: 12, head: { ref: "feature/60-unrelated-issue" } }],
    });

    await main();

    expect(process.exitCode).toBeUndefined();
    // Should NOT have reused issue 60's branch — must have derived and
    // pushed a fresh one for issue 6.
    const branch6 = execFileSync(
      "git",
      ["branch", "--list", "feature/6-implement-workflow"],
      { cwd: bareRemoteDir, encoding: "utf8" },
    );
    expect(branch6).toContain("feature/6-implement-workflow");
  });
});

describe("publish-implement-patch — Codex round 7: fork-PR confusion (findExistingPrForIssue repo scoping)", () => {
  it("does NOT reuse a fork's PR whose branch coincidentally matches feature/{issueNumber}-, and opens a fresh same-repo PR instead", async () => {
    // A public-repo attack shape: a fork opens a PR from a branch named
    // exactly like this factory would name its own branch for issue 6.
    // Matching on head.ref alone would have this run force-push OUR
    // patch onto what it believes is PR #77's branch (i.e. treat #77 as
    // "already exists, just refresh it") — wrong, because #77's branch
    // isn't in this repo at all.
    const fetchMock = stubHappyPathFetch({
      existingPrs: [
        {
          number: 77,
          head: {
            ref: "feature/6-implement-workflow",
            repo: { full_name: "some-attacker/roastpilot-cloud" },
          },
        },
      ],
      createResponse: { number: 101, html_url: "https://github.com/o/r/pull/101" },
    });

    await main();

    expect(process.exitCode).toBeUndefined();
    // A fresh PR was opened (POST /pulls called) rather than treating #77
    // as the existing PR to refresh.
    const postPullsCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/pulls") && (init?.method ?? "GET") === "POST",
    );
    expect(postPullsCall).toBeDefined();

    // The push landed on the freshly-derived branch for issue 6 (still
    // named feature/6-implement-workflow here, since that's what
    // deriveBranchName also produces for this fixture's issue title) —
    // in THIS repo's bare remote, proving the push targeted our repo
    // regardless of the fork PR's existence.
    const branches = execFileSync(
      "git",
      ["branch", "--list", "feature/6-implement-workflow"],
      { cwd: bareRemoteDir, encoding: "utf8" },
    );
    expect(branches).toContain("feature/6-implement-workflow");
  });

  it("does NOT reuse a PR whose source repo has been deleted (head.repo: null)", async () => {
    const fetchMock = stubHappyPathFetch({
      existingPrs: [
        { number: 77, head: { ref: "feature/6-implement-workflow", repo: null } },
      ],
      createResponse: { number: 102, html_url: "https://github.com/o/r/pull/102" },
    });

    await main();

    expect(process.exitCode).toBeUndefined();
    const postPullsCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/pulls") && (init?.method ?? "GET") === "POST",
    );
    expect(postPullsCall).toBeDefined();
  });

  it("DOES reuse a same-repo PR (the ordinary idempotent-refresh case still works)", async () => {
    const fetchMock = stubHappyPathFetch({
      existingPrs: [
        {
          number: 50,
          head: {
            ref: "feature/6-implement-workflow",
            repo: { full_name: "syamaner/roastpilot-cloud" },
          },
        },
      ],
    });

    await main();

    expect(process.exitCode).toBeUndefined();
    const postPullsCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/pulls") && (init?.method ?? "GET") === "POST",
    );
    expect(postPullsCall).toBeUndefined(); // Reused PR #50, no new PR opened.
  });
});

describe("publish-implement-patch — Codex round 7: open-PR listing is paginated", () => {
  it("finds this issue's existing PR when it's on the SECOND page of open PRs", async () => {
    // Page 1: exactly 100 (PR_PAGE_SIZE) unrelated PRs — a full page
    // signals "there may be more" and must trigger a page-2 fetch.
    // Page 2: fewer than 100, containing the real match — signals "last
    // page" once found. A pre-pagination implementation (page 1 only)
    // would report no existing PR here and incorrectly open a duplicate.
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      number: 1000 + i,
      head: { ref: `feature/999${i}-unrelated`, repo: { full_name: "syamaner/roastpilot-cloud" } },
      base: { ref: "main" },
    }));
    const page2 = [
      {
        number: 50,
        head: { ref: "feature/6-implement-workflow", repo: { full_name: "syamaner/roastpilot-cloud" } },
        base: { ref: "main" },
      },
    ];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.match(/\/issues\/\d+$/)) {
        return jsonResponse({ title: "[F1-S3] Implement workflow" });
      }
      if (method === "GET" && url.includes("/pulls?state=open")) {
        if (url.includes("page=2")) {
          return jsonResponse(page2);
        }
        // Every other page number (including the un-paginated legacy
        // shape, if this URL ever omitted `page=`) returns page 1 —
        // asserts page=1 is requested explicitly below instead.
        return jsonResponse(page1);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    // The existing PR's branch must already exist on the remote for the
    // force-push to a REUSED branch to succeed.
    git(localCloneDir, ["checkout", "-b", "feature/6-implement-workflow"]);
    await fsWriteFile(join(localCloneDir, "placeholder.txt"), "old\n");
    git(localCloneDir, ["add", "-A"]);
    git(localCloneDir, ["commit", "-q", "-m", "old dispatch"]);
    git(localCloneDir, ["push", "-u", "origin", "feature/6-implement-workflow"]);
    git(localCloneDir, ["checkout", "main"]);

    await main();

    expect(process.exitCode).toBeUndefined();
    // Confirms page=1 was actually requested (not just page=2 by luck).
    const requestedPage1 = fetchMock.mock.calls.some(([input]) =>
      String(input).includes("/pulls?state=open") && String(input).includes("page=1"),
    );
    expect(requestedPage1).toBe(true);
    const requestedPage2 = fetchMock.mock.calls.some(([input]) =>
      String(input).includes("/pulls?state=open") && String(input).includes("page=2"),
    );
    expect(requestedPage2).toBe(true);
    // No duplicate PR opened — the page-2 match was found and reused.
    const postPullsCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/pulls") && (init?.method ?? "GET") === "POST",
    );
    expect(postPullsCall).toBeUndefined();
  });

  it("stops after MAX_PR_PAGES (50) full pages without finding a match, warns, and proceeds as if no existing PR was found", async () => {
    // Every page returns exactly 100 unrelated PRs — a full page every
    // time, so pagination never naturally terminates via the "short page"
    // signal and must instead hit the MAX_PR_PAGES bound.
    const unrelatedFullPage = Array.from({ length: 100 }, (_, i) => ({
      number: 2000 + i,
      head: { ref: `feature/999${i}-unrelated`, repo: { full_name: "syamaner/roastpilot-cloud" } },
      base: { ref: "main" },
    }));
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.match(/\/issues\/\d+$/)) {
        return jsonResponse({ title: "[F1-S3] Implement workflow" });
      }
      if (method === "GET" && url.includes("/pulls?state=open")) {
        return jsonResponse(unrelatedFullPage);
      }
      if (method === "POST" && url.endsWith("/pulls")) {
        return jsonResponse({ number: 200, html_url: "https://github.com/o/r/pull/200" }, 201);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await main();

    expect(process.exitCode).toBeUndefined();
    // Fetched exactly 50 pages (1..50), never a 51st.
    const pullsCalls = fetchMock.mock.calls.filter(([input]) =>
      String(input).includes("/pulls?state=open"),
    );
    expect(pullsCalls).toHaveLength(50);
    expect(
      pullsCalls.some(([input]) => String(input).includes("page=50")),
    ).toBe(true);
    expect(
      pullsCalls.some(([input]) => String(input).includes("page=51")),
    ).toBe(false);
    // Warned about the exhausted scan.
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Scanned 50 pages of open PRs"));
    // No match found across all 50 pages, so it proceeded to open a fresh
    // PR rather than treating anything as "already exists".
    const postPullsCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        String(input).endsWith("/pulls") && (init?.method ?? "GET") === "POST",
    );
    expect(postPullsCall).toBeDefined();

    warnSpy.mockRestore();
  });

  it("stops paginating once a page comes back short of PR_PAGE_SIZE (single-page repos don't fetch page 2)", async () => {
    const fetchMock = stubHappyPathFetch({ existingPrs: [] });

    await main();

    expect(process.exitCode).toBeUndefined();
    const page2Requested = fetchMock.mock.calls.some(([input]) =>
      String(input).includes("/pulls?state=open") && String(input).includes("page=2"),
    );
    expect(page2Requested).toBe(false);
  });
});

describe("publish-implement-patch — FIX 1: the applier-authoritative patch-path guard", () => {
  it("REJECTS the reviewer's exact exploit: a zz/-prefixed diff header targeting .github/workflows/ci.yml", async () => {
    // This is the exact bypass class the guard was rewritten for: a diff
    // header using a made-up "zz/" prefix instead of the usual "a/"/"b/".
    // git apply's default -p1 strips whatever the first path segment
    // actually is — not specifically "a"/"b" — so it still lands the
    // write at .github/workflows/ci.yml. An old parser that only strips a
    // literal "a/"/"b/" would see the harmless-looking path
    // "zz/.github/workflows/ci.yml" and let this through.
    const exploitDiff = `diff --git zz/.github/workflows/ci.yml zz/.github/workflows/ci.yml
index abc1234..def5678 100644
--- zz/.github/workflows/ci.yml
+++ zz/.github/workflows/ci.yml
@@ -1 +1 @@
-on: push
+on: pull_request_target
`;
    const exploitPath = await writePatch(scratchDir, "exploit-zz.diff", exploitDiff);
    process.env.PATCH_PATH = exploitPath;

    const { calls } = { calls: [] as unknown[] };
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.includes("/comments")) {
        return jsonResponse([]);
      }
      if (method === "POST" && url.includes("/comments")) {
        return jsonResponse({}, 201);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    // Never even reached the point of fetching the issue title / checking
    // for an existing PR — rejected before any of that. Two calls total:
    // postFailureComment's own upsert lookup (GET comments, Codex round 3)
    // plus the resulting POST — no issue-fetch, no PR-list, no PR-create.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const postCall = fetchMock.mock.calls.find(
      ([, callInit]) => (callInit as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeDefined();
    const [, init] = postCall!;
    const body = JSON.parse((init as RequestInit).body as string) as {
      body: string;
    };
    expect(body.body).toContain(".github/workflows/ci.yml");

    // And, decisively: the file on disk was never touched.
    const ciContent = await readFile(
      join(localCloneDir, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    expect(ciContent).toBe("on: push\n");
    void calls;
  });

  it("rejects a straightforward (non-exploit) patch touching .github/**", async () => {
    const diff = `diff --git a/.github/workflows/evil.yml b/.github/workflows/evil.yml
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/.github/workflows/evil.yml
@@ -0,0 +1,1 @@
+on: pull_request_target
`;
    process.env.PATCH_PATH = await writePatch(scratchDir, "evil.diff", diff);

    const fetchMock = rejectionOnlyFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const evilExists = await readFile(
      join(localCloneDir, ".github", "workflows", "evil.yml"),
      "utf8",
    ).catch(() => null);
    expect(evilExists).toBeNull();
  });

  it("rejects a patch touching the privileged glue scripts (scripts/factory/**), not just .github/**", async () => {
    const diff = `diff --git a/scripts/factory/publish-implement-patch.mts b/scripts/factory/publish-implement-patch.mts
index abc1234..def5678 100644
--- a/scripts/factory/publish-implement-patch.mts
+++ b/scripts/factory/publish-implement-patch.mts
@@ -1 +1 @@
-export const marker = 1;
+export const marker = 999;
`;
    process.env.PATCH_PATH = await writePatch(scratchDir, "glue.diff", diff);

    const fetchMock = rejectionOnlyFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const content = await readFile(
      join(localCloneDir, "scripts", "factory", "publish-implement-patch.mts"),
      "utf8",
    );
    expect(content).toBe("export const marker = 1;\n"); // unchanged
  });

  it("REJECTS the reviewer's exact round-6-second-pass exploit: git mv scripts/factory/... to scripts/other/... (the brace-compaction bypass)", async () => {
    // This is the specific gap FIX A closed: --numstat alone only reports
    // the destination "scripts/other/x.mts" (not protected), and the OLD
    // --summary-substring check was defeated by git's own brace
    // compaction of the shared "scripts/" prefix — "rename scripts/
    // {factory/publish-implement-patch.mts => other/x.mts} (100%)" never
    // contains the literal substring "scripts/factory/". Uses a REAL
    // `git mv` + `git diff --cached`, not a hand-crafted patch, so this
    // is exactly what the implement job's own capture step would produce.
    // `git mv` requires the destination directory to already exist on
    // disk (unlike applying a hand-crafted rename patch, which doesn't
    // need this) — create it first.
    await mkdir(join(localCloneDir, "scripts", "other"), { recursive: true });
    git(localCloneDir, [
      "mv",
      "scripts/factory/publish-implement-patch.mts",
      "scripts/other/x.mts",
    ]);
    const exploitDiff = git(localCloneDir, ["diff", "--cached"]);
    expect(exploitDiff).toContain(
      "rename from scripts/factory/publish-implement-patch.mts",
    );
    git(localCloneDir, ["reset", "--hard", "-q", "HEAD"]); // undo the mv on disk before main() runs against the SAME checkout

    process.env.PATCH_PATH = await writePatch(scratchDir, "exploit-rename-out.diff", exploitDiff);

    const fetchMock = rejectionOnlyFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    // Decisive: the file was never moved/deleted.
    const content = await readFile(
      join(localCloneDir, "scripts", "factory", "publish-implement-patch.mts"),
      "utf8",
    );
    expect(content).toBe("export const marker = 1;\n");
    const relocated = await readFile(
      join(localCloneDir, "scripts", "other", "x.mts"),
      "utf8",
    ).catch(() => null);
    expect(relocated).toBeNull();
  });

  it("rejects a rename OUT of .github/** (no shared prefix with the destination, so the OLD --summary check would have caught this one too — still covered under the new approach)", async () => {
    await mkdir(join(localCloneDir, "lib"), { recursive: true });
    git(localCloneDir, ["mv", ".github/workflows/ci.yml", "lib/ci.yml"]);
    const diff = git(localCloneDir, ["diff", "--cached"]);
    git(localCloneDir, ["reset", "--hard", "-q", "HEAD"]);

    process.env.PATCH_PATH = await writePatch(scratchDir, "rename-out-github.diff", diff);
    const fetchMock = rejectionOnlyFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const ciContent = await readFile(
      join(localCloneDir, ".github", "workflows", "ci.yml"),
      "utf8",
    );
    expect(ciContent).toBe("on: push\n");
  });

  it("rejects a rename OUT of root CODEOWNERS", async () => {
    await fsWriteFile(join(localCloneDir, "CODEOWNERS"), "* @syamaner\n");
    git(localCloneDir, ["add", "-A"]);
    git(localCloneDir, ["commit", "-q", "-m", "add CODEOWNERS"]);
    await mkdir(join(localCloneDir, "lib"), { recursive: true });
    git(localCloneDir, ["mv", "CODEOWNERS", "lib/CODEOWNERS-backup"]);
    const diff = git(localCloneDir, ["diff", "--cached"]);
    git(localCloneDir, ["reset", "--hard", "-q", "HEAD"]);

    process.env.PATCH_PATH = await writePatch(scratchDir, "rename-out-codeowners.diff", diff);
    const fetchMock = rejectionOnlyFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const content = await readFile(join(localCloneDir, "CODEOWNERS"), "utf8");
    expect(content).toBe("* @syamaner\n");
  });

  it("rejects a rename OUT of docs/CODEOWNERS", async () => {
    await mkdir(join(localCloneDir, "docs"), { recursive: true });
    await fsWriteFile(join(localCloneDir, "docs", "CODEOWNERS"), "* @syamaner\n");
    git(localCloneDir, ["add", "-A"]);
    git(localCloneDir, ["commit", "-q", "-m", "add docs/CODEOWNERS"]);
    await mkdir(join(localCloneDir, "lib"), { recursive: true });
    git(localCloneDir, ["mv", "docs/CODEOWNERS", "lib/CODEOWNERS-backup"]);
    const diff = git(localCloneDir, ["diff", "--cached"]);
    git(localCloneDir, ["reset", "--hard", "-q", "HEAD"]);

    process.env.PATCH_PATH = await writePatch(scratchDir, "rename-out-docs-codeowners.diff", diff);
    const fetchMock = rejectionOnlyFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const content = await readFile(join(localCloneDir, "docs", "CODEOWNERS"), "utf8");
    expect(content).toBe("* @syamaner\n");
  });

  it("rejects a COPY (not just a rename) INTO scripts/factory/** (hand-crafted — our own capture step's git diff --cached never detects copies without -C, so this is defensive coverage)", async () => {
    const diff = `diff --git a/lib/x.mts b/scripts/factory/evil-copy.mts
similarity index 100%
copy from lib/x.mts
copy to scripts/factory/evil-copy.mts
`;
    process.env.PATCH_PATH = await writePatch(scratchDir, "copy-into.diff", diff);
    const fetchMock = rejectionOnlyFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const exists = await readFile(
      join(localCloneDir, "scripts", "factory", "evil-copy.mts"),
      "utf8",
    ).catch(() => null);
    expect(exists).toBeNull();
  });

  it("rejects a COPY OUT of scripts/factory/** (hand-crafted, same reason as above)", async () => {
    const diff = `diff --git a/scripts/factory/publish-implement-patch.mts b/lib/leaked-copy.mts
similarity index 100%
copy from scripts/factory/publish-implement-patch.mts
copy to lib/leaked-copy.mts
`;
    process.env.PATCH_PATH = await writePatch(scratchDir, "copy-out.diff", diff);
    const fetchMock = rejectionOnlyFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
  });

  it("REJECTS Codex round-4's exact exploit: a COPY OUT of scripts/factory/** whose source path is C-QUOTED", async () => {
    // The finding that motivated the categorical rewrite: the OLD
    // extractRenameCopySourcePaths did `line.slice("copy from ".length)`
    // on the raw text, which for a C-quoted line keeps the leading `"` —
    // "\"scripts/factory/publish-implement-patch.mts\"" never matched the
    // "scripts/factory/" prefix check. This guard no longer parses that
    // line (or ANY diff-text line) at all — getAuthoritativeChangedPaths
    // asks git's own tree comparison, which has no quoting to get wrong
    // in the first place. Empirically confirmed this exact patch text
    // applies cleanly via `git apply --cached` and is reported as a
    // C100 record with both paths already unquoted.
    const diff = `diff --git a/lib/copy-dest.mts "b/scripts/factory/publish-implement-patch.mts"
similarity index 100%
copy from "scripts/factory/publish-implement-patch.mts"
copy to lib/copy-dest.mts
`;
    process.env.PATCH_PATH = await writePatch(scratchDir, "quoted-copy-from.diff", diff);
    const fetchMock = rejectionOnlyFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const leaked = await readFile(join(localCloneDir, "lib", "copy-dest.mts")).catch(
      () => null,
    );
    expect(leaked).toBeNull();
  });

  it("REJECTS a COPY INTO scripts/factory/** whose DESTINATION path is C-QUOTED (the symmetric variant)", async () => {
    const diff = `diff --git "a/README.md" "b/scripts/factory/evil-copy.mts"
similarity index 100%
copy from README.md
copy to "scripts/factory/evil-copy.mts"
`;
    process.env.PATCH_PATH = await writePatch(scratchDir, "quoted-copy-to.diff", diff);
    const fetchMock = rejectionOnlyFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const evilExists = await readFile(
      join(localCloneDir, "scripts", "factory", "evil-copy.mts"),
    ).catch(() => null);
    expect(evilExists).toBeNull();
  });

  it("REJECTS a RENAME OUT of scripts/factory/** with BOTH sides C-QUOTED (adversarial variant beyond Codex's own report)", async () => {
    // Codex's finding was specifically about a quoted "copy from" line;
    // the same slice-based parsing bug would equally have affected a
    // quoted "rename from"/"rename to" line, which nothing had reported
    // yet. Proving it here anyway, since the categorical fix closes this
    // whole CLASS regardless of which specific line a report named.
    const diff = `diff --git "a/scripts/factory/publish-implement-patch.mts" "b/scripts/other/x.mts"
similarity index 100%
rename from "scripts/factory/publish-implement-patch.mts"
rename to "scripts/other/x.mts"
`;
    process.env.PATCH_PATH = await writePatch(scratchDir, "quoted-rename.diff", diff);
    const fetchMock = rejectionOnlyFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const content = await readFile(
      join(localCloneDir, "scripts", "factory", "publish-implement-patch.mts"),
      "utf8",
    );
    expect(content).toBe("export const marker = 1;\n");
    const relocated = await readFile(
      join(localCloneDir, "scripts", "other", "x.mts"),
    ).catch(() => null);
    expect(relocated).toBeNull();
  });

  it("REJECTS a RENAME OUT via a non-ASCII destination filename, octal-escaped by git's DIFFERENT core.quotepath mechanism (adversarial variant hunting a fourth encoding)", async () => {
    // A genuinely different quoting mechanism from Codex's C-style
    // special-char quoting: git's human-readable diff header
    // octal-escapes non-ASCII BYTES regardless of any special characters
    // being present — "scripts/other/café.mts" renders as
    // "scripts/other/caf\303\251.mts" in the diff header text. Uses a
    // REAL `git mv` + `git diff --cached` (not hand-crafted), so this is
    // exactly what a real rename to a non-ASCII filename produces.
    // Empirically confirmed this same escaping happens on the diff
    // HEADER but never on the `-z` oracle's output, which reports the
    // raw UTF-8 bytes unescaped either way — proving the categorical fix
    // holds against a quoting mechanism neither Codex's report nor any
    // prior round of this guard ever named.
    await mkdir(join(localCloneDir, "scripts", "other"), { recursive: true });
    git(localCloneDir, [
      "mv",
      "scripts/factory/publish-implement-patch.mts",
      "scripts/other/café.mts",
    ]);
    const exploitDiff = git(localCloneDir, ["diff", "--cached"]);
    expect(exploitDiff).toContain('caf\\303\\251.mts"'); // Confirms the header really is octal-escaped.
    git(localCloneDir, ["reset", "--hard", "-q", "HEAD"]);

    process.env.PATCH_PATH = await writePatch(scratchDir, "nonascii-rename.diff", exploitDiff);
    const fetchMock = rejectionOnlyFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const content = await readFile(
      join(localCloneDir, "scripts", "factory", "publish-implement-patch.mts"),
      "utf8",
    );
    expect(content).toBe("export const marker = 1;\n");
  });

  it("still correctly rejects a protected-path patch when the filename contains a space (Codex's parser miss)", async () => {
    const diff = `diff --git a/.github/workflows/evil workflow.yml b/.github/workflows/evil workflow.yml
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/.github/workflows/evil workflow.yml
@@ -0,0 +1,1 @@
+on: pull_request_target
`;
    process.env.PATCH_PATH = await writePatch(scratchDir, "space.diff", diff);

    const fetchMock = rejectionOnlyFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
  });

  it("still allows a legitimate patch to a filename containing a space, outside any protected path", async () => {
    const diff = `diff --git a/lib/new file.ts b/lib/new file.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/lib/new file.ts
@@ -0,0 +1,1 @@
+export const x = 1;
`;
    process.env.PATCH_PATH = await writePatch(scratchDir, "space-ok.diff", diff);
    stubHappyPathFetch();

    await main();

    expect(process.exitCode).toBeUndefined();
    const branches = execFileSync(
      "git",
      ["branch", "--list", "feature/6-implement-workflow"],
      { cwd: bareRemoteDir, encoding: "utf8" },
    );
    expect(branches).toContain("feature/6-implement-workflow");
  });

  it("rejects an empty patch (no diff --git headers at all)", async () => {
    process.env.PATCH_PATH = await writePatch(scratchDir, "empty.diff", "");

    const fetchMock = rejectionOnlyFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
  });

  it("posts a generic failure comment when a well-formed, unprotected patch doesn't actually apply cleanly", async () => {
    // Passes the guard (touches only lib/**), but the context lines don't
    // match the base file — a genuine git-apply failure distinct from a
    // guard rejection.
    const diff = `diff --git a/README.md b/README.md
index abc1234..def5678 100644
--- a/README.md
+++ b/README.md
@@ -1,1 +1,1 @@
-this context line does not match the real file
+replacement
`;
    process.env.PATCH_PATH = await writePatch(scratchDir, "bad-context.diff", diff);
    stubHappyPathFetch();

    await main();

    expect(process.exitCode).toBe(1);
  });
});

describe("publish-implement-patch — FIX 5: accurate reporting when publish partially succeeds", () => {
  it("reports that the branch WAS pushed when PR-create fails after a successful push", async () => {
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.match(/\/issues\/\d+$/)) {
        return jsonResponse({ title: "[F1-S3] Implement workflow" });
      }
      if (method === "GET" && url.includes("/pulls?state=open")) {
        return jsonResponse([]);
      }
      if (method === "POST" && url.endsWith("/pulls")) {
        return new Response("service unavailable", { status: 503 });
      }
      if (method === "GET" && url.includes("/comments")) {
        return jsonResponse([]);
      }
      if (method === "POST" && url.includes("/comments")) {
        return jsonResponse({}, 201);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);

    // The branch really did land on the remote...
    const branches = execFileSync(
      "git",
      ["branch", "--list", "feature/6-implement-workflow"],
      { cwd: bareRemoteDir, encoding: "utf8" },
    );
    expect(branches).toContain("feature/6-implement-workflow");

    // ...and the comment says so accurately, not "no branch was created".
    // Filtered to the POST specifically — postFailureComment's own upsert
    // lookup (Codex round 3) makes a GET .../comments call first, which
    // also matches a bare "/comments" substring but carries no JSON body.
    const commentCall = fetchMock.mock.calls.find(
      ([input, callInit]) =>
        String(input).includes("/comments") &&
        (callInit as RequestInit | undefined)?.method === "POST",
    );
    expect(commentCall).toBeDefined();
    const [, init] = commentCall!;
    const body = JSON.parse((init as RequestInit).body as string) as {
      body: string;
    };
    expect(body.body).toContain("WAS pushed successfully");
    expect(body.body).not.toContain("No branch was created and nothing was pushed");
  });
});
