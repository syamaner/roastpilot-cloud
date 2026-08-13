import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/claude-code-review.yml", import.meta.url),
);
const GIT = "/usr/bin/git";
const RESOLVER = "resolve-trusted-revision";
const RESOLVER_STEP = "Resolve the trusted revision";
const REVIEW_RESTORE = "Restore base-owned configuration";
const REVIEW_DIFF = "Compute the PR diff from trusted revisions";
const SPEC_RESTORE =
  "Restore trusted configuration + manifests from the trusted revision";
const PUBLISH_JOB = "publish-spec-grounding-review";
const PUBLISH_ASSERT = "Assert the resolved trusted revision";

type Mapping = Record<string, unknown>;

function asMapping(value: unknown): Mapping {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected mapping");
  }
  return value as Mapping;
}

function workflow(): Mapping {
  const document = parseDocument(readFileSync(WORKFLOW_PATH, "utf8"));
  expect(document.errors).toEqual([]);
  return document.toJS() as Mapping;
}

function job(name: string): Mapping {
  return asMapping(asMapping(workflow().jobs)[name]);
}

function steps(name: string): Mapping[] {
  const value = job(name).steps;
  if (!Array.isArray(value)) throw new Error(`${name} has no steps`);
  return value.map(asMapping);
}

function namedStep(jobName: string, name: string): Mapping {
  const step = steps(jobName).find((candidate) => candidate.name === name);
  if (!step) throw new Error(`${jobName} has no ${name} step`);
  return step;
}

function stepRun(jobName: string, name: string): string {
  const run = namedStep(jobName, name).run;
  if (typeof run !== "string") throw new Error(`${name} has no run body`);
  return run;
}

function git(cwd: string, args: string[]): string {
  return execFileSync(GIT, ["-c", "core.excludesFile=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    },
  });
}

function write(root: string, path: string, contents: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function commit(repository: string, message: string): string {
  git(repository, ["add", "-A"]);
  git(repository, ["commit", "--quiet", "-m", message]);
  return git(repository, ["rev-parse", "HEAD"]).trim();
}

interface Fixture {
  readonly parent: string;
  readonly origin: string;
  readonly repository: string;
  readonly baseSha: string;
  readonly attackerSha: string;
  readonly mainTipSha: string;
}

function createFixture(): Fixture {
  const parent = mkdtempSync(join(tmpdir(), "trusted-revision-"));
  const origin = join(parent, "origin.git");
  const repository = join(parent, "repository");
  git(parent, ["init", "--quiet", "--bare", origin]);
  git(origin, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  git(parent, ["clone", "--quiet", origin, repository]);
  git(repository, ["config", "user.email", "resolver-test@example.com"]);
  git(repository, ["config", "user.name", "Resolver Test"]);
  git(repository, ["checkout", "--quiet", "-b", "main"]);
  write(repository, "trusted.txt", "trusted base\n");
  write(repository, "scripts/factory/base.txt", "base factory\n");
  write(
    repository,
    ".claude/skills/spec-grounded-review/SKILL.md",
    "base skill\n",
  );
  const baseSha = commit(repository, "base");
  git(repository, ["push", "--quiet", "-u", "origin", "main"]);
  git(origin, ["symbolic-ref", "HEAD", "refs/heads/main"]);

  git(repository, ["checkout", "--quiet", "-b", "attacker-base", baseSha]);
  write(repository, ".claude/settings.json", "attacker hook\n");
  write(repository, ".mcp.json", "attacker server\n");
  const attackerSha = commit(repository, "attacker base");
  git(repository, ["push", "--quiet", "origin", "attacker-base"]);

  git(repository, ["checkout", "--quiet", "main"]);
  write(repository, "main-tip.txt", "advanced main\n");
  const mainTipSha = commit(repository, "advance main");
  git(repository, ["push", "--quiet", "origin", "main"]);
  return { parent, origin, repository, baseSha, attackerSha, mainTipSha };
}

function withFixture(run: (fixture: Fixture) => void): void {
  const fixture = createFixture();
  try {
    run(fixture);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
}

interface ResolverResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly output: string;
  readonly values: Readonly<Record<string, string>>;
}

function runResolver(
  fixture: Fixture,
  options: {
    readonly baseSha?: string;
    readonly baseRef?: string;
    readonly defaultBranch?: string;
    readonly remoteUrl?: string;
    readonly path?: string;
  } = {},
): ResolverResult {
  const outputPath = join(fixture.parent, "github-output");
  writeFileSync(outputPath, "");
  const result = spawnSync("bash", ["-c", stepRun(RESOLVER, RESOLVER_STEP)], {
    cwd: fixture.repository,
    encoding: "utf8",
    env: {
      ...process.env,
      BASE_SHA:
        options.baseSha !== undefined ? options.baseSha : fixture.baseSha,
      BASE_REF: options.baseRef ?? "main",
      DEFAULT_BRANCH: options.defaultBranch ?? "main",
      REMOTE_URL: options.remoteUrl ?? fixture.origin,
      GITHUB_OUTPUT: outputPath,
      PATH: options.path ?? process.env.PATH,
    },
  });
  const output = readFileSync(outputPath, "utf8");
  const values = Object.fromEntries(
    output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    output,
    values,
  };
}

function runConsumer(fixture: Fixture, jobName: string, sha: string) {
  const stepName = jobName === "claude-review" ? REVIEW_RESTORE : SPEC_RESTORE;
  return spawnSync("bash", ["-c", stepRun(jobName, stepName)], {
    cwd: fixture.repository,
    encoding: "utf8",
    env: { ...process.env, TRUSTED_SHA: sha },
  });
}

function runPublishAssert(sha: string) {
  return spawnSync("bash", ["-c", stepRun(PUBLISH_JOB, PUBLISH_ASSERT)], {
    encoding: "utf8",
    env: { ...process.env, TRUSTED_SHA: sha },
  });
}

function fakeGit(fixture: Fixture, body: string): string {
  const directory = join(fixture.parent, "fake-bin");
  mkdirSync(directory);
  const script = join(directory, "git");
  writeFileSync(script, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(script, 0o755);
  return `${directory}:/usr/bin:/bin`;
}

describe("trusted revision resolver executable contract", () => {
  it("R1 trusts base.sha when base.ref byte-equals the default branch", () => {
    withFixture((fixture) => {
      const result = runResolver(fixture);
      expect(result.status, result.stderr).toBe(0);
      expect(result.values).toEqual({
        "trusted-sha": fixture.baseSha,
        "trusted-source": "base-sha",
      });
      expect(fixture.mainTipSha).not.toBe(fixture.baseSha);
    });
  });

  it("R2 resolves the default-branch tip after a retarget", () => {
    withFixture((fixture) => {
      const result = runResolver(fixture, {
        baseSha: fixture.attackerSha,
        baseRef: "attacker-base",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.values["trusted-sha"]).toBe(fixture.mainTipSha);
      expect(result.values["trusted-source"]).toBe("default-branch-tip");
    });
  });

  it.each(["Main", "main ", " main", "MAIN", "refs/heads/main", "main/", ""])(
    "R3 treats near-miss base ref %j as untrusted",
    (baseRef) => {
      withFixture((fixture) => {
        const result = runResolver(fixture, {
          baseSha: fixture.attackerSha,
          baseRef,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.values["trusted-sha"]).toBe(fixture.mainTipSha);
      });
    },
  );

  it("R4 rejects an unavailable default branch with the exact diagnostic", () => {
    withFixture((fixture) => {
      const result = runResolver(fixture, { defaultBranch: "" });
      expect(result.status).not.toBe(0);
      expect(result.stdout).toContain(
        "::error::default_branch unavailable; cannot establish a trusted revision",
      );
      expect(result.output).toBe("");
    });
  });

  it.each(["--upload-pack=touch", "ma in"])(
    "R5 rejects unsafe default branch %j before git",
    (defaultBranch) => {
      withFixture((fixture) => {
        const marker = join(fixture.parent, "git-reached");
        const path = fakeGit(fixture, `touch ${marker}\nexit 99`);
        const result = runResolver(fixture, {
          baseRef: "attacker-base",
          defaultBranch,
          path,
        });
        expect(result.status).not.toBe(0);
        expect(result.output).toBe("");
        expect(existsSync(marker)).toBe(false);
      });
    },
  );

  it.each(["refs/heads/main", "../main", "$(touch PWNED)", "*"])(
    "R6 compares hostile BASE_REF %j without dereferencing it",
    (baseRef) => {
      withFixture((fixture) => {
        const pwned = join(fixture.parent, "PWNED");
        const result = runResolver(fixture, {
          baseRef: baseRef.replace("PWNED", pwned),
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.values["trusted-sha"]).toBe(fixture.mainTipSha);
        expect(existsSync(pwned)).toBe(false);
      });
    },
  );

  it("R7 ignores a decoy suffix ref and selects the one exact ref", () => {
    withFixture((fixture) => {
      const path = fakeGit(
        fixture,
        `printf '%s\\t%s\\n' '${fixture.attackerSha}' 'decoy/refs/heads/main' '${fixture.mainTipSha}' 'refs/heads/main'`,
      );
      const result = runResolver(fixture, {
        baseRef: "attacker-base",
        path,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.values["trusted-sha"]).toBe(fixture.mainTipSha);
    });
  });

  it("R7b filters a real git ls-remote decoy suffix ref", () => {
    withFixture((fixture) => {
      git(fixture.repository, [
        "checkout",
        "--quiet",
        "-b",
        "decoy/refs/heads/main",
        fixture.attackerSha,
      ]);
      write(fixture.repository, "decoy.txt", "decoy branch\n");
      const decoySha = commit(fixture.repository, "decoy branch");
      git(fixture.repository, [
        "push",
        "--quiet",
        "origin",
        "HEAD:refs/heads/decoy/refs/heads/main",
      ]);
      git(fixture.repository, ["checkout", "--quiet", "main"]);

      const advertised = git(fixture.repository, [
        "ls-remote",
        fixture.origin,
        "refs/heads/main",
      ]);
      expect(advertised).toContain(
        `${decoySha}\trefs/heads/decoy/refs/heads/main`,
      );
      expect(advertised).toContain(`${fixture.mainTipSha}\trefs/heads/main`);

      const result = runResolver(fixture, { baseRef: "attacker-base" });
      expect(result.status, result.stderr).toBe(0);
      expect(result.values["trusted-sha"]).toBe(fixture.mainTipSha);
      expect(result.values["trusted-sha"]).not.toBe(decoySha);
    });
  });

  it("R8 fails closed when the default branch is absent", () => {
    withFixture((fixture) => {
      const path = fakeGit(
        fixture,
        `printf '%s\\t%s\\n' '${fixture.attackerSha}' 'decoy/refs/heads/missing'`,
      );
      const result = runResolver(fixture, {
        baseRef: "attacker-base",
        defaultBranch: "missing",
        path,
      });
      expect(result.status).not.toBe(0);
      expect(result.output).toBe("");
    });
  });

  it("R9 fails closed when the remote is unreachable", () => {
    withFixture((fixture) => {
      const result = runResolver(fixture, {
        baseRef: "attacker-base",
        remoteUrl: join(fixture.parent, "absent.git"),
      });
      expect(result.status).not.toBe(0);
      expect(result.output).toBe("");
      expect(result.stdout).not.toContain("default branch lookup returned");
    });
  });

  it("R10 emits only the closed output grammar", () => {
    withFixture((fixture) => {
      const result = runResolver(fixture);
      expect(result.output).toMatch(
        /^trusted-sha=[0-9a-f]{40}\ntrusted-source=(base-sha|default-branch-tip)\n$/,
      );
    });
  });

  it.each(["", "HEAD", "A".repeat(40), "a".repeat(39)])(
    "R11 rejects malformed conditionally trusted base SHA %j",
    (baseSha) => {
      withFixture((fixture) => {
        const result = runResolver(fixture, { baseSha });
        expect(result.status).not.toBe(0);
        expect(result.output).toBe("");
      });
    },
  );
});

describe("trusted revision consumers", () => {
  it("G8 executes the privileged publish SHA assertion", () => {
    const malformed = [
      "",
      "HEAD",
      "$(id)",
      "a".repeat(39),
      "a".repeat(41),
      "A".repeat(40),
    ];
    for (const sha of malformed) {
      const result = runPublishAssert(sha);
      expect(result.status, `TRUSTED_SHA=${JSON.stringify(sha)}`).not.toBe(0);
    }

    const valid = runPublishAssert("a".repeat(40));
    expect(valid.status, valid.stderr).toBe(0);
  });

  it("R12 keeps the claude-review total restore behaviour", () => {
    withFixture((fixture) => {
      git(fixture.repository, ["checkout", "--quiet", "-b", "feature", "main"]);
      write(fixture.repository, ".mcp.json", "malicious server\n");
      write(fixture.repository, "trusted.txt", "malicious edit\n");
      commit(fixture.repository, "feature");
      const result = runConsumer(fixture, "claude-review", fixture.mainTipSha);
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(fixture.repository, ".mcp.json"))).toBe(false);
      expect(readFileSync(join(fixture.repository, "trusted.txt"), "utf8")).toBe(
        "trusted base\n",
      );
    });
  });

  it.each(["", "HEAD", "$(id)", "a".repeat(39)])(
    "R13 both restore consumers reject malformed SHA %j before mutation",
    (sha) => {
      for (const jobName of ["claude-review", "spec-grounded-review"]) {
        withFixture((fixture) => {
          git(fixture.repository, ["checkout", "--quiet", "-b", "feature", "main"]);
          write(fixture.repository, ".mcp.json", "must survive failure\n");
          commit(fixture.repository, "feature");
          const result = runConsumer(fixture, jobName, sha);
          expect(result.status).not.toBe(0);
          expect(existsSync(join(fixture.repository, ".mcp.json"))).toBe(true);
        });
      }
    },
  );

  it("R14 keeps only the site-2 PR-head exceptions", () => {
    withFixture((fixture) => {
      git(fixture.repository, ["checkout", "--quiet", "-b", "feature", "main"]);
      write(fixture.repository, ".mcp.json", "malicious server\n");
      write(fixture.repository, "scripts/factory/base.txt", "PR factory\n");
      write(
        fixture.repository,
        ".claude/skills/spec-grounded-review/SKILL.md",
        "PR skill\n",
      );
      commit(fixture.repository, "feature");
      const result = runConsumer(
        fixture,
        "spec-grounded-review",
        fixture.mainTipSha,
      );
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(fixture.repository, ".mcp.json"))).toBe(false);
      expect(readFileSync(join(fixture.repository, "scripts/factory/base.txt"), "utf8")).toBe("PR factory\n");
      expect(readFileSync(join(fixture.repository, ".claude/skills/spec-grounded-review/SKILL.md"), "utf8")).toBe("PR skill\n");
    });
  });

  it("R15 restores site 2 from default branch after attacker-base retarget", () => {
    withFixture((fixture) => {
      git(fixture.repository, [
        "checkout",
        "--quiet",
        "-b",
        "feature",
        "attacker-base",
      ]);
      write(fixture.repository, "feature.txt", "feature\n");
      commit(fixture.repository, "feature");
      const resolved = runResolver(fixture, {
        baseSha: fixture.attackerSha,
        baseRef: "attacker-base",
      });
      const result = runConsumer(
        fixture,
        "spec-grounded-review",
        resolved.values["trusted-sha"] ?? "",
      );
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(fixture.repository, ".claude/settings.json"))).toBe(false);
      expect(existsSync(join(fixture.repository, ".mcp.json"))).toBe(false);
      expect(() =>
        git(fixture.repository, ["diff", "--quiet", fixture.mainTipSha, "--", "."]),
      ).not.toThrow();
    });
  });
});

describe("trusted revision workflow structure", () => {
  it("R16 pins the resolver's exact outputs and event-only env", () => {
    const resolveJob = job(RESOLVER);
    const resolve = namedStep(RESOLVER, RESOLVER_STEP);
    expect(asMapping(resolveJob.outputs)).toEqual({
      "trusted-sha": "${{ steps.resolve.outputs.trusted-sha }}",
      "trusted-source": "${{ steps.resolve.outputs.trusted-source }}",
    });
    expect(resolve.id).toBe("resolve");
    expect(asMapping(resolve.env)).toEqual({
      BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      BASE_REF: "${{ github.event.pull_request.base.ref }}",
      DEFAULT_BRANCH: "${{ github.event.repository.default_branch }}",
      REMOTE_URL: "${{ github.server_url }}/${{ github.repository }}.git",
    });
    expect(resolve.run).not.toContain("${{");
  });

  it("R17 pins strict mode and every resolver failure boundary", () => {
    const run = stepRun(RESOLVER, RESOLVER_STEP);
    expect(run).toContain("set -euo pipefail");
    expect(run).toContain(
      "::error::default_branch unavailable; cannot establish a trusted revision",
    );
    expect(run).toContain('case "$DEFAULT_BRANCH" in');
    expect(run).toContain("-*|*[[:space:]]*|*'*'*)");
    expect(run).toContain('[ "$MATCH_COUNT" -ne 1 ]');
    expect(run).toContain("^[0-9a-f]{40}$");
    expect(run).not.toMatch(/git ls-remote[^\n]*\|\| true/);
  });

  it("R18 never passes BASE_REF to git", () => {
    const run = stepRun(RESOLVER, RESOLVER_STEP);
    expect(run).not.toMatch(/git\b[^\n]*\$\{?BASE_REF/);
  });

  it("R19 admits only the payload-base diff's extra base.sha binding and no event checkout ref", () => {
    const source = readFileSync(WORKFLOW_PATH, "utf8");
    expect(source.split("github.event.pull_request.base.sha")).toHaveLength(3);
    for (const expression of [
      "github.event.pull_request.base.ref",
      "github.event.repository.default_branch",
    ]) {
      expect(source.split(expression)).toHaveLength(2);
    }
    expect(asMapping(namedStep("claude-review", REVIEW_DIFF).env)).toEqual({
      BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      DIFF_MAX_BYTES: "65536",
    });
    for (const jobValue of Object.values(asMapping(workflow().jobs))) {
      const jobSteps = asMapping(jobValue).steps;
      if (!Array.isArray(jobSteps)) continue;
      for (const step of jobSteps.map(asMapping)) {
        if (typeof step.uses !== "string" || !step.uses.startsWith("actions/checkout@")) continue;
        const ref = asMapping(step.with ?? {}).ref;
        expect(typeof ref === "string" && ref.includes("github.event.")).toBe(false);
      }
    }
  });

  it.each(["claude-review", "spec-grounded-review"])(
    "R20 wires read-only consumer %s to the shared output without override guards",
    (jobName) => {
      const consumer = job(jobName);
      const restore = namedStep(
        jobName,
        jobName === "claude-review" ? REVIEW_RESTORE : SPEC_RESTORE,
      );
      expect(consumer.needs).toBe(RESOLVER);
      expect(String(consumer.if)).not.toMatch(/always\(\)|!cancelled\(\)/);
      expect(asMapping(restore.env)).toEqual({
        TRUSTED_SHA:
          "${{ needs.resolve-trusted-revision.outputs.trusted-sha }}",
      });
    },
  );

  it("R21 pins the privileged consumer's needs, gate, and first two steps", () => {
    const publish = job("publish-spec-grounding-review");
    expect(publish.needs).toEqual([
      RESOLVER,
      "spec-grounded-review",
    ]);
    expect(String(publish.if)).toContain(
      "needs.resolve-trusted-revision.result == 'success'",
    );
    const publishSteps = steps("publish-spec-grounding-review");
    expect(publishSteps[0]?.name).toBe("Assert the resolved trusted revision");
    expect(publishSteps[1]?.name).toBe(
      "Checkout TRUSTED base only -- never the PR's own head",
    );
    expect(asMapping(publishSteps[1]?.with).ref).toBe(
      "${{ needs.resolve-trusted-revision.outputs.trusted-sha }}",
    );
  });

  it("R22 preserves the publisher's exact permissions", () => {
    expect(asMapping(job("publish-spec-grounding-review").permissions)).toEqual({
      contents: "read",
      issues: "read",
      "pull-requests": "write",
    });
  });

  it("R23 keeps the resolver credential-free and free of local actions", () => {
    const resolveJob = job(RESOLVER);
    expect(asMapping(resolveJob.permissions)).toEqual({});
    expect(resolveJob["runs-on"]).toBe("ubuntu-latest");
    expect(steps(RESOLVER)).toHaveLength(1);
    expect(
      steps(RESOLVER).some(
        (step) => typeof step.uses === "string" && step.uses.startsWith("./"),
      ),
    ).toBe(false);
  });
});
