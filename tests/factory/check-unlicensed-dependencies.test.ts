import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";
import {
  assertNoUnlicensedDependencies,
  formatUnlicensedDependencyReport,
  main,
  MAX_INVALID_LICENSE_CHANGES_BYTES,
  parseUnlicensedDependencies,
  runCli,
  type UnlicensedDependency,
} from "../../scripts/factory/check-unlicensed-dependencies.mts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const WORKFLOW_PATH = join(
  REPOSITORY_ROOT,
  ".github",
  "workflows",
  "dependency-review.yml",
);
const WORKFLOW_CONTENT = readFileSync(WORKFLOW_PATH, "utf8");
const DEPENDENCY_REVIEW_ACTION =
  "actions/dependency-review-action@a1d282b36b6f3519aa1f3fc636f609c47dddb294";
const SETUP_NODE_ACTION =
  "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const CHECK_COMMAND =
  "node --experimental-strip-types scripts/factory/check-unlicensed-dependencies.mts";
const OUTPUT_EXPRESSION =
  "${{ steps.dependency-review.outputs.invalid-license-changes }}";
const ENTRYPOINT_PATH = join(
  REPOSITORY_ROOT,
  "scripts",
  "factory",
  "check-unlicensed-dependencies.mts",
);

type Mapping = Record<string, unknown>;

interface ActionDependency {
  readonly change_type: "added";
  readonly manifest: string;
  readonly ecosystem: string;
  readonly name: string;
  readonly version: string;
  readonly package_url: string;
  readonly license: null | "NOASSERTION";
  readonly source_repository_url: string | null;
  readonly scope: "runtime" | "development" | "unknown";
  readonly vulnerabilities: readonly unknown[];
}

function dependency(
  overrides: Partial<ActionDependency> = {},
): ActionDependency {
  return {
    change_type: "added",
    manifest: "package-lock.json",
    ecosystem: "npm",
    name: "unknown-license-package",
    version: "1.2.3",
    package_url: "pkg:npm/unknown-license-package@1.2.3",
    license: null,
    source_repository_url: null,
    scope: "runtime",
    vulnerabilities: [],
    ...overrides,
  };
}

function actionOutput(unlicensed: readonly unknown[]): string {
  return JSON.stringify({
    unlicensed,
    unresolved: [],
    forbidden: [],
  });
}

function asMapping(value: unknown): Mapping | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Mapping)
    : undefined;
}

function namedSteps(steps: unknown[], name: string): Mapping[] {
  return steps
    .map(asMapping)
    .filter((step): step is Mapping => step?.name === name);
}

function hasOwn(record: Mapping | undefined, key: string): boolean {
  return (
    record !== undefined &&
    Object.prototype.hasOwnProperty.call(record, key)
  );
}

function hasInput(record: Mapping | undefined, input: string): boolean {
  const expectedEnvironmentName = `INPUT_${input.replace(/ /g, "_").toUpperCase()}`;
  return Object.keys(record ?? {}).some(
    (key) =>
      `INPUT_${key.replace(/ /g, "_").toUpperCase()}` ===
      expectedEnvironmentName,
  );
}

function runEntrypoint(rawOutput: string | undefined) {
  const env = { ...process.env };
  if (rawOutput === undefined) {
    delete env.INVALID_LICENSE_CHANGES;
  } else {
    env.INVALID_LICENSE_CHANGES = rawOutput;
  }
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", ENTRYPOINT_PATH],
    {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      env,
    },
  );
}

function validateDependencyReviewWorkflow(workflow: string): string[] {
  const document = parseDocument(workflow);
  if (document.errors.length > 0) {
    return ["workflow must be valid YAML"];
  }
  const root = asMapping(document.toJS({ maxAliasCount: 100 }));
  const jobs = asMapping(root?.jobs);
  const job = asMapping(jobs?.["dependency-review"]);
  const steps = Array.isArray(job?.steps) ? job.steps : [];
  const setupSteps = namedSteps(steps, "Set up Node");
  const reviewSteps = namedSteps(steps, "Dependency Review");
  const checkSteps = namedSteps(
    steps,
    "Fail on undetected dependency licenses",
  );
  const setupStep = setupSteps[0];
  const reviewStep = reviewSteps[0];
  const checkStep = checkSteps[0];
  const setupWith = asMapping(setupStep?.with);
  const reviewWith = asMapping(reviewStep?.with);
  const checkEnv = asMapping(checkStep?.env);
  const failures: string[] = [];

  if (hasOwn(job, "if") || hasOwn(job, "continue-on-error")) {
    failures.push("dependency-review job must always fail closed");
  }
  if (
    setupSteps.length !== 1 ||
    reviewSteps.length !== 1 ||
    checkSteps.length !== 1
  ) {
    failures.push(
      "Node setup, dependency review, and unknown-license check must be unique",
    );
  }
  if (
    setupStep?.uses !== SETUP_NODE_ACTION ||
    setupWith?.["node-version"] !== "22"
  ) {
    failures.push("unknown-license check must use the pinned Node runtime");
  }
  if (
    reviewStep?.uses !== DEPENDENCY_REVIEW_ACTION ||
    reviewStep.id !== "dependency-review"
  ) {
    failures.push("dependency review must expose the pinned action output");
  }
  if (
    hasOwn(setupStep, "if") ||
    hasOwn(setupStep, "continue-on-error") ||
    hasOwn(reviewStep, "if") ||
    hasOwn(reviewStep, "continue-on-error") ||
    hasOwn(checkStep, "if") ||
    hasOwn(checkStep, "continue-on-error")
  ) {
    failures.push("dependency review and unknown-license check must always fail closed");
  }
  if (
    hasInput(reviewWith, "allow-dependencies-licenses") ||
    hasInput(reviewWith, "config-file")
  ) {
    failures.push("unknown-license exceptions must remain disabled");
  }
  if (checkEnv?.INVALID_LICENSE_CHANGES !== OUTPUT_EXPRESSION) {
    failures.push("action output must pass through the environment");
  }
  if (checkStep?.run !== CHECK_COMMAND) {
    failures.push("unknown-license check must use the repository entrypoint");
  }
  if (
    steps.indexOf(setupStep) < 0 ||
    steps.indexOf(reviewStep) !== steps.indexOf(setupStep) + 1 ||
    steps.indexOf(checkStep) !== steps.indexOf(reviewStep) + 1
  ) {
    failures.push(
      "Node setup, dependency review, and unknown-license check must be adjacent",
    );
  }
  return failures;
}

afterEach(() => {
  delete process.env.INVALID_LICENSE_CHANGES;
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("parseUnlicensedDependencies", () => {
  it("accepts an empty unlicensed array", () => {
    expect(parseUnlicensedDependencies(actionOutput([]))).toEqual([]);
    expect(() =>
      assertNoUnlicensedDependencies(actionOutput([])),
    ).not.toThrow();
  });

  it("parses the actionable fields for an unlicensed dependency", () => {
    expect(parseUnlicensedDependencies(actionOutput([dependency()]))).toEqual([
      {
        manifest: "package-lock.json",
        name: "unknown-license-package",
        version: "1.2.3",
        packageUrl: "pkg:npm/unknown-license-package@1.2.3",
        license: null,
      },
    ]);
  });

  it("accepts NOASSERTION as the pinned action's other unlicensed classification", () => {
    const parsed = parseUnlicensedDependencies(
      actionOutput([dependency({ license: "NOASSERTION" })]),
    );
    expect(parsed[0]?.license).toBe("NOASSERTION");
    expect(() =>
      assertNoUnlicensedDependencies(
        actionOutput([dependency({ license: "NOASSERTION" })]),
      ),
    ).toThrow(/could not determine a license/);
  });

  it.each([
    ["missing output", undefined, /missing or empty/],
    ["empty output", "  ", /missing or empty/],
    ["malformed JSON", "{not-json", /not valid JSON/],
    ["non-object root", "[]", /must be a JSON object/],
    [
      "missing unlicensed field",
      JSON.stringify({ unresolved: [], forbidden: [] }),
      /must be present as an array/,
    ],
    [
      "malformed unlicensed field",
      JSON.stringify({ unlicensed: {}, unresolved: [], forbidden: [] }),
      /must be present as an array/,
    ],
    [
      "malformed entry",
      actionOutput(["not-an-object"]),
      /unlicensed\[0\] must be an object/,
    ],
  ])("fails closed for %s", (_name, raw, expected) => {
    expect(() => parseUnlicensedDependencies(raw)).toThrow(expected);
  });

  it.each(["manifest", "name", "version", "package_url"])(
    "rejects an entry with a missing %s",
    (field) => {
      const value: Record<string, unknown> = { ...dependency() };
      delete value[field];
      expect(() =>
        parseUnlicensedDependencies(actionOutput([value])),
      ).toThrow(new RegExp(`\\.${field} must be a string`));
    },
  );

  it("rejects a value placed in unlicensed with an unexpected license", () => {
    const value = { ...dependency(), license: "MIT" };
    expect(() =>
      parseUnlicensedDependencies(actionOutput([value])),
    ).toThrow(/license must be null or NOASSERTION/);
  });

  it("rejects oversized output before parsing it", () => {
    const oversized = "x".repeat(MAX_INVALID_LICENSE_CHANGES_BYTES + 1);
    expect(() => parseUnlicensedDependencies(oversized)).toThrow(
      /exceeds the 1048576-byte limit/,
    );
  });
});

describe("unlicensed dependency failure reporting", () => {
  it("fails for every non-empty unlicensed result", () => {
    expect(() =>
      assertNoUnlicensedDependencies(actionOutput([dependency()])),
    ).toThrow(
      /Unknown-license exceptions are disabled by factory\.md D111/,
    );
  });

  it("neutralizes hostile fields without creating injected log lines", () => {
    const hostile: UnlicensedDependency = {
      manifest: "\r::warning::manifest\u001b[31m",
      name: "package\n::error::injected\u202e",
      version: "1.0.0\u0000",
      packageUrl: "pkg:npm/hostile@1.0.0\u2028::notice::owned",
      license: null,
    };
    const report = formatUnlicensedDependencyReport([hostile]);
    const lines = report.split("\n");

    expect(lines).toHaveLength(3);
    expect(lines.every((line) => !line.startsWith("::"))).toBe(true);
    expect(report).not.toMatch(/[\u0000\u001b\u2028\u202e]/);
    expect(report).toContain("- 1. package ::error::injected@1.0.0");
  });

  it("bounds the number of dependency lines in the report", () => {
    const dependencies = Array.from({ length: 30 }, (_, index) => ({
      manifest: "package-lock.json",
      name: `package-${index}`,
      version: "1.0.0",
      packageUrl: `pkg:npm/package-${index}@1.0.0`,
      license: null,
    })) satisfies UnlicensedDependency[];
    const report = formatUnlicensedDependencyReport(dependencies);

    expect(report).toContain("5 additional unlicensed dependencies omitted");
    expect(report).not.toContain("package-29@");
  });

  it("wires the environment through main on the successful path", () => {
    process.env.INVALID_LICENSE_CHANGES = actionOutput([]);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    main();

    expect(log).toHaveBeenCalledWith(
      "Dependency review reported no undetected licenses.",
    );
  });

  it("converts validation failures into a non-zero process result", () => {
    process.env.INVALID_LICENSE_CHANGES = "{not-json";
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    runCli();

    expect(process.exitCode).toBe(1);
    expect(error).toHaveBeenCalledWith(
      "Unknown-license check failed:",
      "invalid-license-changes output is not valid JSON",
    );
  });

  it.each([
    ["missing output", undefined],
    ["malformed output", "{not-json"],
    ["unlicensed output", actionOutput([dependency()])],
  ])("exits 1 from the exact Node entrypoint for %s", (_name, rawOutput) => {
    const result = runEntrypoint(rawOutput);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/^Unknown-license check failed:/);
  });

  it("neutralizes hostile fields in the exact entrypoint stderr", () => {
    const result = runEntrypoint(
      actionOutput([
        dependency({
          name: "package\n::error::injected\u001b[31m",
          package_url: "pkg:npm/hostile@1.0.0\u2028::notice::owned",
        }),
      ]),
    );

    expect(result.status).toBe(1);
    expect(result.stderr).not.toMatch(/[\u001b\u2028]/);
    expect(result.stderr.split("\n").every((line) => !line.startsWith("::"))).toBe(
      true,
    );
  });
});

describe("dependency-review workflow contract (issue #42)", () => {
  it("passes the pinned action output to the fail-closed repository check", () => {
    expect(validateDependencyReviewWorkflow(WORKFLOW_CONTENT)).toEqual([]);
  });

  it.each([
    [
      "version-insensitive inline exception",
      "allow-dependencies-licenses: pkg:npm/example@1.2.3",
    ],
    ["configuration-file bypass", "config-file: .github/dependency-review.yml"],
  ])("rejects a %s", (_name, input) => {
    const mutated = WORKFLOW_CONTENT.replace(
      "          fail-on-severity: high\n",
      ["          fail-on-severity: high", `          ${input}`, ""].join(
        "\n",
      ),
    );
    expect(validateDependencyReviewWorkflow(mutated)).toContain(
      "unknown-license exceptions must remain disabled",
    );
  });

  it.each([
    "Allow-Dependencies-Licenses: pkg:npm/example@1.2.3",
    "Config-File: .github/dependency-review.yml",
    "allow-dependencies-licenſes: pkg:npm/example@1.2.3",
  ])("rejects a mixed-case exception input via %s", (input) => {
    const mutated = WORKFLOW_CONTENT.replace(
      "          fail-on-severity: high\n",
      ["          fail-on-severity: high", `          ${input}`, ""].join(
        "\n",
      ),
    );
    expect(validateDependencyReviewWorkflow(mutated)).toContain(
      "unknown-license exceptions must remain disabled",
    );
  });

  it.each(["if: false", "continue-on-error: true"])(
    "rejects a job-level fail-open override via %s",
    (override) => {
      const mutated = WORKFLOW_CONTENT.replace(
        "  dependency-review:\n",
        ["  dependency-review:", `    ${override}`, ""].join("\n"),
      );
      expect(validateDependencyReviewWorkflow(mutated)).toContain(
        "dependency-review job must always fail closed",
      );
    },
  );

  it.each(["if: false", "continue-on-error: true"])(
    "rejects a skipped checker via %s",
    (override) => {
      const mutated = WORKFLOW_CONTENT.replace(
        "      - name: Fail on undetected dependency licenses\n",
        [
          "      - name: Fail on undetected dependency licenses",
          `        ${override}`,
          "",
        ].join("\n"),
      );
      expect(validateDependencyReviewWorkflow(mutated)).toContain(
        "dependency review and unknown-license check must always fail closed",
      );
    },
  );

  it("rejects shell interpolation of the action output", () => {
    const mutated = WORKFLOW_CONTENT.replace(
      [
        "        env:",
        `          INVALID_LICENSE_CHANGES: ${OUTPUT_EXPRESSION}`,
        `        run: ${CHECK_COMMAND}`,
      ].join("\n"),
      `        run: ${CHECK_COMMAND} '${OUTPUT_EXPRESSION}'`,
    );
    const failures = validateDependencyReviewWorkflow(mutated);
    expect(failures).toContain("action output must pass through the environment");
    expect(failures).toContain(
      "unknown-license check must use the repository entrypoint",
    );
  });
});
