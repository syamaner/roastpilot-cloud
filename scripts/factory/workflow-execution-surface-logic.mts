/**
 * Bounded ordinary-run workflow canonicalization for factory issue #120.
 *
 * This module describes static shell execution only. Delegated actions,
 * reusable workflows, expression producers, and containers fail closed until
 * slice 120d-1b models them. This module never authorizes execution.
 */

import {
  LineCounter,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  type Node,
  type Pair,
} from "yaml";

export const MAX_WORKFLOW_SOURCE_BYTES = 1_048_576;
export const MAX_WORKFLOW_JOBS = 256;
export const MAX_WORKFLOW_STEPS = 2_048;
export const MAX_WORKFLOW_BINDINGS = 4_096;
export const MAX_WORKFLOW_ALIASES = 100;
export const MAX_RUN_CHARACTERS = 21_000;
export const MAX_CANONICAL_EVIDENCE_BYTES = 1_048_576;
export const MAX_WORKFLOW_PATH_BYTES = 4_096;
export const MAX_WORKFLOW_IDENTIFIER_BYTES = 1_024;
export const MAX_WORKFLOW_VIOLATIONS = 256;
export const MAX_WORKFLOW_VIOLATION_BYTES = 1_048_576;

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

type BindingScope = "workflow" | "job" | "step";
type ScalarValue = string | number | boolean;

/**
 * One canonical static environment binding.
 */
export interface WorkflowBindingEvidence {
  readonly name: string;
  readonly value: ScalarValue;
  readonly scope: BindingScope;
}

/**
 * One effective shell or working-directory value and its precedence source.
 */
export type WorkflowEffectiveField =
  | { readonly source: "implicit" }
  | {
      readonly source: "workflow-default" | "job-default" | "step";
      readonly value: string;
    };

/**
 * Canonical static ordinary-run step evidence.
 */
export interface WorkflowRunStepEvidence {
  readonly index: number;
  readonly line: number;
  readonly id?: string;
  readonly name?: string;
  readonly continueOnError?: boolean;
  readonly timeoutMinutes?: number;
  readonly environment: readonly WorkflowBindingEvidence[];
  readonly run: string;
  readonly shell: WorkflowEffectiveField;
  readonly workingDirectory: WorkflowEffectiveField;
}

/**
 * Canonical static ordinary-run job evidence.
 */
export interface WorkflowRunJobEvidence {
  readonly id: string;
  readonly line: number;
  readonly runnerLabels: readonly string[];
  readonly environment: readonly WorkflowBindingEvidence[];
  readonly steps: readonly WorkflowRunStepEvidence[];
}

/**
 * Complete canonical ordinary-run surface for one workflow.
 */
export interface WorkflowExecutionSurfaceEvidence {
  readonly workflowPath: string;
  readonly trigger: string;
  readonly workflowName: string | null;
  readonly workflowEnvironment: readonly WorkflowBindingEvidence[];
  readonly jobs: readonly WorkflowRunJobEvidence[];
}

/**
 * One fail-closed workflow execution-surface violation.
 */
export interface WorkflowExecutionSurfaceViolation {
  readonly kind:
    | "invalid-yaml"
    | "resource-limit"
    | "unsupported-execution-shape";
  readonly line: number;
  readonly subject: string;
  readonly detail: string;
}

/**
 * Canonicalization result. Evidence is absent whenever any violation exists.
 */
export interface WorkflowExecutionSurfaceResult {
  readonly evidence?: WorkflowExecutionSurfaceEvidence;
  readonly violations: readonly WorkflowExecutionSurfaceViolation[];
}

type Defaults = {
  readonly shell?: string;
  readonly workingDirectory?: string;
};
type SourceLocation = {
  readonly line: number;
  readonly stepLines: readonly number[];
};
type ViolationAccumulator = {
  readonly entries: WorkflowExecutionSurfaceViolation[];
  jsonBytes: number;
  saturated: boolean;
};

const EXPRESSION_MARKER = "${{";
const WORKFLOW_PATH_PREFIX = ".github/workflows/";
const JOB_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const WORKFLOW_KEYS = new Set([
  "defaults",
  "env",
  "jobs",
  "name",
  "on",
  "run-name",
]);
const JOB_KEYS = new Set([
  "defaults",
  "env",
  "name",
  "runs-on",
  "steps",
]);
const STEP_KEYS = new Set([
  "continue-on-error",
  "env",
  "id",
  "name",
  "run",
  "shell",
  "timeout-minutes",
  "working-directory",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isWorkflowPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value, "utf8") > MAX_WORKFLOW_PATH_BYTES ||
    !value.startsWith(WORKFLOW_PATH_PREFIX)
  ) {
    return false;
  }
  const fileName = value.slice(WORKFLOW_PATH_PREFIX.length);
  const extension = fileName.endsWith(".yaml")
    ? ".yaml"
    : fileName.endsWith(".yml")
      ? ".yml"
      : undefined;
  return (
    extension !== undefined &&
    fileName.length > extension.length &&
    !fileName.includes("/") &&
    !fileName.includes("\\") &&
    !fileName.includes("\0")
  );
}

function boundedJsonByteLength(value: unknown, limit: number): number {
  const stringLengths = new Map<string, number>();
  const stringLength = (text: string): number => {
    const cached = stringLengths.get(text);
    if (cached !== undefined) {
      return cached;
    }
    const length = Buffer.byteLength(JSON.stringify(text), "utf8");
    stringLengths.set(text, length);
    return length;
  };
  const measure = (item: unknown): number => {
    if (item === null) {
      return 4;
    }
    if (typeof item === "string") {
      return stringLength(item);
    }
    if (typeof item === "number" || typeof item === "boolean") {
      return Buffer.byteLength(String(item), "utf8");
    }
    if (Array.isArray(item)) {
      let length = 2;
      for (const [index, entry] of item.entries()) {
        length += (index === 0 ? 0 : 1) + measure(entry);
        if (length > limit) {
          return limit + 1;
        }
      }
      return length;
    }
    /* v8 ignore else -- canonical evidence contains only JSON objects here. */
    if (isRecord(item)) {
      let length = 2;
      let propertyCount = 0;
      for (const [key, entry] of Object.entries(item)) {
        /* v8 ignore next -- canonical evidence omits optional properties. */
        if (entry === undefined) {
          continue;
        }
        length +=
          (propertyCount === 0 ? 0 : 1) +
          stringLength(key) +
          1 +
          measure(entry);
        propertyCount += 1;
        if (length > limit) {
          return limit + 1;
        }
      }
      return length;
    }
    /* v8 ignore next -- canonical evidence contains JSON values only. */
    throw new TypeError("canonical evidence contains a non-JSON value");
  };
  return measure(value);
}

function createViolationAccumulator(): ViolationAccumulator {
  return { entries: [], jsonBytes: 2, saturated: false };
}

function addViolation(
  accumulator: ViolationAccumulator,
  violation: WorkflowExecutionSurfaceViolation,
): void {
  if (accumulator.saturated) {
    return;
  }
  const separatorBytes = accumulator.entries.length === 0 ? 0 : 1;
  const remainingBytes =
    MAX_WORKFLOW_VIOLATION_BYTES -
    accumulator.jsonBytes -
    separatorBytes;
  const violationBytes =
    remainingBytes < 0
      ? remainingBytes + 1
      : boundedJsonByteLength(violation, remainingBytes);
  if (
    accumulator.entries.length >= MAX_WORKFLOW_VIOLATIONS ||
    violationBytes > remainingBytes
  ) {
    const marker: WorkflowExecutionSurfaceViolation = {
      kind: "resource-limit",
      line: 1,
      subject: "<workflow>",
      detail: "workflow violation diagnostics exceed the bounded output budget",
    };
    accumulator.entries.splice(0, accumulator.entries.length, marker);
    accumulator.jsonBytes = boundedJsonByteLength(
      accumulator.entries,
      MAX_WORKFLOW_VIOLATION_BYTES,
    );
    accumulator.saturated = true;
    return;
  }
  accumulator.entries.push(violation);
  accumulator.jsonBytes += separatorBytes + violationBytes;
}

function isCanonicalIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    JOB_ID_PATTERN.test(value) &&
    Buffer.byteLength(value, "utf8") <= MAX_WORKFLOW_IDENTIFIER_BYTES
  );
}

function nodeLine(node: Node, lineCounter: LineCounter): number {
  /* v8 ignore next -- every parsed YAML node has a source range. */
  return lineCounter.linePos(node.range![0]).line;
}

function pairKey(
  pair: Pair,
  resolveAlias: (node: Node) => Node | undefined,
): string | undefined {
  /* v8 ignore next -- parsed mapping keys are Nodes; empty keys are YAML errors. */
  if (!isNode(pair.key)) {
    return undefined;
  }
  const key = resolveAlias(pair.key);
  return isScalar(key) && typeof key.value === "string"
    ? key.value
    : undefined;
}

function sourceLocations(
  document: ReturnType<typeof parseDocument>,
  lineCounter: LineCounter,
): ReadonlyMap<string, SourceLocation> {
  const locations = new Map<string, SourceLocation>();
  const resolveAlias = (node: Node): Node | undefined =>
    isAlias(node) ? node.resolve(document) : node;
  /* v8 ignore next -- the semantic workflow check guarantees a Node root. */
  const root = isNode(document.contents)
    ? resolveAlias(document.contents)
    : undefined;
  /* v8 ignore next -- the semantic workflow check guarantees a mapping root. */
  if (!isMap(root)) {
    return locations;
  }
  const jobsPair = root.items.find(
    (pair) => pairKey(pair, resolveAlias) === "jobs",
  );
  /* v8 ignore next -- the semantic jobs check guarantees this pair and Node value. */
  const jobs =
    jobsPair && isNode(jobsPair.value)
      ? resolveAlias(jobsPair.value)
      : undefined;
  /* v8 ignore next -- the semantic jobs check guarantees a mapping node. */
  if (!isMap(jobs)) {
    return locations;
  }
  const jobsLine = nodeLine(jobs, lineCounter);
  for (const pair of jobs.items) {
    const id = pairKey(pair, resolveAlias);
    if (!id || id === "<<") {
      continue;
    }
    /* v8 ignore next -- parsed mapping values are Nodes; null uses Scalar(null). */
    const jobNode = isNode(pair.value)
      ? resolveAlias(pair.value)
      : undefined;
    /* v8 ignore next -- parsed mapping values are Nodes; null uses Scalar(null). */
    const line = isNode(pair.value)
      ? nodeLine(pair.value, lineCounter)
      : jobsLine;
    const stepLines: number[] = [];
    if (isMap(jobNode)) {
      const stepsPair = jobNode.items.find(
        (item) => pairKey(item, resolveAlias) === "steps",
      );
      const steps =
        stepsPair && isNode(stepsPair.value)
          ? resolveAlias(stepsPair.value)
          : undefined;
      if (isSeq(steps)) {
        for (const item of steps.items) {
          /* v8 ignore next -- parsed sequence values use Scalar(null), not null. */
          stepLines.push(
            isNode(item) ? nodeLine(item, lineCounter) : line,
          );
        }
      }
    }
    locations.set(id, { line, stepLines });
  }
  return locations;
}

function scalarValue(value: unknown): ScalarValue | undefined {
  if (
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0)
    ? value
    : undefined;
}

function containsExpression(value: string): boolean {
  return value.includes(EXPRESSION_MARKER);
}

function canonicalBindings(
  value: unknown,
  scope: BindingScope,
  subject: string,
  line: number,
  violations: ViolationAccumulator,
): readonly WorkflowBindingEvidence[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    addViolation(violations, {
      kind: "unsupported-execution-shape",
      line,
      subject,
      detail: "environment must be a mapping of static scalar values",
    });
    return undefined;
  }
  const bindings: WorkflowBindingEvidence[] = [];
  const caseFoldedNames = new Set<string>();
  for (const name of Object.keys(value).sort()) {
    const isPortableName = ENVIRONMENT_NAME_PATTERN.test(name);
    const caseFoldedName = isPortableName
      ? name.toUpperCase()
      : undefined;
    const hasCaseCollision =
      caseFoldedName !== undefined &&
      caseFoldedNames.has(caseFoldedName);
    if (caseFoldedName !== undefined) {
      caseFoldedNames.add(caseFoldedName);
    }
    if (!isPortableName || hasCaseCollision) {
      addViolation(violations, {
        kind: "unsupported-execution-shape",
        line,
        subject,
        detail:
          "environment binding names must be portable ASCII and unique under case-insensitive runner semantics",
      });
      continue;
    }
    const scalar = scalarValue(value[name]);
    if (
      scalar === undefined ||
      (typeof scalar === "string" && containsExpression(scalar))
    ) {
      addViolation(violations, {
        kind: "unsupported-execution-shape",
        line,
        subject,
        detail: `binding ${JSON.stringify(name)} must have a static, injective scalar value`,
      });
      continue;
    }
    bindings.push({ name, value: scalar, scope });
  }
  return bindings;
}

function mergeEnvironment(
  line: number,
  subject: string,
  violations: ViolationAccumulator,
  ...levels: readonly (readonly WorkflowBindingEvidence[])[]
): readonly WorkflowBindingEvidence[] | undefined {
  const effective = new Map<string, WorkflowBindingEvidence>();
  for (const bindings of levels) {
    for (const binding of bindings) {
      effective.set(binding.name, binding);
    }
  }
  const namesByCaseFold = new Map<string, string>();
  for (const name of effective.keys()) {
    const caseFoldedName = name.toUpperCase();
    const priorName = namesByCaseFold.get(caseFoldedName);
    if (priorName !== undefined && priorName !== name) {
      addViolation(violations, {
        kind: "unsupported-execution-shape",
        line,
        subject,
        detail:
          "effective environment binding names must be unique under case-insensitive runner semantics",
      });
      return undefined;
    }
    namesByCaseFold.set(caseFoldedName, name);
  }
  return [...effective.values()].sort((left, right) => {
    /* v8 ignore next -- Map keys are unique, so equal names cannot be compared. */
    return left.name < right.name
      ? -1
      : left.name > right.name
        ? 1
        : 0;
  });
}

function staticNonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    !containsExpression(value)
    ? value
    : undefined;
}

function parseDefaults(
  value: unknown,
  subject: string,
  line: number,
  violations: ViolationAccumulator,
): Defaults | undefined {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value) || !isRecord(value.run)) {
    addViolation(violations, {
      kind: "unsupported-execution-shape",
      line,
      subject,
      detail: "defaults must contain a run mapping",
    });
    return undefined;
  }
  if (
    Object.keys(value).some((key) => key !== "run") ||
    Object.keys(value.run).some(
      (key) => key !== "shell" && key !== "working-directory",
    )
  ) {
    addViolation(violations, {
      kind: "unsupported-execution-shape",
      line,
      subject,
      detail: "defaults contains an unknown execution field",
    });
  }
  const shell = value.run.shell;
  const workingDirectory = value.run["working-directory"];
  const canonicalShell =
    shell === undefined ? undefined : staticNonEmptyText(shell);
  const canonicalWorkingDirectory =
    workingDirectory === undefined
      ? undefined
      : staticNonEmptyText(workingDirectory);
  if (
    (shell !== undefined && canonicalShell === undefined) ||
    (workingDirectory !== undefined &&
      canonicalWorkingDirectory === undefined)
  ) {
    addViolation(violations, {
      kind: "unsupported-execution-shape",
      line,
      subject,
      detail: "default shell and working-directory must be static non-empty strings",
    });
    return undefined;
  }
  return {
    shell: canonicalShell,
    workingDirectory: canonicalWorkingDirectory,
  };
}

function effectiveField(
  stepValue: unknown,
  jobValue: string | undefined,
  workflowValue: string | undefined,
): WorkflowEffectiveField | undefined {
  if (stepValue !== undefined) {
    const value = staticNonEmptyText(stepValue);
    return value === undefined
      ? undefined
      : { source: "step", value };
  }
  if (jobValue !== undefined) {
    return { source: "job-default", value: jobValue };
  }
  return workflowValue === undefined
    ? { source: "implicit" }
    : { source: "workflow-default", value: workflowValue };
}

function runnerLabels(
  value: unknown,
  subject: string,
  line: number,
  violations: ViolationAccumulator,
): readonly string[] | undefined {
  const labels =
    typeof value === "string"
      ? [value]
      : Array.isArray(value) &&
          value.every((label) => typeof label === "string")
        ? value
        : undefined;
  if (
    labels === undefined ||
    labels.length === 0 ||
    labels.some(
      (label) => staticNonEmptyText(label) === undefined,
    )
  ) {
    addViolation(violations, {
      kind: "unsupported-execution-shape",
      line,
      subject,
      detail: "runs-on must contain only static non-empty labels",
    });
    return undefined;
  }
  return [...labels];
}

function optionalStepFields(
  step: Record<string, unknown>,
  subject: string,
  line: number,
  violations: ViolationAccumulator,
): Pick<
  WorkflowRunStepEvidence,
  "continueOnError" | "id" | "name" | "timeoutMinutes"
> | undefined {
  const id = step.id;
  const name = step.name;
  const continueOnError = step["continue-on-error"];
  const timeoutMinutes = step["timeout-minutes"];
  if (
    (id !== undefined && !isCanonicalIdentifier(id)) ||
    (name !== undefined && typeof name !== "string") ||
    (continueOnError !== undefined &&
      typeof continueOnError !== "boolean") ||
    (timeoutMinutes !== undefined &&
      (typeof timeoutMinutes !== "number" ||
        !Number.isSafeInteger(timeoutMinutes) ||
        timeoutMinutes <= 0))
  ) {
    addViolation(violations, {
      kind: "unsupported-execution-shape",
      line,
      subject,
      detail: "step id, name, continue-on-error, or timeout-minutes has an unsupported shape",
    });
    return undefined;
  }
  return {
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(continueOnError === undefined ? {} : { continueOnError }),
    ...(timeoutMinutes === undefined ? {} : { timeoutMinutes }),
  };
}

/**
 * Canonicalize one workflow's static ordinary-run execution surface.
 *
 * @param workflowPath - Repository-relative path directly under `.github/workflows/`.
 * @param fileContent - Exact UTF-8 workflow source text.
 * @returns Canonical evidence, or fail-closed violations with no evidence.
 */
export function canonicalizeWorkflowExecutionSurface(
  workflowPath: string,
  fileContent: string,
): WorkflowExecutionSurfaceResult {
  if (!isWorkflowPath(workflowPath)) {
    return {
      violations: [
        {
          kind: "unsupported-execution-shape",
          line: 1,
          subject: "<workflow-path>",
          detail: "workflow path must be a bounded direct .github/workflows/*.yml or *.yaml path",
        },
      ],
    };
  }
  if (
    Buffer.byteLength(fileContent, "utf8") >
    MAX_WORKFLOW_SOURCE_BYTES
  ) {
    return {
      violations: [
        {
          kind: "resource-limit",
          line: 1,
          subject: "<workflow>",
          detail: `workflow source exceeds ${MAX_WORKFLOW_SOURCE_BYTES} UTF-8 bytes`,
        },
      ],
    };
  }

  const lineCounter = new LineCounter();
  const document = parseDocument(fileContent, {
    lineCounter,
    logLevel: "silent",
    merge: true,
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
    version: "1.2",
  });
  const parseProblems = [
    ...document.errors,
    ...document.warnings,
  ];
  if (parseProblems.length > 0) {
    const violations = createViolationAccumulator();
    for (const error of parseProblems) {
      addViolation(violations, {
        kind: "invalid-yaml",
        line: lineCounter.linePos(error.pos[0]).line,
        subject: "<workflow>",
        detail: `invalid YAML (${error.code}): ${error.message.split("\n")[0]}`,
      });
    }
    return { violations: violations.entries };
  }

  let workflow: unknown;
  try {
    workflow = document.toJS({
      // yaml rejects when its weighted count reaches this exclusive bound.
      maxAliasCount: MAX_WORKFLOW_ALIASES + 1,
    }) as unknown;
  } catch {
    const violations = createViolationAccumulator();
    addViolation(violations, {
      kind: "resource-limit",
      line: 1,
      subject: "<workflow>",
      detail:
        "workflow alias expansion is invalid or exceeds the bounded expansion limit",
    });
    return { violations: violations.entries };
  }
  if (!isRecord(workflow) || !isRecord(workflow.jobs)) {
    return {
      violations: [
        {
          kind: "unsupported-execution-shape",
          line: 1,
          subject: "<workflow>",
          detail: "workflow and jobs must be mappings",
        },
      ],
    };
  }
  if (
    Object.keys(workflow).some((key) => !WORKFLOW_KEYS.has(key)) ||
    (workflow.name !== undefined && typeof workflow.name !== "string") ||
    (workflow["run-name"] !== undefined &&
      typeof workflow["run-name"] !== "string")
  ) {
    return {
      violations: [
        {
          kind: "unsupported-execution-shape",
          line: 1,
          subject: "<workflow>",
          detail: "workflow contains an unknown or malformed top-level execution field",
        },
      ],
    };
  }
  const trigger = staticNonEmptyText(workflow.on);
  if (trigger === undefined) {
    return {
      violations: [
        {
          kind: "unsupported-execution-shape",
          line: 1,
          subject: "on",
          detail: "120d-1a supports exactly one static scalar trigger",
        },
      ],
    };
  }
  const workflowName =
    typeof workflow.name === "string" ? workflow.name : null;

  const jobIds = Object.keys(workflow.jobs).sort();
  if (jobIds.length === 0 || jobIds.length > MAX_WORKFLOW_JOBS) {
    return {
      violations: [
        {
          kind: "resource-limit",
          line: 1,
          subject: "jobs",
          detail:
            jobIds.length === 0
              ? "workflow must contain at least one job"
              : `workflow exceeds ${MAX_WORKFLOW_JOBS} jobs`,
        },
      ],
    };
  }

  const violations = createViolationAccumulator();
  const locations = sourceLocations(document, lineCounter);
  const workflowEnvironment =
    canonicalBindings(
      workflow.env,
      "workflow",
      "env",
      1,
      violations,
    ) ?? [];
  const workflowDefaults =
    parseDefaults(
      workflow.defaults,
      "defaults",
      1,
      violations,
    ) ?? {};
  const jobs: WorkflowRunJobEvidence[] = [];
  let totalSteps = 0;
  let totalBindings = workflowEnvironment.length;
  const recordBindings = (
    count: number,
    line: number,
    subject: string,
  ): boolean => {
    totalBindings += count;
    if (totalBindings <= MAX_WORKFLOW_BINDINGS) {
      return true;
    }
    addViolation(violations, {
      kind: "resource-limit",
      line,
      subject,
      detail: `canonical evidence exceeds ${MAX_WORKFLOW_BINDINGS} effective environment bindings`,
    });
    return false;
  };
  if (totalBindings > MAX_WORKFLOW_BINDINGS) {
    addViolation(violations, {
      kind: "resource-limit",
      line: 1,
      subject: "env",
      detail: `canonical evidence exceeds ${MAX_WORKFLOW_BINDINGS} effective environment bindings`,
    });
    return {
      violations: violations.entries,
    };
  }

  jobLoop: for (const id of jobIds) {
    if (violations.saturated) {
      break;
    }
    const location = locations.get(id) ?? { line: 1, stepLines: [] };
    const rawJob = workflow.jobs[id];
    if (!isCanonicalIdentifier(id)) {
      addViolation(violations, {
        kind: "unsupported-execution-shape",
        line: location.line,
        subject: "jobs",
        detail: `job id must be canonical and at most ${MAX_WORKFLOW_IDENTIFIER_BYTES} UTF-8 bytes`,
      });
      continue;
    }
    const subject = `jobs.${id}`;
    if (
      !isRecord(rawJob) ||
      (rawJob.name !== undefined && typeof rawJob.name !== "string")
    ) {
      addViolation(violations, {
        kind: "unsupported-execution-shape",
        line: location.line,
        subject,
        detail: "job value must use canonical mapping syntax",
      });
      continue;
    }
    if (Object.keys(rawJob).some((key) => !JOB_KEYS.has(key))) {
      addViolation(violations, {
        kind: "unsupported-execution-shape",
        line: location.line,
        subject,
        detail: "120d-1a rejects delegated or unmodeled job execution fields",
      });
      continue;
    }
    if (!Array.isArray(rawJob.steps)) {
      addViolation(violations, {
        kind: "unsupported-execution-shape",
        line: location.line,
        subject,
        detail: "ordinary job steps must be a sequence",
      });
      continue;
    }
    const labels = runnerLabels(
      rawJob["runs-on"],
      `${subject}.runs-on`,
      location.line,
      violations,
    );
    totalSteps += rawJob.steps.length;
    if (totalSteps > MAX_WORKFLOW_STEPS) {
      addViolation(violations, {
        kind: "resource-limit",
        line: location.line,
        subject,
        detail: `workflow exceeds ${MAX_WORKFLOW_STEPS} steps`,
      });
      break;
    }

    const jobEnvironment =
      canonicalBindings(
        rawJob.env,
        "job",
        `${subject}.env`,
        location.line,
        violations,
      ) ?? [];
    const effectiveJobEnvironment =
      mergeEnvironment(
        location.line,
        `${subject}.env`,
        violations,
        workflowEnvironment,
        jobEnvironment,
      ) ?? [];
    const jobDefaults =
      parseDefaults(
        rawJob.defaults,
        `${subject}.defaults`,
        location.line,
        violations,
      ) ?? {};
    if (
      !recordBindings(
        effectiveJobEnvironment.length,
        location.line,
        subject,
      )
    ) {
      break;
    }

    const steps: WorkflowRunStepEvidence[] = [];
    for (const [index, rawStep] of rawJob.steps.entries()) {
      if (violations.saturated) {
        break jobLoop;
      }
      const line = location.stepLines[index] ?? location.line;
      const stepSubject = `${subject}.steps[${index}]`;
      if (
        !isRecord(rawStep) ||
        Object.keys(rawStep).some((key) => !STEP_KEYS.has(key)) ||
        !Object.hasOwn(rawStep, "run")
      ) {
        addViolation(violations, {
          kind: "unsupported-execution-shape",
          line,
          subject: stepSubject,
          detail: "120d-1a supports only closed ordinary run-step fields",
        });
        continue;
      }
      const optional = optionalStepFields(
        rawStep,
        stepSubject,
        line,
        violations,
      );
      const stepEnvironment =
        canonicalBindings(
          rawStep.env,
          "step",
          `${stepSubject}.env`,
          line,
          violations,
        ) ?? [];
      const environment =
        mergeEnvironment(
          line,
          `${stepSubject}.env`,
          violations,
          effectiveJobEnvironment,
          stepEnvironment,
        ) ?? [];
      if (!recordBindings(environment.length, line, stepSubject)) {
        break jobLoop;
      }
      const run = staticNonEmptyText(rawStep.run);
      if (run === undefined) {
        addViolation(violations, {
          kind: "unsupported-execution-shape",
          line,
          subject: stepSubject,
          detail: "run must be a static non-empty string",
        });
        continue;
      }
      if ([...run].length > MAX_RUN_CHARACTERS) {
        addViolation(violations, {
          kind: "resource-limit",
          line,
          subject: stepSubject,
          detail: `run exceeds ${MAX_RUN_CHARACTERS} Unicode characters`,
        });
        continue;
      }
      const shell = effectiveField(
        rawStep.shell,
        jobDefaults.shell,
        workflowDefaults.shell,
      );
      const workingDirectory = effectiveField(
        rawStep["working-directory"],
        jobDefaults.workingDirectory,
        workflowDefaults.workingDirectory,
      );
      if (!shell || !workingDirectory) {
        addViolation(violations, {
          kind: "unsupported-execution-shape",
          line,
          subject: stepSubject,
          detail: "shell and working-directory must be static non-empty strings",
        });
        continue;
      }
      if (!optional) {
        continue;
      }
      steps.push({
        index,
        line,
        environment,
        run,
        shell,
        workingDirectory,
        ...optional,
      });
    }
    jobs.push({
      id,
      line: location.line,
      runnerLabels: labels ?? [],
      environment: effectiveJobEnvironment,
      steps,
    });
  }

  if (violations.entries.length > 0) {
    return { violations: violations.entries };
  }
  const evidence: WorkflowExecutionSurfaceEvidence = {
    workflowPath,
    trigger,
    workflowName,
    workflowEnvironment,
    jobs,
  };
  if (
    boundedJsonByteLength(evidence, MAX_CANONICAL_EVIDENCE_BYTES) >
    MAX_CANONICAL_EVIDENCE_BYTES
  ) {
    return {
      violations: [
        {
          kind: "resource-limit",
          line: 1,
          subject: "<workflow>",
          detail: `canonical evidence exceeds ${MAX_CANONICAL_EVIDENCE_BYTES} UTF-8 JSON bytes`,
        },
      ],
    };
  }
  return { evidence, violations: [] };
}
