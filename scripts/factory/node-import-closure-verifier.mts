/**
 * Verify the bounded Node static module closure required by D117-D118.
 *
 * The combined verifier admits only D126's exact protected adapter capability.
 * Neither path activates or declares any live job compliant.
 */

import {
  lstatSync,
  readFileSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { createHash } from "node:crypto";
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
/** Runtime-AST ceilings derived from the current factory corpus. */
export const MAX_NODE_AST_NODES = 100_000;
export const MAX_NODE_AST_DEPTH = 256;
/** Exact future D123 process-adapter identity; no production adapter exists yet. */
export const NODE_PROCESS_CAPABILITY_ADAPTER_PATH =
  "scripts/factory/node-process-capability.mts";

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
    | "unapproved-external-module"
    | "unsafe-runtime-capability";
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
type RequestSnapshot =
  | { readonly request: NodeImportClosureRequest }
  | { readonly error: string };
type ViolationKind = NodeImportClosureViolation["kind"];
type VerificationMode = "import-only" | "executable";

interface RuntimeScope {
  readonly parent: RuntimeScope | undefined;
  readonly bindings: Set<string>;
}

const RUNTIME_FORBIDDEN_MODULES = new Set([
  "bun",
  "child_process",
  "cluster",
  "cross-spawn",
  "execa",
  "module",
  "node:child_process",
  "node:cluster",
  "node:inspector",
  "node:module",
  "node:process",
  "node:repl",
  "node:sqlite",
  "node:vm",
  "node:wasi",
  "node:worker_threads",
  "repl",
  "shelljs",
  "vm",
  "wasi",
  "worker_threads",
]);
const DANGEROUS_GLOBALS = new Set([
  "AsyncFunction",
  "AsyncGeneratorFunction",
  "Bun",
  "Deno",
  "Function",
  "GeneratorFunction",
  "Reflect",
  "SharedWorker",
  "WebAssembly",
  "Worker",
  "createRequire",
  "eval",
  "require",
]);
const SAFE_PROCESS_MEMBERS = new Set([
  "argv",
  "cwd",
  "env",
  "exitCode",
]);
const SAFE_OBJECT_MEMBERS = new Set([
  "entries",
  "hasOwn",
  "keys",
  "prototype",
  "values",
]);
const SENSITIVE_GLOBAL_OBJECTS = new Set([
  "Object",
  "global",
  "globalThis",
  "module",
  "process",
]);
const EXACT_CHILD_PROCESS_SPECIFIERS = new Set([
  '"node:child_process"',
  "'node:child_process'",
]);
const NODE_PROCESS_CAPABILITY_ADAPTER_SOURCE_SHA256 =
  "650b5a7ed5f7fc038b21962c0d9176e62f744958031842c62e34870ab7c210e4";

function runtimeForbiddenModule(specifier: string): boolean {
  for (const forbidden of RUNTIME_FORBIDDEN_MODULES) {
    if (specifier === forbidden || specifier.startsWith(`${forbidden}/`)) {
      return true;
    }
  }
  return false;
}

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

function addBinding(scope: RuntimeScope, name: ts.BindingName): void {
  const pending: ts.BindingName[] = [name];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (ts.isIdentifier(current)) {
      scope.bindings.add(current.text);
      continue;
    }
    for (const element of current.elements) {
      if (!ts.isOmittedExpression(element)) pending.push(element.name);
    }
  }
}

function nodeChildren(node: ts.Node): ts.Node[] {
  const children: ts.Node[] = [];
  ts.forEachChild(node, (child) => {
    children.push(child);
  });
  return children;
}

function hasDeclareModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    ts
      .getModifiers(node)
      ?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) ===
      true
  );
}

function ambientVariable(node: ts.VariableDeclaration): boolean {
  const statement = node.parent.parent;
  return ts.isVariableStatement(statement) && hasDeclareModifier(statement);
}

function runtimeAstLimitFailure(source: ts.SourceFile): string | undefined {
  const pending: { readonly node: ts.Node; readonly depth: number }[] = [
    { node: source, depth: 1 },
  ];
  let nodes = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    nodes += 1;
    if (nodes > MAX_NODE_AST_NODES) {
      return `runtime AST exceeds ${MAX_NODE_AST_NODES} nodes`;
    }
    if (current.depth > MAX_NODE_AST_DEPTH) {
      return `runtime AST exceeds depth ${MAX_NODE_AST_DEPTH}`;
    }
    for (const child of nodeChildren(current.node)) {
      pending.push({ node: child, depth: current.depth + 1 });
    }
  }
  return undefined;
}

function runtimeScopeBoundary(node: ts.Node): boolean {
  return (
    ts.isSourceFile(node) ||
    ts.isFunctionLike(node) ||
    ts.isClassLike(node) ||
    ts.isClassStaticBlockDeclaration(node) ||
    ts.isBlock(node) ||
    ts.isCaseBlock(node) ||
    ts.isCatchClause(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node)
  );
}

function runtimeFunctionBody(node: ts.Node): ts.ConciseBody | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  ) {
    return node.body;
  }
  return undefined;
}

function collectRuntimeScopes(source: ts.SourceFile): WeakMap<ts.Node, RuntimeScope> {
  const scopes = new WeakMap<ts.Node, RuntimeScope>();
  const root: RuntimeScope = { parent: undefined, bindings: new Set() };
  const pending: {
    readonly node: ts.Node;
    readonly lexicalScope: RuntimeScope;
    readonly functionScope: RuntimeScope;
  }[] = nodeChildren(source)
    .reverse()
    .map((node) => ({
      node,
      lexicalScope: root,
      functionScope: root,
    }));

  scopes.set(source, root);
  while (pending.length > 0) {
    const work = pending.pop()!;
    const { node } = work;
    let { lexicalScope, functionScope } = work;
    if (
      ((ts.isFunctionDeclaration(node) && node.body !== undefined) ||
        ts.isClassDeclaration(node)) &&
      node.name !== undefined &&
      !hasDeclareModifier(node)
    ) {
      lexicalScope.bindings.add(node.name.text);
    }

    if (node !== source && runtimeScopeBoundary(node)) {
      lexicalScope = { parent: lexicalScope, bindings: new Set() };
      if (
        ts.isFunctionLike(node) ||
        ts.isClassStaticBlockDeclaration(node)
      ) {
        functionScope = lexicalScope;
      }
    }
    scopes.set(node, lexicalScope);

    if (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly !== true) {
      const clause = node.importClause;
      if (clause?.name !== undefined) lexicalScope.bindings.add(clause.name.text);
      if (clause?.namedBindings !== undefined) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          lexicalScope.bindings.add(clause.namedBindings.name.text);
        } else {
          for (const element of clause.namedBindings.elements) {
            if (!element.isTypeOnly) lexicalScope.bindings.add(element.name.text);
          }
        }
      }
    } else if (ts.isVariableDeclaration(node) && !ambientVariable(node)) {
      const declarationList = node.parent;
      const target =
        ts.isVariableDeclarationList(declarationList) &&
        (declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0
          ? functionScope
          : lexicalScope;
      addBinding(target, node.name);
    } else if (ts.isParameter(node)) {
      addBinding(functionScope, node.name);
    } else if (
      ts.isCatchClause(node) &&
      node.variableDeclaration !== undefined
    ) {
      addBinding(lexicalScope, node.variableDeclaration.name);
    } else if (
      (ts.isFunctionExpression(node) || ts.isClassExpression(node)) &&
      node.name !== undefined
    ) {
      lexicalScope.bindings.add(node.name.text);
    }

    const children = nodeChildren(node);
    const functionBody = runtimeFunctionBody(node);
    const functionBodyScope =
      functionBody !== undefined &&
      ts.isBlock(functionBody)
        ? { parent: lexicalScope, bindings: new Set<string>() }
        : undefined;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]!;
      const childIsFunctionBody =
        functionBodyScope !== undefined &&
        child === functionBody;
      pending.push({
        node: child,
        lexicalScope: childIsFunctionBody
          ? functionBodyScope
          : lexicalScope,
        functionScope: childIsFunctionBody
          ? functionBodyScope
          : functionScope,
      });
    }
  }

  return scopes;
}

function locallyBound(
  name: string,
  node: ts.Node,
  scopes: WeakMap<ts.Node, RuntimeScope>,
): boolean {
  let scope = scopes.get(node);
  while (scope !== undefined) {
    if (scope.bindings.has(name)) return true;
    scope = scope.parent;
  }
  return false;
}

function typeContext(node: ts.Node): boolean {
  let current = node.parent;
  while (current !== undefined) {
    if (ts.isTypeNode(current)) return true;
    if (ts.isExpression(current) || ts.isStatement(current)) return false;
    current = current.parent;
  }
  /* v8 ignore next -- identifiers visited from a source file reach a type, expression, or statement ancestor. */
  return false;
}

function valueIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (typeContext(node)) return false;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isPropertyDeclaration(parent) && parent.name === node) ||
    (ts.isPropertySignature(parent) && parent.name === node) ||
    (ts.isMethodSignature(parent) && parent.name === node) ||
    ts.isImportClause(parent) ||
    ts.isImportSpecifier(parent) ||
    ts.isNamespaceImport(parent) ||
    ts.isExportSpecifier(parent) ||
    ts.isLabeledStatement(parent) ||
    ts.isBreakOrContinueStatement(parent)
  ) {
    return false;
  }
  return !(
    "name" in parent &&
    parent.name === node &&
    (ts.isVariableDeclaration(parent) ||
      ts.isParameter(parent) ||
      ts.isFunctionDeclaration(parent) ||
      ts.isFunctionExpression(parent) ||
      ts.isClassDeclaration(parent) ||
      ts.isClassExpression(parent) ||
      ts.isInterfaceDeclaration(parent) ||
      ts.isTypeAliasDeclaration(parent) ||
      ts.isEnumDeclaration(parent) ||
      ts.isModuleDeclaration(parent) ||
      ts.isBindingElement(parent))
  );
}

function unwrappedExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function directUnboundIdentifier(
  expression: ts.Expression,
  name: string,
  scopes: WeakMap<ts.Node, RuntimeScope>,
): boolean {
  const unwrapped = unwrappedExpression(expression);
  return (
    ts.isIdentifier(unwrapped) &&
    unwrapped.text === name &&
    !locallyBound(name, unwrapped, scopes)
  );
}

function memberName(
  node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const argument = node.argumentExpression;
  return argument !== undefined &&
    (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument))
    ? argument.text
    : undefined;
}

function exactAdapterProcessImport(
  statement: ts.Statement,
  source: ts.SourceFile,
): boolean {
  if (!ts.isImportDeclaration(statement)) return false;
  const clause = statement.importClause;
  return (
    EXACT_CHILD_PROCESS_SPECIFIERS.has(
      statement.moduleSpecifier.getText(source),
    ) &&
    statement.attributes === undefined &&
    clause !== undefined &&
    clause.isTypeOnly !== true &&
    clause.name === undefined &&
    clause.phaseModifier === undefined &&
    clause.namedBindings !== undefined &&
    ts.isNamedImports(clause.namedBindings) &&
    clause.namedBindings.elements.length === 1 &&
    clause.namedBindings.elements[0]?.isTypeOnly !== true &&
    clause.namedBindings.elements[0]?.propertyName === undefined &&
    clause.namedBindings.elements[0]?.name.text === "spawnSync" &&
    clause.namedBindings.elements[0]?.name.getText(source) === "spawnSync"
  );
}

function adapterSourceSha256(source: ts.SourceFile): string {
  return createHash("sha256").update(source.text, "utf8").digest("hex");
}

function exactString(expression: ts.Expression, value: string): boolean {
  const unwrapped = unwrappedExpression(expression);
  return ts.isStringLiteralLike(unwrapped) && unwrapped.text === value;
}

function exactNumber(expression: ts.Expression, value: number): boolean {
  const unwrapped = unwrappedExpression(expression);
  return ts.isNumericLiteral(unwrapped) && Number(unwrapped.text) === value;
}

function exactBoolean(expression: ts.Expression, value: boolean): boolean {
  const unwrapped = unwrappedExpression(expression);
  return unwrapped.kind ===
    (value ? ts.SyntaxKind.TrueKeyword : ts.SyntaxKind.FalseKeyword);
}

function exactStringArray(
  expression: ts.Expression,
  values: readonly string[],
): boolean {
  const unwrapped = unwrappedExpression(expression);
  return (
    ts.isArrayLiteralExpression(unwrapped) &&
    unwrapped.elements.length === values.length &&
    unwrapped.elements.every(
      (element, index) =>
        ts.isExpression(element) && exactString(element, values[index]!),
    )
  );
}

function exactPropertyPath(
  expression: ts.Expression,
  path: readonly string[],
): boolean {
  let current = unwrappedExpression(expression);
  const names: string[] = [];
  while (ts.isPropertyAccessExpression(current)) {
    /* v8 ignore next -- the exact source registry fixes the adapter's property paths. */
    if (current.questionDotToken !== undefined) return false;
    names.unshift(current.name.text);
    current = unwrappedExpression(current.expression);
  }
  return (
    ts.isIdentifier(current) &&
    [current.text, ...names].join(".") === path.join(".")
  );
}

function exactObjectProperties(
  expression: ts.Expression,
): Map<string, ts.Expression> | undefined {
  const unwrapped = unwrappedExpression(expression);
  /* v8 ignore next -- the exact source registry fixes adapter option objects. */
  if (!ts.isObjectLiteralExpression(unwrapped)) return undefined;
  const properties = new Map<string, ts.Expression>();
  for (const property of unwrapped.properties) {
    /* v8 ignore next -- the exact source registry fixes adapter property assignments. */
    if (
      !ts.isPropertyAssignment(property) ||
      ts.isComputedPropertyName(property.name)
    ) {
      return undefined;
    }
    /* v8 ignore next -- the exact source registry fixes adapter property-name syntax. */
    const name =
      ts.isIdentifier(property.name) ||
      ts.isStringLiteralLike(property.name) ||
      ts.isNumericLiteral(property.name)
        ? property.name.text
        : undefined;
    /* v8 ignore next -- the exact source registry precludes missing or duplicate property names. */
    if (name === undefined || properties.has(name)) return undefined;
    properties.set(name, property.initializer);
  }
  return properties;
}

function exactAdapterEnvironment(expression: ts.Expression): boolean {
  const properties = exactObjectProperties(expression);
  const expected = new Map([
    ["GIT_CONFIG_COUNT", "1"],
    ["GIT_CONFIG_GLOBAL", "/dev/null"],
    ["GIT_CONFIG_KEY_0", "core.fsmonitor"],
    ["GIT_CONFIG_NOSYSTEM", "1"],
    ["GIT_CONFIG_VALUE_0", "false"],
    ["GIT_OPTIONAL_LOCKS", "0"],
    ["GIT_TERMINAL_PROMPT", "0"],
    ["LC_ALL", "C"],
  ]);
  return (
    properties !== undefined &&
    properties.size === expected.size &&
    [...expected].every(([name, value]) => {
      const property = properties.get(name);
      return property !== undefined && exactString(property, value);
    })
  );
}

function exactAdapterSpawnOptions(expression: ts.Expression): boolean {
  const properties = exactObjectProperties(expression);
  /* v8 ignore next -- the exact source registry fixes the nine-option object shape. */
  if (properties === undefined || properties.size !== 9) return false;
  const cwd = properties.get("cwd");
  const encoding = properties.get("encoding");
  const environment = properties.get("env");
  const killSignal = properties.get("killSignal");
  const maxBuffer = properties.get("maxBuffer");
  const shell = properties.get("shell");
  const stdio = properties.get("stdio");
  const timeout = properties.get("timeout");
  const windowsHide = properties.get("windowsHide");
  return (
    cwd !== undefined &&
    exactPropertyPath(cwd, ["rootIdentity", "canonicalPath"]) &&
    encoding !== undefined &&
    exactString(encoding, "buffer") &&
    environment !== undefined &&
    exactAdapterEnvironment(environment) &&
    killSignal !== undefined &&
    exactString(killSignal, "SIGKILL") &&
    maxBuffer !== undefined &&
    exactNumber(maxBuffer, 16_777_216) &&
    shell !== undefined &&
    exactBoolean(shell, false) &&
    stdio !== undefined &&
    exactStringArray(stdio, ["ignore", "pipe", "pipe"]) &&
    timeout !== undefined &&
    exactNumber(timeout, 30_000) &&
    windowsHide !== undefined &&
    exactBoolean(windowsHide, true)
  );
}

function enclosingFunction(node: ts.Node): ts.SignatureDeclaration | undefined {
  let current = node.parent;
  while (current !== undefined) {
    if (ts.isFunctionLike(current)) return current;
    current = current.parent;
  }
  /* v8 ignore next -- the exact source registry fixes the process call inside its function. */
  return undefined;
}

function exactAdapterProcessCall(node: ts.CallExpression): boolean {
  const owner = enclosingFunction(node);
  return (
    ts.isIdentifier(node.expression) &&
    node.expression.text === "spawnSync" &&
    node.arguments.length === 3 &&
    exactString(node.arguments[0]!, "/usr/bin/git") &&
    exactStringArray(node.arguments[1]!, ["ls-files", "-z"]) &&
    exactAdapterSpawnOptions(node.arguments[2]!) &&
    owner !== undefined &&
    ts.isFunctionDeclaration(owner) &&
    owner.name?.text === "listTrackedPaths" &&
    owner.parameters.length === 1 &&
    ts.isIdentifier(owner.parameters[0]!.name) &&
    owner.parameters[0]!.name.text === "repositoryRoot" &&
    owner.parameters[0]!.type?.kind === ts.SyntaxKind.StringKeyword
  );
}

function runtimeModuleSpecifier(
  node: ts.Node,
): ts.Expression | undefined {
  if (ts.isImportDeclaration(node)) {
    return node.importClause?.isTypeOnly === true
      ? undefined
      : node.moduleSpecifier;
  }
  return ts.isExportDeclaration(node) && !node.isTypeOnly
    ? node.moduleSpecifier
    : undefined;
}

function runtimeCapabilityViolations(
  path: string,
  source: ts.SourceFile,
): NodeImportClosureViolation[] {
  const violations: NodeImportClosureViolation[] = [];
  const scopes = collectRuntimeScopes(source);
  let adapterProcessCalls = 0;

  function reject(node: ts.Node, detail: string): void {
    if (violations.length > 0) return;
    violations.push(
      finding(
        "unsafe-runtime-capability",
        path,
        detail,
        sourceLine(source, node),
      ),
    );
  }

  if (
    path === NODE_PROCESS_CAPABILITY_ADAPTER_PATH &&
    adapterSourceSha256(source) !==
      NODE_PROCESS_CAPABILITY_ADAPTER_SOURCE_SHA256
  ) {
    reject(
      source,
      "the protected process adapter does not match the exact D126 source registry",
    );
    return violations;
  }

  const pending: ts.Node[] = [source];
  while (pending.length > 0) {
    const node = pending.pop()!;
    const moduleSpecifier = runtimeModuleSpecifier(node);
    if (
      ts.isEnumDeclaration(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isImportEqualsDeclaration(node) ||
      ts.isDecorator(node) ||
      ts.isTypeAssertionExpression(node) ||
      (ts.isFunctionDeclaration(node) && node.body === undefined) ||
      hasDeclareModifier(node)
    ) {
      reject(node, "runtime source uses TypeScript syntax unsupported by Node type stripping");
    }

    if (
      ts.isParameter(node) &&
      node.modifiers?.some((modifier) =>
        new Set([
          ts.SyntaxKind.PrivateKeyword,
          ts.SyntaxKind.ProtectedKeyword,
          ts.SyntaxKind.PublicKeyword,
          ts.SyntaxKind.ReadonlyKeyword,
        ]).has(modifier.kind),
      )
    ) {
      reject(node, "runtime source uses a TypeScript parameter property");
    }

    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(moduleSpecifier) &&
      runtimeForbiddenModule(moduleSpecifier.text) &&
      !(
        ts.isImportDeclaration(node) &&
        path === NODE_PROCESS_CAPABILITY_ADAPTER_PATH &&
        moduleSpecifier.text === "node:child_process" &&
        exactAdapterProcessImport(node, source)
      )
    ) {
      reject(
        node,
        `runtime module "${moduleSpecifier.text}" is outside the closed capability grammar`,
      );
    }

    if (ts.isBindingElement(node)) {
      const boundProperty = node.propertyName ?? node.name;
      if (ts.isComputedPropertyName(boundProperty)) {
        reject(
          node,
          "computed destructuring is outside the closed capability grammar",
        );
      }
      if (
        (ts.isIdentifier(boundProperty) ||
          ts.isStringLiteralLike(boundProperty)) &&
        boundProperty.text === "constructor"
      ) {
        reject(
          node,
          "runtime constructor extraction is outside the closed capability grammar",
        );
      }
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      reject(node, "dynamic import is outside the closed capability grammar");
    }

    if (
      path === NODE_PROCESS_CAPABILITY_ADAPTER_PATH &&
      ts.isIdentifier(node) &&
      node.text === "spawnSync" &&
      locallyBound(node.text, node, scopes)
    ) {
      const importBinding =
        ts.isImportSpecifier(node.parent) &&
        node.parent.name === node &&
        node.parent.propertyName === undefined;
      const directCall =
        ts.isCallExpression(node.parent) &&
        node.parent.expression === node &&
        exactAdapterProcessCall(node.parent);
      if (directCall) adapterProcessCalls += 1;
      /* v8 ignore next -- the exact source registry precludes alternate process-binding uses. */
      if (
        !importBinding &&
        (!directCall || adapterProcessCalls > 1)
      ) {
        reject(
          node,
          "the protected process binding may only be used by the one exact listTrackedPaths capability",
        );
      }
    }

    if (ts.isIdentifier(node) && valueIdentifier(node)) {
      if (
        DANGEROUS_GLOBALS.has(node.text) &&
        !locallyBound(node.text, node, scopes)
      ) {
        reject(node, `runtime global "${node.text}" is outside the closed capability grammar`);
      }
    }

    if (
      ts.isPropertyAccessExpression(node) ||
      ts.isElementAccessExpression(node)
    ) {
      const name = memberName(node);
      const receiver = node.expression;
      if (name === "constructor") {
        reject(node, "runtime constructor reflection is outside the closed capability grammar");
      } else if (
        directUnboundIdentifier(receiver, "process", scopes) &&
        (!ts.isPropertyAccessExpression(node) ||
          name === undefined ||
          !SAFE_PROCESS_MEMBERS.has(name))
      ) {
        reject(node, "process access is outside the closed property grammar");
      } else if (
        directUnboundIdentifier(receiver, "module", scopes)
      ) {
        reject(node, "module access is outside the closed property grammar");
      } else if (
        directUnboundIdentifier(receiver, "Object", scopes) &&
        (!ts.isPropertyAccessExpression(node) ||
          name === undefined ||
          !SAFE_OBJECT_MEMBERS.has(name))
      ) {
        reject(node, "Object access is outside the closed property grammar");
      } else if (
        (directUnboundIdentifier(receiver, "globalThis", scopes) ||
          directUnboundIdentifier(receiver, "global", scopes))
      ) {
        reject(node, "global object access is outside the closed property grammar");
      } else if (
        ts.isElementAccessExpression(node) &&
        name === undefined
      ) {
        reject(node, "non-literal computed member access is outside the closed capability grammar");
      }
    }

    if (
      ts.isIdentifier(node) &&
      SENSITIVE_GLOBAL_OBJECTS.has(node.text) &&
      valueIdentifier(node) &&
      !locallyBound(node.text, node, scopes) &&
      !(
        (ts.isPropertyAccessExpression(node.parent) ||
          ts.isElementAccessExpression(node.parent)) &&
        node.parent.expression === node
      )
    ) {
      reject(
        node,
        `the ${node.text} object may only be used through direct reviewed properties`,
      );
    }

    const children = nodeChildren(node);
    if (violations.length > 0) break;
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push(children[index]!);
    }
  }

  return violations;
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

function requestFailure(value: Record<string, unknown>): string | undefined {
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
    entrypoints.length === 0 ||
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
    rules.some((rule) => !externalRule(rule)) ||
    new Set(
      rules.map((rule) => (rule as NodeExternalModuleRule).specifier),
    ).size !== rules.length
  ) {
    return "external module rules must be unique exact safe resolutions";
  }
  return undefined;
}

function snapshotRequest(request: unknown): RequestSnapshot {
  if (typeof request !== "object" || request === null) {
    return { error: "closure evidence has an invalid runtime shape" };
  }
  let repositoryRoot: unknown;
  let trustedRoot: unknown;
  let trustedSourceClass: unknown;
  let rootsComplete: unknown;
  let entrypointValues: unknown;
  let externalModuleValues: unknown;
  try {
    const value = request as Record<string, unknown>;
    repositoryRoot = value.repositoryRoot;
    trustedRoot = value.trustedRoot;
    trustedSourceClass = value.trustedSourceClass;
    rootsComplete = value.rootsComplete;
    entrypointValues = value.entrypoints;
    externalModuleValues = value.externalModules;
  } catch {
    return { error: "closure evidence has an invalid runtime shape" };
  }
  let arraysValid: boolean;
  try {
    arraysValid =
      Array.isArray(entrypointValues) &&
      Array.isArray(externalModuleValues);
  } catch {
    return { error: "closure evidence has an invalid runtime shape" };
  }
  if (!arraysValid) {
    return { error: "closure evidence has an invalid runtime shape" };
  }
  const entrypointArray = entrypointValues as unknown[];
  const externalModuleArray = externalModuleValues as unknown[];

  let entrypoints: unknown[];
  try {
    const length: unknown = entrypointArray.length;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_NODE_CLOSURE_FILES
    ) {
      return {
        error: "source-qualified roots must be unique safe .mts paths",
      };
    }
    entrypoints = [];
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(entrypointArray, index)) {
        return {
          error: "source-qualified roots must be unique safe .mts paths",
        };
      }
      entrypoints.push(entrypointArray[index]);
    }
  } catch {
    return { error: "source-qualified roots must be unique safe .mts paths" };
  }

  let externalModules: unknown[];
  try {
    const length: unknown = externalModuleArray.length;
    if (
      typeof length !== "number" ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > MAX_NODE_CLOSURE_EDGES
    ) {
      return {
        error: "external module rules must be unique exact safe resolutions",
      };
    }
    externalModules = [];
    for (let index = 0; index < length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(externalModuleArray, index)) {
        return {
          error: "external module rules must be unique exact safe resolutions",
        };
      }
      const candidate = externalModuleArray[index];
      if (typeof candidate !== "object" || candidate === null) {
        externalModules.push(candidate);
        continue;
      }
      const rule = candidate as Record<string, unknown>;
      externalModules.push({
        kind: rule.kind,
        specifier: rule.specifier,
        resolvedTarget: rule.resolvedTarget,
      });
    }
  } catch {
    return {
      error: "external module rules must be unique exact safe resolutions",
    };
  }

  const value: Record<string, unknown> = {
    repositoryRoot,
    trustedRoot,
    trustedSourceClass,
    rootsComplete,
    entrypoints,
    externalModules,
  };
  const invalid = requestFailure(value);
  return invalid === undefined
    ? { request: value as unknown as NodeImportClosureRequest }
    : { error: invalid };
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

function verifyNodeClosure(
  request: NodeImportClosureRequest,
  mode: VerificationMode,
): NodeImportClosureResult {
  const snapshot = snapshotRequest(request);
  if ("error" in snapshot) {
    return failedResult([
      finding("invalid-input", "<node-import-closure>", snapshot.error),
    ]);
  }
  request = snapshot.request;
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
    let source: ts.SourceFile;
    let parseViolations: NodeImportClosureViolation[];
    try {
      source = ts.createSourceFile(
        canonicalPath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
      );
      const astLimitFailure =
        mode === "executable" ? runtimeAstLimitFailure(source) : undefined;
      if (astLimitFailure !== undefined) {
        violations.push(
          finding("resource-limit", canonicalPath, astLimitFailure),
        );
        continue;
      }
      parseViolations = parseFailures(canonicalPath, sourceText);
    } catch {
      /* v8 ignore start -- explicit AST limits catch reproducible complexity before this parser fallback. */
      violations.push(
        finding(
          "resource-limit",
          canonicalPath,
          "source exceeds supported AST complexity",
        ),
      );
      continue;
      /* v8 ignore stop */
    }
    if (parseViolations.length > 0) {
      violations.push(...parseViolations);
      continue;
    }

    files.add(canonicalPath);
    if (mode === "executable") {
      try {
        violations.push(...runtimeCapabilityViolations(canonicalPath, source));
      } catch {
        /* v8 ignore next -- defensive analyzer failure must erase evidence. */
        violations.push(
          finding(
            "unsafe-runtime-capability",
            canonicalPath,
            "runtime capability analysis failed closed",
          ),
        );
      }
    }
    let adapterProcessImports = 0;
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
        const adapterProcessImport =
          mode === "executable" &&
          canonicalPath === NODE_PROCESS_CAPABILITY_ADAPTER_PATH &&
          specifier === "node:child_process" &&
          exactAdapterProcessImport(statement, source);
        if (adapterProcessImport) {
          adapterProcessImports += 1;
          if (adapterProcessImports > 1) {
            violations.push(
              finding(
                "unsafe-runtime-capability",
                canonicalPath,
                "the protected process adapter must have one exact child-process import",
                line,
              ),
            );
          }
          continue;
        }
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
    if (
      mode === "executable" &&
      canonicalPath === NODE_PROCESS_CAPABILITY_ADAPTER_PATH &&
      adapterProcessImports !== 1
    ) {
      violations.push(
        finding(
          "unsafe-runtime-capability",
          canonicalPath,
          "the protected process adapter must have one exact child-process import",
        ),
      );
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

/**
 * Verify bounded trusted Node static imports and exact module provenance.
 *
 * This import-only contract remains universally strict: it does not recognize
 * the future process adapter exception used by the combined verifier.
 *
 * @param request - Complete roots and reviewed external resolutions.
 * @returns Canonical success-only closure evidence or deterministic findings.
 */
export function verifyNodeImportClosure(
  request: NodeImportClosureRequest,
): NodeImportClosureResult {
  return verifyNodeClosure(request, "import-only");
}

/**
 * Verify static provenance and repository runtime capabilities in one read.
 *
 * Both analyzers receive the same canonical path, stable source bytes, decoded
 * text, and TypeScript AST. The only process capability is D126's exact
 * protected `listTrackedPaths` adapter; no live workflow is activated.
 *
 * @param request - Complete roots and reviewed external resolutions.
 * @returns Canonical success-only closure evidence or deterministic findings.
 */
export function verifyNodeExecutableClosure(
  request: NodeImportClosureRequest,
): NodeImportClosureResult {
  return verifyNodeClosure(request, "executable");
}
