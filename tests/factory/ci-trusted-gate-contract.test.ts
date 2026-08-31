import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const CI_PATH = fileURLToPath(
  new URL("../../.github/workflows/ci.yml", import.meta.url),
);
const REVIEW_PATH = fileURLToPath(
  new URL("../../.github/workflows/claude-code-review.yml", import.meta.url),
);
const RESOLVER_JOB = "resolve-trusted-revision";
const RESOLVER_STEP = "Resolve the trusted revision";
const CLASSIFY_STEP = "Classify pull-request change";
const CHECKS_STEP = "Require every CI job to match its change class";

const CLASSIFY_RUN = `set -euo pipefail
emit_full() { echo "mode=full" >> "$GITHUB_OUTPUT"; exit 0; }
[[ "$TRUSTED_SHA" =~ ^[0-9a-f]{40}$ ]] || emit_full
git fetch --depth 1 origin "$TRUSTED_SHA" || emit_full
if git cat-file -e "$TRUSTED_SHA:snowflake/ci_change_classifier.py" 2>/dev/null; then
  rm -rf -- snowflake/ci_change_classifier.py
  git checkout "$TRUSTED_SHA" -- snowflake/ci_change_classifier.py
  python3 -P snowflake/ci_change_classifier.py --event-name "$EVENT_NAME" --base-sha "$BASE_SHA" --head-sha "$HEAD_SHA"
else
  emit_full
fi
`;

const CHECKS_RUN = `set -euo pipefail
bootstrap_fallback() {
  [ "$MODE" = "full" ] || { echo "::error::bootstrap: require mode=full"; exit 1; }
  for r in "$R_GATES" "$R_CLASSIFY" "$R_PLAYWRIGHT" "$R_SNOWFLAKE" "$R_MUTATION"; do
    [ "$r" = "success" ] || { echo "::error::bootstrap: every heavy job must succeed"; exit 1; }
  done
  exit 0
}
[[ "$TRUSTED_SHA" =~ ^[0-9a-f]{40}$ ]] || bootstrap_fallback
git fetch --depth 1 origin "$TRUSTED_SHA" || bootstrap_fallback
if git cat-file -e "$TRUSTED_SHA:snowflake/ci_gate_result.py" 2>/dev/null; then
  rm -rf -- snowflake/ci_gate_result.py
  git checkout "$TRUSTED_SHA" -- snowflake/ci_gate_result.py
  python3 -P snowflake/ci_gate_result.py --always gates --always classify --always resolve-trusted-revision --full-only playwright --full-only snowflake-migrations --full-only mutation-testing
else
  bootstrap_fallback
fi
`;

type Mapping = Record<string, unknown>;

function asMapping(value: unknown): Mapping {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected mapping");
  }
  return value as Mapping;
}

function load(path: string): { source: string; workflow: Mapping } {
  const source = readFileSync(path, "utf8");
  const document = parseDocument(source);
  expect(document.errors).toEqual([]);
  return { source, workflow: document.toJS() as Mapping };
}

function job(workflow: Mapping, name: string): Mapping {
  return asMapping(asMapping(workflow.jobs)[name]);
}

function step(workflow: Mapping, jobName: string, stepName: string): Mapping {
  const rawSteps = job(workflow, jobName).steps;
  if (!Array.isArray(rawSteps)) throw new Error(`${jobName} has no steps`);
  const found = rawSteps.map(asMapping).find((candidate) => candidate.name === stepName);
  if (!found) throw new Error(`${jobName} has no ${stepName} step`);
  return found;
}

function runBody(workflow: Mapping, jobName: string, stepName: string): string {
  const run = step(workflow, jobName, stepName).run;
  if (typeof run !== "string") throw new Error(`${stepName} has no run body`);
  return run;
}

function needs(workflow: Mapping, jobName: string): string[] {
  const raw = job(workflow, jobName).needs;
  if (typeof raw === "string") return [raw];
  if (!Array.isArray(raw) || !raw.every((value) => typeof value === "string")) {
    throw new Error(`${jobName} has malformed needs`);
  }
  return raw;
}

function resolverBytes(source: string): string {
  const startMarker = "  resolve-trusted-revision:\n";
  const endMarker = '          } >> "$GITHUB_OUTPUT"\n';
  const start = source.indexOf(startMarker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end + endMarker.length);
}

function expectBashSyntax(run: string): void {
  const result = spawnSync("bash", ["-n"], { input: run, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
}

describe("CI trusted gate scripts", () => {
  const ci = load(CI_PATH);
  const review = load(REVIEW_PATH);

  it("ports the trusted-revision resolver without byte drift", () => {
    expect(resolverBytes(ci.source)).toBe(resolverBytes(review.source));
    expect(job(ci.workflow, RESOLVER_JOB)).toEqual(job(review.workflow, RESOLVER_JOB));
    expect(runBody(ci.workflow, RESOLVER_JOB, RESOLVER_STEP)).toBe(
      runBody(review.workflow, RESOLVER_JOB, RESOLVER_STEP),
    );
  });

  it("runs classification only after restoring the base-controlled script", () => {
    expect(needs(ci.workflow, "classify")).toContain(RESOLVER_JOB);
    const run = runBody(ci.workflow, "classify", CLASSIFY_STEP);
    expect(run).toBe(CLASSIFY_RUN);
    expect(run.match(/python3 -P snowflake\/ci_change_classifier\.py/g)).toHaveLength(1);
    const elseBranch = run.match(/else\n([\s\S]*?)\nfi\n$/)?.[1];
    expect(elseBranch).toBe("  emit_full");
    expect(elseBranch).not.toContain("ci_change_classifier.py");
    expect(run.indexOf("git checkout")).toBeLessThan(run.indexOf("python3 -P"));
  });

  it("runs the aggregate gate only after restore and otherwise bootstraps strictly", () => {
    expect(needs(ci.workflow, "checks")).toContain(RESOLVER_JOB);
    const run = runBody(ci.workflow, "checks", CHECKS_STEP);
    expect(run).toBe(CHECKS_RUN);
    expect(run.match(/python3 -P snowflake\/ci_gate_result\.py/g)).toHaveLength(1);
    const elseBranch = run.match(/else\n([\s\S]*?)\nfi\n$/)?.[1];
    expect(elseBranch).toBe("  bootstrap_fallback");
    expect(elseBranch).not.toContain("ci_gate_result.py");
    expect(run.indexOf("git checkout")).toBeLessThan(run.indexOf("python3 -P"));
  });

  it("runs every heavy job on failed classification unless the run is cancelled", () => {
    for (const jobName of [
      "playwright",
      "snowflake-migrations",
      "mutation-testing",
    ]) {
      expect(job(ci.workflow, jobName).if).toBe(
        "${{ !cancelled() && needs.classify.outputs.mode != 'docs-only' }}",
      );
    }
  });

  it("keeps every composed shell body syntactically valid Bash", () => {
    expectBashSyntax(runBody(ci.workflow, RESOLVER_JOB, RESOLVER_STEP));
    expectBashSyntax(runBody(ci.workflow, "classify", CLASSIFY_STEP));
    expectBashSyntax(runBody(ci.workflow, "checks", CHECKS_STEP));
  });
});
