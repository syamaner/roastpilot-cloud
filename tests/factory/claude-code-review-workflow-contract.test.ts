import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

const WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/claude-code-review.yml", import.meta.url),
);

type Mapping = Record<string, unknown>;

function asMapping(value: unknown): Mapping {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected workflow mapping");
  }
  return value as Mapping;
}

function parseWorkflow(): Mapping {
  const document = parseDocument(readFileSync(WORKFLOW_PATH, "utf8"));
  expect(document.errors).toEqual([]);
  return document.toJS() as Mapping;
}

function jobIf(workflow: Mapping, jobName: string): string {
  const job = asMapping(asMapping(workflow.jobs)[jobName]);
  if (typeof job.if !== "string") {
    throw new Error(`${jobName} has no string if expression`);
  }
  return job.if;
}

function jobStep(workflow: Mapping, jobName: string, stepName: string): Mapping {
  const steps = asMapping(asMapping(workflow.jobs)[jobName]).steps;
  if (!Array.isArray(steps)) {
    throw new Error(`${jobName} has no steps array`);
  }
  const step = steps.find((candidate) => asMapping(candidate).name === stepName);
  if (!step) {
    throw new Error(`${jobName} has no "${stepName}" step`);
  }
  return asMapping(step);
}

describe("claude-code-review workflow edited-event contract", () => {
  it("T18 admits every spec-grounding edited dimension with the non-edited short-circuit", () => {
    const expression = jobIf(parseWorkflow(), "spec-grounded-review");
    expect(expression).toBe(
      "${{ (github.event.action != 'edited' || github.event.changes.body != null || " +
        "github.event.changes.base != null || github.event.changes.title != null) && " +
        "github.actor != 'dependabot[bot]' && github.event.pull_request.head.repo.full_name == " +
        "github.repository && github.event.pull_request.draft == false }}",
    );
  });

  it("T19 admits only base edits to claude-review, excluding title/body-only edits", () => {
    const expression = jobIf(parseWorkflow(), "claude-review");
    expect(expression).toBe(
      "${{ (github.event.action != 'edited' || github.event.changes.base != null) && " +
        "github.actor != 'dependabot[bot]' && github.event.pull_request.head.repo.full_name == " +
        "github.repository && github.event.pull_request.draft == false }}",
    );
    expect(expression).not.toContain("changes.body");
    expect(expression).not.toContain("changes.title");
  });

  it("T20 retains edited in the pull_request activity types", () => {
    const workflow = parseWorkflow();
    const pullRequest = asMapping(asMapping(workflow.on).pull_request);
    expect(pullRequest.types).toEqual([
      "opened",
      "synchronize",
      "ready_for_review",
      "reopened",
      "converted_to_draft",
      "edited",
    ]);
  });

  it("T21 requires and serializes reviewed-base-sha on the false outcome branch", () => {
    const step = jobStep(
      parseWorkflow(),
      "spec-grounded-review",
      "Write the outcome marker (self-describing artifact)",
    );
    expect(asMapping(step.env).REVIEWED_BASE_SHA).toBe(
      "${{ steps.runner.outputs.reviewed-base-sha }}",
    );
    expect(step.run).toContain('[ -n "$REVIEWED_BASE_SHA" ]');
    expect(step.run).toContain('--arg reviewedBaseSha "$REVIEWED_BASE_SHA"');
    expect(step.run).toContain("reviewedBaseSha: $reviewedBaseSha");
  });
});

describe("claude-review untrusted-comment-injection guard (issue #194)", () => {
  it("T22 binds include_comments_by_actor to the PR author, not a wildcard or a blank", () => {
    // Exact-string match, not a truthy/presence check (fsr-195 mutation M2:
    // swapping this input for an inert one of equal count, e.g.
    // `label_trigger: ""`, is otherwise invisible to every existing test --
    // the D140 drift counters in workflow-execution-surface-logic.test.ts
    // only pin cardinality, not which key it is or what it's bound to). This
    // assertion fails closed on removal (the key is absent -> undefined !==
    // the expected string), on rebinding to "" or "*" (still not the
    // expected string), and on rebinding to a different context expression.
    const step = jobStep(parseWorkflow(), "claude-review", "Run Claude Code Review");
    expect(asMapping(step.with).include_comments_by_actor).toBe(
      "${{ github.event.pull_request.user.login }}",
    );
  });

  it("T23 keeps track_progress true, the precondition that makes the T22 guard live at all", () => {
    // fsr-195 mutation M10: flipping track_progress to false is invisible to
    // T22 (the input count and binding are untouched) but makes
    // include_comments_by_actor completely inert -- detectMode() only forces
    // tag mode (which reads this input via fetchGitHubData) when
    // track_progress is truthy; false falls through to agent mode, which
    // never calls fetchGitHubData at all. A reader seeing T22 green would
    // otherwise reasonably assume the filter is live.
    const step = jobStep(parseWorkflow(), "claude-review", "Run Claude Code Review");
    expect(asMapping(step.with).track_progress).toBe(true);
  });
});
