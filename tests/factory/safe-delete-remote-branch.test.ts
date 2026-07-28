import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * Runs the script; returns its exit code and combined stdout+stderr.
 *
 * `spawnSync`, not `execFileSync`, and deliberately: `execFileSync` returns
 * only STDOUT on success and exposes stderr solely through the thrown error,
 * so on the success path every assertion here was blind to stderr. That hid a
 * real leak — the script's redacted `git push` output goes to stderr, and the
 * delete SUCCEEDS, so a test asserting on it saw nothing at all and failed for
 * a reason unrelated to the property it was checking. spawnSync returns both
 * streams whatever the exit code.
 *
 * `pathPrefix` prepends a directory to PATH, which is how the race test gets
 * a shimmed `git` in front of the real one so it can mutate the remote at an
 * exact point inside the script's run.
 */
function runScript(args: string[], opts: { pathPrefix?: string } = {}): { code: number; out: string } {
  const env = opts.pathPrefix ? { ...process.env, PATH: `${opts.pathPrefix}:${process.env.PATH ?? ""}` } : process.env;
  const result = spawnSync("bash", [SCRIPT, ...args], {
    cwd: clone,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  return { code: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
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
    const { code, out } = runScript(["main", "--delete"]);
    expect(code).not.toBe(0);
    expect(out).toContain("'main' is the comparison branch; deleting it is never safe here");
    // It must refuse BEFORE ever concluding main is safe: this is the exact
    // historical catastrophe, where main compares to itself and reports zero
    // unique commits.
    expect(out).not.toContain("SAFE");
    expect(remoteHasBranch("main")).toBe(true);
  });

  it("refuses the symbolic ref HEAD by the HEAD-guard specifically", () => {
    const { code, out } = runScript(["HEAD", "--delete"]);
    expect(code).not.toBe(0);
    expect(out).toContain("refusing the symbolic ref 'HEAD'");
    // Not the fetch failure that masked this guard's absence before.
    expect(out).not.toContain("could not fetch");
  });

  it("refuses a branch that does not exist on the remote", () => {
    const { code, out } = runScript(["no-such-branch", "--delete"]);
    expect(code).not.toBe(0);
    expect(out).toContain("could not fetch refs/heads/no-such-branch");
  });

  // Rebuilt (qa review, #156). The push URL now points at a REAL second bare
  // repo that genuinely contains the branch, so if the mismatch check were
  // removed the push would SUCCEED and delete from a remote the safety check
  // never inspected — which is the actual hazard. Pointing at a nonexistent
  // path, as this test used to, proves only that git cannot push to nowhere.
  it("refuses when a push URL diverges from the fetch URL, and the other remote is untouched", () => {
    const elsewhere = join(root, "elsewhere.git");
    git(root, "init", "--bare", "--initial-branch=main", elsewhere);
    git(clone, "push", elsewhere, "main:main", "merged-branch:merged-branch");
    git(clone, "remote", "set-url", "--push", "origin", elsewhere);

    const { code, out } = runScript(["merged-branch", "--delete"]);
    expect(code).not.toBe(0);
    expect(out).toContain("The safety check would inspect one remote and delete on another");
    // Both remotes keep the branch: the one that was checked, and the one that
    // would have been deleted from.
    expect(remoteHasBranch("merged-branch")).toBe(true);
    const elsewhereRefs = git(elsewhere, "for-each-ref", "--format=%(refname:short)", "refs/heads/");
    expect(elsewhereRefs).toContain("merged-branch");
  });

  it("refuses with a usage message when no branch is given", () => {
    const { code, out } = runScript([]);
    expect(code).not.toBe(0);
    expect(out).toContain("usage:");
  });

  // ACCEPTED AS UNTESTED, recorded rather than dropped (qa review, #156): the
  // two "absent after an explicit fetch" refusals have no test under their own
  // trigger. They are backstops for a state the preceding fetch-failure check
  // should already have caught, so provoking them means simulating a git that
  // reports a successful fetch without producing the ref. The qa pass confirmed
  // the backstop does fire when the fetch-failure die is neutralised, so they
  // are live rather than dead code — but that is defence in depth, not a
  // covered path, and this comment is here so the next reader knows which.
  //
  // Also recorded: the five credential-redaction tests above pass through
  // BOTH the mismatch refusal's own redaction and the later push-output
  // redaction, so each alone would satisfy them. The qa pass verified they
  // fail when the mismatch path's own `redact_url` calls are stripped, so they
  // do bind that path; they simply are not isolated to it.

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
    // The key name is redacted too, and that is the CURRENT contract rather
    // than the original one. v3 redacted `?k=v` values and kept key names for
    // diagnosis; Codex then broke v3 with an opaque, keyless query credential
    // (`?<token>`, or a bare segment after `&`), which contains no `=` and so
    // matched nothing (P1, #156, reproduced against a real push). Preserving
    // key names is a nicety; failing open on a credential is not. So the whole
    // query component goes, and host/path — the part that identifies which
    // remote mismatched — is what remains.
    expect(out).not.toContain(key);
  });

  // The keyless case that broke the k=v redaction (Codex P1, #156).
  it.each([
    ["opaque query with no key at all", "?sk_live_opaquecanary"],
    ["bare segment after an ampersand", "?a=1&barecanary"],
  ])("redacts %s", (_name, query) => {
    git(clone, "remote", "set-url", "--push", "origin", `https://example.invalid/x.git${query}`);
    const { code, out } = runScript(["merged-branch", "--delete"]);
    expect(code).not.toBe(0);
    expect(out).toContain("<redacted>");
    expect(out).not.toContain("opaquecanary");
    expect(out).not.toContain("barecanary");
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

    const { code, out } = runScript(["unique-branch", "--delete"]);
    expect(code).not.toBe(0);
    expect(out).toContain("a graft file exists");
    expect(remoteHasBranch("unique-branch")).toBe(true);
    // The point of refusing rather than compensating: without the guard the
    // graft makes this branch look safe. Prove the graft really does distort
    // the answer, so this test cannot pass vacuously.
    const grafted = git(clone, "rev-list", "--count", "main..unique-branch").trim();
    expect(grafted).toBe("0");
  });

  // Codex P2, #156, reproduced: with push.followTags set, the deletion push
  // also publishes local annotated tags reachable from the main commit it
  // carries — a tool that promises only to remove a branch silently creating
  // remote tags.
  it("does not publish local tags when push.followTags is set", () => {
    git(clone, "config", "push.followTags", "true");
    git(clone, "tag", "-a", "v-local-only", "-m", "should not cross");

    const { code } = runScript(["merged-branch", "--delete"]);
    expect(code).toBe(0);
    const remoteTags = git(remote, "for-each-ref", "--format=%(refname:short)", "refs/tags/");
    expect(remoteTags).not.toContain("v-local-only");
  });

  // Codex P1, #156: every message the script writes itself was redacted, but
  // git writes its OWN push output ("To <url>", and the error text on failure)
  // and that never passed through redact_url. Verified against real git rather
  // than assumed: pushing to `https://host/x.git?access_token=CANARY` prints
  // the token verbatim. The mismatch guard does not save this case, because it
  // only fires when fetch and push URLs DIFFER — when they match and both
  // carry a credential, the script runs all the way to the push.
  //
  // Reproducing that without a real HTTPS server: a local bare repo whose
  // PATH contains a query-shaped credential. Fetch and push both succeed, so
  // the script reaches the push and git prints the path in its own output,
  // which is exactly the leak channel under test.
  it("redacts credentials from git's own push output", () => {
    const leakRemote = join(root, "leak.git?access_token=CANARY123");
    git(root, "init", "--bare", "--initial-branch=main", leakRemote);
    git(clone, "push", leakRemote, "main:main", "merged-branch:merged-branch");
    git(clone, "remote", "set-url", "origin", leakRemote);

    const { code, out } = runScript(["merged-branch", "--delete"]);
    // The delete SUCCEEDS here; this is the success path's output being the
    // leak channel, not a refusal.
    expect(code).toBe(0);
    expect(out).toContain("DELETED");
    // The property under test.
    expect(out).not.toContain("CANARY123");
    expect(out).toContain("<redacted>");
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

    const { code, out } = runScript(["replace-branch", "--delete"]);
    expect(code).not.toBe(0);
    // The guard's actual job: the real count, and the full evidence.
    expect(out).toContain("unique:  3 commit(s)");
    expect(out).toContain("c1");
    expect(out).toContain("3 commit(s) exist only on 'replace-branch'");
    expect(remoteHasBranch("replace-branch")).toBe(true);
  });

  // Codex P1, #156, twice, in opposite directions — worth stating because the
  // conclusion moved and the evidence is what should be trusted, not me.
  //
  // First I said git offered no atomic fetch-then-push, so this race could only
  // be bounded. That was wrong: `git push --atomic` carries several refspecs
  // and several leases. Then I said that closed the race. That was ALSO wrong.
  // Verified with a pre-receive hook on a real remote: when main is unchanged at
  // advertisement time git treats its refspec as up to date and omits it from
  // the transaction, so main's lease does not participate at all.
  //
  // What this test proves is therefore narrower than its old name suggested: if
  // main has ALREADY moved when the push starts, the delete is refused and the
  // branch survives. It does not prove anything about a rewrite landing inside
  // the push itself, which remains a documented residual in the script.
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

  // Codex P2, #156: the script's PROTECTED array and the registry's "Protected
  // branches" table are two independently maintained copies of one destructive
  // safeguard. Drift is silent and one-directional — a branch added to the
  // registry but not to the script is reported SAFE and deleted, which is the
  // accident this list exists to prevent and which has already happened once.
  // The script keeps its literal list (it must refuse correctly even from a
  // partial checkout, where parsing the registry could fail open), so the drift
  // is caught here instead: adding a branch to only one artifact reddens CI.
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
