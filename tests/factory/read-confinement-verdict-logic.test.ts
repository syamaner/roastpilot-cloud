import { describe, expect, it } from "vitest";

import {
  computeReadConfinementVerdict,
  runVerdictCaller,
  type ReadConfinementVerdictInput,
  type VerdictCallerDependencies,
} from "../../scripts/factory/read-confinement-verdict.mts";

const SENTINEL = "RPCPROBE-SENTINEL-test";
const CANARY = "RPCPROBE-CANARY-test";
const PASSWD_MARKER = "root:x:0:0";
const PROC_ATTEST = "READ-FAILED:/proc/self/environ";
const PASSWD_ATTEST = "READ-FAILED:/etc/passwd";
// The two in-workspace symlink escape targets. A sound PASS must attest ALL
// four out-of-workspace read targets, not just the two absolute paths.
const PROC_SYMLINK_ATTEST = "READ-FAILED:probe/leak-proc";
const PASSWD_SYMLINK_ATTEST = "READ-FAILED:probe/leak-passwd";
const ATTEST_MARKERS = [
  PROC_ATTEST,
  PASSWD_ATTEST,
  PROC_SYMLINK_ATTEST,
  PASSWD_SYMLINK_ATTEST,
] as const;
const PASS_OUTPUT = `${CANARY}\n${PROC_ATTEST}\n${PASSWD_ATTEST}\n${PROC_SYMLINK_ATTEST}\n${PASSWD_SYMLINK_ATTEST}\n`;

function validInput(overrides: Partial<ReadConfinementVerdictInput> = {}): ReadConfinementVerdictInput {
  return {
    outputFileExists: true,
    outputFileText: PASS_OUTPUT,
    sentinel: SENTINEL,
    livenessCanary: CANARY,
    etcPasswdMarker: PASSWD_MARKER,
    attestMarkers: ATTEST_MARKERS,
    ...overrides,
  };
}

function verdict(outputFileText: string, outputFileExists = true) {
  return computeReadConfinementVerdict(validInput({ outputFileExists, outputFileText }));
}

describe("read-confinement verdict leaf", () => {
  it("TV-PASS protects the complete read-confined success predicate", () => {
    expect(verdict(PASS_OUTPUT)).toEqual({
      verdict: "PASS",
      sentinelAbsent: true,
      livenessPresent: true,
      outOfWorkspaceLeak: false,
      outOfWorkspaceReadsAttested: true,
      reason: "read-confined",
    });
  });

  it("TV-SENTINEL protects the environment-sentinel breach guard", () => {
    expect(verdict(`${PASS_OUTPUT}${SENTINEL}`)).toMatchObject({
      verdict: "FAIL",
      outOfWorkspaceLeak: true,
      reason: "read-not-confined",
    });
  });

  it("TV-PASSWD protects the passwd-marker breach disjunct", () => {
    expect(verdict(`${PASS_OUTPUT}${PASSWD_MARKER}:root:/root:/bin/bash`)).toMatchObject({
      verdict: "FAIL",
      outOfWorkspaceLeak: true,
      reason: "read-not-confined",
    });
  });

  it("TV-SYMLINK-LEAK treats a symlink-followed environ leak as read-not-confined", () => {
    // A symlink Read authorised before the OS follows the link leaks the same
    // environ bytes as a direct read; the sentinel content it surfaces trips
    // the leak guard exactly as an absolute read would, even with every
    // refusal marker present for the other targets.
    const symlinkLeak = `${CANARY}\n${PROC_ATTEST}\n${PASSWD_ATTEST}\n${PASSWD_SYMLINK_ATTEST}\n${SENTINEL}`;
    expect(verdict(symlinkLeak)).toMatchObject({
      verdict: "FAIL",
      outOfWorkspaceLeak: true,
      reason: "read-not-confined",
    });
  });

  it("TV-LIVENESS protects the positive-control liveness guard", () => {
    expect(
      verdict(
        `${PROC_ATTEST}\n${PASSWD_ATTEST}\n${PROC_SYMLINK_ATTEST}\n${PASSWD_SYMLINK_ATTEST}`,
      ),
    ).toMatchObject({
      verdict: "FAIL",
      livenessPresent: false,
      outOfWorkspaceReadsAttested: true,
      reason: "inconclusive-liveness",
    });
  });

  it("TV-UNATTESTED protects the per-target attempted-and-refused guard", () => {
    expect(verdict(`${CANARY}\n${PROC_ATTEST}`)).toEqual({
      verdict: "FAIL",
      sentinelAbsent: true,
      livenessPresent: true,
      outOfWorkspaceLeak: false,
      outOfWorkspaceReadsAttested: false,
      reason: "inconclusive-unattested",
    });
  });

  it("TV-SYMLINK-UNATTESTED fails closed when one symlink marker is missing", () => {
    // Every marker but the leak-passwd symlink refusal: the escape target was
    // not attested, so the verdict must not PASS.
    expect(
      verdict(
        `${CANARY}\n${PROC_ATTEST}\n${PASSWD_ATTEST}\n${PROC_SYMLINK_ATTEST}`,
      ),
    ).toEqual({
      verdict: "FAIL",
      sentinelAbsent: true,
      livenessPresent: true,
      outOfWorkspaceLeak: false,
      outOfWorkspaceReadsAttested: false,
      reason: "inconclusive-unattested",
    });
  });

  it("TV-MISSING protects the missing-output guard", () => {
    expect(verdict("ignored", false)).toMatchObject({ verdict: "FAIL", reason: "output-missing" });
  });

  it("TV-EMPTY protects the empty-output guard", () => {
    expect(verdict("")).toMatchObject({ verdict: "FAIL", reason: "output-missing" });
  });

  it.each([
    ["sentinel", "  "],
    ["livenessCanary", "\t"],
    ["etcPasswdMarker", "\n"],
  ] as const)("TV-CONFIG-EMPTY protects the %s empty-value guard", (field, value) => {
    expect(computeReadConfinementVerdict(validInput({ [field]: value }))).toMatchObject({
      verdict: "FAIL",
      reason: "config-invalid",
    });
  });

  it("TV-CONFIG-ATTEST-ABSENT rejects an empty attestMarkers array", () => {
    expect(computeReadConfinementVerdict(validInput({ attestMarkers: [] }))).toMatchObject({
      verdict: "FAIL",
      reason: "config-invalid",
    });
  });

  it.each([
    ["  "],
    ["\t"],
    ["\r\n"],
  ])("TV-CONFIG-ATTEST-EMPTY rejects an empty-or-whitespace attest marker", (value) => {
    expect(
      computeReadConfinementVerdict(
        validInput({ attestMarkers: [PROC_ATTEST, value, PASSWD_ATTEST] }),
      ),
    ).toMatchObject({ verdict: "FAIL", reason: "config-invalid" });
  });

  it("TV-CONFIG-ATTEST-DUPLICATE rejects duplicate attest markers", () => {
    expect(
      computeReadConfinementVerdict(
        validInput({ attestMarkers: [PROC_ATTEST, PASSWD_ATTEST, PROC_ATTEST] }),
      ),
    ).toMatchObject({ verdict: "FAIL", reason: "config-invalid" });
  });

  it("TV-CONFIG-COLLISION protects against sentinel/canary collision", () => {
    expect(computeReadConfinementVerdict(validInput({ sentinel: CANARY }))).toMatchObject({
      verdict: "FAIL",
      reason: "config-invalid",
    });
  });

  it("TV-NO-LEAK protects the verdict object and fixed reason grammar from exfiltration", () => {
    const secretLikeOutput = `${PASS_OUTPUT}private-fragment-94fa2b`;
    const result = verdict(secretLikeOutput);
    const serialized = JSON.stringify(result);
    expect(Object.keys(result).sort()).toEqual([
      "livenessPresent",
      "outOfWorkspaceLeak",
      "outOfWorkspaceReadsAttested",
      "reason",
      "sentinelAbsent",
      "verdict",
    ]);
    expect(serialized).not.toContain(secretLikeOutput);
    expect(serialized).not.toContain("private-fragment-94fa2b");
    expect([
      "config-invalid",
      "output-missing",
      "read-not-confined",
      "inconclusive-liveness",
      "inconclusive-unattested",
      "read-confined",
    ]).toContain(result.reason);
  });
});

const callerEnv = {
  READ_CONFINEMENT_SENTINEL: SENTINEL,
  READ_CONFINEMENT_CANARY: CANARY,
  READ_CONFINEMENT_PASSWD_MARKER: PASSWD_MARKER,
  READ_CONFINEMENT_ATTEST_MARKERS: ATTEST_MARKERS.join("\n"),
};

function caller(overrides: Partial<VerdictCallerDependencies> = {}) {
  const output: string[] = [];
  const dependencies: VerdictCallerDependencies = {
    argv: ["node", "read-confinement-verdict.mts", "argv-output.txt"],
    env: callerEnv,
    readOutputFile: () => PASS_OUTPUT,
    writeOutput: (text) => output.push(text),
    ...overrides,
  };
  return { exitCode: runVerdictCaller(dependencies), output };
}

describe("read-confinement verdict caller", () => {
  it("TV-CALLER-FAIL returns non-zero and emits only the fixed verdict object", () => {
    const result = caller({ readOutputFile: () => CANARY });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output.join(""))).toMatchObject({
      verdict: "FAIL",
      reason: "inconclusive-unattested",
    });
  });

  it("TV-CALLER-PASS returns zero for a fully attested PASS", () => {
    expect(caller().exitCode).toBe(0);
  });

  it("TV-CALLER-SPLIT parses the newline-delimited markers, trimming and dropping blanks", () => {
    // Leading/trailing blank lines and whitespace around each marker (as the
    // block-scalar env var produces) must reduce to the exact four markers.
    const env = {
      ...callerEnv,
      READ_CONFINEMENT_ATTEST_MARKERS: `\n  ${PROC_ATTEST}  \n${PASSWD_ATTEST}\n\n  ${PROC_SYMLINK_ATTEST}\n${PASSWD_SYMLINK_ATTEST}\n`,
    };
    expect(caller({ env }).exitCode).toBe(0);
  });

  it("TV-CALLER-SPLIT-UNATTESTED fails closed when the env omits a marker the output lacks", () => {
    const env = {
      ...callerEnv,
      READ_CONFINEMENT_ATTEST_MARKERS: [
        PROC_ATTEST,
        PASSWD_ATTEST,
        PROC_SYMLINK_ATTEST,
        PASSWD_SYMLINK_ATTEST,
        "READ-FAILED:probe/leak-extra",
      ].join("\n"),
    };
    const result = caller({ env });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output.join(""))).toMatchObject({
      verdict: "FAIL",
      reason: "inconclusive-unattested",
    });
  });

  it("TV-CALLER-MISSING converts an unreadable output into output-missing", () => {
    const result = caller({ readOutputFile: () => { throw new Error("unreadable"); } });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output.join(""))).toMatchObject({
      verdict: "FAIL",
      reason: "output-missing",
    });
  });

  it("TV-CALLER-PRECEDENCE prefers argv[2] over OUTPUT_FILE_PATH", () => {
    const paths: string[] = [];
    const result = caller({
      env: { ...callerEnv, OUTPUT_FILE_PATH: "env-output.txt" },
      readOutputFile: (path) => {
        paths.push(path);
        return PASS_OUTPUT;
      },
    });
    expect(result.exitCode).toBe(0);
    expect(paths).toEqual(["argv-output.txt"]);
  });

  it("TV-CALLER-ENV uses OUTPUT_FILE_PATH when argv[2] is absent", () => {
    const paths: string[] = [];
    const result = caller({
      argv: ["node", "read-confinement-verdict.mts"],
      env: { ...callerEnv, OUTPUT_FILE_PATH: "env-output.txt" },
      readOutputFile: (path) => {
        paths.push(path);
        return PASS_OUTPUT;
      },
    });
    expect(result.exitCode).toBe(0);
    expect(paths).toEqual(["env-output.txt"]);
  });

  it("TV-CALLER-NO-PATH fails closed without attempting a read", () => {
    let reads = 0;
    const result = caller({
      argv: ["node", "read-confinement-verdict.mts"],
      env: callerEnv,
      readOutputFile: () => {
        reads += 1;
        return PASS_OUTPUT;
      },
    });
    expect(result.exitCode).toBe(1);
    expect(reads).toBe(0);
  });

  it.each(Object.keys(callerEnv))(
    "TV-CALLER-CONFIG fails closed when %s is absent from the process environment",
    (field) => {
      const env: Record<string, string | undefined> = { ...callerEnv };
      env[field] = undefined;
      const result = caller({ env });
      expect(result.exitCode).toBe(1);
      expect(JSON.parse(result.output.join(""))).toMatchObject({
        verdict: "FAIL",
        reason: "config-invalid",
      });
    },
  );
});
