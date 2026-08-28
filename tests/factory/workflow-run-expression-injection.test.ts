import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { isWorkflowPinAuditManifestPath } from "../../scripts/factory/workflow-pin-audit-logic.mts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const GITHUB_DIRECTORY = join(REPOSITORY_ROOT, ".github");
const GITHUB_EXPRESSION = /\$\{\{[\s\S]*?\}\}/g;
const ALLOWED_SINK_EXPRESSIONS = [
  /^steps\.[A-Za-z_][A-Za-z0-9_-]*\.outcome$/i,
  /^github\.repository$/i,
  // 28 Aug 2026, D-F2-C2 C2a: the issue_comment payload issue number is an
  // integer trusted by the approve-dispatch contract and is safe in every
  // audited execution sink.
  /^github\.event\.issue\.number$/i,
];
const SINK_KEYS = new Set(["run", "shell", "script"]);

type Mapping = Record<string, unknown>;

interface WorkflowFile {
  readonly path: string;
  readonly content: string;
}

function asMapping(value: unknown): Mapping | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Mapping)
    : undefined;
}

function readWorkflowFiles(directory = GITHUB_DIRECTORY): WorkflowFile[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return readWorkflowFiles(path);
      }
      const repositoryPath = relative(REPOSITORY_ROOT, path).replaceAll(
        "\\",
        "/",
      );
      if (!isWorkflowPinAuditManifestPath(repositoryPath)) {
        return [];
      }
      return {
        path: repositoryPath,
        content: readFileSync(path, "utf8"),
      };
    })
    .sort((left, right) => left.path.localeCompare(right.path));
}

function normalizedExpressionInnerText(expression: string): string {
  return expression.slice(3, -2).trim().replace(/\s+/g, " ");
}

function findUnrecognisedSinkExpressions(
  value: unknown,
  location: string,
): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      findUnrecognisedSinkExpressions(item, `${location}[${index}]`),
    );
  }

  const mapping = asMapping(value);
  if (mapping === undefined) {
    return [];
  }

  const failures: string[] = [];
  for (const [key, child] of Object.entries(mapping)) {
    const childLocation = `${location}.${key}`;
    if (SINK_KEYS.has(key.toLowerCase()) && typeof child === "string") {
      for (const match of child.matchAll(GITHUB_EXPRESSION)) {
        const expression = match[0];
        const normalized = normalizedExpressionInnerText(expression);
        if (
          !ALLOWED_SINK_EXPRESSIONS.some((pattern) => pattern.test(normalized))
        ) {
          failures.push(`${childLocation}: ${expression}`);
        }
      }
    }
    failures.push(...findUnrecognisedSinkExpressions(child, childLocation));
  }
  return failures;
}

/**
 * Audits one workflow or composite action without trusting expression syntax.
 *
 * The previous deny-list was defeated by equivalent bracket access, function
 * calls, case changes, and other forms. A closed allow-list fails safely for
 * every expression form that has not received explicit review.
 *
 * The audit covers three sink keys whose string values are spliced into an
 * execution medium: `run` (shell source), `shell` (a command template such as
 * `bash -c "{0}"`, matched at step level and via job- or workflow-level
 * `defaults.run.shell`), and `script` (JS source for `actions/github-script`).
 * One `SINK_KEYS` membership arm matches all three; the unconditional recursion
 * reaches every location, so no parent tracking is needed.
 *
 * `script` is keyed UNSCOPED (any parent, not only under `with`): scoping it to
 * `with` would fail open on a `script` sink reached through an unenumerated
 * shape (composite indirection, a future `github-script`-alike), so the
 * fail-closed direction is to audit every `script`-named string. A plain value
 * never fails; only an UNREVIEWED `${{ }}` does.
 *
 * Keys are matched case-insensitively (`.toLowerCase()`), mirroring the sibling
 * pin audit (`workflow-pin-audit-logic.mts:716-717`). A spelling such as `Run:`
 * or `Shell:` can only be ADDITIONALLY audited, never additionally admitted.
 *
 * Because one allow-list serves every sink, any future allow-list entry must be
 * safe in EVERY audited sink — a JS source position and a command template, not
 * only a quoted `run:` body — before it may be added.
 */
export function validateWorkflowSinkExpressions(
  workflow: WorkflowFile,
): string[] {
  const document = parseDocument(workflow.content);
  if (document.errors.length > 0) {
    return [`${workflow.path}: workflow must be valid YAML`];
  }
  try {
    return findUnrecognisedSinkExpressions(
      document.toJS({ maxAliasCount: 100 }),
      workflow.path,
    );
  } catch {
    return [
      `${workflow.path}: workflow aliases must stay within the permitted bound`,
    ];
  }
}

export function validateWorkflowSinkExpressionCorpus(
  workflows: readonly WorkflowFile[],
): string[] {
  if (workflows.length === 0) {
    return ["workflow sink expression corpus must not be empty"];
  }
  return workflows.flatMap(validateWorkflowSinkExpressions);
}

describe("workflow run/shell/script expression injection guard (issues #151, #154)", () => {
  it("allows only reviewed expressions in every workflow and composite action", () => {
    expect(validateWorkflowSinkExpressionCorpus(readWorkflowFiles())).toEqual(
      [],
    );
  });

  it.each([
    "${{ vars['SNOWFLAKE_DEV_DATABASE'] }}",
    "${{ github['event'].issue.title }}",
    "${{ github.event['issue'].title }}",
    "${{ inputs['issue_number'] }}",
    "${{ github['head_ref'] }}",
    "${{ format('{0}', vars.SNOWFLAKE_DEV_DATABASE) }}",
    "${{ toJSON(github.event.issue) }}",
    "${{ join(github.event.issue.labels.*.name, ',') }}",
    "${{ fromJSON(vars.CFG).db }}",
    "${{ steps.x.outcome || github.event.issue.title }}",
    "${{ github.event_name == 'issues' && github.event.issue.title || '' }}",
    "${{ env.ISSUE_TITLE }}",
    "${{ needs.agent.outputs.title }}",
    "${{ steps.agent.outputs.result }}",
    "${{ matrix.target }}",
    "${{ github.ref_name }}",
    "${{ github.base_ref }}",
    "${{ github.triggering_actor }}",
    "${{ VARS.SNOWFLAKE_DEV_DATABASE }}",
    "${{ GITHUB.EVENT.ISSUE.TITLE }}",
    "${{ vars .X }}",
    "${{ github . repository }}",
    "${{ vars.SNOWFLAKE_DEV_DATABASE }}",
    "${{ github.event.issue.title }}",
  ])("rejects unrecognised run expression %s", (expression) => {
    const vulnerableWorkflow = {
      path: ".github/workflows/vulnerable.yml",
      content: `jobs:\n  test:\n    steps:\n      - run: |\n          echo "${expression}"\n`,
    };
    expect(validateWorkflowSinkExpressions(vulnerableWorkflow)).toContainEqual(
      expect.stringContaining(
        `${vulnerableWorkflow.path}.jobs.test.steps[0].run: ${expression}`,
      ),
    );
  });

  it.each([
    "${{ steps.deploy.outcome }}",
    "${{ steps.grants-post.outcome }}",
    "${{ github.repository }}",
    "${{   github.repository   }}",
    "${{ github.event.issue.number }}",
  ])("allows reviewed run expression %s", (expression) => {
    const allowedWorkflow = {
      path: ".github/workflows/allowed.yml",
      content: `jobs:\n  test:\n    steps:\n      - run: |\n          echo "${expression}"\n`,
    };
    expect(validateWorkflowSinkExpressions(allowedWorkflow)).toEqual([]);
  });

  it("catches a composite action run expression", () => {
    const compositeAction = {
      path: ".github/actions/foo/action.yml",
      content:
        "runs:\n  using: composite\n  steps:\n    - run: 'echo \"${{ vars.ATTACKER }}\"'\n      shell: bash\n",
    };
    expect(validateWorkflowSinkExpressions(compositeAction)).toEqual([
      `${compositeAction.path}.runs.steps[0].run: \${{ vars.ATTACKER }}`,
    ]);
  });

  it("catches a step-level shell expression (T1)", () => {
    const vulnerableWorkflow = {
      path: ".github/workflows/vulnerable.yml",
      content:
        "jobs:\n  test:\n    steps:\n      - shell: 'bash -c \"${{ inputs.x }}\" {0}'\n",
    };
    expect(validateWorkflowSinkExpressions(vulnerableWorkflow)).toContainEqual(
      expect.stringContaining(
        ".github/workflows/vulnerable.yml.jobs.test.steps[0].shell: ${{ inputs.x }}",
      ),
    );
  });

  it("catches a job-level defaults.run.shell expression (T2)", () => {
    const vulnerableWorkflow = {
      path: ".github/workflows/vulnerable.yml",
      content:
        "jobs:\n  test:\n    defaults:\n      run:\n        shell: '${{ vars.SH }}'\n",
    };
    expect(validateWorkflowSinkExpressions(vulnerableWorkflow)).toContainEqual(
      expect.stringContaining(
        ".github/workflows/vulnerable.yml.jobs.test.defaults.run.shell: ${{ vars.SH }}",
      ),
    );
  });

  it("catches a workflow-level defaults.run.shell expression (T3)", () => {
    const vulnerableWorkflow = {
      path: ".github/workflows/vulnerable.yml",
      content: "defaults:\n  run:\n    shell: '${{ vars.SH }}'\n",
    };
    expect(validateWorkflowSinkExpressions(vulnerableWorkflow)).toContainEqual(
      expect.stringContaining(
        ".github/workflows/vulnerable.yml.defaults.run.shell: ${{ vars.SH }}",
      ),
    );
  });

  it("catches a composite-action step shell expression (T4)", () => {
    const compositeAction = {
      path: ".github/actions/foo/action.yml",
      content:
        "runs:\n  using: composite\n  steps:\n    - shell: '${{ inputs.sh }}'\n",
    };
    expect(validateWorkflowSinkExpressions(compositeAction)).toContainEqual(
      expect.stringContaining(
        ".github/actions/foo/action.yml.runs.steps[0].shell: ${{ inputs.sh }}",
      ),
    );
  });

  it("catches a with.script expression in a workflow step (T5)", () => {
    const vulnerableWorkflow = {
      path: ".github/workflows/vulnerable.yml",
      content:
        "jobs:\n  test:\n    steps:\n      - uses: actions/github-script@v7\n        with:\n          script: '${{ github.event.issue.title }}'\n",
    };
    expect(validateWorkflowSinkExpressions(vulnerableWorkflow)).toContainEqual(
      expect.stringContaining(
        ".github/workflows/vulnerable.yml.jobs.test.steps[0].with.script: ${{ github.event.issue.title }}",
      ),
    );
  });

  it("catches a with.script expression inside a composite action (T6)", () => {
    const compositeAction = {
      path: ".github/actions/foo/action.yml",
      content:
        "runs:\n  using: composite\n  steps:\n    - uses: actions/github-script@v7\n      with:\n        script: '${{ inputs.payload }}'\n",
    };
    expect(validateWorkflowSinkExpressions(compositeAction)).toContainEqual(
      expect.stringContaining(
        ".github/actions/foo/action.yml.runs.steps[0].with.script: ${{ inputs.payload }}",
      ),
    );
  });

  it("catches a bare script key outside with, pinning the unscoped decision (T7)", () => {
    const vulnerableWorkflow = {
      path: ".github/workflows/vulnerable.yml",
      content: "jobs:\n  test:\n    steps:\n      - script: '${{ vars.X }}'\n",
    };
    expect(validateWorkflowSinkExpressions(vulnerableWorkflow)).toContainEqual(
      expect.stringContaining(
        ".github/workflows/vulnerable.yml.jobs.test.steps[0].script: ${{ vars.X }}",
      ),
    );
  });

  it("allows a shell value with no expression (T8)", () => {
    const allowedWorkflow = {
      path: ".github/workflows/allowed.yml",
      content: "jobs:\n  test:\n    steps:\n      - shell: bash\n",
    };
    expect(validateWorkflowSinkExpressions(allowedWorkflow)).toEqual([]);
  });

  it("allows a reviewed expression in a shell value (T9)", () => {
    const allowedWorkflow = {
      path: ".github/workflows/allowed.yml",
      content:
        "jobs:\n  test:\n    steps:\n      - shell: '${{ github.repository }}'\n",
    };
    expect(validateWorkflowSinkExpressions(allowedWorkflow)).toEqual([]);
  });

  it("allows a reviewed expression in a with.script value (T10)", () => {
    const allowedWorkflow = {
      path: ".github/workflows/allowed.yml",
      content:
        "jobs:\n  test:\n    steps:\n      - uses: actions/github-script@v7\n        with:\n          script: '${{ steps.x.outcome }}'\n",
    };
    expect(validateWorkflowSinkExpressions(allowedWorkflow)).toEqual([]);
  });

  it("catches a capitalised Shell key, proving case-insensitive matching (T11)", () => {
    const vulnerableWorkflow = {
      path: ".github/workflows/vulnerable.yml",
      content:
        "jobs:\n  test:\n    steps:\n      - Shell: 'bash -c \"${{ inputs.x }}\" {0}'\n",
    };
    expect(validateWorkflowSinkExpressions(vulnerableWorkflow)).toContainEqual(
      expect.stringContaining(
        ".github/workflows/vulnerable.yml.jobs.test.steps[0].Shell: ${{ inputs.x }}",
      ),
    );
  });

  it("catches a capitalised Run key, hardening the existing arm (T12)", () => {
    const vulnerableWorkflow = {
      path: ".github/workflows/vulnerable.yml",
      content: "jobs:\n  test:\n    steps:\n      - Run: 'echo \"${{ vars.X }}\"'\n",
    };
    expect(validateWorkflowSinkExpressions(vulnerableWorkflow)).toContainEqual(
      expect.stringContaining(
        ".github/workflows/vulnerable.yml.jobs.test.steps[0].Run: ${{ vars.X }}",
      ),
    );
  });

  it("fails closed when alias expansion exceeds the permitted bound (T13)", () => {
    const aliasedWorkflow = {
      path: ".github/workflows/aliased.yml",
      content:
        "a: &a [1,1,1,1,1,1,1,1,1,1]\n" +
        "b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\n" +
        "c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]\n" +
        "d: [*c,*c]\n",
    };
    expect(validateWorkflowSinkExpressions(aliasedWorkflow)).toEqual([
      ".github/workflows/aliased.yml: workflow aliases must stay within the permitted bound",
    ]);
  });

  it("fails when the audited corpus is empty", () => {
    expect(validateWorkflowSinkExpressionCorpus([])).toEqual([
      "workflow sink expression corpus must not be empty",
    ]);
  });

  it("fails closed for invalid YAML", () => {
    expect(
      validateWorkflowSinkExpressions({
        path: ".github/workflows/invalid.yml",
        content: "jobs: [",
      }),
    ).toEqual([
      ".github/workflows/invalid.yml: workflow must be valid YAML",
    ]);
  });
});
