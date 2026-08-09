import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import { parseDocument } from "yaml";

import { EXPECTED_CLAUDE_CODE_ACTION_SHA } from "../../scripts/factory/workflow-pin-audit-logic.mts";

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
const OWNER_INTAKE_VARIABLE = ["OWNER", "COMMAND", "INTAKE", "ENABLED"].join("_");
const DOUBLE_GATE =
  `vars.${OWNER_INTAKE_VARIABLE} == 'true' && vars.FACTORY_PAUSED != 'true'`;
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

  it("W2 pins default deny and keeps write authority on publish only", () => {
    expect(workflow().permissions).toEqual({});
    expect(job("resolve-trusted-revision").permissions).toEqual({});
    expect(job("intake").permissions).toEqual({
      contents: "read",
      issues: "read",
      "pull-requests": "read",
    });
    expect(job("answer-agent").permissions).toEqual({ contents: "read" });
    expect(job("publish").permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
    });
    for (const [name, raw] of Object.entries(mapping(workflow().jobs))) {
      if (name !== "publish") {
        expect(JSON.stringify(mapping(raw).permissions)).not.toContain('"write"');
      }
    }
  });

  it("W3 byte-pins the dark double gate on every job", () => {
    for (const rawJob of Object.values(mapping(workflow().jobs))) {
      expect(mapping(rawJob).if).toEqual(expect.stringContaining(DOUBLE_GATE));
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
    expect(checkouts).toHaveLength(3);
    for (const checkout of checkouts) {
      expect(mapping(checkout.with)).toEqual(expect.objectContaining({
        ref: "${{ needs.resolve-trusted-revision.outputs.trusted-sha }}",
        "persist-credentials": false,
      }));
    }
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
    for (const rawJob of Object.values(mapping(workflow().jobs))) {
      expect(mapping(rawJob)).not.toHaveProperty("environment");
    }
  });
});
