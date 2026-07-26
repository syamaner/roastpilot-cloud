import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";

let repositoryRoot: string;
const VERIFIER_URL = new URL(
  "../../scripts/factory/node-import-closure-verifier.mts",
  import.meta.url,
).href;

async function put(path: string, content: string): Promise<void> {
  const absolute = join(repositoryRoot, path);
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

beforeEach(async () => {
  repositoryRoot = await mkdtemp(join(tmpdir(), "node-runtime-single-read-"));
});

afterEach(async () => {
  await rm(repositoryRoot, { recursive: true, force: true });
});

it("analyzes every canonical closure file from exactly one stable read", async () => {
  await put(
    "scripts/factory/trusted/entry.mts",
    'import "./dependency.mts";\n',
  );
  await put(
    "scripts/factory/trusted/dependency.mts",
    "export const value = 1;\n",
  );
  const preloadPath = join(repositoryRoot, "count-reads.mjs");
  const runnerPath = join(repositoryRoot, "runner.mts");
  await writeFile(
    preloadPath,
    [
      'import fs from "node:fs";',
      'import { syncBuiltinESMExports } from "node:module";',
      "const original = fs.readFileSync;",
      "const counts = new Map();",
      "fs.readFileSync = function(path, ...args) {",
      '  if (typeof path === "string") counts.set(path, (counts.get(path) ?? 0) + 1);',
      "  return original.call(this, path, ...args);",
      "};",
      "syncBuiltinESMExports();",
      "globalThis.__roastpilotReadCounts = counts;",
      "",
    ].join("\n"),
  );
  await writeFile(
    runnerPath,
    [
      `import { verifyNodeExecutableClosure } from ${JSON.stringify(VERIFIER_URL)};`,
      `const result = verifyNodeExecutableClosure(${JSON.stringify({
        repositoryRoot,
        trustedRoot: "scripts/factory/trusted",
        trustedSourceClass: "protected-glue",
        rootsComplete: true,
        entrypoints: ["scripts/factory/trusted/entry.mts"],
        externalModules: [],
      })});`,
      "const counts = Object.fromEntries(globalThis.__roastpilotReadCounts);",
      "console.log(JSON.stringify({ result, counts }));",
      "",
    ].join("\n"),
  );

  const output = JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", preloadPath, "--experimental-strip-types", runnerPath],
      { encoding: "utf8" },
    ),
  ) as {
    readonly result: { readonly files: readonly string[] };
    readonly counts: Readonly<Record<string, number>>;
  };

  expect(output.result.files).toEqual([
    "scripts/factory/trusted/dependency.mts",
    "scripts/factory/trusted/entry.mts",
  ]);
  const canonicalRoot = await realpath(repositoryRoot);
  expect(output.counts).toEqual({
    [join(canonicalRoot, "scripts/factory/trusted/entry.mts")]: 1,
    [join(canonicalRoot, "scripts/factory/trusted/dependency.mts")]: 1,
  });
});
