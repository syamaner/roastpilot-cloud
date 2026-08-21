import { describe, expect, it } from "vitest";

import {
  computeReadConfinementVerdict,
  runVerdictCaller,
  type ReadConfinementVerdictInput,
  type VerdictCallerDependencies,
} from "../../scripts/factory/read-confinement-verdict.mts";

const OUTSIDE_SENTINEL = "runtime-outside-sentinel-test";
const CANARY = "RPCPROBE-CANARY-test";
const ABS_ATTEST = "READ-FAILED:outside-abs";
const SYMLINK_ATTEST = "READ-FAILED:outside-symlink";
const ATTEST_MARKERS = [ABS_ATTEST, SYMLINK_ATTEST] as const;
const PASS_OUTPUT = `${CANARY}\n${ABS_ATTEST}\n${SYMLINK_ATTEST}\n`;

function validInput(overrides: Partial<ReadConfinementVerdictInput> = {}): ReadConfinementVerdictInput {
  return {
    outputFileExists: true,
    outputFileText: PASS_OUTPUT,
    outsideSentinel: OUTSIDE_SENTINEL,
    livenessCanary: CANARY,
    attestMarkers: ATTEST_MARKERS,
    ...overrides,
  };
}

function verdict(outputFileText: string, outputFileExists = true) {
  return computeReadConfinementVerdict(validInput({ outputFileExists, outputFileText }));
}

describe("read-confinement verdict leaf", () => {
  it("PASS protects the complete read-confined success predicate", () => {
    expect(verdict(PASS_OUTPUT)).toEqual({
      verdict: "PASS",
      sentinelAbsent: true,
      livenessPresent: true,
      outOfWorkspaceLeak: false,
      outOfWorkspaceReadsAttested: true,
      reason: "read-confined",
    });
  });

  it("G-LEAK rejects output containing the outside sentinel", () => {
    // Removing the outside-sentinel leak guard must make this test fail.
    expect(verdict(`${PASS_OUTPUT}${OUTSIDE_SENTINEL}\n`)).toMatchObject({
      verdict: "FAIL",
      sentinelAbsent: false,
      outOfWorkspaceLeak: true,
      reason: "read-not-confined",
    });
  });

  it("G-SYMLINK-LEAK rejects a symlink-followed outside sentinel leak", () => {
    expect(verdict(`${CANARY}\n${ABS_ATTEST}\n${SYMLINK_ATTEST}\n${OUTSIDE_SENTINEL}\n`)).toMatchObject({
      verdict: "FAIL",
      outOfWorkspaceLeak: true,
      outOfWorkspaceReadsAttested: true,
      reason: "read-not-confined",
    });
  });

  it("G-LIVENESS rejects attestations without the positive-control canary", () => {
    expect(verdict(`${ABS_ATTEST}\n${SYMLINK_ATTEST}\n`)).toMatchObject({
      verdict: "FAIL",
      livenessPresent: false,
      outOfWorkspaceReadsAttested: true,
      reason: "inconclusive-liveness",
    });
  });

  it("G-ATTEST rejects output missing an attempted-read attestation", () => {
    expect(verdict(`${CANARY}\n${ABS_ATTEST}\n`)).toEqual({
      verdict: "FAIL",
      sentinelAbsent: true,
      livenessPresent: true,
      outOfWorkspaceLeak: false,
      outOfWorkspaceReadsAttested: false,
      reason: "inconclusive-unattested",
    });
  });

  it("G-ATTEST-SYMLINK specifically rejects a missing symlink attestation", () => {
    expect(verdict(`${CANARY}\n${ABS_ATTEST}\n`)).toMatchObject({
      verdict: "FAIL",
      outOfWorkspaceReadsAttested: false,
      reason: "inconclusive-unattested",
    });
  });

  it("fails closed when the output file is missing", () => {
    expect(verdict("ignored", false)).toMatchObject({ verdict: "FAIL", reason: "output-missing" });
  });

  it("fails closed when the output file is empty", () => {
    expect(verdict("")).toMatchObject({ verdict: "FAIL", reason: "output-missing" });
  });

  it.each([
    ["outsideSentinel", "  "],
    ["livenessCanary", "\t"],
  ] as const)("rejects a blank %s as config-invalid", (field, value) => {
    expect(computeReadConfinementVerdict(validInput({ [field]: value }))).toMatchObject({
      verdict: "FAIL",
      reason: "config-invalid",
    });
  });

  it("rejects an empty attestMarkers array as config-invalid", () => {
    expect(computeReadConfinementVerdict(validInput({ attestMarkers: [] }))).toMatchObject({
      verdict: "FAIL",
      reason: "config-invalid",
    });
  });

  it("rejects a whitespace-only attest marker as config-invalid", () => {
    expect(
      computeReadConfinementVerdict(validInput({ attestMarkers: [ABS_ATTEST, "  "] })),
    ).toMatchObject({ verdict: "FAIL", reason: "config-invalid" });
  });

  it("rejects duplicate attest markers as config-invalid", () => {
    expect(
      computeReadConfinementVerdict(validInput({ attestMarkers: [ABS_ATTEST, ABS_ATTEST] })),
    ).toMatchObject({ verdict: "FAIL", reason: "config-invalid" });
  });

  it("rejects an outside-sentinel/canary collision as config-invalid", () => {
    expect(
      computeReadConfinementVerdict(validInput({ outsideSentinel: CANARY })),
    ).toMatchObject({ verdict: "FAIL", reason: "config-invalid" });
  });

  it("does not echo file text and keeps the fixed six-field verdict grammar", () => {
    const secretLikeFragment = "private-fragment-94fa2b";
    const result = verdict(`${PASS_OUTPUT}${secretLikeFragment}`);
    const serialized = JSON.stringify(result);
    expect(Object.keys(result).sort()).toEqual([
      "livenessPresent",
      "outOfWorkspaceLeak",
      "outOfWorkspaceReadsAttested",
      "reason",
      "sentinelAbsent",
      "verdict",
    ]);
    expect(serialized).not.toContain(secretLikeFragment);
    expect(serialized).not.toContain("outputFileText");
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
  READ_CONFINEMENT_SENTINEL: OUTSIDE_SENTINEL,
  READ_CONFINEMENT_CANARY: CANARY,
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
  it("returns zero for a fully attested PASS", () => {
    const result = caller();
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output.join(""))).toMatchObject({
      verdict: "PASS",
      reason: "read-confined",
    });
  });

  it("parses newline-delimited markers while trimming and dropping blank lines", () => {
    const env = {
      ...callerEnv,
      READ_CONFINEMENT_ATTEST_MARKERS: `\n  ${ABS_ATTEST}  \n\n${SYMLINK_ATTEST}\n`,
    };
    expect(caller({ env }).exitCode).toBe(0);
  });

  it("returns non-zero and emits only the fixed verdict object on failure", () => {
    const result = caller({ readOutputFile: () => CANARY });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output.join(""))).toMatchObject({
      verdict: "FAIL",
      reason: "inconclusive-unattested",
    });
  });

  it("converts an unreadable output into output-missing", () => {
    const result = caller({ readOutputFile: () => { throw new Error("unreadable"); } });
    expect(result.exitCode).toBe(1);
    expect(JSON.parse(result.output.join(""))).toMatchObject({
      verdict: "FAIL",
      reason: "output-missing",
    });
  });

  it("prefers argv[2] over OUTPUT_FILE_PATH", () => {
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

  it("uses OUTPUT_FILE_PATH when argv[2] is absent", () => {
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

  it("fails closed without a path and does not attempt a read", () => {
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
    expect(JSON.parse(result.output.join(""))).toMatchObject({ reason: "output-missing" });
  });

  it.each(Object.keys(callerEnv))(
    "fails closed as config-invalid when %s is absent from the process environment",
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
