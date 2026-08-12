import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";

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
]);
const PAUSE_BLOCK_CONJUNCT = "vars.FACTORY_PAUSED != 'true'";
const PAUSE_NOTICE_CONJUNCT = "vars.FACTORY_PAUSED == 'true'";
const PAUSE_NOTICE_ALLOWLIST: ReadonlyMap<string, ReadonlySet<string>> =
  new Map([
    ["triage-issues.yml", new Set(["pause-notice"])],
    ["implement-ready-issues.yml", new Set(["pause-notice"])],
  ]);
const PAUSE_NOTICE_JOB_KEYS = new Set([
  "if",
  "name",
  "runs-on",
  "permissions",
  "steps",
]);
const PAUSE_NOTICE_STEP_KEYS = new Set([
  "name",
  "run",
  "shell",
  "working-directory",
]);
const SECRET_CONTEXT_INTERPOLATION = /\$\{\{[^}]*\bsecrets\b/i;

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

function mappingHasKey(mapping: unknown, key: string): boolean {
  return (
    isMap(mapping) &&
    mapping.items.some(
      (pair) => isScalar(pair.key) && pair.key.value === key,
    )
  );
}

function mappingValue(mapping: unknown, key: string): unknown {
  if (!isMap(mapping)) return undefined;
  const pair = mapping.items.find(
    (candidate) =>
      isScalar(candidate.key) && candidate.key.value === key,
  );
  return pair?.value;
}

function firstDisallowedMappingKey(
  mapping: unknown,
  allowedKeys: ReadonlySet<string>,
): string | undefined {
  if (!isMap(mapping)) return "<non-mapping>";
  for (const pair of mapping.items) {
    const key =
      isScalar(pair.key) && typeof pair.key.value === "string"
        ? pair.key.value
        : "<non-string-key>";
    if (!allowedKeys.has(key)) return key;
  }
  return undefined;
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
        const extraJobKey = firstDisallowedMappingKey(
          job,
          PAUSE_NOTICE_JOB_KEYS,
        );
        const permissions = mappingValue(job, "permissions");
        const hasEmptyPermissions =
          isMap(permissions) && permissions.items.length === 0;
        const steps = mappingValue(job, "steps");
        const stepsHaveRun =
          isSeq(steps) &&
          steps.items.every(
            (step) => isMap(step) && mappingHasKey(step, "run"),
          );
        let extraStepKey: string | undefined;
        if (isSeq(steps) && stepsHaveRun) {
          for (const step of steps.items) {
            extraStepKey = firstDisallowedMappingKey(
              step,
              PAUSE_NOTICE_STEP_KEYS,
            );
            if (extraStepKey !== undefined) break;
          }
        }
        const hasSecretInterpolation =
          isSeq(steps) &&
          steps.items.some((step) => {
            const run = mappingValue(step, "run");
            return (
              isScalar(run) &&
              typeof run.value === "string" &&
              SECRET_CONTEXT_INTERPOLATION.test(run.value)
            );
          });

        if (!noticeAllowed) {
          reasons.push(`${reasonPrefix}:pause-notice-not-allowlisted`);
        } else if (extraJobKey !== undefined) {
          reasons.push(
            `${reasonPrefix}:pause-notice-extra-job-key:${extraJobKey}`,
          );
        } else if (!hasEmptyPermissions) {
          reasons.push(`${reasonPrefix}:pause-notice-permissions-not-empty`);
        } else if (!stepsHaveRun) {
          reasons.push(`${reasonPrefix}:pause-notice-steps-not-run-only`);
        } else if (extraStepKey !== undefined) {
          reasons.push(
            `${reasonPrefix}:pause-notice-step-extra-key:${extraStepKey}`,
          );
        } else if (hasSecretInterpolation) {
          reasons.push(
            `${reasonPrefix}:pause-notice-step-secret-interpolation`,
          );
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
// Parse-based and fail-closed: every job needs the byte-exact top-level
// `vars.FACTORY_PAUSED != 'true'` conjunct, except the inverse-gated
// `pause-notice` allowlist. As defense in depth, that exemption restricts the
// job/step key-shape (rejecting env/secrets/environment/container, job uses, and
// step env/with), requires permissions: {} plus run-only steps, and rejects
// direct or nested secrets-context interpolation found in run text. This scan
// does not prove inertness: workflow-level env inheritance, format()/fromJSON()
// secret access, and unvalidated runs-on values are residuals tracked for a
// definitive byte-pin in #259. The authoritative guarantee is structural: an
// allowlisted notice edit is a protected .github/workflows/** change drawing the
// factory-security-reviewer lens, while a full halt disables the inventoried
// workflow entirely. Changing this detector under tests/factory/** draws that
// lens too; triage's notice `if:` also has a byte-pin.
const gatedWorkflows = workflowFiles.filter((filename) => {
  const text = workflowTexts.get(filename);
  return text !== undefined && classifyWorkflow(filename, text).gated;
});

describe("factory halt and resume inventory", () => {
  it("pins the exact live set of FACTORY_PAUSED-gated workflows", () => {
    expect(gatedWorkflows).toEqual([
      "codex-verdict-status.yml",
      "implement-ready-issues.yml",
      "owner-command-intake.yml",
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

  it("F10 rejects an otherwise valid notice-only workflow", () => {
    const classification = classifyWorkflow(
      "triage-issues.yml",
      `jobs:
  pause-notice:
    if: vars.FACTORY_PAUSED == 'true'
    permissions: {}
    steps:
      - run: echo paused
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

  it("F12 rejects structurally unsafe allowlisted notice jobs", () => {
    const withUses = classifyWorkflow(
      "triage-issues.yml",
      `jobs:
  blocked:
    if: vars.FACTORY_PAUSED != 'true'
  pause-notice:
    if: vars.FACTORY_PAUSED == 'true'
    permissions: {}
    steps:
      - uses: example/action@0123456789abcdef
`,
    );
    const withoutEmptyPermissions = classifyWorkflow(
      "triage-issues.yml",
      `jobs:
  blocked:
    if: vars.FACTORY_PAUSED != 'true'
  pause-notice:
    if: vars.FACTORY_PAUSED == 'true'
    steps:
      - run: echo paused
`,
    );

    expect(withUses.gated).toBe(false);
    expect(withUses.reasons).toContain(
      "job:pause-notice:pause-notice-steps-not-run-only",
    );
    expect(withoutEmptyPermissions.gated).toBe(false);
    expect(withoutEmptyPermissions.reasons).toContain(
      "job:pause-notice:pause-notice-permissions-not-empty",
    );
  });

  it("F13 rejects an allowlisted notice job carrying job-level env", () => {
    const classification = classifyWorkflow(
      "triage-issues.yml",
      `jobs:
  blocked:
    if: vars.FACTORY_PAUSED != 'true'
  pause-notice:
    if: vars.FACTORY_PAUSED == 'true'
    permissions: {}
    env:
      SECRET_VALUE: secret
    steps:
      - run: echo paused
`,
    );

    expect(classification.gated).toBe(false);
    expect(classification.reasons).toContain(
      "job:pause-notice:pause-notice-extra-job-key:env",
    );
  });

  it("F14 rejects an allowlisted notice step carrying env", () => {
    const classification = classifyWorkflow(
      "triage-issues.yml",
      `jobs:
  blocked:
    if: vars.FACTORY_PAUSED != 'true'
  pause-notice:
    if: vars.FACTORY_PAUSED == 'true'
    permissions: {}
    steps:
      - run: echo paused
        env:
          SECRET_VALUE: secret
`,
    );

    expect(classification.gated).toBe(false);
    expect(classification.reasons).toContain(
      "job:pause-notice:pause-notice-step-extra-key:env",
    );
  });

  it("F15 rejects an allowlisted notice job carrying environment", () => {
    const classification = classifyWorkflow(
      "triage-issues.yml",
      `jobs:
  blocked:
    if: vars.FACTORY_PAUSED != 'true'
  pause-notice:
    if: vars.FACTORY_PAUSED == 'true'
    permissions: {}
    environment: production
    steps:
      - run: echo paused
`,
    );

    expect(classification.gated).toBe(false);
    expect(classification.reasons).toContain(
      "job:pause-notice:pause-notice-extra-job-key:environment",
    );
  });

  it("F16 accepts the live inert notice key-shape beside a blocked job", () => {
    const classification = classifyWorkflow(
      "triage-issues.yml",
      `jobs:
  blocked:
    if: vars.FACTORY_PAUSED != 'true'
  pause-notice:
    name: Factory pause notice
    if: vars.FACTORY_PAUSED == 'true'
    runs-on: ubuntu-latest
    permissions: {}
    steps:
      - name: Announce that the factory is paused
        run: echo paused
`,
    );

    expect(classification).toEqual({ gated: true, reasons: [] });
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

  it("F21 rejects secrets-context interpolation in a notice run", () => {
    const classification = classifyWorkflow(
      "triage-issues.yml",
      `jobs:
  blocked:
    if: vars.FACTORY_PAUSED != 'true'
  pause-notice:
    if: vars.FACTORY_PAUSED == 'true'
    permissions: {}
    steps:
      - run: echo \${{ secrets.FOO }}
`,
    );

    expect(classification.gated).toBe(false);
    expect(classification.reasons).toContain(
      "job:pause-notice:pause-notice-step-secret-interpolation",
    );
  });

  it("F22 accepts benign github-context interpolation in a notice run", () => {
    const classification = classifyWorkflow(
      "triage-issues.yml",
      `jobs:
  blocked:
    if: vars.FACTORY_PAUSED != 'true'
  pause-notice:
    if: vars.FACTORY_PAUSED == 'true'
    permissions: {}
    steps:
      - run: echo \${{ github.repository }}
`,
    );

    expect(classification).toEqual({ gated: true, reasons: [] });
  });

  it("F23 rejects nested secrets context in a notice run", () => {
    const classification = classifyWorkflow(
      "triage-issues.yml",
      `jobs:
  blocked:
    if: vars.FACTORY_PAUSED != 'true'
  pause-notice:
    if: vars.FACTORY_PAUSED == 'true'
    permissions: {}
    steps:
      - run: echo \${{ toJSON(secrets) }}
`,
    );

    expect(classification.gated).toBe(false);
    expect(classification.reasons).toContain(
      "job:pause-notice:pause-notice-step-secret-interpolation",
    );
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
