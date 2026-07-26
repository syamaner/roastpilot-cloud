import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_NODE_AST_DEPTH,
  MAX_NODE_AST_NODES,
  NODE_PROCESS_CAPABILITY_ADAPTER_PATH,
  verifyNodeExecutableClosure,
  verifyNodeImportClosure,
  type NodeImportClosureRequest,
  type NodeImportClosureResult,
} from "../../scripts/factory/node-import-closure-verifier.mts";

let repositoryRoot: string;
const ACTUAL_REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PRODUCTION_ADAPTER_SOURCE = readFileSync(
  join(ACTUAL_REPOSITORY_ROOT, NODE_PROCESS_CAPABILITY_ADAPTER_PATH),
  "utf8",
);

async function put(path: string, content: string): Promise<void> {
  const absolute = join(repositoryRoot, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

function request(
  overrides: Partial<NodeImportClosureRequest> = {},
): NodeImportClosureRequest {
  return {
    repositoryRoot,
    trustedRoot: "scripts/factory/trusted",
    trustedSourceClass: "protected-glue",
    rootsComplete: true,
    entrypoints: ["scripts/factory/trusted/entry.mts"],
    externalModules: [],
    ...overrides,
  };
}

function expectViolation(
  result: NodeImportClosureResult,
  kind: NodeImportClosureResult["violations"][number]["kind"],
  detail: string,
): void {
  expect(result).toEqual({
    files: [],
    edgeCount: 0,
    sourceBytes: 0,
    violations: expect.arrayContaining([
      expect.objectContaining({
        kind,
        detail: expect.stringContaining(detail),
      }),
    ]),
  });
}

beforeEach(async () => {
  repositoryRoot = await mkdtemp(join(tmpdir(), "node-runtime-closure-"));
  await put("scripts/factory/trusted/entry.mts", "export const ready = true;\n");
});

afterEach(async () => {
  await rm(repositoryRoot, { recursive: true, force: true });
});

describe("verifyNodeExecutableClosure closed runtime grammar", () => {
  it("accepts ordinary calls, constructors, direct process properties, and shadowed names", async () => {
    const source = [
      "class LocalThing {}",
      "const match = /x/.exec('x');",
      "const item = new LocalThing();",
      "const indexed = [1][0] + ({ safe: 2 })['safe'];",
      "const named = function LocalFunction() {};",
      "try { throw new Error('x'); } catch (reason) { void reason; }",
      "function local(",
      "  Function: (value: string) => string,",
      "  require: (value: string) => string,",
      "  Worker: new () => object,",
      ") {",
      "  return [Function('x'), require('x'), new Worker()];",
      "}",
      "const process = { kill: () => true };",
      "const module = { require: () => true };",
      "process.kill();",
      "module.require();",
      "export { indexed, item, local, match, named };",
      "",
    ].join("\n");
    await put("scripts/factory/trusted/entry.mts", source);

    expect(verifyNodeExecutableClosure(request())).toEqual({
      files: ["scripts/factory/trusted/entry.mts"],
      edgeCount: 0,
      sourceBytes: Buffer.byteLength(source),
      violations: [],
    });
  });

  it("accepts the direct reviewed process properties used by factory scripts", async () => {
    const source = [
      "const args = process.argv;",
      "const env = process.env;",
      "const cwd = process.cwd();",
      "process.exitCode = args.length + Object.keys(env).length + cwd.length;",
      "",
    ].join("\n");
    await put("scripts/factory/trusted/entry.mts", source);

    expect(verifyNodeExecutableClosure(request()).violations).toEqual([]);
  });

  it("preserves the import-only contract while combined mode rejects runtime-only syntax", async () => {
    const source = "export const result = eval('1 + 1');\n";
    await put("scripts/factory/trusted/entry.mts", source);

    expect(verifyNodeImportClosure(request())).toEqual({
      files: ["scripts/factory/trusted/entry.mts"],
      edgeCount: 0,
      sourceBytes: Buffer.byteLength(source),
      violations: [],
    });
    expectViolation(
      verifyNodeExecutableClosure(request()),
      "unsafe-runtime-capability",
      'runtime global "eval"',
    );
  });

  it("finds and attributes a runtime violation in a transitive dependency", async () => {
    await put(
      "scripts/factory/trusted/entry.mts",
      'import "./dependency.mts";\n',
    );
    await put(
      "scripts/factory/trusted/dependency.mts",
      "export const result = eval('1 + 1');\n",
    );

    const result = verifyNodeExecutableClosure(request());

    expect(result.files).toEqual([]);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "unsafe-runtime-capability",
          path: "scripts/factory/trusted/dependency.mts",
          line: 1,
        }),
      ]),
    );
  });

  it("sorts multi-file runtime findings and erases all partial success evidence", async () => {
    await put(
      "scripts/factory/trusted/entry.mts",
      'import "./b.mts";\nimport "./a.mts";\n',
    );
    await put(
      "scripts/factory/trusted/a.mts",
      "export const a = eval('1');\n",
    );
    await put(
      "scripts/factory/trusted/b.mts",
      "// line one\nexport const b = eval('2');\n",
    );

    expect(verifyNodeExecutableClosure(request())).toEqual({
      files: [],
      edgeCount: 0,
      sourceBytes: 0,
      violations: [
        {
          kind: "unsafe-runtime-capability",
          path: "scripts/factory/trusted/a.mts",
          line: 1,
          detail: 'runtime global "eval" is outside the closed capability grammar',
        },
        {
          kind: "unsafe-runtime-capability",
          path: "scripts/factory/trusted/b.mts",
          line: 2,
          detail: 'runtime global "eval" is outside the closed capability grammar',
        },
      ],
    });
  });

  it.each([
    ["dynamic import", "void import('./other.mts');", "dynamic import"],
    ["global require", "require('./other.mts');", 'runtime global "require"'],
    ["require resolve", "require.resolve('./other.mts');", 'runtime global "require"'],
    ["module require", "module.require('./other.mts');", "module access"],
    ["module register", "module.register('./other.mts');", "module access"],
    ["createRequire", "createRequire(import.meta.url);", 'runtime global "createRequire"'],
    [
      "process main module",
      "process.mainModule?.require('./other.mts');",
      "process access",
    ],
    [
      "process builtin module",
      "process.getBuiltinModule('node:fs');",
      "process access",
    ],
    ["process binding", "process.binding('spawn_sync');", "process access"],
    [
      "linked binding",
      "process._linkedBinding('spawn_sync');",
      "process access",
    ],
    ["computed process", "process['getBuiltinModule']('node:fs');", "process access"],
    ["unknown computed process", "process[key]('node:fs');", "process access"],
    [
      "process identity recovery",
      "process.valueOf().getBuiltinModule('node:child_process');",
      "process access",
    ],
    ["aliased process", "const p = process; void p;", "process object"],
    [
      "global process alias",
      "const p = globalThis.process; void p;",
      "global object access",
    ],
    ["aliased module", "const m = module; void m;", "module object"],
    [
      "global identity recovery",
      "globalThis.valueOf().eval('1 + 1');",
      "global object access",
    ],
    [
      "nested global identity",
      "globalThis.global.eval('1 + 1');",
      "global object access",
    ],
    ["direct eval", "eval('1 + 1');", 'runtime global "eval"'],
    ["indirect eval", "(0, eval)('1 + 1');", 'runtime global "eval"'],
    ["aliased eval", "const run = eval; run('1 + 1');", 'runtime global "eval"'],
    [
      "class field eval",
      "class Value { field = eval('1') }\nvoid Value;",
      'runtime global "eval"',
    ],
    [
      "static block eval",
      "class Value { static { eval('1') } }\nvoid Value;",
      'runtime global "eval"',
    ],
    [
      "computed class key eval",
      "class Value { [eval('1')]() {} }\nvoid Value;",
      'runtime global "eval"',
    ],
    ["Function call", "Function('return 1');", 'runtime global "Function"'],
    ["Function constructor", "new Function('return 1');", 'runtime global "Function"'],
    [
      "async constructor",
      "AsyncFunction('return 1');",
      'runtime global "AsyncFunction"',
    ],
    [
      "generator constructor",
      "GeneratorFunction('return 1');",
      'runtime global "GeneratorFunction"',
    ],
    [
      "computed global Function",
      "globalThis['Function']('return 1');",
      "global object access",
    ],
    ["aliased global", "const root = globalThis; void root;", "globalThis object"],
    [
      "constructor reflection",
      "const build = (() => {}).constructor; void build;",
      "constructor reflection",
    ],
    [
      "reflective constructor access",
      'const build = Reflect.get(() => {}, "constructor"); void build;',
      'runtime global "Reflect"',
    ],
    [
      "global reflective constructor access",
      'const build = globalThis.Reflect.get(() => {}, "constructor"); void build;',
      "global object access",
    ],
    [
      "descriptor constructor access",
      [
        'const descriptor = Object.getOwnPropertyDescriptor(',
        '  Object.getPrototypeOf(() => {}),',
        '  "constructor",',
        ");",
        "const build = descriptor!.value;",
        "build('return process')();",
      ].join("\n"),
      "Object access",
    ],
    [
      "destructured constructor access",
      "const { constructor: build } = (() => {}); void build;",
      "constructor extraction",
    ],
    [
      "computed constructor binding",
      'const key = "constructor"; const build = (() => {})[key]; void build;',
      "non-literal computed member access",
    ],
    [
      "computed constructor expression",
      'const build = (() => {})["con" + "structor"]; void build;',
      "non-literal computed member access",
    ],
    [
      "computed constructor destructuring",
      'const key = "constructor"; const { [key]: build } = (() => {}); void build;',
      "computed destructuring",
    ],
    ["global Worker", "new Worker('./worker.mts');", 'runtime global "Worker"'],
    ["shared worker", "new SharedWorker('./worker.mts');", 'runtime global "SharedWorker"'],
    [
      "WebAssembly constructor",
      "new WebAssembly.Module(bytes);",
      'runtime global "WebAssembly"',
    ],
    ["Bun process", "Bun.spawn(['git']);", 'runtime global "Bun"'],
    ["Deno process", "new Deno.Command('git');", 'runtime global "Deno"'],
    ["process kill", "process.kill(1);", "process access"],
    ["native addon", "process.dlopen(module, './addon.node');", "process access"],
  ])("rejects %s", async (_name, source, detail) => {
    await put("scripts/factory/trusted/entry.mts", `${source}\n`);

    expectViolation(
      verifyNodeExecutableClosure(request()),
      "unsafe-runtime-capability",
      detail,
    );
  });

  it.each([
    [
      "ambient process",
      [
        "declare const process: any;",
        'process.getBuiltinModule("node:child_process");',
      ].join("\n"),
    ],
    [
      "ambient eval",
      "declare function eval(source: string): unknown;\neval('1 + 1');",
    ],
    [
      "ambient Function",
      "declare const Function: any;\nFunction('return 1');",
    ],
  ])("rejects the erased %s declaration", async (_name, source) => {
    await put("scripts/factory/trusted/entry.mts", `${source}\n`);

    expectViolation(
      verifyNodeExecutableClosure(request()),
      "unsafe-runtime-capability",
      "TypeScript syntax unsupported",
    );
  });

  it.each([
    [
      "eval overload",
      "function eval(source: string): unknown;\neval('1 + 1');",
    ],
    [
      "process overload",
      [
        "function process(name: string): unknown;",
        'process.getBuiltinModule("node:child_process");',
      ].join("\n"),
    ],
  ])("rejects the erased %s signature", async (_name, source) => {
    await put("scripts/factory/trusted/entry.mts", `${source}\n`);

    expectViolation(
      verifyNodeExecutableClosure(request()),
      "unsafe-runtime-capability",
      "TypeScript syntax unsupported",
    );
  });

  it("keeps class static-block var bindings inside the static block", async () => {
    await put(
      "scripts/factory/trusted/entry.mts",
      [
        "class Value {",
        "  static { var process = {}; void process; }",
        "}",
        'process.getBuiltinModule("node:child_process");',
        "void Value;",
        "",
      ].join("\n"),
    );

    expectViolation(
      verifyNodeExecutableClosure(request()),
      "unsafe-runtime-capability",
      "process access",
    );
  });

  it("keeps body var bindings out of default-parameter resolution", async () => {
    await put(
      "scripts/factory/trusted/entry.mts",
      [
        "function run(",
        '  value = process.getBuiltinModule("node:child_process"),',
        ") {",
        "  var process = null;",
        "  return value;",
        "}",
        "void run;",
        "",
      ].join("\n"),
    );

    expectViolation(
      verifyNodeExecutableClosure(request()),
      "unsafe-runtime-capability",
      "process access",
    );
  });

  it.each([
    ["node module", "node:module"],
    ["node vm", "node:vm"],
    ["worker threads", "node:worker_threads"],
    ["cluster", "node:cluster"],
    ["execa", "execa"],
    ["cross-spawn", "cross-spawn"],
    ["cross-spawn subpath", "cross-spawn/lib/parse"],
    ["shelljs", "shelljs"],
  ])("rejects the %s execution module even with reviewed resolution", async (_name, specifier) => {
    await put(
      "scripts/factory/trusted/entry.mts",
      `import value from ${JSON.stringify(specifier)};\nvoid value;\n`,
    );

    expectViolation(
      verifyNodeExecutableClosure(request()),
      "unsafe-runtime-capability",
      `runtime module "${specifier}"`,
    );
  });

  it.each([
    ["inspector evaluation", "node:inspector"],
    ["inspector promises evaluation", "node:inspector/promises"],
    ["SQLite native extensions", "node:sqlite"],
  ])("rejects reviewed %s capability", async (_name, specifier) => {
    await put(
      "scripts/factory/trusted/entry.mts",
      `import * as capability from ${JSON.stringify(specifier)};\nvoid capability;\n`,
    );

    expectViolation(
      verifyNodeExecutableClosure(
        request({
          externalModules: [
            {
              kind: "node-builtin",
              specifier,
              resolvedTarget: specifier,
            },
          ],
        }),
      ),
      "unsafe-runtime-capability",
      `runtime module "${specifier}"`,
    );
  });

  it("treats an ordinary locked package as a terminal external delegation", async () => {
    await put(
      "node_modules/example/package.json",
      '{"name":"example","type":"module","exports":"./index.mjs"}\n',
    );
    await put(
      "node_modules/example/index.mjs",
      "export const internal = eval('1 + 1');\n",
    );
    const source = 'import { internal } from "example";\nvoid internal;\n';
    await put("scripts/factory/trusted/entry.mts", source);

    expect(
      verifyNodeExecutableClosure(
        request({
          externalModules: [
            {
              kind: "locked-package",
              specifier: "example",
              resolvedTarget: "node_modules/example/index.mjs",
            },
          ],
        }),
      ),
    ).toEqual({
      files: ["scripts/factory/trusted/entry.mts"],
      edgeCount: 1,
      sourceBytes: Buffer.byteLength(source),
      violations: [],
    });
  });

  it("rejects a process-wrapper package despite an otherwise exact resolution", async () => {
    await put(
      "node_modules/cross-spawn/package.json",
      '{"name":"cross-spawn","type":"module","exports":"./index.mjs"}\n',
    );
    await put(
      "node_modules/cross-spawn/index.mjs",
      "export default function spawn() {}\n",
    );
    await put(
      "scripts/factory/trusted/entry.mts",
      'import spawn from "cross-spawn";\nvoid spawn;\n',
    );

    expectViolation(
      verifyNodeExecutableClosure(
        request({
          externalModules: [
            {
              kind: "locked-package",
              specifier: "cross-spawn",
              resolvedTarget: "node_modules/cross-spawn/index.mjs",
            },
          ],
        }),
      ),
      "unsafe-runtime-capability",
      'runtime module "cross-spawn"',
    );
  });

  it("allows erased type-only imports from runtime-forbidden modules", async () => {
    const source = 'import type { Worker } from "node:worker_threads";\nexport type T = Worker;\n';
    await put("scripts/factory/trusted/entry.mts", source);

    expect(verifyNodeExecutableClosure(request())).toEqual({
      files: ["scripts/factory/trusted/entry.mts"],
      edgeCount: 0,
      sourceBytes: Buffer.byteLength(source),
      violations: [],
    });
  });

  it("rejects a repository-triggered native addon edge", async () => {
    await put("scripts/factory/trusted/entry.mts", 'import "./addon.node";\n');

    expectViolation(
      verifyNodeExecutableClosure(request()),
      "unsupported-import",
      "not an explicit .mts source",
    );
  });

  it.each([
    ["enum", "enum Mode { A }\nvoid Mode.A;"],
    ["namespace", "namespace Runtime { export const value = 1 }\nvoid Runtime.value;"],
    ["import equals", "import fs = require('node:fs');\nvoid fs;"],
    [
      "parameter property",
      "class Value { constructor(public readonly value: string) {} }\nvoid Value;",
    ],
    ["decorator", "@sealed\nclass Value {}\nvoid Value;"],
    ["angle-bracket assertion", "const value = <string>'x';\nvoid value;"],
  ])("rejects Node strip-types-unsupported %s syntax", async (_name, source) => {
    await put("scripts/factory/trusted/entry.mts", `${source}\n`);

    expectViolation(
      verifyNodeExecutableClosure(request()),
      "unsafe-runtime-capability",
      "TypeScript",
    );
  });

  it("fails closed when runtime AST depth exceeds the supported grammar", async () => {
    const nesting = MAX_NODE_AST_DEPTH + 32;
    await put(
      "scripts/factory/trusted/entry.mts",
      `${"{".repeat(nesting)}process.argv;${"}".repeat(nesting)}\n`,
    );

    expectViolation(
      verifyNodeExecutableClosure(request()),
      "resource-limit",
      "AST",
    );
  });

  it("fails closed before transpilation when runtime AST node count is excessive", async () => {
    const source = "void 0;\n".repeat(Math.ceil(MAX_NODE_AST_NODES / 3));
    await put("scripts/factory/trusted/entry.mts", source);

    expectViolation(
      verifyNodeExecutableClosure(request()),
      "resource-limit",
      `${MAX_NODE_AST_NODES} nodes`,
    );
  }, 15_000);
});

describe("verifyNodeExecutableClosure D126 adapter boundary", () => {
  function adapterRequest(): NodeImportClosureRequest {
    return request({
      trustedRoot: "scripts/factory",
      entrypoints: [NODE_PROCESS_CAPABILITY_ADAPTER_PATH],
      externalModules: ["node:fs", "node:path"].map((specifier) => ({
        kind: "node-builtin" as const,
        specifier,
        resolvedTarget: specifier,
      })),
    });
  }

  function exactAdapterSource(
    mutate: (source: string) => string = (source) => source,
  ): string {
    return mutate(PRODUCTION_ADAPTER_SOURCE);
  }

  it("recognizes the one exact listTrackedPaths capability only in combined mode", async () => {
    const source = exactAdapterSource();
    await put(NODE_PROCESS_CAPABILITY_ADAPTER_PATH, source);

    expect(verifyNodeExecutableClosure(adapterRequest())).toEqual({
      files: [NODE_PROCESS_CAPABILITY_ADAPTER_PATH],
      edgeCount: 3,
      sourceBytes: Buffer.byteLength(source),
      violations: [],
    });
    expectViolation(
      verifyNodeImportClosure(adapterRequest()),
      "unapproved-external-module",
      "no exact reviewed resolution",
    );
  });

  it("accepts the migrated production scanner only through the protected adapter", () => {
    const productionRequest: NodeImportClosureRequest = {
      repositoryRoot: ACTUAL_REPOSITORY_ROOT,
      trustedRoot: "scripts/factory",
      trustedSourceClass: "protected-glue",
      rootsComplete: true,
      entrypoints: [
        "scripts/factory/check-invisible-format-characters.mts",
      ],
      externalModules: ["node:fs", "node:path", "node:url"].map(
        (specifier) => ({
          kind: "node-builtin" as const,
          specifier,
          resolvedTarget: specifier,
        }),
      ),
    };

    const combined = verifyNodeExecutableClosure(productionRequest);

    expect(combined.violations).toEqual([]);
    expect(combined.files).toContain(
      "scripts/factory/check-invisible-format-characters.mts",
    );
    expect(combined.files).toContain(NODE_PROCESS_CAPABILITY_ADAPTER_PATH);
    expectViolation(
      verifyNodeImportClosure(productionRequest),
      "unapproved-external-module",
      "no exact reviewed resolution",
    );
  });

  it("rejects a raw process call outside the exact capability", async () => {
    await put(
      NODE_PROCESS_CAPABILITY_ADAPTER_PATH,
      [
        'import { spawnSync } from "node:child_process";',
        "spawnSync(process.argv[2], process.argv.slice(3), {",
        "  shell: true,",
        "  cwd: process.cwd(),",
        "  env: process.env,",
        "});",
        "",
      ].join("\n"),
    );

    expectViolation(
      verifyNodeExecutableClosure(adapterRequest()),
      "unsafe-runtime-capability",
      "exact D126 source registry",
    );
  });

  it("rejects an exact child-process import without the capability call", async () => {
    await put(
      NODE_PROCESS_CAPABILITY_ADAPTER_PATH,
      'import { spawnSync } from "node:child_process";\n',
    );

    expectViolation(
      verifyNodeExecutableClosure(adapterRequest()),
      "unsafe-runtime-capability",
      "exact D126 source registry",
    );
  });

  it("rejects a same-named spawn binding from a repository module", async () => {
    await put(
      NODE_PROCESS_CAPABILITY_ADAPTER_PATH,
      exactAdapterSource((source) =>
        source.replace(
          'from "node:child_process"',
          'from "./fake.mts"',
        ),
      ),
    );
    await put(
      "scripts/factory/fake.mts",
      "export function spawnSync(): never { throw new Error('no'); }\n",
    );

    expectViolation(
      verifyNodeExecutableClosure(adapterRequest()),
      "unsafe-runtime-capability",
      "exact D126 source registry",
    );
  });

  it.each([
    [
      "near path",
      "scripts/factory/node-process-capabilities.mts",
      exactAdapterSource(),
      "runtime module",
    ],
    [
      "case variant",
      "scripts/factory/Node-process-capability.mts",
      exactAdapterSource(),
      "runtime module",
    ],
    [
      "default import",
      NODE_PROCESS_CAPABILITY_ADAPTER_PATH,
      'import childProcess from "node:child_process";\nvoid childProcess;\n',
      "exact D126 source registry",
    ],
    [
      "namespace import",
      NODE_PROCESS_CAPABILITY_ADAPTER_PATH,
      'import * as childProcess from "node:child_process";\nchildProcess.spawnSync("/x");\n',
      "exact D126 source registry",
    ],
    [
      "aliased import",
      NODE_PROCESS_CAPABILITY_ADAPTER_PATH,
      'import { spawnSync as run } from "node:child_process";\nrun("/x");\n',
      "exact D126 source registry",
    ],
    [
      "wrong named import",
      NODE_PROCESS_CAPABILITY_ADAPTER_PATH,
      'import { spawn } from "node:child_process";\nspawn("/x");\n',
      "exact D126 source registry",
    ],
    [
      "mixed named import",
      NODE_PROCESS_CAPABILITY_ADAPTER_PATH,
      'import { spawn, spawnSync } from "node:child_process";\nspawnSync("/x");\nvoid spawn;\n',
      "exact D126 source registry",
    ],
    [
      "escaped module spelling",
      NODE_PROCESS_CAPABILITY_ADAPTER_PATH,
      'import { spawnSync } from "node:child\\u005fprocess";\nspawnSync("/x");\n',
      "exact D126 source registry",
    ],
    [
      "escaped binding spelling",
      NODE_PROCESS_CAPABILITY_ADAPTER_PATH,
      'import { spawn\\u0053ync } from "node:child_process";\nspawnSync("/x");\n',
      "exact D126 source registry",
    ],
    [
      "re-export",
      NODE_PROCESS_CAPABILITY_ADAPTER_PATH,
      'export { spawnSync } from "node:child_process";\n',
      "exact D126 source registry",
    ],
    [
      "binding escape",
      NODE_PROCESS_CAPABILITY_ADAPTER_PATH,
      'import { spawnSync } from "node:child_process";\nconst run = spawnSync;\nvoid run;\n',
      "exact D126 source registry",
    ],
    [
      "binding re-export",
      NODE_PROCESS_CAPABILITY_ADAPTER_PATH,
      'import { spawnSync } from "node:child_process";\nexport { spawnSync };\n',
      "exact D126 source registry",
    ],
    [
      "call indirection",
      NODE_PROCESS_CAPABILITY_ADAPTER_PATH,
      'import { spawnSync } from "node:child_process";\nspawnSync.call(null, "/x");\n',
      "exact D126 source registry",
    ],
    [
      "bind indirection",
      NODE_PROCESS_CAPABILITY_ADAPTER_PATH,
      'import { spawnSync } from "node:child_process";\nvoid spawnSync.bind(null);\n',
      "exact D126 source registry",
    ],
    [
      "duplicate import",
      NODE_PROCESS_CAPABILITY_ADAPTER_PATH,
      [
        'import { spawnSync } from "node:child_process";',
        'import { spawnSync as spawnSync2 } from "node:child_process";',
        'spawnSync("/x");',
        'spawnSync2("/x");',
        "",
      ].join("\n"),
      "exact D126 source registry",
    ],
  ])("rejects adapter %s", async (_name, path, source, detail) => {
    await put(path, source);
    const result = verifyNodeExecutableClosure(
      request({
        trustedRoot: "scripts/factory",
        entrypoints: [path],
      }),
    );

    expectViolation(result, "unsafe-runtime-capability", detail);
  });

  it.each([
    ["executable", (source: string) => source.replace("/usr/bin/git", "/bin/git")],
    ["subcommand", (source: string) => source.replace("ls-files", "status")],
    ["argument count", (source: string) => source.replace(', "-z"', "")],
    [
      "cwd",
      (source: string) =>
        source.replace("rootIdentity.canonicalPath", "repositoryRoot"),
    ],
    [
      "environment entry removed",
      (source: string) =>
        source.replace('      GIT_CONFIG_COUNT: "1",\n', ""),
    ],
    [
      "environment entry renamed",
      (source: string) =>
        source.replace("GIT_CONFIG_KEY_0", "GIT_CONFIG_KEY_1"),
    ],
    [
      "computed environment entry",
      (source: string) =>
        source.replace("GIT_CONFIG_VALUE_0:", '["GIT_CONFIG_VALUE_0"]:'),
    ],
    [
      "caller-derived environment",
      (source: string) =>
        source.replace(
          'GIT_CONFIG_GLOBAL: "/dev/null"',
          "GIT_CONFIG_GLOBAL: repositoryRoot",
        ),
    ],
    [
      "fsmonitor override",
      (source: string) =>
        source.replace("core.fsmonitor", "core.hooksPath"),
    ],
    [
      "shell",
      (source: string) => source.replace("shell: false", "shell: true"),
    ],
    [
      "timeout",
      (source: string) => source.replace("timeout: 30_000", "timeout: 0"),
    ],
    [
      "kill signal",
      (source: string) =>
        source.replace('killSignal: "SIGKILL"', 'killSignal: "SIGTERM"'),
    ],
    [
      "output bound",
      (source: string) =>
        source.replace("maxBuffer: 16_777_216", "maxBuffer: 16_777_217"),
    ],
    [
      "stdio",
      (source: string) =>
        source.replace(
          'stdio: ["ignore", "pipe", "pipe"]',
          'stdio: ["inherit", "pipe", "pipe"]',
        ),
    ],
    [
      "window behavior",
      (source: string) =>
        source.replace("windowsHide: true", "windowsHide: false"),
    ],
    [
      "capability name",
      (source: string) =>
        source.replace("function listTrackedPaths", "function runProcess"),
    ],
    [
      "parameter name",
      (source: string) =>
        source.replace("repositoryRoot: string", "root: string"),
    ],
    [
      "root inspection dataflow",
      (source: string) =>
        source.replace(
          "inspectRepositoryRoot(repositoryRoot)",
          'inspectRepositoryRoot("/tmp/attacker")',
        ),
    ],
    [
      "canonical-root return dataflow",
      (source: string) =>
        source.replace(
          "repositoryRoot: rootIdentity.canonicalPath",
          'repositoryRoot: "/tmp/attacker"',
        ),
    ],
    [
      "stdout return dataflow",
      (source: string) =>
        source.replace(
          "rawTrackedPaths: Buffer.from(result.stdout)",
          'rawTrackedPaths: Buffer.from("attacker")',
        ),
    ],
    [
      "line-terminator-sensitive return",
      (source: string) =>
        source.replace(
          "return identity(canonicalPath, stats);",
          "return\n    identity(canonicalPath, stats);",
        ),
    ],
  ])("rejects a mutated exact adapter %s rule", async (_name, mutate) => {
    await put(
      NODE_PROCESS_CAPABILITY_ADAPTER_PATH,
      exactAdapterSource(mutate),
    );

    expectViolation(
      verifyNodeExecutableClosure(adapterRequest()),
      "unsafe-runtime-capability",
      "exact D126 source registry",
    );
  });

  it("rejects trivia changes until the exact source registry is reviewed", async () => {
    const source = `// formatting-only review note\n\n${exactAdapterSource()}`;
    await put(NODE_PROCESS_CAPABILITY_ADAPTER_PATH, source);

    expectViolation(
      verifyNodeExecutableClosure(adapterRequest()),
      "unsafe-runtime-capability",
      "exact D126 source registry",
    );
  });

  it("rejects a duplicate exact capability call", async () => {
    const source = exactAdapterSource((current) => {
      const start = current.indexOf(
        '  const result = spawnSync("/usr/bin/git"',
      );
      const end = current.indexOf("\n\n    if (", start);
      const call = current.slice(start, end).replace(
        "const result =",
        "const duplicate =",
      );
      return `${current.slice(0, end)}\n${call}${current.slice(end)}`;
    });
    await put(NODE_PROCESS_CAPABILITY_ADAPTER_PATH, source);

    expectViolation(
      verifyNodeExecutableClosure(adapterRequest()),
      "unsafe-runtime-capability",
      "exact D126 source registry",
    );
  });

  it("rejects more than one exact process import", async () => {
    await put(
      NODE_PROCESS_CAPABILITY_ADAPTER_PATH,
      exactAdapterSource((source) =>
        source.replace(
          'import { spawnSync } from "node:child_process";',
          [
            'import { spawnSync } from "node:child_process";',
            'import { spawnSync } from "node:child_process";',
          ].join("\n"),
        ),
      ),
    );

    expectViolation(
      verifyNodeExecutableClosure(adapterRequest()),
      "unsafe-runtime-capability",
      "exact D126 source registry",
    );
  });
});
