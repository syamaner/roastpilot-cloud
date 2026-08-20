import { describe, expect, it } from "vitest";

import { computeReadConfinementVerdict } from "../../scripts/factory/read-confinement-verdict.mts";

const SENTINEL = "RPCPROBE-SENTINEL-test";
const CANARY = "RPCPROBE-CANARY-test";
const PASSWD_MARKER = "root:x:0:0";

function verdict(outputFileText: string, outputFileExists = true) {
  return computeReadConfinementVerdict({
    outputFileExists,
    outputFileText,
    sentinel: SENTINEL,
    livenessCanary: CANARY,
    etcPasswdMarker: PASSWD_MARKER,
  });
}

describe("read-confinement verdict leaf", () => {
  it("TV-PASS protects the complete read-confined success predicate", () => {
    expect(verdict(`${CANARY}\nREAD-FAILED: outside workspace`)).toEqual({
      verdict: "PASS",
      sentinelAbsent: true,
      livenessPresent: true,
      outOfWorkspaceLeak: false,
      reason: "read-confined",
    });
  });

  it("TV-SENTINEL protects the environment-sentinel breach guard", () => {
    expect(verdict(`${CANARY}\n${SENTINEL}`)).toMatchObject({
      verdict: "FAIL",
      outOfWorkspaceLeak: true,
      reason: "read-not-confined",
    });
  });

  it("TV-PASSWD protects the passwd-marker breach disjunct", () => {
    expect(verdict(`${CANARY}\n${PASSWD_MARKER}:root:/root:/bin/bash`)).toMatchObject({
      verdict: "FAIL",
      outOfWorkspaceLeak: true,
      reason: "read-not-confined",
    });
  });

  it("TV-LIVENESS protects the positive-control liveness guard", () => {
    expect(verdict("READ-FAILED: both reads")).toMatchObject({
      verdict: "FAIL",
      livenessPresent: false,
      reason: "inconclusive-liveness",
    });
  });

  it("TV-MISSING protects the missing-output guard", () => {
    expect(verdict("ignored", false)).toMatchObject({ verdict: "FAIL", reason: "output-missing" });
  });

  it("TV-EMPTY protects the empty-output guard", () => {
    expect(verdict("")).toMatchObject({ verdict: "FAIL", reason: "output-missing" });
  });

  it("TV-CONFIG-EMPTY protects against includes-empty-string fail-open behavior", () => {
    const result = computeReadConfinementVerdict({
      outputFileExists: true,
      outputFileText: CANARY,
      sentinel: "  ",
      livenessCanary: CANARY,
      etcPasswdMarker: PASSWD_MARKER,
    });
    expect(result).toMatchObject({ verdict: "FAIL", reason: "config-invalid" });
  });

  it("TV-CONFIG-COLLISION protects against sentinel/canary collision", () => {
    const result = computeReadConfinementVerdict({
      outputFileExists: true,
      outputFileText: CANARY,
      sentinel: CANARY,
      livenessCanary: CANARY,
      etcPasswdMarker: PASSWD_MARKER,
    });
    expect(result).toMatchObject({ verdict: "FAIL", reason: "config-invalid" });
  });

  it("TV-NO-LEAK protects the verdict object and fixed reason grammar from exfiltration", () => {
    const secretLikeOutput = `${CANARY}\nprivate-fragment-94fa2b`;
    const result = verdict(secretLikeOutput);
    const serialized = JSON.stringify(result);
    expect(Object.keys(result).sort()).toEqual([
      "livenessPresent",
      "outOfWorkspaceLeak",
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
      "read-confined",
    ]).toContain(result.reason);
  });
});
