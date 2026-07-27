/**
 * Bounded ordinary-run workflow/context canonicalization for issue #120.
 *
 * This module describes ordinary run steps and their exact context producers.
 * Delegated actions, reusable workflows, and containers fail closed until
 * later 120d-1b slices model them. This module never authorizes execution.
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

import {
  WorkflowCanonicalValueBuilder,
  type WorkflowCanonicalValue,
} from "./workflow-canonical-value-logic.mts";
import {
  resolveEffectiveWorkflowPermissions,
  type EffectiveWorkflowPermissionsEvidence,
} from "./workflow-permissions-logic.mts";

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
const MAX_EXPANDED_YAML_PREFLIGHT_NODES = 65_536;
const MAX_EXPANDED_YAML_PREFLIGHT_DEPTH = 64;

type BindingScope = "workflow" | "job" | "step";
type ScalarValue = string | number | boolean;

/**
 * Exact opaque condition evidence. It never proves a step cannot execute.
 */
export type WorkflowConditionEvidence =
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "integer"; readonly value: number }
  | {
      readonly kind: "string";
      readonly spelling: "bare" | "template" | "wrapped";
      readonly value: string;
    };

/**
 * One canonical environment binding with exact opaque scalar content.
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
 * Canonical ordinary-run step evidence.
 */
export interface WorkflowRunStepEvidence {
  readonly index: number;
  readonly line: number;
  readonly id?: string;
  readonly name?: string;
  readonly condition?: WorkflowConditionEvidence;
  readonly continueOnError?: WorkflowConditionEvidence;
  readonly timeoutMinutes?: WorkflowConditionEvidence;
  readonly environment: readonly WorkflowBindingEvidence[];
  readonly run: string;
  readonly shell: WorkflowEffectiveField;
  readonly workingDirectory: WorkflowEffectiveField;
}

/**
 * Canonical ordinary-run job/context evidence.
 */
export interface WorkflowRunJobEvidence {
  readonly id: string;
  readonly line: number;
  readonly name: string | null;
  readonly runner: WorkflowCanonicalValue;
  readonly permissions: EffectiveWorkflowPermissionsEvidence;
  readonly concurrency?: WorkflowCanonicalValue;
  readonly needs?: WorkflowCanonicalValue;
  readonly condition?: WorkflowConditionEvidence;
  readonly strategy?: WorkflowCanonicalValue;
  readonly outputs?: WorkflowCanonicalValue;
  readonly deploymentEnvironment?: WorkflowCanonicalValue;
  readonly continueOnError?: WorkflowConditionEvidence;
  readonly timeoutMinutes?: WorkflowConditionEvidence;
  readonly environment: readonly WorkflowBindingEvidence[];
  readonly steps: readonly WorkflowRunStepEvidence[];
}

/**
 * Complete canonical ordinary-run/context surface for one workflow.
 */
export interface WorkflowExecutionSurfaceEvidence {
  readonly workflowPath: string;
  readonly trigger: WorkflowCanonicalValue;
  readonly workflowName: string | null;
  readonly runName: string | null;
  readonly concurrency?: WorkflowCanonicalValue;
  readonly workflowEnvironment: readonly WorkflowBindingEvidence[];
  readonly canonicalValueCount: number;
  readonly canonicalValueDepth: number;
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
  "concurrency",
  "defaults",
  "env",
  "jobs",
  "name",
  "on",
  "permissions",
  "run-name",
]);
const JOB_KEYS = new Set([
  "concurrency",
  "continue-on-error",
  "defaults",
  "env",
  "environment",
  "if",
  "name",
  "needs",
  "outputs",
  "permissions",
  "runs-on",
  "steps",
  "strategy",
  "timeout-minutes",
]);
const STEP_KEYS = new Set([
  "continue-on-error",
  "env",
  "id",
  "if",
  "name",
  "run",
  "shell",
  "timeout-minutes",
  "working-directory",
]);
const TRIGGER_EVENTS_WITH_OPTIONAL_CONFIGURATION = new Set([
  "branch_protection_rule",
  "check_run",
  "check_suite",
  "create",
  "delete",
  "deployment",
  "deployment_status",
  "discussion",
  "discussion_comment",
  "fork",
  "gollum",
  "issue_comment",
  "issues",
  "label",
  "merge_group",
  "milestone",
  "page_build",
  "project",
  "project_card",
  "project_column",
  "public",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_target",
  "push",
  "registry_package",
  "release",
  "repository_dispatch",
  "status",
  "watch",
  "workflow_call",
  "workflow_dispatch",
  "workflow_run",
]);
const IMAGE_VERSION_KEYS = new Set(["names", "versions"]);
const SCHEDULE_KEYS = new Set(["cron", "timezone"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isStringKeyedMap(value: unknown): value is Map<string, unknown> {
  return (
    value instanceof Map &&
    [...value.keys()].every((key) => typeof key === "string")
  );
}

function exactNonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0
    ? value
    : undefined;
}

function conditionEvidence(
  value: unknown,
): WorkflowConditionEvidence | undefined {
  if (typeof value === "boolean") {
    return { kind: "boolean", value };
  }
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Number.isFinite(value) &&
    !Object.is(value, -0)
  ) {
    return { kind: "integer", value };
  }
  const text = exactNonEmptyText(value);
  if (text === undefined) {
    return undefined;
  }
  const trimmed = text.trim();
  const wrapped =
    trimmed.startsWith(EXPRESSION_MARKER) &&
    trimmed.endsWith("}}") &&
    trimmed.indexOf(EXPRESSION_MARKER, EXPRESSION_MARKER.length) ===
      -1 &&
    trimmed.indexOf("}}") === trimmed.length - 2;
  return {
    kind: "string",
    spelling: wrapped
      ? "wrapped"
      : text.includes(EXPRESSION_MARKER)
        ? "template"
        : "bare",
    value: text,
  };
}

function booleanExpressionEvidence(
  value: unknown,
): WorkflowConditionEvidence | undefined {
  const evidence = conditionEvidence(value);
  return evidence?.kind === "boolean" ||
    (evidence?.kind === "string" &&
      evidence.spelling !== "bare")
    ? evidence
    : undefined;
}

function timeoutEvidence(
  value: unknown,
): WorkflowConditionEvidence | undefined {
  const evidence = conditionEvidence(value);
  return evidence?.kind === "integer" && evidence.value > 0
    ? evidence
    : evidence?.kind === "string" &&
        evidence.spelling !== "bare"
      ? evidence
      : undefined;
}

function stepTimeoutEvidence(
  value: unknown,
): WorkflowConditionEvidence | undefined {
  const evidence = timeoutEvidence(value);
  return evidence?.kind === "integer" && evidence.value > 360
    ? undefined
    : evidence;
}

function canonicalContextValue(
  value: unknown,
  subject: string,
  line: number,
  builder: WorkflowCanonicalValueBuilder,
  violations: ViolationAccumulator,
): WorkflowCanonicalValue | undefined {
  const result = builder.canonicalize(value);
  if (result.kind !== "canonical") {
    addViolation(violations, {
      kind:
        result.kind === "resource-limit"
          ? "resource-limit"
          : "unsupported-execution-shape",
      line,
      subject,
      detail: result.detail,
    });
    if (result.kind === "resource-limit") {
      violations.saturated = true;
    }
    return undefined;
  }
  return result.value;
}

function canonicalConditionEvidence(
  value: unknown,
  subject: string,
  line: number,
  builder: WorkflowCanonicalValueBuilder,
  violations: ViolationAccumulator,
  parser: (input: unknown) => WorkflowConditionEvidence | undefined,
): WorkflowConditionEvidence | undefined {
  const violationCount = violations.entries.length;
  if (
    canonicalContextValue(
      value,
      subject,
      line,
      builder,
      violations,
    ) === undefined
  ) {
    return undefined;
  }
  const evidence = parser(value);
  if (
    evidence === undefined &&
    violations.entries.length === violationCount
  ) {
    addViolation(violations, {
      kind: "unsupported-execution-shape",
      line,
      subject,
      detail: "context scalar has an unsupported shape",
    });
  }
  return evidence;
}

function hasOnlyMapKeys(
  value: Map<string, unknown>,
  keys: ReadonlySet<string>,
): boolean {
  return [...value.keys()].every((key) => keys.has(key));
}

function normalizedTrigger(
  value: unknown,
): Map<string, unknown> | undefined {
  const events = new Map<string, unknown>();
  const addEvent = (event: unknown, configuration: unknown): boolean => {
    const name = staticNonEmptyText(event);
    if (
      name === undefined ||
      events.has(name) ||
      (name !== "image_version" &&
        name !== "schedule" &&
        !TRIGGER_EVENTS_WITH_OPTIONAL_CONFIGURATION.has(name))
    ) {
      return false;
    }
    if (name === "image_version") {
      if (
        !isStringKeyedMap(configuration) ||
        !hasOnlyMapKeys(configuration, IMAGE_VERSION_KEYS) ||
        !configuration.has("names") ||
        !configuration.has("versions") ||
        !["names", "versions"].every((key) => {
          const filters = configuration.get(key);
          return (
            Array.isArray(filters) &&
            filters.length > 0 &&
            filters.every(
              (filter) =>
                staticNonEmptyText(filter) !== undefined,
            )
          );
        })
      ) {
        return false;
      }
      events.set(name, configuration);
      return true;
    }
    if (name === "schedule") {
      if (
        !Array.isArray(configuration) ||
        configuration.length === 0 ||
        !configuration.every(
          (entry) =>
            isStringKeyedMap(entry) &&
            hasOnlyMapKeys(entry, SCHEDULE_KEYS) &&
            exactNonEmptyText(entry.get("cron")) !== undefined &&
            (entry.get("timezone") === undefined ||
              exactNonEmptyText(entry.get("timezone")) !==
                undefined),
        )
      ) {
        return false;
      }
      events.set(name, configuration);
      return true;
    }
    if (
      configuration !== null &&
      !isStringKeyedMap(configuration)
    ) {
      return false;
    }
    events.set(
      name,
      configuration instanceof Map && configuration.size === 0
        ? null
        : configuration,
    );
    return true;
  };
  if (typeof value === "string") {
    if (!addEvent(value, null)) {
      return undefined;
    }
  } else if (Array.isArray(value)) {
    for (const event of value) {
      if (!addEvent(event, null)) {
        return undefined;
      }
    }
  } else if (isStringKeyedMap(value)) {
    for (const [event, configuration] of value) {
      if (!addEvent(event, configuration)) {
        return undefined;
      }
    }
  } else {
    return undefined;
  }
  if (events.size === 0) {
    return undefined;
  }
  return new Map(
    [...events.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

const CONCURRENCY_KEYS = new Set([
  "cancel-in-progress",
  "group",
]);
const STRATEGY_KEYS = new Set([
  "fail-fast",
  "matrix",
  "max-parallel",
]);
const DEPLOYMENT_ENVIRONMENT_KEYS = new Set([
  "deployment",
  "name",
  "url",
]);

function normalizedConcurrency(
  value: unknown,
): Map<string, unknown> | undefined {
  const scalarGroup = exactNonEmptyText(value);
  if (scalarGroup !== undefined) {
    return new Map([["group", scalarGroup]]);
  }
  if (
    !isStringKeyedMap(value) ||
    !hasOnlyMapKeys(value, CONCURRENCY_KEYS) ||
    exactNonEmptyText(value.get("group")) === undefined
  ) {
    return undefined;
  }
  const cancel = value.get("cancel-in-progress");
  if (
    cancel !== undefined &&
    booleanExpressionEvidence(cancel) === undefined
  ) {
    return undefined;
  }
  return new Map([
    ["group", value.get("group")],
    ...(cancel === undefined || cancel === false
      ? []
      : [["cancel-in-progress", cancel] as const]),
  ]);
}

function normalizedRunner(
  value: unknown,
): readonly unknown[] | undefined {
  // 120a deliberately treats every non-string runner spelling as
  // credential-bearing; this evidence-only normalizer instead follows D133.
  const scalarLabel = exactNonEmptyText(value);
  if (scalarLabel !== undefined) {
    return [scalarLabel];
  }
  if (Array.isArray(value)) {
    return (
      value.length > 0 &&
      value.every((label) => exactNonEmptyText(label) !== undefined)
    )
      ? value
      : undefined;
  }
  return undefined;
}

function normalizedNeeds(
  value: unknown,
): readonly string[] | undefined {
  if (isCanonicalIdentifier(value)) {
    return [value];
  }
  return Array.isArray(value) &&
    value.length > 0 &&
    value.every(isCanonicalIdentifier)
    ? value
    : undefined;
}

function validStrategy(value: unknown): boolean {
  if (
    !isStringKeyedMap(value) ||
    !hasOnlyMapKeys(value, STRATEGY_KEYS) ||
    !value.has("matrix")
  ) {
    return false;
  }
  const matrix = value.get("matrix");
  const failFast = value.get("fail-fast");
  const maxParallel = value.get("max-parallel");
  return (
    (isStringKeyedMap(matrix) ||
      exactNonEmptyText(matrix) !== undefined) &&
    (failFast === undefined ||
      booleanExpressionEvidence(failFast) !== undefined) &&
    (maxParallel === undefined ||
      timeoutEvidence(maxParallel) !== undefined)
  );
}

function validOutputs(value: unknown): boolean {
  return (
    isStringKeyedMap(value) &&
    [...value.entries()].every(
      ([name, output]) =>
        isCanonicalIdentifier(name) &&
        exactNonEmptyText(output) !== undefined,
    )
  );
}

function normalizedDeploymentEnvironment(
  value: unknown,
): Map<string, unknown> | undefined {
  const scalarName = exactNonEmptyText(value);
  if (scalarName !== undefined) {
    return ENVIRONMENT_NAME_PATTERN.test(scalarName)
      ? new Map([["name", scalarName]])
      : undefined;
  }
  if (
    !isStringKeyedMap(value) ||
    !hasOnlyMapKeys(value, DEPLOYMENT_ENVIRONMENT_KEYS) ||
    exactNonEmptyText(value.get("name")) === undefined ||
    !ENVIRONMENT_NAME_PATTERN.test(
      exactNonEmptyText(value.get("name"))!,
    )
  ) {
    return undefined;
  }
  const url = value.get("url");
  const deployment = value.get("deployment");
  if (
    (url === undefined || exactNonEmptyText(url) !== undefined) &&
    (deployment === undefined ||
      booleanExpressionEvidence(deployment) !== undefined)
  ) {
    return new Map([
      ["name", value.get("name")],
      ...(url === undefined
        ? []
        : [["url", url] as const]),
      ...(deployment === undefined
        ? []
        : [["deployment", deployment] as const]),
    ]);
  }
  return undefined;
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

function expandedYamlPreflight(
  document: ReturnType<typeof parseDocument>,
): boolean {
  if (!isNode(document.contents)) {
    return true;
  }
  const stack: { readonly depth: number; readonly node: Node }[] = [
    { depth: 1, node: document.contents },
  ];
  let count = 0;
  try {
    while (stack.length > 0) {
      const current = stack.pop()!;
      count += 1;
      if (
        count > MAX_EXPANDED_YAML_PREFLIGHT_NODES ||
        current.depth > MAX_EXPANDED_YAML_PREFLIGHT_DEPTH
      ) {
        return false;
      }
      if (isAlias(current.node)) {
        const resolved = current.node.resolve(document);
        if (!isNode(resolved)) {
          return false;
        }
        stack.push({ depth: current.depth, node: resolved });
      } else if (isMap(current.node)) {
        for (const pair of current.node.items) {
          if (isNode(pair.value)) {
            stack.push({
              depth: current.depth + 1,
              node: pair.value,
            });
          }
          if (isNode(pair.key)) {
            stack.push({
              depth: current.depth + 1,
              node: pair.key,
            });
          }
        }
      } else if (isSeq(current.node)) {
        for (const item of current.node.items) {
          if (isNode(item)) {
            stack.push({
              depth: current.depth + 1,
              node: item,
            });
          }
        }
      }
    }
  } catch {
    /* v8 ignore next -- traversal uses only parser-owned Node accessors. */
    return false;
  }
  return true;
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
    if (scalar === undefined) {
      addViolation(violations, {
        kind: "unsupported-execution-shape",
        line,
        subject,
        detail: `binding ${JSON.stringify(name)} must have an injective scalar value`,
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
    const value = exactNonEmptyText(stepValue);
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

function optionalStepFields(
  step: Record<string, unknown>,
  subject: string,
  line: number,
  canonicalValues: WorkflowCanonicalValueBuilder,
  violations: ViolationAccumulator,
): Pick<
  WorkflowRunStepEvidence,
  | "condition"
  | "continueOnError"
  | "id"
  | "name"
  | "timeoutMinutes"
> | undefined {
  const id = step.id;
  const name = step.name;
  const condition =
    step.if === undefined
      ? undefined
      : canonicalConditionEvidence(
          step.if,
          `${subject}.if`,
          line,
          canonicalValues,
          violations,
          conditionEvidence,
        );
  const continueOnError = step["continue-on-error"];
  const timeoutMinutes = step["timeout-minutes"];
  const canonicalContinueOnError =
    continueOnError === undefined
      ? undefined
      : canonicalConditionEvidence(
          continueOnError,
          `${subject}.continue-on-error`,
          line,
          canonicalValues,
          violations,
          booleanExpressionEvidence,
        );
  const canonicalTimeout =
    timeoutMinutes === undefined
      ? undefined
      : canonicalConditionEvidence(
          timeoutMinutes,
          `${subject}.timeout-minutes`,
          line,
          canonicalValues,
          violations,
          stepTimeoutEvidence,
        );
  if (
    (id !== undefined && !isCanonicalIdentifier(id)) ||
    (name !== undefined && typeof name !== "string") ||
    (step.if !== undefined && condition === undefined) ||
    (continueOnError !== undefined &&
      canonicalContinueOnError === undefined) ||
    (timeoutMinutes !== undefined && canonicalTimeout === undefined)
  ) {
    addViolation(violations, {
      kind: "unsupported-execution-shape",
      line,
      subject,
      detail: "step id, name, if, continue-on-error, or timeout-minutes has an unsupported shape",
    });
    return undefined;
  }
  return {
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(condition === undefined ? {} : { condition }),
    ...(canonicalContinueOnError === undefined
      ? {}
      : { continueOnError: canonicalContinueOnError }),
    ...(canonicalTimeout === undefined
      ? {}
      : { timeoutMinutes: canonicalTimeout }),
  };
}

/**
 * Canonicalize one workflow's ordinary-run execution/context surface.
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
  if (!expandedYamlPreflight(document)) {
    return {
      violations: [
        {
          kind: "resource-limit",
          line: 1,
          subject: "<workflow>",
          detail:
            "expanded YAML exceeds the bounded pre-canonicalization budget",
        },
      ],
    };
  }

  let workflow: unknown;
  let structuredWorkflow: unknown;
  try {
    workflow = document.toJS({
      // yaml rejects when its weighted count reaches this exclusive bound.
      maxAliasCount: MAX_WORKFLOW_ALIASES + 1,
    }) as unknown;
    structuredWorkflow = document.toJS({
      mapAsMap: true,
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
  let structuredJobs: Map<string, unknown> | undefined;
  if (isStringKeyedMap(structuredWorkflow)) {
    const jobs = structuredWorkflow.get("jobs");
    if (isStringKeyedMap(jobs)) {
      structuredJobs = jobs;
    }
  }
  if (
    !isRecord(workflow) ||
    !isRecord(workflow.jobs) ||
    !isStringKeyedMap(structuredWorkflow) ||
    structuredJobs === undefined
  ) {
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
  const violations = createViolationAccumulator();
  const canonicalValues = new WorkflowCanonicalValueBuilder();
  const triggerInput = normalizedTrigger(structuredWorkflow.get("on"));
  const trigger =
    triggerInput === undefined
      ? undefined
      : canonicalContextValue(
          triggerInput,
          "on",
          1,
          canonicalValues,
          violations,
        );
  if (trigger === undefined) {
    if (violations.entries.length === 0) {
      addViolation(violations, {
        kind: "unsupported-execution-shape",
        line: 1,
        subject: "on",
        detail:
          "trigger must be a non-empty documented event declaration, including the closed schedule sequence grammar",
      });
    }
    return {
      violations: violations.entries,
    };
  }
  const workflowName =
    typeof workflow.name === "string" ? workflow.name : null;
  const runName =
    typeof workflow["run-name"] === "string"
      ? workflow["run-name"]
      : null;
  const normalizedWorkflowConcurrency =
    workflow.concurrency === undefined
      ? undefined
      : normalizedConcurrency(
          structuredWorkflow.get("concurrency"),
        );
  const workflowConcurrency =
    normalizedWorkflowConcurrency === undefined
      ? undefined
      : canonicalContextValue(
            normalizedWorkflowConcurrency,
            "concurrency",
            1,
            canonicalValues,
            violations,
          );
  if (
    workflow.concurrency !== undefined &&
    workflowConcurrency === undefined &&
    violations.entries.length === 0
  ) {
    addViolation(violations, {
      kind: "unsupported-execution-shape",
      line: 1,
      subject: "concurrency",
      detail: "workflow concurrency has an unsupported shape",
    });
  }
  const workflowPermissionResolution =
    resolveEffectiveWorkflowPermissions(
      workflow.permissions,
      { present: false },
    );
  if (workflowPermissionResolution.kind === "unanalyzable") {
    addViolation(violations, {
      kind: "unsupported-execution-shape",
      line: 1,
      subject: "permissions",
      detail: workflowPermissionResolution.detail,
    });
  }

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
  const deploymentNamesByCaseFold = new Map<string, string>();
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
    const structuredJob = structuredJobs.get(id);
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
      !isStringKeyedMap(structuredJob) ||
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
        detail: "120d-1b1 rejects delegated or unmodeled job execution fields",
      });
      continue;
    }
    const structuredSteps = structuredJob.get("steps");
    if (
      !Array.isArray(rawJob.steps) ||
      !Array.isArray(structuredSteps) ||
      structuredSteps.length !== rawJob.steps.length
    ) {
      addViolation(violations, {
        kind: "unsupported-execution-shape",
        line: location.line,
        subject,
        detail: "ordinary job steps must be a sequence",
      });
      continue;
    }
    const normalizedJobRunner = normalizedRunner(
      structuredJob.get("runs-on"),
    );
    const runner =
      normalizedJobRunner === undefined
        ? undefined
        : canonicalContextValue(
            normalizedJobRunner,
            `${subject}.runs-on`,
            location.line,
            canonicalValues,
            violations,
          );
    if (runner === undefined && violations.entries.length === 0) {
      addViolation(violations, {
        kind: "unsupported-execution-shape",
        line: location.line,
        subject: `${subject}.runs-on`,
        detail: "runs-on has an unsupported runner shape",
      });
    }
    const permissionResolution = resolveEffectiveWorkflowPermissions(
      workflow.permissions,
      Object.hasOwn(rawJob, "permissions")
        ? { present: true, value: rawJob.permissions }
        : { present: false },
    );
    if (permissionResolution.kind === "unanalyzable") {
      addViolation(violations, {
        kind: "unsupported-execution-shape",
        line: location.line,
        subject: `${subject}.permissions`,
        detail: permissionResolution.detail,
      });
    }

    const jobControlViolationCount = violations.entries.length;
    const normalizedJobConcurrency =
      rawJob.concurrency === undefined
        ? undefined
        : normalizedConcurrency(
            structuredJob.get("concurrency"),
          );
    const jobConcurrency =
      normalizedJobConcurrency === undefined
        ? undefined
        : canonicalContextValue(
              normalizedJobConcurrency,
              `${subject}.concurrency`,
              location.line,
              canonicalValues,
              violations,
            );
    const normalizedJobNeeds =
      rawJob.needs === undefined
        ? undefined
        : normalizedNeeds(structuredJob.get("needs"));
    const needs =
      normalizedJobNeeds === undefined
        ? undefined
        : canonicalContextValue(
              normalizedJobNeeds,
              `${subject}.needs`,
              location.line,
              canonicalValues,
              violations,
            );
    const condition =
      rawJob.if === undefined
        ? undefined
        : canonicalConditionEvidence(
            rawJob.if,
            `${subject}.if`,
            location.line,
            canonicalValues,
            violations,
            conditionEvidence,
          );
    const strategy =
      rawJob.strategy === undefined
        ? undefined
        : validStrategy(structuredJob.get("strategy"))
          ? canonicalContextValue(
              structuredJob.get("strategy"),
              `${subject}.strategy`,
              location.line,
              canonicalValues,
              violations,
            )
          : undefined;
    const outputs =
      rawJob.outputs === undefined
        ? undefined
        : validOutputs(structuredJob.get("outputs"))
          ? canonicalContextValue(
              structuredJob.get("outputs"),
              `${subject}.outputs`,
              location.line,
              canonicalValues,
              violations,
            )
          : undefined;
    const normalizedJobDeploymentEnvironment =
      rawJob.environment === undefined
        ? undefined
        : normalizedDeploymentEnvironment(
            structuredJob.get("environment"),
          );
    const deploymentEnvironment =
      normalizedJobDeploymentEnvironment === undefined
        ? undefined
        : canonicalContextValue(
              normalizedJobDeploymentEnvironment,
              `${subject}.environment`,
              location.line,
              canonicalValues,
              violations,
            );
    if (normalizedJobDeploymentEnvironment !== undefined) {
      const deploymentName = normalizedJobDeploymentEnvironment.get(
        "name",
      ) as string;
      const caseFoldedName = deploymentName.toUpperCase();
      const priorName =
        deploymentNamesByCaseFold.get(caseFoldedName);
      if (
        priorName !== undefined &&
        priorName !== deploymentName
      ) {
        addViolation(violations, {
          kind: "unsupported-execution-shape",
          line: location.line,
          subject: `${subject}.environment`,
          detail:
            "deployment environment names must be unique under case-insensitive runner semantics",
        });
      } else {
        deploymentNamesByCaseFold.set(
          caseFoldedName,
          deploymentName,
        );
      }
    }
    const continueOnError =
      rawJob["continue-on-error"] === undefined
        ? undefined
        : canonicalConditionEvidence(
            rawJob["continue-on-error"],
            `${subject}.continue-on-error`,
            location.line,
            canonicalValues,
            violations,
            booleanExpressionEvidence,
          );
    const timeoutMinutes =
      rawJob["timeout-minutes"] === undefined
        ? undefined
        : canonicalConditionEvidence(
            rawJob["timeout-minutes"],
            `${subject}.timeout-minutes`,
            location.line,
            canonicalValues,
            violations,
            timeoutEvidence,
          );
    const invalidJobControls = [
      [rawJob.concurrency, jobConcurrency],
      [rawJob.needs, needs],
      [rawJob.if, condition],
      [rawJob.strategy, strategy],
      [rawJob.outputs, outputs],
      [rawJob.environment, deploymentEnvironment],
      [rawJob["continue-on-error"], continueOnError],
      [rawJob["timeout-minutes"], timeoutMinutes],
    ].some(
      ([declared, canonical]) =>
        declared !== undefined && canonical === undefined,
    );
    if (
      invalidJobControls &&
      violations.entries.length === jobControlViolationCount
    ) {
      addViolation(violations, {
        kind: "unsupported-execution-shape",
        line: location.line,
        subject,
        detail: "ordinary job context or lifecycle field has an unsupported shape",
      });
    }
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
      const structuredStep = structuredSteps[index];
      if (
        !isRecord(rawStep) ||
        !isStringKeyedMap(structuredStep) ||
        Object.keys(rawStep).some((key) => !STEP_KEYS.has(key)) ||
        !Object.hasOwn(rawStep, "run")
      ) {
        addViolation(violations, {
          kind: "unsupported-execution-shape",
          line,
          subject: stepSubject,
          detail: "120d-1b1 supports only the closed ordinary run-step field set",
        });
        continue;
      }
      const optional = optionalStepFields(
        rawStep,
        stepSubject,
        line,
        canonicalValues,
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
      const run = exactNonEmptyText(rawStep.run);
      if (run === undefined) {
        addViolation(violations, {
          kind: "unsupported-execution-shape",
          line,
          subject: stepSubject,
          detail: "run must be an exact non-empty string",
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
    if (
      runner === undefined ||
      permissionResolution.kind !== "resolved"
    ) {
      continue;
    }
    jobs.push({
      id,
      line: location.line,
      name: typeof rawJob.name === "string" ? rawJob.name : null,
      runner,
      permissions: permissionResolution.evidence,
      ...(jobConcurrency === undefined
        ? {}
        : { concurrency: jobConcurrency }),
      ...(needs === undefined ? {} : { needs }),
      ...(condition === undefined ? {} : { condition }),
      ...(strategy === undefined ? {} : { strategy }),
      ...(outputs === undefined ? {} : { outputs }),
      ...(deploymentEnvironment === undefined
        ? {}
        : { deploymentEnvironment }),
      ...(continueOnError === undefined
        ? {}
        : { continueOnError }),
      ...(timeoutMinutes === undefined
        ? {}
        : { timeoutMinutes }),
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
    runName,
    ...(workflowConcurrency === undefined
      ? {}
      : { concurrency: workflowConcurrency }),
    workflowEnvironment,
    canonicalValueCount: canonicalValues.emittedValues,
    canonicalValueDepth: canonicalValues.deepestEmission,
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
