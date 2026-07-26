import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_CANONICAL_EVIDENCE_BYTES,
  MAX_RUN_CHARACTERS,
  MAX_WORKFLOW_ALIASES,
  MAX_WORKFLOW_BINDINGS,
  MAX_WORKFLOW_IDENTIFIER_BYTES,
  MAX_WORKFLOW_JOBS,
  MAX_WORKFLOW_PATH_BYTES,
  MAX_WORKFLOW_SOURCE_BYTES,
  MAX_WORKFLOW_STEPS,
  MAX_WORKFLOW_VIOLATION_BYTES,
  MAX_WORKFLOW_VIOLATIONS,
  canonicalizeWorkflowExecutionSurface,
  type WorkflowExecutionSurfaceEvidence,
} from "../../scripts/factory/workflow-execution-surface-logic.mts";

const WORKFLOW_DIRECTORY = resolve(process.cwd(), ".github/workflows");
const DEFAULT_WORKFLOW_PATH = ".github/workflows/test.yml";

function workflow(jobBody: string, prefix = ""): string {
  return [
    "name: test",
    "on: workflow_dispatch",
    prefix,
    "jobs:",
    "  verify:",
    ...jobBody.split("\n").map((line) => `    ${line}`),
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function evidence(
  source: string,
  workflowPath = DEFAULT_WORKFLOW_PATH,
): WorkflowExecutionSurfaceEvidence {
  const result = canonicalizeWorkflowExecutionSurface(
    workflowPath,
    source,
  );
  expect(result.violations).toEqual([]);
  expect(result.evidence).toBeDefined();
  return result.evidence!;
}

function violations(source: string, workflowPath = DEFAULT_WORKFLOW_PATH) {
  const result = canonicalizeWorkflowExecutionSurface(
    workflowPath,
    source,
  );
  expect(result.evidence).toBeUndefined();
  return result.violations;
}

function yamlBindings(count: number, indentation: string): string {
  return Array.from(
    { length: count },
    (_, index) => `${indentation}VALUE_${index}: value`,
  ).join("\n");
}

describe("ordinary-run workflow evidence (issue #120 slice 120d-1a)", () => {
  it("canonicalizes one static implicit-shell run without authorizing it", () => {
    expect(
      evidence(
        workflow(
          [
            "runs-on: ubuntu-latest",
            "steps:",
            "  - id: verify",
            "    name: Verify",
            "    run: node script.mjs",
          ].join("\n"),
        ),
      ),
    ).toEqual({
      workflowPath: DEFAULT_WORKFLOW_PATH,
      trigger: "workflow_dispatch",
      workflowName: "test",
      workflowEnvironment: [],
      jobs: [
        {
          id: "verify",
          line: 5,
          runnerLabels: ["ubuntu-latest"],
          environment: [],
          steps: [
            {
              index: 0,
              line: 7,
              id: "verify",
              name: "Verify",
              environment: [],
              run: "node script.mjs",
              shell: { source: "implicit" },
              workingDirectory: { source: "implicit" },
            },
          ],
        },
      ],
    });
  });

  it("distinguishes workflow identity exposed through GitHub variables", () => {
    const named = evidence(
      workflow("runs-on: ubuntu-latest\nsteps:\n  - run: printenv GITHUB_WORKFLOW_REF"),
      ".github/workflows/first.yml",
    );
    const namedAtAnotherPath = evidence(
      workflow(
        "runs-on: ubuntu-latest\nsteps:\n  - run: printenv GITHUB_WORKFLOW_REF",
      ),
      ".github/workflows/second.yml",
    );
    const renamed = evidence(
      workflow("runs-on: ubuntu-latest\nsteps:\n  - run: printenv GITHUB_WORKFLOW")
        .replace("name: test", "name: renamed"),
      ".github/workflows/first.yml",
    );
    const unnamedSource = workflow(
      "runs-on: ubuntu-latest\nsteps:\n  - run: printenv GITHUB_WORKFLOW",
    ).replace("name: test\n", "");
    const unnamed = evidence(
      unnamedSource,
      ".github/workflows/first.yml",
    );
    const unnamedAtAnotherPath = evidence(
      unnamedSource,
      ".github/workflows/second.yml",
    );

    expect(named.workflowPath).toBe(".github/workflows/first.yml");
    expect(named.workflowName).toBe("test");
    expect(renamed.workflowName).toBe("renamed");
    expect(unnamed.workflowName).toBeNull();
    expect(JSON.stringify(named)).not.toBe(
      JSON.stringify(namedAtAnotherPath),
    );
    expect(JSON.stringify(named)).not.toBe(JSON.stringify(renamed));
    expect(JSON.stringify(named)).not.toBe(JSON.stringify(unnamed));
    expect(JSON.stringify(unnamed)).not.toBe(
      JSON.stringify(unnamedAtAnotherPath),
    );
  });

  it.each([
    ["empty", ""],
    ["absolute", "/.github/workflows/test.yml"],
    ["outside workflow root", ".github/actions/test.yml"],
    ["nested", ".github/workflows/nested/test.yml"],
    ["backslash", ".github/workflows/nested\\test.yml"],
    ["missing yml stem", ".github/workflows/.yml"],
    ["missing yaml stem", ".github/workflows/.yaml"],
    ["wrong extension", ".github/workflows/test.json"],
  ])("rejects malformed workflow path: %s", (_name, workflowPath) => {
    expect(violations(workflow("runs-on: ubuntu\nsteps: []"), workflowPath))
      .toContainEqual(
        expect.objectContaining({
          subject: "<workflow-path>",
          kind: "unsupported-execution-shape",
        }),
      );
  });

  it.each([".yml", ".yaml"])(
    "accepts and rejects the exact workflow path boundary for %s",
    (extension) => {
      const fixedBytes = Buffer.byteLength(
        `.github/workflows/${extension}`,
        "utf8",
      );
      const atLimit = `.github/workflows/${"x".repeat(
        MAX_WORKFLOW_PATH_BYTES - fixedBytes,
      )}${extension}`;
      const overLimit = atLimit.replace(extension, `x${extension}`);
      const source = workflow("runs-on: ubuntu\nsteps: []");

      expect(Buffer.byteLength(atLimit, "utf8")).toBe(
        MAX_WORKFLOW_PATH_BYTES,
      );
      expect(evidence(source, atLimit).workflowPath).toBe(atLimit);
      expect(Buffer.byteLength(overLimit, "utf8")).toBe(
        MAX_WORKFLOW_PATH_BYTES + 1,
      );
      expect(violations(source, overLimit)).toContainEqual(
        expect.objectContaining({
          subject: "<workflow-path>",
          kind: "unsupported-execution-shape",
        }),
      );
    },
  );

  it("enforces the canonical evidence byte ceiling exactly", () => {
    const source = workflow(
      [
        "runs-on: ubuntu-latest",
        "steps:",
        "  - env:",
        '      PAYLOAD: ""',
        "    run: echo static",
      ].join("\n"),
    );
    const baseline = evidence(source);
    const baselineBytes = Buffer.byteLength(
      JSON.stringify(baseline),
      "utf8",
    );
    const padding = "x".repeat(
      MAX_CANONICAL_EVIDENCE_BYTES - baselineBytes,
    );
    const atLimit = evidence(
      source.replace('PAYLOAD: ""', `PAYLOAD: ${padding}`),
    );

    expect(
      Buffer.byteLength(JSON.stringify(atLimit), "utf8"),
    ).toBe(MAX_CANONICAL_EVIDENCE_BYTES);
    expect(
      violations(
        source.replace(
          'PAYLOAD: ""',
          `PAYLOAD: ${padding}x`,
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({
        kind: "resource-limit",
        detail: expect.stringContaining("canonical evidence exceeds"),
      }),
    );
  });

  it("rejects inherited environment evidence amplification", () => {
    const steps = Array.from(
      { length: MAX_WORKFLOW_STEPS },
      () => "      - run: echo static",
    ).join("\n");
    const source = [
      "on: push",
      "env:",
      `  PAYLOAD: ${"x".repeat(10_000)}`,
      "jobs:",
      "  verify:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      steps,
    ].join("\n");

    expect(violations(source)).toContainEqual(
      expect.objectContaining({
        kind: "resource-limit",
        detail: expect.stringContaining("canonical evidence exceeds"),
      }),
    );
  });

  it("accepts and rejects exact job and step identifier boundaries", () => {
    const atLimit = "x".repeat(MAX_WORKFLOW_IDENTIFIER_BYTES);
    const overLimit = `${atLimit}x`;
    const jobSource = (id: string): string => `
on: push
jobs:
  ? ${id}
  : runs-on: ubuntu
    steps: []
`;

    expect(evidence(jobSource(atLimit)).jobs[0]?.id).toBe(atLimit);
    expect(violations(jobSource(overLimit))).toEqual([
      expect.objectContaining({
        subject: "jobs",
        detail: expect.stringContaining("job id must be canonical"),
      }),
    ]);
    expect(
      evidence(
        workflow(
          `runs-on: ubuntu\nsteps:\n  - id: ${atLimit}\n    run: echo`,
        ),
      ).jobs[0]?.steps[0]?.id,
    ).toBe(atLimit);
    expect(
      violations(
        workflow(
          `runs-on: ubuntu\nsteps:\n  - id: ${overLimit}\n    run: echo`,
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({
        detail: expect.stringContaining("step id"),
      }),
    );
  });

  it("does not repeat an oversized explicit job id in step violations", () => {
    const id = "x".repeat(100_000);
    const malformedSteps = Array.from(
      { length: MAX_WORKFLOW_STEPS },
      () => "      - malformed",
    ).join("\n");
    const result = violations(`
on: push
jobs:
  ? ${id}
  : runs-on: ubuntu
    steps:
${malformedSteps}
`);

    expect(result).toEqual([
      expect.objectContaining({
        kind: "unsupported-execution-shape",
        subject: "jobs",
      }),
    ]);
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThan(
      1_024,
    );
  });

  it("caps aggregate violation count before retaining repeated output", () => {
    const source = (count: number): string =>
      workflow(
        `runs-on: ubuntu\nsteps:\n${Array.from(
          { length: count },
          () => "  - malformed",
        ).join("\n")}`,
      );

    expect(violations(source(MAX_WORKFLOW_VIOLATIONS))).toHaveLength(
      MAX_WORKFLOW_VIOLATIONS,
    );
    for (const count of [
      MAX_WORKFLOW_VIOLATIONS + 1,
      MAX_WORKFLOW_VIOLATIONS + 2,
    ]) {
      expect(violations(source(count))).toEqual([
        expect.objectContaining({
          kind: "resource-limit",
          detail: expect.stringContaining(
            "violation diagnostics exceed",
          ),
        }),
      ]);
    }
  });

  it("caps aggregate YAML parser diagnostics", () => {
    const duplicateJobs = Array.from(
      { length: MAX_WORKFLOW_VIOLATIONS + 44 },
      () => "  duplicate: {}",
    ).join("\n");

    expect(violations(`on: push\njobs:\n${duplicateJobs}`)).toEqual([
      expect.objectContaining({
        kind: "resource-limit",
        detail: expect.stringContaining(
          "violation diagnostics exceed",
        ),
      }),
    ]);
  });

  it("enforces the aggregate violation JSON byte ceiling exactly", () => {
    const source = (name: string): string => `
on: push
env:
  ? "${name}"
  : value
jobs:
  verify:
    runs-on: ubuntu
    steps: []
`;
    const baseName = "${{";
    const baseline = violations(source(baseName));
    const baselineBytes = Buffer.byteLength(
      JSON.stringify(baseline),
      "utf8",
    );
    const atLimitName = `${baseName}${"x".repeat(
      MAX_WORKFLOW_VIOLATION_BYTES - baselineBytes,
    )}`;
    const atLimit = violations(source(atLimitName));

    expect(Buffer.byteLength(JSON.stringify(atLimit), "utf8")).toBe(
      MAX_WORKFLOW_VIOLATION_BYTES,
    );
    expect(
      violations(
        source(atLimitName).replace(
          "jobs:",
          "defaults: malformed\njobs:",
        ),
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "resource-limit",
        detail: expect.stringContaining(
          "violation diagnostics exceed",
        ),
      }),
    ]);
    expect(violations(source(`${atLimitName}x`))).toEqual([
      expect.objectContaining({
        kind: "resource-limit",
        detail: expect.stringContaining(
          "violation diagnostics exceed",
        ),
      }),
    ]);
  });

  it("resolves defaults and environment precedence exactly", () => {
    const result = evidence(`
name: inherited
on: push
env:
  A: workflow
  B: workflow
defaults:
  run:
    shell: bash
    working-directory: scripts
jobs:
  verify:
    runs-on: [self-hosted, linux]
    env:
      B: job
      C: job
    defaults:
      run:
        working-directory: scripts/factory
    steps:
      - run: printf ok
        shell: bash
        env:
          C: step
          D: static
`);

    expect(result.trigger).toBe("push");
    expect(result.workflowEnvironment).toEqual([
      { name: "A", value: "workflow", scope: "workflow" },
      { name: "B", value: "workflow", scope: "workflow" },
    ]);
    expect(result.jobs[0]).toMatchObject({
      runnerLabels: ["self-hosted", "linux"],
      environment: [
        { name: "A", value: "workflow", scope: "workflow" },
        { name: "B", value: "job", scope: "job" },
        { name: "C", value: "job", scope: "job" },
      ],
      steps: [
        {
          environment: [
            { name: "A", value: "workflow", scope: "workflow" },
            { name: "B", value: "job", scope: "job" },
            { name: "C", value: "step", scope: "step" },
            { name: "D", value: "static", scope: "step" },
          ],
          shell: { source: "step", value: "bash" },
          workingDirectory: {
            source: "job-default",
            value: "scripts/factory",
          },
        },
      ],
    });
  });

  it("retains workflow-default provenance when no override exists", () => {
    const result = evidence(`
on: workflow_dispatch
defaults:
  run:
    shell: bash
    working-directory: scripts
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`);
    expect(result.jobs[0]?.steps[0]).toMatchObject({
      shell: { source: "workflow-default", value: "bash" },
      workingDirectory: {
        source: "workflow-default",
        value: "scripts",
      },
    });
  });

  it("preserves exact multiline run text and Unicode code points", () => {
    const result = evidence(`
on: workflow_dispatch
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - shell: bash
        run: |
          set -euo pipefail
          printf 'coffee ☕\\n'
`);
    expect(result.jobs[0]?.steps[0]?.run).toBe(
      "set -euo pipefail\nprintf 'coffee ☕\\n'\n",
    );
  });

  it("canonicalizes static step lifecycle controls", () => {
    const result = evidence(`
on: workflow_dispatch
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - id: allowed_id
        name: Static step
        continue-on-error: false
        timeout-minutes: 5
        run: echo ok
`);
    expect(result.jobs[0]?.steps[0]).toMatchObject({
      id: "allowed_id",
      name: "Static step",
      continueOnError: false,
      timeoutMinutes: 5,
    });
  });

  it("retains safe integer and boolean environment values injectively", () => {
    const result = evidence(`
on: workflow_dispatch
env:
  ENABLED: true
  LIMIT: ${Number.MAX_SAFE_INTEGER}
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - run: echo ok
`);
    expect(result.workflowEnvironment).toEqual([
      { name: "ENABLED", value: true, scope: "workflow" },
      {
        name: "LIMIT",
        value: Number.MAX_SAFE_INTEGER,
        scope: "workflow",
      },
    ]);
  });

  it("resolves aliases and merge keys before applying precedence", () => {
    const result = evidence(`
on: workflow_dispatch
env: &shared_env
  A: workflow
defaults: &shared_defaults
  run:
    shell: bash
jobs:
  <<: &job_map
    verify:
      runs-on: ubuntu-latest
      env:
        <<: *shared_env
        A: job
      defaults:
        <<: *shared_defaults
        run:
          shell: bash
          working-directory: scripts
      steps: &steps
        - run: echo ok
  second:
    runs-on: ubuntu-latest
    steps: *steps
`);
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs.map((job) => job.id)).toEqual([
      "second",
      "verify",
    ]);
    expect(result.jobs[1]).toMatchObject({
      environment: [{ name: "A", value: "job", scope: "job" }],
      steps: [
        {
          shell: { source: "job-default", value: "bash" },
          workingDirectory: {
            source: "job-default",
            value: "scripts",
          },
        },
      ],
    });
  });
});

describe("deferred execution/context surfaces fail closed", () => {
  it.each([
    ["action step", `uses: actions/checkout@${"a".repeat(40)}`],
    ["action inputs", "run: echo\nwith: {script: hidden}"],
    ["step condition", "run: echo\nif: always()"],
  ])("rejects delegated step form: %s", (_name, step) => {
    const source = workflow(
      [
        "runs-on: ubuntu-latest",
        "steps:",
        "  - " + step.split("\n").join("\n    "),
      ].join("\n"),
    );
    expect(violations(source)).toContainEqual(
      expect.objectContaining({
        kind: "unsupported-execution-shape",
      }),
    );
  });

  it.each([
    [
      "reusable workflow",
      `uses: owner/repo/.github/workflows/a.yml@${"a".repeat(40)}`,
    ],
    ["strategy/matrix", "strategy: {matrix: {value: [safe]}}"],
    ["job condition", "if: always()"],
    ["outputs", "outputs: {value: hidden}"],
    ["needs", "needs: earlier"],
    ["environment", "environment: production"],
    ["continue-on-error", "continue-on-error: false"],
    ["timeout", "timeout-minutes: 5"],
    ["permissions", "permissions: {contents: read}"],
    ["container", "container: node:24"],
    ["services", "services: {redis: {image: redis}}"],
    ["concurrency", "concurrency: singleton"],
  ])("rejects delegated or unmodeled job form: %s", (_name, field) => {
    const source = workflow(
      [
        "runs-on: ubuntu-latest",
        field,
        "steps:",
        "  - run: echo ok",
      ].join("\n"),
    );
    expect(violations(source)).toContainEqual(
      expect.objectContaining({
        subject: "jobs.verify",
        kind: "unsupported-execution-shape",
      }),
    );
  });

  it("closes the reproduced matrix-to-action evidence collision", () => {
    const variant = (payload: string): string => `
on: workflow_dispatch
jobs:
  verify:
    strategy:
      matrix:
        payload:
          - ${payload}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@${"a".repeat(40)}
        with:
          script: "\${{ matrix.payload }}"
`;
    const harmless = canonicalizeWorkflowExecutionSurface(
      DEFAULT_WORKFLOW_PATH,
      variant("core.info()"),
    );
    const executable = canonicalizeWorkflowExecutionSurface(
      DEFAULT_WORKFLOW_PATH,
      variant('require("child_process").execSync("id")'),
    );
    expect(harmless.evidence).toBeUndefined();
    expect(executable.evidence).toBeUndefined();
    expect(harmless.violations).not.toEqual([]);
    expect(executable.violations).not.toEqual([]);
  });

  it.each([
    ["run", "run: echo \u0024{{ github.sha }}"],
    ["shell", "run: echo\nshell: \u0024{{ matrix.shell }}"],
    [
      "working directory",
      "run: echo\nworking-directory: \u0024{{ matrix.cwd }}",
    ],
    [
      "step environment",
      'run: echo\nenv: {VALUE: "\u0024{{ github.sha }}"}',
    ],
  ])("rejects dynamic step %s", (_name, step) => {
    const source = workflow(
      [
        "runs-on: ubuntu-latest",
        "steps:",
        "  - " + step.split("\n").join("\n    "),
      ].join("\n"),
    );
    expect(violations(source)).toContainEqual(
      expect.objectContaining({
        kind: "unsupported-execution-shape",
      }),
    );
  });

  it.each([
    ["runner", "\u0024{{ matrix.runner }}"],
    ["runner list", "[ubuntu-latest, '\u0024{{ matrix.runner }}']"],
  ])("rejects dynamic %s labels", (_name, runsOn) => {
    expect(
      violations(
        workflow(
          `runs-on: ${runsOn}\nsteps:\n  - run: echo ok`,
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({
        kind: "unsupported-execution-shape",
      }),
    );
  });

  it.each([
    ["workflow environment", "env:\n  VALUE: \u0024{{ github.sha }}"],
    [
      "workflow default",
      "defaults:\n  run:\n    shell: \u0024{{ matrix.shell }}",
    ],
  ])("rejects dynamic %s", (_name, prefix) => {
    expect(
      violations(
        workflow(
          "runs-on: ubuntu-latest\nsteps:\n  - run: echo ok",
          prefix,
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({
        kind: "unsupported-execution-shape",
      }),
    );
  });

  it("rejects every live workflow until 120d-1b models delegation", () => {
    const names = readdirSync(WORKFLOW_DIRECTORY)
      .filter((name) => /\.ya?ml$/i.test(name))
      .sort();
    expect(names).toHaveLength(7);
    for (const name of names) {
      const result = canonicalizeWorkflowExecutionSurface(
        `.github/workflows/${name}`,
        readFileSync(resolve(WORKFLOW_DIRECTORY, name), "utf8"),
      );
      expect(result.evidence, name).toBeUndefined();
      expect(result.violations.length, name).toBeGreaterThan(0);
    }
  });
});

describe("ordinary-run workflow fail-closed grammar", () => {
  it.each([
    ["duplicate keys", "on: push\njobs:\n  a: 1\n  a: 2\n"],
    ["unterminated flow", "on: push\njobs: [\n"],
    ["bare wildcard alias", "on: push\njobs:\n  verify: *\n"],
    [
      "unknown tag",
      "on: push\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps:\n      - run: !evil echo ok",
    ],
  ])("rejects invalid YAML: %s", (_name, source) => {
    expect(violations(source)).toContainEqual(
      expect.objectContaining({ kind: "invalid-yaml" }),
    );
  });

  it.each([
    ["scalar workflow", "not-a-map"],
    ["missing jobs", "on: push"],
    ["scalar jobs", "on: push\njobs: no"],
    ["sequence jobs", "on: push\njobs: []"],
    ["empty jobs", "on: push\njobs: {}"],
    [
      "unknown top field",
      "on: push\ncommand: hidden\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "malformed name",
      "name: 7\non: push\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "malformed run name",
      "run-name: {bad: true}\non: push\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "scalar workflow environment",
      "on: push\nenv: nope\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
  ])("rejects root shape: %s", (_name, source) => {
    expect(violations(source).length).toBeGreaterThan(0);
  });

  it.each([
    ["missing", "jobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []"],
    [
      "mapping",
      "on: {workflow_dispatch: {}}\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "sequence",
      "on: [push, pull_request]\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "dynamic",
      "on: \u0024{{ inputs.event }}\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
  ])("rejects unsupported trigger: %s", (_name, source) => {
    expect(violations(source)).toContainEqual(
      expect.objectContaining({ subject: "on" }),
    );
  });

  it.each([
    [
      "noncanonical id",
      "on: push\njobs:\n  bad.id:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    ["non-map", "on: push\njobs:\n  verify: nope"],
    [
      "scalar steps",
      "on: push\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: nope",
    ],
    [
      "missing runner",
      "on: push\njobs:\n  verify:\n    steps: []",
    ],
    [
      "missing steps",
      "on: push\njobs:\n  verify:\n    runs-on: ubuntu",
    ],
    [
      "empty runner",
      'on: push\njobs:\n  verify:\n    runs-on: ""\n    steps: []',
    ],
    [
      "non-string runner",
      "on: push\njobs:\n  verify:\n    runs-on: [ubuntu, 2]\n    steps: []",
    ],
    [
      "scalar env",
      "on: push\njobs:\n  verify:\n    runs-on: ubuntu\n    env: nope\n    steps: []",
    ],
    [
      "numeric name",
      "on: push\njobs:\n  verify:\n    name: 7\n    runs-on: ubuntu\n    steps: []",
    ],
  ])("rejects malformed job: %s", (_name, source) => {
    expect(violations(source).length).toBeGreaterThan(0);
  });

  it.each([
    ["non-map step", "runs-on: ubuntu\nsteps:\n  - nope"],
    ["missing run", "runs-on: ubuntu\nsteps:\n  - name: nope"],
    [
      "unknown field",
      "runs-on: ubuntu\nsteps:\n  - run: echo\n    command: hidden",
    ],
    [
      "bad id",
      "runs-on: ubuntu\nsteps:\n  - id: bad.id\n    run: echo",
    ],
    [
      "numeric name",
      "runs-on: ubuntu\nsteps:\n  - name: 7\n    run: echo",
    ],
    [
      "string continue",
      "runs-on: ubuntu\nsteps:\n  - continue-on-error: yes\n    run: echo",
    ],
    [
      "zero timeout",
      "runs-on: ubuntu\nsteps:\n  - timeout-minutes: 0\n    run: echo",
    ],
    [
      "unsafe timeout",
      `runs-on: ubuntu\nsteps:\n  - timeout-minutes: ${Number.MAX_SAFE_INTEGER + 1}\n    run: echo`,
    ],
    ['empty run', 'runs-on: ubuntu\nsteps:\n  - run: ""'],
    ["numeric run", "runs-on: ubuntu\nsteps:\n  - run: 7"],
    [
      "empty shell",
      'runs-on: ubuntu\nsteps:\n  - run: echo\n    shell: ""',
    ],
    [
      "empty cwd",
      'runs-on: ubuntu\nsteps:\n  - run: echo\n    working-directory: ""',
    ],
    [
      "scalar env",
      "runs-on: ubuntu\nsteps:\n  - run: echo\n    env: nope",
    ],
  ])("rejects malformed run step: %s", (_name, job) => {
    expect(violations(workflow(job)).length).toBeGreaterThan(0);
  });

  it.each([
    ["defaults without run", "defaults: {shell: bash}"],
    [
      "unknown default",
      "defaults:\n  run:\n    shell: bash\n    command: hidden",
    ],
    [
      "dynamic default",
      "defaults:\n  run:\n    working-directory: \u0024{{ matrix.cwd }}",
    ],
  ])("rejects malformed defaults: %s", (_name, defaults) => {
    const source = workflow(
      [
        "runs-on: ubuntu",
        ...defaults.split("\n"),
        "steps: []",
      ].join("\n"),
    );
    expect(violations(source).length).toBeGreaterThan(0);
  });

  it.each([
    [".nan", "non-finite NaN"],
    [".inf", "positive infinity"],
    ["-.inf", "negative infinity"],
    [`${Number.MAX_SAFE_INTEGER + 1}`, "unsafe integer"],
    ["1.5", "fraction"],
    ["-0", "negative zero"],
  ])("rejects non-injective numeric binding %s (%s)", (value) => {
    const source = `
on: push
env:
  VALUE: ${value}
jobs:
  verify:
    runs-on: ubuntu
    steps: []
`;
    expect(violations(source)).toContainEqual(
      expect.objectContaining({
        kind: "unsupported-execution-shape",
        subject: "env",
      }),
    );
  });

  it("erases otherwise-valid evidence after any violation", () => {
    const result = canonicalizeWorkflowExecutionSurface(
      DEFAULT_WORKFLOW_PATH,
      `
on: push
jobs:
  valid:
    runs-on: ubuntu
    steps:
      - run: echo valid
  invalid:
    runs-on: ubuntu
    strategy: {matrix: {x: [1]}}
    steps:
      - run: echo invalid
`,
    );
    expect(result.evidence).toBeUndefined();
    expect(result.violations).toContainEqual(
      expect.objectContaining({ subject: "jobs.invalid" }),
    );
  });
});

describe("ordinary-run workflow resource ceilings", () => {
  it("accepts source exactly at the UTF-8 byte ceiling", () => {
    const base =
      "on: push\njobs:\n  verify:\n    runs-on: ubuntu\n    steps: []\n";
    const paddingLength =
      MAX_WORKFLOW_SOURCE_BYTES -
      Buffer.byteLength(base, "utf8") -
      1;
    const source = `${"#".repeat(paddingLength)}\n${base}`;
    expect(Buffer.byteLength(source, "utf8")).toBe(
      MAX_WORKFLOW_SOURCE_BYTES,
    );
    expect(evidence(source).jobs).toHaveLength(1);
  });

  it("rejects source above the byte ceiling before parsing", () => {
    expect(
      violations("x".repeat(MAX_WORKFLOW_SOURCE_BYTES + 1)),
    ).toContainEqual(
      expect.objectContaining({ kind: "resource-limit" }),
    );
  });

  it("accepts and rejects the exact Unicode run boundary", () => {
    const accepted = "☕".repeat(MAX_RUN_CHARACTERS);
    expect(
      evidence(
        workflow(
          `runs-on: ubuntu\nsteps:\n  - run: ${JSON.stringify(accepted)}`,
        ),
      ).jobs[0]?.steps[0]?.run,
    ).toBe(accepted);

    const rejected = "☕".repeat(MAX_RUN_CHARACTERS + 1);
    expect(
      violations(
        workflow(
          `runs-on: ubuntu\nsteps:\n  - run: ${JSON.stringify(rejected)}`,
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({ kind: "resource-limit" }),
    );
  });

  it("accepts and rejects the exact job boundary", () => {
    const jobs = (count: number): string =>
      Array.from(
        { length: count },
        (_, index) =>
          `  job_${index}:\n    runs-on: ubuntu\n    steps: []`,
      ).join("\n");
    expect(evidence(`on: push\njobs:\n${jobs(MAX_WORKFLOW_JOBS)}`).jobs)
      .toHaveLength(MAX_WORKFLOW_JOBS);
    expect(
      violations(
        `on: push\njobs:\n${jobs(MAX_WORKFLOW_JOBS + 1)}`,
      ),
    ).toContainEqual(
      expect.objectContaining({ kind: "resource-limit" }),
    );
  });

  it("accepts and rejects the exact step boundary", () => {
    const steps = (count: number): string =>
      Array.from(
        { length: count },
        () => "      - run: echo ok",
      ).join("\n");
    const accepted = evidence(
      `on: push\njobs:\n  verify:\n    runs-on: ubuntu\n    steps:\n${steps(MAX_WORKFLOW_STEPS)}`,
    );
    expect(accepted.jobs[0]?.steps).toHaveLength(MAX_WORKFLOW_STEPS);
    expect(
      violations(
        `on: push\njobs:\n  verify:\n    runs-on: ubuntu\n    steps:\n${steps(MAX_WORKFLOW_STEPS + 1)}`,
      ),
    ).toContainEqual(
      expect.objectContaining({ kind: "resource-limit" }),
    );
  });

  it("accepts and rejects the exact binding boundary", () => {
    const acceptedBindings = yamlBindings(
      MAX_WORKFLOW_BINDINGS,
      "          ",
    );
    const accepted = evidence(
      [
        "on: push",
        "jobs:",
        "  verify:",
        "    runs-on: ubuntu",
        "    steps:",
        "      - run: echo",
        "        env:",
        acceptedBindings,
      ].join("\n"),
    );
    expect(accepted.jobs[0]?.steps[0]?.environment).toHaveLength(
      MAX_WORKFLOW_BINDINGS,
    );

    const rejectedBindings = yamlBindings(
      MAX_WORKFLOW_BINDINGS + 1,
      "          ",
    );
    expect(
      violations(
        [
          "on: push",
          "jobs:",
          "  verify:",
          "    runs-on: ubuntu",
          "    steps:",
          "      - run: echo",
          "        env:",
          rejectedBindings,
        ].join("\n"),
      ),
    ).toContainEqual(
      expect.objectContaining({ kind: "resource-limit" }),
    );
  });

  it("stops at the job binding expansion boundary", () => {
    const bindings = yamlBindings(
      MAX_WORKFLOW_BINDINGS + 1,
      "      ",
    );
    expect(
      violations(
        [
          "on: push",
          "jobs:",
          "  verify:",
          "    runs-on: ubuntu",
          "    env:",
          bindings,
          "    steps: []",
        ].join("\n"),
      ),
    ).toContainEqual(
      expect.objectContaining({ kind: "resource-limit" }),
    );
  });

  it("stops at the workflow binding expansion boundary", () => {
    const bindings = yamlBindings(
      MAX_WORKFLOW_BINDINGS + 1,
      "  ",
    );
    expect(
      violations(
        [
          "on: push",
          "env:",
          bindings,
          "jobs:",
          "  verify:",
          "    runs-on: ubuntu",
          "    steps: []",
        ].join("\n"),
      ),
    ).toContainEqual(
      expect.objectContaining({ kind: "resource-limit" }),
    );
  });

  it("accepts 100 direct aliases and rejects 101", () => {
    const source = (count: number): string => {
      const aliases = Array.from(
        { length: count },
        () => "      - run: *run_text",
      ).join("\n");
      return [
        "on: push",
        "jobs:",
        "  verify:",
        "    runs-on: ubuntu",
        "    steps:",
        "      - run: &run_text echo ok",
        aliases,
      ].join("\n");
    };
    expect(
      evidence(source(MAX_WORKFLOW_ALIASES)).jobs[0]?.steps,
    ).toHaveLength(MAX_WORKFLOW_ALIASES + 1);
    expect(violations(source(MAX_WORKFLOW_ALIASES + 1))).toContainEqual(
      expect.objectContaining({ kind: "resource-limit" }),
    );
  });

  it("rejects amplified nested aliases", () => {
    const aliases = (anchor: string): string =>
      Array.from(
        { length: Math.ceil(Math.sqrt(MAX_WORKFLOW_ALIASES)) + 1 },
        () => `*${anchor}`,
      ).join(", ");
    const source = [
      "on: push",
      `base: &base {run: echo}`,
      `a: &a [${aliases("base")}]`,
      `b: &b [${aliases("a")}]`,
      "jobs:",
      "  verify:",
      "    runs-on: ubuntu",
      `    steps: [${aliases("b")}]`,
    ].join("\n");
    expect(violations(source)).toContainEqual(
      expect.objectContaining({ kind: "resource-limit" }),
    );
  });
});
