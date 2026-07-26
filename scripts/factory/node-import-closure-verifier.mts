/**
 * Verify the bounded Node static module closure required by D117-D118.
 *
 * Slice 120c-2 separately rejects dynamic loading and process capabilities.
 * This module alone does not activate or declare any live job compliant.
 */

import {
  lstatSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve as resolveImport } from "import-meta-resolve";
import * as ts from "typescript";

import { isProtectedPath } from "./implement-patch-logic.mts";

/** Operator-approved D118 traversal ceilings. */
export const MAX_NODE_CLOSURE_FILES = 128;
export const MAX_NODE_CLOSURE_EDGES = 512;
export const MAX_NODE_SOURCE_BYTES = 1_000_000;
export const MAX_NODE_CLOSURE_BYTES = 8_000_000;

const FORBIDDEN_MODULES = new Set([
  "child_process",
  "cluster",
  "module",
  "node:child_process",
  "node:cluster",
  "node:module",
  "node:repl",
  "node:vm",
  "node:wasi",
  "node:worker_threads",
  "repl",
  "vm",
  "wasi",
  "worker_threads",
]);
const BUILTIN_PATTERN = /^node:[a-z0-9_/-]+$/;
// Closed public Node 22 catalogue. Runtime discovery through node:module would
// make this verifier's own closure require a capability that it forbids.
const BUILTIN_MODULES = new Set([
  "node:assert",
  "node:assert/strict",
  "node:async_hooks",
  "node:buffer",
  "node:child_process",
  "node:cluster",
  "node:console",
  "node:constants",
  "node:crypto",
  "node:dgram",
  "node:diagnostics_channel",
  "node:dns",
  "node:dns/promises",
  "node:domain",
  "node:events",
  "node:fs",
  "node:fs/promises",
  "node:http",
  "node:http2",
  "node:https",
  "node:inspector",
  "node:inspector/promises",
  "node:module",
  "node:net",
  "node:os",
  "node:path",
  "node:path/posix",
  "node:path/win32",
  "node:perf_hooks",
  "node:process",
  "node:punycode",
  "node:querystring",
  "node:readline",
  "node:readline/promises",
  "node:repl",
  "node:sea",
  "node:sqlite",
  "node:stream",
  "node:stream/consumers",
  "node:stream/promises",
  "node:stream/web",
  "node:string_decoder",
  "node:test",
  "node:test/reporters",
  "node:timers",
  "node:timers/promises",
  "node:tls",
  "node:trace_events",
  "node:tty",
  "node:url",
  "node:util",
  "node:util/types",
  "node:v8",
  "node:vm",
  "node:wasi",
  "node:worker_threads",
  "node:zlib",
]);
const PACKAGE_PATTERN =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/i;

function forbiddenModule(specifier: string): boolean {
  return [...FORBIDDEN_MODULES].some(
    (forbidden) =>
      specifier === forbidden || specifier.startsWith(`${forbidden}/`),
  );
}

/** One reviewed external resolution within a D117 trust root. */
export type NodeExternalModuleRule =
  | {
      readonly kind: "node-builtin";
      readonly specifier: string;
      readonly resolvedTarget: string;
    }
  | {
      readonly kind: "locked-package";
      readonly specifier: string;
      readonly resolvedTarget: string;
    };

/** Complete evidence for one trusted static-module closure. */
export interface NodeImportClosureRequest {
  readonly repositoryRoot: string;
  readonly trustedRoot: string;
  readonly trustedSourceClass: "protected-glue" | "trusted-main-snowflake";
  readonly rootsComplete: boolean;
  readonly entrypoints: readonly string[];
  readonly externalModules: readonly NodeExternalModuleRule[];
}

/** One fail-closed static import/provenance violation. */
export interface NodeImportClosureViolation {
  readonly kind:
    | "invalid-input"
    | "resource-limit"
    | "unsafe-path"
    | "parse-error"
    | "unsupported-import"
    | "unapproved-external-module";
  readonly path: string;
  /** 1-based source line, or zero for request/filesystem evidence. */
  readonly line: number;
  readonly detail: string;
}

/**
 * Canonical static closure evidence for later byte/runtime verification.
 *
 * Evidence is populated only when `violations` is empty. A caller therefore
 * cannot accidentally use a partial or invalid traversal as reviewed closure.
 */
export interface NodeImportClosureResult {
  readonly files: readonly string[];
  readonly edgeCount: number;
  readonly sourceBytes: number;
  readonly violations: readonly NodeImportClosureViolation[];
}

type InspectedPath =
  | { readonly absolutePath: string; readonly stats: Stats }
  | { readonly error: string };
type ViolationKind = NodeImportClosureViolation["kind"];

function finding(
  kind: ViolationKind,
  path: string,
  detail: string,
  line = 0,
): NodeImportClosureViolation {
  return { kind, path, line, detail };
}

function safeRelativePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    path
      .split("/")
      .every(
        (segment) =>
          segment.length > 0 && segment !== "." && segment !== "..",
      )
  );
}

function denseArray(values: readonly unknown[]): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(values, index)) return false;
  }
  return true;
}

function containedBy(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`));
}

function inspectPath(
  repositoryRoot: string,
  repositoryPath: string,
  expected: "directory" | "file",
): InspectedPath {
  let current = repositoryRoot;
  let stats: Stats | undefined;
  for (const segment of repositoryPath.split("/")) {
    current = resolve(current, segment);
    try {
      stats = lstatSync(current);
    } catch {
      return { error: `"${repositoryPath}" does not exist` };
    }
    if (stats.isSymbolicLink()) {
      return {
        error: `"${repositoryPath}" contains symlink component "${segment}"`,
      };
    }
  }
  if (
    stats === undefined ||
    (expected === "file" ? !stats.isFile() : !stats.isDirectory())
  ) {
    return { error: `"${repositoryPath}" must be a regular ${expected}` };
  }
  try {
    const absolutePath = realpathSync(current);
    return containedBy(repositoryRoot, absolutePath)
      ? { absolutePath, stats }
      : { error: `"${repositoryPath}" resolves outside the repository` };
  } catch {
    /* v8 ignore next -- defensive lstat-to-realpath TOCTOU fail-closed path. */
    return { error: `"${repositoryPath}" cannot resolve to reviewed bytes` };
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    right.isFile() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function sourceLine(source: ts.SourceFile, node: ts.Node): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function runtimeStaticEdge(
  statement: ts.Statement,
):
  | {
      readonly declaration: ts.ImportDeclaration | ts.ExportDeclaration;
      readonly moduleSpecifier: ts.Expression;
    }
  | undefined {
  if (ts.isImportDeclaration(statement)) {
    return statement.importClause?.isTypeOnly === true
      ? undefined
      : { declaration: statement, moduleSpecifier: statement.moduleSpecifier };
  }
  if (ts.isExportDeclaration(statement)) {
    return statement.isTypeOnly || statement.moduleSpecifier === undefined
      ? undefined
      : { declaration: statement, moduleSpecifier: statement.moduleSpecifier };
  }
  return undefined;
}

function repositoryPath(repositoryRoot: string, absolutePath: string): string {
  return relative(repositoryRoot, absolutePath).split(sep).join("/");
}

function relativeDependency(
  importer: string,
  specifier: string,
  trustedRoot: string,
  repositoryRoot: string,
): string | undefined {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return undefined;
  }
  let dependency: string;
  try {
    if (specifier.includes("\\")) throw new Error("backslash");
    const resolvedUrl = new URL(
      specifier,
      pathToFileURL(resolve(repositoryRoot, importer)),
    );
    if (
      resolvedUrl.protocol !== "file:" ||
      resolvedUrl.search !== "" ||
      resolvedUrl.hash !== ""
    ) {
      throw new Error("not a plain file");
    }
    dependency = repositoryPath(
      repositoryRoot,
      fileURLToPath(resolvedUrl),
    );
  } catch {
    return "";
  }
  return safeRelativePath(dependency) &&
    dependency.endsWith(".mts") &&
    dependency.startsWith(`${trustedRoot}/`)
    ? dependency
    : "";
}

function externalRule(value: unknown): value is NodeExternalModuleRule {
  if (typeof value !== "object" || value === null) return false;
  const rule = value as Record<string, unknown>;
  if (
    typeof rule.specifier !== "string" ||
    typeof rule.resolvedTarget !== "string" ||
    forbiddenModule(rule.specifier)
  ) {
    return false;
  }
  if (rule.kind === "node-builtin") {
    return (
      BUILTIN_PATTERN.test(rule.specifier) &&
      BUILTIN_MODULES.has(rule.specifier) &&
      rule.resolvedTarget === rule.specifier
    );
  }
  return (
    rule.kind === "locked-package" &&
    PACKAGE_PATTERN.test(rule.specifier) &&
    safeRelativePath(rule.resolvedTarget) &&
    rule.resolvedTarget.startsWith("node_modules/") &&
    !rule.resolvedTarget.endsWith(".node")
  );
}

function requestFailure(request: unknown): string | undefined {
  if (typeof request !== "object" || request === null) {
    return "closure evidence has an invalid runtime shape";
  }
  const value = request as Record<string, unknown>;
  if (
    typeof value.repositoryRoot !== "string" ||
    typeof value.trustedRoot !== "string" ||
    !new Set(["protected-glue", "trusted-main-snowflake"]).has(
      value.trustedSourceClass as string,
    ) ||
    value.rootsComplete !== true ||
    !Array.isArray(value.entrypoints) ||
    !Array.isArray(value.externalModules)
  ) {
    return "closure evidence has an invalid runtime shape";
  }
  const entrypoints = value.entrypoints;
  if (
    !safeRelativePath(value.trustedRoot) ||
    !denseArray(entrypoints) ||
    entrypoints.length === 0 ||
    entrypoints.length > MAX_NODE_CLOSURE_FILES ||
    entrypoints.some(
      (path) =>
        typeof path !== "string" ||
        !safeRelativePath(path) ||
        !path.startsWith(`${value.trustedRoot}/`) ||
        !path.endsWith(".mts"),
    ) ||
    new Set(entrypoints).size !== entrypoints.length ||
    (value.trustedSourceClass === "protected-glue" &&
      !isProtectedPath(`${value.trustedRoot}/`)) ||
    (value.trustedSourceClass === "trusted-main-snowflake" &&
      !value.trustedRoot.startsWith("snowflake/"))
  ) {
    return "source-qualified roots must be unique safe .mts paths";
  }
  const rules = value.externalModules;
  if (
    !denseArray(rules) ||
    rules.length > MAX_NODE_CLOSURE_EDGES ||
    rules.some((rule) => !externalRule(rule)) ||
    new Set(
      rules.map((rule) => (rule as NodeExternalModuleRule).specifier),
    ).size !== rules.length
  ) {
    return "external module rules must be unique exact safe resolutions";
  }
  return undefined;
}

function externalFailure(
  rule: NodeExternalModuleRule | undefined,
  specifier: string,
  importer: string,
  repositoryRoot: string,
): string | undefined {
  if (rule === undefined) {
    return `external module "${specifier}" has no exact reviewed resolution`;
  }
  let actual: string;
  try {
    actual = resolveImport(
      specifier,
      pathToFileURL(resolve(repositoryRoot, importer)).href,
    );
  } catch {
    return `external module "${specifier}" cannot be resolved`;
  }
  if (rule.kind === "node-builtin") {
    return actual === rule.resolvedTarget
      ? undefined
      : `external module "${specifier}" resolved to unexpected target "${actual}"`;
  }
  let resolvedPath: string;
  try {
    const resolvedUrl = new URL(actual);
    if (
      resolvedUrl.protocol !== "file:" ||
      resolvedUrl.search !== "" ||
      resolvedUrl.hash !== ""
    ) {
      throw new Error("not a plain file");
    }
    resolvedPath = repositoryPath(repositoryRoot, fileURLToPath(resolvedUrl));
  } catch {
    return `package "${specifier}" did not resolve to a local locked file`;
  }
  if (
    resolvedPath !== rule.resolvedTarget ||
    !resolvedPath.startsWith("node_modules/")
  ) {
    return `package "${specifier}" resolved to unexpected target "${resolvedPath}"`;
  }
  const inspected = inspectPath(repositoryRoot, resolvedPath, "file");
  return "error" in inspected ? inspected.error : undefined;
}

function parseFailures(
  path: string,
  sourceText: string,
): NodeImportClosureViolation[] {
  const result = ts.transpileModule(sourceText, {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      allowImportingTsExtensions: true,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      target: ts.ScriptTarget.ESNext,
    },
  });
  return (result.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) =>
      finding(
        "parse-error",
        path,
        ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        diagnostic.file === undefined || diagnostic.start === undefined
          ? 0
          : diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
              .line + 1,
      ),
    );
}

function failedResult(
  violations: NodeImportClosureViolation[],
): NodeImportClosureResult {
  return {
    files: [],
    edgeCount: 0,
    sourceBytes: 0,
    violations: violations.sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.line - right.line ||
        left.kind.localeCompare(right.kind) ||
        left.detail.localeCompare(right.detail),
    ),
  };
}

/**
 * Verify bounded trusted Node static imports and exact module provenance.
 *
 * @param request - Complete roots and reviewed external resolutions.
 * @returns Canonical success-only closure evidence or deterministic findings.
 */
export function verifyNodeImportClosure(
  request: NodeImportClosureRequest,
): NodeImportClosureResult {
  const invalid = requestFailure(request);
  if (invalid !== undefined) {
    return failedResult([
      finding("invalid-input", "<node-import-closure>", invalid),
    ]);
  }
  let repositoryRoot: string;
  try {
    const stats = lstatSync(request.repositoryRoot);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error();
    repositoryRoot = realpathSync(request.repositoryRoot);
  } catch {
    return failedResult([
      finding(
        "unsafe-path",
        "<repository-root>",
        "repository root must be a real directory",
      ),
    ]);
  }
  const trustedRoot = inspectPath(
    repositoryRoot,
    request.trustedRoot,
    "directory",
  );
  if ("error" in trustedRoot) {
    return failedResult([
      finding("unsafe-path", request.trustedRoot, trustedRoot.error),
    ]);
  }
  const canonicalTrustedRoot = repositoryPath(
    repositoryRoot,
    trustedRoot.absolutePath,
  );

  const rules = new Map(
    request.externalModules.map((rule) => [rule.specifier, rule]),
  );
  const pending = [...request.entrypoints].sort().reverse();
  const attempted = new Set<string>();
  const inspectedFiles = new Set<string>();
  const files = new Set<string>();
  const violations: NodeImportClosureViolation[] = [];
  let edgeCount = 0;
  let sourceBytes = 0;

  while (pending.length > 0) {
    const path = pending.pop()!;
    if (attempted.has(path)) continue;
    attempted.add(path);
    const inspected = inspectPath(repositoryRoot, path, "file");
    if ("error" in inspected) {
      violations.push(finding("unsafe-path", path, inspected.error));
      continue;
    }
    const canonicalPath = repositoryPath(
      repositoryRoot,
      inspected.absolutePath,
    );
    if (inspectedFiles.has(canonicalPath)) continue;
    if (inspectedFiles.size >= MAX_NODE_CLOSURE_FILES) {
      violations.push(
        finding(
          "resource-limit",
          canonicalPath,
          `closure exceeds ${MAX_NODE_CLOSURE_FILES} source files`,
        ),
      );
      break;
    }
    inspectedFiles.add(canonicalPath);
    sourceBytes += inspected.stats.size;
    const sourceTooLarge = inspected.stats.size > MAX_NODE_SOURCE_BYTES;
    if (sourceTooLarge) {
      violations.push(
        finding(
          "resource-limit",
          canonicalPath,
          `source exceeds ${MAX_NODE_SOURCE_BYTES} bytes`,
        ),
      );
    }
    if (sourceBytes > MAX_NODE_CLOSURE_BYTES) {
      violations.push(
        finding(
          "resource-limit",
          canonicalPath,
          `closure exceeds ${MAX_NODE_CLOSURE_BYTES} source bytes`,
        ),
      );
      break;
    }
    if (sourceTooLarge) continue;
    let content: Buffer;
    let afterRead: Stats;
    try {
      content = readFileSync(inspected.absolutePath);
      afterRead = lstatSync(inspected.absolutePath);
    } catch {
      /* v8 ignore start -- defensive filesystem TOCTOU; no stable local repro. */
      violations.push(
        finding(
          "unsafe-path",
          canonicalPath,
          `"${canonicalPath}" cannot be read stably`,
        ),
      );
      continue;
      /* v8 ignore stop */
    }
    if (
      content.length !== inspected.stats.size ||
      !sameFile(inspected.stats, afterRead)
    ) {
      /* v8 ignore start -- defensive filesystem TOCTOU; no stable local repro. */
      violations.push(
        finding(
          "unsafe-path",
          canonicalPath,
          `"${canonicalPath}" changed while being read`,
        ),
      );
      continue;
      /* v8 ignore stop */
    }
    let sourceText: string;
    try {
      sourceText = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      violations.push(
        finding("parse-error", canonicalPath, "source is not valid UTF-8"),
      );
      continue;
    }
    const parseViolations = parseFailures(canonicalPath, sourceText);
    if (parseViolations.length > 0) {
      violations.push(...parseViolations);
      continue;
    }

    files.add(canonicalPath);
    const source = ts.createSourceFile(
      canonicalPath,
      sourceText,
      ts.ScriptTarget.Latest,
      true,
    );
    for (const statement of source.statements) {
      const edge = runtimeStaticEdge(statement);
      if (edge === undefined) continue;
      edgeCount += 1;
      const line = sourceLine(source, statement);
      if (edgeCount > MAX_NODE_CLOSURE_EDGES) {
        violations.push(
          finding(
            "resource-limit",
            canonicalPath,
            `closure exceeds ${MAX_NODE_CLOSURE_EDGES} static edges`,
            line,
          ),
        );
        pending.length = 0;
        break;
      }
      if (
        edge.declaration.attributes !== undefined ||
        (ts.isImportDeclaration(edge.declaration) &&
          edge.declaration.importClause?.phaseModifier !== undefined) ||
        !ts.isStringLiteralLike(edge.moduleSpecifier)
      ) {
        violations.push(
          finding(
            "unsupported-import",
            canonicalPath,
            "runtime import/export requires a plain literal without attributes or phase modifiers",
            line,
          ),
        );
        continue;
      }
      const specifier = edge.moduleSpecifier.text;
      const dependency = relativeDependency(
        canonicalPath,
        specifier,
        canonicalTrustedRoot,
        repositoryRoot,
      );
      if (dependency === "") {
        violations.push(
          finding(
            "unsupported-import",
            canonicalPath,
            `relative module "${specifier}" is not an explicit .mts source inside the trusted root`,
            line,
          ),
        );
      } else if (dependency !== undefined) {
        pending.push(dependency);
        pending.sort().reverse();
      } else {
        const failure = externalFailure(
          rules.get(specifier),
          specifier,
          canonicalPath,
          repositoryRoot,
        );
        if (failure !== undefined) {
          violations.push(
            finding(
              "unapproved-external-module",
              canonicalPath,
              failure,
              line,
            ),
          );
        }
      }
    }
  }

  if (violations.length > 0) return failedResult(violations);
  return {
    files: [...files].sort(),
    edgeCount,
    sourceBytes,
    violations: [],
  };
}
