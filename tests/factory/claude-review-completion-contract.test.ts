import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

// These tests exercise the two `run:` steps issue #146 added to the
// `claude-review` job by executing their embedded bash directly, the way
// `triage-workflow-contract.test.ts` does for the triage workflow:
// `spawnSync("bash", ["-c", run])` against a controlled environment, a stub
// `gh` on PATH, and real `jq`/`awk`/`grep`. The workflow bash is deliberately
// NOT extracted into a separate script (the repo already tests
// workflow-embedded bash in place; extracting it was judged scope creep on
// the #146 contract).

const REVIEW_WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/claude-code-review.yml", import.meta.url),
);
const FIXTURE_DIR = fileURLToPath(new URL("./fixtures/", import.meta.url));

// The two real tracking comments this slice was built from, captured with
// `gh api repos/syamaner/roastpilot-cloud/issues/<n>/comments`. #150 is the
// truncated run (two of five boxes ticked, header "Code review in progress");
// #152 is the healthy control (every box ticked). Their `/actions/runs/<id>`
// links are the real run ids, so the run-id binding is exercised end to end.
const PR150_TRUNCATED = readFileSync(
  join(FIXTURE_DIR, "claude-review-tracking-comment-pr150-truncated.md"),
  "utf8",
);
const PR152_COMPLETE = readFileSync(
  join(FIXTURE_DIR, "claude-review-tracking-comment-pr152-complete.md"),
  "utf8",
);
const PR150_RUN_ID = "30304076291";
const PR152_RUN_ID = "30306271323";

// The execution-transcript fixture is schema-accurate rather than captured:
// claude-code-action's execution file is a single pretty-printed JSON array
// of SDK messages (base-action `writeExecutionFile()` ->
// `JSON.stringify(messages, null, 2)`, written to
// `${RUNNER_TEMP}/claude-execution-output.json`). The 4-denial shape mirrors
// PR #150's own run summary (`permission_denials_count: 4`). Provenance does
// not matter for the redaction/grammar logic; the file SHAPE does.
const TRANSCRIPT_4_DENIALS = fileURLToPath(
  new URL("./fixtures/claude-execution-output-4-denials.json", import.meta.url),
);

type Mapping = Record<string, unknown>;

function asMapping(value: unknown): Mapping | undefined {
  return typeof value === "object" && value !== null
    ? (value as Mapping)
    : undefined;
}

function reviewJobStepRun(stepName: string): string {
  const document = parseDocument(readFileSync(REVIEW_WORKFLOW_PATH, "utf8"));
  expect(document.errors).toEqual([]);
  const workflow = document.toJS() as Mapping;
  const job = asMapping(asMapping(workflow.jobs)?.["claude-review"]);
  const steps = job?.steps;
  if (!Array.isArray(steps)) {
    throw new Error("claude-review job has no steps");
  }
  const step = steps.find(
    (candidate) => asMapping(candidate)?.name === stepName,
  );
  if (!step) {
    throw new Error(`missing claude-review step: ${stepName}`);
  }
  return String(asMapping(step)?.run);
}

const STEP_A = "Surface the review run's own denial evidence";
const STEP_B = "Assert the review actually completed";

interface StepAResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly summary: string;
}

// Run step A with the transcript at `actionFile` (its `execution_file`
// output) and `fallbackFile` (the runner-temp fallback). Either may point at
// a non-existent path to exercise the missing-file and fallback branches.
function runStepA(options: {
  readonly actionFile: string;
  readonly fallbackFile?: string;
}): StepAResult {
  const run = reviewJobStepRun(STEP_A);
  const workdir = mkdtempSync(join(tmpdir(), "review-step-a-"));
  const summaryPath = join(workdir, "step-summary");
  try {
    writeFileSync(summaryPath, "");
    const result = spawnSync("bash", ["-c", run], {
      cwd: workdir,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        ACTION_EXECUTION_OUTPUT: options.actionFile,
        FALLBACK_EXECUTION_OUTPUT:
          options.fallbackFile ?? join(workdir, "no-fallback.json"),
        GITHUB_STEP_SUMMARY: summaryPath,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      summary: readFileSync(summaryPath, "utf8"),
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

// Write `value` to a temp JSON file (a raw string is written verbatim so a
// deliberately unparseable body can be tested) and run step A against it.
function runStepAWith(value: unknown): StepAResult {
  const workdir = mkdtempSync(join(tmpdir(), "review-step-a-input-"));
  const file = join(workdir, "execution-output.json");
  try {
    writeFileSync(
      file,
      typeof value === "string" ? value : JSON.stringify(value),
    );
    return runStepA({ actionFile: file });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

interface Comment {
  readonly login: string;
  readonly body: string;
}

interface StepBResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

// Run step B with a stub `gh` whose only job is to emit the slurped
// `--paginate --slurp` comment payload (an array of pages) that the step's jq
// consumes. `pages` is the array of pages; each page is an array of comments.
function runStepB(options: {
  readonly pages: readonly (readonly Comment[])[];
  readonly runId: string;
  readonly outcome?: string;
  readonly conclusion?: string;
  readonly ghFails?: boolean;
}): StepBResult {
  const run = reviewJobStepRun(STEP_B);
  const workdir = mkdtempSync(join(tmpdir(), "review-step-b-"));
  const bin = join(workdir, "bin");
  const ghPath = join(bin, "gh");
  const commentsPath = join(workdir, "comments.json");
  try {
    mkdirSync(bin);
    writeFileSync(
      commentsPath,
      JSON.stringify(
        options.pages.map((page) =>
          page.map((comment) => ({
            user: { login: comment.login },
            body: comment.body,
          })),
        ),
      ),
    );
    writeFileSync(
      ghPath,
      options.ghFails
        ? "#!/usr/bin/env bash\necho 'stub gh forced failure' >&2\nexit 1\n"
        : '#!/usr/bin/env bash\ncat "$COMMENTS_PATH"\n',
    );
    chmodSync(ghPath, 0o755);
    const result = spawnSync("bash", ["-c", run], {
      cwd: workdir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        COMMENTS_PATH: commentsPath,
        GH_TOKEN: "test-token",
        REPO: "syamaner/roastpilot-cloud",
        PR_NUMBER: "999",
        RUN_ID: options.runId,
        REVIEW_STEP_OUTCOME: options.outcome ?? "success",
        REVIEW_STEP_CONCLUSION: options.conclusion ?? "success",
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

function claudeComment(body: string): Comment {
  return { login: "claude[bot]", body };
}

// A tracking comment carrying this run's `/actions/runs/<id>` link plus a
// checklist. `ticked` controls whether every box is ticked. `header` is the
// heading line above the checklist.
function trackingComment(options: {
  readonly runId: string;
  readonly header?: string;
  readonly ticked: boolean;
  readonly login?: string;
}): Comment {
  const box = options.ticked ? "x" : " ";
  const body = [
    `**Claude finished** —— [View job](https://github.com/syamaner/roastpilot-cloud/actions/runs/${options.runId})`,
    "",
    "---",
    options.header ?? "### Code review",
    "",
    `- [${box}] Gather context`,
    `- [${box}] Post findings`,
  ].join("\n");
  return { login: options.login ?? "claude[bot]", body };
}

describe("claude-review denial-evidence step (step A)", () => {
  it("A-T1: emits denial counts and sorted-unique denied tool names, exit 0", () => {
    const result = runStepA({ actionFile: TRANSCRIPT_4_DENIALS });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("permission_denials_count: 4");
    // 4 denials, Bash twice -> 3 unique names, ASCII-sorted.
    expect(result.stdout).toContain(
      "denied tool names (3): Bash, WebFetch, mcp__github__get_pull_request",
    );
    expect(result.stdout).toContain("tool invocations seen (NOT necessarily denied): 4");
    // Guards the G6 slurp-shape fix: a single-array transcript must yield the
    // message schema, not "none". Reverting the `messages` normalisation makes
    // this line read "top-level keys: none" and fails here.
    expect(result.stdout).toMatch(/top-level keys:.*permission_denials/);
    expect(result.stdout).not.toContain("top-level keys: none");
    expect(result.summary).toContain("## Review run evidence");
    expect(result.summary).toContain("permission_denials_count: 4");
  });

  it("A-T2: no execution file -> note, never fails the job", () => {
    const result = runStepA({
      actionFile: join(tmpdir(), "definitely-absent-action.json"),
      fallbackFile: join(tmpdir(), "definitely-absent-fallback.json"),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no execution output at");
  });

  it("A-T3: empty action output var falls back to the runner-temp file", () => {
    const result = runStepA({
      actionFile: "",
      fallbackFile: TRANSCRIPT_4_DENIALS,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("permission_denials_count: 4");
  });

  it("A-T4: unparseable JSON -> note, exit 0, and no byte of file content leaks", () => {
    const result = runStepAWith(
      'not json at all { LEAK_MARKER_SENSITIVE_XYZ "ghp_UNPARSEABLE111122223333"',
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("not parseable JSON");
    expect(result.stdout).not.toContain("LEAK_MARKER_SENSITIVE_XYZ");
    expect(result.summary).not.toContain("LEAK_MARKER_SENSITIVE_XYZ");
    expect(result.stdout).not.toContain("ghp_UNPARSEABLE");
  });

  it("A-T5: sensitive-looking and malformed top-level keys are redacted", () => {
    const result = runStepAWith([
      {
        type: "result",
        MY_SECRET_TOKEN: "value",
        "not a valid key": "value",
        normalkey: "value",
      },
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("[redacted unsafe key]");
    expect(result.stdout).not.toContain("MY_SECRET_TOKEN");
    expect(result.stdout).not.toContain("not a valid key");
    // A well-formed, non-sensitive key still passes through.
    expect(result.stdout).toContain("normalkey");
  });

  it("A-T6: over-long tool names are clamped and sensitive ones redacted", () => {
    const longName = "A".repeat(500);
    const result = runStepAWith([
      {
        type: "result",
        permission_denials: [
          { tool_name: longName },
          { tool_name: "my_token_helper" },
        ],
      },
    ]);
    expect(result.status, result.stderr).toBe(0);
    // Clamped to <= 200 chars: 200 As present, 201 As are not.
    expect(result.stdout).toContain("A".repeat(200));
    expect(result.stdout).not.toContain("A".repeat(201));
    // The sensitive survivor is redacted rather than printed.
    expect(result.stdout).toContain("[redacted sensitive-looking string]");
    expect(result.stdout).not.toContain("my_token_helper");
  });

  it("A-T7: evidence larger than 65536 bytes is clamped on both emissions", () => {
    const denials = Array.from({ length: 4000 }, (_, index) => ({
      tool_name: `denied_tool_name_${String(index).padStart(6, "0")}`,
    }));
    const result = runStepAWith([{ type: "result", permission_denials: denials }]);
    expect(result.status, result.stderr).toBe(0);
    // The un-clamped evidence would exceed 65536 bytes; both the public step
    // summary and stdout are head -c 65536 clamped. Allow one trailing
    // newline from the step's `echo ""`.
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(65537);
    // The clamp is real, not an artefact of short output: the highest-indexed
    // tool name lands past the cut and is absent.
    expect(result.stdout).not.toContain("denied_tool_name_003999");
    // The step summary body (after its header) is likewise clamped.
    const summaryBytes = Buffer.byteLength(result.summary, "utf8");
    expect(summaryBytes).toBeLessThanOrEqual(65536 + 64);
  });

  it("A-T8: bare tool invocations are counted as invocations, never denials", () => {
    const result = runStepAWith([
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", tool_name: "Bash" }] },
      },
      { type: "result", permission_denials_count: 0 },
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "denied tool names (0): no denial records found in this document",
    );
    expect(result.stdout).toContain("tool invocations seen (NOT necessarily denied): 1");
  });

  it("A-T9: planted credential VALUES never reach the closed emission grammar", () => {
    // The 4-denial fixture plants `ghp_...` in an assistant text value and
    // `sk-ant-...` in a tool_input value. The grammar emits only keys, numeric
    // counts, tool NAMES, and an invocation count -- never a `.value` -- so
    // neither planted secret can appear. Widening the grammar to emit any
    // value fails here.
    const result = runStepA({ actionFile: TRANSCRIPT_4_DENIALS });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("ghp_");
    expect(result.stdout).not.toContain("sk-ant-");
    expect(result.summary).not.toContain("ghp_");
    expect(result.summary).not.toContain("sk-ant-");
  });
});

describe("claude-review completion-assertion step (step B)", () => {
  it("B-T1: healthy #152 tracking comment on a successful run passes", () => {
    const result = runStepB({
      pages: [[claudeComment(PR152_COMPLETE)]],
      runId: PR152_RUN_ID,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      "confirmed: the review posted a tracking comment with no unfinished work",
    );
  });

  it("B-T2: truncated #150 tracking comment fails on unticked boxes", () => {
    const result = runStepB({
      pages: [[claudeComment(PR150_TRUNCATED)]],
      runId: PR150_RUN_ID,
    });
    expect(result.status).toBe(1);
    // GitHub workflow `::error::` commands are written to stdout.
    expect(result.stdout).toContain(
      "finished with unticked checklist items in its own tracking comment",
    );
  });

  it.each([
    ["failure/success", "failure", "success"],
    ["success/skipped", "success", "skipped"],
    ["skipped/skipped", "skipped", "skipped"],
  ])(
    "B-T3: %s outcome/conclusion fails before inspecting any comment",
    (_label, outcome, conclusion) => {
      const result = runStepB({
        pages: [[claudeComment(PR152_COMPLETE)]],
        runId: PR152_RUN_ID,
        outcome,
        conclusion,
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("did not genuinely run to success");
    },
  );

  it("B-T4: zero comments fails closed", () => {
    const result = runStepB({ pages: [[]], runId: PR152_RUN_ID });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("posted no tracking comment");
  });

  it("B-T5: a run-id that only prefix-matches the comment's run link is rejected", () => {
    // The comment links run 30304076291; RUN_ID is a 10-digit prefix of it.
    // The old substring `contains(...)` matched; the boundary-anchored `test`
    // must not.
    const prefixRunId = PR150_RUN_ID.slice(0, -1);
    const result = runStepB({
      pages: [[claudeComment(PR152_COMPLETE)]],
      runId: prefixRunId,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("posted no tracking comment");

    // A wholly different run id is likewise unbound.
    const other = runStepB({
      pages: [[claudeComment(PR152_COMPLETE)]],
      runId: "99999999999",
    });
    expect(other.status).toBe(1);
    expect(other.stdout).toContain("posted no tracking comment");
  });

  it("B-T6: a non-claude author cannot supply this run's completion evidence", () => {
    // mallory posts an otherwise-healthy comment carrying this run's link. The
    // author binding rejects it (no claude[bot] comment exists), so dropping
    // the author filter would let this spoof pass.
    const result = runStepB({
      pages: [
        [
          {
            login: "mallory",
            body: trackingComment({ runId: PR152_RUN_ID, ticked: true }).body,
          },
        ],
      ],
      runId: PR152_RUN_ID,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("posted no tracking comment");
  });

  it("B-T7: a matching comment with no checklist fails closed", () => {
    const body = [
      `**Claude finished** [View job](https://github.com/syamaner/roastpilot-cloud/actions/runs/${PR152_RUN_ID})`,
      "",
      "Some prose with no task list at all.",
    ].join("\n");
    const result = runStepB({
      pages: [[claudeComment(body)]],
      runId: PR152_RUN_ID,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("no tracking checklist");
  });

  it("B-T8: a fully-ticked checklist under an in-progress heading still fails", () => {
    const result = runStepB({
      pages: [
        [
          trackingComment({
            runId: PR152_RUN_ID,
            header: "### Code review in progress",
            ticked: true,
          }),
        ],
      ],
      runId: PR152_RUN_ID,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("still reports work in progress");
  });

  it("B-T9: only the first checklist block is scored, so a later unticked quote passes", () => {
    const body = [
      `**Claude finished** [View job](https://github.com/syamaner/roastpilot-cloud/actions/runs/${PR152_RUN_ID})`,
      "",
      "### Code review",
      "",
      "- [x] Gather context",
      "- [x] Post findings",
      "",
      "Findings: the acceptance criteria below are quoted verbatim:",
      "",
      "- [ ] a criterion the PR has not met yet",
    ].join("\n");
    const result = runStepB({
      pages: [[claudeComment(body)]],
      runId: PR152_RUN_ID,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("confirmed:");
  });

  it("B-T10: a non-zero gh keeps the pipeline fail-closed", () => {
    const result = runStepB({
      pages: [[claudeComment(PR152_COMPLETE)]],
      runId: PR152_RUN_ID,
      ghFails: true,
    });
    expect(result.status).not.toBe(0);
    // Under `set -euo pipefail` the failed `gh | jq` pipeline aborts the step
    // at the command substitution, before the empty-BODY guard runs. A `set
    // +e` regression instead swallows the failure, reaches that guard, and
    // prints "posted no tracking comment" -- so its ABSENCE is what proves the
    // strict-mode fail-closed is intact.
    expect(result.stdout).not.toContain("posted no tracking comment");
  });

  it("B-T11: the latest matching comment decides, not the first", () => {
    const truncated = trackingComment({
      runId: PR152_RUN_ID,
      header: "### Code review in progress",
      ticked: false,
    });
    const healthy = trackingComment({ runId: PR152_RUN_ID, ticked: true });

    // truncated then healthy: `last` is healthy -> pass. `first` would fail.
    const passes = runStepB({
      pages: [[truncated, healthy]],
      runId: PR152_RUN_ID,
    });
    expect(passes.status, `${passes.stdout}\n${passes.stderr}`).toBe(0);

    // healthy then truncated: `last` is truncated -> fail. `first` would pass.
    const fails = runStepB({
      pages: [[healthy, truncated]],
      runId: PR152_RUN_ID,
    });
    expect(fails.status).toBe(1);
  });
});
