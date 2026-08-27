import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isMap, isScalar, parseDocument } from "yaml";

const RUNBOOK_PATH = new URL("../../docs/factory-runbook.md", import.meta.url);
const WORKFLOW_DIRECTORY = new URL("../../.github/workflows/", import.meta.url);
const INVENTORY_LINE =
  /^\s*gh api -X PUT repos\/syamaner\/roastpilot-cloud\/actions\/workflows\/(\d+)\/(disable|enable)[ \t]+#[ \t]*(\S+\.ya?ml)(?:[ \t].*)?$/;
const INVENTORY_ACTION =
  /^\s*gh api -X PUT repos\/syamaner\/roastpilot-cloud\/actions\/workflows\/\d+\/(?:disable|enable)\b/;
const UNAFFECTED_WORKFLOWS = new Set([
  "ci.yml",
  "codeql.yml",
  "dependency-review.yml",
  "claude-code-review.yml",
  "dev-snowflake-contract.yml",
  // Refs #237: this workflow_dispatch-only, operator-initiated diagnostic is
  // intentionally run while the factory is paused before activation. A pause
  // gate would defeat that purpose; no event/automated trigger can reach it.
  "task-agent-read-confinement-probe.yml",
]);
const PAUSE_BLOCK_CONJUNCT = "vars.FACTORY_PAUSED != 'true'";
const PAUSE_NOTICE_CONJUNCT = "vars.FACTORY_PAUSED == 'true'";
const PAUSE_NOTICE_ALLOWLIST: ReadonlyMap<string, ReadonlySet<string>> =
  new Map([
    ["triage-issues.yml", new Set(["pause-notice"])],
    ["implement-ready-issues.yml", new Set(["pause-notice"])],
  ]);
const PAUSE_NOTICE_JOB_PINS = {
  "triage-issues.yml#pause-notice": {
    name: "Factory pause notice",
    if: "(github.event_name != 'workflow_dispatch' || github.ref == 'refs/heads/main') && vars.FACTORY_PAUSED == 'true'",
    "runs-on": "ubuntu-latest",
    permissions: {},
    steps: [
      {
        name: "Announce that the factory is paused",
        run: `echo "::warning::Factory is PAUSED (vars.FACTORY_PAUSED=true) — seed/triage/apply will NOT run for this event. Unset the FACTORY_PAUSED repo variable (or set it to 'false') to resume, or see docs/factory-runbook.md for the full-halt option."
{
  echo "## ⏸ Factory paused"
  echo "\\\`FACTORY_PAUSED\\\` is \\\`true\\\` — no triage jobs ran for this event."
  echo "See [docs/factory-runbook.md](https://github.com/\${{ github.repository }}/blob/main/docs/factory-runbook.md) for how to resume or fully halt."
} >> "$GITHUB_STEP_SUMMARY"
`,
      },
    ],
  },
  "implement-ready-issues.yml#pause-notice": {
    name: "Factory pause notice",
    if: "vars.FACTORY_PAUSED == 'true'",
    "runs-on": "ubuntu-latest",
    permissions: {},
    steps: [
      {
        name: "Announce that the factory is paused",
        run: `echo "::warning::Factory is PAUSED (vars.FACTORY_PAUSED=true) — this dispatch will NOT implement or publish anything. Unset the FACTORY_PAUSED repo variable (or set it to 'false') to resume, or see docs/factory-runbook.md for the full-halt option."
{
  echo "## ⏸ Factory paused"
  echo "\\\`FACTORY_PAUSED\\\` is \\\`true\\\` — this dispatch did not implement or publish anything."
  echo "See [docs/factory-runbook.md](https://github.com/\${{ github.repository }}/blob/main/docs/factory-runbook.md) for how to resume or fully halt."
} >> "$GITHUB_STEP_SUMMARY"
`,
      },
    ],
  },
} as const;
const PAUSE_NOTICE_ROOT_KEY_PINS: Readonly<Record<string, readonly string[]>> =
  {
    "triage-issues.yml": [
      "name",
      "run-name",
      "on",
      "env",
      "permissions",
      "jobs",
    ],
    "implement-ready-issues.yml": [
      "name",
      "on",
      "concurrency",
      "permissions",
      "jobs",
    ],
  };
const TRIAGE_ROOT_ENV_PIN = {
  TARGET_ISSUE_NUMBER:
    "${{ github.event.issue.number || inputs.issue_number }}",
} as const;

type InventoryEntry = {
  id: string;
  action: "disable" | "enable";
  filename: string;
};

type WorkflowClassification = {
  gated: boolean;
  reasons: string[];
};

function splitTopLevelConjuncts(expr: string): string[] | null {
  if (expr.includes("${{")) return null;

  const conjuncts: string[] = [];
  let conjunctStart = 0;
  let inSingleQuote = false;
  let parenDepth = 0;

  for (let index = 0; index < expr.length; index += 1) {
    const character = expr[index];
    const nextCharacter = expr[index + 1];

    if (character === "'") {
      if (inSingleQuote && nextCharacter === "'") {
        index += 1;
      } else {
        inSingleQuote = !inSingleQuote;
      }
      continue;
    }
    if (inSingleQuote) continue;

    if (character === "(") {
      parenDepth += 1;
      continue;
    }
    if (character === ")") {
      parenDepth -= 1;
      if (parenDepth < 0) return null;
      continue;
    }
    if (parenDepth === 0 && character === "|" && nextCharacter === "|") {
      return null;
    }
    if (parenDepth === 0 && character === "&" && nextCharacter === "&") {
      conjuncts.push(expr.slice(conjunctStart, index).trim());
      index += 1;
      conjunctStart = index + 1;
    }
  }

  if (inSingleQuote || parenDepth !== 0) return null;
  conjuncts.push(expr.slice(conjunctStart).trim());
  return conjuncts;
}

function mappingValue(mapping: unknown, key: string): unknown {
  if (!isMap(mapping)) return undefined;
  const pair = mapping.items.find(
    (candidate) =>
      isScalar(candidate.key) && candidate.key.value === key,
  );
  return pair?.value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isStructuralScalar(
  value: unknown,
): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function firstStructuralMismatch(
  actual: unknown,
  expected: unknown,
  path = "$",
): string | undefined {
  if (isStructuralScalar(actual) || isStructuralScalar(expected)) {
    return isStructuralScalar(actual) &&
      isStructuralScalar(expected) &&
      actual === expected
      ? undefined
      : path;
  }

  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) return path;
    if (actual.length !== expected.length) return `${path}.length`;
    for (let index = 0; index < actual.length; index += 1) {
      const mismatch = firstStructuralMismatch(
        actual[index],
        expected[index],
        `${path}[${index}]`,
      );
      if (mismatch !== undefined) return mismatch;
    }
    return undefined;
  }

  if (!isPlainObject(actual) || !isPlainObject(expected)) return path;
  const actualKeys = Object.keys(actual);
  const expectedKeys = Object.keys(expected);
  for (const key of actualKeys) {
    if (!Object.hasOwn(expected, key)) return `${path}.${key}`;
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(actual, key)) return `${path}.${key}`;
  }
  for (const key of actualKeys) {
    const mismatch = firstStructuralMismatch(
      actual[key],
      expected[key],
      `${path}.${key}`,
    );
    if (mismatch !== undefined) return mismatch;
  }
  return undefined;
}

function hasExactKeySet(
  value: unknown,
  expectedKeys: readonly string[],
): boolean {
  if (!isPlainObject(value)) return false;
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key) => expectedKeys.includes(key)) &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function classifyWorkflow(
  filename: string,
  text: string,
): WorkflowClassification {
  try {
    const document = parseDocument(text);
    if (document.errors.length > 0 || document.warnings.length > 0) {
      return { gated: false, reasons: ["yaml-parse-error"] };
    }

    const jobs = mappingValue(document.contents, "jobs");
    if (!isMap(jobs) || jobs.items.length === 0) {
      return { gated: false, reasons: ["jobs-missing-or-empty"] };
    }

    const reasons: string[] = [];
    let pauseBlockedJobs = 0;
    for (const [index, pair] of jobs.items.entries()) {
      const jobName =
        isScalar(pair.key) && typeof pair.key.value === "string"
          ? pair.key.value
          : `<invalid-job-${index}>`;
      const reasonPrefix = `job:${jobName}`;
      const job = pair.value;
      if (!isMap(job)) {
        reasons.push(`${reasonPrefix}:not-a-mapping`);
        continue;
      }

      const condition = mappingValue(job, "if");
      if (!isScalar(condition) || typeof condition.value !== "string") {
        reasons.push(`${reasonPrefix}:if-missing-or-not-string`);
        continue;
      }
      const conjuncts = splitTopLevelConjuncts(condition.value.trim());
      if (conjuncts === null) {
        reasons.push(`${reasonPrefix}:if-expression-rejected`);
        continue;
      }

      const pauseBlockCount = conjuncts.filter(
        (conjunct) => conjunct === PAUSE_BLOCK_CONJUNCT,
      ).length;
      if (pauseBlockCount === 1) {
        pauseBlockedJobs += 1;
        continue;
      }

      const hasNoticeConjunct = conjuncts.some(
        (conjunct) => conjunct === PAUSE_NOTICE_CONJUNCT,
      );
      if (hasNoticeConjunct) {
        const noticeAllowed =
          PAUSE_NOTICE_ALLOWLIST.get(filename)?.has(jobName) === true;
        if (!noticeAllowed) {
          reasons.push(`${reasonPrefix}:pause-notice-not-allowlisted`);
          continue;
        }

        const pinKey = `${filename}#${jobName}`;
        const expectedJob = Object.hasOwn(PAUSE_NOTICE_JOB_PINS, pinKey)
          ? PAUSE_NOTICE_JOB_PINS[
              pinKey as keyof typeof PAUSE_NOTICE_JOB_PINS
            ]
          : undefined;
        const jobMismatch = firstStructuralMismatch(
          job.toJSON(),
          expectedJob,
        );
        if (jobMismatch !== undefined) {
          reasons.push(
            `${reasonPrefix}:pause-notice-pin-mismatch:${jobMismatch}`,
          );
        }

        const root = document.toJSON();
        const expectedRootKeys = PAUSE_NOTICE_ROOT_KEY_PINS[filename];
        if (
          expectedRootKeys === undefined ||
          !hasExactKeySet(root, expectedRootKeys)
        ) {
          reasons.push(`${reasonPrefix}:pause-notice-root-key-set-mismatch`);
        }
        if (
          filename === "triage-issues.yml" &&
          (!isPlainObject(root) ||
            firstStructuralMismatch(root.env, TRIAGE_ROOT_ENV_PIN) !==
              undefined)
        ) {
          reasons.push(`${reasonPrefix}:pause-notice-root-env-mismatch`);
        }
        continue;
      }

      reasons.push(
        pauseBlockCount > 1
          ? `${reasonPrefix}:duplicate-pause-block-conjunct`
          : `${reasonPrefix}:missing-exact-pause-block-conjunct`,
      );
    }

    if (reasons.length > 0) return { gated: false, reasons };
    if (pauseBlockedJobs === 0) {
      return { gated: false, reasons: ["workflow:no-pause-blocked-job"] };
    }
    return { gated: true, reasons: [] };
  } catch {
    return { gated: false, reasons: ["yaml-parse-error"] };
  }
}

function sectionBetween(
  document: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = document.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing section marker: ${startMarker}`);
  const end = document.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Missing section marker: ${endMarker}`);
  return document.slice(start, end);
}

function fencedBashBlockAfter(section: string, marker: string): string {
  const markerIndex = section.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Missing block marker: ${marker}`);
  const match = /```bash\n([\s\S]*?)```/.exec(section.slice(markerIndex));
  if (match?.[1] === undefined) {
    throw new Error(`Missing bash block after: ${marker}`);
  }
  return match[1];
}

function sectionAfter(document: string, marker: string): string {
  const start = document.indexOf(marker);
  if (start < 0) throw new Error(`Missing section marker: ${marker}`);
  return document.slice(start);
}

function parseInventoryBlock(
  block: string,
  expectedAction: "disable" | "enable",
): InventoryEntry[] {
  const actionLines = block
    .split("\n")
    .filter((line) => INVENTORY_ACTION.test(line));
  if (actionLines.length === 0) {
    throw new Error(`Inventory has no ${expectedAction} lines`);
  }

  return actionLines.map((line) => {
    const match = INVENTORY_LINE.exec(line);
    if (match === null) {
      throw new Error(`Malformed inventory line; add a .yml filename: ${line}`);
    }
    const id = match[1];
    const action = match[2];
    const filename = match[3];
    if (
      id === undefined ||
      filename === undefined ||
      (action !== "disable" && action !== "enable")
    ) {
      throw new Error(`Malformed inventory line: ${line}`);
    }
    if (action !== expectedAction) {
      throw new Error(
        `Expected ${expectedAction} inventory line but found ${action}: ${line}`,
      );
    }
    return { id, action, filename };
  });
}

function filenameIdMap(
  entries: readonly InventoryEntry[],
  label: string,
): Map<string, string> {
  const byFilename = new Map<string, string>();
  const filenameById = new Map<string, string>();
  for (const entry of entries) {
    if (byFilename.has(entry.filename)) {
      throw new Error(
        `${label} inventory repeats workflow filename ${entry.filename}`,
      );
    }
    const existingFilename = filenameById.get(entry.id);
    if (existingFilename !== undefined) {
      throw new Error(
        `${label} inventory reuses workflow ID ${entry.id} for ${existingFilename} and ${entry.filename}`,
      );
    }
    byFilename.set(entry.filename, entry.id);
    filenameById.set(entry.id, entry.filename);
  }
  return byFilename;
}

function assertGatedMappings(
  disableIds: ReadonlyMap<string, string>,
  enableIds: ReadonlyMap<string, string>,
  gatedFilenames: readonly string[],
): void {
  for (const filename of gatedFilenames) {
    const disableId = disableIds.get(filename);
    if (disableId === undefined) {
      throw new Error(`Missing disable workflow ID mapping for ${filename}`);
    }
    const enableId = enableIds.get(filename);
    if (enableId === undefined) {
      throw new Error(`Missing enable workflow ID mapping for ${filename}`);
    }
    if (disableId !== enableId) {
      throw new Error(
        `Disable/enable workflow ID mismatch for ${filename}: ${disableId} != ${enableId}`,
      );
    }
  }
}

function assertExactInventoryFilenames(
  inventoryIds: ReadonlyMap<string, string>,
  label: string,
  gatedFilenames: readonly string[],
): void {
  const gatedSet = new Set(gatedFilenames);
  for (const filename of inventoryIds.keys()) {
    if (!gatedSet.has(filename)) {
      throw new Error(
        `${label} inventory contains stale or non-gated workflow ${filename}`,
      );
    }
  }
  for (const filename of gatedFilenames) {
    if (!inventoryIds.has(filename)) {
      throw new Error(
        `${label} inventory is missing gated workflow ${filename}`,
      );
    }
  }
}

const runbook = readFileSync(RUNBOOK_PATH, "utf8");
const killSwitch = sectionBetween(
  runbook,
  "## Kill-switch: stopping the factory",
  "## Resuming after a pause — clear the flag, then don't skip the backfill",
);
const disableSection = sectionBetween(
  killSwitch,
  "### 3. Disable the workflows",
  "### Emergency halt — full procedure",
);
const resumeSection = sectionBetween(
  runbook,
  "## Resuming after a pause — clear the flag, then don't skip the backfill",
  "## Cost/budget caps",
);
const disableBlock = fencedBashBlockAfter(
  disableSection,
  "### 3. Disable the workflows",
);
const enableBlock = fencedBashBlockAfter(
  resumeSection,
  "1. **Re-enable the workflows",
);
const disableEntries = parseInventoryBlock(disableBlock, "disable");
const enableEntries = parseInventoryBlock(enableBlock, "enable");
const disableIdsByFilename = filenameIdMap(disableEntries, "Disable");
const enableIdsByFilename = filenameIdMap(enableEntries, "Enable");

const workflowFiles = readdirSync(WORKFLOW_DIRECTORY)
  .filter((filename) => /\.ya?ml$/.test(filename))
  .sort();
const workflowTexts = new Map(
  workflowFiles.map((filename) => [
    filename,
    readFileSync(new URL(filename, WORKFLOW_DIRECTORY), "utf8"),
  ]),
);

function liveWorkflowText(filename: string): string {
  const text = workflowTexts.get(filename);
  if (text === undefined) throw new Error(`Missing live workflow ${filename}`);
  return text;
}

function mutateLiveWorkflow(
  filename: string,
  needle: string,
  replacement: string,
): string {
  const original = liveWorkflowText(filename);
  const mutated = original.replace(needle, replacement);
  expect(mutated).not.toBe(original);
  return mutated;
}

function expectNoticePinMismatch(
  classification: WorkflowClassification,
): void {
  expect(classification.gated).toBe(false);
  expect(classification.reasons).toEqual(
    expect.arrayContaining([
      expect.stringMatching(
        /^job:pause-notice:pause-notice-pin-mismatch:\$/,
      ),
    ]),
  );
}
// Parse-based and fail-closed: every job needs the byte-exact top-level
// `vars.FACTORY_PAUSED != 'true'` conjunct, except the inverse-gated
// `pause-notice` allowlist. Each exemption is pinned as one complete plain
// object: exact keys, scalar representations, step count/order, and block-scalar
// bytes. The brittleness is intentional. Any notice-message or job edit must
// re-pin it in the same reviewed diff; that coupling is the security property.
// The root key set is pinned only for workflows containing an allowlisted
// notice, and triage's legitimate non-secret root env is value-pinned. Trigger,
// run-name, concurrency, and root-permissions values are deliberately not
// pinned: the job has its own `permissions: {}`, concurrency is
// availability-only, and its sole interpolation (`github.repository`) is
// benign for every trigger. Keep
// triage's notice condition in step with its complementary byte-pin at
// tests/factory/triage-workflow-contract.test.ts:1460-1462.
const gatedWorkflows = workflowFiles.filter((filename) => {
  const text = workflowTexts.get(filename);
  return text !== undefined && classifyWorkflow(filename, text).gated;
});

describe("factory halt and resume inventory", () => {
  it("T1 accepts the live triage pause notice pin", () => {
    expect(
      classifyWorkflow(
        "triage-issues.yml",
        liveWorkflowText("triage-issues.yml"),
      ),
    ).toEqual({ gated: true, reasons: [] });
  });

  it("T2 accepts the live implement pause notice pin", () => {
    expect(
      classifyWorkflow(
        "implement-ready-issues.yml",
        liveWorkflowText("implement-ready-issues.yml"),
      ),
    ).toEqual({ gated: true, reasons: [] });
  });

  it("pins the exact live set of FACTORY_PAUSED-gated workflows", () => {
    expect(gatedWorkflows).toEqual([
      "codex-verdict-status.yml",
      "implement-ready-issues.yml",
      "owner-command-intake.yml",
      "story-planner.yml",
      "triage-issues.yml",
    ]);
  });

  it("keeps unaffected workflows free of FACTORY_PAUSED mentions", () => {
    for (const filename of UNAFFECTED_WORKFLOWS) {
      expect(
        workflowTexts.get(filename),
        `Missing unaffected workflow ${filename}`,
      ).not.toContain("FACTORY_PAUSED");
    }
  });

  it("F1 rejects comment-only and run-string FACTORY_PAUSED mentions", () => {
    const classification = classifyWorkflow(
      "comment-only.yml",
      `# FACTORY_PAUSED is mentioned but does not gate a job
jobs:
  echo-only:
    runs-on: ubuntu-latest
    steps:
      - run: echo FACTORY_PAUSED
`,
    );

    expect(classification.gated).toBe(false);
    expect(classification.reasons).toContain(
      "job:echo-only:if-missing-or-not-string",
    );
  });

  it("F2 rejects a workflow with any ungated job", () => {
    const classification = classifyWorkflow(
      "partly-gated.yml",
      `jobs:
  job-a:
    if: vars.FACTORY_PAUSED != 'true'
  job-b:
    steps:
      - uses: example/action@0123456789abcdef
`,
    );

    expect(classification.gated).toBe(false);
    expect(classification.reasons).toContain(
      "job:job-b:if-missing-or-not-string",
    );
  });

  it("F3 accepts exact blocking conjuncts in realistic compounds", () => {
    const classification = classifyWorkflow(
      "compound.yml",
      `jobs:
  first:
    if: always() && needs.x.result == 'success' && (a || b) && vars.FACTORY_PAUSED != 'true'
  second:
    if: vars.FACTORY_PAUSED != 'true' && github.ref == 'refs/heads/main'
`,
    );

    expect(classification).toEqual({ gated: true, reasons: [] });
  });

  it("F4 rejects a depth-zero disjunction despite an exact substring", () => {
    const classification = classifyWorkflow(
      "disjunction.yml",
      `jobs:
  unsafe:
    if: github.event_name == 'push' || vars.FACTORY_PAUSED != 'true'
`,
    );

    expect(classification.gated).toBe(false);
    expect(classification.reasons).toContain(
      "job:unsafe:if-expression-rejected",
    );
  });

  it("F5 rejects a dollar-brace-wrapped expression", () => {
    const classification = classifyWorkflow(
      "wrapped.yml",
      `jobs:
  wrapped:
    if: \${{ vars.FACTORY_PAUSED != 'true' }}
`,
    );

    expect(classification.gated).toBe(false);
    expect(classification.reasons).toContain(
      "job:wrapped:if-expression-rejected",
    );
  });

  it("F6 rejects inverse-gated notice impersonation", () => {
    const classification = classifyWorkflow(
      "impersonator.yml",
      `jobs:
  pause-notice:
    if: vars.FACTORY_PAUSED == 'true'
    permissions: {}
    steps:
      - run: echo paused
`,
    );

    expect(classification.gated).toBe(false);
    expect(classification.reasons).toContain(
      "job:pause-notice:pause-notice-not-allowlisted",
    );
  });

  it("F7 rejects non-exact pause variable and value variants", () => {
    const variants = [
      "env.FACTORY_PAUSED != 'true'",
      "vars.FACTORY_PAUSED != 'TRUE'",
    ];

    for (const condition of variants) {
      const classification = classifyWorkflow(
        "variant.yml",
        `jobs:
  variant:
    if: ${condition}
`,
      );
      expect(classification.gated, condition).toBe(false);
      expect(classification.reasons).toContain(
        "job:variant:missing-exact-pause-block-conjunct",
      );
    }
  });

  it("F8 rejects empty or missing jobs and unparseable YAML", () => {
    expect(classifyWorkflow("empty.yml", `jobs: {}`)).toEqual({
      gated: false,
      reasons: ["jobs-missing-or-empty"],
    });
    expect(classifyWorkflow("missing.yml", `name: missing jobs`)).toEqual({
      gated: false,
      reasons: ["jobs-missing-or-empty"],
    });
    expect(classifyWorkflow("broken.yml", `jobs:\n  broken: [`)).toEqual({
      gated: false,
      reasons: ["yaml-parse-error"],
    });
  });

  it("F9 rejects a non-string boolean job condition", () => {
    const classification = classifyWorkflow(
      "boolean.yml",
      `jobs:
  boolean-condition:
    if: true
`,
    );

    expect(classification.gated).toBe(false);
    expect(classification.reasons).toContain(
      "job:boolean-condition:if-missing-or-not-string",
    );
  });

  it("T5 rejects a pin-matching implement notice-only workflow", () => {
    const classification = classifyWorkflow(
      "implement-ready-issues.yml",
      `name: Implement Ready Issues
on: workflow_dispatch
concurrency: {}
permissions: {}
jobs:
  pause-notice:
    name: Factory pause notice
    if: vars.FACTORY_PAUSED == 'true'
    runs-on: ubuntu-latest
    permissions: {}
    steps:
      - name: Announce that the factory is paused
        run: |
          echo "::warning::Factory is PAUSED (vars.FACTORY_PAUSED=true) — this dispatch will NOT implement or publish anything. Unset the FACTORY_PAUSED repo variable (or set it to 'false') to resume, or see docs/factory-runbook.md for the full-halt option."
          {
            echo "## ⏸ Factory paused"
            echo "\\\`FACTORY_PAUSED\\\` is \\\`true\\\` — this dispatch did not implement or publish anything."
            echo "See [docs/factory-runbook.md](https://github.com/\${{ github.repository }}/blob/main/docs/factory-runbook.md) for how to resume or fully halt."
          } >> "$GITHUB_STEP_SUMMARY"
`,
    );

    expect(classification).toEqual({
      gated: false,
      reasons: ["workflow:no-pause-blocked-job"],
    });
  });

  it("F11 treats operators inside quoted strings as literal text", () => {
    const condition =
      "contains(github.event.head_commit.message, 'a && b') && vars.FACTORY_PAUSED != 'true'";

    expect(splitTopLevelConjuncts(condition)).toEqual([
      "contains(github.event.head_commit.message, 'a && b')",
      PAUSE_BLOCK_CONJUNCT,
    ]);
    expect(
      classifyWorkflow(
        "quoted-operators.yml",
        `jobs:\n  quoted:\n    if: ${condition}\n`,
      ),
    ).toEqual({ gated: true, reasons: [] });
  });

  it("N1 rejects an appended notice command", () => {
    const mutated = mutateLiveWorkflow(
      "implement-ready-issues.yml",
      `          } >> "$GITHUB_STEP_SUMMARY"\n\n  # --- implement:`,
      `          } >> "$GITHUB_STEP_SUMMARY"\n          echo "tampered"\n\n  # --- implement:`,
    );

    expectNoticePinMismatch(
      classifyWorkflow("implement-ready-issues.yml", mutated),
    );
  });

  it("N2a rejects inherited root env in the implement workflow", () => {
    const mutated = mutateLiveWorkflow(
      "implement-ready-issues.yml",
      `permissions: {}\n\njobs:`,
      `permissions: {}\nenv:\n  LEAK: \${{ secrets.X }}\n\njobs:`,
    );
    const classification = classifyWorkflow(
      "implement-ready-issues.yml",
      mutated,
    );

    expect(classification.gated).toBe(false);
    expect(classification.reasons).toContain(
      "job:pause-notice:pause-notice-root-key-set-mismatch",
    );
  });

  it("N2b rejects an extra triage root env value", () => {
    const mutated = mutateLiveWorkflow(
      "triage-issues.yml",
      `  TARGET_ISSUE_NUMBER: \${{ github.event.issue.number || inputs.issue_number }}\n`,
      `  TARGET_ISSUE_NUMBER: \${{ github.event.issue.number || inputs.issue_number }}\n  LEAK: \${{ secrets.X }}\n`,
    );
    const classification = classifyWorkflow("triage-issues.yml", mutated);

    expect(classification.gated).toBe(false);
    expect(classification.reasons).toContain(
      "job:pause-notice:pause-notice-root-env-mismatch",
    );
  });

  it("N2c rejects a format-wrapped secret in triage root env", () => {
    const mutated = mutateLiveWorkflow(
      "triage-issues.yml",
      `  TARGET_ISSUE_NUMBER: \${{ github.event.issue.number || inputs.issue_number }}`,
      `  TARGET_ISSUE_NUMBER: \${{ format('{0}', secrets.X) }}`,
    );
    const classification = classifyWorkflow("triage-issues.yml", mutated);

    expect(classification.gated).toBe(false);
    expect(classification.reasons).toContain(
      "job:pause-notice:pause-notice-root-env-mismatch",
    );
  });

  it("N3 rejects a different notice runner", () => {
    const mutated = mutateLiveWorkflow(
      "implement-ready-issues.yml",
      "    runs-on: ubuntu-latest",
      "    runs-on: self-hosted",
    );

    expectNoticePinMismatch(
      classifyWorkflow("implement-ready-issues.yml", mutated),
    );
  });

  it("N4 rejects format-wrapped secret access in a notice run", () => {
    const mutated = mutateLiveWorkflow(
      "implement-ready-issues.yml",
      `\${{ github.repository }}`,
      `\${{ format('{0}', secrets.X) }}`,
    );

    expectNoticePinMismatch(
      classifyWorkflow("implement-ready-issues.yml", mutated),
    );
  });

  it("rejects direct secret access in a notice run", () => {
    const mutated = mutateLiveWorkflow(
      "implement-ready-issues.yml",
      `\${{ github.repository }}`,
      `\${{ secrets.FOO }}`,
    );

    expectNoticePinMismatch(
      classifyWorkflow("implement-ready-issues.yml", mutated),
    );
  });

  it("N5 rejects an extra notice job key", () => {
    const mutated = mutateLiveWorkflow(
      "implement-ready-issues.yml",
      "    runs-on: ubuntu-latest\n    permissions: {}",
      "    runs-on: ubuntu-latest\n    timeout-minutes: 1\n    permissions: {}",
    );

    expectNoticePinMismatch(
      classifyWorkflow("implement-ready-issues.yml", mutated),
    );
  });

  it("N6 rejects a uses key on the notice step", () => {
    const mutated = mutateLiveWorkflow(
      "implement-ready-issues.yml",
      "      - name: Announce that the factory is paused\n        run: |",
      "      - uses: example/action@0123456789abcdef\n        run: |",
    );

    expectNoticePinMismatch(
      classifyWorkflow("implement-ready-issues.yml", mutated),
    );
  });

  it("N6b rejects a duplicate notice run step", () => {
    const mutated = mutateLiveWorkflow(
      "implement-ready-issues.yml",
      `          } >> "$GITHUB_STEP_SUMMARY"\n\n  # --- implement:`,
      `          } >> "$GITHUB_STEP_SUMMARY"\n      - run: echo duplicate\n\n  # --- implement:`,
    );

    expectNoticePinMismatch(
      classifyWorkflow("implement-ready-issues.yml", mutated),
    );
  });

  it("N7 rejects non-empty notice permissions", () => {
    const mutated = mutateLiveWorkflow(
      "implement-ready-issues.yml",
      "    permissions: {}",
      "    permissions:\n      contents: read",
    );

    expectNoticePinMismatch(
      classifyWorkflow("implement-ready-issues.yml", mutated),
    );
  });

  it("rejects missing notice permissions at the pinned path", () => {
    const mutated = mutateLiveWorkflow(
      "implement-ready-issues.yml",
      "\n    permissions: {}",
      "",
    );

    expect(classifyWorkflow("implement-ready-issues.yml", mutated)).toEqual({
      gated: false,
      reasons: [
        "job:pause-notice:pause-notice-pin-mismatch:$.permissions",
      ],
    });
  });

  it("N8 rejects workflow-level defaults beside a notice", () => {
    const mutated = mutateLiveWorkflow(
      "implement-ready-issues.yml",
      `permissions: {}\n\njobs:`,
      `permissions: {}\ndefaults:\n  run:\n    shell: bash\n\njobs:`,
    );
    const classification = classifyWorkflow(
      "implement-ready-issues.yml",
      mutated,
    );

    expect(classification.gated).toBe(false);
    expect(classification.reasons).toContain(
      "job:pause-notice:pause-notice-root-key-set-mismatch",
    );
  });

  it("rejects a missing triage root run-name key", () => {
    const mutated = mutateLiveWorkflow(
      "triage-issues.yml",
      `run-name: "Triage issue #\${{ github.event.issue.number || inputs.issue_number }}"\n`,
      "",
    );

    expect(classifyWorkflow("triage-issues.yml", mutated)).toEqual({
      gated: false,
      reasons: [
        "job:pause-notice:pause-notice-root-key-set-mismatch",
      ],
    });
  });

  it("N9 rejects a sequence-form notice runner", () => {
    const mutated = mutateLiveWorkflow(
      "implement-ready-issues.yml",
      "    runs-on: ubuntu-latest",
      "    runs-on: [ubuntu-latest]",
    );

    expectNoticePinMismatch(
      classifyWorkflow("implement-ready-issues.yml", mutated),
    );
  });

  it("F17 rejects a duplicated exact pause-block conjunct", () => {
    const classification = classifyWorkflow(
      "duplicate.yml",
      `jobs:
  duplicated:
    if: vars.FACTORY_PAUSED != 'true' && vars.FACTORY_PAUSED != 'true'
`,
    );

    expect(classification.gated).toBe(false);
    expect(classification.reasons).toContain(
      "job:duplicated:duplicate-pause-block-conjunct",
    );
  });

  it("F18 rejects a null job alongside a pause-blocked job", () => {
    const classification = classifyWorkflow(
      "null-job.yml",
      `jobs:
  blocked:
    if: vars.FACTORY_PAUSED != 'true'
  some-job:
`,
    );

    expect(classification.gated).toBe(false);
    expect(classification.reasons).toContain("job:some-job:not-a-mapping");
  });

  it("F19 rejects an if condition supplied through a YAML alias", () => {
    const classification = classifyWorkflow(
      "alias.yml",
      `condition: &cond vars.FACTORY_PAUSED != 'true'
jobs:
  aliased:
    if: *cond
`,
    );

    expect(classification.gated).toBe(false);
    expect(classification.reasons).toContain(
      "job:aliased:if-missing-or-not-string",
    );
  });

  it("F20 accepts an exact condition in a trimmed folded scalar", () => {
    const classification = classifyWorkflow(
      "folded.yml",
      `jobs:
  folded:
    if: >-
      vars.FACTORY_PAUSED != 'true'
`,
    );

    expect(classification).toEqual({ gated: true, reasons: [] });
  });

  it("disables every workflow gated by FACTORY_PAUSED", () => {
    assertExactInventoryFilenames(
      disableIdsByFilename,
      "Disable",
      gatedWorkflows,
    );
    for (const filename of gatedWorkflows) {
      expect(
        disableIdsByFilename.has(filename),
        `Missing §3 disable inventory line for gated workflow ${filename}`,
      ).toBe(true);
    }
  });

  it("re-enables every workflow gated by FACTORY_PAUSED", () => {
    assertExactInventoryFilenames(
      enableIdsByFilename,
      "Enable",
      gatedWorkflows,
    );
    for (const filename of gatedWorkflows) {
      expect(
        enableIdsByFilename.has(filename),
        `Missing resume enable inventory line for gated workflow ${filename}`,
      ).toBe(true);
    }
  });

  it("keeps the disable and enable workflow ID sets strictly equal", () => {
    assertGatedMappings(
      disableIdsByFilename,
      enableIdsByFilename,
      gatedWorkflows,
    );
    const disableIds = [...disableIdsByFilename.values()].sort();
    const enableIds = [...enableIdsByFilename.values()].sort();
    expect(enableIds).toEqual(disableIds);
  });

  it("classifies every workflow as gated or explicitly unaffected", () => {
    const unclassified = workflowFiles.filter(
      (filename) =>
        !gatedWorkflows.includes(filename) &&
        !UNAFFECTED_WORKFLOWS.has(filename),
    );
    expect(
      unclassified,
      "Gate/classify every new workflow and update the runbook halt inventory or closed unaffected allowlist",
    ).toEqual([]);
    const inventoriedUnaffected = [...UNAFFECTED_WORKFLOWS]
      .filter(
        (filename) =>
          disableIdsByFilename.has(filename) ||
          enableIdsByFilename.has(filename),
      )
      .sort();
    expect(
      inventoriedUnaffected,
      "Unaffected workflows must not appear in the halt/resume inventory",
    ).toEqual([]);
  });

  it("enumerates all non-completed runs repo-wide with real pagination", () => {
    const cancelSection = sectionBetween(
      killSwitch,
      "### 2. Cancel any run already queued or in-progress",
      "### 3. Disable the workflows",
    );
    const enumeration = fencedBashBlockAfter(
      cancelSection,
      "**List every non-completed run",
    );
    expect(enumeration).toContain("gh api --paginate");
    expect(enumeration).toContain('select(.status != "completed")');
    expect(enumeration).not.toContain("gh run list --workflow");
    expect(enumeration).not.toContain("--limit");
  });

  it("documents the credentialed Snowflake workflow exclusion", () => {
    const exclusion = sectionAfter(
      disableSection,
      "#### Exclusion: `dev-snowflake-contract.yml`",
    );
    expect(exclusion).toContain("EXCLUDED");
    expect(exclusion).toContain("§2 cancel");
    expect(exclusion).toContain("§3 disable");
  });

  it("documents both conditional event-backfill paths", () => {
    expect(resumeSection).toMatch(
      /codex-verdict-status\.yml --ref main[^\n]*-f pr_number/,
    );
    const ownerBackfill = resumeSection.slice(
      resumeSection.indexOf("**Conditional Step 5 (9e)"),
    );
    expect(ownerBackfill).toContain("@claude question");
    expect(ownerBackfill).toContain("@claude task");
    expect(ownerBackfill).toMatch(/re-issue[^.]*fresh PR comment/);
  });

  it("rejects empty, malformed, and non-bijective inventory fixtures", () => {
    expect(() => parseInventoryBlock("echo no inventory", "disable")).toThrow(
      "Inventory has no disable lines",
    );
    expect(() =>
      parseInventoryBlock(
        "gh api -X PUT repos/syamaner/roastpilot-cloud/actions/workflows/123/disable # Triage Issues",
        "disable",
      ),
    ).toThrow("add a .yml filename");
    expect(() =>
      parseInventoryBlock(
        "# gh api -X PUT repos/syamaner/roastpilot-cloud/actions/workflows/123/disable # first.yml",
        "disable",
      ),
    ).toThrow("Inventory has no disable lines");
    expect(() =>
      parseInventoryBlock(
        "gh api repos/syamaner/roastpilot-cloud/actions/workflows/123/disable # first.yml",
        "disable",
      ),
    ).toThrow("Inventory has no disable lines");
    expect(() =>
      filenameIdMap(
        [
          { id: "123", action: "disable", filename: "first.yml" },
          { id: "123", action: "disable", filename: "second.yml" },
        ],
        "Fixture",
      ),
    ).toThrow(
      "Fixture inventory reuses workflow ID 123 for first.yml and second.yml",
    );
    expect(() =>
      assertGatedMappings(
        new Map([["first.yml", "123"]]),
        new Map<string, string>(),
        ["first.yml"],
      ),
    ).toThrow("Missing enable workflow ID mapping for first.yml");
    expect(() =>
      assertExactInventoryFilenames(
        new Map([
          ["gated.yml", "123"],
          ["stale.yml", "456"],
        ]),
        "Fixture",
        ["gated.yml"],
      ),
    ).toThrow(
      "Fixture inventory contains stale or non-gated workflow stale.yml",
    );
  });
});
