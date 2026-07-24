import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";
import {
  ALLOWLISTED_TRACKED_PATHS,
  decodeTrackedText,
  findInvisibleFormatCharacters,
  formatInvisibleFormatFinding,
  isDirectExecution,
  loadTrackedWorkingTreeEntry,
  main,
  runCli,
  scanRepository,
  scanTrackedPaths,
} from "../../scripts/factory/check-invisible-format-characters.mts";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENTRYPOINT_PATH = join(
  REPOSITORY_ROOT,
  "scripts",
  "factory",
  "check-invisible-format-characters.mts",
);
const CI_WORKFLOW_PATH = join(
  REPOSITORY_ROOT,
  ".github",
  "workflows",
  "ci.yml",
);
const CHECK_COMMAND =
  "node --experimental-strip-types scripts/factory/check-invisible-format-characters.mts";

const REQUIRED_DEFAULT_IGNORABLE_EXAMPLES = [
  0x00ad,
  0x034f,
  0x061c,
  0x115f,
  0x17b4,
  0x180b,
  0x180e,
  ...codePointRange(0x200b, 0x200f),
  ...codePointRange(0x202a, 0x202e),
  ...codePointRange(0x2060, 0x206f),
  0x3164,
  0xfe00,
  0xfe0f,
  0xfeff,
  0xffa0,
  0xe0000,
  0xe0001,
  0xe0020,
  0xe007f,
  0xe0100,
  0xe01ef,
] as const;

type Mapping = Record<string, unknown>;

function codePointRange(start: number, end: number): number[] {
  return Array.from(
    { length: end - start + 1 },
    (_unused, index) => start + index,
  );
}

function asMapping(value: unknown): Mapping | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Mapping)
    : undefined;
}

function withTemporaryGitRepository(
  run: (repositoryRoot: string) => void,
): void {
  const repositoryRoot = mkdtempSync(
    join(tmpdir(), "invisible-format-guard-"),
  );
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: repositoryRoot });
    run(repositoryRoot);
  } finally {
    rmSync(repositoryRoot, { force: true, recursive: true });
  }
}

function writeTrackedFile(
  repositoryRoot: string,
  path: string,
  content: string | Uint8Array,
): void {
  const absolutePath = join(repositoryRoot, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
  execFileSync("git", ["add", "--", path], { cwd: repositoryRoot });
}

function runEntrypointAtPath(
  repositoryRoot: string,
  entrypointPath: string,
) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", entrypointPath],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
    },
  );
}

function runEntrypoint(repositoryRoot: string) {
  return runEntrypointAtPath(repositoryRoot, ENTRYPOINT_PATH);
}

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

describe("findInvisibleFormatCharacters", () => {
  it.each(REQUIRED_DEFAULT_IGNORABLE_EXAMPLES)(
    "rejects representative default-ignorable U+%s",
    (codePoint) => {
      const text = `before${String.fromCodePoint(codePoint)}after`;
      expect(findInvisibleFormatCharacters("src/example.ts", text)).toEqual([
        {
          path: "src/example.ts",
          line: 1,
          column: 7,
          codePoint,
        },
      ]);
    },
  );

  it.each([
    0x00ac,
    0x00ae,
    0x034e,
    0x0350,
    0x061b,
    0x061d,
    0x200a,
    0x2010,
    0x2029,
    0x202f,
    0x205f,
    0x2070,
    0x3163,
    0x3165,
    0xfefe,
    0xff00,
    0xdffff,
    0xe1000,
    0x10ffff,
  ])(
    "allows adjacent non-target U+%s",
    (codePoint) => {
      expect(
        findInvisibleFormatCharacters(
          "src/example.ts",
          `before${String.fromCodePoint(codePoint)}after`,
        ),
      ).toEqual([]);
    },
  );

  it("reports multiple findings in source order with code-point columns", () => {
    const forbidden = String.fromCodePoint(0x202e);
    const astral = String.fromCodePoint(0x1f600);
    const findings = findInvisibleFormatCharacters(
      "src/example.ts",
      `${astral}a\nx${forbidden}y${forbidden}`,
    );

    expect(findings).toEqual([
      {
        path: "src/example.ts",
        line: 2,
        column: 2,
        codePoint: 0x202e,
      },
      {
        path: "src/example.ts",
        line: 2,
        column: 4,
        codePoint: 0x202e,
      },
    ]);
  });

  it("treats CR, CRLF, and Unicode line separators as line boundaries", () => {
    const forbidden = String.fromCodePoint(0x200b);
    const lineSeparator = String.fromCodePoint(0x2028);
    const paragraphSeparator = String.fromCodePoint(0x2029);
    const findings = findInvisibleFormatCharacters(
      "src/lines.ts",
      `a\r\nb\rc${lineSeparator}d${paragraphSeparator}e${forbidden}`,
    );

    expect(findings).toEqual([
      {
        path: "src/lines.ts",
        line: 5,
        column: 2,
        codePoint: 0x200b,
      },
    ]);
  });

  it("allows visible unicode escape text", () => {
    expect(
      findInvisibleFormatCharacters(
        "tests/example.test.ts",
        "const payload = \"\\u200B\\u061C\\u{E0100}\";",
      ),
    ).toEqual([]);
  });
});

describe("decodeTrackedText", () => {
  it("preserves a leading UTF-8 BOM so U+FEFF is rejected", () => {
    const decoded = decodeTrackedText(
      Uint8Array.from([0xef, 0xbb, 0xbf, 0x61]),
    );
    expect(decoded).not.toBeNull();
    expect(
      findInvisibleFormatCharacters("bom.txt", decoded ?? ""),
    ).toEqual([
      { path: "bom.txt", line: 1, column: 1, codePoint: 0xfeff },
    ]);
  });

  it("skips NUL-bearing and invalid UTF-8 content", () => {
    expect(decodeTrackedText(Uint8Array.from([0x61, 0x00, 0x62]))).toBeNull();
    expect(decodeTrackedText(Uint8Array.from([0xc3, 0x28]))).toBeNull();
  });
});

describe("scanTrackedPaths", () => {
  it("counts text and non-text entries and collects all findings", () => {
    const contents = new Map<string, Uint8Array | null>([
      ["clean.txt", Buffer.from("clean")],
      [
        "bad.txt",
        Buffer.from(`a${String.fromCodePoint(0x200b)}b`),
      ],
      ["binary.bin", Uint8Array.from([0x00, 0x01])],
      ["gitlink", null],
    ]);

    expect(
      scanTrackedPaths(
        ["clean.txt", "bad.txt", "binary.bin", "gitlink"],
        (path) => contents.get(path) ?? null,
      ),
    ).toEqual({
      findings: [
        {
          path: "bad.txt",
          line: 1,
          column: 2,
          codePoint: 0x200b,
        },
      ],
      scannedTextFiles: 2,
      skippedNonTextEntries: 2,
      skippedAllowlistedEntries: 0,
    });
  });

  it("skips only exact allowlisted paths", () => {
    const forbidden = Buffer.from(String.fromCodePoint(0x2060));
    const result = scanTrackedPaths(
      ["allowed.txt", "nested/allowed.txt"],
      () => forbidden,
      new Set(["allowed.txt"]),
    );

    expect(result.findings.map((finding) => finding.path)).toEqual([
      "nested/allowed.txt",
    ]);
    expect(result.skippedAllowlistedEntries).toBe(1);
    expect(ALLOWLISTED_TRACKED_PATHS.size).toBe(0);
  });
});

describe("loadTrackedWorkingTreeEntry", () => {
  it("handles a root with a trailing separator and rejects parent traversal", () => {
    withTemporaryGitRepository((repositoryRoot) => {
      writeTrackedFile(repositoryRoot, "tracked.txt", "tracked");

      expect(
        Buffer.from(
          loadTrackedWorkingTreeEntry(
            `${repositoryRoot}${sep}`,
            "tracked.txt",
          ) ?? [],
        ).toString("utf8"),
      ).toBe("tracked");
      expect(() =>
        loadTrackedWorkingTreeEntry(repositoryRoot, "../outside.txt"),
      ).toThrow("tracked path escapes repository root");
    });
  });

  it("returns null for a non-file entry", () => {
    withTemporaryGitRepository((repositoryRoot) => {
      mkdirSync(join(repositoryRoot, "gitlink"));
      expect(
        loadTrackedWorkingTreeEntry(repositoryRoot, "gitlink"),
      ).toBeNull();
    });
  });
});

describe("formatInvisibleFormatFinding", () => {
  it("produces a deterministic diagnostic without source content", () => {
    expect(
      formatInvisibleFormatFinding({
        path: "src/example.ts",
        line: 2,
        column: 4,
        codePoint: 0x202e,
      }),
    ).toBe("\"src/example.ts\":2:4: forbidden U+202E");
  });

  it("neutralizes control and bidi characters in an attacker-controlled path", () => {
    const arabicLetterMark = String.fromCodePoint(0x061c);
    const unsafePath =
      `src/${arabicLetterMark}\nname${String.fromCodePoint(0x202e)}` + ".ts";
    const formatted = formatInvisibleFormatFinding({
      path: unsafePath,
      line: 1,
      column: 1,
      codePoint: 0x200b,
    });

    expect(formatted).toBe(
      "\"src/[U+061C]\\nname[U+202E].ts\":1:1: forbidden U+200B",
    );
    expect(formatted).not.toContain(arabicLetterMark);
    expect(formatted).not.toContain(String.fromCodePoint(0x202e));
  });
});

describe("scanner entrypoint", () => {
  it("identifies direct execution with URL-aware path comparison", () => {
    expect(
      isDirectExecution(
        pathToFileURL(ENTRYPOINT_PATH).href,
        ENTRYPOINT_PATH,
      ),
    ).toBe(true);
    expect(
      isDirectExecution(pathToFileURL(ENTRYPOINT_PATH).href, undefined),
    ).toBe(false);
  });

  it("runs when the entrypoint path contains URL-escaped characters", () => {
    withTemporaryGitRepository((repositoryRoot) => {
      writeTrackedFile(repositoryRoot, "clean.txt", "clean");
      const specialPath = join(
        repositoryRoot,
        "scanner with space # percent %",
        "check.mts",
      );
      mkdirSync(dirname(specialPath), { recursive: true });
      writeFileSync(specialPath, readFileSync(ENTRYPOINT_PATH));

      const result = runEntrypointAtPath(repositoryRoot, specialPath);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("Invisible-format guard passed:");
      expect(result.stderr).toBe("");
    });
  });

  it("passes a clean tracked UTF-8 file and ignores untracked content", () => {
    withTemporaryGitRepository((repositoryRoot) => {
      writeTrackedFile(
        repositoryRoot,
        "src/clean.ts",
        "const payload = \"\\u200B\";\n",
      );
      writeFileSync(
        join(repositoryRoot, "untracked.ts"),
        String.fromCodePoint(0x200b),
      );

      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(process, "cwd").mockReturnValue(repositoryRoot);
      main();
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining(
          "Invisible-format guard passed: scanned 1 tracked UTF-8 text file(s)",
        ),
      );

      const result = runEntrypoint(repositoryRoot);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(
        "Invisible-format guard passed: scanned 1 tracked UTF-8 text file(s)",
      );
      expect(result.stderr).toBe("");
    });
  });

  it("scans every tracked path and reports a forbidden character after a clean file", () => {
    withTemporaryGitRepository((repositoryRoot) => {
      writeTrackedFile(repositoryRoot, "a-clean.ts", "clean");
      writeTrackedFile(
        repositoryRoot,
        "nested/z-bad.ts",
        `bad${String.fromCodePoint(0x2060)}`,
      );

      const result = scanRepository(repositoryRoot);

      expect(result.scannedTextFiles).toBe(2);
      expect(result.findings).toEqual([
        {
          path: "nested/z-bad.ts",
          line: 1,
          column: 4,
          codePoint: 0x2060,
        },
      ]);
    });
  });

  it("fails with a location and code point but not the source line", () => {
    withTemporaryGitRepository((repositoryRoot) => {
      const source = `secret-before${String.fromCodePoint(0x202e)}secret-after`;
      writeTrackedFile(repositoryRoot, "src/bad.ts", source);

      const error = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      vi.spyOn(process, "cwd").mockReturnValue(repositoryRoot);
      runCli();
      expect(process.exitCode).toBe(1);
      expect(error).toHaveBeenCalledWith(
        "Invisible-format guard failed:",
        expect.stringContaining(
          "\"src/bad.ts\":1:14: forbidden U+202E",
        ),
      );

      const result = runEntrypoint(repositoryRoot);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "\"src/bad.ts\":1:14: forbidden U+202E",
      );
      expect(result.stderr).not.toContain("secret-before");
      expect(result.stdout).toBe("");
    });
  });

  it("scans a tracked symlink's link text without following its target", () => {
    withTemporaryGitRepository((repositoryRoot) => {
      const linkTarget = `missing-${String.fromCodePoint(0x2064)}`;
      symlinkSync(linkTarget, join(repositoryRoot, "unsafe-link"));
      execFileSync("git", ["add", "--", "unsafe-link"], {
        cwd: repositoryRoot,
      });

      expect(scanRepository(repositoryRoot).findings).toEqual([
        {
          path: "unsafe-link",
          line: 1,
          column: 9,
          codePoint: 0x2064,
        },
      ]);

      const result = runEntrypoint(repositoryRoot);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "\"unsafe-link\":1:9: forbidden U+2064",
      );
      expect(result.stderr).not.toContain(linkTarget);
    });
  });

  it("does not scan an untracked symlink target's contents", () => {
    withTemporaryGitRepository((repositoryRoot) => {
      writeFileSync(
        join(repositoryRoot, "target.txt"),
        String.fromCodePoint(0x200b),
      );
      symlinkSync("target.txt", join(repositoryRoot, "safe-link"));
      execFileSync("git", ["add", "--", "safe-link"], {
        cwd: repositoryRoot,
      });

      const result = scanRepository(repositoryRoot);

      expect(result.findings).toEqual([]);
      expect(result.scannedTextFiles).toBe(1);
    });
  });

  it("preserves NUL-delimited tracked paths and escapes newlines in diagnostics", () => {
    withTemporaryGitRepository((repositoryRoot) => {
      const path = "src/line\nbreak.ts";
      writeTrackedFile(
        repositoryRoot,
        path,
        `a${String.fromCodePoint(0x200f)}`,
      );

      const scan = scanRepository(repositoryRoot);
      expect(scan.findings).toEqual([
        { path, line: 1, column: 2, codePoint: 0x200f },
      ]);

      const result = runEntrypoint(repositoryRoot);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "\"src/line\\nbreak.ts\":1:2: forbidden U+200F",
      );
      expect(result.stderr).not.toContain(path);
    });
  });

  it("fails closed when a tracked working-tree path is missing", () => {
    withTemporaryGitRepository((repositoryRoot) => {
      writeTrackedFile(repositoryRoot, "deleted.txt", "tracked");
      rmSync(join(repositoryRoot, "deleted.txt"));

      expect(() => scanRepository(repositoryRoot)).toThrow(
        "cannot inspect tracked path: \"deleted.txt\"",
      );

      const result = runEntrypoint(repositoryRoot);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "cannot inspect tracked path: \"deleted.txt\"",
      );
    });
  });

  it("passes the current repository without a literal forbidden character", () => {
    const result = scanRepository(REPOSITORY_ROOT);
    expect(result.findings).toEqual([]);
    expect(result.scannedTextFiles).toBeGreaterThan(0);
  });
});

describe("CI workflow wiring", () => {
  it("runs the protected scanner after Node setup and before dependency installation", () => {
    const document = parseDocument(readFileSync(CI_WORKFLOW_PATH, "utf8"));
    expect(document.errors).toEqual([]);
    const root = asMapping(document.toJS({ maxAliasCount: 100 }));
    const jobs = asMapping(root?.jobs);
    const gates = asMapping(jobs?.gates);
    const steps = Array.isArray(gates?.steps) ? gates.steps : [];
    const scannerIndex = steps.findIndex(
      (step) =>
        asMapping(step)?.name === "Reject literal invisible format characters",
    );
    const scannerSteps = steps.filter(
      (step) =>
        asMapping(step)?.name === "Reject literal invisible format characters",
    );
    const scanner = asMapping(steps[scannerIndex]);
    const setupIndex = steps.findIndex(
      (step) => asMapping(step)?.name === "Set up Node",
    );
    const installIndex = steps.findIndex(
      (step) => asMapping(step)?.name === "Install dependencies",
    );

    expect(scannerSteps).toHaveLength(1);
    expect(scannerIndex).toBeGreaterThan(setupIndex);
    expect(scannerIndex).toBeLessThan(installIndex);
    expect(scanner?.run).toBe(CHECK_COMMAND);
    expect(scanner).not.toHaveProperty("if");
    expect(scanner).not.toHaveProperty("continue-on-error");
  });
});
