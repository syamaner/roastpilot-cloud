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
  const document = parseDocument(readFileSync(WORKFLOW_PATH, "utf8"));
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
});
