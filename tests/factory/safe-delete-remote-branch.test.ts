import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * Runs the script; returns its exit code and combined stdout+stderr.
 *
 * `spawnSync`, not `execFileSync`, and deliberately: `execFileSync` returns
 * only STDOUT on success and exposes stderr solely through the thrown error,
 * so on the success path every assertion here was blind to stderr. That hid a
 * real leak — the script's redacted `git push` output goes to stderr, and the
 * delete SUCCEEDS, so a test asserting on it saw nothing at all and failed for
 * a reason unrelated to the property it was checking. spawnSync returns both
 * streams whatever the exit code.

 */
function runScript(args: string[]): { code: number; out: string } {
  const env = process.env;
  const result = spawnSync("bash", [SCRIPT, ...args], {
    cwd: clone,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  return { code: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
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

  it("reports and never deletes, which is now the only mode", () => {
    const { code, out } = runScript(["merged-branch"]);
    expect(code).toBe(0);
    expect(out).toContain("VERDICT: SAFE TO DELETE");
    expect(out).toContain("This tool does NOT delete");
    // The window is named rather than implied — report-only relocates the
    // race to the operator, it does not remove it.
    expect(out).toContain("between this report and your delete");
    // The load-bearing assertion: reporting must not mutate the remote.
    expect(remoteHasBranch("merged-branch")).toBe(true);
  });

  it("refuses a branch carrying commits that exist nowhere else", () => {
    const { code, out } = runScript(["unique-branch"]);
    expect(code).not.toBe(0);
    expect(out).toContain("REFUSE");
    expect(out).toContain("exist only on");
    expect(remoteHasBranch("unique-branch")).toBe(true);
  });

  // A bare `toContain("REFUSE")` is not enough on this script, and that is not
  // a style point (qa review, #156). Every refusal prints "REFUSE", so the
  // assertion is satisfied by ANY of them — including one that fires for a
  // reason unrelated to the guard the test is named after. Three tests here
  // were verified by mutation to pass with their named guard deleted outright:
  //
  //   - "refuses main" passed because with the guard gone the script reaches
  //     the atomic push, which then fails on an incidental git error
  //     ("dst ref refs/heads/main receives from more than one src", since the
  //     push targets main twice when branch == main). An accidental collision,
  //     not the guard, was doing the work — and it disappears the moment the
  //     refspec construction changes;
  //   - "refuses HEAD" passed because the script instead failed fetching a
  //     nonexistent `refs/heads/HEAD`;
  //   - the push-URL mismatch test passed because its push URL pointed at a
  //     path that does not exist, so the push failed at transport level whether
  //     or not the check ran.
  //
  // So each now asserts the SPECIFIC die message, and the mismatch test below
  // is rebuilt so that removing the check causes a real deletion rather than an
  // incidental error.
  it("refuses main by the main-guard specifically, and main survives", () => {
    const { code, out } = runScript(["main"]);
    expect(code).not.toBe(0);
    expect(out).toContain("'main' is the comparison branch; deleting it is never safe here");
    // It must refuse BEFORE ever concluding main is safe: this is the exact
    // historical catastrophe, where main compares to itself and reports zero
    // unique commits.
    expect(out).not.toContain("SAFE");
    expect(remoteHasBranch("main")).toBe(true);
  });

  it("refuses the symbolic ref HEAD by the HEAD-guard specifically", () => {
    const { code, out } = runScript(["HEAD"]);
    expect(code).not.toBe(0);
    expect(out).toContain("refusing the symbolic ref 'HEAD'");
    // Not the fetch failure that masked this guard's absence before.
    expect(out).not.toContain("could not fetch");
  });

  it("refuses a branch that does not exist on the remote", () => {
    const { code, out } = runScript(["no-such-branch"]);
    expect(code).not.toBe(0);
    expect(out).toContain("could not fetch refs/heads/no-such-branch");
  });

  it("refuses with a usage message when no branch is given", () => {
    const { code, out } = runScript([]);
    expect(code).not.toBe(0);
    expect(out).toContain("usage:");
  });

  // Codex P2, #156: anything past the second argument was silently ignored,
  // so a typo'd or reordered invocation could look accepted while the flag the
  // operator meant went unread. On a destructive tool that is a real hazard.
  it("refuses extra arguments rather than ignoring them", () => {
    const { code, out } = runScript(["merged-branch", "--oops"]);
    expect(code).not.toBe(0);
    expect(out).toContain("too many arguments");
    expect(remoteHasBranch("merged-branch")).toBe(true);
  });

  // Codex P2, #156: the refusal prints `git log --oneline` for the commits that
  // exist only on the branch, and a commit subject is untrusted data. Control
  // bytes there could clear the screen or overwrite the very evidence the
  // operator reads to decide whether the refusal is correct.
  it("strips terminal control bytes from the commit evidence", () => {
    git(clone, "checkout", "-q", "-b", "ansi-branch", "main");
    // ESC[2J clears the screen; \r returns to column zero to overwrite.
    git(clone, "commit", "--allow-empty", "-m", "\u001b[2Jcleared\rOVERWRITTEN evidence");
    git(clone, "push", "-q", "origin", "ansi-branch");
    git(clone, "checkout", "-q", "main");

    const { code, out } = runScript(["ansi-branch"]);
    expect(code).not.toBe(0);
    // The raw control bytes must not survive to the terminal.
    expect(out).not.toContain("\u001b");
    expect(out).not.toContain("\r");
    // The readable text still does, so the evidence is not simply dropped.
    expect(out).toContain("OVERWRITTEN evidence");
    expect(remoteHasBranch("ansi-branch")).toBe(true);
  });

  // Codex P2, #156: git permits control bytes in REF names, so a
  // remotely-created branch is attacker-controllable input to this report. The
  // commit evidence and push output were sanitised; the branch name was not.
  it("sanitises control bytes in the branch name before printing it", () => {
    // C1, not C0, and that distinction is the finding: git REJECTS C0 bytes
    // (ESC, CR) in a ref name, so a test using those proves nothing — it fails
    // at branch creation. Git does accept UTF-8-encoded C1 controls, and
    // U+009B is CSI, the single-byte equivalent of `ESC [`, which a terminal
    // recognising C1 will act on exactly like an escape sequence.
    const evil = "evil\u009b2Jcleared-OVERWRITTEN";
    git(clone, "branch", evil, "main");
    git(clone, "push", "-q", "origin", `refs/heads/${evil}:refs/heads/${evil}`);

    const { out } = runScript([evil]);
    expect(out).not.toContain("\u009b");
    // Sanitised, not dropped — the operator still learns which branch it was.
    expect(out).toContain("OVERWRITTEN");
  });

  // Codex P1, #156, reproduced: a LOCAL tracking ref can be symbolic, and the
  // fetch writes through the indirection — so the branch's tracking ref gets
  // overwritten with main and the count compares main to itself.
  it("refuses when a local tracking ref is symbolic", () => {
    git(clone, "checkout", "-q", "-b", "ahead", "main");
    git(clone, "commit", "--allow-empty", "-m", "genuinely ahead");
    git(clone, "push", "-q", "origin", "ahead");
    git(clone, "checkout", "-q", "main");
    git(clone, "fetch", "-q", "origin");
    git(clone, "symbolic-ref", "refs/remotes/origin/main", "refs/remotes/origin/ahead");

    const { code, out } = runScript(["ahead"]);
    expect(code).not.toBe(0);
    expect(out).toContain("is SYMBOLIC");
    // The branch really is ahead, so a SAFE verdict here would be destructive.
    expect(out).not.toContain("SAFE TO DELETE");
  });

  // Codex P1, #156: the report prints a copy-pasteable `git push --delete`, so
  // a divergent push URL means that advice acts on a repository this check
  // never inspected. I removed this guard during the report-only rescope
  // ("there is no push") and the rescope reintroduced its premise in another
  // form — the script now tells a HUMAN to push.
  it("refuses when the push URL diverges from the inspected fetch URL", () => {
    const elsewhere = join(root, "elsewhere.git");
    git(root, "init", "--bare", "--initial-branch=main", elsewhere);
    git(clone, "push", elsewhere, "main:main", "merged-branch:merged-branch");
    git(clone, "remote", "set-url", "--push", "origin", elsewhere);

    const { code, out } = runScript(["merged-branch"]);
    expect(code).not.toBe(0);
    expect(out).toContain("fetches from one URL and pushes to another");
    expect(out).not.toContain("SAFE TO DELETE");
  });

  // Codex P1, #156, reproduced: `main` itself can be a symbolic ref pointing
  // AT the branch under test. Both explicit fetches then resolve to the same
  // sha, the unique count is zero, and the report calls the branch safe —
  // while deleting it would take main's target with it. Checking only the
  // REQUESTED ref left the comparison side unverified.
  it("refuses when main is a symbolic ref pointing at the branch under test", () => {
    git(clone, "checkout", "-q", "-b", "victim", "main");
    git(clone, "commit", "--allow-empty", "-m", "only on victim");
    git(clone, "push", "-q", "origin", "victim");
    git(clone, "checkout", "-q", "main");
    git(remote, "symbolic-ref", "refs/heads/main", "refs/heads/victim");

    const { code, out } = runScript(["victim"]);
    expect(code).not.toBe(0);
    expect(out).toContain("is a SYMBOLIC ref");
    expect(out).not.toContain("SAFE TO DELETE");
  });

  // Codex P1, #156, reproduced against SSH: a transport wrapper can route
  // git-upload-pack to a different repository while the configured URL is
  // untouched, so the URL proves nothing about which repository answered the
  // fetch — and the fetch is what the whole reachability answer rests on.
  it.each([["core.sshCommand", "config"], ["GIT_SSH_COMMAND", "env"], ["GIT_SSH", "env"]])(
    "refuses when %s is set",
    (key, kind) => {
      if (kind === "config") {
        git(clone, "config", key, "/bin/true");
        const { code, out } = runScript(["merged-branch"]);
        expect(code).not.toBe(0);
        expect(out).toContain(`${key} is set`);
        return;
      }
      const result = spawnSync("bash", [SCRIPT, "merged-branch"], {
        cwd: clone,
        encoding: "utf8",
        env: { ...process.env, [key]: "/bin/true" },
      });
      const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      expect(result.status).not.toBe(0);
      expect(out).toContain(`${key} is set in the environment`);
    },
  );

  // Codex P1, #156, and a hazard the report-only rescope INTRODUCED: the
  // output now prints a copy-pasteable shell command, and git permits shell
  // metacharacters in ref names. A raw interpolation turns a safety report
  // into command injection at exactly the moment the operator is told to run
  // something destructive.
  it("shell-quotes the branch in the suggested delete command", () => {
    const evil = "merged;touch${IFS}/tmp/pwned-canary";
    git(clone, "branch", evil, "main");
    git(clone, "push", "-q", "origin", `refs/heads/${evil}:refs/heads/${evil}`);

    const { out } = runScript([evil]);
    const line = out.split("\n").find((l) => l.includes("git push"));
    expect(line).toBeDefined();
    // The metacharacters must be escaped, not present as live shell syntax.
    expect(line).not.toContain(";touch$");
    expect(line).toContain("\\;");
    // `--` so a leading-dash branch name cannot be read as an option.
    expect(line).toContain("--delete --");
  });

  // Codex P1, #156, reproduced by the reviewer: a symbolic remote ref
  // dereferences on BOTH the reachability check and the push, so `alias ->
  // main` reports zero unique commits and the deletion removes `main`. The
  // literal name guard never sees it.
  it("refuses a symbolic remote ref that dereferences to main", () => {
    git(remote, "symbolic-ref", "refs/heads/alias", "refs/heads/main");
    const { code, out } = runScript(["alias"]);
    expect(code).not.toBe(0);
    expect(out).toContain("is a SYMBOLIC ref");
    // The load-bearing assertion: main must survive.
    expect(remoteHasBranch("main")).toBe(true);
    expect(git(remote, "symbolic-ref", "refs/heads/alias").trim()).toBe("refs/heads/main");
  });

  // Codex P1, #156, reproduced: with a configured transport command, equal
  // fetch/push URLs do not prove the push reaches the inspected repository —
  // git runs the configured command and the URL becomes advisory.
  it("refuses when remote.origin.uploadpack is configured", () => {
    const key = "uploadpack";
    git(clone, "config", `remote.origin.${key}`, "/bin/true");
    const { code, out } = runScript(["merged-branch"]);
    expect(code).not.toBe(0);
    expect(out).toContain(`remote.origin.${key} is set`);
    expect(remoteHasBranch("merged-branch")).toBe(true);
  });

  // Codex P2, #156: the C1 strip handled only the UTF-8 encoding, so a RAW
  // single-byte 0x9b — equally valid in a ref name — survived into the report.
  // Codex P2, #156. Asserts the case that EXISTS: a C1 control reaching the
  // evidence display, escaped rather than deleted so two refs differing only by
  // it cannot render alike.
  //
  // Recorded rather than tested, because I could not construct it: a RAW
  // single-byte C1 reaches this output through no path I could find. Git
  // refuses one in a ref name ("Illegal byte sequence"), and a commit subject
  // containing one comes back out of `git log` as the encoded pair `c2 9b`
  // (byte-dumped to confirm, after an earlier check of mine matched the second
  // byte of that pair and wrongly showed a surviving raw byte). The byte-wise
  // pre-pass added for that case corrupted valid input — it split `c2 9b` and
  // emitted `<U+FFFD><U+009B>` — so it was reverted.
  it("escapes a C1 control in the commit evidence rather than deleting it", () => {
    git(clone, "checkout", "-q", "-b", "raw-c1", "main");
    execFileSync("bash", ["-c", `git commit -q --allow-empty -m "$(printf 'evil\\x9b2Jx subject')"`], {
      cwd: clone,
    });
    git(clone, "push", "-q", "origin", "raw-c1");
    git(clone, "checkout", "-q", "main");

    const result = spawnSync("bash", [SCRIPT, "raw-c1"], { cwd: clone, encoding: "binary" });
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status).not.toBe(0);
    // No control byte reaches the terminal...
    expect(Buffer.from(out, "binary").includes(0x9b)).toBe(false);
    // ...it is escaped as that exact codepoint...
    expect(out).toContain("<U+009B>");
    // ...and valid input is NOT corrupted: no stray replacement character,
    // which is what the reverted two-pass version produced here.
    expect(out).not.toContain("<U+FFFD>");
    expect(Buffer.from(out, "binary").includes(0xfd)).toBe(false);
  });

  // Codex P1, #156, reproduced by the reviewer: GIT_NO_REPLACE_OBJECTS does not
  // disable a legacy graft file, so a graft could make a branch-only commit
  // look reachable from main and authorise a deletion. Grafts are deprecated
  // but still honoured, so the script refuses outright.
  it("refuses to run at all when a graft file is present", () => {
    const graftPath = join(clone, ".git", "info", "grafts");
    const uniqueTip = git(clone, "rev-parse", "unique-branch").trim();
    const mainSha = git(clone, "rev-parse", "main").trim();
    // Direction matters: this must make MAIN reach the branch tip, so the
    // branch looks fully merged. Grafting the branch tip onto main is a no-op,
    // since that is already its parent.
    writeFileSync(graftPath, `${mainSha} ${uniqueTip}\n`);

    const { code, out } = runScript(["unique-branch"]);
    expect(code).not.toBe(0);
    expect(out).toContain("a graft file exists");
    expect(remoteHasBranch("unique-branch")).toBe(true);
    // The point of refusing rather than compensating: without the guard the
    // graft makes this branch look safe. Prove the graft really does distort
    // the answer, so this test cannot pass vacuously.
    const grafted = git(clone, "rev-list", "--count", "main..unique-branch").trim();
    expect(grafted).toBe("0");
  });

  // Codex P1, #156: git expands `~` in `core.graftsFile` when honouring it, but
  // `git config --get` returns the literal string, so checking the raw value
  // tests a path that does not exist while the real graft file is in force.
  it("finds a graft file configured with an unexpanded ~ path", () => {
    const graftDir = mkdtempSync(join(tmpdir(), "graft-home-"));
    const graftPath = join(graftDir, "grafts");
    const uniqueTip = git(clone, "rev-parse", "unique-branch").trim();
    const mainSha = git(clone, "rev-parse", "main").trim();
    writeFileSync(graftPath, `${mainSha} ${uniqueTip}\n`);
    // Point core.graftsFile at it via `~`, with HOME set so `~` resolves there.
    git(clone, "config", "core.graftsFile", "~/grafts");

    const result = spawnSync("bash", [SCRIPT, "unique-branch"], {
      cwd: clone,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: graftDir },
    });
    const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    expect(result.status).not.toBe(0);
    expect(out).toContain("a graft file exists");
    expect(remoteHasBranch("unique-branch")).toBe(true);
    rmSync(graftDir, { recursive: true, force: true });
  });

  // Codex P1, #156, and a correction to my own note (qa review, #156).
  //
  // I originally recorded this guard as UNTESTABLE, having failed to construct
  // the distortion: replacing the branch TIP with main's tip, and replacing
  // main's commit with the branch tip, both left `rev-list --count main..branch`
  // unchanged. That conclusion was wrong, and wrong in the direction that
  // matters — it claimed a security guard could not be shown to do anything.
  //
  // The construction needs an INTERMEDIATE commit, not the tip. Replacing a
  // middle commit with a fabricated one whose sole parent is `main` truncates
  // the ancestry behind it, so the count drops and the commits before the
  // replacement vanish from BOTH the number and the printed evidence. The tip
  // itself cannot be hidden this way, because git preserves the original
  // commit's sha identity through a replacement — which is why the count can be
  // falsified but never driven to zero, and why this is an evidence-integrity
  // defect rather than a path to an unwanted delete.
  //
  // That distinction is worth keeping: the operator reads that count and that
  // log to decide whether the refusal is correct, so a silently truncated
  // history is a real defect even though it cannot itself cause a deletion.
  it("counts against real objects, not a local replacement graph", () => {
    // Three unique commits on a branch: base -> c1 -> c2 -> c3(tip).
    git(clone, "checkout", "-q", "-b", "replace-branch", "main");
    for (const message of ["c1", "c2", "c3"]) {
      git(clone, "commit", "--allow-empty", "-m", message);
    }
    git(clone, "push", "-q", "origin", "replace-branch");
    git(clone, "checkout", "-q", "main");

    const mainSha = git(clone, "rev-parse", "main").trim();
    const c2 = git(clone, "rev-parse", "replace-branch~1").trim();
    // A stand-in for c2 whose only parent is main, which detaches c1 from the
    // branch's history for any traversal that honours the replacement.
    const fabricated = git(clone, "commit-tree", `${c2}^{tree}`, "-p", mainSha, "-m", "fabricated c2").trim();
    git(clone, "replace", c2, fabricated);

    // Sanity check the construction itself, so this test cannot quietly stop
    // exercising anything if git's behaviour changes: the replacement MUST
    // distort an unguarded traversal, or there is nothing here to defend.
    const distorted = git(clone, "rev-list", "--count", `main..replace-branch`).trim();
    expect(distorted).toBe("2");

    const { code, out } = runScript(["replace-branch"]);
    expect(code).not.toBe(0);
    // The guard's actual job: the real count, and the full evidence.
    expect(out).toContain("unique:  3 commit(s)");
    expect(out).toContain("c1");
    expect(out).toContain("3 commit(s) exist only on 'replace-branch'");
    expect(remoteHasBranch("replace-branch")).toBe(true);
  });
  it("keeps the script's protected list identical to the registry's", () => {
    const registry = readFileSync(
      fileURLToPath(new URL("../../docs/state/registry.md", import.meta.url)),
      "utf8",
    );
    const section = registry.split(/^## Protected branches/m)[1];
    expect(section, "registry.md has no 'Protected branches' section").toBeDefined();
    // Table rows look like: | `branch-name` | `sha` | why |
    const fromRegistry = [...section.split(/^## /m)[0].matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((m) => m[1]).sort();

    const script = readFileSync(SCRIPT, "utf8");
    const arrayBody = script.match(/PROTECTED=\(([\s\S]*?)\)/)?.[1];
    expect(arrayBody, "script has no PROTECTED array").toBeDefined();
    const fromScript = [...(arrayBody as string).matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();

    // Guards against the comparison passing vacuously if either parse breaks.
    expect(fromRegistry.length).toBeGreaterThan(0);
    expect(fromScript.length).toBeGreaterThan(0);
    expect(fromScript).toEqual(fromRegistry);
  });

  it("refuses a branch on the protected list", () => {
    git(clone, "branch", "feature/12-spec-grounded-publish-90-1-base-sha", "main");
    git(clone, "push", "-q", "origin", "feature/12-spec-grounded-publish-90-1-base-sha");
    const { code, out } = runScript(["feature/12-spec-grounded-publish-90-1-base-sha"]);
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

    const { code, out } = runScript(["merged-branch"]);
    expect(code).not.toBe(0);
    expect(out).toContain("exist only on");
    expect(remoteHasBranch("merged-branch")).toBe(true);
  });
});
