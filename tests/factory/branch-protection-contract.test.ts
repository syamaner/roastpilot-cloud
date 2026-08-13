import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  REQUIRED_STATUS_APP_IDS,
  REQUIRED_STATUS_CONTEXTS,
  isDirectInvocation,
  runCli as runCliInProcess,
  verifyBranchProtectionContract,
} from "../../scripts/factory/branch-protection-contract.mts";

type JsonObject = Record<string, unknown>;

interface LiveSnapshot extends JsonObject {
  url: string;
  required_status_checks: JsonObject & {
    url: string;
    strict: boolean;
    contexts: unknown;
    contexts_url: string;
    checks: unknown;
  };
  required_signatures: JsonObject;
  enforce_admins: JsonObject;
  required_linear_history: JsonObject;
  allow_force_pushes: JsonObject;
  allow_deletions: JsonObject;
  block_creations: JsonObject;
  required_conversation_resolution: JsonObject;
  lock_branch: JsonObject;
  allow_fork_syncing: JsonObject;
}

// Live GitHub branch-protection payload captured 2026-08-11 at head 737c6b0.
const LIVE_SNAPSHOT: LiveSnapshot = {
  url: "https://api.github.com/repos/syamaner/roastpilot-cloud/branches/main/protection",
  required_status_checks: {
    url: "https://api.github.com/repos/syamaner/roastpilot-cloud/branches/main/protection/required_status_checks",
    strict: false,
    contexts: [
      "Lint, typecheck, unit tests",
      "Playwright smoke",
      "Snowflake migrations (offline)",
      "CodeQL",
      "dependency-review",
      "Mutation testing (security-critical Python)",
      "Analyze (javascript-typescript)",
      "Analyze (actions)",
      "Analyze (python)",
    ],
    contexts_url:
      "https://api.github.com/repos/syamaner/roastpilot-cloud/branches/main/protection/required_status_checks/contexts",
    checks: [
      { context: "Lint, typecheck, unit tests", app_id: 15368 },
      { context: "Playwright smoke", app_id: 15368 },
      { context: "Snowflake migrations (offline)", app_id: 15368 },
      { context: "CodeQL", app_id: 57789 },
      { context: "dependency-review", app_id: 15368 },
      {
        context: "Mutation testing (security-critical Python)",
        app_id: 15368,
      },
      { context: "Analyze (javascript-typescript)", app_id: 15368 },
      { context: "Analyze (actions)", app_id: 15368 },
      { context: "Analyze (python)", app_id: 15368 },
    ],
  },
  required_signatures: {
    url: "https://api.github.com/repos/syamaner/roastpilot-cloud/branches/main/protection/required_signatures",
    enabled: false,
  },
  enforce_admins: {
    url: "https://api.github.com/repos/syamaner/roastpilot-cloud/branches/main/protection/enforce_admins",
    enabled: true,
  },
  required_linear_history: { enabled: false },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  block_creations: { enabled: false },
  required_conversation_resolution: { enabled: true },
  lock_branch: { enabled: false },
  allow_fork_syncing: { enabled: false },
};

const RUNBOOK_PATH = new URL("../../docs/factory-runbook.md", import.meta.url);
const ENTRYPOINT_PATH = fileURLToPath(
  new URL("../../scripts/factory/branch-protection-contract.mts", import.meta.url),
);
const DEFAULT_BRANCH_ASSERTION =
  "test \"$(gh api repos/syamaner/roastpilot-cloud --jq '.default_branch')\" = main \\\n" +
  "  || { echo 'BRANCH-PROTECTION: default-branch drift — not main; fail closed'; exit 1; }";
const COMPARATOR_COMMAND =
  "gh api repos/syamaner/roastpilot-cloud/branches/main/protection \\\n" +
  '  | node --experimental-strip-types "$tmpdir/bpc.mts"';
const TRUSTED_COMPARATOR_BLOCK = [
  "set -euo pipefail",
  'tmpdir="$(mktemp -d)"',
  'gh api "repos/syamaner/roastpilot-cloud/contents/scripts/factory/branch-protection-contract.mts?ref=main" \\',
  '  -H "Accept: application/vnd.github.raw" > "$tmpdir/bpc.mts"',
  'test -s "$tmpdir/bpc.mts" || { echo \'BRANCH-PROTECTION: comparator load failed; fail closed\'; exit 1; }',
  DEFAULT_BRANCH_ASSERTION,
  COMPARATOR_COMMAND,
].join("\n");

afterEach(() => {
  vi.restoreAllMocks();
});

function cloneSnapshot(): LiveSnapshot {
  return structuredClone(LIVE_SNAPSHOT);
}

function contextsOf(snapshot: LiveSnapshot): string[] {
  const contexts = snapshot.required_status_checks.contexts;
  if (
    !Array.isArray(contexts) ||
    !contexts.every((item) => typeof item === "string")
  ) {
    throw new Error("fixture contexts are not strings");
  }
  return contexts;
}

function checksOf(snapshot: LiveSnapshot): JsonObject[] {
  const checks = snapshot.required_status_checks.checks;
  if (
    !Array.isArray(checks) ||
    !checks.every(
      (item) =>
        item !== null && typeof item === "object" && !Array.isArray(item),
    )
  ) {
    throw new Error("fixture checks are not objects");
  }
  return checks as JsonObject[];
}

function setEnabled(
  snapshot: LiveSnapshot,
  key:
    | "required_signatures"
    | "enforce_admins"
    | "required_linear_history"
    | "allow_force_pushes"
    | "allow_deletions"
    | "block_creations"
    | "required_conversation_resolution"
    | "lock_branch"
    | "allow_fork_syncing",
  value: unknown,
): void {
  snapshot[key].enabled = value;
}

function runCliAt(
  entrypointPath: string,
  input: string,
  extraArgs: readonly string[] = [],
) {
  return spawnSync(
    process.execPath,
    ["--no-warnings", "--experimental-strip-types", entrypointPath, ...extraArgs],
    {
      input,
      encoding: "utf8",
    },
  );
}

function runCli(input: string, extraArgs: readonly string[] = []) {
  return runCliAt(ENTRYPOINT_PATH, input, extraArgs);
}

function sectionBetween(
  document: string,
  startMarker: string,
  endMarker: string,
): string {
  const start = document.indexOf(startMarker);
  if (start < 0) throw new Error(`Missing section marker: ${startMarker}`);
  const end = document.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Missing section marker: ${endMarker}`);
  return document.slice(start, end);
}

function sectionAfter(document: string, marker: string): string {
  const start = document.indexOf(marker);
  if (start < 0) throw new Error(`Missing section marker: ${marker}`);
  return document.slice(start);
}

function normalizeProse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function bashBlocks(section: string): string[] {
  return [...section.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) =>
    (match[1] ?? "")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => line.replace(/^\s{3}/, ""))
      .join("\n"),
  );
}

describe("branch-protection contract comparator", () => {
  it("runs the OK CLI path in-process", () => {
    const readStdin = vi.fn(() => JSON.stringify(LIVE_SNAPSHOT));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(runCliInProcess(readStdin)).toBe(0);
    expect(readStdin).toHaveBeenCalledWith(0, "utf8");
    expect(log.mock.calls).toEqual([
      [
        "BRANCH-PROTECTION-CONTRACT: OK (9 required contexts; reviews-absent exception intact)",
      ],
    ]);
    expect(error).not.toHaveBeenCalled();
  });

  it("runs the drift CLI path in-process", () => {
    const drifted = cloneSnapshot();
    drifted.required_status_checks.strict = true;
    const readStdin = vi.fn(() => JSON.stringify(drifted));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    expect(runCliInProcess(readStdin)).toBe(1);
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls).toEqual([
      ["$.required_status_checks.strict:value-mismatch"],
      ["BRANCH-PROTECTION-CONTRACT: DRIFT (1 violations)"],
    ]);
  });

  it.each(["", "not JSON"])(
    "runs the malformed CLI path in-process for %j",
    (input) => {
      const readStdin = vi.fn(() => input);
      const log = vi
        .spyOn(console, "log")
        .mockImplementation(() => undefined);
      const error = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);

      expect(runCliInProcess(readStdin)).toBe(2);
      expect(log).not.toHaveBeenCalled();
      expect(error.mock.calls).toEqual([
        ["BRANCH-PROTECTION-CONTRACT: MALFORMED-INPUT"],
      ]);
    },
  );

  it("runs the stray-argument usage path in-process without reading stdin", () => {
    const originalArgv = process.argv;
    const readStdin = vi.fn(() => JSON.stringify(LIVE_SNAPSHOT));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      process.argv = [...process.argv.slice(0, 2), "payload.json"];
      expect(runCliInProcess(readStdin)).toBe(2);
    } finally {
      process.argv = originalArgv;
    }
    expect(readStdin).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    expect(error.mock.calls).toEqual([
      ["BRANCH-PROTECTION-CONTRACT: USAGE (read JSON from stdin)"],
    ]);
  });

  it("fails closed when direct-invocation path resolution throws", () => {
    const originalArgv = process.argv;
    try {
      process.argv = [process.argv[0]!, join(tmpdir(), "missing-bpc.mts")];
      expect(isDirectInvocation()).toBe(false);
      process.argv = [process.argv[0]!];
      expect(isDirectInvocation()).toBe(false);
    } finally {
      process.argv = originalArgv;
    }
  });

  it("T1 accepts the verbatim live snapshot", () => {
    expect(verifyBranchProtectionContract(cloneSnapshot())).toEqual({
      ok: true,
      violations: [],
    });
  });

  it("accepts a null-prototype plain-object payload", () => {
    const snapshot = Object.assign(
      Object.create(null) as JsonObject,
      cloneSnapshot(),
    );
    expect(verifyBranchProtectionContract(snapshot)).toEqual({
      ok: true,
      violations: [],
    });
  });

  it("T2 keeps the live fixture and canonical context pin set-equal", () => {
    const fixtureContexts = contextsOf(cloneSnapshot());
    expect(fixtureContexts).toHaveLength(REQUIRED_STATUS_CONTEXTS.length);
    expect(new Set(fixtureContexts)).toEqual(new Set(REQUIRED_STATUS_CONTEXTS));
  });

  it("pins the provider app ID for every required context", () => {
    expect(REQUIRED_STATUS_APP_IDS).toEqual({
      "Lint, typecheck, unit tests": 15368,
      "Playwright smoke": 15368,
      "Snowflake migrations (offline)": 15368,
      CodeQL: 57789,
      "dependency-review": 15368,
      "Mutation testing (security-critical Python)": 15368,
      "Analyze (javascript-typescript)": 15368,
      "Analyze (actions)": 15368,
      "Analyze (python)": 15368,
    });
  });

  it("T3 exercises CLI success, drift, and malformed exit codes", () => {
    const ok = runCli(JSON.stringify(LIVE_SNAPSHOT));
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe(
      "BRANCH-PROTECTION-CONTRACT: OK (9 required contexts; reviews-absent exception intact)\n",
    );
    expect(ok.stderr).toBe("");

    const drifted = cloneSnapshot();
    drifted.required_status_checks.strict = true;
    const drift = runCli(JSON.stringify(drifted));
    expect(drift.status).toBe(1);
    expect(drift.stdout).toBe("");
    expect(drift.stderr).toBe(
      "$.required_status_checks.strict:value-mismatch\n" +
        "BRANCH-PROTECTION-CONTRACT: DRIFT (1 violations)\n",
    );

    const malformed = runCli("not JSON");
    expect(malformed.status).toBe(2);
    expect(malformed.stdout).toBe("");
    expect(malformed.stderr).toBe(
      "BRANCH-PROTECTION-CONTRACT: MALFORMED-INPUT\n",
    );
  });

  it("executes after being copied beneath the platform temp directory", () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "bpc-"));
    const copiedEntrypoint = join(temporaryDirectory, "bpc.mts");
    copyFileSync(ENTRYPOINT_PATH, copiedEntrypoint);

    try {
      const drifted = cloneSnapshot();
      drifted.required_status_checks.strict = true;
      const drift = runCliAt(copiedEntrypoint, JSON.stringify(drifted));
      expect(drift.status).toBe(1);
      expect(drift.stdout).toBe("");
      expect(drift.stderr).toContain("BRANCH-PROTECTION-CONTRACT: DRIFT");

      const ok = runCliAt(copiedEntrypoint, JSON.stringify(LIVE_SNAPSHOT));
      expect(ok.status).toBe(0);
      expect(ok.stderr).toBe("");
      expect(ok.stdout).toContain("BRANCH-PROTECTION-CONTRACT: OK");
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it.each(REQUIRED_STATUS_CONTEXTS)(
    "N1..N9 rejects a missing required context: %s",
    (context) => {
      const snapshot = cloneSnapshot();
      snapshot.required_status_checks.contexts = contextsOf(snapshot).filter(
        (candidate) => candidate !== context,
      );
      expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
        `$.required_status_checks.contexts:missing:${context}`,
      ]);
    },
  );

  it("N10 rejects an extra context", () => {
    const snapshot = cloneSnapshot();
    contextsOf(snapshot).push("codecov/patch");
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks.contexts:unexpected:codecov/patch",
    ]);
  });

  it("N11 rejects a duplicated context", () => {
    const snapshot = cloneSnapshot();
    const context = REQUIRED_STATUS_CONTEXTS[0]!;
    contextsOf(snapshot).push(context);
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      `$.required_status_checks.contexts:duplicate:${context}`,
    ]);
  });

  it("N12 rejects a non-array contexts value", () => {
    const snapshot = cloneSnapshot();
    snapshot.required_status_checks.contexts = {};
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks.contexts:not-an-array",
    ]);
  });

  it("N13 rejects strict mode", () => {
    const snapshot = cloneSnapshot();
    snapshot.required_status_checks.strict = true;
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks.strict:value-mismatch",
    ]);
  });

  it.each([
    ["enforce_admins", false, "$.enforce_admins.enabled:value-mismatch"],
    [
      "allow_force_pushes",
      true,
      "$.allow_force_pushes.enabled:value-mismatch",
    ],
    ["allow_deletions", true, "$.allow_deletions.enabled:value-mismatch"],
    [
      "required_conversation_resolution",
      false,
      "$.required_conversation_resolution.enabled:value-mismatch",
    ],
    ["lock_branch", true, "$.lock_branch.enabled:value-mismatch"],
    [
      "required_signatures",
      true,
      "$.required_signatures.enabled:value-mismatch",
    ],
    [
      "required_linear_history",
      true,
      "$.required_linear_history.enabled:value-mismatch",
    ],
    ["block_creations", true, "$.block_creations.enabled:value-mismatch"],
    [
      "allow_fork_syncing",
      true,
      "$.allow_fork_syncing.enabled:value-mismatch",
    ],
  ] as const)("N14..N18 rejects a flipped %s pin", (key, value, code) => {
    const snapshot = cloneSnapshot();
    setEnabled(snapshot, key, value);
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([code]);
  });

  it.each([
    {},
    {
      url: "https://api.github.com/example",
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
      required_approving_review_count: 1,
      require_last_push_approval: true,
      dismissal_restrictions: { users: [], teams: [], apps: [] },
      bypass_pull_request_allowances: { users: [], teams: [], apps: [] },
    },
  ])("N19 rejects required pull-request reviews in every form", (reviews) => {
    const snapshot = cloneSnapshot();
    snapshot.required_pull_request_reviews = reviews;
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_pull_request_reviews:must-be-absent",
    ]);
  });

  it("N20 rejects a missing pinned top-level key with only its own code", () => {
    const snapshot = cloneSnapshot();
    Reflect.deleteProperty(snapshot, "enforce_admins");
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.enforce_admins:missing",
    ]);
  });

  it("rejects a missing required_status_checks top-level key", () => {
    const snapshot: JsonObject = cloneSnapshot();
    Reflect.deleteProperty(snapshot, "required_status_checks");
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks:missing",
    ]);
  });

  it("N21 rejects an unknown top-level key", () => {
    const snapshot = cloneSnapshot();
    snapshot.benign_new_key = {};
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.benign_new_key:unexpected",
    ]);
  });

  it("N21 treats an own __proto__ data key as unexpected", () => {
    const snapshot = cloneSnapshot();
    Object.defineProperty(snapshot, "__proto__", {
      value: {},
      enumerable: true,
      configurable: true,
    });
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.__proto__:unexpected",
    ]);
  });

  it("N22 rejects checks whose context set diverges", () => {
    const snapshot = cloneSnapshot();
    checksOf(snapshot)[0]!.context = "different check";
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks.checks:context-set-mismatch",
    ]);
  });

  it("rejects a duplicate check entry", () => {
    const snapshot = cloneSnapshot();
    const checks = checksOf(snapshot);
    checks.push(structuredClone(checks[0]!));
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks.checks:context-set-mismatch",
    ]);
  });

  it("rejects an unexpected semantic key on a checks entry", () => {
    const snapshot = cloneSnapshot();
    checksOf(snapshot)[0]!.conclusion = "success";
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks.checks[0].conclusion:value-mismatch",
    ]);
  });

  it("rejects a missing checks field", () => {
    const snapshot = cloneSnapshot();
    Reflect.deleteProperty(snapshot.required_status_checks, "checks");
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks.checks:context-set-mismatch",
    ]);
  });

  it("rejects an empty checks array", () => {
    const snapshot = cloneSnapshot();
    snapshot.required_status_checks.checks = [];
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks.checks:context-set-mismatch",
    ]);
  });

  it("rejects a non-array checks value", () => {
    const snapshot = cloneSnapshot();
    snapshot.required_status_checks.checks = {};
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks.checks:context-set-mismatch",
    ]);
  });

  it("rejects a non-plain-object checks entry without crashing", () => {
    const snapshot = cloneSnapshot();
    snapshot.required_status_checks.checks = [
      null,
      ...checksOf(snapshot).slice(1),
    ];
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks.checks:context-set-mismatch",
    ]);
  });

  it("rejects a checks entry with no context field", () => {
    const snapshot = cloneSnapshot();
    Reflect.deleteProperty(checksOf(snapshot)[0]!, "context");
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks.checks:context-set-mismatch",
    ]);
  });

  it("rejects a checks entry with a non-string context", () => {
    const snapshot = cloneSnapshot();
    checksOf(snapshot)[0]!.context = 42;
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks.checks:context-set-mismatch",
    ]);
  });

  it("rejects an unexpected required-status-checks key", () => {
    const snapshot = cloneSnapshot();
    snapshot.required_status_checks.foo = "bar";
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks.foo:value-mismatch",
    ]);
  });

  it.each([
    [42, "42"],
    [{ foo: "bar" }, '{"foo":"bar"}'],
    [undefined, "undefined"],
  ] as const)(
    "rejects and labels a non-string contexts entry: %j",
    (value, label) => {
      const snapshot = cloneSnapshot();
      snapshot.required_status_checks.contexts = contextsOf(snapshot).map(
        (context) => (context === "CodeQL" ? value : context),
      );
      expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
        "$.required_status_checks.contexts:missing:CodeQL",
        `$.required_status_checks.contexts:unexpected:${label}`,
      ]);
    },
  );

  it("rejects a non-object required_status_checks value", () => {
    const snapshot: JsonObject = cloneSnapshot();
    snapshot.required_status_checks = "invalid";
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks.strict:value-mismatch",
      "$.required_status_checks.contexts:not-an-array",
    ]);
  });

  it("rejects a required_status_checks object missing contexts", () => {
    const snapshot = cloneSnapshot();
    Reflect.deleteProperty(snapshot.required_status_checks, "contexts");
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks.contexts:not-an-array",
    ]);
  });

  it("rejects an empty contexts array with all nine sorted missing codes", () => {
    const snapshot = cloneSnapshot();
    snapshot.required_status_checks.contexts = [];
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual(
      [...REQUIRED_STATUS_CONTEXTS]
        .sort()
        .map(
          (context) =>
            `$.required_status_checks.contexts:missing:${context}`,
        ),
    );
  });

  it.each([null, [], "string", 42])(
    "N23 rejects a non-plain input: %j",
    (input) => {
      expect(verifyBranchProtectionContract(input).violations).toEqual([
        "input:not-a-plain-object",
      ]);
    },
  );

  it.each(["", "not JSON"])(
    "N23 maps malformed CLI input to exit 2: %j",
    (input) => {
      const result = runCli(input);
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "BRANCH-PROTECTION-CONTRACT: MALFORMED-INPUT\n",
      );
    },
  );

  it("rejects CLI argv instead of treating it as a file path", () => {
    const result = runCli(JSON.stringify(LIVE_SNAPSHOT), ["payload.json"]);
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "BRANCH-PROTECTION-CONTRACT: USAGE (read JSON from stdin)\n",
    );
  });

  it("N24 rejects boolean type coercion", () => {
    const snapshot = cloneSnapshot();
    setEnabled(snapshot, "enforce_admins", "true");
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.enforce_admins.enabled:value-mismatch",
    ]);
  });

  it.each(["codeql", "CodeQL "])(
    "N25 byte-compares context spelling: %j",
    (variant) => {
      const snapshot = cloneSnapshot();
      snapshot.required_status_checks.contexts = contextsOf(snapshot).map(
        (context) => (context === "CodeQL" ? variant : context),
      );
      expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
        "$.required_status_checks.contexts:missing:CodeQL",
        `$.required_status_checks.contexts:unexpected:${variant}`,
      ]);
    },
  );

  it("ignores only the observed nested locator keys", () => {
    const allowed = cloneSnapshot();
    allowed.enforce_admins.url = 17;
    allowed.required_status_checks.contexts_url = "changed locator";
    expect(verifyBranchProtectionContract(allowed).violations).toEqual([]);
  });

  it("L1 rejects contexts_url on a URL-bearing boolean wrapper", () => {
    const snapshot = cloneSnapshot();
    snapshot.enforce_admins.contexts_url = "x";
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.enforce_admins.contexts_url:value-mismatch",
    ]);
  });

  it("L2 rejects url on a required-check entry", () => {
    const snapshot = cloneSnapshot();
    checksOf(snapshot)[0]!.url = "x";
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks.checks[0].url:value-mismatch",
    ]);
  });

  it("L3 rejects contexts_url on a required-check entry", () => {
    const snapshot = cloneSnapshot();
    checksOf(snapshot)[0]!.contexts_url = "x";
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks.checks[0].contexts_url:value-mismatch",
    ]);
  });

  it.each(["lock_branch", "required_conversation_resolution"] as const)(
    "L4 rejects url on non-URL-bearing wrapper %s",
    (key) => {
      const snapshot = cloneSnapshot();
      snapshot[key].url = "x";
      expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
        `$.${key}.url:value-mismatch`,
      ]);
    },
  );

  it("L5 leaves required_signatures.url value unpinned", () => {
    const snapshot = cloneSnapshot();
    snapshot.required_signatures.url = { arbitrary: "value" };
    expect(verifyBranchProtectionContract(snapshot)).toEqual({
      ok: true,
      violations: [],
    });
  });

  it("L6 leaves enforce_admins.url optional", () => {
    const snapshot = cloneSnapshot();
    Reflect.deleteProperty(snapshot.enforce_admins, "url");
    expect(verifyBranchProtectionContract(snapshot)).toEqual({
      ok: true,
      violations: [],
    });
  });

  it("rejects an unobserved URL-suffixed key on a boolean wrapper", () => {
    const snapshot = cloneSnapshot();
    snapshot.enforce_admins.future_permission_url = false;
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.enforce_admins.future_permission_url:value-mismatch",
    ]);
  });

  it("rejects an unobserved URL-suffixed key on required status checks", () => {
    const snapshot = cloneSnapshot();
    snapshot.required_status_checks.future_permission_url = false;
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks.future_permission_url:value-mismatch",
    ]);
  });

  it("rejects other unknown nested keys", () => {
    const unknown = cloneSnapshot();
    unknown.enforce_admins.new_setting = false;
    expect(verifyBranchProtectionContract(unknown).violations).toEqual([
      "$.enforce_admins.new_setting:value-mismatch",
    ]);
  });

  it("rejects a null required-check provider app ID", () => {
    const snapshot = cloneSnapshot();
    const context = "Lint, typecheck, unit tests";
    checksOf(snapshot)[0]!.app_id = null;
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      `$.required_status_checks.checks:app-id-mismatch:${context}`,
    ]);
  });

  it("rejects a wrong required-check provider app ID", () => {
    const snapshot = cloneSnapshot();
    const context = "Playwright smoke";
    checksOf(snapshot)[1]!.app_id = 99999;
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      `$.required_status_checks.checks:app-id-mismatch:${context}`,
    ]);
  });

  it("rejects an absent required-check provider app ID", () => {
    const snapshot = cloneSnapshot();
    const context = "Snowflake migrations (offline)";
    Reflect.deleteProperty(checksOf(snapshot)[2]!, "app_id");
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      `$.required_status_checks.checks:app-id-mismatch:${context}`,
    ]);
  });

  it("rejects CodeQL rebound to the Actions provider app ID", () => {
    const snapshot = cloneSnapshot();
    checksOf(snapshot)[3]!.app_id = 15368;
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks.checks:app-id-mismatch:CodeQL",
    ]);
  });

  it("sorts multiple provider app-ID mismatch codes by context", () => {
    const snapshot = cloneSnapshot();
    checksOf(snapshot)[1]!.app_id = 99999;
    checksOf(snapshot)[3]!.app_id = 15368;
    expect(verifyBranchProtectionContract(snapshot).violations).toEqual([
      "$.required_status_checks.checks:app-id-mismatch:CodeQL",
      "$.required_status_checks.checks:app-id-mismatch:Playwright smoke",
    ]);
  });
});

describe("branch-protection runbook contract", () => {
  const runbook = readFileSync(RUNBOOK_PATH, "utf8");
  const surfaceA = sectionBetween(
    runbook,
    "### Applied-head roster re-validation (#238 decided path)",
    "The following ordered items are the fail-safe activation path",
  );
  const surfaceB = sectionBetween(
    runbook,
    "The following ordered items are the fail-safe activation path",
    "Unpausing `FACTORY_PAUSED` remains a separate operator decision",
  );

  it("P1 pins the trusted comparator load at all four operator reads", () => {
    const step3 = sectionBetween(
      surfaceA,
      "3. As the first action",
      "4. A stale-notice",
    );
    const step6 = sectionAfter(surfaceA, "6. After all required checks");
    const item4 = sectionBetween(
      surfaceB,
      "4. Before enabling task mutation",
      "5. Only after",
    );
    const item5 = sectionAfter(surfaceB, "5. Only after");

    for (const region of [step3, step6, item4, item5]) {
      expect(bashBlocks(region)).toContain(TRUSTED_COMPARATOR_BLOCK);
    }
    expect(normalizeProse(item5)).toContain(
      "Also re-run the item-4 comparator immediately before the write",
    );
    const finalHeadBaseRead =
      "`gh pr view <n> --json headRefOid,baseRefName`";
    const step6ComparatorLoad =
      'gh api "repos/syamaner/roastpilot-cloud/contents/scripts/factory/branch-protection-contract.mts?ref=main"';
    expect(step6.indexOf(step6ComparatorLoad)).toBeGreaterThanOrEqual(0);
    expect(step6.lastIndexOf(finalHeadBaseRead)).toBeGreaterThan(
      step6.indexOf(step6ComparatorLoad),
    );
    expect(normalizeProse(step6)).toContain(
      "After that comparator block passes, as the last read before declaring re-validation complete, immediately re-read `headRefOid` and `baseRefName` with `gh pr view <n> --json headRefOid,baseRefName`",
    );
  });

  it("P2 keeps the runbook context listing set-equal to the canonical pin", () => {
    const listing = sectionBetween(
      surfaceA,
      "<!-- branch-protection-required-contexts:start -->",
      "<!-- branch-protection-required-contexts:end -->",
    );
    const listedContexts = [...listing.matchAll(/^- `(.+)`$/gm)].map(
      (match) => match[1]!,
    );
    expect(listedContexts).toHaveLength(REQUIRED_STATUS_CONTEXTS.length);
    expect(new Set(listedContexts)).toEqual(new Set(REQUIRED_STATUS_CONTEXTS));
  });

  it("P3 carries the fail-closed rule on both operator surfaces", () => {
    const normalizedA = normalizeProse(surfaceA);
    const normalizedB = normalizeProse(surfaceB);
    expect(normalizedA).toContain(
      "Comparator-load failure, default-branch drift, or any output other than the `BRANCH-PROTECTION-CONTRACT: OK` line with exit 0 means the applied head is not gated: do not merge",
    );
    expect(normalizedB).toContain(
      "Comparator-load failure, default-branch drift, or any output other than the `BRANCH-PROTECTION-CONTRACT: OK` line with exit 0 blocks enabling task mutation; do not proceed to item 5 until the default branch is restored to `main`, branch protection is restored to the pinned contract, and both the identity assertion and comparator pass",
    );
  });

  it("P4 records dependency-review as required and codecov/patch as operator-verified", () => {
    const normalizedA = normalizeProse(surfaceA);
    const normalizedB = normalizeProse(surfaceB);
    expect(normalizedA).toContain(
      "Dependency review is branch-protection-required; only `codecov/patch` is an operator-verified gate.",
    );
    expect(normalizedA).toContain(
      "branch protection mechanically gates CI, CodeQL, dependency review, and mutation testing",
    );
    expect(normalizedB).toContain(
      "required status checks (CI, CodeQL, dependency review, and mutation)",
    );
    expect(surfaceA).not.toContain(
      "Dependency review and `codecov/patch` are operator-verified",
    );
    expect(surfaceA).not.toContain(
      "even though branch protection does not mechanically stop it",
    );
  });

  it("P5 pins the hardened comparator at the task-mutation unpause boundary", () => {
    const unpauseBoundary = sectionBetween(
      runbook,
      "Task-mutation unpause boundary:",
      "Unpausing `FACTORY_PAUSED` remains a separate operator decision",
    );
    expect(bashBlocks(unpauseBoundary)).toContain(TRUSTED_COMPARATOR_BLOCK);
    expect(normalizeProse(unpauseBoundary)).toContain(
      "Comparator-load failure, default-branch drift, or comparator drift aborts the unpause until the default branch is restored to `main`, branch protection is restored to the pinned contract, and the hardened block passes",
    );
    expect(normalizeProse(unpauseBoundary)).toContain(
      "operator-procedure defense in depth; it is not a mechanical guarantee against a truly concurrent admin actor",
    );
  });
});
