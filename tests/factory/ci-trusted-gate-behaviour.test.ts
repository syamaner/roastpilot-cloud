import { execFileSync, spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/ci.yml", import.meta.url),
);
const REPOSITORY_ROOT = resolve(dirname(WORKFLOW_PATH), "../..");
const GIT = "/usr/bin/git";
const CLASSIFIER_PATH = "snowflake/ci_change_classifier.py";
const GATE_PATH = "snowflake/ci_gate_result.py";
const CLASSIFY_STEP = "Classify pull-request change";
const CHECKS_STEP = "Require every CI job to match its change class";

type Mapping = Record<string, unknown>;
type Replacement = "file" | "symlink" | "directory";

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

function stepRun(jobName: string, stepName: string): string {
  const jobs = asMapping(workflow().jobs);
  const steps = asMapping(jobs[jobName]).steps;
  if (!Array.isArray(steps)) throw new Error(`${jobName} has no steps`);
  const found = steps.map(asMapping).find((step) => step.name === stepName);
  if (!found || typeof found.run !== "string") {
    throw new Error(`${jobName} has no executable ${stepName} step`);
  }
  return found.run;
}

const CLASSIFY_RUN = stepRun("classify", CLASSIFY_STEP);
const CHECKS_RUN = stepRun("checks", CHECKS_STEP);
const HONEST_CLASSIFIER = readFileSync(join(REPOSITORY_ROOT, CLASSIFIER_PATH));
const HONEST_GATE = readFileSync(join(REPOSITORY_ROOT, GATE_PATH));
const ATTACKER_CLASSIFIER = `import os
with open(os.environ["GITHUB_OUTPUT"], "a", encoding="utf-8") as output:
    output.write("mode=docs-only\\n")
`;
const ATTACKER_GATE = "raise SystemExit(0)\n";

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

function write(root: string, path: string, contents: string | Buffer): void {
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
  readonly repository: string;
  readonly trustedSha: string;
  readonly attackerSha: string;
}

function replaceWithAttacker(
  repository: string,
  path: string,
  attackerName: string,
  attackerSource: string,
  replacement: Replacement,
): void {
  const target = join(repository, path);
  rmSync(target, { recursive: true, force: true });
  if (replacement === "file") {
    writeFileSync(target, attackerSource);
  } else if (replacement === "symlink") {
    write(repository, attackerName, attackerSource);
    symlinkSync(`../${attackerName}`, target);
  } else {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "__main__.py"), attackerSource);
  }
}

function createFixture(replacement: Replacement): Fixture {
  const parent = mkdtempSync(join(tmpdir(), "ci-trusted-gate-"));
  const origin = join(parent, "origin.git");
  const repository = join(parent, "repository");
  git(parent, ["init", "--quiet", "--bare", origin]);
  git(origin, ["config", "uploadpack.allowAnySHA1InWant", "true"]);
  git(parent, ["clone", "--quiet", origin, repository]);
  git(repository, ["config", "user.email", "ci-gate-test@example.com"]);
  git(repository, ["config", "user.name", "CI Gate Test"]);
  git(repository, ["checkout", "--quiet", "-b", "main"]);
  write(repository, CLASSIFIER_PATH, HONEST_CLASSIFIER);
  write(repository, GATE_PATH, HONEST_GATE);
  write(repository, "app.txt", "trusted\n");
  const trustedSha = commit(repository, "trusted gate scripts");
  git(repository, ["push", "--quiet", "-u", "origin", "main"]);

  git(repository, ["checkout", "--quiet", "-b", "attacker", trustedSha]);
  write(repository, "app.txt", "attacker non-doc change\n");
  replaceWithAttacker(
    repository,
    CLASSIFIER_PATH,
    "attacker-classifier.py",
    ATTACKER_CLASSIFIER,
    replacement,
  );
  replaceWithAttacker(
    repository,
    GATE_PATH,
    "attacker-gate.py",
    ATTACKER_GATE,
    replacement,
  );
  const attackerSha = commit(repository, `attacker ${replacement} replacements`);
  git(repository, ["push", "--quiet", "origin", "attacker"]);
  return { parent, repository, trustedSha, attackerSha };
}

function withFixture(
  replacement: Replacement,
  run: (fixture: Fixture) => void,
): void {
  const fixture = createFixture(replacement);
  try {
    run(fixture);
  } finally {
    rmSync(fixture.parent, { recursive: true, force: true });
  }
}

function assertTrustedRegularFile(
  fixture: Fixture,
  path: string,
  expected: Buffer,
): void {
  const restored = join(fixture.repository, path);
  expect(lstatSync(restored).isFile()).toBe(true);
  expect(lstatSync(restored).isSymbolicLink()).toBe(false);
  expect(readFileSync(restored)).toEqual(expected);
}

function runClassify(fixture: Fixture) {
  const outputPath = join(fixture.parent, "classify-output");
  writeFileSync(outputPath, "");
  const result = spawnSync("bash", ["-c", CLASSIFY_RUN], {
    cwd: fixture.repository,
    encoding: "utf8",
    env: {
      ...process.env,
      EVENT_NAME: "pull_request",
      BASE_SHA: fixture.trustedSha,
      HEAD_SHA: fixture.attackerSha,
      TRUSTED_SHA: fixture.trustedSha,
      GITHUB_OUTPUT: outputPath,
    },
  });
  return { ...result, output: readFileSync(outputPath, "utf8") };
}

function gateNeeds(playwright: string): string {
  return JSON.stringify(
    Object.fromEntries(
      [
        ["gates", "success"],
        ["classify", "success"],
        ["resolve-trusted-revision", "success"],
        ["playwright", playwright],
        ["snowflake-migrations", "success"],
        ["mutation-testing", "success"],
      ].map(([name, result]) => [name, { result }]),
    ),
  );
}

function checksEnvironment(overrides: Record<string, string> = {}) {
  return {
    ...process.env,
    MODE: "full",
    NEEDS_JSON: gateNeeds("failure"),
    TRUSTED_SHA: "malformed",
    R_GATES: "success",
    R_CLASSIFY: "success",
    R_PLAYWRIGHT: "success",
    R_SNOWFLAKE: "success",
    R_MUTATION: "success",
    ...overrides,
  };
}

function runChecks(fixture: Fixture) {
  return spawnSync("bash", ["-c", CHECKS_RUN], {
    cwd: fixture.repository,
    encoding: "utf8",
    env: checksEnvironment({ TRUSTED_SHA: fixture.trustedSha }),
  });
}

describe("CI trusted gate executable behavior", () => {
  it.each<Replacement>(["file", "symlink", "directory"])(
    "restores trusted scripts over an attacker-controlled HEAD %s",
    (replacement) => {
      withFixture(replacement, (fixture) => {
        const classify = runClassify(fixture);
        expect(classify.status, classify.stderr).toBe(0);
        expect(classify.output).toBe("mode=full\n");
        expect(classify.output).not.toContain("docs-only");
        assertTrustedRegularFile(fixture, CLASSIFIER_PATH, HONEST_CLASSIFIER);

        const checks = runChecks(fixture);
        expect(checks.status).not.toBe(0);
        expect(checks.stdout).toContain("playwright\tsuccess\tfailure");
        assertTrustedRegularFile(fixture, GATE_PATH, HONEST_GATE);
      });
    },
  );

  it("classify emits exactly full and succeeds when trusted restoration cannot start", () => {
    const parent = mkdtempSync(join(tmpdir(), "ci-classify-fallback-"));
    try {
      const outputPath = join(parent, "github-output");
      writeFileSync(outputPath, "");
      const result = spawnSync("bash", ["-c", CLASSIFY_RUN], {
        cwd: parent,
        encoding: "utf8",
        env: {
          ...process.env,
          EVENT_NAME: "pull_request",
          BASE_SHA: "a".repeat(40),
          HEAD_SHA: "b".repeat(40),
          TRUSTED_SHA: "malformed",
          GITHUB_OUTPUT: outputPath,
        },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(outputPath, "utf8")).toBe("mode=full\n");
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it.each([
    ["full", "all-success", "success", 0],
    ["full", "one-skipped", "skipped", 1],
    ["full", "one-failure", "failure", 1],
    ["docs-only", "all-success", "success", 1],
    ["docs-only", "one-skipped", "skipped", 1],
    ["docs-only", "one-failure", "failure", 1],
    ["", "all-success", "success", 1],
    ["", "one-skipped", "skipped", 1],
    ["", "one-failure", "failure", 1],
  ] as const)(
    "checks fallback mode=%j results=%s exits %i",
    (mode, _caseName, mutationResult, expectedStatus) => {
      const result = spawnSync("bash", ["-c", CHECKS_RUN], {
        encoding: "utf8",
        env: checksEnvironment({
          MODE: mode,
          R_MUTATION: mutationResult,
          TRUSTED_SHA: "malformed",
        }),
      });
      expect(result.status, result.stderr).toBe(expectedStatus);
    },
  );
});
