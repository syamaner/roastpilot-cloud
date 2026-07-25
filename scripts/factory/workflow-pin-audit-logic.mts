/**
 * Structural YAML audit logic for F1-S7's Claude action pin and actor
 * allowlist invariants.
 *
 * The caller owns filesystem discovery. This module parses one workflow or
 * composite-action manifest at a time so YAML-equivalent spellings cannot
 * bypass the guard, and optionally validates referenced local-action targets
 * against a repository checkout.
 */

import {
  LineCounter,
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type Node,
  type Pair,
} from "yaml";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { posix, resolve, win32 } from "node:path";

/**
 * The reviewed `claude-code-action` commit used by every audited manifest.
 *
 * Bumps must update this constant and every action/provenance reference in the
 * same commit. The SHA corresponds to v1.0.176 and includes the v1.0.94
 * bot-allowlist-bypass fix.
 */
export const EXPECTED_CLAUDE_CODE_ACTION_SHA =
  "700e7f8316990de46bed556429765647af760efc";

const ACTION_REFERENCE_PATTERN =
  /(?<![A-Za-z0-9._-])anthropics\/claude-code-action@(\S+)/gi;
const EXPECTED_ACTION_REPOSITORY = "anthropics/claude-code-action";
const EXPECTED_ACTION_REFERENCE = `${EXPECTED_ACTION_REPOSITORY}@${EXPECTED_CLAUDE_CODE_ACTION_SHA}`;
const ALLOWLIST_KEYS = new Set([
  "allowed_bots",
  "allowed_non_write_users",
]);
const GITHUB_TOKEN_PERMISSION_KEYS = new Set([
  "actions",
  "artifact-metadata",
  "attestations",
  "checks",
  "code-quality",
  "contents",
  "deployments",
  "discussions",
  "id-token",
  "issues",
  "models",
  "packages",
  "pages",
  "pull-requests",
  "security-events",
  "statuses",
  "vulnerability-alerts",
]);
const CREDENTIAL_KEY_PATTERN =
  /(?:^|[_-])(?:api[_-]?key|auth(?:entication|orization)?|credential|credentials|password|passphrase|pat|private[_-]?key|secret|secrets|ssh[_-]?key|token|tokens)(?:$|[_-])/i;

type UnsafeAllowlistValue = {
  readonly node: Node;
  readonly description: string;
};

/**
 * One actionable violation of the audited workflow invariants.
 */
export interface WorkflowPinViolation {
  readonly kind:
    | "invalid-yaml"
    | "privileged-local-action"
    | "unpinned-action"
    | "unsafe-local-action"
    | "wildcard-allowlist";
  /** 1-based line number within the audited manifest. */
  readonly line: number;
  readonly detail: string;
}

/**
 * Returns whether a repository-relative path belongs to the pin audit.
 *
 * Workflow YAML and composite-action manifests are both included. Path
 * separators and extensions are normalized case-insensitively so discovery
 * behaves consistently across supported development platforms.
 *
 * @param repositoryRelativePath - Path relative to the repository root.
 * @returns Whether the file must be structurally audited.
 */
export function isWorkflowPinAuditManifestPath(
  repositoryRelativePath: string,
): boolean {
  const normalized = repositoryRelativePath
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "");
  return (
    /^\.github\/workflows\/.+\.ya?ml$/i.test(normalized) ||
    /^\.github\/actions\/(?:.+\/)?action\.ya?ml$/i.test(normalized)
  );
}

function localActionRepositoryPath(
  actionReference: string,
): string | undefined {
  const separatorsNormalized = actionReference.replaceAll("\\", "/");
  if (!separatorsNormalized.startsWith("./")) {
    return undefined;
  }
  return posix.normalize(separatorsNormalized).replace(/^\.\//, "");
}

function isAllowedLocalActionPath(repositoryPath: string): boolean {
  return (
    repositoryPath === ".github/actions" ||
    repositoryPath.startsWith(".github/actions/")
  );
}

type LocalActionEntrypoint = {
  readonly field: "image" | "main" | "post" | "pre";
  readonly path: string;
};

type LocalActionEntrypointInspection =
  | { readonly entrypoints: readonly LocalActionEntrypoint[] }
  | { readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function containsCredentialExpression(value: unknown): boolean {
  if (typeof value === "string") {
    return (
      /\$\{\{[\s\S]*?\bsecrets\b[\s\S]*?\}\}/i.test(value) ||
      /\$\{\{[\s\S]*?\bgithub\s*(?:\.|\[\s*["'])token\b[\s\S]*?\}\}/i.test(
        value,
      ) ||
      /\$\{\{[\s\S]*?\b(?:steps|needs)\b[\s\S]*?\boutputs\b[\s\S]*?\}\}/i.test(
        value,
      ) ||
      /\$\{\{[\s\S]*?\btoJSON\s*\(\s*(?:steps|needs)\s*\)[\s\S]*?\}\}/i.test(
        value,
      )
    );
  }
  if (Array.isArray(value)) {
    return value.some(containsCredentialExpression);
  }
  return (
    isRecord(value) &&
    Object.values(value).some(containsCredentialExpression)
  );
}

function containsCredentialNamedValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsCredentialNamedValue);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.entries(value).some(([key, nestedValue]) => {
    const normalizedKey = key
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase();
    if (key === "permissions") {
      return false;
    }
    if (CREDENTIAL_KEY_PATTERN.test(normalizedKey)) {
      if (
        normalizedKey.replaceAll("_", "-") ===
          "persist-credentials" &&
        (nestedValue === false || nestedValue === "false")
      ) {
        return false;
      }
      if (
        (normalizedKey === "credentials" ||
          normalizedKey === "secrets") &&
        isRecord(nestedValue) &&
        Object.keys(nestedValue).length === 0
      ) {
        return false;
      }
      return true;
    }
    return containsCredentialNamedValue(nestedValue);
  });
}

function permissionsCarryCredential(value: unknown): boolean {
  if (value === undefined) {
    // Repository defaults are mutable external state, so absence is unknown.
    return true;
  }
  if (typeof value === "string") {
    // Both supported scalar shorthands grant a token; every other scalar is
    // an unknown form and therefore also fails closed.
    return true;
  }
  if (!isRecord(value)) {
    return true;
  }
  return Object.entries(value).some(
    ([permissionKey, permission]) =>
      !GITHUB_TOKEN_PERMISSION_KEYS.has(permissionKey) ||
      permission !== "none",
  );
}

function hasUnknownCredentialShape(
  workflow: Record<string, unknown>,
  job: Record<string, unknown>,
): boolean {
  return (
    (Object.hasOwn(workflow, "env") && !isRecord(workflow.env)) ||
    (Object.hasOwn(job, "env") && !isRecord(job.env)) ||
    (Object.hasOwn(job, "steps") &&
      (!Array.isArray(job.steps) ||
        job.steps.some(
          (step) =>
            !isRecord(step) ||
            (Object.hasOwn(step, "env") && !isRecord(step.env)) ||
            (Object.hasOwn(step, "with") && !isRecord(step.with)),
        ))) ||
    (Object.hasOwn(job, "with") && !isRecord(job.with)) ||
    (Object.hasOwn(job, "container") &&
      typeof job.container !== "string" &&
      !isRecord(job.container)) ||
    (Object.hasOwn(job, "services") && !isRecord(job.services))
  );
}

function jobCarriesCredential(
  workflow: Record<string, unknown>,
  job: Record<string, unknown>,
): boolean {
  const permissions = Object.hasOwn(job, "permissions")
    ? job.permissions
    : workflow.permissions;
  if (permissionsCarryCredential(permissions)) {
    return true;
  }
  if (
    Object.hasOwn(job, "environment") ||
    (Object.hasOwn(job, "with") &&
      (!isRecord(job.with) || Object.keys(job.with).length > 0)) ||
    hasUnknownCredentialShape(workflow, job) ||
    containsCredentialExpression(workflow.env) ||
    containsCredentialExpression(job) ||
    containsCredentialNamedValue(workflow.env) ||
    containsCredentialNamedValue(job)
  ) {
    return true;
  }
  if (!Object.hasOwn(job, "secrets")) {
    return false;
  }
  const secrets = job.secrets;
  return (
    secrets === "inherit" ||
    !isRecord(secrets) ||
    Object.keys(secrets).length > 0
  );
}

type LocalUsesReference = {
  readonly display: string;
  readonly unknown: boolean;
};

function localUsesReference(
  value: unknown,
): LocalUsesReference | undefined {
  if (typeof value !== "string") {
    return value === undefined
      ? undefined
      : { display: "<non-string uses value>", unknown: true };
  }
  const reference = value.trim();
  if (reference.includes("${{")) {
    return { display: reference, unknown: true };
  }
  return localActionRepositoryPath(reference) !== undefined
    ? { display: reference, unknown: false }
    : undefined;
}

function localUsesReferences(
  job: Record<string, unknown>,
): LocalUsesReference[] {
  const references: LocalUsesReference[] = [];
  const jobReference = localUsesReference(job.uses);
  if (jobReference !== undefined) {
    references.push(jobReference);
  }
  const steps = Array.isArray(job.steps)
    ? job.steps
    : [job.steps];
  for (const step of steps) {
    if (isRecord(step) && Object.hasOwn(step, "uses")) {
      const reference = localUsesReference(step.uses);
      if (reference !== undefined) {
        references.push(reference);
      }
    }
  }
  return references.filter(
    (reference, index) =>
      references.findIndex(
        (candidate) =>
          candidate.display === reference.display &&
          candidate.unknown === reference.unknown,
      ) === index,
  );
}

function workflowFieldLine(
  document: ReturnType<typeof parseDocument>,
  fieldName: string,
  lineCounter: LineCounter,
): number {
  const resolveAlias = (node: Node): Node | undefined =>
    isAlias(node) ? node.resolve(document) : node;
  /* v8 ignore next -- a semantic object with `jobs` has a Node root. */
  const root = isNode(document.contents)
    ? resolveAlias(document.contents)
    : undefined;
  /* v8 ignore next -- a semantic object with `jobs` requires a mapping root. */
  if (!isMap(root)) {
    return 1;
  }
  const field = root.items.find(
    (pair) => pairKey(pair, resolveAlias) === fieldName,
  );
  return field && isNode(field.value)
    ? nodeLine(field.value, lineCounter)
    : 1;
}

function workflowJobLine(
  document: ReturnType<typeof parseDocument>,
  jobName: string,
  lineCounter: LineCounter,
): number {
  const resolveAlias = (node: Node): Node | undefined =>
    isAlias(node) ? node.resolve(document) : node;
  /* v8 ignore next -- a semantic object with `jobs` has a Node root. */
  const root = isNode(document.contents)
    ? resolveAlias(document.contents)
    : undefined;
  /* v8 ignore next -- a semantic object with `jobs` requires a mapping root. */
  if (!isMap(root)) {
    return 1;
  }
  const jobsPair = root.items.find(
    (pair) => pairKey(pair, resolveAlias)?.toLowerCase() === "jobs",
  );
  const jobs =
    jobsPair && isNode(jobsPair.value)
      ? resolveAlias(jobsPair.value)
      : undefined;
  /* v8 ignore next -- semantic `jobs` is a record only for a mapping node. */
  if (!isMap(jobs)) {
    return 1;
  }
  const jobPair = jobs.items.find(
    (pair) => pairKey(pair, resolveAlias) === jobName,
  );
  return jobPair && isNode(jobPair.value)
    ? nodeLine(jobPair.value, lineCounter)
    : 1;
}

function findPrivilegedLocalActionViolations(
  manifest: unknown,
  document: ReturnType<typeof parseDocument>,
  lineCounter: LineCounter,
): WorkflowPinViolation[] {
  if (!isRecord(manifest) || !Object.hasOwn(manifest, "jobs")) {
    return [];
  }
  if (!isRecord(manifest.jobs)) {
    const malformedJobs = Array.isArray(manifest.jobs)
      ? manifest.jobs
      : [manifest.jobs];
    const references = malformedJobs.flatMap((job) =>
      isRecord(job) ? localUsesReferences(job) : [],
    );
    const line = workflowFieldLine(document, "jobs", lineCounter);
    return references.map((reference) => ({
      kind: "privileged-local-action" as const,
      line,
      detail: `workflow has malformed jobs and cannot prove local reference "${reference.display}" is credential-free`,
    }));
  }
  return Object.entries(manifest.jobs).flatMap(([jobName, value]) => {
    if (!isRecord(value)) {
      const line = workflowJobLine(document, jobName, lineCounter);
      return localUsesReferences({ steps: value }).map((reference) => ({
        kind: "privileged-local-action" as const,
        line,
        detail: `malformed job "${jobName}" cannot prove local reference "${reference.display}" is credential-free`,
      }));
    }
    if (!jobCarriesCredential(manifest, value)) {
      return [];
    }
    const line = workflowJobLine(document, jobName, lineCounter);
    return localUsesReferences(value).map((reference) => ({
      kind: "privileged-local-action" as const,
      line,
      detail: reference.unknown
        ? `credential-bearing job "${jobName}" has non-static uses value "${reference.display}" and cannot prove it is non-local`
        : `credential-bearing job "${jobName}" must not invoke repository-local reference "${reference.display}"`,
    }));
  });
}

function inspectLocalActionEntrypoints(
  manifestPath: string,
): LocalActionEntrypointInspection {
  const document = parseDocument(readFileSync(manifestPath, "utf8"), {
    logLevel: "silent",
    prettyErrors: true,
    strict: true,
    uniqueKeys: true,
    version: "1.2",
  });
  if (document.errors.length > 0) {
    return { error: "cannot inspect entrypoints because its YAML is invalid" };
  }

  let manifest: unknown;
  try {
    manifest = document.toJS({ maxAliasCount: 100 }) as unknown;
  } catch {
    return {
      error: "cannot inspect entrypoints because its YAML aliases are invalid",
    };
  }
  if (!isRecord(manifest) || !isRecord(manifest.runs)) {
    return { entrypoints: [] };
  }

  const runs = manifest.runs;
  const using = runs.using;
  if (typeof using !== "string") {
    return { entrypoints: [] };
  }
  const fields: readonly LocalActionEntrypoint["field"][] = using
    .toLowerCase()
    .startsWith("node")
    ? ["main", "pre", "post"]
    : using.toLowerCase() === "docker"
      ? ["image"]
      : [];
  const entrypoints = fields.flatMap((field) => {
    const path = runs[field];
    if (typeof path !== "string" || path.trim() === "") {
      return [];
    }
    if (
      field === "image" &&
      path.trim().toLowerCase().startsWith("docker://")
    ) {
      return [];
    }
    return [{ field, path: path.trim() }];
  });
  return { entrypoints };
}

function localActionEntrypointViolation(
  actionDirectory: string,
  repositoryPath: string,
  entrypoint: LocalActionEntrypoint,
): string | undefined {
  const normalizedSeparators = entrypoint.path.replaceAll("\\", "/");
  if (
    posix.isAbsolute(normalizedSeparators) ||
    win32.parse(entrypoint.path).root !== ""
  ) {
    return `local action target "${repositoryPath}" runs.${entrypoint.field} path "${entrypoint.path}" must be relative to the action directory`;
  }
  const normalizedPath = posix.normalize(normalizedSeparators);
  if (
    normalizedPath === ".." ||
    normalizedPath.startsWith("../")
  ) {
    return `local action target "${repositoryPath}" runs.${entrypoint.field} path "${entrypoint.path}" escapes the action directory after normalization`;
  }

  let currentPath = actionDirectory;
  for (const segment of normalizedPath.split("/")) {
    currentPath = resolve(currentPath, segment);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(currentPath);
    } catch {
      return `local action target "${repositoryPath}" runs.${entrypoint.field} path "${entrypoint.path}" does not exist`;
    }
    if (stats.isSymbolicLink()) {
      return `local action target "${repositoryPath}" runs.${entrypoint.field} path "${entrypoint.path}" contains symlink component "${segment}"`;
    }
  }
  if (!lstatSync(currentPath).isFile()) {
    return `local action target "${repositoryPath}" runs.${entrypoint.field} path "${entrypoint.path}" must be a regular file`;
  }
  return undefined;
}

function localActionTargetViolation(
  repositoryRoot: string,
  repositoryPath: string,
): string | undefined {
  const segments = repositoryPath.split("/");
  let currentPath = resolve(repositoryRoot);
  for (const segment of segments) {
    currentPath = resolve(currentPath, segment);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(currentPath);
    } catch {
      return `local action target "${repositoryPath}" does not exist`;
    }
    if (stats.isSymbolicLink()) {
      return `local action target "${repositoryPath}" contains symlink component "${segment}"`;
    }
  }

  if (!lstatSync(currentPath).isDirectory()) {
    return `local action target "${repositoryPath}" must be a directory`;
  }

  const manifests = readdirSync(currentPath, {
    withFileTypes: true,
  }).filter((entry) => /^action\.ya?ml$/i.test(entry.name));
  if (manifests.length !== 1) {
    return `local action target "${repositoryPath}" must contain exactly one action.yml or action.yaml manifest, found ${manifests.length}`;
  }
  const manifest = manifests[0];
  if (manifest.name !== "action.yml" && manifest.name !== "action.yaml") {
    return `local action target "${repositoryPath}" manifest "${manifest.name}" must use the exact lowercase name action.yml or action.yaml`;
  }
  if (manifest.isSymbolicLink()) {
    return `local action target "${repositoryPath}" contains symlink manifest "${manifest.name}"`;
  }
  if (!manifest.isFile()) {
    return `local action target "${repositoryPath}" manifest "${manifest.name}" must be a regular file`;
  }

  const manifestPath = resolve(currentPath, manifest.name);
  const inspection = inspectLocalActionEntrypoints(manifestPath);
  if ("error" in inspection) {
    return `local action target "${repositoryPath}" manifest "${manifest.name}" ${inspection.error}`;
  }
  for (const entrypoint of inspection.entrypoints) {
    const violation = localActionEntrypointViolation(
      currentPath,
      repositoryPath,
      entrypoint,
    );
    if (violation) {
      return violation;
    }
  }
  return undefined;
}

function nodeLine(node: Node, lineCounter: LineCounter): number {
  // Every node passed here comes from parseDocument and therefore has a range.
  return lineCounter.linePos(node.range![0]).line;
}

function pairKey(
  pair: Pair,
  resolveAlias: (node: Node) => Node | undefined,
): string | undefined {
  /* v8 ignore next -- parsed mapping keys are Nodes; empty keys are errors. */
  if (!isNode(pair.key)) {
    return undefined;
  }
  const key = resolveAlias(pair.key);
  return isScalar(key) && typeof key.value === "string"
    ? key.value
    : undefined;
}

function findUnsafeAllowlistValue(
  node: Node,
  resolveAlias: (alias: Node) => Node | undefined,
  seen: Set<Node> = new Set(),
): UnsafeAllowlistValue | undefined {
  if (seen.has(node)) {
    return undefined;
  }
  seen.add(node);

  if (isAlias(node)) {
    const resolved = resolveAlias(node);
    const unsafeValue =
      resolved &&
      findUnsafeAllowlistValue(resolved, resolveAlias, seen);
    return unsafeValue
      ? { node, description: unsafeValue.description }
      : undefined;
  }
  if (isScalar(node)) {
    if (typeof node.value !== "string") {
      return undefined;
    }
    if (node.value.trim() === "*") {
      return { node, description: 'a "*" wildcard' };
    }
    if (node.value.includes("${{")) {
      return { node, description: "a dynamic GitHub expression" };
    }
    return undefined;
  }
  if (isSeq(node)) {
    for (const item of node.items) {
      /* v8 ignore next -- parsed sequence values use Scalar(null), not null. */
      if (!isNode(item)) {
        continue;
      }
      const unsafeValue = findUnsafeAllowlistValue(
        item,
        resolveAlias,
        seen,
      );
      if (unsafeValue) {
        return unsafeValue;
      }
    }
  }
  return undefined;
}

function findStepUsesPairs(
  document: ReturnType<typeof parseDocument>,
  resolveAlias: (node: Node) => Node | undefined,
): Set<Pair> {
  const stepUsesPairs = new Set<Pair>();
  visit(document, {
    Pair(_key, pair): void {
      if (pairKey(pair, resolveAlias)?.toLowerCase() !== "steps") {
        return;
      }
      /* v8 ignore next -- parsed Pair values use Scalar(null), not null. */
      if (!isNode(pair.value)) {
        return;
      }
      const steps = resolveAlias(pair.value);
      if (!isSeq(steps)) {
        return;
      }
      for (const item of steps.items) {
        /* v8 ignore next -- parsed sequence items use Scalar(null), not null. */
        if (!isNode(item)) {
          continue;
        }
        const step = resolveAlias(item);
        if (!isMap(step)) {
          continue;
        }
        for (const stepPair of step.items) {
          if (
            pairKey(stepPair, resolveAlias)?.toLowerCase() === "uses"
          ) {
            stepUsesPairs.add(stepPair);
          }
        }
      }
    },
  });
  return stepUsesPairs;
}

function inspectWorkflowManifest(
  fileContent: string,
  repositoryRoot?: string,
): WorkflowPinViolation[] {
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

  if (document.errors.length > 0) {
    return document.errors.map((error) => ({
      kind: "invalid-yaml",
      line: lineCounter.linePos(error.pos[0]).line,
      detail: `invalid YAML (${error.code}): ${error.message.split("\n")[0]}`,
    }));
  }

  let manifest: unknown;
  try {
    manifest = document.toJS({ maxAliasCount: 100 }) as unknown;
  } catch (error: unknown) {
    // yaml reports alias-expansion failures as Error subclasses.
    const detail = (error as Error).message;
    return [
      {
        kind: "invalid-yaml",
        line: 1,
        detail: `invalid YAML alias expansion: ${detail}`,
      },
    ];
  }

  const violations = findPrivilegedLocalActionViolations(
    manifest,
    document,
    lineCounter,
  );
  const exactActionScalars = new Set<Node>();
  const resolveAlias = (node: Node): Node | undefined =>
    isAlias(node) ? node.resolve(document) : node;
  const stepUsesPairs = findStepUsesPairs(document, resolveAlias);

  visit(document, {
    Pair(_key, pair): void {
      const rawKey = pairKey(pair, resolveAlias);
      const key = rawKey?.toLowerCase();
      if (!key || !isNode(pair.value)) {
        return;
      }

      if (ALLOWLIST_KEYS.has(key)) {
        const unsafeValue = findUnsafeAllowlistValue(
          pair.value,
          resolveAlias,
        );
        if (unsafeValue) {
          violations.push({
            kind: "wildcard-allowlist",
            line: nodeLine(unsafeValue.node, lineCounter),
            detail: `"${key}" resolves to ${unsafeValue.description} — must be a static explicit allowlist`,
          });
        }
      }

      if (key === "implement_agent_action_ref") {
        const resolved = resolveAlias(pair.value);
        if (isScalar(resolved) && typeof resolved.value === "string") {
          exactActionScalars.add(resolved);
        }
        const actual =
          isScalar(resolved) && typeof resolved.value === "string"
            ? resolved.value.trim()
            : undefined;
        if (actual?.toLowerCase() !== EXPECTED_ACTION_REFERENCE) {
          violations.push({
            kind: "unpinned-action",
            line: nodeLine(pair.value, lineCounter),
            detail: `"IMPLEMENT_AGENT_ACTION_REF" must equal "${EXPECTED_ACTION_REFERENCE}", found ${actual === undefined ? "a non-string value" : `"${actual}"`}`,
          });
        }
      }

      if (key === "uses") {
        const resolved = resolveAlias(pair.value);
        if (!isScalar(resolved) || typeof resolved.value !== "string") {
          return;
        }
        const actual = resolved.value.trim();
        const localPath = localActionRepositoryPath(actual);
        if (localPath !== undefined) {
          if (
            stepUsesPairs.has(pair) &&
            !isAllowedLocalActionPath(localPath)
          ) {
            violations.push({
              kind: "unsafe-local-action",
              line: nodeLine(pair.value, lineCounter),
              detail: `local action reference "${actual}" must stay within "./.github/actions/**" after normalization, found "${localPath}"`,
            });
          } else if (
            stepUsesPairs.has(pair) &&
            repositoryRoot !== undefined
          ) {
            const detail = localActionTargetViolation(
              repositoryRoot,
              localPath,
            );
            if (detail) {
              violations.push({
                kind: "unsafe-local-action",
                line: nodeLine(pair.value, lineCounter),
                detail,
              });
            }
          }
          return;
        }
        // Mirror the runner's remote-action parsing before enforcing identity.
        const usesSegments = actual.split("@");
        if (usesSegments.length !== 2) {
          return;
        }
        const pathSegments = usesSegments[0]
          .split(/[\\/]/)
          .filter((segment) => segment.length > 0);
        if (pathSegments[1]?.toLowerCase() !== "claude-code-action") {
          return;
        }
        exactActionScalars.add(resolved);
        const repository = `${pathSegments[0]}/${pathSegments[1]}`;
        if (
          repository.toLowerCase() !== EXPECTED_ACTION_REPOSITORY ||
          pathSegments.length !== 2 ||
          usesSegments[1].toLowerCase() !==
            EXPECTED_CLAUDE_CODE_ACTION_SHA.toLowerCase()
        ) {
          violations.push({
            kind: "unpinned-action",
            line: nodeLine(pair.value, lineCounter),
            detail: `action reference "${actual}" must equal "${EXPECTED_ACTION_REFERENCE}"`,
          });
        }
      }
    },
  });

  visit(document, {
    Scalar(key, scalar): void {
      if (
        key === "key" ||
        exactActionScalars.has(scalar) ||
        typeof scalar.value !== "string"
      ) {
        return;
      }
      for (const match of scalar.value.matchAll(ACTION_REFERENCE_PATTERN)) {
        const actualRef = match[1];
        if (
          actualRef.toLowerCase() !==
          EXPECTED_CLAUDE_CODE_ACTION_SHA.toLowerCase()
        ) {
          violations.push({
            kind: "unpinned-action",
            line: nodeLine(scalar, lineCounter),
            detail: `claude-code-action pinned to "${actualRef}", expected "${EXPECTED_CLAUDE_CODE_ACTION_SHA}"`,
          });
        }
      }
    },
  });

  return violations.sort((left, right) => left.line - right.line);
}

/**
 * Finds structurally parsed Claude action references that are not pinned.
 *
 * Embedded provenance scalars are checked as well as `uses` values, preserving
 * the existing invariant for `IMPLEMENT_AGENT_ACTION_REF`.
 *
 * @param fileContent - Raw YAML for one audited manifest.
 * @returns Unpinned references, or parse violations when YAML is invalid.
 */
export function findUnpinnedActionReferences(
  fileContent: string,
): WorkflowPinViolation[] {
  return inspectWorkflowManifest(fileContent).filter(
    (violation) =>
      violation.kind === "unpinned-action" ||
      violation.kind === "invalid-yaml",
  );
}

/**
 * Finds unsafe Claude action actor allowlists in structurally parsed YAML.
 *
 * Literal wildcards and dynamic GitHub expressions both fail closed because
 * the audit cannot prove that a runtime expression resolves to an explicit
 * actor list.
 *
 * @param fileContent - Raw YAML for one audited manifest.
 * @returns Wildcard allowlists, or parse violations when YAML is invalid.
 */
export function findWildcardAllowlistUsages(
  fileContent: string,
): WorkflowPinViolation[] {
  return inspectWorkflowManifest(fileContent).filter(
    (violation) =>
      violation.kind === "wildcard-allowlist" ||
      violation.kind === "invalid-yaml",
  );
}

/**
 * Runs the complete structural pin and allowlist audit for one manifest.
 *
 * @param fileContent - Raw YAML for one audited manifest.
 * @param repositoryRoot - Optional repository checkout root. When supplied,
 * local action references are also validated against the filesystem.
 * @returns Every violation in source order.
 */
export function findWorkflowPinViolations(
  fileContent: string,
  repositoryRoot?: string,
): WorkflowPinViolation[] {
  return inspectWorkflowManifest(fileContent, repositoryRoot);
}
