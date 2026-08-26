import { readFileSync, readdirSync, type Dirent } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

// Issue #157: every `anthropics/claude-code-action` invocation must run on the
// job's own built-in `GITHUB_TOKEN` (`github_token: ${{ secrets.GITHUB_TOKEN
// }}`), never letting the action OIDC-mint its own write-capable App token into
// the model's Bash subprocess env. The class this guards is a claude-code-action
// invocation that OMITS `github_token` (the claude-review defect #157 fixes).
// Since #199, claude-review itself has no Bash grant; T-5 nonetheless guards the
// broader class for every current or future claude-code-action invocation
// rather than relying on that one job's present tool surface. `factory-security-
// reviewer.md` already states this rule as a PROMPT; this file converts it to a
// gate: T-5 (every invocation passes the built-in token, with a count tripwire)
// and T-6 (no `id-token` anywhere) mechanically stop the class from returning.
//
// Structure mirrors the claude-code-review workflow-contract tests: parse the
// real corpus, assert the invariants against it, and exercise the negative
// space with synthetic YAML fed through the same validator.

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORKFLOWS_DIR = join(REPOSITORY_ROOT, ".github", "workflows");
const ACTIONS_DIR = join(REPOSITORY_ROOT, ".github", "actions");
const REVIEW_WORKFLOW_PATH = join(
  WORKFLOWS_DIR,
  "claude-code-review.yml",
);
const REVIEW_WORKFLOW_CONTENT = readFileSync(REVIEW_WORKFLOW_PATH, "utf8");

const CLAUDE_ACTION_PREFIX = "anthropics/claude-code-action@";
// The exact expression the action must be handed. A PAT-style secret, or the
// OIDC-minted App token that a missing input produces, are both rejected.
const BUILTIN_TOKEN = "${{ secrets.GITHUB_TOKEN }}";
// The claude-review job's declared ceiling once #157 lands: no write beyond the
// `pull-requests: write` the review posts under, no `id-token`, reads only
// otherwise.
const EXPECTED_REVIEW_PERMISSIONS = {
  contents: "read",
  "pull-requests": "write",
  issues: "read",
  actions: "read",
};
// The triggering-actor allowlist (#146). Unrelated to comment authorship, and
// must NOT move when the completion-comment author literal changes -- T-4.
const EXPECTED_ALLOWED_BOTS =
  "claude,claude[bot],roastpilot-factory,roastpilot-factory[bot]";
// The live corpus has exactly eight invocations (claude-review, spec-grounded,
// triage, implement, owner-command answer-agent, owner-command task-agent, and
// the two dark task-agent read-confinement probes). A ninth must fail this
// tripwire so it cannot be added without owning the `github_token` contract
// too (class sweep, #157 §4).
// 9 Aug 2026, 9e Unit 2 PR2b: the fifth invocation is the DARK
// owner-command-intake.yml answer-agent. It explicitly passes the built-in
// `github_token: ${{ secrets.GITHUB_TOKEN }}`, so the #157 token-model contract
// remains satisfied: `analysis.failures` stays empty and only the count moved.
// 10 Aug 2026, F1-S6 slice 9g PR2a: the dark task-agent is the sixth and carries
// the same explicit built-in token binding.
// 20 Aug 2026, Refs #237: the operator-run read-confinement probe is the
// seventh, with the same binding and no OIDC permission.
// 26 Aug 2026, D-F2-A7: the parallel scoped-reader probe is the eighth and
// carries the same explicit built-in token binding and no OIDC permission.
const EXPECTED_INVOCATION_COUNT = 8;

type Mapping = Record<string, unknown>;

interface SourceFile {
  readonly path: string;
  readonly content: string;
}

interface TokenModelAnalysis {
  readonly failures: string[];
  readonly invocationCount: number;
}

function asMapping(value: unknown): Mapping | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Mapping)
    : undefined;
}

// GitHub resolves `uses:` action references case-INSENSITIVELY, so
// `ANTHROPICS/Claude-Code-Action@<sha>` runs exactly as the canonical spelling
// would (LOW-1, factory-security-reviewer). Normalize to lower case before the
// prefix compare so a case-variant invocation cannot slip past the enumerator
// (and therefore past the count tripwire AND the github_token check). YAML
// anchors/aliases need no handling here: `toJS` resolves them before we look.
function isClaudeActionUses(uses: unknown): boolean {
  return (
    typeof uses === "string" &&
    uses.toLowerCase().startsWith(CLAUDE_ACTION_PREFIX)
  );
}

// Every step across a workflow's jobs AND a composite action's `runs.steps`, so
// a claude-code-action invocation hidden in a composite action is still seen
// (G4' -- proves the enumeration is not workflow-only).
function stepsOf(parsed: Mapping): Mapping[] {
  const steps: Mapping[] = [];
  const jobs = asMapping(parsed.jobs);
  if (jobs) {
    for (const job of Object.values(jobs)) {
      const jobSteps = asMapping(job)?.steps;
      if (Array.isArray(jobSteps)) {
        for (const step of jobSteps) {
          const mapping = asMapping(step);
          if (mapping) {
            steps.push(mapping);
          }
        }
      }
    }
  }
  const runSteps = asMapping(parsed.runs)?.steps;
  if (Array.isArray(runSteps)) {
    for (const step of runSteps) {
      const mapping = asMapping(step);
      if (mapping) {
        steps.push(mapping);
      }
    }
  }
  return steps;
}

// Every permissions declaration: workflow-level and each job's. `id-token` is a
// permission, so both scopes are checked (T-6a job, T-6b workflow-level).
function permissionsBlocksOf(parsed: Mapping): unknown[] {
  const blocks: unknown[] = [];
  if (Object.prototype.hasOwnProperty.call(parsed, "permissions")) {
    blocks.push(parsed.permissions);
  }
  const jobs = asMapping(parsed.jobs);
  if (jobs) {
    for (const job of Object.values(jobs)) {
      const mapping = asMapping(job);
      if (mapping && Object.prototype.hasOwnProperty.call(mapping, "permissions")) {
        blocks.push(mapping.permissions);
      }
    }
  }
  return blocks;
}

// The permissions declarations that GOVERN a claude-code-action invocation:
// workflow-level (governs every job) when the file holds an invocation, plus
// the permissions of each job that itself holds one. A SCALAR value here
// (`write-all`/`read-all`/any non-mapping) grants id-token: write implicitly and
// cannot be analysed key-by-key, so it must fail closed (LOW-2). Scoping to
// governing blocks keeps that fail-closed off unrelated jobs/workflows that may
// legitimately use a scalar and never touch claude-code-action.
function invocationGoverningPermissions(
  parsed: Mapping,
): { scope: string; value: unknown }[] {
  const jobs = asMapping(parsed.jobs);
  const jobEntries = jobs ? Object.entries(jobs) : [];
  const fileHasInvocation =
    stepsOf(parsed).some((step) => isClaudeActionUses(step.uses));
  if (!fileHasInvocation) {
    return [];
  }
  const governing: { scope: string; value: unknown }[] = [];
  if (Object.prototype.hasOwnProperty.call(parsed, "permissions")) {
    governing.push({ scope: "workflow-level", value: parsed.permissions });
  }
  for (const [jobId, job] of jobEntries) {
    const mapping = asMapping(job);
    if (!mapping) {
      continue;
    }
    const jobSteps = Array.isArray(mapping.steps) ? mapping.steps : [];
    const holdsInvocation = jobSteps.some((step) =>
      isClaudeActionUses(asMapping(step)?.uses),
    );
    if (
      holdsInvocation &&
      Object.prototype.hasOwnProperty.call(mapping, "permissions")
    ) {
      governing.push({ scope: `job ${jobId}`, value: mapping.permissions });
    }
  }
  return governing;
}

function analyzeTokenModel(files: readonly SourceFile[]): TokenModelAnalysis {
  const failures: string[] = [];
  let invocationCount = 0;
  for (const { path, content } of files) {
    const document = parseDocument(content);
    if (document.errors.length > 0) {
      // Fail closed: a file we cannot parse is never treated as compliant.
      failures.push(`${path}: not valid YAML`);
      continue;
    }
    const parsed = asMapping(document.toJS({ maxAliasCount: 100 }));
    if (!parsed) {
      failures.push(`${path}: top-level document is not a mapping`);
      continue;
    }
    for (const step of stepsOf(parsed)) {
      if (!isClaudeActionUses(step.uses)) {
        continue;
      }
      invocationCount += 1;
      const withBlock = asMapping(step.with);
      const token = withBlock?.github_token;
      if (token === undefined) {
        failures.push(
          `${path}: claude-code-action invocation must pass github_token`,
        );
      } else if (token !== BUILTIN_TOKEN) {
        failures.push(
          `${path}: claude-code-action github_token must be the built-in secrets.GITHUB_TOKEN`,
        );
      }
    }
    for (const block of permissionsBlocksOf(parsed)) {
      const permissions = asMapping(block);
      if (
        permissions &&
        Object.prototype.hasOwnProperty.call(permissions, "id-token")
      ) {
        failures.push(`${path}: permissions must not request id-token`);
      }
    }
    for (const governing of invocationGoverningPermissions(parsed)) {
      if (asMapping(governing.value) === undefined) {
        // A scalar `permissions: write-all` (or any non-mapping) grants
        // id-token: write implicitly and cannot be checked key-by-key, so a
        // block that governs a claude-code-action invocation fails closed here
        // (LOW-2). An explicit mapping, including an empty `{}`, is analysable
        // and passes this check.
        failures.push(
          `${path}: permissions (${governing.scope}) governing a claude-code-action invocation must be an explicit mapping, not a scalar such as write-all/read-all`,
        );
      }
    }
  }
  return { failures, invocationCount };
}

function collectSourceFiles(): SourceFile[] {
  const files: SourceFile[] = [];
  for (const name of readdirSync(WORKFLOWS_DIR)) {
    if (/\.ya?ml$/i.test(name)) {
      files.push({
        path: `.github/workflows/${name}`,
        content: readFileSync(join(WORKFLOWS_DIR, name), "utf8"),
      });
    }
  }
  // Composite actions: `action.yml`/`action.yaml` at ANY depth under
  // `.github/actions`. The tree may not exist yet (none live today); the walk
  // tolerates that so the glob is enforced the moment one is added.
  const walk = (directory: string, relative: string): void => {
    let entries: Dirent[];
    try {
      // `withFileTypes` returns the entry KIND from the same directory read, so
      // the recurse/read branch below is decided off the Dirent rather than a
      // separate `statSync(full)` state check before `readFileSync(full)` --
      // that check-then-use split is a filesystem race (CodeQL
      // js/file-system-race). Reading the Dirent removes the second stat and the
      // window with it.
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      const relativePath = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, relativePath);
      } else if (entry.isFile() && /^action\.ya?ml$/i.test(entry.name)) {
        files.push({ path: relativePath, content: readFileSync(full, "utf8") });
      }
    }
  };
  walk(ACTIONS_DIR, ".github/actions");
  return files;
}

// The single claude-code-action step in the claude-review job (the defect's
// home), for the job-specific T-1/T-2/T-4 assertions.
function reviewInvocationWith(content: string): Mapping | undefined {
  const parsed = asMapping(parseDocument(content).toJS({ maxAliasCount: 100 }));
  const job = asMapping(asMapping(parsed?.jobs)?.["claude-review"]);
  const step = (Array.isArray(job?.steps) ? job.steps : [])
    .map(asMapping)
    .find((candidate) => isClaudeActionUses(candidate?.uses));
  return asMapping(step?.with);
}

function reviewJobPermissions(content: string): unknown {
  const parsed = asMapping(parseDocument(content).toJS({ maxAliasCount: 100 }));
  return asMapping(asMapping(parsed?.jobs)?.["claude-review"])?.permissions;
}

// The completion-assertion (step B) run text -- where the tracking-comment
// author literal lives.
function stepBRun(content: string): string {
  const parsed = asMapping(parseDocument(content).toJS({ maxAliasCount: 100 }));
  const job = asMapping(asMapping(parsed?.jobs)?.["claude-review"]);
  const step = (Array.isArray(job?.steps) ? job.steps : [])
    .map(asMapping)
    .find(
      (candidate) => candidate?.name === "Assert the review actually completed",
    );
  return String(asMapping(step)?.run ?? "");
}

// Every claude-code-action invocation's allowed_bots within one workflow or
// composite action, for the triggering-actor admission guards.
function allowedBotsInSource(content: string): unknown[] {
  const parsed = asMapping(parseDocument(content).toJS({ maxAliasCount: 100 }));
  const values: unknown[] = [];
  for (const step of parsed ? stepsOf(parsed) : []) {
    if (isClaudeActionUses(step.uses)) {
      values.push(asMapping(step.with)?.allowed_bots);
    }
  }
  return values;
}

// A minimal workflow carrying a single claude-code-action invocation, for the
// synthetic negatives. `token` omitted drops the input entirely (T-5a).
function syntheticWorkflow(options: {
  readonly token?: string;
  // Override the `uses:` value (e.g. a mixed-case action ref for LOW-1);
  // defaults to the canonical pinned reference.
  readonly uses?: string;
  readonly jobPermissions?: string;
  // A SCALAR job `permissions:` value on one line (e.g. `write-all` for LOW-2).
  readonly jobPermissionsScalar?: string;
  readonly workflowPermissions?: string;
}): SourceFile {
  const lines = ["name: synthetic", "on: push"];
  if (options.workflowPermissions !== undefined) {
    lines.push(`permissions:\n${options.workflowPermissions}`);
  }
  lines.push("jobs:", "  review:", "    runs-on: ubuntu-latest");
  if (options.jobPermissions !== undefined) {
    lines.push(`    permissions:\n${options.jobPermissions}`);
  }
  if (options.jobPermissionsScalar !== undefined) {
    lines.push(`    permissions: ${options.jobPermissionsScalar}`);
  }
  lines.push(
    "    steps:",
    `      - uses: ${
      options.uses ??
      `${CLAUDE_ACTION_PREFIX}700e7f8316990de46bed556429765647af760efc`
    }`,
    "        with:",
    "          claude_code_oauth_token: ${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
  );
  if (options.token !== undefined) {
    lines.push(`          github_token: ${options.token}`);
  }
  return { path: ".github/workflows/synthetic.yml", content: lines.join("\n") };
}

describe("claude-code-action token model (issue #157)", () => {
  it("T-1: the claude-review invocation passes the built-in github_token exactly", () => {
    expect(reviewInvocationWith(REVIEW_WORKFLOW_CONTENT)?.github_token).toBe(
      BUILTIN_TOKEN,
    );
  });

  it("T-2: the claude-review job permissions are exactly contents:read, pull-requests:write, issues:read, actions:read", () => {
    expect(reviewJobPermissions(REVIEW_WORKFLOW_CONTENT)).toEqual(
      EXPECTED_REVIEW_PERMISSIONS,
    );
  });

  it("T-2a: adding a write permission to the claude-review job is rejected", () => {
    const mutated = REVIEW_WORKFLOW_CONTENT.replace(
      "      contents: read\n",
      "      contents: write\n",
    );
    expect(mutated).not.toBe(REVIEW_WORKFLOW_CONTENT);
    expect(reviewJobPermissions(mutated)).not.toEqual(
      EXPECTED_REVIEW_PERMISSIONS,
    );
  });

  it("T-3: the completion-assertion binds the tracking comment to github-actions[bot], not claude[bot]", () => {
    const run = stepBRun(REVIEW_WORKFLOW_CONTENT);
    expect(run).toContain('.user.login == "github-actions[bot]"');
    expect(run).not.toContain('.user.login == "claude[bot]"');
  });

  it("T-4: both claude-code-review invocations keep the triggering-actor allowlist unchanged", () => {
    const values = allowedBotsInSource(REVIEW_WORKFLOW_CONTENT);
    expect(values).toHaveLength(2);
    for (const value of values) {
      expect(value).toBe(EXPECTED_ALLOWED_BOTS);
    }
  });

  it("T-4a: credential-bearing triage and implement invocations reject every bot", () => {
    for (const workflowName of [
      "triage-issues.yml",
      "implement-ready-issues.yml",
    ]) {
      const content = readFileSync(join(WORKFLOWS_DIR, workflowName), "utf8");
      expect(allowedBotsInSource(content)).toEqual([""]);
    }
  });

  it("T-4b: no allowed_bots value admits GitHub Actions, a wildcard, or an expression", () => {
    for (const source of collectSourceFiles()) {
      for (const value of allowedBotsInSource(source.content)) {
        expect(typeof value).toBe("string");
        expect(value).not.toMatch(/github-actions|\*|\$\{\{/);
      }
    }
  });

  it("T-5: every live claude-code-action invocation passes the built-in token, and there are exactly eight", () => {
    const analysis = analyzeTokenModel(collectSourceFiles());
    expect(analysis.failures).toEqual([]);
    expect(analysis.invocationCount).toBe(EXPECTED_INVOCATION_COUNT);
  });

  it("T-5a: an invocation missing github_token fails closed", () => {
    const analysis = analyzeTokenModel([syntheticWorkflow({})]);
    expect(analysis.failures).toContainEqual(
      expect.stringContaining("must pass github_token"),
    );
  });

  it("T-5b: an invocation passing a non-built-in (PAT-lookalike) token fails closed", () => {
    const analysis = analyzeTokenModel([
      syntheticWorkflow({ token: "${{ secrets.MY_PAT }}" }),
    ]);
    expect(analysis.failures).toContainEqual(
      expect.stringContaining("must be the built-in secrets.GITHUB_TOKEN"),
    );
  });

  it("T-5c: a case-variant uses: reference is still enumerated and must pass github_token (LOW-1)", () => {
    // GitHub resolves action refs case-INSENSITIVELY, so this mixed-case
    // invocation runs. A case-sensitive enumerator would count 0 and never
    // check its (absent) github_token, letting a 5th invocation slip past both
    // the tripwire and the token check. The normalized enumerator counts it AND
    // flags the missing token.
    const analysis = analyzeTokenModel([
      syntheticWorkflow({
        uses: `ANTHROPICS/Claude-Code-Action@${"a".repeat(40)}`,
      }),
    ]);
    expect(analysis.invocationCount).toBe(1);
    expect(analysis.failures).toContainEqual(
      expect.stringContaining("must pass github_token"),
    );
  });

  it("T-6: no workflow or composite action requests id-token", () => {
    const analysis = analyzeTokenModel(collectSourceFiles());
    expect(
      analysis.failures.filter((failure) => failure.includes("id-token")),
    ).toEqual([]);
  });

  it("T-6a: a job-level id-token permission fails closed", () => {
    const analysis = analyzeTokenModel([
      syntheticWorkflow({
        token: BUILTIN_TOKEN,
        jobPermissions: "      id-token: write",
      }),
    ]);
    expect(analysis.failures).toContainEqual(
      expect.stringContaining("must not request id-token"),
    );
  });

  it("T-6b: a workflow-level id-token permission fails closed", () => {
    const analysis = analyzeTokenModel([
      syntheticWorkflow({
        token: BUILTIN_TOKEN,
        workflowPermissions: "  id-token: write",
      }),
    ]);
    expect(analysis.failures).toContainEqual(
      expect.stringContaining("must not request id-token"),
    );
  });

  it("T-6c: a scalar write-all permission governing an invocation fails closed (LOW-2)", () => {
    // `permissions: write-all` is a scalar, so the key-by-key id-token scan
    // skips it -- yet write-all grants id-token: write implicitly. A block that
    // governs a claude-code-action invocation must be an explicit mapping, so
    // this fails closed even though a valid github_token is present.
    const analysis = analyzeTokenModel([
      syntheticWorkflow({
        token: BUILTIN_TOKEN,
        jobPermissionsScalar: "write-all",
      }),
    ]);
    expect(analysis.failures).toContainEqual(
      expect.stringContaining("must be an explicit mapping"),
    );
  });

  it("T-0: a malformed workflow fails closed rather than parsing as compliant", () => {
    const analysis = analyzeTokenModel([
      {
        path: ".github/workflows/broken.yml",
        content: "on: push\njobs:\n  review:\n    runs-on: [unterminated",
      },
    ]);
    expect(analysis.failures).toContainEqual(
      expect.stringContaining("not valid YAML"),
    );
  });
});
