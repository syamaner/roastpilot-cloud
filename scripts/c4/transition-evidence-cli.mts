import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isCommit, isRef, verifyTransitionEvidence } from "./transition-evidence.mts";

const usage = "usage: transition-evidence-cli --expected-cloud-commit <40-hex> --expected-plan-commit <40-hex> --expected-scope <64-hex> --expected-fleet <64-hex> <evidence-file>\n";

export function runTransitionEvidenceCli(
  args: readonly string[],
  read: (path: string) => Uint8Array = readFileSync,
): { exit: number; stdout: string; stderr: string } {
  const [cloudFlag, cloud, planFlag, plan, scopeFlag, scope, fleetFlag, fleet, file] = args;
  if (args.length !== 9 || cloudFlag !== "--expected-cloud-commit" || planFlag !== "--expected-plan-commit"
    || scopeFlag !== "--expected-scope" || fleetFlag !== "--expected-fleet"
    || !isCommit(cloud) || !isCommit(plan) || !isRef(scope) || !isRef(fleet) || !file) {
    return { exit: 2, stdout: "", stderr: usage };
  }

  let bytes: Uint8Array;
  try {
    bytes = read(file);
  } catch {
    return { exit: 1, stdout: '{"verdict":"evidence_rejected","reason":"unreadable"}\n', stderr: "" };
  }
  const verdict = verifyTransitionEvidence(bytes, { cloud, plan, scope, fleet });
  return {
    exit: verdict.verdict === "evidence_structurally_complete" ? 0 : 1,
    stdout: JSON.stringify(verdict) + "\n",
    stderr: "",
  };
}

function isDirectEntry(argument: string | undefined): boolean {
  if (!argument) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argument);
  } catch {
    return false;
  }
}

if (isDirectEntry(process.argv[1])) {
  const result = runTransitionEvidenceCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exit;
}
