import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_WORKFLOW_CANONICAL_VALUES,
} from "../../scripts/factory/workflow-canonical-value-logic.mts";
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
      trigger: {
        kind: "mapping",
        entries: [
          {
            key: "workflow_dispatch",
            value: { kind: "null" },
          },
        ],
      },
      workflowName: "test",
      runName: null,
      workflowEnvironment: [],
      canonicalValueCount: 5,
      canonicalValueDepth: 2,
      jobs: [
        {
          id: "verify",
          line: 5,
          name: null,
          runner: {
            kind: "sequence",
            items: [{ kind: "string", value: "ubuntu-latest" }],
          },
          permissions: {
            githubTokenMaterialPresent: true,
            declaredCapability: "unresolved-default",
            declaration: { kind: "unresolved-default" },
          },
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

  it("pins 1b1 runner equivalence while 120a conservatively diverges", () => {
    const source = (runner: string) => `
on: push
jobs:
  verify:
    runs-on: ${runner}
    steps: []
`;
    const scalar = evidence(source("ubuntu-latest"));
    const singleLabelList = evidence(
      source("[ubuntu-latest]"),
    );

    expect(singleLabelList).toEqual(scalar);
    expect(singleLabelList.canonicalValueCount).toBe(
      scalar.canonicalValueCount,
    );
  });

  it("normalizes workflow concurrency scalar/map and fixed-false spellings", () => {
    const source = (concurrency: string) => `
on: push
concurrency: ${concurrency}
jobs:
  verify:
    runs-on: ubuntu
    steps: []
`;
    const scalar = evidence(source("serial"));
    const groupMap = evidence(source("{group: serial}"));
    const fixedFalse = evidence(
      source(
        "{group: serial, cancel-in-progress: false}",
      ),
    );

    expect(groupMap).toEqual(scalar);
    expect(fixedFalse).toEqual(scalar);
    expect(fixedFalse.canonicalValueCount).toBe(
      scalar.canonicalValueCount,
    );
  });

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
  : 1.5
jobs:
  verify:
    runs-on: ubuntu
    steps: []
`;
    const baseName = "A";
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

    expect(result.trigger).toEqual({
      kind: "mapping",
      entries: [{ key: "push", value: { kind: "null" } }],
    });
    expect(result.workflowEnvironment).toEqual([
      { name: "A", value: "workflow", scope: "workflow" },
      { name: "B", value: "workflow", scope: "workflow" },
    ]);
    expect(result.jobs[0]).toMatchObject({
      runner: {
        kind: "sequence",
        items: [
          { kind: "string", value: "self-hosted" },
          { kind: "string", value: "linux" },
        ],
      },
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

  it.each(["workflow", "job", "step"] as const)(
    "rejects case-colliding %s environment names in either declaration order",
    (scope) => {
      const source = (bindings: readonly string[]): string => {
        const environment = [
          "env:",
          ...bindings.map((binding) => `  ${binding}`),
        ];
        const workflowEnvironment =
          scope === "workflow" ? environment : [];
        const jobEnvironment =
          scope === "job"
            ? environment.map((line) => `    ${line}`)
            : [];
        const stepEnvironment =
          scope === "step"
            ? environment.map((line) => `        ${line}`)
            : [];
        return [
          "on: push",
          ...workflowEnvironment,
          "jobs:",
          "  verify:",
          "    runs-on: windows-latest",
          ...jobEnvironment,
          "    steps:",
          "      - shell: pwsh",
          "        run: Write-Output $env:TOKEN",
          ...stepEnvironment,
        ].join("\n");
      };

      for (const bindings of [
        ["TOKEN: upper", "token: lower"],
        ["token: lower", "TOKEN: upper"],
      ]) {
        expect(violations(source(bindings))).toContainEqual(
          expect.objectContaining({
            kind: "unsupported-execution-shape",
            detail: expect.stringContaining(
              "unique under case-insensitive runner semantics",
            ),
          }),
        );
      }
    },
  );

  it("accepts portable mixed-case environment names without collisions", () => {
    expect(
      evidence(`
on: push
env:
  Mixed_Case1: static
jobs:
  verify:
    runs-on: windows-latest
    steps:
      - shell: pwsh
        run: Write-Output $env:Mixed_Case1
`),
    ).toMatchObject({
      workflowEnvironment: [
        {
          name: "Mixed_Case1",
          value: "static",
          scope: "workflow",
        },
      ],
    });
  });

  it("rejects non-portable environment names", () => {
    expect(
      violations(`
on: push
env:
  NON-PORTABLE: static
jobs:
  verify:
    runs-on: ubuntu-latest
    steps: []
`),
    ).toContainEqual(
      expect.objectContaining({
        kind: "unsupported-execution-shape",
        detail: expect.stringContaining(
          "environment binding names must be portable ASCII",
        ),
      }),
    );
  });

  it.each([
    ["workflow", "job"],
    ["workflow", "step"],
    ["job", "step"],
  ] as const)(
    "rejects case-colliding environment names across %s and %s scopes",
    (outerScope, innerScope) => {
      const source = (
        outerName: string,
        innerName: string,
      ): string => {
        const bindings = new Map([
          [outerScope, `${outerName}: outer`],
          [innerScope, `${innerName}: inner`],
        ]);
        return [
          "on: push",
          ...(bindings.has("workflow")
            ? ["env:", `  ${bindings.get("workflow")}`]
            : []),
          "jobs:",
          "  verify:",
          "    runs-on: windows-latest",
          ...(bindings.has("job")
            ? ["    env:", `      ${bindings.get("job")}`]
            : []),
          "    steps:",
          "      - shell: pwsh",
          "        run: Write-Output $env:TOKEN",
          ...(bindings.has("step")
            ? ["        env:", `          ${bindings.get("step")}`]
            : []),
        ].join("\n");
      };

      for (const [outerName, innerName] of [
        ["TOKEN", "token"],
        ["token", "TOKEN"],
      ]) {
        expect(violations(source(outerName, innerName))).toContainEqual(
          expect.objectContaining({
            kind: "unsupported-execution-shape",
            detail: expect.stringContaining(
              "effective environment binding names must be unique",
            ),
          }),
        );
      }
    },
  );

  it("preserves exact-name environment overrides across scopes", () => {
    const result = evidence(`
on: push
env:
  TOKEN: workflow
jobs:
  verify:
    runs-on: windows-latest
    env:
      TOKEN: job
    steps:
      - shell: pwsh
        run: Write-Output $env:TOKEN
        env:
          TOKEN: step
`);
    expect(result.jobs[0]?.environment).toEqual([
      { name: "TOKEN", value: "job", scope: "job" },
    ]);
    expect(result.jobs[0]?.steps[0]?.environment).toEqual([
      { name: "TOKEN", value: "step", scope: "step" },
    ]);
  });

  it("keeps case-equivalent environment names independent across jobs", () => {
    const result = evidence(`
on: push
jobs:
  first:
    runs-on: windows-latest
    env:
      TOKEN: first
    steps: []
  second:
    runs-on: windows-latest
    env:
      token: second
    steps: []
`);
    expect(result.jobs.map((job) => job.environment)).toEqual([
      [{ name: "TOKEN", value: "first", scope: "job" }],
      [{ name: "token", value: "second", scope: "job" }],
    ]);
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
        timeout-minutes: 360
        run: echo ok
`);
    expect(result.jobs[0]?.steps[0]).toMatchObject({
      id: "allowed_id",
      name: "Static step",
      continueOnError: { kind: "boolean", value: false },
      timeoutMinutes: { kind: "integer", value: 360 },
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

describe("ordinary context evidence (issue #120 slice 120d-1b1)", () => {
  it("canonicalizes the complete closed ordinary-run context surface", () => {
    const result = evidence(`
name: Context
run-name: "Run \${{ github.run_id }}"
on:
  workflow_dispatch:
    inputs:
      target:
        required: true
        type: string
permissions:
  contents: read
concurrency:
  group: "workflow-\${{ github.ref }}"
  cancel-in-progress: false
env:
  SHA: "\${{ github.sha }}"
jobs:
  verify:
    name: Verify
    needs: prepare
    if: success()
    permissions:
      issues: write
    concurrency:
      group: "job-\${{ matrix.os }}"
      cancel-in-progress: true
    strategy:
      fail-fast: false
      max-parallel: 2
      matrix:
        os: [ubuntu-latest, windows-latest]
        include:
          - os: ubuntu-latest
            experimental: false
    runs-on: "\${{ matrix.os }}"
    outputs:
      digest: "\${{ steps.hash.outputs.digest }}"
    environment:
      name: production
      url: "\${{ steps.deploy.outputs.url }}"
    continue-on-error: "\${{ matrix.experimental }}"
    timeout-minutes: "\${{ vars.TIMEOUT }}"
    steps:
      - id: hash
        name: Hash
        if: "\${{ github.ref == 'refs/heads/main' }}"
        env:
          VALUE: "prefix-\${{ matrix.os }}"
        continue-on-error: false
        timeout-minutes: 5
        shell: "\${{ matrix.shell }}"
        working-directory: "work/\${{ matrix.os }}"
        run: "echo \${{ github.sha }}"
`);

    expect(result.runName).toBe("Run ${{ github.run_id }}");
    expect(result.concurrency).toEqual({
      kind: "mapping",
      entries: [
        {
          key: "group",
          value: {
            kind: "string",
            value: "workflow-${{ github.ref }}",
          },
        },
      ],
    });
    expect(result.jobs[0]).toMatchObject({
      name: "Verify",
      concurrency: {
        kind: "mapping",
        entries: [
          {
            key: "group",
            value: {
              kind: "string",
              value: "job-${{ matrix.os }}",
            },
          },
          {
            key: "cancel-in-progress",
            value: { kind: "boolean", value: true },
          },
        ],
      },
      needs: {
        kind: "sequence",
        items: [{ kind: "string", value: "prepare" }],
      },
      permissions: {
        githubTokenMaterialPresent: true,
        declaredCapability: "write",
      },
      condition: {
        kind: "string",
        spelling: "bare",
        value: "success()",
      },
      continueOnError: {
        kind: "string",
        spelling: "wrapped",
        value: "${{ matrix.experimental }}",
      },
      timeoutMinutes: {
        kind: "string",
        spelling: "wrapped",
        value: "${{ vars.TIMEOUT }}",
      },
      outputs: {
        kind: "mapping",
        entries: [
          {
            key: "digest",
            value: {
              kind: "string",
              value: "${{ steps.hash.outputs.digest }}",
            },
          },
        ],
      },
      deploymentEnvironment: {
        kind: "mapping",
        entries: [
          {
            key: "name",
            value: { kind: "string", value: "production" },
          },
          {
            key: "url",
            value: {
              kind: "string",
              value: "${{ steps.deploy.outputs.url }}",
            },
          },
        ],
      },
    });
    expect(result.jobs[0]?.steps[0]).toMatchObject({
      condition: {
        kind: "string",
        spelling: "wrapped",
        value: "${{ github.ref == 'refs/heads/main' }}",
      },
      run: "echo ${{ github.sha }}",
      shell: {
        source: "step",
        value: "${{ matrix.shell }}",
      },
      workingDirectory: {
        source: "step",
        value: "work/${{ matrix.os }}",
      },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /"trusted"|"authorized"|"executes"/,
    );
  });

  it("normalizes equivalent trigger spellings with identical counts", () => {
    const body =
      "jobs:\n  verify:\n    runs-on: ubuntu\n    steps: []";
    const scalarSequence = evidence(
      `on: [push, pull_request]\n${body}`,
    );
    const nullMapping = evidence(
      `on:\n  push:\n  pull_request:\n${body}`,
    );
    const emptyMapping = evidence(
      `on:\n  pull_request: {}\n  push: {}\n${body}`,
    );

    expect(scalarSequence.trigger).toEqual(nullMapping.trigger);
    expect(emptyMapping.trigger).toEqual(nullMapping.trigger);
    expect(scalarSequence.canonicalValueCount).toBe(
      nullMapping.canonicalValueCount,
    );
    expect(emptyMapping.canonicalValueCount).toBe(
      nullMapping.canonicalValueCount,
    );
  });

  it("captures ordered schedule declarations with the documented timezone field", () => {
    const source = (schedule: string) => `
on:
  schedule:
${schedule}
jobs:
  verify:
    runs-on: ubuntu
    steps: []
`;
    const first = evidence(
      source(
        '    - cron: "17 3 * * 2"\n      timezone: Europe/London\n    - cron: "5 4 * * 3"',
      ),
    );
    const reversed = evidence(
      source(
        '    - cron: "5 4 * * 3"\n    - cron: "17 3 * * 2"\n      timezone: Europe/London',
      ),
    );

    expect(first.trigger).toMatchObject({
      kind: "mapping",
      entries: [
        {
          key: "schedule",
          value: {
            kind: "sequence",
            items: [
              {
                kind: "mapping",
                entries: [
                  {
                    key: "cron",
                    value: {
                      kind: "string",
                      value: "17 3 * * 2",
                    },
                  },
                  {
                    key: "timezone",
                    value: {
                      kind: "string",
                      value: "Europe/London",
                    },
                  },
                ],
              },
              {
                kind: "mapping",
                entries: [
                  {
                    key: "cron",
                    value: {
                      kind: "string",
                      value: "5 4 * * 3",
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    });
    expect(JSON.stringify(first)).not.toBe(
      JSON.stringify(reversed),
    );
  });

  it("captures image-version name and version filters injectively", () => {
    const source = (version: string) => `
on:
  image_version:
    names: [ubuntu]
    versions: ["${version}"]
jobs:
  verify:
    runs-on: ubuntu
    steps: []
`;
    const current = evidence(source("24.*"));
    const next = evidence(source("25.*"));

    expect(current.trigger).toMatchObject({
      kind: "mapping",
      entries: [
        {
          key: "image_version",
          value: {
            kind: "mapping",
            entries: [
              {
                key: "names",
                value: {
                  kind: "sequence",
                  items: [
                    { kind: "string", value: "ubuntu" },
                  ],
                },
              },
              {
                key: "versions",
                value: {
                  kind: "sequence",
                  items: [
                    { kind: "string", value: "24.*" },
                  ],
                },
              },
            ],
          },
        },
      ],
    });
    expect(JSON.stringify(current)).not.toBe(JSON.stringify(next));
  });

  it.each([
    [
      "needs scalar/list",
      "needs: prepare",
      "needs: [prepare]",
    ],
    [
      "runner scalar/single-label list",
      "runs-on: ubuntu-latest",
      "runs-on: [ubuntu-latest]",
    ],
    [
      "environment scalar/name map",
      "environment: production",
      "environment: {name: production}",
    ],
    [
      "concurrency scalar/group map",
      "concurrency: serial",
      "concurrency: {group: serial}",
    ],
    [
      "explicit fixed false concurrency default",
      "concurrency: {group: serial}",
      "concurrency: {group: serial, cancel-in-progress: false}",
    ],
  ])(
    "normalizes equivalent %s evidence and counts",
    (_name, leftControl, rightControl) => {
      const source = (control: string) =>
        [
          "on: push",
          "jobs:",
          "  prepare:",
          "    runs-on: ubuntu",
          "    steps: []",
          "  verify:",
          `    ${control}`,
          ...(control.startsWith("runs-on:")
            ? []
            : ["    runs-on: ubuntu"]),
          "    steps: []",
          "",
        ].join("\n");
      const left = evidence(source(leftControl));
      const right = evidence(source(rightControl));

      expect(left).toEqual(right);
      expect(left.canonicalValueCount).toBe(
        right.canonicalValueCount,
      );
    },
  );

  it("keeps all owned control near misses injectively distinct", () => {
    const source = (
      runName: string,
      workflowConcurrency: string,
      jobConcurrency: string,
      needs: string,
      output: string,
      deploymentEnvironment: string,
    ) => `
run-name: ${runName}
on: push
concurrency: {group: ${workflowConcurrency}}
jobs:
  alternate:
    runs-on: ubuntu
    steps: []
  prepare:
    runs-on: ubuntu
    steps: []
  verify:
    concurrency: {group: ${jobConcurrency}}
    needs: ${needs}
    outputs: {digest: "${output}"}
    environment: ${deploymentEnvironment}
    runs-on: ubuntu
    steps: []
`;
    const baselineArguments = [
      "baseline",
      "workflow-a",
      "job-a",
      "prepare",
      "${{ github.sha }}",
      "production",
    ] as const;
    const baseline = evidence(source(...baselineArguments));
    const variants = [
      source(
        "other",
        "workflow-a",
        "job-a",
        "prepare",
        "${{ github.sha }}",
        "production",
      ),
      source(
        "baseline",
        "workflow-b",
        "job-a",
        "prepare",
        "${{ github.sha }}",
        "production",
      ),
      source(
        "baseline",
        "workflow-a",
        "job-b",
        "prepare",
        "${{ github.sha }}",
        "production",
      ),
      source(
        "baseline",
        "workflow-a",
        "job-a",
        "alternate",
        "${{ github.sha }}",
        "production",
      ),
      source(
        "baseline",
        "workflow-a",
        "job-a",
        "prepare",
        "${{ github.ref }}",
        "production",
      ),
      source(
        "baseline",
        "workflow-a",
        "job-a",
        "prepare",
        "${{ github.sha }}",
        '{name: production, url: "${{ github.ref }}"}',
      ),
    ].map((variant) => evidence(variant));

    for (const variant of variants) {
      expect(JSON.stringify(variant)).not.toBe(
        JSON.stringify(baseline),
      );
    }
  });

  it("canonicalizes scalar concurrency and runners to richer mappings and sequences", () => {
    const result = evidence(`
on: push
concurrency: singleton
jobs:
  verify:
    runs-on: ubuntu-latest
    steps: []
`);

    expect(result.concurrency).toEqual({
      kind: "mapping",
      entries: [
        {
          key: "group",
          value: { kind: "string", value: "singleton" },
        },
      ],
    });
    expect(result.jobs[0]?.runner).toEqual({
      kind: "sequence",
      items: [
        { kind: "string", value: "ubuntu-latest" },
      ],
    });
  });

  it("keeps absent, empty, read, and write permissions injectively distinct", () => {
    const variant = (permissions: string): WorkflowExecutionSurfaceEvidence =>
      evidence(`
on: push
${permissions}
jobs:
  verify:
    runs-on: ubuntu
    steps: []
`);
    const absent = variant("");
    const empty = variant("permissions: {}");
    const read = variant("permissions: {contents: read}");
    const write = variant("permissions: {contents: write}");

    expect(absent.jobs[0]?.permissions).not.toEqual(
      empty.jobs[0]?.permissions,
    );
    expect(empty.jobs[0]?.permissions).not.toEqual(
      read.jobs[0]?.permissions,
    );
    expect(read.jobs[0]?.permissions).not.toEqual(
      write.jobs[0]?.permissions,
    );
    expect(read.jobs[0]?.permissions.githubTokenMaterialPresent).toBe(
      true,
    );
  });

  it("preserves condition spelling and scalar types without pruning steps", () => {
    const variant = (condition: string): WorkflowExecutionSurfaceEvidence =>
      evidence(
        workflow(
          `runs-on: ubuntu\nsteps:\n  - if: ${condition}\n    run: echo`,
        ),
      );
    const bare = variant("success()");
    const wrapped = variant('"${{ success() }}"');
    const boolean = variant("false");
    const stringBoolean = variant('"false"');
    const integer = variant("1");
    const stringInteger = variant('"1"');
    const template = variant(
      '"prefix-${{ github.ref }}-suffix"',
    );
    const multiExpressionTemplate = variant(
      '"${{ success() }}-x-${{ failure() }}"',
    );
    const attackerContext = variant(
      "github.event.pull_request.head.repo.fork == false",
    );

    expect(bare.jobs[0]?.steps[0]?.condition).toMatchObject({
      spelling: "bare",
      value: "success()",
    });
    expect(wrapped.jobs[0]?.steps[0]?.condition).toMatchObject({
      spelling: "wrapped",
      value: "${{ success() }}",
    });
    expect(boolean.jobs[0]?.steps[0]?.condition).toEqual({
      kind: "boolean",
      value: false,
    });
    expect(stringBoolean.jobs[0]?.steps[0]?.condition).toEqual({
      kind: "string",
      spelling: "bare",
      value: "false",
    });
    expect(integer.jobs[0]?.steps[0]?.condition).toEqual({
      kind: "integer",
      value: 1,
    });
    expect(stringInteger.jobs[0]?.steps[0]?.condition).toEqual({
      kind: "string",
      spelling: "bare",
      value: "1",
    });
    expect(template.jobs[0]?.steps[0]?.condition).toEqual({
      kind: "string",
      spelling: "template",
      value: "prefix-${{ github.ref }}-suffix",
    });
    expect(
      multiExpressionTemplate.jobs[0]?.steps[0]?.condition,
    ).toEqual({
      kind: "string",
      spelling: "template",
      value: "${{ success() }}-x-${{ failure() }}",
    });
    expect(JSON.stringify(bare)).not.toBe(JSON.stringify(wrapped));
    expect(JSON.stringify(boolean)).not.toBe(
      JSON.stringify(stringBoolean),
    );
    expect(JSON.stringify(integer)).not.toBe(
      JSON.stringify(stringInteger),
    );
    for (const accepted of [boolean, attackerContext]) {
      expect(accepted.jobs[0]?.steps).toHaveLength(1);
      expect(
        Object.hasOwn(accepted.jobs[0]?.steps[0] ?? {}, "executes"),
      ).toBe(false);
    }
  });

  it("distinguishes matrix payload, key order, and ordered filters", () => {
    const variant = (matrix: string): WorkflowExecutionSurfaceEvidence =>
      evidence(`
on: push
jobs:
  verify:
    strategy:
      matrix:
${matrix}
    runs-on: "\${{ matrix.os }}"
    steps:
      - run: "echo \${{ matrix.payload }}"
`);
    const harmless = variant(
      "        os: [ubuntu]\n        payload: [safe]",
    );
    const executable = variant(
      '        os: [ubuntu]\n        payload: ["$(id)"]',
    );
    const reordered = variant(
      "        payload: [safe]\n        os: [ubuntu]",
    );
    const reversedInclude = variant(
      "        os: [ubuntu]\n        include: [{os: ubuntu}, {os: windows}]",
    );
    const includeOrder = variant(
      "        os: [ubuntu]\n        include: [{os: windows}, {os: ubuntu}]",
    );

    expect(JSON.stringify(harmless)).not.toBe(
      JSON.stringify(executable),
    );
    expect(JSON.stringify(harmless)).not.toBe(
      JSON.stringify(reordered),
    );
    expect(JSON.stringify(reversedInclude)).not.toBe(
      JSON.stringify(includeOrder),
    );
  });

  it("rejects malformed permissions with no partial evidence", () => {
    expect(
      violations(`
on: push
permissions:
  frobnicate: none
jobs:
  verify:
    runs-on: ubuntu
    steps: []
`),
    ).toContainEqual(
      expect.objectContaining({
        kind: "unsupported-execution-shape",
        subject: "permissions",
      }),
    );
  });
});

describe("delegated/container surfaces remain fail closed", () => {
  it.each([
    ["action step", `uses: actions/checkout@${"a".repeat(40)}`],
    ["local action", "uses: ./.github/actions/review"],
    ["dynamic action", 'uses: "owner/action@${{ inputs.ref }}"'],
    ["action inputs", "run: echo\nwith: {script: hidden}"],
  ])("rejects delegated step form: %s", (_name, step) => {
    expect(
      violations(
        workflow(
          [
            "runs-on: ubuntu-latest",
            "steps:",
            "  - " + step.split("\n").join("\n    "),
          ].join("\n"),
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({ kind: "unsupported-execution-shape" }),
    );
  });

  it.each([
    [
      "reusable workflow",
      `uses: owner/repo/.github/workflows/a.yml@${"a".repeat(40)}`,
    ],
    ["local reusable workflow", "uses: ./.github/workflows/a.yml"],
    [
      "dynamic reusable workflow",
      'uses: "owner/repo/.github/workflows/a.yml@${{ inputs.ref }}"',
    ],
    ["container", "container: node:24"],
    ["services", "services: {redis: {image: redis}}"],
  ])("rejects deferred job form: %s", (_name, field) => {
    expect(
      violations(
        workflow(
          `runs-on: ubuntu-latest\n${field}\nsteps:\n  - run: echo`,
        ),
      ),
    ).toContainEqual(
      expect.objectContaining({
        subject: "jobs.verify",
        kind: "unsupported-execution-shape",
      }),
    );
  });

  it("keeps matrix evidence unavailable when the step is an action", () => {
    const result = canonicalizeWorkflowExecutionSurface(
      DEFAULT_WORKFLOW_PATH,
      `
on: workflow_dispatch
jobs:
  verify:
    strategy:
      matrix:
        payload: [safe]
    runs-on: ubuntu-latest
    steps:
      - uses: actions/github-script@${"a".repeat(40)}
        with:
          script: "\${{ matrix.payload }}"
`,
    );
    expect(result.evidence).toBeUndefined();
    expect(result.violations).not.toEqual([]);
  });

  it("rejects every live workflow until delegation is modeled", () => {
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
    ["empty workflow", ""],
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
    [
      "held single queue workflow control",
      "on: push\nconcurrency:\n  group: one\n  queue: single\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "held max queue job control",
      "on: push\njobs:\n  verify:\n    concurrency:\n      group: one\n      queue: max\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "ordered-map permissions",
      "on: push\npermissions: !!omap []\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "set permissions",
      "on: push\npermissions: !!set {}\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
  ])("rejects root shape: %s", (_name, source) => {
    expect(violations(source).length).toBeGreaterThan(0);
  });

  it.each([
    ["missing", "jobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []"],
    [
      "event sequence body",
      "on: {workflow_dispatch: []}\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "empty event sequence",
      "on: []\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "empty event map",
      "on: {}\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "empty schedule",
      "on: {schedule: []}\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "schedule missing cron",
      "on: {schedule: [{timezone: UTC}]}\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "schedule unknown field",
      "on: {schedule: [{cron: '5 4 * * 3', hidden: true}]}\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "unknown static event",
      "on: frobnicate\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "scalar image version",
      "on: image_version\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "null image version",
      "on: {image_version: null}\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "empty image version",
      "on: {image_version: {}}\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "image version missing names",
      "on: {image_version: {versions: ['24.*']}}\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "image version missing versions",
      "on: {image_version: {names: [ubuntu]}}\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "image version unknown filter",
      "on: {image_version: {names: [ubuntu], versions: ['24.*'], hidden: true}}\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "image version empty names",
      "on: {image_version: {names: [], versions: ['24.*']}}\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "image version numeric name",
      "on: {image_version: {names: [24], versions: ['24.*']}}\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "image version empty version",
      "on: {image_version: {names: [ubuntu], versions: ['']}}\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
    ],
    [
      "duplicate sequence event",
      "on: [push, push]\njobs:\n  verify:\n    runs-on: ubuntu-latest\n    steps: []",
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
    [
      "empty needs sequence",
      "on: push\njobs:\n  verify:\n    needs: []\n    runs-on: ubuntu\n    steps: []",
    ],
    [
      "concurrency without group",
      "on: push\njobs:\n  verify:\n    concurrency: {cancel-in-progress: false}\n    runs-on: ubuntu\n    steps: []",
    ],
    [
      "malformed concurrency cancellation",
      "on: push\njobs:\n  verify:\n    concurrency: {group: one, cancel-in-progress: never}\n    runs-on: ubuntu\n    steps: []",
    ],
    [
      "strategy without matrix",
      "on: push\njobs:\n  verify:\n    strategy: {fail-fast: false}\n    runs-on: ubuntu\n    steps: []",
    ],
    [
      "environment without name",
      "on: push\njobs:\n  verify:\n    environment: {url: https://example.test}\n    runs-on: ubuntu\n    steps: []",
    ],
    [
      "malformed environment URL",
      "on: push\njobs:\n  verify:\n    environment: {name: production, url: 7}\n    runs-on: ubuntu\n    steps: []",
    ],
    [
      "runner mapping without group",
      "on: push\njobs:\n  verify:\n    runs-on: {labels: ubuntu}\n    steps: []",
    ],
    [
      "runner group mapping is deferred",
      "on: push\njobs:\n  verify:\n    runs-on: {group: trusted, labels: ubuntu}\n    steps: []",
    ],
    [
      "non-portable deployment environment",
      "on: push\njobs:\n  verify:\n    environment: prod-east\n    runs-on: ubuntu\n    steps: []",
    ],
    [
      "case-colliding deployment environments",
      "on: push\njobs:\n  first:\n    environment: Production\n    runs-on: ubuntu\n    steps: []\n  second:\n    environment: production\n    runs-on: ubuntu\n    steps: []",
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
    [
      "timeout over documented step maximum",
      "runs-on: ubuntu\nsteps:\n  - timeout-minutes: 361\n    run: echo",
    ],
    ['empty run', 'runs-on: ubuntu\nsteps:\n  - run: ""'],
    ["numeric run", "runs-on: ubuntu\nsteps:\n  - run: 7"],
    [
      "null condition",
      "runs-on: ubuntu\nsteps:\n  - if: null\n    run: echo",
    ],
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
    container: node:24
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
    ).toEqual([
      expect.objectContaining({ kind: "resource-limit" }),
    ]);
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

  it(
    "accepts and rejects the exact per-workflow canonical-value boundary",
    () => {
      const source = (branchCount: number): string => {
        const branches = Array.from(
          { length: branchCount },
          (_, index) => `      - branch_${index}`,
        ).join("\n");
        return [
          "on:",
          "  push:",
          "    branches:",
          branches,
          "jobs:",
          "  verify:",
          "    runs-on: ubuntu",
          "    steps: []",
        ].join("\n");
      };
      const accepted = evidence(source(16_377));
      expect(accepted.canonicalValueCount).toBe(
        MAX_WORKFLOW_CANONICAL_VALUES,
      );

      const rejected = canonicalizeWorkflowExecutionSurface(
        DEFAULT_WORKFLOW_PATH,
        source(16_378),
      );
      expect(rejected.evidence).toBeUndefined();
      expect(rejected.violations).toEqual([
        expect.objectContaining({ kind: "resource-limit" }),
      ]);
    },
    15_000,
  );

  it("charges each expanded alias occurrence to canonical evidence", () => {
    const source = (matrixEntries: string): string => `
on: push
jobs:
  verify:
    strategy:
      matrix:
        value: &values [one, two]
        include:
${matrixEntries}
    runs-on: ubuntu
    steps: []
`;
    const once = evidence(source("          - value: *values"));
    const twice = evidence(
      source(
        "          - value: *values\n          - value: *values",
      ),
    );

    expect(twice.canonicalValueCount).toBeGreaterThan(
      once.canonicalValueCount,
    );
    expect(twice.jobs[0]?.strategy).not.toEqual(
      once.jobs[0]?.strategy,
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

  it("bounds unresolved-alias diagnostics at the source-size ceiling", () => {
    const prefix = "on: push\njobs:\n  verify: *";
    const aliasName = "a".repeat(
      MAX_WORKFLOW_SOURCE_BYTES - Buffer.byteLength(prefix),
    );
    const source = `${prefix}${aliasName}`;
    expect(Buffer.byteLength(source)).toBe(MAX_WORKFLOW_SOURCE_BYTES);

    const result = violations(source);
    expect(result).toEqual([
      {
        kind: "resource-limit",
        line: 1,
        subject: "<workflow>",
        detail:
          "expanded YAML exceeds the bounded pre-canonicalization budget",
      },
    ]);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(
      MAX_WORKFLOW_VIOLATION_BYTES,
    );
    expect(JSON.stringify(result)).not.toContain(aliasName.slice(0, 128));
  });

  it(
    "stops expanded YAML before conversion amplification",
    () => {
      const events = Array.from(
        { length: 65_536 },
        () => "push",
      ).join(", ");
      const result = canonicalizeWorkflowExecutionSurface(
        DEFAULT_WORKFLOW_PATH,
        `on: [${events}]\njobs: {}`,
      );

      expect(result.evidence).toBeUndefined();
      expect(result.violations).toEqual([
        {
          kind: "resource-limit",
          line: 1,
          subject: "<workflow>",
          detail:
            "expanded YAML exceeds the bounded pre-canonicalization budget",
        },
      ]);
    },
    15_000,
  );

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
