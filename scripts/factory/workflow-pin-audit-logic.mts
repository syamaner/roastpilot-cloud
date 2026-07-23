/**
 * Structural YAML audit logic for F1-S7's Claude action pin and actor
 * allowlist invariants.
 *
 * The caller owns filesystem discovery. This module parses one workflow or
 * composite-action manifest at a time so YAML-equivalent spellings cannot
 * bypass the guard.
 */

import {
  LineCounter,
  isAlias,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  type Node,
  type Pair,
} from "yaml";

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
const USES_ACTION_PATTERN = /^([^/\s]+\/claude-code-action)@(\S+)$/i;
const EXPECTED_ACTION_REPOSITORY = "anthropics/claude-code-action";
const EXPECTED_ACTION_REFERENCE = `${EXPECTED_ACTION_REPOSITORY}@${EXPECTED_CLAUDE_CODE_ACTION_SHA}`;
const ALLOWLIST_KEYS = new Set([
  "allowed_bots",
  "allowed_non_write_users",
]);

/**
 * One actionable violation of the audited workflow invariants.
 */
export interface WorkflowPinViolation {
  readonly kind:
    | "invalid-yaml"
    | "unpinned-action"
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

function findWildcardNode(
  node: Node,
  resolveAlias: (alias: Node) => Node | undefined,
  seen: Set<Node> = new Set(),
): Node | undefined {
  if (seen.has(node)) {
    return undefined;
  }
  seen.add(node);

  if (isAlias(node)) {
    const resolved = resolveAlias(node);
    return resolved && findWildcardNode(resolved, resolveAlias, seen)
      ? node
      : undefined;
  }
  if (isScalar(node)) {
    return typeof node.value === "string" && node.value.trim() === "*"
      ? node
      : undefined;
  }
  if (isSeq(node)) {
    for (const item of node.items) {
      /* v8 ignore next -- parsed sequence values use Scalar(null), not null. */
      if (!isNode(item)) {
        continue;
      }
      const wildcard = findWildcardNode(item, resolveAlias, seen);
      if (wildcard) {
        return wildcard;
      }
    }
  }
  return undefined;
}

function inspectWorkflowManifest(
  fileContent: string,
): WorkflowPinViolation[] {
  const lineCounter = new LineCounter();
  const document = parseDocument(fileContent, {
    lineCounter,
    logLevel: "silent",
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

  try {
    document.toJS({ maxAliasCount: 100 });
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

  const violations: WorkflowPinViolation[] = [];
  const exactActionScalars = new Set<Node>();
  const resolveAlias = (node: Node): Node | undefined =>
    isAlias(node) ? node.resolve(document) : node;

  visit(document, {
    Pair(_key, pair): void {
      const rawKey = pairKey(pair, resolveAlias);
      const key = rawKey?.toLowerCase();
      if (!key || !isNode(pair.value)) {
        return;
      }

      if (ALLOWLIST_KEYS.has(key)) {
        const wildcard = findWildcardNode(pair.value, resolveAlias);
        if (wildcard) {
          violations.push({
            kind: "wildcard-allowlist",
            line: nodeLine(wildcard, lineCounter),
            detail: `"${key}" resolves to a "*" wildcard — must be an explicit allowlist`,
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
        exactActionScalars.add(resolved);
        const match = USES_ACTION_PATTERN.exec(resolved.value.trim());
        if (
          match &&
          (match[1].toLowerCase() !== EXPECTED_ACTION_REPOSITORY ||
            match[2].toLowerCase() !==
              EXPECTED_CLAUDE_CODE_ACTION_SHA.toLowerCase())
        ) {
          violations.push({
            kind: "unpinned-action",
            line: nodeLine(pair.value, lineCounter),
            detail: `action reference "${match[1]}@${match[2]}" must equal "${EXPECTED_ACTION_REPOSITORY}@${EXPECTED_CLAUDE_CODE_ACTION_SHA}"`,
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
 * Finds wildcard Claude action actor allowlists in structurally parsed YAML.
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
 * @returns Every violation in source order.
 */
export function findWorkflowPinViolations(
  fileContent: string,
): WorkflowPinViolation[] {
  return inspectWorkflowManifest(fileContent);
}
