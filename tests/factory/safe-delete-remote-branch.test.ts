import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Behavioural tests for `scripts/safe-delete-remote-branch.sh` against REAL
 * git repositories, following the same real-git pattern as
 * `publish-implement-patch.real-git.test.ts`.
 *
 * This script is destructive, and until now its only verification was a
 * handful of manual runs recorded in a commit message (Codex P2, PR #156).
 * That is not repeatable and it did not survive contact: across its prose and
 * script lifetimes this check accumulated seven defects, the worst of which
 * would have deleted `main`, because `main` compares to itself and reports
 * zero unique commits. A destructive tool whose refusals are not tested is
 * asserting its own safety.
 *
 * Every test drives the real script against a real bare "remote" and a real
 * clone, so a refusal is proved by the branch still existing afterwards
 * rather than by reading the source.
 */

const SCRIPT = fileURLToPath(new URL("../../scripts/safe-delete-remote-branch.sh", import.meta.url));

/**
 * Absolute path to the real git, resolved BEFORE any test puts a shim on PATH,
 * so a shim can delegate to it without recursing into itself.
 */
const REAL_GIT = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();

let root: string;
let remote: string;
let clone: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.invalid",
    },
  });
}

/**
 * Runs the script; returns its exit code and combined output.
 *
 * `pathPrefix` prepends a directory to PATH, which is how the lease test gets
 * a shimmed `git` in front of the real one so it can mutate the remote at an
 * exact point inside the script's run.
 */
function runScript(args: string[], opts: { pathPrefix?: string } = {}): { code: number; out: string } {
  const env = opts.pathPrefix ? { ...process.env, PATH: `${opts.pathPrefix}:${process.env.PATH ?? ""}` } : process.env;
  try {
    const out = execFileSync("bash", [SCRIPT, ...args], {
      cwd: clone,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    return { code: 0, out };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

/** The remote's current `main` sha, read straight from the bare repo. */
function remoteMainSha(): string {
  return git(remote, "rev-parse", "refs/heads/main").trim();
}

function remoteHasBranch(branch: string): boolean {
  return git(remote, "for-each-ref", "--format=%(refname:short)", "refs/heads/")
    .split("\n")
    .map((line) => line.trim())
    .includes(branch);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "safe-delete-"));
  remote = join(root, "remote.git");
  clone = join(root, "clone");

  git(root, "init", "--bare", "--initial-branch=main", remote);
  git(root, "clone", remote, clone);
  git(clone, "commit", "--allow-empty", "-m", "base");
  git(clone, "push", "origin", "main");

  // A branch fully reachable from main: safe to delete.
  git(clone, "branch", "merged-branch", "main");
  git(clone, "push", "origin", "merged-branch");

  // A branch carrying a commit that exists nowhere else: never safe.
  git(clone, "checkout", "-q", "-b", "unique-branch");
  git(clone, "commit", "--allow-empty", "-m", "only here");
  git(clone, "push", "-q", "origin", "unique-branch");
  git(clone, "checkout", "-q", "main");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("safe-delete-remote-branch.sh", () => {
  it("deletes a branch whose commits are all reachable from main", () => {
    expect(remoteHasBranch("merged-branch")).toBe(true);
    const { code, out } = runScript(["merged-branch", "--delete"]);
    expect(code).toBe(0);
    expect(out).toContain("DELETED");
    expect(remoteHasBranch("merged-branch")).toBe(false);
  });

  it("reports without deleting when --delete is omitted", () => {
    const { code, out } = runScript(["merged-branch"]);
    expect(code).toBe(0);
    expect(out).toContain("SAFE");
    expect(out).toContain("report only");
    // The load-bearing assertion: reporting must not mutate the remote.
    expect(remoteHasBranch("merged-branch")).toBe(true);
  });

  it("refuses a branch carrying commits that exist nowhere else", () => {
    const { code, out } = runScript(["unique-branch", "--delete"]);
    expect(code).not.toBe(0);
    expect(out).toContain("REFUSE");
    expect(out).toContain("exist only on");
    expect(remoteHasBranch("unique-branch")).toBe(true);
  });

  // The worst defect this script ever had: `main` compares to itself, reports
  // zero unique commits, and deletes the default branch.
  it("refuses main, and main survives", () => {
    const { code, out } = runScript(["main", "--delete"]);
    expect(code).not.toBe(0);
    expect(out).toContain("REFUSE");
    expect(remoteHasBranch("main")).toBe(true);
  });

  it("refuses the symbolic ref HEAD", () => {
    const { code, out } = runScript(["HEAD", "--delete"]);
    expect(code).not.toBe(0);
    expect(out).toContain("REFUSE");
  });

  it("refuses a branch that does not exist on the remote", () => {
    const { code, out } = runScript(["no-such-branch", "--delete"]);
    expect(code).not.toBe(0);
    expect(out).toContain("REFUSE");
  });

  it("refuses when a push URL diverges from the fetch URL", () => {
    git(clone, "remote", "set-url", "--push", "origin", join(root, "elsewhere.git"));
    const { code, out } = runScript(["merged-branch", "--delete"]);
    expect(code).not.toBe(0);
    expect(out).toContain("REFUSE");
    expect(remoteHasBranch("merged-branch")).toBe(true);
  });

  // A remote may configure several pushurl entries; `get-url --push` returns
  // only the first, so a matching first entry must not mask a divergent later
  // one (Codex P1, PR #156).
  it("refuses when a LATER push URL diverges, not just the first", () => {
    git(clone, "remote", "set-url", "--push", "origin", remote);
    git(clone, "remote", "set-url", "--push", "--add", "origin", join(root, "elsewhere.git"));
    const { code, out } = runScript(["merged-branch", "--delete"]);
    expect(code).not.toBe(0);
    expect(out).toContain("REFUSE");
    expect(remoteHasBranch("merged-branch")).toBe(true);
  });

  it("redacts inline credentials from a URL mismatch refusal", () => {
    git(clone, "remote", "set-url", "--push", "origin", "https://user:supersecrettoken@example.invalid/x.git");
    const { code, out } = runScript(["merged-branch", "--delete"]);
    expect(code).not.toBe(0);
    expect(out).toContain("REFUSE");
    expect(out).toContain("<redacted>@");
    // The whole point: the token must never reach a terminal or CI log.
    expect(out).not.toContain("supersecrettoken");
  });

  // Codex P2, #156: anything past the second argument was silently ignored,
  // so a typo'd or reordered invocation could look accepted while the flag the
  // operator meant went unread. On a destructive tool that is a real hazard.
  it("refuses extra arguments rather than ignoring them", () => {
    const { code, out } = runScript(["merged-branch", "--delete", "--oops"]);
    expect(code).not.toBe(0);
    expect(out).toContain("too many arguments");
    expect(remoteHasBranch("merged-branch")).toBe(true);
  });

  it("refuses an unrecognised second argument", () => {
    const { code, out } = runScript(["merged-branch", "--force"]);
    expect(code).not.toBe(0);
    expect(out).toContain("unrecognised second argument");
    expect(remoteHasBranch("merged-branch")).toBe(true);
  });

  // Codex P1, #156: the first redaction handled `scheme://user:pass@host`
  // only, so a credential carried in a query parameter printed in full.
  it("redacts a credential carried in a query parameter", () => {
    git(clone, "remote", "set-url", "--push", "origin", "https://example.invalid/x.git?access_token=querysecret123");
    const { code, out } = runScript(["merged-branch", "--delete"]);
    expect(code).not.toBe(0);
    expect(out).toContain("<redacted>");
    expect(out).not.toContain("querysecret123");
  });

  // Codex P1, #156 round 3: the query-parameter fix above was an ALLOWLIST of
  // credential key names, so a compound key like `client_secret` missed it and
  // printed in full. The redaction no longer enumerates key names at all, so
  // this asserts the property that replaced the list: a value is redacted
  // because it is a query-parameter value, whatever its key is called. These
  // keys are deliberately ones no allowlist contained.
  it.each([
    ["client_secret", "compoundsecret1"],
    ["refresh_token", "compoundsecret2"],
    ["auth_token", "compoundsecret3"],
    ["x-totally-unforeseen-credential", "compoundsecret4"],
  ])("redacts a credential under the unlisted query key %s", (key, secret) => {
    git(clone, "remote", "set-url", "--push", "origin", `https://example.invalid/x.git?${key}=${secret}`);
    const { code, out } = runScript(["merged-branch", "--delete"]);
    expect(code).not.toBe(0);
    expect(out).toContain("<redacted>");
    expect(out).not.toContain(secret);
    // The key name survives, so the operator can still see WHICH parameter
    // was suppressed; only the value is withheld.
    expect(out).toContain(key);
  });

  // Codex P2, #156: a repeated push URL means the delete would be attempted
  // against the same target twice.
  it("refuses a duplicated push URL before mutating anything", () => {
    git(clone, "remote", "set-url", "--push", "origin", remote);
    git(clone, "remote", "set-url", "--push", "--add", "origin", remote);
    const { code, out } = runScript(["merged-branch", "--delete"]);
    expect(code).not.toBe(0);
    expect(out).toContain("more than once");
    expect(remoteHasBranch("merged-branch")).toBe(true);
  });

  // NOT TESTED, deliberately, and recorded rather than quietly dropped: Codex
  // raised a P1 that a local `refs/replace/*` entry would make `git rev-list`
  // answer reachability about a substituted graph. The script sets
  // `GIT_NO_REPLACE_OBJECTS=1` as cheap defence in depth, but I could not
  // construct the distortion to prove it matters: replacing the branch tip
  // with main's tip, and replacing main's commit with the branch tip, both
  // left `rev-list --count main..branch` unchanged at 1, with and without the
  // env var. Either replacement refs do not affect a symmetric-range count
  // this way, or the construction needs a shape I did not find. Shipping a
  // test that passes for the wrong reason would be worse than none, so the
  // guard stays and the claim that it is load-bearing does not.

  // Codex P1, #156, and a correction to an earlier claim of mine: I had said
  // git offers no atomic fetch-then-push so this race could only be bounded.
  // That was wrong. `git push --atomic` carries several refspecs and several
  // leases, so the delete can be leased to the main sha the reachability count
  // was computed against.
  //
  // Codex P2, #156 round 4: the first version of this test rewrote main BEFORE
  // invoking the script, so the script's own fetch observed the rewrite and
  // refused at the unique-commit check. The leased push was never reached, and
  // `toMatch(/REFUSE|rejected/)` accepted that unrelated refusal, so the test
  // passed with the lease removed entirely — it proved nothing about the race
  // it was named for. The window is between the script's fetch and its push,
  // so the rewrite has to land INSIDE that window.
  //
  // A `git` shim on PATH does exactly that: it delegates every call to the real
  // git, except that on the `push` invocation it first force-rewrites main on
  // the remote. By then the fetch and the reachability count have already run
  // against the old main, so the lease is genuinely the only thing left that
  // can refuse.
  it("refuses to delete when main moves between the reachability check and the push", () => {
    const rewriter = join(root, "rewriter");
    git(root, "clone", remote, rewriter);
    git(rewriter, "commit", "--allow-empty", "--amend", "-m", "rewritten main");

    const shimDir = join(root, "shim");
    mkdirSync(shimDir);
    const marker = join(root, "rewrite-fired");
    writeFileSync(
      join(shimDir, "git"),
      [
        "#!/bin/sh",
        `if [ "$1" = "push" ] && [ ! -e "${marker}" ]; then`,
        `  : > "${marker}"`,
        `  "${REAL_GIT}" -C "${rewriter}" push --force --quiet origin HEAD:main`,
        "fi",
        `exec "${REAL_GIT}" "$@"`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );

    const mainBefore = remoteMainSha();
    const { code, out } = runScript(["merged-branch", "--delete"], { pathPrefix: shimDir });

    // The specific refusal, not any refusal: this must be the lease rejecting
    // the push, not the reachability check declining to get that far.
    expect(out).toContain("atomic delete rejected");
    expect(code).not.toBe(0);
    // The branch survives, which is the property the whole script exists for.
    expect(remoteHasBranch("merged-branch")).toBe(true);

    // Guards against the test quietly reverting to proving nothing: the shim
    // must actually have fired, and main must actually have moved. Without
    // these, a shim that silently failed to run would leave a green test.
    expect(existsSync(marker)).toBe(true);
    expect(remoteMainSha()).not.toBe(mainBefore);
    // The script reached the push stage, so it had already decided the branch
    // was safe to delete — the refusal came from the push, not from an earlier
    // check declining to get that far.
    expect(out).toContain("SAFE: every commit on 'merged-branch' is reachable from main");
  });

  // What the test above proves, precisely, and what it does NOT — established
  // by deleting each part and re-running, not by reading the code:
  //
  //   - Remove the `main` REFSPEC from the atomic push and the test FAILS: the
  //     branch is deleted even though main moved. So carrying main in the push
  //     is the load-bearing part.
  //   - Remove only `--force-with-lease` on main and the test still PASSES,
  //     because pushing the checked main sha back over a moved main is a rewind
  //     and git rejects it as non-fast-forward regardless of any lease.
  //
  // So the main LEASE is defence in depth here — it would carry the refusal if
  // that refspec were ever forced — and the non-fast-forward rejection is what
  // actually stops this case. Recorded rather than asserted, because a comment
  // claiming this test covers the lease would be the same "passes for the wrong
  // reason" defect that produced this round in the first place.

  it("refuses a branch on the protected list", () => {
    git(clone, "branch", "feature/12-spec-grounded-publish-90-1-base-sha", "main");
    git(clone, "push", "-q", "origin", "feature/12-spec-grounded-publish-90-1-base-sha");
    const { code, out } = runScript(["feature/12-spec-grounded-publish-90-1-base-sha", "--delete"]);
    expect(code).not.toBe(0);
    expect(out).toContain("protected list");
    expect(remoteHasBranch("feature/12-spec-grounded-publish-90-1-base-sha")).toBe(true);
  });

  // A stale local ref must not be able to answer the reachability question:
  // a bare `<branch>` resolves through local refs first, which is the defect
  // the prose version of this check shipped with.
  it("counts against the remote even when a stale local ref disagrees", () => {
    // Advance the branch on the remote only; the local ref stays behind.
    const other = join(root, "other");
    git(root, "clone", remote, other);
    git(other, "checkout", "-q", "merged-branch");
    git(other, "commit", "--allow-empty", "-m", "remote-only commit");
    git(other, "push", "-q", "origin", "merged-branch");

    const { code, out } = runScript(["merged-branch", "--delete"]);
    expect(code).not.toBe(0);
    expect(out).toContain("exist only on");
    expect(remoteHasBranch("merged-branch")).toBe(true);
  });
});
