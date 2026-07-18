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

/** A fetch mock covering the issue-fetch + PR-list + PR-create calls a successful run makes. */
function stubHappyPathFetch(options?: {
  existingPrs?: Array<{ number: number; head: { ref: string } }>;
  createResponse?: { number: number; html_url: string };
  issueTitle?: string;
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
      return jsonResponse(options?.existingPrs ?? []);
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
    if (method === "POST" && url.includes("/comments")) {
      // Reached only on a post-guard failure (e.g. a real git-apply
      // error) — not part of the "happy" path per se, but harmless to
      // handle here so callers testing that specific failure mode don't
      // need their own bespoke fetch mock.
      return jsonResponse({}, 201);
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
      if (method === "POST" && url.includes("/comments")) {
        return jsonResponse({}, 201);
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    // Never even reached the point of fetching the issue title / checking
    // for an existing PR — rejected before any of that.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
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

    const fetchMock = vi.fn(async () => jsonResponse({}, 201));
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

    const fetchMock = vi.fn(async () => jsonResponse({}, 201));
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

    const fetchMock = vi.fn(async () => jsonResponse({}, 201));
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
    const fetchMock = vi.fn(async () => jsonResponse({}, 201));
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
    const fetchMock = vi.fn(async () => jsonResponse({}, 201));
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
    const fetchMock = vi.fn(async () => jsonResponse({}, 201));
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
    const fetchMock = vi.fn(async () => jsonResponse({}, 201));
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
    const fetchMock = vi.fn(async () => jsonResponse({}, 201));
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
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

    const fetchMock = vi.fn(async () => jsonResponse({}, 201));
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

    const fetchMock = vi.fn(async () => jsonResponse({}, 201));
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
    const commentCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("/comments"),
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
