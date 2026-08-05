import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/claude-code-review.yml", import.meta.url),
);
const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/claude-review-sdk-tool-catalog.json", import.meta.url),
);

type Mapping = Record<string, unknown>;

interface StepCResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly summary: string;
  readonly outputText: string;
  readonly outputs: Readonly<Record<string, string>>;
}

const CLEAN_TRANSCRIPT: readonly unknown[] = [
  { type: "system", subtype: "init", tools: ["ToolSearch"] },
  {
    type: "result",
    is_error: false,
    subtype: "success",
    num_turns: 1,
  },
];

function asMapping(value: unknown): Mapping | undefined {
  return typeof value === "object" && value !== null
    ? (value as Mapping)
    : undefined;
}

function stepCDefinition(): Mapping {
  const document = parseDocument(readFileSync(WORKFLOW_PATH, "utf8"));
  expect(document.errors).toEqual([]);
  const workflow = document.toJS() as Mapping;
  const job = asMapping(asMapping(workflow.jobs)?.["claude-review"]);
  const steps = job?.steps;
  if (!Array.isArray(steps)) {
    throw new Error("claude-review job has no steps");
  }
  const step = steps.find(
    (candidate) =>
      asMapping(candidate)?.name === "Enforce the SDK tool-catalog closure",
  );
  if (!step) {
    throw new Error("missing catalog-closure step");
  }
  return asMapping(step) ?? {};
}

function stepCRun(): string {
  return String(stepCDefinition().run);
}

function stepCPermittedResidual(): string {
  const value = asMapping(stepCDefinition().env)?.PERMITTED_RESIDUAL;
  if (typeof value !== "string") {
    throw new Error("catalog-closure step has no PERMITTED_RESIDUAL literal");
  }
  return value;
}

function parseOutputs(text: string): Readonly<Record<string, string>> {
  const outputs: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const separator = line.indexOf("=");
    if (separator > 0) {
      outputs[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
  return outputs;
}

function runStepC(options: {
  readonly actionFile: string;
  readonly fallbackFile?: string;
  readonly fixtureFile?: string;
  readonly permittedResidual?: string;
}): StepCResult {
  const workdir = mkdtempSync(join(tmpdir(), "review-step-c-"));
  const summaryPath = join(workdir, "step-summary");
  const outputPath = join(workdir, "step-output");
  try {
    writeFileSync(summaryPath, "");
    writeFileSync(outputPath, "");
    const result = spawnSync("bash", ["-c", stepCRun()], {
      cwd: workdir,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        ACTION_EXECUTION_OUTPUT: options.actionFile,
        FALLBACK_EXECUTION_OUTPUT:
          options.fallbackFile ?? join(workdir, "no-fallback.json"),
        TOOL_CATALOG_FIXTURE: options.fixtureFile ?? FIXTURE_PATH,
        PERMITTED_RESIDUAL:
          options.permittedResidual ?? stepCPermittedResidual(),
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
    });
    const outputText = readFileSync(outputPath, "utf8");
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      summary: readFileSync(summaryPath, "utf8"),
      outputText,
      outputs: parseOutputs(outputText),
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

function runStepCWith(
  transcript: unknown,
  fixture?: unknown,
  permittedResidual?: string,
): StepCResult {
  const workdir = mkdtempSync(join(tmpdir(), "review-step-c-input-"));
  const executionPath = join(workdir, "execution-output.json");
  const fixturePath = join(workdir, "tool-catalog.json");
  try {
    writeFileSync(
      executionPath,
      typeof transcript === "string" ? transcript : JSON.stringify(transcript),
    );
    if (fixture !== undefined) {
      writeFileSync(
        fixturePath,
        typeof fixture === "string" ? fixture : JSON.stringify(fixture),
      );
    }
    return runStepC({
      actionFile: executionPath,
      ...(fixture === undefined ? {} : { fixtureFile: fixturePath }),
      ...(permittedResidual === undefined ? {} : { permittedResidual }),
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

function fixtureWith(overrides: Mapping): Mapping {
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Mapping;
  return { ...fixture, ...overrides };
}

describe("claude-review SDK tool-catalog closure (step C)", () => {
  it("SC-T1: accepts a clean transcript and writes both true outputs", () => {
    const result = runStepCWith(CLEAN_TRANSCRIPT);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.outputs).toMatchObject({
      metadata_only: "true",
      result_clean: "true",
    });
    expect(result.stdout).toContain("SDK tool-catalog closure holds");
  });

  it("SC-T2: rejects an unknown init tool name", () => {
    const result = runStepCWith([
      { type: "system", subtype: "init", tools: ["SomeNewTool"] },
      CLEAN_TRANSCRIPT[1],
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("unknown tool name outside the permitted residual");
    expect(result.outputs.metadata_only).toBe("false");
  });

  it("SC-T3: classifies a denied tool's reappearance as a mechanism flip", () => {
    const result = runStepCWith([
      { type: "system", subtype: "init", tools: ["Task"] },
      CLEAN_TRANSCRIPT[1],
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("denied tool reappeared");
    expect(result.stdout).toContain("deny mechanism flip");
    expect(result.stdout).not.toContain("unknown tool name");
  });

  it("SC-T4: unions tools across every top-level init record", () => {
    const result = runStepCWith([
      CLEAN_TRANSCRIPT[0],
      { type: "system", subtype: "init", tools: ["Task"] },
      CLEAN_TRANSCRIPT[1],
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("deny mechanism flip");
  });

  it("SC-T5: fails closed when both execution-file paths are absent", () => {
    const result = runStepC({
      actionFile: join(tmpdir(), "absent-step-c-action.json"),
      fallbackFile: join(tmpdir(), "absent-step-c-fallback.json"),
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("execution output is missing");
  });

  it("SC-T6: rejects unparseable JSON without leaking transcript bytes", () => {
    const marker = "LEAK_MARKER_SENSITIVE_XYZ";
    const result = runStepCWith(`not-json ${marker} ghp_UNPARSEABLE111122223333`);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("not parseable JSON");
    expect(result.stdout).not.toContain(marker);
    expect(result.summary).not.toContain(marker);
    expect(result.stdout).not.toContain("ghp_UNPARSEABLE");
  });

  it("SC-T7: rejects zero top-level init records", () => {
    const result = runStepCWith([CLEAN_TRANSCRIPT[1]]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("no top-level system/init record");
  });

  it("SC-T8: rejects an init record with absent .tools", () => {
    const result = runStepCWith([
      { type: "system", subtype: "init" },
      CLEAN_TRANSCRIPT[1],
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("must carry a .tools array");
  });

  it("SC-T9: rejects a string-valued .tools field", () => {
    const result = runStepCWith([
      { type: "system", subtype: "init", tools: "ToolSearch" },
      CLEAN_TRANSCRIPT[1],
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("must carry a .tools array");
  });

  it.each([42, { name: "ToolSearch" }])(
    "SC-T10: rejects a non-string .tools element (%j)",
    (hostileElement) => {
      const result = runStepCWith([
        {
          type: "system",
          subtype: "init",
          tools: ["ToolSearch", hostileElement],
        },
        CLEAN_TRANSCRIPT[1],
      ]);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("must carry a .tools array");
    },
  );

  it("SC-T12: compares raw names and prints only redacted forms", () => {
    const newline = String.fromCharCode(10);
    const zeroWidth = String.fromCharCode(0x200b);
    const forgedHeading = `evil${newline}## injected heading`;
    const nearToolSearch = `ToolSearch${zeroWidth}`;
    const result = runStepCWith([
      {
        type: "system",
        subtype: "init",
        tools: ["ToolSearch", forgedHeading, nearToolSearch, "my_token_helper"],
      },
      CLEAN_TRANSCRIPT[1],
    ]);
    expect(result.status).toBe(1);
    for (const emission of [result.stdout, result.summary]) {
      expect(emission).toContain("[redacted non-conforming tool name]");
      expect(emission).toContain("[redacted sensitive-looking string]");
      expect(emission).not.toContain("## injected heading");
      expect(emission).not.toContain(zeroWidth);
      expect(emission).not.toContain("my_token_helper");
    }
  });

  it("SC-T12b: rejects a sole near-ToolSearch name before redaction", () => {
    const zeroWidth = String.fromCharCode(0x200b);
    const nearToolSearch = `ToolSearch${zeroWidth}`;
    const result = runStepCWith([
      {
        type: "system",
        subtype: "init",
        tools: [nearToolSearch],
      },
      CLEAN_TRANSCRIPT[1],
    ]);
    expect(result.status).toBe(1);
    expect(result.outputs.metadata_only).toBe("false");
    const expectedDiagnostic =
      "unknown tool name outside the permitted residual: [redacted non-conforming tool name]";
    for (const emission of [result.stdout, result.summary]) {
      const offenderLines = emission
        .split("\n")
        .filter((line) => line.startsWith("unknown tool name outside"));
      expect(offenderLines).toEqual([expectedDiagnostic]);
      expect(emission).not.toContain(zeroWidth);
    }
  });

  it("SC-T13: binds init evidence to top-level SDK records", () => {
    const forgedDenied = runStepCWith([
      CLEAN_TRANSCRIPT[0],
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              input: { type: "system", subtype: "init", tools: ["Bash"] },
            },
          ],
        },
      },
      CLEAN_TRANSCRIPT[1],
    ]);
    expect(forgedDenied.status, forgedDenied.stderr).toBe(0);

    const forgedCleanOnly = runStepCWith([
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              input: CLEAN_TRANSCRIPT[0],
            },
          ],
        },
      },
      CLEAN_TRANSCRIPT[1],
    ]);
    expect(forgedCleanOnly.status).toBe(1);
    expect(forgedCleanOnly.stdout).toContain("no top-level system/init record");
  });

  it("SC-T14: is_error true withholds result cleanliness without failing closure", () => {
    const result = runStepCWith([
      CLEAN_TRANSCRIPT[0],
      { type: "result", is_error: true, subtype: "success" },
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.outputs).toMatchObject({
      metadata_only: "true",
      result_clean: "false",
    });
  });

  it("SC-T15: an error subtype withholds result cleanliness", () => {
    const result = runStepCWith([
      CLEAN_TRANSCRIPT[0],
      { type: "result", is_error: false, subtype: "error_during_execution" },
    ]);
    expect(result.status).toBe(0);
    expect(result.outputs.result_clean).toBe("false");
  });

  it("SC-T16: no result record withholds result cleanliness", () => {
    const result = runStepCWith([CLEAN_TRANSCRIPT[0]]);
    expect(result.status).toBe(0);
    expect(result.outputs.result_clean).toBe("false");
  });

  it("SC-T17: duplicated clean result records withhold result cleanliness", () => {
    const result = runStepCWith([
      CLEAN_TRANSCRIPT[0],
      CLEAN_TRANSCRIPT[1],
      CLEAN_TRANSCRIPT[1],
    ]);
    expect(result.status).toBe(0);
    expect(result.outputs.result_clean).toBe("false");
  });

  it("SC-T18: string is_error false withholds result cleanliness", () => {
    const result = runStepCWith([
      CLEAN_TRANSCRIPT[0],
      { type: "result", is_error: "false", subtype: "success" },
    ]);
    expect(result.status).toBe(0);
    expect(result.outputs.result_clean).toBe("false");
  });

  it("SC-T19: writes deterministic outputs before a failing closure verdict", () => {
    const result = runStepCWith([
      { type: "system", subtype: "init", tools: ["SomeNewTool"] },
      CLEAN_TRANSCRIPT[1],
    ]);
    expect(result.status).toBe(1);
    expect(result.outputText).toContain("metadata_only=false\n");
    expect(result.outputs).toMatchObject({
      metadata_only: "false",
      result_clean: "true",
    });
  });

  it("SC-T20: bounds adversarial diagnostic volume", () => {
    const tools = Array.from(
      { length: 5000 },
      (_, index) => `unknown_tool_${String(index).padStart(6, "0")}`,
    );
    const result = runStepCWith([
      { type: "system", subtype: "init", tools },
      CLEAN_TRANSCRIPT[1],
    ]);
    expect(result.status).toBe(1);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(65537);
    expect(Buffer.byteLength(result.summary, "utf8")).toBeLessThanOrEqual(
      65536 + 64,
    );
    expect(result.stdout).not.toContain("unknown_tool_004999");
  });

  it.each([
    ["unparseable", "not json LEAK_FIXTURE_BYTES"],
    [
      "ill-shaped observedInitTools",
      fixtureWith({ observedInitTools: "LEAK_FIXTURE_BYTES" }),
    ],
  ])(
    "SC-T21: rejects an invalid diagnostic fixture (%s) without echoing bytes",
    (_name, fixture) => {
      const result = runStepCWith(CLEAN_TRANSCRIPT, fixture);
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("tool-catalog fixture is missing");
      expect(result.stdout).not.toContain("LEAK_FIXTURE_BYTES");
      expect(result.summary).not.toContain("LEAK_FIXTURE_BYTES");
    },
  );

  it.each([
    ["unparseable", "not json LEAK_LITERAL_BYTES"],
    ["empty", "[]"],
    ["non-conforming", '["Tool Search LEAK_LITERAL_BYTES"]'],
  ])(
    "SC-T21: rejects an invalid immutable residual (%s) without echoing bytes",
    (_name, permittedResidual) => {
      const result = runStepCWith(
        CLEAN_TRANSCRIPT,
        undefined,
        permittedResidual,
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("immutable permitted residual policy");
      expect(result.stdout).not.toContain("LEAK_LITERAL_BYTES");
      expect(result.summary).not.toContain("LEAK_LITERAL_BYTES");
    },
  );

  it("SC-T21: rejects a missing fixture", () => {
    const workdir = mkdtempSync(join(tmpdir(), "missing-step-c-fixture-"));
    const executionPath = join(workdir, "execution.json");
    try {
      writeFileSync(executionPath, JSON.stringify(CLEAN_TRANSCRIPT));
      const result = runStepC({
        actionFile: executionPath,
        fixtureFile: join(workdir, "absent-fixture.json"),
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("tool-catalog fixture is missing");
    } finally {
      rmSync(workdir, { recursive: true, force: true });
    }
  });

  it("SC-T22: rejects a sole init record with an empty tool catalog", () => {
    const result = runStepCWith([
      { type: "system", subtype: "init", tools: [] },
      CLEAN_TRANSCRIPT[1],
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("empty .tools array");
    expect(result.outputs.metadata_only).toBe("false");
  });

  it("SC-T23: rejects an empty union across multiple init records", () => {
    const result = runStepCWith([
      { type: "system", subtype: "init", tools: [] },
      { type: "system", subtype: "init", tools: [] },
      CLEAN_TRANSCRIPT[1],
    ]);
    expect(result.status).toBe(1);
    expect(result.outputs.metadata_only).toBe("false");
  });

  it("SC-T24: denial-bearing success is not a clean result", () => {
    const result = runStepCWith([
      CLEAN_TRANSCRIPT[0],
      {
        type: "result",
        is_error: false,
        subtype: "success",
        permission_denials_count: 4,
        permission_denials: [
          { tool_name: "Read" },
          { tool_name: "Bash" },
          { tool_name: "WebFetch" },
          { tool_name: "Grep" },
        ],
      },
    ]);
    expect(result.status).toBe(0);
    expect(result.outputs).toMatchObject({
      metadata_only: "true",
      result_clean: "false",
    });
  });

  it("SC-T25: a non-empty denial array alone is not a clean result", () => {
    const result = runStepCWith([
      CLEAN_TRANSCRIPT[0],
      {
        type: "result",
        is_error: false,
        subtype: "success",
        permission_denials: [{ tool_name: "Read" }],
      },
    ]);
    expect(result.status).toBe(0);
    expect(result.outputs.result_clean).toBe("false");
  });

  it("SC-T26: explicit zero denials preserve a clean result", () => {
    const result = runStepCWith([
      CLEAN_TRANSCRIPT[0],
      {
        type: "result",
        is_error: false,
        subtype: "success",
        permission_denials_count: 0,
        permission_denials: [],
        num_turns: 1,
      },
    ]);
    expect(result.status).toBe(0);
    expect(result.outputs.result_clean).toBe("true");
  });

  it("SC-T27: a false denial count fails closed", () => {
    const result = runStepCWith([
      CLEAN_TRANSCRIPT[0],
      {
        type: "result",
        is_error: false,
        subtype: "success",
        permission_denials_count: false,
      },
    ]);
    expect(result.status).toBe(0);
    expect(result.outputs.result_clean).toBe("false");
  });

  it("SC-T28: a false denial collection fails closed", () => {
    const result = runStepCWith([
      CLEAN_TRANSCRIPT[0],
      {
        type: "result",
        is_error: false,
        subtype: "success",
        permission_denials: false,
      },
    ]);
    expect(result.status).toBe(0);
    expect(result.outputs.result_clean).toBe("false");
  });

  it("SC-T29: a flagged tool_result prevents a clean result", () => {
    const result = runStepCWith([
      CLEAN_TRANSCRIPT[0],
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-use-1",
              is_error: true,
              content: "permission denied",
            },
          ],
        },
      },
      { type: "result", is_error: false, subtype: "success" },
    ]);
    expect(result.status).toBe(0);
    expect(result.outputs.result_clean).toBe("false");
  });

  it("SC-T30: malformed tool_result error state fails closed", () => {
    const result = runStepCWith([
      CLEAN_TRANSCRIPT[0],
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-use-1",
              is_error: "true",
              content: "permission denied",
            },
          ],
        },
      },
      { type: "result", is_error: false, subtype: "success" },
    ]);
    expect(result.status).toBe(0);
    expect(result.outputs.result_clean).toBe("false");
  });

  it("SC-T31: a successful tool_result preserves a clean result", () => {
    const result = runStepCWith([
      CLEAN_TRANSCRIPT[0],
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool-use-1",
              is_error: false,
              content: "ok",
            },
          ],
        },
      },
      { type: "result", is_error: false, subtype: "success" },
    ]);
    expect(result.status).toBe(0);
    expect(result.outputs.result_clean).toBe("true");
  });
});
