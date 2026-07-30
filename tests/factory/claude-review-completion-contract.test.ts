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

// Issue #183. PR #182's re-review posted its tracking comment as PROSE (a
// `### Review summary` heading and plain `-` bullets, but NO task-list box),
// captured verbatim with `gh api ...issues/182/comments`. A prose body has no
// unticked box to catch a truncation, so it routes to the completion-sentinel
// branch. The truncated variant is a mid-paragraph PREFIX of that same body
// (derived, not separately captured) standing in for an interim update a run
// died after: same run id, same prose shape, no sentinel.
const PR182_PROSE = readFileSync(
  join(FIXTURE_DIR, "claude-review-tracking-comment-pr182-prose-resummary.md"),
  "utf8",
);
const PR182_PROSE_TRUNCATED = readFileSync(
  join(FIXTURE_DIR, "claude-review-tracking-comment-pr182-prose-truncated.md"),
  "utf8",
);
const PR182_RUN_ID = "30547564749";

// The #183 completion sentinel. This one JS literal is the single source of
// truth the tests compare against: C-T11 pins that the workflow's
// `--append-system-prompt` instruction AND the assertion grammar both carry
// exactly these bytes, so a drift in either the instruction or the grammar
// fails a test rather than silently shipping an inert instruction.
const SENTINEL =
  "REVIEW-COMPLETE: all code-review steps finished (claude-code-review completion sentinel, issue #183)";

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
  // GitHub's comment `updated_at`; step B rejects any comment last touched
  // before the current attempt started (the re-run freshness binding). Left
  // unset it defaults fresh, so the existing tests are unaffected.
  readonly updatedAt?: string;
}

interface StepBResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

// This attempt's start time and a default comment `updated_at` after it, so a
// comment with no explicit `updatedAt` reads as freshly written by the current
// attempt.
const DEFAULT_ATTEMPT_START = "2026-07-27T13:00:00Z";
const DEFAULT_COMMENT_UPDATED = "2026-07-27T13:30:00Z";

// Run step B with a stub `gh` that serves BOTH endpoints the step calls: the
// per-attempt `actions/runs/<id>/attempts/<n>` (emits `run_started_at`, the
// value `--jq '.run_started_at'` would extract) and the `--paginate --slurp`
// comments payload (an array of pages, each an array of comments).
function runStepB(options: {
  readonly pages: readonly (readonly Comment[])[];
  readonly runId: string;
  readonly outcome?: string;
  readonly conclusion?: string;
  // Fails the COMMENTS call only (the attempts call still succeeds), so this
  // exercises the strict-mode fail-closed of the `gh | jq` comment pipeline.
  readonly ghFails?: boolean;
  // Fails the ATTEMPTS call, exercising the per-attempt fetch's fail-closed.
  readonly attemptApiFails?: boolean;
  readonly attemptStartedAt?: string;
  readonly runAttempt?: string;
}): StepBResult {
  const run = reviewJobStepRun(STEP_B);
  const workdir = mkdtempSync(join(tmpdir(), "review-step-b-"));
  const bin = join(workdir, "bin");
  const ghPath = join(bin, "gh");
  const commentsPath = join(workdir, "comments.json");
  const attemptStartPath = join(workdir, "attempt-start");
  try {
    mkdirSync(bin);
    writeFileSync(
      commentsPath,
      JSON.stringify(
        options.pages.map((page) =>
          page.map((comment) => ({
            user: { login: comment.login },
            body: comment.body,
            updated_at: comment.updatedAt ?? DEFAULT_COMMENT_UPDATED,
          })),
        ),
      ),
    );
    writeFileSync(
      attemptStartPath,
      `${options.attemptStartedAt ?? DEFAULT_ATTEMPT_START}\n`,
    );
    // Route by URL: the attempts endpoint carries `/attempts/`; everything
    // else is the comments call.
    writeFileSync(
      ghPath,
      [
        "#!/usr/bin/env bash",
        "is_attempts=0",
        'for arg in "$@"; do case "$arg" in */attempts/*) is_attempts=1 ;; esac; done',
        'if [ "$is_attempts" -eq 1 ]; then',
        '  if [ -n "${ATTEMPT_API_FAILS:-}" ]; then echo "stub gh attempts failure" >&2; exit 1; fi',
        '  cat "$ATTEMPT_START_PATH"; exit 0',
        "fi",
        'if [ -n "${COMMENTS_FAIL:-}" ]; then echo "stub gh comments failure" >&2; exit 1; fi',
        'cat "$COMMENTS_PATH"',
        "",
      ].join("\n"),
    );
    chmodSync(ghPath, 0o755);
    const result = spawnSync("bash", ["-c", run], {
      cwd: workdir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        COMMENTS_PATH: commentsPath,
        ATTEMPT_START_PATH: attemptStartPath,
        ...(options.ghFails ? { COMMENTS_FAIL: "1" } : {}),
        ...(options.attemptApiFails ? { ATTEMPT_API_FAILS: "1" } : {}),
        GH_TOKEN: "test-token",
        REPO: "syamaner/roastpilot-cloud",
        PR_NUMBER: "999",
        RUN_ID: options.runId,
        RUN_ATTEMPT: options.runAttempt ?? "1",
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

function completionComment(body: string): Comment {
  // Since #157 the genuine tracking comment is authored by the job's own
  // GITHUB_TOKEN identity (github-actions[bot]), not the minted-App identity
  // (claude[bot]) that no longer exists in this job.
  return { login: "github-actions[bot]", body };
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
  // Defaults to the genuine post-#157 tracking-comment author, the job's own
  // GITHUB_TOKEN identity; `login` overrides it to exercise the author binding.
  return { login: options.login ?? "github-actions[bot]", body };
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

  it("A-T8: real tool_use invocations are counted; text/tool_result/denials are not (F3)", () => {
    // Schema-accurate: an invocation is a `tool_use` content block (keyed on
    // `name`), NOT an object with `tool_name` (which appears only on denial
    // records). Two tool_use blocks + a text block + a tool_result -> 2
    // invocations, and 0 denials (no permission_denials). The pre-F3
    // `has("tool_name")` count reported 0 here, masking the bug; the correct
    // `type == "tool_use"` count reports 2, so this test now pins the count.
    const result = runStepAWith([
      {
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "let me look" },
            { type: "tool_use", id: "tu_a", name: "Bash", input: { command: "ls" } },
            { type: "tool_use", id: "tu_b", name: "Read", input: { file: "x" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu_a", content: "ok" }],
        },
      },
      { type: "result", permission_denials_count: 0 },
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "denied tool names (0): no denial records found in this document",
    );
    expect(result.stdout).toContain("tool invocations seen (NOT necessarily denied): 2");
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

  it("A-T10: control and bidi characters in a tool_name are neutralised (fsr LOW-1)", () => {
    // A model-controlled tool_name reaches the PUBLIC step summary. A newline
    // would forge a markdown heading or a fake checklist row; a bidi override
    // reorders the displayed text. `safe_string` must reject both, matching
    // `safe_key`'s posture. String.fromCharCode keeps this source pure ASCII.
    const newline = String.fromCharCode(10);
    const bidiRlo = String.fromCharCode(0x202e);
    const evilName = `evilTool${newline}## injected heading${newline}- [x] done`;
    const bidiName = `mcp__evil__${bidiRlo}cc.exe`;
    const result = runStepAWith([
      {
        type: "result",
        permission_denials: [{ tool_name: evilName }, { tool_name: bidiName }],
      },
    ]);
    expect(result.status, result.stderr).toBe(0);
    // Redacted by the F4 allowlist (control/bidi bytes are outside the
    // tool-name grammar), reported as a non-conforming name.
    expect(result.stdout).toContain("[redacted non-conforming tool name]");
    // The newline no longer forges a heading or a checklist row, and the bidi
    // override is gone, on both stdout and the public step summary.
    expect(result.stdout).not.toContain("## injected heading");
    expect(result.stdout).not.toContain(bidiRlo);
    expect(result.summary).not.toContain("## injected heading");
    expect(result.summary).not.toContain(bidiRlo);
  });

  it("A-T11: bidi ISOLATES and the Arabic Letter Mark are also rejected (fsr LOW-3)", () => {
    // The newer half of the Trojan-Source set: bidi isolates LRI/RLI/FSI/PDI
    // (U+2066-U+2069) and the Arabic Letter Mark (U+061C). The F4 allowlist
    // covers them (as it covers every non-tool-name byte), not just the
    // overrides/embeddings A-T10 exercises.
    const lri = String.fromCharCode(0x2066);
    const alm = String.fromCharCode(0x061c);
    const isolateName = `mcp__evil__${lri}masked`;
    const almName = `arab${alm}mark`;
    const result = runStepAWith([
      {
        type: "result",
        permission_denials: [{ tool_name: isolateName }, { tool_name: almName }],
      },
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("[redacted non-conforming tool name]");
    expect(result.stdout).not.toContain(lri);
    expect(result.stdout).not.toContain(alm);
    expect(result.summary).not.toContain(lri);
    expect(result.summary).not.toContain(alm);
  });

  it("A-T12: the allowlist passes real names and redacts the whole Cf class (F4)", () => {
    // Positive allowlist (mirrors safe_key): only ^[A-Za-z0-9_-]{1,200}$
    // passes, so every invisible-format codepoint -- INCLUDING U+206A-206F,
    // which the growing \\uXXXX blacklist never covered -- is redacted, while
    // the four real denied names pass through. Reverting to any blacklist that
    // misses these reddens this test.
    const cfA = String.fromCharCode(0x206a);
    const cfB = String.fromCharCode(0x206c);
    const cfC = String.fromCharCode(0x206f);
    const result = runStepAWith([
      {
        type: "result",
        permission_denials: [
          { tool_name: `evil${cfA}${cfB}${cfC}name` },
          { tool_name: "Bash" },
          { tool_name: "WebFetch" },
          { tool_name: "mcp__github__get_pull_request" },
          { tool_name: "Read" },
        ],
      },
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("[redacted non-conforming tool name]");
    for (const cf of [cfA, cfB, cfC]) {
      expect(result.stdout).not.toContain(cf);
      expect(result.summary).not.toContain(cf);
    }
    for (const name of ["Bash", "WebFetch", "mcp__github__get_pull_request", "Read"]) {
      expect(result.stdout).toContain(name);
    }
  });

  it("A-T13: nested model content cannot fabricate the diagnostic (F5 schema-bind)", () => {
    // Counts/denied-names/invocations are read off the trusted TOP-LEVEL SDK
    // envelopes (`result` / `assistant`), not a recursive `.. | objects` scan.
    // A tool_use `input` (model-controlled) carrying a fake denial count, a
    // fake denied tool name, and a nested tool_use must all be ignored.
    const result = runStepAWith([
      {
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu_evil",
              name: "Bash",
              input: {
                permission_denials_count: 999,
                denied: { tool_name: "FAKE_INJECTED_TOOL" },
                nested: { type: "tool_use" },
              },
            },
          ],
        },
      },
      { type: "result", permission_denials_count: 0 },
    ]);
    expect(result.status, result.stderr).toBe(0);
    // Count and denied names come only from the top-level result record.
    expect(result.stdout).toContain("permission_denials_count: 0");
    expect(result.stdout).not.toContain("999");
    expect(result.stdout).not.toContain("FAKE_INJECTED_TOOL");
    expect(result.stdout).toContain(
      "denied tool names (0): no denial records found in this document",
    );
    // Only the one real tool_use block counts; the nested one in `input` does not.
    expect(result.stdout).toContain("tool invocations seen (NOT necessarily denied): 1");
  });
});

describe("claude-review completion-assertion step (step B)", () => {
  it("B-T1: healthy #152 tracking comment on a successful run passes", () => {
    const result = runStepB({
      pages: [[completionComment(PR152_COMPLETE)]],
      runId: PR152_RUN_ID,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      "confirmed: the review posted a tracking comment with no unfinished work",
    );
  });

  it("B-T2: truncated #150 tracking comment fails on unticked boxes", () => {
    const result = runStepB({
      pages: [[completionComment(PR150_TRUNCATED)]],
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
        pages: [[completionComment(PR152_COMPLETE)]],
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

  it("B-T5: a run id that byte-prefixes a longer linked run id is rejected", () => {
    // A GENUINE byte-prefix collision: the comment links run 301234567890 and
    // is otherwise HEALTHY, so the pre-fix substring `contains(...)` would
    // SELECT it (and pass) when RUN_ID is a true prefix of that longer id.
    // The boundary-anchored predicate requires a non-digit or end-of-string
    // after the id, so the prefix no longer matches and the run is correctly
    // treated as having no tracking comment. (The earlier version of this test
    // was mutation-blind: it paired PR152's link, run 30306271323, with a
    // prefix of PR150's id, so no prefix relationship existed and reverting
    // the code to `contains(...)` still passed.)
    const longerRunId = "301234567890";
    const prefixRunId = "30123456789"; // a true byte-prefix of longerRunId
    const result = runStepB({
      pages: [[trackingComment({ runId: longerRunId, ticked: true })]],
      runId: prefixRunId,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("posted no tracking comment");

    // A wholly different run id is likewise unbound.
    const other = runStepB({
      pages: [[trackingComment({ runId: longerRunId, ticked: true })]],
      runId: "99999999999",
    });
    expect(other.status).toBe(1);
    expect(other.stdout).toContain("posted no tracking comment");
  });

  it("T-7: only a github-actions[bot] author supplies completion evidence; every other author fails closed", () => {
    // Since #157 the genuine tracker is authored by github-actions[bot] (the
    // job's own GITHUB_TOKEN posts it), and step B's author binding accepts
    // exactly that login. The prior claude[bot] identity (the minted App token
    // that no longer exists in this job), an arbitrary human/other bot, and any
    // other name all fail closed. Deleting the author filter would let the
    // mallory spoof pass (G5); reverting the literal to claude[bot] would both
    // reject the genuine github-actions[bot] tracker and admit the claude[bot]
    // spoof (G5').
    const healthy = (login: string): Comment =>
      trackingComment({ runId: PR152_RUN_ID, ticked: true, login });

    const passes = runStepB({
      pages: [[healthy("github-actions[bot]")]],
      runId: PR152_RUN_ID,
    });
    expect(passes.status, `${passes.stdout}\n${passes.stderr}`).toBe(0);
    expect(passes.stdout).toContain("confirmed:");

    for (const login of ["claude[bot]", "mallory", "roastpilot-factory[bot]"]) {
      const rejected = runStepB({
        pages: [[healthy(login)]],
        runId: PR152_RUN_ID,
      });
      expect(rejected.status, login).toBe(1);
      expect(rejected.stdout, login).toContain("posted no tracking comment");
    }
  });

  it("B-T7: a matching comment with no checklist fails closed", () => {
    const body = [
      `**Claude finished** [View job](https://github.com/syamaner/roastpilot-cloud/actions/runs/${PR152_RUN_ID})`,
      "",
      "Some prose with no task list at all.",
    ].join("\n");
    const result = runStepB({
      pages: [[completionComment(body)]],
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
      pages: [[completionComment(body)]],
      runId: PR152_RUN_ID,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("confirmed:");
  });

  it("B-T10: a non-zero gh keeps the pipeline fail-closed", () => {
    const result = runStepB({
      pages: [[completionComment(PR152_COMPLETE)]],
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

  it("B-T12: a run id quoted in review prose does not satisfy the header binding (fsr LOW-2)", () => {
    // The comment's own [View job] header link references a DIFFERENT run;
    // this run's id appears only in later review prose. The binding is
    // anchored to the [View job](.../actions/runs/<id>) header link, so the
    // prose mention must not bind. A whole-body match would (wrongly) select
    // this healthy comment and pass.
    const headerRun = "40000000001";
    const thisRun = "40000000002";
    const body = [
      `**Claude finished** [View job](https://github.com/syamaner/roastpilot-cloud/actions/runs/${headerRun})`,
      "",
      "### Code review",
      "",
      "- [x] Gather context",
      "- [x] Post findings",
      "",
      `Findings: I compared against /actions/runs/${thisRun} earlier and it looked fine.`,
    ].join("\n");
    const result = runStepB({
      pages: [[completionComment(body)]],
      runId: thisRun,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("posted no tracking comment");
  });

  it("B-T13: a prior-attempt completed comment is rejected on re-run (codex P2)", () => {
    // run_id is stable across re-run attempts, so a re-run that truncates
    // before writing its own tracking comment would otherwise select the prior
    // attempt's COMPLETED comment (same run_id, `last`) and pass -- the #150
    // fail-open via re-run. The freshness binding rejects any comment last
    // updated before THIS attempt started.
    const attemptStart = "2026-07-27T13:18:34Z";
    const staleComment: Comment = {
      ...trackingComment({ runId: PR152_RUN_ID, ticked: true }),
      updatedAt: "2026-07-27T13:16:33Z", // prior attempt, before attemptStart
    };
    const stale = runStepB({
      pages: [[staleComment]],
      runId: PR152_RUN_ID,
      runAttempt: "2",
      attemptStartedAt: attemptStart,
    });
    expect(stale.status).toBe(1);
    expect(stale.stdout).toContain("posted no tracking comment");

    // Positive control: the SAME completed comment, freshly written by this
    // attempt (updated_at at/after the attempt start), passes.
    const freshComment: Comment = {
      ...trackingComment({ runId: PR152_RUN_ID, ticked: true }),
      updatedAt: "2026-07-27T13:19:00Z", // after attemptStart
    };
    const fresh = runStepB({
      pages: [[freshComment]],
      runId: PR152_RUN_ID,
      runAttempt: "2",
      attemptStartedAt: attemptStart,
    });
    expect(fresh.status, `${fresh.stdout}\n${fresh.stderr}`).toBe(0);
    expect(fresh.stdout).toContain("confirmed:");
  });

  it("B-T14: a failing attempts API fails the step closed (codex P2)", () => {
    // If the per-attempt start time is unavailable, the step must fail closed
    // rather than skip the freshness check and admit a possibly-stale comment.
    const result = runStepB({
      pages: [[trackingComment({ runId: PR152_RUN_ID, ticked: true })]],
      runId: PR152_RUN_ID,
      attemptApiFails: true,
    });
    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("confirmed:");
  });

  it("B-T15: a same-second updated_at == attempt_start is rejected (F2)", () => {
    // Both timestamps are whole-second GitHub values, so a comment written in
    // the boundary second reads `updated_at == run_started_at`. The strict `>`
    // fails that tie CLOSED (a `>=` would admit it). A genuine tracker is
    // written many seconds in, so this never rejects a real completion.
    const attemptStart = "2026-07-27T13:18:34Z";
    const boundaryComment: Comment = {
      ...trackingComment({ runId: PR152_RUN_ID, ticked: true }),
      updatedAt: attemptStart, // byte-equal to the attempt start
    };
    const result = runStepB({
      pages: [[boundaryComment]],
      runId: PR152_RUN_ID,
      runAttempt: "2",
      attemptStartedAt: attemptStart,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("posted no tracking comment");
  });

  it("T-8: a same-run github-actions[bot] sibling with no [View job] link does not satisfy step B", () => {
    // #157 made the genuine tracker's author github-actions[bot] -- the SAME
    // identity the spec-grounded-review publisher posts its verdict under, in
    // the SAME run_id. What still discriminates the two is the run-id header
    // link (fsr LOW-2): the genuine tracker carries a `[View job](.../actions/
    // runs/<id>)` header link, the sibling verdict does not. This sibling body
    // is otherwise a perfectly healthy completion signal (github-actions[bot]
    // author, a fully-ticked checklist under a non-in-progress heading, and it
    // even names this run id in prose), so ONLY the missing header link keeps
    // it out. Deleting the header-link predicate (G5") would admit it and pass.
    const siblingBody = [
      "## Spec-grounded review",
      "",
      `Checked the acceptance criteria for run ${PR152_RUN_ID}; all satisfied.`,
      "",
      "- [x] criterion one",
      "- [x] criterion two",
    ].join("\n");
    const result = runStepB({
      pages: [[{ login: "github-actions[bot]", body: siblingBody }]],
      runId: PR152_RUN_ID,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("posted no tracking comment");
  });
});

// A prose tracking-comment body whose [View job] header link carries `runId`
// (so the run-id, freshness and author bindings all pass and execution reaches
// the completion grammar), followed by the given body lines. Mirrors
// trackingComment() but emits NO task-list box, so the first-block extractor
// returns empty and the body routes to the #183 sentinel branch.
function proseBody(runId: string, ...lines: readonly string[]): string {
  return [
    `**Claude finished @syamaner's task in 1m 37s** —— [View job](https://github.com/syamaner/roastpilot-cloud/actions/runs/${runId})`,
    "",
    "---",
    ...lines,
  ].join("\n");
}

describe("claude-review completion-assertion sentinel branch (step B, #183)", () => {
  it("C-T1: a prose re-review body ending with the sentinel passes on the sentinel branch", () => {
    // The real PR #182 prose body (no checklist), plus a blank line and the
    // terminal sentinel as its final line -- the compliant shape the
    // --append-system-prompt instruction asks the model to produce.
    const body = `${PR182_PROSE}\n${SENTINEL}`;
    const result = runStepB({
      pages: [[completionComment(body)]],
      runId: PR182_RUN_ID,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      "carrying the terminal completion sentinel",
    );
  });

  it("C-T2: a truncated prose body with no sentinel is rejected (fail-closed proof)", () => {
    // The load-bearing negative: an interim/truncated prose update (a
    // mid-paragraph prefix of PR #182's body, no sentinel) must red -- the
    // #146/#150 failure direction this whole gate exists for. There is no box
    // to be unticked in a prose body, so the sentinel is the only signal that
    // keeps this fail-closed.
    const result = runStepB({
      pages: [[completionComment(PR182_PROSE_TRUNCATED)]],
      runId: PR182_RUN_ID,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "final line is not the terminal completion sentinel",
    );
  });

  it("C-T3: the full PR #182 prose body verbatim (no sentinel) is rejected", () => {
    // Prose alone never passes, and the fix is not retroactive for the
    // historical comment: the captured body, unmodified, still reds.
    const result = runStepB({
      pages: [[completionComment(PR182_PROSE)]],
      runId: PR182_RUN_ID,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "final line is not the terminal completion sentinel",
    );
  });

  it("C-T4: the sentinel quoted mid-body does not satisfy the final-line anchor", () => {
    // The sentinel appears verbatim on an earlier line, but the FINAL line is
    // other prose. Anchoring to the last line (not "anywhere in the body")
    // keeps an interim update that merely quotes the sentinel from passing.
    const body = proseBody(
      PR182_RUN_ID,
      "### Review summary",
      "",
      "For reference, the completion sentinel this gate expects is:",
      SENTINEL,
      "",
      "But the review is not actually finished, so more prose follows here.",
    );
    const result = runStepB({
      pages: [[completionComment(body)]],
      runId: PR182_RUN_ID,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "final line is not the terminal completion sentinel",
    );
  });

  it("C-T5: near-miss final lines fail byte-equality (prefix, trailing char, code fence)", () => {
    // Byte-equality is exact: a blockquote prefix, a single extra trailing
    // character, or the sentinel wrapped in a closing code fence (so the last
    // non-empty line is the ``` fence) each fail.
    const tails: readonly (readonly string[])[] = [
      [`> ${SENTINEL}`], // (i) blockquote-prefixed
      [`${SENTINEL}.`], // (ii) one extra non-space trailing character
      ["```", SENTINEL, "```"], // (iii) sentinel inside a closing code fence
    ];
    for (const tail of tails) {
      const body = proseBody(
        PR182_RUN_ID,
        "### Review summary",
        "",
        "Done.",
        "",
        ...tail,
      );
      const result = runStepB({
        pages: [[completionComment(body)]],
        runId: PR182_RUN_ID,
      });
      expect(result.status, JSON.stringify(tail)).toBe(1);
      expect(result.stdout, JSON.stringify(tail)).toContain(
        "final line is not the terminal completion sentinel",
      );
    }
  });

  it("C-T6: trailing blank lines, spaces, and a CR after the sentinel are tolerated", () => {
    // A genuine completion may carry trailing whitespace/CRLF or blank lines;
    // the final-non-empty-line + trailing-whitespace/CR strip accepts all of
    // them while still demanding an exact byte match on the sentinel itself.
    const tails: readonly string[] = [
      `${SENTINEL}\n\n\n`, // trailing blank lines
      `${SENTINEL}   `, // trailing spaces on the sentinel line
      `${SENTINEL}\r`, // a trailing CR (CRLF line ending)
      `${SENTINEL}  \r\n  \n`, // spaces + CR + trailing blank lines combined
    ];
    for (const tail of tails) {
      const body = `${proseBody(PR182_RUN_ID, "### Review summary", "", "All good.")}\n${tail}`;
      const result = runStepB({
        pages: [[completionComment(body)]],
        runId: PR182_RUN_ID,
      });
      expect(result.status, JSON.stringify(tail)).toBe(0);
      expect(result.stdout, JSON.stringify(tail)).toContain(
        "carrying the terminal completion sentinel",
      );
    }
  });

  it("C-T7: an in-progress heading fails even when the sentinel is the final line", () => {
    // The sentinel is present as the final line (conjunct (a) passes), but the
    // heading region still advertises work in progress, so conjunct (b) fails
    // with the existing in-progress message.
    const body = proseBody(
      PR182_RUN_ID,
      "### Code review in progress",
      "",
      "Still working through the review passes.",
      "",
      SENTINEL,
    );
    const result = runStepB({
      pages: [[completionComment(body)]],
      runId: PR182_RUN_ID,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("still reports work in progress");
  });

  it("C-T8: a checklist body with the sentinel appended still fails on unticked boxes (precedence)", () => {
    // A body carrying ANY task box routes to the checklist branch, never the
    // sentinel branch -- so PR #150's truncated checklist, even with a
    // sentinel appended as its final line, still fails on unticked boxes. A
    // smuggled sentinel cannot buy past an unfinished checklist.
    const body = `${PR150_TRUNCATED}\n${SENTINEL}`;
    const result = runStepB({
      pages: [[completionComment(body)]],
      runId: PR150_RUN_ID,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "finished with unticked checklist items",
    );
  });

  it("C-T9: #150 verbatim still fails and #152 verbatim still passes WITHOUT any sentinel", () => {
    // The checklist branch is unchanged by #183: the truncated #150 comment
    // still reds on unticked boxes, and the healthy #152 comment still passes
    // with no sentinel anywhere (the checklist branch must not start demanding
    // the sentinel).
    const truncated = runStepB({
      pages: [[completionComment(PR150_TRUNCATED)]],
      runId: PR150_RUN_ID,
    });
    expect(truncated.status).toBe(1);
    expect(truncated.stdout).toContain(
      "finished with unticked checklist items",
    );

    const healthy = runStepB({
      pages: [[completionComment(PR152_COMPLETE)]],
      runId: PR152_RUN_ID,
    });
    expect(healthy.status, `${healthy.stdout}\n${healthy.stderr}`).toBe(0);
    expect(healthy.stdout).toContain("no unfinished work advertised");
  });

  it("C-T10: a headerless prose body mentioning 'review in progress' fails (whole-body heading region)", () => {
    // With no ATX heading anywhere, the heading region widens fail-closed to
    // the WHOLE body, so an in-progress mention in running prose is caught
    // even though the sentinel is the final line.
    const body = proseBody(
      PR182_RUN_ID,
      "This note has no markdown heading at all, yet it mentions the review in progress state in running prose.",
      "",
      SENTINEL,
    );
    const result = runStepB({
      pages: [[completionComment(body)]],
      runId: PR182_RUN_ID,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("still reports work in progress");
  });

  it("C-T12: a headerless prose body with the sentinel as its final line passes (no-heading accept path)", () => {
    // The ACCEPT counterpart to C-T10's reject: with no ATX heading anywhere
    // the heading region widens to the whole body (fail-closed), but a
    // compliant headerless body -- no "review in progress" wording, sentinel
    // as the final non-empty line -- must still be ACCEPTED. Pins that a
    // future over-narrowing of the whole-body widening cannot silently start
    // rejecting compliant headerless prose (availability-only, but this is a
    // security-gate harness, so close the symmetry).
    const body = proseBody(
      PR182_RUN_ID,
      "This note has no markdown heading at all; it is a short, complete prose summary with no checklist.",
      "",
      SENTINEL,
    );
    const result = runStepB({
      pages: [[completionComment(body)]],
      runId: PR182_RUN_ID,
    });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(
      "carrying the terminal completion sentinel",
    );
  });

  it("C-T11: instruction and assertion grammar carry the identical sentinel literal (lockstep)", () => {
    // Pins the two copies of the sentinel together so they cannot drift: the
    // terminal marker the workflow's --append-system-prompt instruction tells
    // the model to emit as its last line must byte-EQUAL the assertion
    // grammar's SENTINEL='...' literal. A one-character change to either fails
    // here rather than shipping an instruction the model obeys and a grammar
    // that rejects the result (or vice versa). Same lockstep style as
    // claude-code-action-token-model.test.ts T-3.
    //
    // The marker is compared with === on the exact substring after the
    // instruction prose, NOT `appendLine.toContain(SENTINEL)` (connector P2 on
    // PR #185): toContain would let a SUFFIX on the instruction marker slip
    // past -- the old marker stays a substring of the longer new one -- while
    // the assertion's byte-equality (`[ "$LAST_LINE" != "$SENTINEL" ]`) would
    // then reject EVERY prose-shaped review (an availability regression). An
    // exact match on the extracted marker catches a suffix, a prefix, or any
    // other drift on either side.
    const document = parseDocument(readFileSync(REVIEW_WORKFLOW_PATH, "utf8"));
    expect(document.errors).toEqual([]);
    const workflow = document.toJS() as Mapping;
    const job = asMapping(asMapping(workflow.jobs)?.["claude-review"]);
    const steps = job?.steps;
    if (!Array.isArray(steps)) {
      throw new Error("claude-review job has no steps");
    }
    const reviewStep = steps.find(
      (candidate) => asMapping(candidate)?.name === "Run Claude Code Review",
    );
    const claudeArgs = String(
      asMapping(asMapping(reviewStep)?.with)?.claude_args,
    );
    const appendLine = claudeArgs
      .split("\n")
      .find((line) => line.trimStart().startsWith("--append-system-prompt"));
    expect(
      appendLine,
      "claude_args has no --append-system-prompt line",
    ).toBeTruthy();
    // (1) Extract the quoted instruction value (it contains no internal `"`).
    const instructionValue = appendLine?.match(
      /--append-system-prompt "(.*)"\s*$/,
    )?.[1];
    expect(
      instructionValue,
      "could not extract the --append-system-prompt value",
    ).toBeTruthy();
    // The terminal marker is the substring after the instruction prose (the
    // model is told this is its exact last line). Extract it after the prose
    // delimiter and assert it byte-EQUALS the grammar literal, so a suffix on
    // the marker fails here (the connector-P2 case) instead of shipping an
    // instruction/grammar mismatch that reds every prose review.
    const PROSE_DELIMITER = "interim update: ";
    const delimiterIndex = instructionValue!.lastIndexOf(PROSE_DELIMITER);
    expect(
      delimiterIndex,
      "instruction prose delimiter not found; cannot isolate the terminal marker",
    ).toBeGreaterThanOrEqual(0);
    const instructionMarker = instructionValue!.slice(
      delimiterIndex + PROSE_DELIMITER.length,
    );
    expect(instructionMarker).toBe(SENTINEL);
    // (2) the assertion grammar's SENTINEL literal equals it exactly, so the
    // instruction marker and the grammar are transitively byte-identical.
    const grammarLiteral = reviewJobStepRun(STEP_B).match(
      /SENTINEL='([^']*)'/,
    )?.[1];
    expect(grammarLiteral).toBe(SENTINEL);
  });
});
