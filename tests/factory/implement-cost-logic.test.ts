import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_COST_USD,
  MAX_TURNS_CAP,
  parseImplementCost,
  validateImplementCostOutputs,
} from "../../scripts/factory/implement-cost-logic.mts";

const EXTRACTOR_PATH = fileURLToPath(
  new URL("../../scripts/factory/extract-implement-cost.mts", import.meta.url),
);
const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/claude-execution-output-4-denials.json", import.meta.url),
);

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function result(total_cost_usd: unknown, num_turns: unknown): unknown[] {
  return [{ type: "result", total_cost_usd, num_turns }];
}

function runExtractor(
  executionContent?: string,
  absentFile = false,
  preexistingCostFile = false,
  plantedOutputDirectorySymlink = false,
) {
  const cwd = mkdtempSync(join(tmpdir(), "implement-cost-"));
  temporaryDirectories.push(cwd);
  const outputPath = join(cwd, "github-output.txt");
  const summaryPath = join(cwd, "step-summary.md");
  const executionPath = join(cwd, "execution.json");
  const costOutputDirectory = join(cwd, "runner-temp", "implement-cost");
  if (executionContent !== undefined && !absentFile) {
    writeFileSync(executionPath, executionContent);
  }
  if (preexistingCostFile) {
    mkdirSync(costOutputDirectory, { recursive: true });
    writeFileSync(
      join(costOutputDirectory, "cost.json"),
      "agent-controlled stale bytes\n",
    );
  }
  if (plantedOutputDirectorySymlink) {
    mkdirSync(join(cwd, "runner-temp"), { recursive: true });
    symlinkSync(cwd, costOutputDirectory, "dir");
  }
  const env = {
    ...process.env,
    GITHUB_OUTPUT: outputPath,
    GITHUB_STEP_SUMMARY: summaryPath,
    INPUT_COST_OUTPUT_DIR: costOutputDirectory,
    ...(executionContent === undefined
      ? { INPUT_EXECUTION_FILE: undefined }
      : { INPUT_EXECUTION_FILE: executionPath }),
  };
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", EXTRACTOR_PATH],
    { cwd, env, encoding: "utf8" },
  );
  return {
    run,
    output: readFileSync(outputPath, "utf8"),
    summary: readFileSync(summaryPath, "utf8"),
    artifact: readFileSync(join(costOutputDirectory, "cost.json"), "utf8"),
    repositoryCostExists: existsSync(join(cwd, "cost.json")),
  };
}

describe("parseImplementCost", () => {
  it("B1: accepts the observed implement run and repository fixture", () => {
    expect(parseImplementCost(result(2.9373, 62))).toEqual({
      costUsd: "2.9373",
      numTurns: "62",
    });
    const fixture: unknown = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    expect(parseImplementCost(fixture)).toEqual({
      costUsd: "1.80123505",
      numTurns: "25",
    });
  });

  it("B2: accepts zero for both fields", () => {
    expect(parseImplementCost(result(0, 0))).toEqual({
      costUsd: "0",
      numTurns: "0",
    });
  });

  it.each([1e-7, 1e3])(
    "B3: formats %s canonically without an exponent",
    (cost) => {
      const parsed = parseImplementCost(result(cost, 1));
      expect(parsed.costUsd).not.toMatch(/[eE]/);
      expect(parsed.costUsd).toMatch(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
    },
  );

  it("N4: rejects a non-array", () => {
    expect(parseImplementCost({ type: "result" })).toEqual({
      costUsd: "",
      numTurns: "",
    });
  });

  it("N5/G3: rejects an array with zero result records", () => {
    expect(parseImplementCost([{ type: "assistant" }])).toEqual({
      costUsd: "",
      numTurns: "",
    });
  });

  it("N6/G3: rejects an array with two result records", () => {
    expect(
      parseImplementCost([
        ...result(1, 1),
        ...result(2, 2),
      ]),
    ).toEqual({ costUsd: "", numTurns: "" });
  });

  it("N7/G1/G5: rejects a string cost and never echoes its injection bytes", () => {
    const raw = "0\n\n@codex review";
    const pureOutput = JSON.stringify(parseImplementCost(result(raw, 1)));
    expect(pureOutput).not.toContain(raw);
    expect(pureOutput).not.toContain("@codex review");

    const extracted = runExtractor(JSON.stringify(result(raw, 1)));
    expect(extracted.run.status).toBe(0);
    const everyOutput = [
      extracted.run.stdout,
      extracted.run.stderr,
      extracted.output,
      extracted.summary,
      extracted.artifact,
    ].join("\n");
    expect(everyOutput).not.toContain(raw);
    expect(everyOutput).not.toContain("@codex review");
    expect(extracted.output).toContain("cost_usd=\n");
  });

  it.each([NaN, Infinity, -Infinity, -1, MAX_COST_USD + 0.01])(
    "N8/G1: rejects invalid cost %s",
    (cost) => {
      expect(parseImplementCost(result(cost, 1)).costUsd).toBe("");
    },
  );

  it.each([1.5, "1", -1, MAX_TURNS_CAP + 1])(
    "N9/G2: rejects invalid num_turns %j",
    (turns) => {
      expect(parseImplementCost(result(1, turns)).numTurns).toBe("");
    },
  );

  it("N10/G4: rejects both fields when only one validates", () => {
    for (const input of [result(1, "bad"), result("bad", 5)]) {
      expect(parseImplementCost(input)).toEqual({
        costUsd: "",
        numTurns: "",
      });
    }
  });

  it("G9-round-trip: rejects regex-valid but non-canonical publisher values", () => {
    expect(validateImplementCostOutputs("1.0", "5")).toBeNull();
    expect(validateImplementCostOutputs("1.50000000", "5")).toBeNull();
  });
});

describe("extract-implement-cost entrypoint", () => {
  it("N1: missing INPUT_EXECUTION_FILE is unavailable and exits zero", () => {
    const extracted = runExtractor();
    expect(extracted.run.status).toBe(0);
    expect(extracted.output).toBe("cost_usd=\nnum_turns=\n");
    expect(extracted.summary).toBe("Implement run cost: unavailable\n");
    expect(JSON.parse(extracted.artifact)).toEqual({
      cost_usd: null,
      num_turns: null,
    });
  });

  it("N2: absent execution file is unavailable and exits zero", () => {
    const extracted = runExtractor("unused", true);
    expect(extracted.run.status).toBe(0);
    expect(extracted.output).toBe("cost_usd=\nnum_turns=\n");
    expect(extracted.summary).toContain("unavailable");
  });

  it("N3: unparseable execution file is unavailable and exits zero", () => {
    const extracted = runExtractor("{not-json");
    expect(extracted.run.status).toBe(0);
    expect(extracted.output).toBe("cost_usd=\nnum_turns=\n");
    expect(extracted.artifact).toBe(
      '{"cost_usd":null,"num_turns":null}\n',
    );
  });

  it("writes only validated scalars to outputs, summary, and cost.json", () => {
    const extracted = runExtractor(
      JSON.stringify(result(2.9373, 62)),
      false,
      true,
    );
    expect(extracted.run.status).toBe(0);
    expect(extracted.output).toBe("cost_usd=2.9373\nnum_turns=62\n");
    expect(extracted.summary).toBe(
      "Implement run cost: $2.9373 USD across 62 turns\n",
    );
    expect(JSON.parse(extracted.artifact)).toEqual({
      cost_usd: 2.9373,
      num_turns: 62,
    });
    expect(extracted.repositoryCostExists).toBe(false);

    const tiny = runExtractor(JSON.stringify(result(1e-7, 1)));
    expect(tiny.output).toContain("cost_usd=0.0000001\n");
    expect(tiny.artifact).toBe(
      '{"cost_usd":0.0000001,"num_turns":1}\n',
    );
    expect(tiny.artifact).not.toMatch(/[eE]/);
  });

  it("F1: replaces an agent-planted output-directory symlink before writing", () => {
    const extracted = runExtractor(
      JSON.stringify(result(2.9373, 62)),
      false,
      false,
      true,
    );
    expect(extracted.run.status).toBe(0);
    expect(extracted.repositoryCostExists).toBe(false);
    expect(JSON.parse(extracted.artifact)).toEqual({
      cost_usd: 2.9373,
      num_turns: 62,
    });
  });
});
