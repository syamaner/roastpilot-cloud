import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_NODE_CLOSURE_BYTES,
  MAX_NODE_CLOSURE_EDGES,
  MAX_NODE_CLOSURE_FILES,
  MAX_NODE_SOURCE_BYTES,
  verifyNodeImportClosure,
  type NodeImportClosureRequest,
  type NodeImportClosureResult,
} from "../../scripts/factory/node-import-closure-verifier.mts";

let repositoryRoot: string;
const VERIFIER_URL = new URL(
  "../../scripts/factory/node-import-closure-verifier.mts",
  import.meta.url,
).href;

async function put(path: string, content: string | Uint8Array): Promise<void> {
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

function paddedSource(prefix: string, size: number): string {
  const remaining = size - Buffer.byteLength(prefix) - 3;
  if (remaining < 0) throw new Error("prefix exceeds requested source size");
  return `${prefix}//${"x".repeat(remaining)}\n`;
}

beforeEach(async () => {
  repositoryRoot = await mkdtemp(join(tmpdir(), "node-import-closure-"));
  await put("scripts/factory/trusted/entry.mts", "export const ready = true;\n");
});

afterEach(async () => {
  await rm(repositoryRoot, { recursive: true, force: true });
});

describe("verifyNodeImportClosure traversal and runtime edges", () => {
  it("returns sorted canonical evidence for transitive roots and cycles", async () => {
    await put(
      "scripts/factory/trusted/entry.mts",
      'import "./middle.mts";\nexport { value } from "./leaf.mts";\n',
    );
    await put("scripts/factory/trusted/middle.mts", 'import "./entry.mts";\n');
    await put("scripts/factory/trusted/leaf.mts", "export const value = 1;\n");

    const result = verifyNodeImportClosure(request());

    expect(result).toEqual({
      files: [
        "scripts/factory/trusted/entry.mts",
        "scripts/factory/trusted/leaf.mts",
        "scripts/factory/trusted/middle.mts",
      ],
      edgeCount: 3,
      sourceBytes:
        Buffer.byteLength(
          'import "./middle.mts";\nexport { value } from "./leaf.mts";\n',
        ) +
        Buffer.byteLength('import "./entry.mts";\n') +
        Buffer.byteLength("export const value = 1;\n"),
      violations: [],
    });
  });

  it("deduplicates shared dependencies across complete entrypoint roots", async () => {
    await put("scripts/factory/trusted/entry.mts", 'import "./shared.mts";\n');
    await put("scripts/factory/trusted/other.mts", 'import "./shared.mts";\n');
    await put("scripts/factory/trusted/shared.mts", "export const shared = true;\n");

    expect(
      verifyNodeImportClosure(
        request({
          entrypoints: ["scripts/factory/trusted/other.mts", "scripts/factory/trusted/entry.mts"],
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        files: [
          "scripts/factory/trusted/entry.mts",
          "scripts/factory/trusted/other.mts",
          "scripts/factory/trusted/shared.mts",
        ],
        edgeCount: 2,
        violations: [],
      }),
    );
  });

  it("deduplicates URL spellings that resolve to one canonical source", async () => {
    await put(
      "scripts/factory/trusted/entry.mts",
      'import "./shared.mts";\nimport "./%73hared.mts";\n',
    );
    await put("scripts/factory/trusted/shared.mts", "export const shared = true;\n");

    expect(verifyNodeImportClosure(request())).toEqual(
      expect.objectContaining({
        files: ["scripts/factory/trusted/entry.mts", "scripts/factory/trusted/shared.mts"],
        edgeCount: 2,
        violations: [],
      }),
    );
  });

  it("treats empty and inline-type clauses as runtime Node edges", async () => {
    await put(
      "scripts/factory/trusted/entry.mts",
      [
        'import type { X } from "./erased-import.mts";',
        'export type { X } from "./erased-export.mts";',
        'import {} from "./empty-import.mts";',
        'export {} from "./empty-export.mts";',
        'import { type X } from "./inline-import.mts";',
        'export { type X } from "./inline-export.mts";',
        "",
      ].join("\n"),
    );
    for (const name of [
      "erased-import",
      "erased-export",
      "empty-import",
      "empty-export",
      "inline-import",
      "inline-export",
    ]) {
      await put(`scripts/factory/trusted/${name}.mts`, "export type X = string;\n");
    }

    const result = verifyNodeImportClosure(request());

    expect(result.violations).toEqual([]);
    expect(result.edgeCount).toBe(4);
    expect(result.files).toEqual([
      "scripts/factory/trusted/empty-export.mts",
      "scripts/factory/trusted/empty-import.mts",
      "scripts/factory/trusted/entry.mts",
      "scripts/factory/trusted/inline-export.mts",
      "scripts/factory/trusted/inline-import.mts",
    ]);
  });

  it("ignores declarations without a runtime module edge", async () => {
    await put(
      "scripts/factory/trusted/entry.mts",
      [
        "import type { Local } from './types.mts';",
        "export type { Local } from './types.mts';",
        "export { Local };",
        "type Local = string;",
        "",
      ].join("\n"),
    );
    await put("scripts/factory/trusted/types.mts", "export type Local = string;\n");

    expect(verifyNodeImportClosure(request())).toEqual(
      expect.objectContaining({
        files: ["scripts/factory/trusted/entry.mts"],
        edgeCount: 0,
        violations: [],
      }),
    );
  });
});

describe("verifyNodeImportClosure local path confinement", () => {
  it.each([
    ["missing source", 'import "./missing.mts";\n', "does not exist"],
    [
      "extensionless source",
      'import "./dependency";\n',
      "not an explicit .mts source",
    ],
    [
      "directory source",
      'import "./directory.mts";\n',
      "must be a regular file",
    ],
    [
      "trusted-root escape",
      'import "../outside.mts";\n',
      "inside the trusted root",
    ],
    [
      "percent-encoded trusted-root escape",
      'import "./%2e%2e/outside.mts";\n',
      "inside the trusted root",
    ],
    [
      "percent-encoded path separator",
      'import "./nested%2fdependency.mts";\n',
      "not an explicit .mts source",
    ],
    [
      "module query",
      'import "./dependency.mts?mode=unsafe";\n',
      "not an explicit .mts source",
    ],
    [
      "module fragment",
      'import "./dependency.mts#unsafe";\n',
      "not an explicit .mts source",
    ],
    [
      "backslash path",
      'import "./nested\\\\dependency.mts";\n',
      "not an explicit .mts source",
    ],
  ])("fails closed for %s", async (_name, source, detail) => {
    await put("scripts/factory/trusted/entry.mts", source);
    if (detail === "must be a regular file") {
      await mkdir(
        join(repositoryRoot, "scripts", "factory", "trusted", "directory.mts"),
      );
    }
    await put("outside.mts", "export const outside = true;\n");
    await put("scripts/factory/trusted/dependency.mts", "export const value = true;\n");

    expectViolation(
      verifyNodeImportClosure(request()),
      detail === "does not exist" || detail === "must be a regular file"
        ? "unsafe-path"
        : "unsupported-import",
      detail,
    );
  });

  it("rejects a symlinked repository root", async () => {
    const parent = await mkdtemp(join(tmpdir(), "node-import-root-link-"));
    const linkedRoot = join(parent, "repo");
    await symlink(repositoryRoot, linkedRoot, "dir");

    expectViolation(
      verifyNodeImportClosure(request({ repositoryRoot: linkedRoot })),
      "unsafe-path",
      "repository root must be a real directory",
    );
    await rm(parent, { recursive: true, force: true });
  });

  it.each([
    ["trusted-root symlink", "scripts/factory/trusted", "dir"],
    ["source symlink", "scripts/factory/trusted/entry.mts", "file"],
  ] as const)("rejects a %s", async (_name, path, kind) => {
    const actual =
      kind === "dir"
        ? join(repositoryRoot, "actual-trusted")
        : join(repositoryRoot, "actual-entry.mts");
    await rm(join(repositoryRoot, path), { recursive: true, force: true });
    if (kind === "dir") {
      await mkdir(actual);
    } else {
      await writeFile(actual, "export const linked = true;\n");
    }
    await symlink(actual, join(repositoryRoot, path), kind);

    expectViolation(
      verifyNodeImportClosure(request()),
      "unsafe-path",
      "symlink component",
    );
  });

  it("rejects a missing trusted root", async () => {
    expectViolation(
      verifyNodeImportClosure(
        request({
          trustedRoot: "scripts/factory/missing",
          entrypoints: ["scripts/factory/missing/entry.mts"],
        }),
      ),
      "unsafe-path",
      "does not exist",
    );
  });
});

describe("verifyNodeImportClosure syntax and source bytes", () => {
  it("reports syntax errors with their source line", async () => {
    await put(
      "scripts/factory/trusted/entry.mts",
      "export const first = true;\nexport const broken = ;\n",
    );

    const result = verifyNodeImportClosure(request());

    expectViolation(result, "parse-error", "Expression expected");
    expect(result.violations[0]).toEqual(
      expect.objectContaining({ path: "scripts/factory/trusted/entry.mts", line: 2 }),
    );
  });

  it("rejects invalid UTF-8 without returning partial evidence", async () => {
    await put("scripts/factory/trusted/entry.mts", new Uint8Array([0xff, 0xfe, 0xfd]));

    expectViolation(
      verifyNodeImportClosure(request()),
      "parse-error",
      "not valid UTF-8",
    );
  });

  it("rejects import attributes as unsupported static resolution", async () => {
    await put(
      "scripts/factory/trusted/entry.mts",
      'import data from "example" with { type: "json" };\nvoid data;\n',
    );

    expectViolation(
      verifyNodeImportClosure(request()),
      "unsupported-import",
      "plain literal without attributes or phase modifiers",
    );
  });

  it("rejects an import defer phase unsupported by the pinned Node runtime", async () => {
    await put(
      "scripts/factory/trusted/entry.mts",
      'import defer * as deferred from "./dependency.mts";\nvoid deferred;\n',
    );
    await put("scripts/factory/trusted/dependency.mts", "export const value = true;\n");

    expectViolation(
      verifyNodeImportClosure(request()),
      "unsupported-import",
      "plain literal without attributes or phase modifiers",
    );
  });

  it("sorts multiple findings deterministically and erases valid evidence", async () => {
    await put(
      "scripts/factory/trusted/entry.mts",
      'import "z-package";\nimport "./missing.mts";\nimport "a-package";\n',
    );

    const result = verifyNodeImportClosure(request());

    expect(result.files).toEqual([]);
    expect(result.edgeCount).toBe(0);
    expect(result.sourceBytes).toBe(0);
    expect(result.violations.map(({ detail }) => detail)).toEqual([
      'external module "z-package" has no exact reviewed resolution',
      'external module "a-package" has no exact reviewed resolution',
      '"scripts/factory/trusted/missing.mts" does not exist',
    ]);
  });
});

describe("verifyNodeImportClosure external provenance", () => {
  it("attests the verifier's own closed static import boundary", () => {
    const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

    expect(
      verifyNodeImportClosure({
        repositoryRoot: projectRoot,
        trustedRoot: "scripts/factory",
        trustedSourceClass: "protected-glue",
        rootsComplete: true,
        entrypoints: [
          "scripts/factory/node-import-closure-verifier.mts",
        ],
        externalModules: [
          {
            kind: "node-builtin",
            specifier: "node:fs",
            resolvedTarget: "node:fs",
          },
          {
            kind: "node-builtin",
            specifier: "node:path",
            resolvedTarget: "node:path",
          },
          {
            kind: "node-builtin",
            specifier: "node:url",
            resolvedTarget: "node:url",
          },
          {
            kind: "locked-package",
            specifier: "import-meta-resolve",
            resolvedTarget: "node_modules/import-meta-resolve/index.js",
          },
          {
            kind: "locked-package",
            specifier: "typescript",
            resolvedTarget: "node_modules/typescript/lib/typescript.js",
          },
        ],
      }),
    ).toEqual(
      expect.objectContaining({
        files: [
          "scripts/factory/implement-patch-logic.mts",
          "scripts/factory/node-import-closure-verifier.mts",
        ],
        edgeCount: 6,
        violations: [],
      }),
    );
  });

  it("accepts an exact reviewed Node builtin", async () => {
    await put(
      "scripts/factory/trusted/entry.mts",
      'import { readFileSync } from "node:fs";\nvoid readFileSync;\n',
    );

    expect(
      verifyNodeImportClosure(
        request({
          externalModules: [
            {
              kind: "node-builtin",
              specifier: "node:fs",
              resolvedTarget: "node:fs",
            },
          ],
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        files: ["scripts/factory/trusted/entry.mts"],
        edgeCount: 1,
        violations: [],
      }),
    );
  });

  it("accepts an exact locked package target", async () => {
    await put(
      "node_modules/example/package.json",
      '{"name":"example","type":"module","exports":"./index.mjs"}\n',
    );
    await put("node_modules/example/index.mjs", "export const value = 1;\n");
    await put(
      "scripts/factory/trusted/entry.mts",
      'import { value } from "example";\nvoid value;\n',
    );

    expect(
      verifyNodeImportClosure(
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
    ).toEqual(
      expect.objectContaining({
        files: ["scripts/factory/trusted/entry.mts"],
        edgeCount: 1,
        violations: [],
      }),
    );
  });

  it("resolves a package from the requested importer in a direct Node subprocess", async () => {
    await put(
      "node_modules/example/package.json",
      '{"name":"example","type":"module","exports":"./index.mjs"}\n',
    );
    await put("node_modules/example/index.mjs", "export const value = 1;\n");
    await put("scripts/factory/trusted/entry.mts", 'import "example";\n');
    const runnerPath = join(repositoryRoot, "runner.mts");
    await writeFile(
      runnerPath,
      `import { verifyNodeImportClosure } from ${JSON.stringify(VERIFIER_URL)};\n` +
        `const result = verifyNodeImportClosure(${JSON.stringify(
          request({
            externalModules: [
              {
                kind: "locked-package",
                specifier: "example",
                resolvedTarget: "node_modules/example/index.mjs",
              },
            ],
          }),
        )});\n` +
        "console.log(JSON.stringify(result));\n",
    );

    const result = JSON.parse(
      execFileSync(
        process.execPath,
        ["--experimental-strip-types", runnerPath],
        { encoding: "utf8" },
      ),
    ) as NodeImportClosureResult;

    expect(result).toEqual(
      expect.objectContaining({
        files: ["scripts/factory/trusted/entry.mts"],
        edgeCount: 1,
        violations: [],
      }),
    );
  });

  it.each([
    [
      "unapproved package",
      [],
      "has no exact reviewed resolution",
    ],
    [
      "mismatched builtin target",
      [
        {
          kind: "node-builtin",
          specifier: "node:fs",
          resolvedTarget: "node:path",
        },
      ],
      "external module rules",
    ],
    [
      "unresolvable package",
      [
        {
          kind: "locked-package",
          specifier: "missing-package",
          resolvedTarget: "node_modules/missing-package/index.mjs",
        },
      ],
      "cannot be resolved",
    ],
  ] as const)("rejects an %s", async (_name, externalModules, detail) => {
    const specifier =
      detail === "external module rules"
        ? "node:fs"
        : detail === "cannot be resolved"
          ? "missing-package"
          : "example";
    await put("scripts/factory/trusted/entry.mts", `import "${specifier}";\n`);

    expectViolation(
      verifyNodeImportClosure(
        request({
          externalModules:
            externalModules as NodeImportClosureRequest["externalModules"],
        }),
      ),
      detail === "external module rules"
        ? "invalid-input"
        : "unapproved-external-module",
      detail,
    );
  });

  it("rejects a package target that differs from the reviewed file", async () => {
    await put(
      "node_modules/example/package.json",
      '{"name":"example","type":"module","exports":"./index.mjs"}\n',
    );
    await put("node_modules/example/index.mjs", "export const value = 1;\n");
    await put("node_modules/example/other.mjs", "export const value = 2;\n");
    await put("scripts/factory/trusted/entry.mts", 'import "example";\n');

    expectViolation(
      verifyNodeImportClosure(
        request({
          externalModules: [
            {
              kind: "locked-package",
              specifier: "example",
              resolvedTarget: "node_modules/example/other.mjs",
            },
          ],
        }),
      ),
      "unapproved-external-module",
      "resolved to unexpected target",
    );
  });

  it("rejects a package target carrying a URL query", async () => {
    await put(
      "node_modules/example/package.json",
      '{"name":"example","type":"module","exports":"./index.mjs?mode=alternate"}\n',
    );
    await put("node_modules/example/index.mjs", "export const value = 1;\n");
    await put("scripts/factory/trusted/entry.mts", 'import "example";\n');

    expectViolation(
      verifyNodeImportClosure(
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
      "unapproved-external-module",
      "did not resolve to a local locked file",
    );
  });

  it("rejects a locked-package rule that resolves to a builtin URL", async () => {
    await put("scripts/factory/trusted/entry.mts", 'import "fs";\n');

    expectViolation(
      verifyNodeImportClosure(
        request({
          externalModules: [
            {
              kind: "locked-package",
              specifier: "fs",
              resolvedTarget: "node_modules/fs/index.mjs",
            },
          ],
        }),
      ),
      "unapproved-external-module",
      "did not resolve to a local locked file",
    );
  });

  it("rejects a package alias that resolves back into repository source", async () => {
    await put("scripts/factory/trusted/aliased.mjs", "export const value = 1;\n");
    await mkdir(join(repositoryRoot, "node_modules"), { recursive: true });
    await symlink(
      join(repositoryRoot, "scripts", "factory", "trusted"),
      join(repositoryRoot, "node_modules", "example"),
      "dir",
    );
    await put("scripts/factory/trusted/package.json", '{"exports":"./aliased.mjs"}\n');
    await put("scripts/factory/trusted/entry.mts", 'import "example";\n');

    expectViolation(
      verifyNodeImportClosure(
        request({
          externalModules: [
            {
              kind: "locked-package",
              specifier: "example",
              resolvedTarget: "node_modules/example/aliased.mjs",
            },
          ],
        }),
      ),
      "unapproved-external-module",
      "resolved to unexpected target",
    );
  });
});

describe("verifyNodeImportClosure approved resource ceilings", () => {
  it("accepts exactly the 128-file and 512-edge ceilings", async () => {
    const dependencyFiles = MAX_NODE_CLOSURE_FILES - 1;
    for (let index = 0; index < dependencyFiles; index += 1) {
      const next =
        index + 1 < dependencyFiles
          ? `import "./file-${index + 1}.mts";\n`
          : "";
      await put(`scripts/factory/trusted/file-${index}.mts`, next);
    }
    await put(
      "scripts/factory/trusted/entry.mts",
      [
        'import "./file-0.mts";',
        ...Array.from(
          { length: MAX_NODE_CLOSURE_EDGES - MAX_NODE_CLOSURE_FILES + 1 },
          () => 'import "./file-0.mts";',
        ),
        "",
      ].join("\n"),
    );

    const result = verifyNodeImportClosure(request());

    expect(result.violations).toEqual([]);
    expect(result.files).toHaveLength(MAX_NODE_CLOSURE_FILES);
    expect(result.edgeCount).toBe(MAX_NODE_CLOSURE_EDGES);
  });

  it("rejects the 129th canonical source file", async () => {
    for (let index = 0; index < MAX_NODE_CLOSURE_FILES; index += 1) {
      await put(
        `scripts/factory/trusted/file-${index}.mts`,
        index + 1 < MAX_NODE_CLOSURE_FILES
          ? `import "./file-${index + 1}.mts";\n`
          : "",
      );
    }
    await put("scripts/factory/trusted/entry.mts", 'import "./file-0.mts";\n');

    expectViolation(
      verifyNodeImportClosure(request()),
      "resource-limit",
      `exceeds ${MAX_NODE_CLOSURE_FILES} source files`,
    );
  });

  it("rejects the 513th runtime static edge", async () => {
    await put("scripts/factory/trusted/dependency.mts", "export const value = 1;\n");
    await put(
      "scripts/factory/trusted/entry.mts",
      `${'import "./dependency.mts";\n'.repeat(MAX_NODE_CLOSURE_EDGES + 1)}`,
    );

    expectViolation(
      verifyNodeImportClosure(request()),
      "resource-limit",
      `exceeds ${MAX_NODE_CLOSURE_EDGES} static edges`,
    );
  });

  it("accepts exactly 1,000,000 bytes in one source", async () => {
    await put(
      "scripts/factory/trusted/entry.mts",
      paddedSource("", MAX_NODE_SOURCE_BYTES),
    );

    expect(verifyNodeImportClosure(request())).toEqual(
      expect.objectContaining({
        files: ["scripts/factory/trusted/entry.mts"],
        sourceBytes: MAX_NODE_SOURCE_BYTES,
        violations: [],
      }),
    );
  });

  it("rejects 1,000,001 bytes in one source", async () => {
    await put(
      "scripts/factory/trusted/entry.mts",
      paddedSource("", MAX_NODE_SOURCE_BYTES + 1),
    );

    expectViolation(
      verifyNodeImportClosure(request()),
      "resource-limit",
      `exceeds ${MAX_NODE_SOURCE_BYTES} bytes`,
    );
  });

  it("charges oversized roots to the aggregate budget before reading", async () => {
    const entrypoints = Array.from(
      { length: 8 },
      (_, index) => `scripts/factory/trusted/oversized-${index}.mts`,
    );
    for (const path of entrypoints) {
      await put(path, paddedSource("", MAX_NODE_SOURCE_BYTES + 1));
    }

    const result = verifyNodeImportClosure(request({ entrypoints }));

    expectViolation(
      result,
      "resource-limit",
      `exceeds ${MAX_NODE_CLOSURE_BYTES} source bytes`,
    );
    expect(
      result.violations.filter(({ detail }) =>
        detail.includes(`exceeds ${MAX_NODE_SOURCE_BYTES} bytes`),
      ),
    ).toHaveLength(8);
  });

  it("accepts exactly 8,000,000 bytes across the closure", async () => {
    const fileCount = MAX_NODE_CLOSURE_BYTES / MAX_NODE_SOURCE_BYTES;
    for (let index = 0; index < fileCount; index += 1) {
      const prefix =
        index + 1 < fileCount
          ? `import "./large-${index + 1}.mts";\n`
          : "";
      await put(
        `scripts/factory/trusted/large-${index}.mts`,
        paddedSource(prefix, MAX_NODE_SOURCE_BYTES),
      );
    }

    const result = verifyNodeImportClosure(
      request({ entrypoints: ["scripts/factory/trusted/large-0.mts"] }),
    );

    expect(result.violations).toEqual([]);
    expect(result.sourceBytes).toBe(MAX_NODE_CLOSURE_BYTES);
  });

  it("rejects 8,000,001 bytes across the closure", async () => {
    const fileCount = MAX_NODE_CLOSURE_BYTES / MAX_NODE_SOURCE_BYTES;
    for (let index = 0; index < fileCount; index += 1) {
      const prefix =
        index + 1 < fileCount
          ? `import "./large-${index + 1}.mts";\n`
          : 'import "./overflow.mts";\n';
      await put(
        `scripts/factory/trusted/large-${index}.mts`,
        paddedSource(prefix, MAX_NODE_SOURCE_BYTES),
      );
    }
    await put("scripts/factory/trusted/overflow.mts", "\n");

    expectViolation(
      verifyNodeImportClosure(
        request({ entrypoints: ["scripts/factory/trusted/large-0.mts"] }),
      ),
      "resource-limit",
      `exceeds ${MAX_NODE_CLOSURE_BYTES} source bytes`,
    );
  });

  it("counts malformed canonical files toward the 128-file ceiling", async () => {
    await put(
      "scripts/factory/trusted/entry.mts",
      Array.from(
        { length: MAX_NODE_CLOSURE_FILES },
        (_, index) => `import "./invalid-${index}.mts";`,
      ).join("\n"),
    );
    for (let index = 0; index < MAX_NODE_CLOSURE_FILES; index += 1) {
      await put(`scripts/factory/trusted/invalid-${index}.mts`, "export const broken = ;\n");
    }

    expectViolation(
      verifyNodeImportClosure(request()),
      "resource-limit",
      `exceeds ${MAX_NODE_CLOSURE_FILES} source files`,
    );
  });

  it("counts invalid UTF-8 sources toward the 8 MB closure ceiling", async () => {
    const invalidBytes = new Uint8Array(900_000).fill(0xff);
    await put(
      "scripts/factory/trusted/entry.mts",
      Array.from(
        { length: 9 },
        (_, index) => `import "./invalid-bytes-${index}.mts";`,
      ).join("\n"),
    );
    for (let index = 0; index < 9; index += 1) {
      await put(`scripts/factory/trusted/invalid-bytes-${index}.mts`, invalidBytes);
    }

    expectViolation(
      verifyNodeImportClosure(request()),
      "resource-limit",
      `exceeds ${MAX_NODE_CLOSURE_BYTES} source bytes`,
    );
  });
});

describe("verifyNodeImportClosure request contract", () => {
  it.each([null, undefined, false, "request"])(
    "rejects a non-object top-level request: %j",
    (value) => {
      expectViolation(
        verifyNodeImportClosure(
          value as unknown as NodeImportClosureRequest,
        ),
        "invalid-input",
        "invalid runtime shape",
      );
    },
  );

  it.each(["entrypoints", "externalModules"] as const)(
    "rejects a sparse %s array",
    (field) => {
      const sparse: unknown[] = [];
      sparse.length = 1;

      expectViolation(
        verifyNodeImportClosure(
          request({
            [field]: sparse,
          } as Partial<NodeImportClosureRequest>),
        ),
        "invalid-input",
        field === "entrypoints"
          ? "source-qualified roots"
          : "external module rules",
      );
    },
  );

  it.each([
    ["non-object external rule", { externalModules: [null] }],
    ["incomplete roots", { rootsComplete: false }],
    ["truthy non-boolean roots", { rootsComplete: "true" }],
    ["empty entrypoints", { entrypoints: [] }],
    [
      "duplicate entrypoints",
      {
        entrypoints: ["scripts/factory/trusted/entry.mts", "scripts/factory/trusted/entry.mts"],
      },
    ],
    [
      "too many entrypoints",
      {
        entrypoints: Array.from(
          { length: MAX_NODE_CLOSURE_FILES + 1 },
          (_, index) => `scripts/factory/trusted/entry-${index}.mts`,
        ),
      },
    ],
    ["unsafe trusted root", { trustedRoot: "../trusted" }],
    ["entrypoint outside root", { entrypoints: ["other/entry.mts"] }],
    ["non-mts entrypoint", { entrypoints: ["scripts/factory/trusted/entry.ts"] }],
    [
      "unprotected glue root",
      {
        trustedRoot: "app",
        entrypoints: ["app/entry.mts"],
      },
    ],
    [
      "wrong Snowflake root",
      {
        trustedSourceClass: "trusted-main-snowflake",
        trustedRoot: "scripts/factory/trusted",
      },
    ],
    [
      "forbidden builtin",
      {
        externalModules: [
          {
            kind: "node-builtin",
            specifier: "node:module",
            resolvedTarget: "node:module",
          },
        ],
      },
    ],
    [
      "forbidden builtin subpath",
      {
        externalModules: [
          {
            kind: "node-builtin",
            specifier: "node:vm/context",
            resolvedTarget: "node:vm/context",
          },
        ],
      },
    ],
    [
      "unknown builtin",
      {
        externalModules: [
          {
            kind: "node-builtin",
            specifier: "node:not-a-real-builtin",
            resolvedTarget: "node:not-a-real-builtin",
          },
        ],
      },
    ],
    [
      "duplicate external rules",
      {
        externalModules: [
          {
            kind: "node-builtin",
            specifier: "node:fs",
            resolvedTarget: "node:fs",
          },
          {
            kind: "node-builtin",
            specifier: "node:fs",
            resolvedTarget: "node:fs",
          },
        ],
      },
    ],
    [
      "too many external rules",
      {
        externalModules: Array.from(
          { length: MAX_NODE_CLOSURE_EDGES + 1 },
          (_, index) => ({
            kind: "locked-package",
            specifier: `package-${index}`,
            resolvedTarget: `node_modules/package-${index}/index.mjs`,
          })),
      },
    ],
  ])("rejects %s", (_name, overrides) => {
    expectViolation(
      verifyNodeImportClosure(
        request(overrides as Partial<NodeImportClosureRequest>),
      ),
      "invalid-input",
      _name.includes("roots") && !_name.includes("trusted")
        ? "invalid runtime shape"
        : _name.includes("external rule") ||
            _name === "duplicate external rules" ||
            _name === "too many external rules" ||
            _name.includes("builtin")
          ? "external module rules"
          : "source-qualified roots",
    );
  });

  it("accepts the source-qualified trusted-main Snowflake class", async () => {
    await put("snowflake/glue/entry.mts", "export const ready = true;\n");

    expect(
      verifyNodeImportClosure(
        request({
          trustedRoot: "snowflake/glue",
          trustedSourceClass: "trusted-main-snowflake",
          entrypoints: ["snowflake/glue/entry.mts"],
        }),
      ),
    ).toEqual(
      expect.objectContaining({
        files: ["snowflake/glue/entry.mts"],
        violations: [],
      }),
    );
  });

  it("rejects a missing repository root", () => {
    expectViolation(
      verifyNodeImportClosure(
        request({ repositoryRoot: join(repositoryRoot, "missing") }),
      ),
      "unsafe-path",
      "repository root must be a real directory",
    );
  });
});
