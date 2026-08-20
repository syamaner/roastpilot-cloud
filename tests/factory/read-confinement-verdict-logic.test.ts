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
const PASS_OUTPUT = `${CANARY}\n${PROC_ATTEST}\n${PASSWD_ATTEST}\n`;

function validInput(overrides: Partial<ReadConfinementVerdictInput> = {}): ReadConfinementVerdictInput {
  return {
    outputFileExists: true,
    outputFileText: PASS_OUTPUT,
    sentinel: SENTINEL,
    livenessCanary: CANARY,
    etcPasswdMarker: PASSWD_MARKER,
    procAttestMarker: PROC_ATTEST,
    passwdAttestMarker: PASSWD_ATTEST,
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

  it("TV-LIVENESS protects the positive-control liveness guard", () => {
    expect(verdict(`${PROC_ATTEST}\n${PASSWD_ATTEST}`)).toMatchObject({
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
    ["procAttestMarker", " "],
    ["passwdAttestMarker", "\r\n"],
  ] as const)("TV-CONFIG-EMPTY protects the %s empty-value guard", (field, value) => {
    expect(computeReadConfinementVerdict(validInput({ [field]: value }))).toMatchObject({
      verdict: "FAIL",
      reason: "config-invalid",
    });
  });

  it("TV-CONFIG-COLLISION protects against sentinel/canary collision", () => {
    expect(computeReadConfinementVerdict(validInput({ sentinel: CANARY }))).toMatchObject({
      verdict: "FAIL",
      reason: "config-invalid",
    });
  });

  it("TV-CONFIG-ATTEST-COLLISION protects against target-attestation collision", () => {
    expect(computeReadConfinementVerdict(validInput({ passwdAttestMarker: PROC_ATTEST }))).toMatchObject({
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
  READ_CONFINEMENT_PROC_ATTEST_MARKER: PROC_ATTEST,
  READ_CONFINEMENT_PASSWD_ATTEST_MARKER: PASSWD_ATTEST,
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
