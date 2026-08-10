import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { EXPECTED_CLAUDE_CODE_ACTION_SHA } from "../../scripts/factory/workflow-pin-audit-logic.mts";
import { MAX_PATCH_BYTES } from "../../scripts/factory/patch-analysis-format.mts";

const WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/owner-command-intake.yml", import.meta.url),
);
const RESOLVER_REFERENCE_PATH = fileURLToPath(
  new URL("../../.github/workflows/codex-verdict-status.yml", import.meta.url),
);
const INTAKE_ENTRYPOINT_PATH = fileURLToPath(
  new URL("../../scripts/factory/intake-owner-command.mts", import.meta.url),
);
const PUBLISH_ENTRYPOINT_PATH = fileURLToPath(
  new URL("../../scripts/factory/post-owner-command-response.mts", import.meta.url),
);
const APPLY_ENTRYPOINT_PATH = fileURLToPath(
  new URL("../../scripts/factory/apply-owner-task.mts", import.meta.url),
);
const OWNER_INTAKE_VARIABLE = ["OWNER", "COMMAND", "INTAKE", "ENABLED"].join("_");
const TASK_GATE =
  `vars.${OWNER_INTAKE_VARIABLE} == 'true' && vars.OWNER_TASK_APPLY_ENABLED == 'true' && vars.FACTORY_PAUSED != 'true' && needs.intake.outputs.proceed == 'true' && needs.intake.outputs.verb == 'task'`;
const TASK_APPLY_GATE = `${TASK_GATE} && needs.task-agent.result == 'success'`;
const PUBLISH_GATE =
  `always() && vars.${OWNER_INTAKE_VARIABLE} == 'true' && vars.FACTORY_PAUSED != 'true' && needs.resolve-trusted-revision.result == 'success' && needs.intake.result == 'success' && needs.intake.outputs.proceed == 'true' && ((needs.intake.outputs.verb == 'question' && needs.answer-agent.result == 'success') || (needs.intake.outputs.verb == 'task' && vars.OWNER_TASK_APPLY_ENABLED != 'true'))`;
const CHECKOUT =
  "actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0";

type Mapping = Record<string, unknown>;

function mapping(value: unknown): Mapping {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected mapping");
  }
  return value as Mapping;
}

function workflowSource(): string {
  return readFileSync(WORKFLOW_PATH, "utf8");
}

function workflow(): Mapping {
  const document = parseDocument(workflowSource());
  expect(document.errors).toEqual([]);
  return mapping(document.toJS());
}

function job(name: string): Mapping {
  return mapping(mapping(workflow().jobs)[name]);
}

function steps(jobName: string): Mapping[] {
  const raw = job(jobName).steps;
  if (!Array.isArray(raw)) throw new Error(`${jobName} has no steps`);
  return raw.map(mapping);
}

function allSteps(): Mapping[] {
  return Object.keys(mapping(workflow().jobs)).flatMap(steps);
}

function namedStep(jobName: string, name: string): Mapping {
  const found = steps(jobName).find((step) => step.name === name);
  if (found === undefined) throw new Error(`missing ${jobName} step ${name}`);
  return found;
}

function runBody(jobName: string, name: string): string {
  const run = namedStep(jobName, name).run;
  if (typeof run !== "string") throw new Error(`${jobName} step ${name} has no run body`);
  return run;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function environmentReadNames(source: string): string[] {
  return [
    ...source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/gu),
    ...source.matchAll(/process\.env\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]/gu),
    ...source.matchAll(/requireEnv\("([A-Z][A-Z0-9_]*)"\)/gu),
  ].map((match) => match[1]!);
}

function resolverStepBytes(source: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((line) =>
    line === "      - name: Resolve the trusted revision"
  );
  if (start < 0) throw new Error("missing resolver step");
  let end = start + 1;
  while (
    end < lines.length &&
    !/^      - /u.test(lines[end]!) &&
    !/^  [a-zA-Z0-9_-]+:$/u.test(lines[end]!)
  ) {
    end += 1;
  }
  while (end > start && lines[end - 1] === "") end -= 1;
  return lines.slice(start, end).join("\n");
}

describe("owner-command intake workflow contract", () => {
  it("W1 pins issue-comment creation as the only trigger", () => {
    expect(workflow().on).toEqual({ issue_comment: { types: ["created"] } });
  });

  it("W2 pins default deny and keeps write authority on the two publisher jobs only", () => {
    expect(workflow().permissions).toEqual({});
    expect(job("resolve-trusted-revision").permissions).toEqual({});
    expect(job("intake").permissions).toEqual({
      contents: "read",
      issues: "read",
      "pull-requests": "read",
    });
    expect(job("answer-agent").permissions).toEqual({ contents: "read" });
    expect(job("task-agent").permissions).toEqual({ contents: "read" });
    expect(job("task-apply").permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });
    expect(job("publish").permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
    });
    for (const [name, raw] of Object.entries(mapping(workflow().jobs))) {
      if (name !== "publish" && name !== "task-apply") {
        expect(JSON.stringify(mapping(raw).permissions)).not.toContain('"write"');
      }
    }
  });

  it("W3 byte-pins the dark double gate on every job", () => {
    for (const rawJob of Object.values(mapping(workflow().jobs))) {
      const gate = String(mapping(rawJob).if);
      expect(gate).toContain(`vars.${OWNER_INTAKE_VARIABLE} == 'true'`);
      expect(gate).toContain("vars.FACTORY_PAUSED != 'true'");
    }
  });

  it("W4 keeps the resolver step byte-identical and credential-free", () => {
    expect(resolverStepBytes(workflowSource())).toBe(
      resolverStepBytes(readFileSync(RESOLVER_REFERENCE_PATH, "utf8")),
    );
    expect(job("resolve-trusted-revision").permissions).toEqual({});
    expect(job("resolve-trusted-revision").outputs).toEqual({
      "trusted-sha": "${{ steps.resolve.outputs.trusted-sha }}",
    });
  });

  it("W5 pins every repository checkout to the trusted SHA", () => {
    const checkouts = allSteps().filter((step) => step.uses === CHECKOUT);
    expect(checkouts).toHaveLength(5);
    for (const checkout of checkouts) {
      expect(mapping(checkout.with)).toEqual(expect.objectContaining({
        ref: "${{ needs.resolve-trusted-revision.outputs.trusted-sha }}",
      }));
    }
    expect(checkouts.filter((checkout) =>
      mapping(checkout.with)["persist-credentials"] === true
    )).toEqual([
      namedStep("task-apply", "Checkout trusted repository state with push credentials"),
    ]);
    expect(checkouts.filter((checkout) =>
      mapping(checkout.with)["persist-credentials"] === false
    )).toHaveLength(4);
    expect(workflowSource()).not.toMatch(
      /github\.sha|head\.sha|pull_request\.head|event\.pull_request\.head/u,
    );
  });

  it("W6 pins every external action and the Claude action revision", () => {
    const uses = allSteps().map((step) => step.uses).filter(
      (value): value is string => typeof value === "string",
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use).toMatch(/^[^@\s]+@[0-9a-f]{40}$/u);
    expect(uses).toContain(
      `anthropics/claude-code-action@${EXPECTED_CLAUDE_CODE_ACTION_SHA}`,
    );
  });

  it("W7 keeps GitHub expressions out of every shell body", () => {
    for (const step of allSteps()) {
      if (typeof step.run === "string") expect(step.run).not.toContain("${{");
    }
  });

  it("W8 excludes identity literals and token-minting/OIDC surfaces", () => {
    for (const rawJob of Object.values(mapping(workflow().jobs))) {
      const candidate = mapping(rawJob);
      expect(String(candidate.if ?? "")).not.toContain("syamaner");
      for (const step of (candidate.steps as unknown[]).map(mapping)) {
        expect(JSON.stringify(step.env ?? {})).not.toContain("syamaner");
      }
    }
    expect(workflowSource()).not.toMatch(/create-github-app-token|id-token/iu);
  });

  it("W9 pins both entrypoints to their closed environment grammars", () => {
    const intakeNames = environmentReadNames(
      readFileSync(INTAKE_ENTRYPOINT_PATH, "utf8"),
    );
    expect(new Set(intakeNames)).toEqual(new Set([
      "GH_TOKEN",
      "GITHUB_REPOSITORY",
      "TARGET_PR_NUMBER",
      "COMMENT_ID",
      "PROMPT_ARTIFACT_PATH",
      "GITHUB_OUTPUT",
    ]));
    const publishNames = environmentReadNames(
      readFileSync(PUBLISH_ENTRYPOINT_PATH, "utf8"),
    );
    expect(new Set(publishNames)).toEqual(new Set([
      "GH_TOKEN",
      "GITHUB_REPOSITORY",
      "TARGET_PR_NUMBER",
      "COMMENT_ID",
      "ANSWER_ARTIFACT_PATH",
      "BINDING_ARTIFACT_PATH",
      "INTAKE_VERB",
      "GITHUB_RUN_ID",
    ]));
  });

  it("W10 pins the answer agent to one edit and a closed tool catalog", () => {
    expect(job("answer-agent").permissions).toEqual({ contents: "read" });
    const action = namedStep("answer-agent", "Answer the owner question");
    const inputs = mapping(action.with);
    expect(inputs.use_commit_signing).toBe(true);
    expect(inputs.claude_code_oauth_token).toBe(
      "${{ secrets.CLAUDE_CODE_OAUTH_TOKEN }}",
    );
    expect(inputs.github_token).toBe("${{ secrets.GITHUB_TOKEN }}");
    expect(inputs.allowed_bots).toBe("");
    expect(inputs.allowed_non_write_users).toBe("");
    expect(inputs.show_full_output).toBe(false);
    const args = String(inputs.claude_args);
    const allowed = args.match(/--allowedTools\s+"([^"]+)"/u)?.[1]
      ?.split(",") ?? [];
    expect(allowed).toEqual(["Edit(answer-output/answer.md)"]);
    const denied = args.match(/--disallowedTools\s+"([^"]+)"/u)?.[1]
      ?.split(",") ?? [];
    expect(denied).toEqual(expect.arrayContaining([
      "Bash",
      // MUTATION-CHECK M15: reverting these bare, whole-tool reader denies
      // to a .git-only/path-only scope fails W10 and would reopen absolute
      // reads such as /proc/self/environ.
      "Read",
      "Grep",
      "Glob",
      "LS",
      "WebFetch",
      "WebSearch",
      "Task",
      "TaskCreate",
      "ScheduleWakeup",
      "RemoteTrigger",
      "SendMessage",
      "mcp__github_file_ops__commit_files",
      "mcp__github_comment__update_claude_comment",
      "mcp__github_inline_comment__create_inline_comment",
    ]));
    expect(denied.some((tool) => /^(Read|Grep|Glob|LS)\(/u.test(tool)))
      .toBe(false);
    expect(denied).not.toContain("Edit(answer-output/answer.md)");
    expect(args.match(/--append-system-prompt-file\s+"([^"]+)"/u)?.[1])
      .toBe("intake-data/prompt.txt");
    const prompt = String(inputs.prompt);
    expect(prompt).not.toMatch(/\bRead\b|trusted repository state/u);
  });

  it("W12 carries the v3 prompt binding sidecar to the publisher", () => {
    const upload = namedStep("intake", "Upload question data artifact");
    expect(mapping(upload.with).path).toBe(
      "intake-output/prompt.txt\nintake-output/binding.json\n",
    );
    const download = namedStep("publish", "Download owner-question binding");
    expect(download.if).toBe("needs.intake.outputs.verb == 'question'");
    expect(mapping(download.with)).toEqual({
      name: "owner-question-data",
      path: "intake-data",
    });
    const publish = namedStep(
      "publish",
      "Publish authorised owner-command response",
    );
    expect(mapping(publish.env).BINDING_ARTIFACT_PATH).toBe(
      "intake-data/binding.json",
    );
    expect(mapping(publish.env).INTAKE_VERB).toBe(
      "${{ needs.intake.outputs.verb }}",
    );
  });

  it("W11 serialises per source command and declares no Environment", () => {
    // MUTATION-CHECK: reverting this to issue.number fails the exact key pin
    // and would let GitHub silently replace a third pending command on one PR.
    expect(job("publish").concurrency).toEqual({
      group: "owner-command-intake-${{ github.event.comment.id }}",
      "cancel-in-progress": false,
    });
    expect(job("intake")).not.toHaveProperty("concurrency");
    expect(job("answer-agent")).not.toHaveProperty("concurrency");
    expect(job("task-agent")).not.toHaveProperty("concurrency");
    expect(job("task-apply").concurrency).toEqual(job("publish").concurrency);
    for (const rawJob of Object.values(mapping(workflow().jobs))) {
      expect(mapping(rawJob)).not.toHaveProperty("environment");
    }
  });

  it("W-T1 byte-pins both complete dark task gates", () => {
    expect(job("task-agent").if).toBe(TASK_GATE);
    expect(job("task-apply").if).toBe(TASK_APPLY_GATE);
  });

  it("W-T2 byte-pins every reviewed task-agent and task-apply shell body", () => {
    expect(sha256(runBody("task-agent", "Check out the authorised PR-head snapshot")))
      .toBe("d2166341ac27cedef003f067fe30c9e9d36e27edcae966cee4a07f79a121eaa9");
    expect(sha256(runBody("task-agent", "Restore base-owned configuration (scoped, any-depth)")))
      .toBe("4f50af8a54e9d33f7b29e03c6f905685efe8daf50c6135e39eaa616756542251");
    expect(sha256(runBody("task-agent", "Capture the owner-task patch")))
      .toBe("b841567ac0de67c0d33adb9159115a7d6bab8e1e1642ae17ae1fa4323a63741e");
    expect(sha256(runBody("task-apply", "Build authoritative owner-task patch analysis")))
      .toBe("182d8864751656fb142dab4bf3b8acbcc661947760a2bb27998d1be02f436a11");
    expect(sha256(runBody("task-apply", "Apply the admitted owner-task commit")))
      .toBe("763ee80bdff8cf30042746acf04c8085137aca42759e07625cebcf970888d314");
  });

  it("W-T3 rejects the shell-injection mutation set", () => {
    const capture = runBody("task-agent", "Capture the owner-task patch");
    const analysis = runBody("task-apply", "Build authoritative owner-task patch analysis");
    const mutation = runBody("task-apply", "Apply the admitted owner-task commit");
    const hardenedGitEnvironment = {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    };
    for (const [jobName, stepName] of [
      ["task-agent", "Check out the authorised PR-head snapshot"],
      ["task-agent", "Restore base-owned configuration (scoped, any-depth)"],
      ["task-agent", "Capture the owner-task patch"],
      ["task-apply", "Build authoritative owner-task patch analysis"],
      ["task-apply", "Apply the admitted owner-task commit"],
    ] as const) {
      expect(mapping(namedStep(jobName, stepName).env)).toEqual(
        expect.objectContaining(hardenedGitEnvironment),
      );
    }
    const analysisGuards = [
      ["patch byte count is numeric", '[[ "$PATCH_BYTES" =~ ^[0-9]+$ ]]'],
      ["captured binary row is rejected", 'case "$row" in\n    $\'-\\t-\\t\'*)'],
      ["base object is a commit", '/usr/bin/git rev-parse --verify "$BASE_SHA^{commit}"'],
      ["written tree OID is canonical", 'if [ -z "$TREE_OID" ] || ! [[ "$TREE_OID" =~ ^[0-9a-f]{40}$ ]]'],
    ] as const;
    const mutationGuards = [
      ["ref name has the closed grammar", 'if ! [[ "$REF_NAME" =~ ^[A-Za-z0-9._/-]+$ ]]'],
      ["commit-tree output is canonical", 'if [ -z "$COMMIT_OID" ] || ! [[ "$COMMIT_OID" =~ ^[0-9a-f]{40}$ ]]'],
    ] as const;
    const captureIsHardened = (body: string): boolean => {
      const removeLocalConfig = body.indexOf("rm -f .git/config");
      const seedMinimalConfig = body.indexOf(
        "/usr/bin/git config core.repositoryformatversion 0",
      );
      const captureIndex = body.indexOf("/usr/bin/git add -A");
      return (
        body.includes("set -euo pipefail") &&
        removeLocalConfig >= 0 &&
        seedMinimalConfig >= 0 &&
        captureIndex >= 0 &&
        removeLocalConfig < captureIndex &&
        seedMinimalConfig < captureIndex
      );
    };
    const analysisIsHardened = (body: string): boolean =>
      body.includes("set -euo pipefail") &&
      body.includes('[[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]') &&
      body.includes('/usr/bin/git apply --cached -- "$PATCH_PATH"') &&
      body.includes('/usr/bin/git diff-index --cached --name-status -z -M -C --find-copies-harder "$BASE_SHA"') &&
      body.includes('/usr/bin/git diff --cached --text --no-color --no-renames "$BASE_SHA"') &&
      body.includes('/usr/bin/git diff --cached --numstat -z -M "$BASE_SHA"') &&
      analysisGuards.every(([, guard]) => body.includes(guard)) &&
      !body.includes(" HEAD");
    const mutationIsHardened = (body: string): boolean =>
      body.includes("set -euo pipefail") &&
      body.includes('[[ "$oid" =~ ^[0-9a-f]{40}$ ]]') &&
      body.includes('case "$REF_NAME" in\n  -*)') &&
      body.includes('/usr/bin/git check-ref-format --branch "$REF_NAME"') &&
      body.includes('--force-with-lease="refs/heads/$REF_NAME:$LEASE_SHA"') &&
      body.includes('"$COMMIT_OID:refs/heads/$REF_NAME"') &&
      mutationGuards.every(([, guard]) => body.includes(guard));
    expect(captureIsHardened(capture)).toBe(true);
    expect(captureIsHardened(capture.replace("rm -f .git/config\n", "")))
      .toBe(false);
    expect(captureIsHardened(capture.replace(
      "/usr/bin/git config core.repositoryformatversion 0\n",
      "",
    ))).toBe(false);
    expect(analysisIsHardened(analysis)).toBe(true);
    expect(mutationIsHardened(mutation)).toBe(true);
    for (const [name, guard] of analysisGuards) {
      expect(analysis.includes(guard), name).toBe(true);
      expect(analysis.replace(guard, "").includes(guard), name).toBe(false);
      expect(analysisIsHardened(analysis.replace(guard, "")), name).toBe(false);
    }
    for (const [name, guard] of mutationGuards) {
      expect(mutation.includes(guard), name).toBe(true);
      expect(mutation.replace(guard, "").includes(guard), name).toBe(false);
      expect(mutationIsHardened(mutation.replace(guard, "")), name).toBe(false);
    }
    expect(analysisIsHardened(analysis.replace("set -euo pipefail", "set -u"))).toBe(false);
    expect(analysisIsHardened(analysis.replace('[[ "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]', "true"))).toBe(false);
    expect(analysisIsHardened(analysis.replaceAll("/usr/bin/git", "git"))).toBe(false);
    expect(analysisIsHardened(analysis.replaceAll('"$BASE_SHA"', "HEAD"))).toBe(false);
    expect(analysisIsHardened(analysis.replace('apply --cached -- "$PATCH_PATH"', 'apply --cached "$PATCH_PATH"'))).toBe(false);
    expect(mutationIsHardened(mutation.replace("set -euo pipefail", "set -u"))).toBe(false);
    expect(mutationIsHardened(mutation.replace('[[ "$oid" =~ ^[0-9a-f]{40}$ ]]', "true"))).toBe(false);
    expect(mutationIsHardened(mutation.replace('case "$REF_NAME" in\n  -*)', "case x in\n  x)"))).toBe(false);
    expect(mutationIsHardened(mutation.replace('/usr/bin/git check-ref-format --branch "$REF_NAME"', "true"))).toBe(false);
    expect(mutationIsHardened(mutation.replace('--force-with-lease="refs/heads/$REF_NAME:$LEASE_SHA"', "--force"))).toBe(false);
    expect(mutationIsHardened(mutation.replace('"$COMMIT_OID:refs/heads/$REF_NAME"', '"$COMMIT_OID:$REF_NAME"'))).toBe(false);
  });

  it("W-T4 pins FI[1] to one scratch index, one apply, and three base-bound streams", () => {
    const body = runBody("task-apply", "Build authoritative owner-task patch analysis");
    expect(body.match(/GIT_INDEX_FILE/gu)).toHaveLength(1);
    expect(body.match(/git apply --cached/gu)).toHaveLength(1);
    expect(body.match(/git write-tree/gu)).toHaveLength(1);
    expect(body).toContain('export GIT_INDEX_FILE="$SCRATCH/index"');
    expect(body).toContain('/usr/bin/git diff-index --cached --name-status -z -M -C --find-copies-harder "$BASE_SHA" > "$ANALYSIS_DIR/name_status"');
    expect(body).toContain('/usr/bin/git diff --cached --text --no-color --no-renames "$BASE_SHA" > "$ANALYSIS_DIR/diff"');
    expect(body).toContain('/usr/bin/git diff --cached --numstat -z -M "$BASE_SHA" > "$ANALYSIS_DIR/numstat"');
    const cap = Number(body.match(/PATCH_BYTES" -gt ([0-9]+)/u)?.[1]);
    expect(cap).toBe(MAX_PATCH_BYTES);
  });

  it("W-T5 pins FI[2] plan values to quoted argv and excludes workflow expressions from shells", () => {
    const body = runBody("task-apply", "Apply the admitted owner-task commit");
    expect(body).toContain('/usr/bin/git check-ref-format --branch "$REF_NAME"');
    expect(body).toContain('/usr/bin/git push --force-with-lease="refs/heads/$REF_NAME:$LEASE_SHA" origin "$COMMIT_OID:refs/heads/$REF_NAME"');
    expect(body).not.toMatch(/check-ref-format --branch \$REF_NAME| origin \$COMMIT_OID:/u);
    for (const step of allSteps()) {
      if (typeof step.run === "string") expect(step.run).not.toContain("${{");
    }
  });

  it("W-T6 pins FI[3] and all three apply phases to the entrypoint environment grammar", () => {
    const expectedNames = [
      "APPLY_PHASE", "GH_TOKEN", "GITHUB_REPOSITORY", "TARGET_PR_NUMBER",
      "COMMENT_ID", "GITHUB_RUN_ID", "BINDING_ARTIFACT_PATH",
      "PATCH_ARTIFACT_PATH", "ANALYSIS_DIR", "PLAN_DIR",
    ];
    const entrypointNames = environmentReadNames(
      readFileSync(APPLY_ENTRYPOINT_PATH, "utf8"),
    );
    expect(new Set(entrypointNames)).toEqual(
      new Set([...expectedNames, "GITHUB_OUTPUT"]),
    );
    for (const [name, phase] of [
      ["Prepare owner-task apply", "prepare"],
      ["Decide owner-task apply", "decide"],
      ["Finalize owner-task apply", "finalize"],
    ] as const) {
      const env = mapping(namedStep("task-apply", name).env);
      expect(Object.keys(env)).toEqual(expectedNames);
      expect(env.APPLY_PHASE).toBe(phase);
      expect(env).not.toHaveProperty("GITHUB_OUTPUT");
    }
    expect(runBody("task-apply", "Apply the admitted owner-task commit"))
      .toContain('printf \'%s\\n\' "$COMMIT_OID" > "$PLAN_DIR/applied_commit"');
  });

  it("W-T7 pins credential reachability to the two agents and one persisting checkout", () => {
    expect(job("task-agent").permissions).toEqual({ contents: "read" });
    expect(job("task-apply").permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
    });
    const oauthJobs = Object.keys(mapping(workflow().jobs)).filter((name) =>
      JSON.stringify(job(name)).includes("secrets.CLAUDE_CODE_OAUTH_TOKEN")
    );
    expect(oauthJobs).toEqual(["answer-agent", "task-agent"]);
    const persisted = allSteps().filter((step) =>
      step.uses === CHECKOUT && mapping(step.with)["persist-credentials"] === true
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toEqual(namedStep("task-apply", "Checkout trusted repository state with push credentials"));
  });

  it("W-T8 byte-pins the task-agent tool catalog and prompt-file transport", () => {
    const inputs = mapping(namedStep("task-agent", "Implement the authorised owner task").with);
    const args = String(inputs.claude_args);
    expect(args.match(/--allowedTools\s+"([^"]+)"/u)?.[1])
      .toBe("Edit,MultiEdit,Write,Read,Grep,Glob,LS");
    expect(args.match(/--disallowedTools\s+"([^"]+)"/u)?.[1]?.split(","))
      .toEqual([
        "NotebookEdit", "mcp__github_file_ops__commit_files",
        "mcp__github_file_ops__delete_files", "Bash",
        "mcp__github_comment__update_claude_comment",
        "mcp__github_inline_comment__create_inline_comment",
        "mcp__github_ci__get_ci_status", "mcp__github_ci__get_workflow_run_details",
        "mcp__github_ci__download_job_log", "CronCreate", "CronDelete", "CronList",
        "DesignSync", "EnterWorktree", "ExitWorktree", "Monitor", "PushNotification",
        "RemoteTrigger", "ReportFindings", "ScheduleWakeup", "SendMessage", "Skill",
        "Task", "TaskCreate", "TaskGet", "TaskList", "TaskOutput", "TaskStop",
        "TaskUpdate", "WebFetch", "WebSearch", "Workflow",
      ]);
    expect(args).toContain('--append-system-prompt-file "${{ runner.temp }}/intake-data/prompt.txt"');
  });

  it("W-T9 byte-pins the any-depth protected-basename reset before model startup", () => {
    const body = runBody("task-agent", "Restore base-owned configuration (scoped, any-depth)");
    expect(body).not.toContain("PROTECTED_BASENAMES=");
    expect(body).toContain('if [ "$segment" = ".claude" ] || [ "$segment" = ".codex" ]; then');
    expect(body).toContain(".mcp.json|.claudeignore|.npmrc|CLAUDE.md|CLAUDE.local.md|AGENTS.md|AGENTS.override.md)");
    expect(body).toContain("/usr/bin/git ls-files -z");
    expect(body).toContain("find . -path './.git' -prune -o -mindepth 1 -print0");
    expect(body).toContain('/usr/bin/git ls-tree -r -z --name-only "$TRUSTED_SHA"');
    expect(body.indexOf('rm -rf -- "$protected_path"'))
      .toBeLessThan(body.indexOf('/usr/bin/git checkout "$TRUSTED_SHA" -- "$protected_path"'));
    const taskSteps = steps("task-agent");
    expect(taskSteps.findIndex((step) => step.name === "Restore base-owned configuration (scoped, any-depth)"))
      .toBeLessThan(taskSteps.findIndex((step) => step.name === "Implement the authorised owner task"));
  });

  it("W-T10 routes questions and disabled-task acknowledgements through publish", () => {
    const upload = namedStep("intake", "Upload owner-task data artifact");
    expect(upload.if).toBe("steps.intake.outputs.proceed == 'true' && steps.intake.outputs.verb == 'task'");
    expect(mapping(upload.with)).toEqual({
      name: "owner-task-data",
      path: "intake-output/prompt.txt\nintake-output/binding.json\n",
      "if-no-files-found": "error",
      "retention-days": 1,
    });
    const publishGate = String(job("publish").if);
    expect(publishGate).toBe(PUBLISH_GATE);
    expect(publishGate).toContain("needs.intake.outputs.verb == 'question' && needs.answer-agent.result == 'success'");
    expect(publishGate).toContain("needs.intake.outputs.verb == 'task' && vars.OWNER_TASK_APPLY_ENABLED != 'true'");
    expect(publishGate).not.toContain("needs.intake.outputs.verb != 'question'");
    expect(publishGate).not.toContain("needs.intake.outputs.verb != 'question' || needs.answer-agent.result == 'success'");
  });

  it("W-T11 pins shared mutation concurrency and the new step inventory", () => {
    expect(job("task-agent")).not.toHaveProperty("concurrency");
    expect(job("task-apply").concurrency).toEqual(job("publish").concurrency);
    expect(steps("task-agent")).toHaveLength(7);
    expect(steps("task-apply")).toHaveLength(9);
    expect(Object.keys(mapping(workflow().jobs))).toHaveLength(6);
    expect(allSteps()).toHaveLength(33);
  });
});
