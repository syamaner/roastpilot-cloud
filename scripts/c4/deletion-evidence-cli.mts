import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { isCommit, verifyDeletionEvidence, type Verdict } from "./deletion-evidence.mts";

const usage = "usage: deletion-evidence-cli --expected-cloud-commit <40-hex> --expected-plan-commit <40-hex> <evidence-file>\n";

export function runDeletionEvidenceCli(
  args: readonly string[],
  read: (path: string) => Uint8Array = readFileSync,
): { exit: number; stdout: string; stderr: string } {
  const [cloudFlag, cloud, planFlag, plan, file] = args;
  if (args.length !== 5 || cloudFlag !== "--expected-cloud-commit"
    || planFlag !== "--expected-plan-commit" || !isCommit(cloud) || !isCommit(plan)
    || !file) {
    return { exit: 2, stdout: "", stderr: usage };
  }

  let bytes: Uint8Array;
  try {
    bytes = read(file);
  } catch {
    return format({ verdict: "evidence_rejected", reason: "unreadable" });
  }
  return format(verifyDeletionEvidence(bytes, cloud, plan));
}

function format(verdict: Verdict) {
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
  const result = runDeletionEvidenceCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exit;
}
