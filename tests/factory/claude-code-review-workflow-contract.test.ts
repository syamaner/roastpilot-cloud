import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/claude-code-review.yml", import.meta.url),
);
const TOOL_CATALOG_FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/claude-review-sdk-tool-catalog.json", import.meta.url),
);

type Mapping = Record<string, unknown>;

function asMapping(value: unknown): Mapping {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected workflow mapping");
  }
  return value as Mapping;
}

function parseWorkflow(): Mapping {
  return parseWorkflowSource(readFileSync(WORKFLOW_PATH, "utf8"));
}

function parseWorkflowSource(source: string): Mapping {
  const document = parseDocument(source);
  expect(document.errors).toEqual([]);
  return document.toJS() as Mapping;
}

function parseToolCatalogFixture(): Mapping {
  return asMapping(
    JSON.parse(readFileSync(TOOL_CATALOG_FIXTURE_PATH, "utf8")) as unknown,
  );
}

function fixtureStringArray(fixture: Mapping, field: string): string[] {
  const value = fixture[field];
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new Error(`tool-catalog fixture ${field} is not a string array`);
  }
  return value;
}

function jobIf(workflow: Mapping, jobName: string): string {
  const job = asMapping(asMapping(workflow.jobs)[jobName]);
  if (typeof job.if !== "string") {
    throw new Error(`${jobName} has no string if expression`);
  }
  return job.if;
}

function jobStep(workflow: Mapping, jobName: string, stepName: string): Mapping {
  const steps = asMapping(asMapping(workflow.jobs)[jobName]).steps;
  if (!Array.isArray(steps)) {
    throw new Error(`${jobName} has no steps array`);
  }
  const step = steps.find((candidate) => asMapping(candidate).name === stepName);
  if (!step) {
    throw new Error(`${jobName} has no "${stepName}" step`);
  }
  return asMapping(step);
}

function jobSteps(workflow: Mapping, jobName: string): Mapping[] {
  const steps = asMapping(asMapping(workflow.jobs)[jobName]).steps;
  if (!Array.isArray(steps)) {
    throw new Error(`${jobName} has no steps array`);
  }
  return steps.map(asMapping);
}

function marketplaceMachineryFindings(source: string): string[] {
  const workflow = parseWorkflowSource(source);
  const jobs = asMapping(workflow.jobs);
  const findings: string[] = [];
  const forbiddenStepNames = [
    "Clear Claude Code plugin marketplace path",
    "Checkout Claude Code plugin marketplace",
    "Rename pinned marketplace to a non-reserved name",
  ];

  for (const jobName of Object.keys(jobs)) {
    for (const step of jobSteps(workflow, jobName)) {
      if (
        typeof step.name === "string" &&
        forbiddenStepNames.includes(step.name)
      ) {
        findings.push(`forbidden marketplace step: ${step.name}`);
      }
      if (
        typeof step.uses === "string" &&
        step.uses.startsWith("anthropics/claude-code-action@")
      ) {
        const inputs = step.with === undefined ? {} : asMapping(step.with);
        for (const input of ["plugins", "plugin_marketplaces"]) {
          if (Object.prototype.hasOwnProperty.call(inputs, input)) {
            findings.push(`forbidden Claude action input: ${input}`);
          }
        }
      }
    }
  }

  for (const literal of [
    ".claude-marketplace",
    "claude-code-plugins",
    "roastpilot-pinned-plugins",
    "code-review@",
  ]) {
    if (source.includes(literal)) {
      findings.push(`forbidden workflow literal: ${literal}`);
    }
  }

  return findings;
}

function hasPayloadFrozenHeadBinding(source: string): boolean {
  const step = jobStep(
    parseWorkflowSource(source),
    "claude-review",
    "Compute the PR diff from trusted revisions",
  );
  return asMapping(step.env).HEAD_SHA ===
    "${{ github.event.pull_request.head.sha }}";
}

function hasPayloadFrozenBaseBinding(source: string): boolean {
  const step = jobStep(
    parseWorkflowSource(source),
    "claude-review",
    "Compute the PR diff from trusted revisions",
  );
  return asMapping(step.env).BASE_SHA ===
    "${{ github.event.pull_request.base.sha }}";
}

const INLINE_COMMENT_TOOL =
  "mcp__github_inline_comment__create_inline_comment";
const TRACKING_COMMENT_TOOL =
  "mcp__github_comment__update_claude_comment";
const ORIGINAL_DENY_TOOLS = [
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "mcp__github_file_ops__commit_files",
  "mcp__github_file_ops__delete_files",
  "Bash",
];
const READER_TOOLS = ["Read", "Glob", "Grep", "LS"];
const CI_TOOLS = [
  "mcp__github_ci__get_ci_status",
  "mcp__github_ci__get_workflow_run_details",
  "mcp__github_ci__download_job_log",
];

function claudeArgTools(
  claudeArgs: unknown,
  flag: "allowedTools" | "disallowedTools",
): string[] {
  if (typeof claudeArgs !== "string") {
    throw new Error("claude_args is not a string");
  }
  const prefix = `--${flag} "`;
  const lines = claudeArgs
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(prefix));
  if (lines.length !== 1 || !lines[0].endsWith('"')) {
    throw new Error(`claude_args must contain exactly one quoted --${flag}`);
  }
  return lines[0].slice(prefix.length, -1).split(",");
}

function deniesAllBashAndAllowsOnlyInlineComments(claudeArgs: unknown): boolean {
  const allowedTools = claudeArgTools(claudeArgs, "allowedTools");
  const disallowedTools = claudeArgTools(claudeArgs, "disallowedTools");
  return (
    allowedTools.length === 1 &&
    allowedTools[0] === INLINE_COMMENT_TOOL &&
    !allowedTools.some((tool) => tool === "Bash" || tool.startsWith("Bash(")) &&
    disallowedTools.includes("Bash")
  );
}

describe("claude-code-review workflow edited-event contract", () => {
  it("T18 admits every spec-grounding edited dimension with the non-edited short-circuit", () => {
    const expression = jobIf(parseWorkflow(), "spec-grounded-review");
    expect(expression).toBe(
      "${{ (github.event.action != 'edited' || github.event.changes.body != null || " +
        "github.event.changes.base != null || github.event.changes.title != null) && " +
        "github.actor != 'dependabot[bot]' && github.event.pull_request.head.repo.full_name == " +
        "github.repository && github.event.pull_request.draft == false }}",
    );
  });

  it("T19 admits only base edits to claude-review, excluding title/body-only edits", () => {
    const expression = jobIf(parseWorkflow(), "claude-review");
    expect(expression).toBe(
      "${{ (github.event.action != 'edited' || github.event.changes.base != null) && " +
        "github.actor != 'dependabot[bot]' && github.event.pull_request.head.repo.full_name == " +
        "github.repository && github.event.pull_request.draft == false }}",
    );
    expect(expression).not.toContain("changes.body");
    expect(expression).not.toContain("changes.title");
  });

  it("T20 retains edited in the pull_request activity types", () => {
    const workflow = parseWorkflow();
    const pullRequest = asMapping(asMapping(workflow.on).pull_request);
    expect(pullRequest.types).toEqual([
      "opened",
      "synchronize",
      "ready_for_review",
      "reopened",
      "converted_to_draft",
      "edited",
    ]);
  });

  it("T21 requires and serializes reviewed-base-sha on the false outcome branch", () => {
    const step = jobStep(
      parseWorkflow(),
      "spec-grounded-review",
      "Write the outcome marker (self-describing artifact)",
    );
    expect(asMapping(step.env).REVIEWED_BASE_SHA).toBe(
      "${{ steps.runner.outputs.reviewed-base-sha }}",
    );
    expect(step.run).toContain('[ -n "$REVIEWED_BASE_SHA" ]');
    expect(step.run).toContain('--arg reviewedBaseSha "$REVIEWED_BASE_SHA"');
    expect(step.run).toContain("reviewedBaseSha: $reviewedBaseSha");
  });
});

describe("claude-review untrusted-comment-injection guard (issue #194)", () => {
  it("T22 binds include_comments_by_actor to the PR author, not a wildcard or a blank", () => {
    // Exact-string match, not a truthy/presence check (fsr-195 mutation M2:
    // swapping this input for an inert one of equal count, e.g.
    // `label_trigger: ""`, is otherwise invisible to every existing test --
    // the D140 drift counters in workflow-execution-surface-logic.test.ts
    // only pin cardinality, not which key it is or what it's bound to). This
    // assertion fails closed on removal (the key is absent -> undefined !==
    // the expected string), on rebinding to "" or "*" (still not the
    // expected string), and on rebinding to a different context expression.
    const step = jobStep(parseWorkflow(), "claude-review", "Run Claude Code Review");
    expect(asMapping(step.with).include_comments_by_actor).toBe(
      "${{ github.event.pull_request.user.login }}",
    );
  });

  it("T23 keeps track_progress true, the precondition that makes the T22 guard live at all", () => {
    // fsr-195 mutation M10: flipping track_progress to false is invisible to
    // T22 (the input count and binding are untouched) but makes
    // include_comments_by_actor completely inert -- detectMode() only forces
    // tag mode (which reads this input via fetchGitHubData) when
    // track_progress is truthy; false falls through to agent mode, which
    // never calls fetchGitHubData at all. A reader seeing T22 green would
    // otherwise reasonably assume the filter is live.
    const step = jobStep(parseWorkflow(), "claude-review", "Run Claude Code Review");
    expect(asMapping(step.with).track_progress).toBe(true);
  });

  it("T24 allows exactly the inline-comment tool and denies all Bash subprocesses", () => {
    // PR #199 / issue #194 removed every Bash grant after #192's empirical
    // probe proved `gh pr comment --body-file /proc/self/environ` could publish
    // credentials. Pin both halves of that property: the review model gets
    // only the inline-comment MCP tool, and bare `Bash` in disallowedTools
    // denies the whole subprocess surface rather than selected commands.
    const step = jobStep(parseWorkflow(), "claude-review", "Run Claude Code Review");
    const claudeArgs = asMapping(step.with).claude_args;
    const allowedTools = claudeArgTools(claudeArgs, "allowedTools");
    const disallowedTools = claudeArgTools(claudeArgs, "disallowedTools");

    expect(allowedTools).toEqual([INLINE_COMMENT_TOOL]);
    expect(
      allowedTools.some((tool) => tool === "Bash" || tool.startsWith("Bash(")),
    ).toBe(false);
    expect(disallowedTools).toContain("Bash");
    expect(deniesAllBashAndAllowsOnlyInlineComments(claudeArgs)).toBe(true);
  });

  it("T25 rejects re-admitting the demonstrated gh-pr-comment Bash grant", () => {
    // Mutation proof: cardinality-only execution-surface tests stay green when
    // a claude_args VALUE regresses, so exercise this content guard directly.
    const step = jobStep(parseWorkflow(), "claude-review", "Run Claude Code Review");
    const claudeArgs = asMapping(step.with).claude_args;
    if (typeof claudeArgs !== "string") {
      throw new Error("claude_args is not a string");
    }
    const mutated = claudeArgs.replace(
      `--allowedTools "${INLINE_COMMENT_TOOL}"`,
      `--allowedTools "${INLINE_COMMENT_TOOL},Bash(gh pr comment:*)"`,
    );

    expect(mutated).not.toBe(claudeArgs);
    expect(deniesAllBashAndAllowsOnlyInlineComments(mutated)).toBe(false);
  });

  it("T26 denies every non-permitted SDK init tool in the captured catalog", () => {
    const fixture = parseToolCatalogFixture();
    const observedInitTools = fixtureStringArray(fixture, "observedInitTools");
    const permittedResidual = new Set(
      fixtureStringArray(fixture, "permittedResidual"),
    );
    const step = jobStep(parseWorkflow(), "claude-review", "Run Claude Code Review");
    const deniedTools = claudeArgTools(
      asMapping(step.with).claude_args,
      "disallowedTools",
    );

    for (const tool of observedInitTools.filter(
      (candidate) => !permittedResidual.has(candidate),
    )) {
      expect(deniedTools, `${tool} must be denied`).toContain(tool);
    }
  });

  it("T27 explicitly denies core readers plus egress and execution tools", () => {
    const step = jobStep(parseWorkflow(), "claude-review", "Run Claude Code Review");
    const deniedTools = claudeArgTools(
      asMapping(step.with).claude_args,
      "disallowedTools",
    );
    const egressAndExecutionTools = [
      "WebFetch",
      "WebSearch",
      "Task",
      "Skill",
      "Workflow",
    ];

    for (const tool of [...READER_TOOLS, ...egressAndExecutionTools]) {
      expect(deniedTools, `${tool} must be denied explicitly`).toContain(tool);
    }
  });

  it("T28 denies every non-permitted MCP tool in the action-computed allowlist", () => {
    const fixture = parseToolCatalogFixture();
    const computedAllowlist = fixtureStringArray(
      fixture,
      "actionComputedAllowlist",
    );
    const permittedMcpTools = new Set([
      INLINE_COMMENT_TOOL,
      TRACKING_COMMENT_TOOL,
    ]);
    const mcpToolsThatMustBeDenied = computedAllowlist.filter(
      (tool) => tool.startsWith("mcp__") && !permittedMcpTools.has(tool),
    );
    const step = jobStep(parseWorkflow(), "claude-review", "Run Claude Code Review");
    const deniedTools = claudeArgTools(
      asMapping(step.with).claude_args,
      "disallowedTools",
    );

    for (const tool of mcpToolsThatMustBeDenied) {
      expect(deniedTools, `${tool} must be denied`).toContain(tool);
    }
  });

  it("T29 preserves the tracking-comment sink and exactly one explicit allow", () => {
    const step = jobStep(parseWorkflow(), "claude-review", "Run Claude Code Review");
    const claudeArgs = asMapping(step.with).claude_args;
    const allowedTools = claudeArgTools(claudeArgs, "allowedTools");
    const deniedTools = claudeArgTools(claudeArgs, "disallowedTools");

    expect(deniedTools).not.toContain(TRACKING_COMMENT_TOOL);
    expect(allowedTools).toEqual([INLINE_COMMENT_TOOL]);
  });

  it("T30 uses only whole-tool deny names, never path- or command-scoped forms", () => {
    const step = jobStep(parseWorkflow(), "claude-review", "Run Claude Code Review");
    const deniedTools = claudeArgTools(
      asMapping(step.with).claude_args,
      "disallowedTools",
    );

    for (const tool of deniedTools) {
      expect(tool, `${tool} must be an unscoped tool name`).toMatch(
        /^[A-Za-z0-9_]+$/,
      );
    }
  });

  it("T31 byte-pins the fixture-derived complete deny grammar", () => {
    const fixture = parseToolCatalogFixture();
    const observedInitTools = fixtureStringArray(
      fixture,
      "observedInitTools",
    );
    const permittedResidual = new Set(
      fixtureStringArray(fixture, "permittedResidual"),
    );
    const expectedDenyTools = [
      ...ORIGINAL_DENY_TOOLS,
      ...READER_TOOLS,
      ...CI_TOOLS,
      ...observedInitTools
        .filter((tool) => !permittedResidual.has(tool))
        .sort(),
    ];
    const step = jobStep(parseWorkflow(), "claude-review", "Run Claude Code Review");
    const deniedTools = claudeArgTools(
      asMapping(step.with).claude_args,
      "disallowedTools",
    );

    expect(deniedTools).toEqual(expectedDenyTools);
    expect(deniedTools).not.toContain("");
    expect(new Set(deniedTools).size).toBe(deniedTools.length);
  });

  it("T32 permits only ToolSearch as a fixture-recorded residual", () => {
    const permittedResidual = fixtureStringArray(
      parseToolCatalogFixture(),
      "permittedResidual",
    );

    for (const tool of permittedResidual) {
      expect(tool).toBe("ToolSearch");
    }
  });

  it("T33 locks the captured SDK catalog to the claude-review action pin", () => {
    const step = jobStep(parseWorkflow(), "claude-review", "Run Claude Code Review");
    if (typeof step.uses !== "string") {
      throw new Error("claude-review action step has no string uses value");
    }
    const pin = step.uses.match(
      /^anthropics\/claude-code-action@([0-9a-f]{40})$/,
    );
    if (!pin) {
      throw new Error("claude-review action step is not pinned to a 40-hex SHA");
    }

    expect(parseToolCatalogFixture().actionSha).toBe(pin[1]);
  });

  it("T34 keeps steps A, C, and B strictly adjacent with step C unconditional", () => {
    const workflow = parseWorkflow();
    const steps = asMapping(asMapping(workflow.jobs)["claude-review"]).steps;
    if (!Array.isArray(steps)) {
      throw new Error("claude-review job has no steps array");
    }
    const names = steps.map((step) => asMapping(step).name);
    const stepAIndex = names.indexOf("Surface the review run's own denial evidence");
    const stepCIndex = names.indexOf("Enforce the SDK tool-catalog closure");
    const stepBIndex = names.indexOf("Assert the review actually completed");

    expect(stepAIndex).toBeGreaterThanOrEqual(0);
    expect(stepCIndex).toBe(stepAIndex + 1);
    expect(stepBIndex).toBe(stepCIndex + 1);
    const stepC = asMapping(steps[stepCIndex]);
    expect(stepC.id).toBe("catalog-closure");
    expect(stepC.if).toBe("!cancelled()");
  });

  it("T35 wires step C only to execution files, immutable policy, and diagnostic fixture", () => {
    const workflow = parseWorkflow();
    const stepA = jobStep(
      workflow,
      "claude-review",
      "Surface the review run's own denial evidence",
    );
    const stepC = jobStep(
      workflow,
      "claude-review",
      "Enforce the SDK tool-catalog closure",
    );
    const stepAEnv = asMapping(stepA.env);
    const stepCEnv = asMapping(stepC.env);

    expect(Object.keys(stepCEnv).sort()).toEqual([
      "ACTION_EXECUTION_OUTPUT",
      "FALLBACK_EXECUTION_OUTPUT",
      "PERMITTED_RESIDUAL",
      "TOOL_CATALOG_FIXTURE",
    ]);
    expect(stepCEnv.ACTION_EXECUTION_OUTPUT).toBe(
      stepAEnv.ACTION_EXECUTION_OUTPUT,
    );
    expect(stepCEnv.ACTION_EXECUTION_OUTPUT).toBe(
      "${{ steps.claude-review.outputs.execution_file }}",
    );
    expect(stepCEnv.FALLBACK_EXECUTION_OUTPUT).toBe(
      stepAEnv.FALLBACK_EXECUTION_OUTPUT,
    );
    expect(stepCEnv.FALLBACK_EXECUTION_OUTPUT).toBe(
      "${{ runner.temp }}/claude-execution-output.json",
    );
    expect(stepCEnv.TOOL_CATALOG_FIXTURE).toBe(
      "${{ github.workspace }}/tests/factory/fixtures/claude-review-sdk-tool-catalog.json",
    );
    expect(JSON.stringify(stepCEnv)).not.toMatch(/GH_TOKEN|secrets\./u);
  });

  it("T36 locks step C output names to step B's exact-string gates and its #217 sentinel conjunct", () => {
    const stepB = jobStep(
      parseWorkflow(),
      "claude-review",
      "Assert the review actually completed",
    );
    const env = asMapping(stepB.env);
    const run = String(stepB.run);

    expect(env.CATALOG_METADATA_ONLY).toBe(
      "${{ steps.catalog-closure.outputs.metadata_only }}",
    );
    expect(env.RESULT_CLEAN).toBe(
      "${{ steps.catalog-closure.outputs.result_clean }}",
    );
    expect(env.RESULT_NUM_TURNS).toBe(
      "${{ steps.catalog-closure.outputs.result_num_turns }}",
    );
    expect(env.TOOL_INVOCATIONS).toBe(
      "${{ steps.catalog-closure.outputs.tool_invocations }}",
    );
    expect(env.SUBSTANTIVE_OUTPUT).toBe(
      "${{ steps.catalog-closure.outputs.substantive_output }}",
    );
    expect(run).toContain('[ "$CATALOG_METADATA_ONLY" = "true" ]');
    expect(run).toContain('[ "$RESULT_CLEAN" = "true" ]');
    // The metadata-only accept gate opens with the two step-C conjuncts…
    expect(run).toContain(
      'if [ "$CATALOG_METADATA_ONLY" = "true" ] && [ "$RESULT_CLEAN" = "true" ]',
    );
    // …and is fail-closed by the #217 sentinel conjunct terminating the gate (a
    // regression back to the two-conjunct fail-open would break this lock).
    expect(run).toContain('&& [ "$LAST_LINE" = "$SENTINEL" ]; then');
    // The proven-inert accept is one closed five-conjunct gate. Removing any
    // conjunct widens the newly admitted outcome and breaks this byte pin.
    expect(run).toContain(
      'if [ "$CATALOG_METADATA_ONLY" = "true" ] && [ "$RESULT_CLEAN" = "true" ] \\\n' +
        '  && [ "$RESULT_NUM_TURNS" = "1" ] && [ "$TOOL_INVOCATIONS" = "0" ] \\\n' +
        '  && [ "$SUBSTANTIVE_OUTPUT" = "0" ]; then',
    );
  });

  it("T37 locks the immutable permitted residual policy to the fixture anchor", () => {
    const stepC = jobStep(
      parseWorkflow(),
      "claude-review",
      "Enforce the SDK tool-catalog closure",
    );
    const literal = asMapping(stepC.env).PERMITTED_RESIDUAL;
    if (typeof literal !== "string") {
      throw new Error("catalog-closure PERMITTED_RESIDUAL is not a string");
    }

    expect(JSON.parse(literal) as unknown).toEqual(
      fixtureStringArray(parseToolCatalogFixture(), "permittedResidual"),
    );
  });

  it("T38 pins the trusted diff step's identity, placement, and closed environment", () => {
    const workflow = parseWorkflow();
    const steps = jobSteps(workflow, "claude-review");
    const named = steps.filter(
      (step) => step.name === "Compute the PR diff from trusted revisions",
    );
    expect(named).toHaveLength(1);
    const step = named[0];
    expect(step.id).toBe("pr-diff");

    const restoreIndex = steps.findIndex(
      (candidate) => candidate.name === "Restore base-owned configuration",
    );
    const diffIndex = steps.indexOf(step);
    const actionIndex = steps.findIndex(
      (candidate) => candidate.name === "Run Claude Code Review",
    );
    expect(diffIndex).toBe(restoreIndex + 1);
    expect(diffIndex).toBeLessThan(actionIndex);
    expect(step).not.toHaveProperty("if");
    expect(step).not.toHaveProperty("continue-on-error");
    expect(asMapping(step.env)).toEqual({
      BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
      DIFF_MAX_BYTES: "65536",
    });
    const run = String(step.run);
    expect(run).not.toContain("${{");
    expect(run).not.toContain("secrets.");
    expect(run).not.toContain("GH_TOKEN");
  });

  it("T39 binds BASE_SHA and HEAD_SHA only to payload-frozen commits", () => {
    const source = readFileSync(WORKFLOW_PATH, "utf8");
    expect(hasPayloadFrozenBaseBinding(source)).toBe(true);
    expect(hasPayloadFrozenHeadBinding(source)).toBe(true);

    for (const mutant of [
      "${{ github.event.pull_request.base.ref }}",
      "${{ github.base_ref }}",
      "${{ needs.resolve-trusted-revision.outputs.trusted-sha }}",
      "${{ steps.compute-base.outputs.sha }}",
    ]) {
      const mutated = source.replace(
        "          BASE_SHA: ${{ github.event.pull_request.base.sha }}\n" +
          "          HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
        `          BASE_SHA: ${mutant}\n` +
          "          HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
      );
      expect(mutated).not.toBe(source);
      expect(hasPayloadFrozenBaseBinding(mutated), mutant).toBe(false);
    }

    for (const mutant of [
      "${{ github.event.pull_request.head.ref }}",
      "${{ github.head_ref }}",
      "${{ steps.compute-head.outputs.sha }}",
    ]) {
      const mutated = source.replace(
        "HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
        `HEAD_SHA: ${mutant}`,
      );
      expect(mutated).not.toBe(source);
      expect(hasPayloadFrozenHeadBinding(mutated), mutant).toBe(false);
    }
  });

  it("T40 injects only nonce-fenced untrusted diff data into the repo-owned prompt", () => {
    const action = jobStep(
      parseWorkflow(),
      "claude-review",
      "Run Claude Code Review",
    );
    const withInputs = asMapping(action.with);
    const prompt = String(withInputs.prompt);
    const claudeArgs = String(withInputs.claude_args);
    const appendLine = claudeArgs
      .split("\n")
      .find((line) => line.trimStart().startsWith("--append-system-prompt"));
    const sentinel = appendLine?.match(/interim update: ([^"]+)"\s*$/)?.[1];
    expect(sentinel).toBeTruthy();

    expect(prompt).toContain(
      "PR-DIFF-FENCE-${{ steps.pr-diff.outputs.nonce }}-BEGIN",
    );
    expect(prompt).toContain("${{ steps.pr-diff.outputs.diff }}");
    expect(prompt).toContain(
      "PR-DIFF-FENCE-${{ steps.pr-diff.outputs.nonce }}-END",
    );
    expect(prompt).toContain(
      "${{ steps.pr-diff.outputs.changeset_empty }}",
    );
    expect(prompt).toContain("If it is exactly `true`");
    expect(prompt).toContain("Never infer emptiness by");
    expect(prompt).not.toContain("If the diff contains");
    expect(prompt).toContain("The available tools are `ToolSearch`");
    expect(prompt).toContain("MUST use to load");
    expect(prompt).toContain("Use ToolSearch to load both sinks");
    expect(prompt).toMatch(
      /ALWAYS write\s+the tracking comment via\s+`mcp__github_comment__update_claude_comment`/u,
    );
    expect(prompt).toMatch(
      /`mcp__github_inline_comment__create_inline_comment` ONLY for an actual\s+blocker, medium, or low finding on a changed line/u,
    );
    expect(prompt).toMatch(
      /If there are no\s+findings, or `changeset_empty` is exactly `true`, post NO inline\s+comments/u,
    );
    expect(prompt).toContain(
      "Loading both sinks does not require calling the inline sink",
    );
    expect(prompt).not.toContain("then use them");
    expect(prompt).toContain(
      "Never attempt any tool beyond ToolSearch",
    );
    expect(prompt).not.toContain("The ONLY tools that exist are the inline-comment sink");
    expect(prompt).not.toContain("Never attempt to use any other tool");
    expect(prompt).toContain("mcp__github_inline_comment__create_inline_comment");
    expect(prompt).toContain("mcp__github_comment__update_claude_comment");
    expect(prompt).toContain("There is NO file");
    expect(prompt).toContain("repository, network, or subprocess access");
    for (const mustBlock of [
      "any grant to PUBLIC",
      "secure roast-by-slug and",
      "reviews-by-roast views",
      "USAGE ON PROCEDURE",
      "never `EXECUTE`",
      "containing database/schema and shared warehouse",
      "flag those prerequisite grants",
      "flag `EXECUTE` on the",
      "visibility <> 'private'",
      "differs between Zod and Pydantic",
      "does not cascade reviews, telemetry",
      "a raw IP address",
      "any Fahrenheit value or conversion",
      "login, session, or account concept reachable from /r/[slug]",
    ]) {
      expect(prompt, mustBlock).toContain(mustBlock);
    }
    expect(prompt).toContain(
      "${{ github.event.pull_request.user.login }}",
    );
    for (const factorySurfacePin of [
      "exactly `roastpilot-factory[bot]`",
      "implementing-agent patch",
      "must never grant itself more pipeline power",
      ".github/**",
      "workflows and composite actions",
      "scripts/factory/**",
      "privileged glue/publisher script",
      "CODEOWNERS",
      "branch-protection config",
      "tests/factory/**",
      ".claude/**",
      ".codex/**",
      "AGENTS.md",
      "AGENTS.override.md",
      "CLAUDE.md",
      "CLAUDE.local.md",
      ".claudeignore",
      ".mcp.json",
      ".npmrc",
      "docs/state/registry.md",
      "If the author is anyone else",
      "conventional human-directed work",
      "do not flag them on that basis",
    ]) {
      expect(prompt, factorySurfacePin).toContain(factorySurfacePin);
    }
    expect(prompt).toContain("blocker, medium, and low findings as INLINE comments");
    expect(prompt).not.toContain("/code-review:code-review");
    expect(prompt).not.toContain(sentinel);
  });

  it("T41 pins the immutable diff cap and forbids payload truncation", () => {
    const step = jobStep(
      parseWorkflow(),
      "claude-review",
      "Compute the PR diff from trusted revisions",
    );
    expect(asMapping(step.env).DIFF_MAX_BYTES).toBe("65536");
    const run = String(step.run);
    expect(run).toContain(
      'DIFF_BYTES="$(wc -c < "$DIFF_FILE" | tr -d \'[:space:]\')"',
    );
    expect(run).toContain('[ "$DIFF_BYTES" -gt "$DIFF_MAX_BYTES" ]');
    expect(run).not.toMatch(/\bhead\s+-c\b|\btruncate\b/u);
  });

  it("T42 byte-pins both nonce-derived collision sentinels", () => {
    const step = jobStep(
      parseWorkflow(),
      "claude-review",
      "Compute the PR diff from trusted revisions",
    );
    const run = String(step.run);
    expect(run).toContain('OUTPUT_DELIMITER="PRDIFF-$NONCE"');
    expect(run).toContain('FENCE_MARKER="PR-DIFF-FENCE-$NONCE"');
  });

  it("T43 removes all Claude Code marketplace machinery and rejects regressions", () => {
    const source = readFileSync(WORKFLOW_PATH, "utf8");

    expect(marketplaceMachineryFindings(source)).toEqual([]);

    const inputMutant = source.replace(
      "          show_full_output: false\n",
      [
        "          show_full_output: false",
        "          plugin_marketplaces: './.claude-marketplace'",
        "          plugins: 'code-review@roastpilot-pinned-plugins'",
        "",
      ].join("\n"),
    );
    expect(inputMutant).not.toBe(source);
    expect(marketplaceMachineryFindings(inputMutant)).toEqual(
      expect.arrayContaining([
        "forbidden Claude action input: plugins",
        "forbidden Claude action input: plugin_marketplaces",
      ]),
    );

    const stepMutant = source.replace(
      "      - name: Run Claude Code Review\n",
      [
        "      - name: Checkout Claude Code plugin marketplace",
        "        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0",
        "        with:",
        "          repository: anthropics/claude-code",
        "",
        "      - name: Run Claude Code Review",
        "",
      ].join("\n"),
    );
    expect(stepMutant).not.toBe(source);
    expect(marketplaceMachineryFindings(stepMutant)).toContain(
      "forbidden marketplace step: Checkout Claude Code plugin marketplace",
    );
  });
});
