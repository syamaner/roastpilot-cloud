import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The placement meta-guard (#160 — closes the residual C1/C2 leave open). The
 * `tests/factory/` prefix protects every factory-integrity enforcement test
 * that lives THERE, but nothing stops a future enforcement test being created
 * OUTSIDE the subtree, unprotected by the guard and unowned by CODEOWNERS. This
 * scan fails CI if any in-class member is found outside `tests/factory/`, so
 * drift is loud rather than silent.
 *
 * WHAT C4 CATCHES — and why it is IMPORT-ONLY (the design-level decision after
 * three connector rounds, #160/#177). C4 flags a TS test placed OUTSIDE
 * `tests/factory/` that IMPORTS the `scripts/factory/` glue — via `from`,
 * dynamic `import()`, or `require()`. That is the whole detector. It is a
 * per-file static text scan over the vitest (`tests/**\/*.test.ts`) and
 * Playwright (`e2e/**`) roots.
 *
 * It DELIBERATELY does NOT catch (all honest-drift ceiling, backstopped by C1's
 * applied-tree guard, which blocks a factory patch from EDITING the protected
 * surface regardless of how any test references it):
 *   - a test that READS a protected tree path WITHOUT importing the glue (the
 *     live-read subclass — which the full-corpus survey showed overwhelmingly
 *     uses variable/wrapper path arguments anyway, i.e. the computed-path ceiling
 *     below, so it adds negligible real coverage);
 *   - Python / snowflake tests — the data-layer class (story-planner contract
 *     §Q5): mutation-gate-covered and legitimately factory-authored, so a
 *     pipeline-integrity Python test placed there is a zero-instance case;
 *   - side-effect imports (`import "scripts/factory/x"` with no binding, #177:206);
 *   - subprocess / child-process execution, `eval` / dynamic-`import` of computed
 *     specifiers, cross-module delegation (a read in an imported helper), and
 *     computed / concatenated / variable-substituted path arguments.
 *
 * WHY IMPORT-ONLY. The two read-heuristics C4 used to carry — the TS
 * literal-read and the Python path-shaped token — each produced connector
 * false-positives (:83, :168 for TS; :255 for Python: an ordinary test that
 * merely NAMES a protected path in a comment/docstring/test-name got flagged,
 * rejecting a safe unrelated PR). `importsFactoryGlue` (keyword-anchored to real
 * import syntax) never did. The survey also showed import-detection alone
 * already covers the majority of the subtree precisely, while the read-heuristics
 * added ~no real coverage and were the entire FP source. Dropping them ends the
 * FP spiral by construction — a keyword-anchored import regex has no
 * prose-match or read-mode edges — and loses essentially nothing real.
 */

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** The subtree in-class enforcement tests must live under (C1's guard prefix). */
const ENFORCEMENT_TEST_SUBTREE = "tests/factory/";

/** A scanned file: its repo-relative path (`/`-separated) and full content. */
interface ScanFile {
  readonly relativePath: string;
  readonly content: string;
}

/**
 * True when a file IMPORTS the privileged factory glue it would be testing — a
 * static `from`, dynamic `import(`, or `require(` of a `scripts/factory/`
 * module. This is C4's SOLE in-class detector (import-only, #160/#177).
 *
 * The specifier is quote-delimited and kept within a SINGLE literal by the
 * `[^"'\`]*` runs (they cannot cross a quote), and the opening quote is ANCHORED
 * to the `import`/`from`/`require` keyword — so a BARE prose mention of the path
 * (`// once lived in scripts/factory`) does NOT match: it lacks the `<keyword>
 * "..."` shape. Path depth is left open so a different relative depth still
 * matches, and the specifier may be single-quoted, double-quoted, or a backtick
 * no-substitution template (`import(\`...\`)` / `require(\`...\`)`).
 *
 * RESIDUAL (honest-drift, documented): a COMMENT that quotes verbatim import
 * syntax for the glue (`// from "scripts/factory/x"`) would match — an
 * exceedingly unusual thing to write, and backstopped by C1. It is not folded
 * against, deliberately: a robust comment-stripper needs the very
 * string-literal machinery import-only C4 removed, and would risk a false
 * NEGATIVE on a real specifier (a `//` inside a genuine `scripts/factory` string).
 */
export function importsFactoryGlue(content: string): boolean {
  return /(?:from|import\s*\(|require\s*\()\s*["'`][^"'`]*scripts\/factory\/[^"'`]*["'`]/.test(
    content,
  );
}

/**
 * The pure detector (fixture-injectable): whether a file's content puts it in
 * the factory-integrity enforcement-test class. Import-only (#160/#177) — see
 * the file header for why the read-heuristics were dropped.
 */
export function isInClassEnforcementTest(content: string): boolean {
  return importsFactoryGlue(content);
}

/**
 * The pure placement check (fixture-injectable): every in-class member found
 * OUTSIDE `tests/factory/`. Empty means every enforcement test is in the
 * protected, owned drawer.
 */
export function findMisplacedEnforcementTests(
  files: readonly ScanFile[],
): string[] {
  return files
    .filter((file) => !file.relativePath.startsWith(ENFORCEMENT_TEST_SUBTREE))
    .filter((file) => isInClassEnforcementTest(file.content))
    .map((file) => file.relativePath)
    .sort();
}

/** Gathers scan files under a repo directory, filtered by filename pattern. */
function gatherFiles(directory: string, namePattern: RegExp): ScanFile[] {
  const absoluteDirectory = join(REPOSITORY_ROOT, directory);
  if (!existsSync(absoluteDirectory)) {
    return [];
  }
  return readdirSync(absoluteDirectory, { recursive: true })
    .map((entry) => entry.toString())
    .filter((entry) => namePattern.test(entry))
    .map((entry) => ({
      relativePath: `${directory}/${entry.split(sep).join("/")}`,
      absolutePath: join(absoluteDirectory, entry),
    }))
    .filter(({ absolutePath }) => statSync(absolutePath).isFile())
    .map(({ relativePath, absolutePath }) => ({
      relativePath,
      content: readFileSync(absolutePath, "utf8"),
    }));
}

/** Vitest discovery for the `tests/` root (`vitest.config.ts` include glob). */
const VITEST_TEST_PATTERN = /\.test\.ts$/;

/**
 * Playwright's DEFAULT testMatch for the `e2e/` root — `playwright.config.ts`
 * sets `testDir: "./e2e"` with no `testMatch` override, so discovery is the
 * built-in `**\/*.@(spec|test).?(c|m)[jt]s?(x)`: a `.spec.`/`.test.` file with
 * any of the js/ts extensions (`js`, `jsx`, `ts`, `tsx`, `cjs`, `mjs`, `cts`,
 * `mts`, ...). The old `/\.ts$/` filter matched only plain `.ts` and MISSED
 * `.spec.tsx`/`.spec.mts`/`.spec.js`/... — a misplaced glue-importing e2e test
 * in any of those would run under Playwright yet escape this scan (connector on
 * #177).
 */
const PLAYWRIGHT_TEST_PATTERN = /\.(test|spec)\.(c|m)?[jt]sx?$/;

/**
 * The live corpus C4 scans: the TS test roots only — `tests/**\/*.test.ts`
 * (vitest) and `e2e/**` (Playwright). The Python/pytest root
 * (`snowflake/tests/`) is deliberately NOT scanned: those are the data-layer
 * class (see the file header), and the Python read-heuristic that once scanned
 * them was the :255 false-positive source.
 */
function gatherScanCorpus(): ScanFile[] {
  return [
    ...gatherFiles("tests", VITEST_TEST_PATTERN),
    ...gatherFiles("e2e", PLAYWRIGHT_TEST_PATTERN),
  ];
}

describe("enforcement-test placement meta-guard (#160)", () => {
  // T7: today's expected match set is EMPTY. The sanity assertions keep this
  // from passing vacuously — the scan must reach the tests/factory subtree, and
  // the detector must fire on a known live member (a glue importer).
  it("finds no in-class enforcement test outside tests/factory/", () => {
    const corpus = gatherScanCorpus();
    expect(
      corpus.some((file) => file.relativePath.startsWith("tests/factory/")),
    ).toBe(true);

    const glueImporter = corpus.find(
      (file) => file.relativePath === "tests/factory/implement-patch-logic.test.ts",
    );
    expect(glueImporter).toBeDefined();
    expect(isInClassEnforcementTest(glueImporter!.content)).toBe(true);

    expect(findMisplacedEnforcementTests(corpus)).toEqual([]);
  });

  // N5.
  describe("detector and placement check on injected fixtures (N5)", () => {
    it("passes an ordinary application test outside the subtree", () => {
      expect(
        findMisplacedEnforcementTests([
          {
            relativePath: "tests/slug.test.ts",
            content:
              "import { slugify } from '../lib/slug';\n" +
              "it('slugifies', () => expect(slugify('A B')).toBe('a-b'));\n",
          },
        ]),
      ).toEqual([]);
    });

    // False-positive that import-only removes by construction (:168 on #177): a
    // bare read-verb WORD in a test NAME (`open`) plus a protected token in that
    // same name is not an import of the glue, so it must NOT be flagged.
    it("does NOT flag a test whose name contains a read-verb word and a token", () => {
      expect(
        findMisplacedEnforcementTests([
          {
            relativePath: "tests/npmrc-behaviour.test.ts",
            content:
              'it("does not open .npmrc", () => {\n' +
              "  expect(loadConfig().reads).not.toContain('.npmrc');\n" +
              "});\n",
          },
        ]),
      ).toEqual([]);
    });

    // FP that import-only removes (:83 on #177): an ordinary app test that reads
    // a NON-protected fixture and merely names a protected path in a comment is
    // not a glue import → NOT flagged.
    it("does NOT flag an ordinary test that reads a fixture and names a protected path in a comment", () => {
      expect(
        findMisplacedEnforcementTests([
          {
            relativePath: "tests/fixture-reader.test.ts",
            content:
              "import { readFileSync } from 'node:fs';\n" +
              "// reads a fixture; we deliberately never open the .github/ tree\n" +
              'const data = readFileSync("fixture.txt", "utf8");\n' +
              'it("parses", () => expect(parse(data)).toBe("ok"));\n',
          },
        ]),
      ).toEqual([]);
    });

    // importsFactoryGlue robustness: a BARE prose mention of the glue path (no
    // `<keyword> "..."` import syntax) is NOT a match.
    it("does NOT flag a bare prose mention of the glue path", () => {
      expect(
        findMisplacedEnforcementTests([
          {
            relativePath: "tests/history.test.ts",
            content:
              "import { helper } from '../lib/helper';\n" +
              "// this logic used to live under scripts/factory before the move\n" +
              "it('works', () => expect(helper()).toBe(true));\n",
          },
        ]),
      ).toEqual([]);
    });

    // FP that import-only removes (:255 on #177): a Python data-layer test that
    // names a protected path in a docstring is not a glue import; Python is not
    // even scanned now, but even passed directly it must NOT be flagged.
    it("does NOT flag a Python test that names a protected path in a docstring", () => {
      expect(
        findMisplacedEnforcementTests([
          {
            relativePath: "snowflake/tests/test_grants.py",
            content:
              "def test_no_public_grants():\n" +
              "    # AGENTS.md's invariant is \"no grants to PUBLIC\"; see .github/workflows\n" +
              "    sql = open('snowflake/fixtures/grants.sql').read()\n" +
              "    assert 'PUBLIC' not in sql\n",
          },
        ]),
      ).toEqual([]);
    });

    it("flags an out-of-tree test importing the factory glue", () => {
      expect(
        findMisplacedEnforcementTests([
          {
            relativePath: "tests/sneaky-pin.test.ts",
            content:
              "import { validateAgentModelPins } from '../../scripts/factory/x.mts';\n",
          },
        ]),
      ).toEqual(["tests/sneaky-pin.test.ts"]);
    });

    it("flags a misplaced e2e glue-importing test with a non-.ts Playwright extension", () => {
      expect(
        findMisplacedEnforcementTests([
          {
            relativePath: "e2e/alarm.spec.tsx",
            content:
              "import { isProtectedPath } from '../scripts/factory/x.mts';\n",
          },
        ]),
      ).toEqual(["e2e/alarm.spec.tsx"]);
    });

    it("flags a factory-glue import via a backtick dynamic-import specifier", () => {
      expect(
        findMisplacedEnforcementTests([
          {
            relativePath: "tests/backtick-import.test.ts",
            content:
              "const mod = await import(`../../scripts/factory/x.mts`);\n",
          },
        ]),
      ).toEqual(["tests/backtick-import.test.ts"]);
    });

    it("flags a factory-glue require() outside the subtree", () => {
      expect(
        findMisplacedEnforcementTests([
          {
            relativePath: "tests/cjs-import.test.ts",
            content: "const glue = require('../../scripts/factory/x.mts');\n",
          },
        ]),
      ).toEqual(["tests/cjs-import.test.ts"]);
    });

    it("does NOT flag a correctly-placed in-class member under the subtree", () => {
      expect(
        findMisplacedEnforcementTests([
          {
            relativePath: "tests/factory/new-alarm.test.ts",
            content:
              "import { isProtectedPath } from '../../scripts/factory/x.mts';\n",
          },
        ]),
      ).toEqual([]);
    });

    // Playwright testMatch coverage (connector on #177): the e2e scan must
    // discover every extension Playwright runs, not just plain `.ts`.
    it.each([
      "alarm.spec.tsx",
      "alarm.spec.mts",
      "alarm.test.jsx",
      "alarm.spec.js",
      "alarm.spec.cjs",
      "boot.spec.ts",
    ])("Playwright discovery pattern matches the e2e test file %s", (name) => {
      expect(PLAYWRIGHT_TEST_PATTERN.test(name)).toBe(true);
    });

    it.each(["helpers.ts", "fixture.json", "README.md"])(
      "Playwright discovery pattern excludes the non-test e2e file %s",
      (name) => {
        expect(PLAYWRIGHT_TEST_PATTERN.test(name)).toBe(false);
      },
    );
  });
});
