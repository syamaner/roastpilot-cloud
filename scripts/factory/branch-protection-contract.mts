/**
 * Fail-closed drift detection for the repository's branch-protection contract.
 * An added, benign GitHub API key blocks activation until the closed pin is
 * updated in a reviewed PR; that is availability-only drift, and the closure
 * must not be loosened to "fix" it. Required-check provider app IDs are pinned
 * alongside their byte-exact contexts.
 */

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const REQUIRED_STATUS_CONTEXTS: readonly string[] = [
  "Lint, typecheck, unit tests",
  "Playwright smoke",
  "Snowflake migrations (offline)",
  "CodeQL",
  "dependency-review",
  "Mutation testing (security-critical Python)",
  "Analyze (javascript-typescript)",
  "Analyze (actions)",
  "Analyze (python)",
];

export const REQUIRED_STATUS_APP_IDS = {
  "Lint, typecheck, unit tests": 15368,
  "Playwright smoke": 15368,
  "Snowflake migrations (offline)": 15368,
  CodeQL: 57789,
  "dependency-review": 15368,
  "Mutation testing (security-critical Python)": 15368,
  "Analyze (javascript-typescript)": 15368,
  "Analyze (actions)": 15368,
  "Analyze (python)": 15368,
} as const;

const TOP_LEVEL_KEYS = [
  "allow_deletions",
  "allow_force_pushes",
  "allow_fork_syncing",
  "block_creations",
  "enforce_admins",
  "lock_branch",
  "required_conversation_resolution",
  "required_linear_history",
  "required_signatures",
  "required_status_checks",
  "url",
] as const;

const ENABLED_PINS = [
  ["enforce_admins", true],
  ["required_signatures", false],
  ["required_linear_history", false],
  ["allow_force_pushes", false],
  ["allow_deletions", false],
  ["block_creations", false],
  ["required_conversation_resolution", true],
  ["lock_branch", false],
  ["allow_fork_syncing", false],
] as const;

const REQUIRED_STATUS_CHECK_KEYS = new Set([
  "strict",
  "contexts",
  "checks",
  "url",
  "contexts_url",
]);
const URL_BEARING_WRAPPERS = new Set([
  "enforce_admins",
  "required_signatures",
]);
const ENABLED_WRAPPER_KEYS = new Set(["enabled"]);
const URL_BEARING_WRAPPER_KEYS = new Set(["enabled", "url"]);

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unexpectedNestedKeyCodes(
  value: unknown,
  path: string,
  allowedKeys: ReadonlySet<string>,
): string[] {
  if (!isPlainObject(value)) return [];
  return Object.keys(value)
    .filter((key) => !allowedKeys.has(key))
    .sort()
    .map((key) => `$.${path}.${key}:value-mismatch`);
}

function contextLabel(value: unknown): string {
  /* v8 ignore next -- contextViolations calls this only for non-string entries. */
  if (typeof value === "string") return value;
  const encoded = JSON.stringify(value);
  return encoded === undefined ? String(value) : encoded;
}

function contextViolations(contexts: readonly unknown[]): string[] {
  const required = new Set(REQUIRED_STATUS_CONTEXTS);
  const counts = new Map<string, number>();
  const unexpected = new Set<string>();

  for (const value of contexts) {
    if (typeof value === "string") {
      counts.set(value, (counts.get(value) ?? 0) + 1);
      if (!required.has(value)) unexpected.add(value);
    } else {
      unexpected.add(contextLabel(value));
    }
  }

  const missingCodes = REQUIRED_STATUS_CONTEXTS.filter(
    (context) => !counts.has(context),
  )
    .slice()
    .sort()
    .map(
      (context) =>
        `$.required_status_checks.contexts:missing:${context}`,
    );
  const unexpectedCodes = [...unexpected]
    .sort()
    .map(
      (context) =>
        `$.required_status_checks.contexts:unexpected:${context}`,
    );
  const duplicateCodes = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([context]) => context)
    .sort()
    .map(
      (context) =>
        `$.required_status_checks.contexts:duplicate:${context}`,
    );

  return [...missingCodes, ...unexpectedCodes, ...duplicateCodes];
}

function checksMatchContexts(
  checks: unknown,
  contexts: readonly unknown[],
): boolean {
  if (!Array.isArray(checks)) return false;
  const contextStrings = contexts.filter(
    (value): value is string => typeof value === "string",
  );
  const contextSet = new Set(contextStrings);
  const checkContexts: string[] = [];
  for (const check of checks) {
    if (
      !isPlainObject(check) ||
      !Object.hasOwn(check, "context") ||
      typeof check.context !== "string"
    ) {
      return false;
    }
    checkContexts.push(check.context);
  }
  const checkContextSet = new Set(checkContexts);
  return (
    checkContexts.length === contextStrings.length &&
    checkContextSet.size === contextSet.size &&
    [...checkContextSet].every((context) => contextSet.has(context))
  );
}

function checkAppIdViolations(checks: unknown): string[] {
  /* v8 ignore next -- checksMatchContexts gates this helper to arrays. */
  if (!Array.isArray(checks)) return [];
  const mismatchedContexts = new Set<string>();
  for (const check of checks) {
    /* v8 ignore next -- checksMatchContexts guarantees plain entries with own string contexts. */
    if (
      !isPlainObject(check) ||
      !Object.hasOwn(check, "context") ||
      typeof check.context !== "string"
    ) {
      continue;
    }
    const expectedAppId =
      REQUIRED_STATUS_APP_IDS[
        check.context as keyof typeof REQUIRED_STATUS_APP_IDS
      ];
    if (!Object.hasOwn(check, "app_id") || check.app_id !== expectedAppId) {
      mismatchedContexts.add(check.context);
    }
  }
  return [...mismatchedContexts]
    .sort()
    .map(
      (context) =>
        `$.required_status_checks.checks:app-id-mismatch:${context}`,
    );
}

function checkEntryClosureViolations(checks: unknown): string[] {
  if (!Array.isArray(checks)) return [];
  const violations: string[] = [];
  checks.forEach((check, index) => {
    if (!isPlainObject(check)) return;
    for (const key of Object.keys(check).sort()) {
      if (key !== "context" && key !== "app_id") {
        violations.push(
          `$.required_status_checks.checks[${index}].${key}:value-mismatch`,
        );
      }
    }
  });
  return violations;
}

export function verifyBranchProtectionContract(input: unknown): {
  ok: boolean;
  violations: readonly string[];
} {
  if (!isPlainObject(input)) {
    return { ok: false, violations: ["input:not-a-plain-object"] };
  }

  const violations: string[] = [];

  for (const key of TOP_LEVEL_KEYS) {
    if (!Object.hasOwn(input, key)) violations.push(`$.${key}:missing`);
  }

  if (Object.hasOwn(input, "required_pull_request_reviews")) {
    violations.push("$.required_pull_request_reviews:must-be-absent");
  }

  const expectedTopLevelKeys = new Set<string>(TOP_LEVEL_KEYS);
  for (const key of Object.keys(input).sort()) {
    if (
      !expectedTopLevelKeys.has(key) &&
      key !== "required_pull_request_reviews"
    ) {
      violations.push(`$.${key}:unexpected`);
    }
  }

  if (Object.hasOwn(input, "required_status_checks")) {
    const statusChecks = input.required_status_checks;
    violations.push(
      ...unexpectedNestedKeyCodes(
        statusChecks,
        "required_status_checks",
        REQUIRED_STATUS_CHECK_KEYS,
      ),
    );

    if (
      !isPlainObject(statusChecks) ||
      !Object.hasOwn(statusChecks, "strict") ||
      statusChecks.strict !== false
    ) {
      violations.push("$.required_status_checks.strict:value-mismatch");
    }

    const contexts =
      isPlainObject(statusChecks) && Object.hasOwn(statusChecks, "contexts")
        ? statusChecks.contexts
        : undefined;
    if (!Array.isArray(contexts)) {
      violations.push("$.required_status_checks.contexts:not-an-array");
    } else {
      const contextCodes = contextViolations(contexts);
      violations.push(...contextCodes);
      const checks =
        isPlainObject(statusChecks) && Object.hasOwn(statusChecks, "checks")
          ? statusChecks.checks
          : undefined;
      if (contextCodes.length === 0) {
        const checksMatch = checksMatchContexts(checks, contexts);
        if (!checksMatch) {
          violations.push(
            "$.required_status_checks.checks:context-set-mismatch",
          );
        } else {
          violations.push(...checkAppIdViolations(checks));
        }
      }
      violations.push(...checkEntryClosureViolations(checks));
    }
  }

  for (const [key, expected] of ENABLED_PINS) {
    if (!Object.hasOwn(input, key)) continue;
    const wrapper = input[key];
    const allowedKeys = URL_BEARING_WRAPPERS.has(key)
      ? URL_BEARING_WRAPPER_KEYS
      : ENABLED_WRAPPER_KEYS;
    violations.push(...unexpectedNestedKeyCodes(wrapper, key, allowedKeys));
    if (
      !isPlainObject(wrapper) ||
      !Object.hasOwn(wrapper, "enabled") ||
      wrapper.enabled !== expected
    ) {
      violations.push(`$.${key}.enabled:value-mismatch`);
    }
  }

  return { ok: violations.length === 0, violations };
}

type StdinReader = (fileDescriptor: 0, encoding: "utf8") => string;

export function runCli(readStdin: StdinReader = readFileSync): number {
  if (process.argv[2] !== undefined) {
    console.error("BRANCH-PROTECTION-CONTRACT: USAGE (read JSON from stdin)");
    return 2;
  }

  const raw = readStdin(0, "utf8");
  let input: unknown;
  try {
    if (raw.trim() === "") throw new Error("empty input");
    input = JSON.parse(raw) as unknown;
  } catch {
    console.error("BRANCH-PROTECTION-CONTRACT: MALFORMED-INPUT");
    return 2;
  }

  const verdict = verifyBranchProtectionContract(input);
  if (verdict.ok) {
    console.log(
      "BRANCH-PROTECTION-CONTRACT: OK (9 required contexts; reviews-absent exception intact)",
    );
    return 0;
  }

  for (const violation of verdict.violations) console.error(violation);
  console.error(
    `BRANCH-PROTECTION-CONTRACT: DRIFT (${verdict.violations.length} violations)`,
  );
  return 1;
}

// Unlike the repository's usual string-equality guard, this script is loaded
// through a `mktemp -d` path whose `/var` prefix is symlinked on macOS. Resolve
// both paths so direct execution cannot silently no-op after Node realpaths it.
export function isDirectInvocation(): boolean {
  const invoked = process.argv[1];
  if (invoked === undefined) return false;
  try {
    return realpathSync(invoked) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

/* v8 ignore next -- import-only branch; runCli is process tested. */
if (isDirectInvocation()) {
  process.exitCode = runCli();
}
