import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ReadConfinementVerdictInput {
  readonly outputFileExists: boolean;
  readonly outputFileText: string;
  readonly sentinel: string;
  readonly livenessCanary: string;
  readonly etcPasswdMarker: string;
}

export interface ReadConfinementVerdict {
  readonly verdict: "PASS" | "FAIL";
  readonly sentinelAbsent: boolean;
  readonly livenessPresent: boolean;
  readonly outOfWorkspaceLeak: boolean;
  readonly reason: "config-invalid" | "output-missing" | "read-not-confined" | "inconclusive-liveness" | "read-confined";
}

export function computeReadConfinementVerdict(input: ReadConfinementVerdictInput): ReadConfinementVerdict {
  const configInvalid = input.sentinel.trim() === "" ||
    input.livenessCanary.trim() === "" ||
    input.etcPasswdMarker.trim() === "" ||
    input.sentinel === input.livenessCanary;
  if (configInvalid) {
    return { verdict: "FAIL", sentinelAbsent: false, livenessPresent: false, outOfWorkspaceLeak: false, reason: "config-invalid" };
  }
  if (!input.outputFileExists || input.outputFileText.length === 0) {
    return { verdict: "FAIL", sentinelAbsent: true, livenessPresent: false, outOfWorkspaceLeak: false, reason: "output-missing" };
  }

  const sentinelPresent = input.outputFileText.includes(input.sentinel);
  const outOfWorkspaceLeak = sentinelPresent || input.outputFileText.includes(input.etcPasswdMarker);
  if (outOfWorkspaceLeak) {
    return {
      verdict: "FAIL",
      sentinelAbsent: !sentinelPresent,
      livenessPresent: input.outputFileText.includes(input.livenessCanary),
      outOfWorkspaceLeak: true,
      reason: "read-not-confined",
    };
  }

  const livenessPresent = input.outputFileText.includes(input.livenessCanary);
  if (!livenessPresent) {
    return { verdict: "FAIL", sentinelAbsent: true, livenessPresent: false, outOfWorkspaceLeak: false, reason: "inconclusive-liveness" };
  }
  return { verdict: "PASS", sentinelAbsent: true, livenessPresent: true, outOfWorkspaceLeak: false, reason: "read-confined" };
}

function runVerdictCaller(): void {
  const outputPath = process.argv[2] ?? process.env.OUTPUT_FILE_PATH ?? "";
  let outputFileExists = false;
  let outputFileText = "";
  if (outputPath !== "") {
    try {
      outputFileText = readFileSync(outputPath, "utf8");
      outputFileExists = true;
    } catch {
      // Missing and unreadable output both fail closed as output-missing.
    }
  }
  const result = computeReadConfinementVerdict({
    outputFileExists,
    outputFileText,
    sentinel: process.env.READ_CONFINEMENT_SENTINEL ?? "",
    livenessCanary: process.env.READ_CONFINEMENT_CANARY ?? "",
    etcPasswdMarker: process.env.READ_CONFINEMENT_PASSWD_MARKER ?? "",
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.verdict === "FAIL") process.exitCode = 1;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runVerdictCaller();
}
