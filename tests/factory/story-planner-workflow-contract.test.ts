import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/story-planner.yml", import.meta.url),
);
const CLOSURE_STEP = "Enforce the SDK tool-catalog closure";
const UPLOAD_STEP = "Upload story-planner contract";

type Mapping = Record<string, unknown>;

function asMapping(value: unknown): Mapping | undefined {
  return typeof value === "object" && value !== null ? (value as Mapping) : undefined;
}

function planSteps(): Mapping[] {
  const document = parseDocument(readFileSync(WORKFLOW_PATH, "utf8"));
  expect(document.errors).toEqual([]);
  const workflow = document.toJS() as Mapping;
  const steps = asMapping(asMapping(workflow.jobs)?.plan)?.steps;
  if (!Array.isArray(steps)) {
    throw new Error("story-planner plan job has no steps");
  }
  return steps.map((step) => asMapping(step) ?? {});
}

function closureStep(): Mapping {
  const step = planSteps().find((candidate) => candidate.name === CLOSURE_STEP);
  if (!step) {
    throw new Error("story-planner closure step is missing");
  }
  return step;
}

function runClosure(transcript: readonly unknown[]): ReturnType<typeof spawnSync> {
  const workdir = mkdtempSync(join(tmpdir(), "story-planner-closure-"));
  const executionPath = join(workdir, "execution.json");
  try {
    writeFileSync(executionPath, JSON.stringify(transcript));
    return spawnSync("bash", ["-c", String(closureStep().run)], {
      cwd: workdir,
      encoding: "utf8",
      env: {
        ...process.env,
        ACTION_EXECUTION_OUTPUT: executionPath,
        FALLBACK_EXECUTION_OUTPUT: join(workdir, "missing.json"),
        PERMITTED_RESIDUAL: '["Read","Grep","Glob","LS","ToolSearch","Edit"]',
      },
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

const INIT = { type: "system", subtype: "init", tools: ["Read"] };
const CLEAN_RESULT = {
  type: "result",
  is_error: false,
  subtype: "success",
  num_turns: 1,
};

describe("story-planner workflow completion gate", () => {
  it("accepts exactly one clean terminal result", () => {
    const result = runClosure([INIT, CLEAN_RESULT]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it.each([
    ["missing is_error", { ...CLEAN_RESULT, is_error: undefined }],
    ["string is_error", { ...CLEAN_RESULT, is_error: "false" }],
    ["error result", { ...CLEAN_RESULT, is_error: true }],
    ["failure subtype", { ...CLEAN_RESULT, subtype: "error_during_execution" }],
    ["missing num_turns", { ...CLEAN_RESULT, num_turns: undefined }],
    ["malformed permission_denials_count", { ...CLEAN_RESULT, permission_denials_count: "0" }],
    ["nonzero permission_denials_count", { ...CLEAN_RESULT, permission_denials_count: 1 }],
    ["malformed permission_denials", { ...CLEAN_RESULT, permission_denials: null }],
    ["nonempty permission_denials", { ...CLEAN_RESULT, permission_denials: ["Read denied"] }],
  ])("rejects a terminal result with %s", (_label, resultRecord) => {
    const result = runClosure([INIT, resultRecord]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
  });

  it("rejects a denied tool_result even when the terminal result is clean", () => {
    const deniedToolResult = {
      type: "user",
      message: {
        content: [{ type: "tool_result", is_error: true }],
      },
    };
    const result = runClosure([INIT, deniedToolResult, CLEAN_RESULT]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
  });

  it("rejects duplicate terminal results", () => {
    const result = runClosure([INIT, CLEAN_RESULT, CLEAN_RESULT]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
  });

  it("rejects an execution with no terminal result", () => {
    const result = runClosure([INIT]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(1);
  });

  it("keeps the fail-closed closure ahead of a default-success upload", () => {
    const steps = planSteps();
    const closureIndex = steps.findIndex((step) => step.name === CLOSURE_STEP);
    const uploadIndex = steps.findIndex((step) => step.name === UPLOAD_STEP);
    const closure = steps[closureIndex];
    const upload = steps[uploadIndex];

    expect(closureIndex).toBeGreaterThanOrEqual(0);
    expect(uploadIndex).toBe(closureIndex + 1);
    expect(closure?.if).toBe("!cancelled()");
    expect(upload).not.toHaveProperty("if");
    expect(String(closure?.run)).toContain('select(.type == "result")');
    expect(String(closure?.run)).toContain('.num_turns | type');
    expect(String(closure?.run)).toContain('.type == "tool_result"');
    expect(String(closure?.run)).toContain('.is_error != false');
  });
});
