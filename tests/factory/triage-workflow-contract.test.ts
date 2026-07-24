import { execFileSync, spawnSync } from "node:child_process";
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
import {
  TRIAGE_COMMENT_MARKER,
  buildTriageGenerationMarker,
  extractTriageGeneration,
} from "../../scripts/factory/apply-triage-verdict-logic.mts";

const TRIAGE_WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/triage-issues.yml", import.meta.url),
);
const IMPLEMENT_WORKFLOW_PATH = fileURLToPath(
  new URL("../../.github/workflows/implement-ready-issues.yml", import.meta.url),
);
const RUNBOOK_PATH = fileURLToPath(
  new URL("../../docs/factory-runbook.md", import.meta.url),
);
const TRIAGE_SKILL_PATH = fileURLToPath(
  new URL("../../.claude/skills/triage/SKILL.md", import.meta.url),
);
const AUTHORIZED_COMMENTS_FILTER_PATH = fileURLToPath(
  new URL(
    "../../.claude/skills/triage/authorized-comments.jq",
    import.meta.url,
  ),
);

type Mapping = Record<string, unknown>;

function asMapping(value: unknown): Mapping | undefined {
  return typeof value === "object" && value !== null
    ? (value as Mapping)
    : undefined;
}

function parseWorkflow(path: string): Mapping {
  const document = parseDocument(readFileSync(path, "utf8"));
  expect(document.errors).toEqual([]);
  return document.toJS() as Mapping;
}

function namedStep(job: unknown, name: string): Mapping {
  const steps = asMapping(job)?.steps;
  if (!Array.isArray(steps)) {
    throw new Error(`job containing ${name} has no steps`);
  }
  const step = steps.find((candidate) => asMapping(candidate)?.name === name);
  if (!step) {
    throw new Error(`missing workflow step: ${name}`);
  }
  return asMapping(step) ?? {};
}

function stepIndex(job: unknown, name: string): number {
  const steps = asMapping(job)?.steps;
  if (!Array.isArray(steps)) {
    throw new Error(`job containing ${name} has no steps`);
  }
  const index = steps.findIndex(
    (candidate) => asMapping(candidate)?.name === name,
  );
  if (index < 0) {
    throw new Error(`missing workflow step: ${name}`);
  }
  return index;
}

function expectOrdered(text: string, fragments: readonly string[]): void {
  let cursor = -1;
  for (const fragment of fragments) {
    const next = text.indexOf(fragment, cursor + 1);
    expect(next, `missing or out-of-order fragment: ${fragment}`).toBeGreaterThan(
      cursor,
    );
    cursor = next;
  }
}

function runFilter(input: unknown): string {
  return execFileSync(
    "jq",
    ["-cj", "-f", AUTHORIZED_COMMENTS_FILTER_PATH],
    {
      encoding: "utf8",
      input: JSON.stringify(input),
    },
  );
}

interface SeedScenario {
  readonly issue?: unknown;
  readonly heldIssue?: unknown;
  readonly graphqlPages?: readonly unknown[];
}

function graphQlCommentsPage(nodes: unknown, pageInfo: unknown): unknown {
  return {
    data: {
      repository: {
        issue: {
          comments: { nodes, pageInfo },
        },
      },
    },
  };
}

function runSeedHold(
  run: string,
  scenario: SeedScenario = {},
): {
  readonly status: number | null;
  readonly calls: readonly string[];
  readonly commentBody: string;
  readonly output: string;
  readonly stdout: string;
  readonly stderr: string;
} {
  const workdir = mkdtempSync(join(tmpdir(), "triage-seed-"));
  const bin = join(workdir, "bin");
  const ghPath = join(bin, "gh");
  const callsPath = join(workdir, "calls");
  const outputPath = join(workdir, "output");
  const statePath = join(workdir, "state");
  try {
    mkdirSync(bin);
    writeFileSync(
      join(workdir, "scenario.json"),
      JSON.stringify({
        issue: scenario.issue ?? {
          state: "open",
          labels: [{ name: "needs-triage" }],
        },
        heldIssue: scenario.heldIssue ?? {
          state: "open",
          labels: [{ name: "needs-triage" }],
        },
        graphqlPages: scenario.graphqlPages ?? [
          {
            data: {
              repository: {
                issue: {
                  comments: {
                    nodes: [],
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          },
        ],
      }),
    );
    writeFileSync(join(workdir, "comment-body"), "");
    writeFileSync(callsPath, "");
    writeFileSync(outputPath, "");
    writeFileSync(statePath, JSON.stringify({ issueReads: 0, graphQlReads: 0 }));
    writeFileSync(
      ghPath,
      `#!/usr/bin/env bash
set -euo pipefail
trap 'printf "stub gh failed at line %s\\n" "$LINENO" >&2' ERR
printf '%q ' "$@" >> "$CALLS_PATH"
printf '\\n' >> "$CALLS_PATH"
method=GET
path=""
joined="$*"
for ((i=1; i<=$#; i++)); do
  arg="\${!i}"
  if [ "$arg" = "--method" ]; then
    j=$((i + 1)); method="\${!j}"
  elif [[ "$arg" == repos/* ]]; then
    path="$arg"
  fi
done
if [ "\${1:-}" = "api" ] && [ "\${2:-}" = "graphql" ]; then
  index=$(jq -r '.graphQlReads' "$STATE_PATH")
  jq --argjson next "$((index + 1))" '.graphQlReads = $next' "$STATE_PATH" > "$STATE_PATH.next"
  mv "$STATE_PATH.next" "$STATE_PATH"
  jq -c --argjson index "$index" '.graphqlPages[$index]' "$SCENARIO_PATH"
elif [ "$method" = "GET" ] && [[ "$path" == */issues/42 ]]; then
  index=$(jq -r '.issueReads' "$STATE_PATH")
  jq --argjson next "$((index + 1))" '.issueReads = $next' "$STATE_PATH" > "$STATE_PATH.next"
  mv "$STATE_PATH.next" "$STATE_PATH"
  if [ "$index" -eq 0 ]; then jq -c '.issue' "$SCENARIO_PATH"; else jq -c '.heldIssue' "$SCENARIO_PATH"; fi
elif [[ "$joined" == *"--method PATCH"* && "$joined" == *"/issues/comments/"* ]] \
  || [[ "$joined" == *"--method POST"* && "$joined" == *"/issues/42/comments"* ]]; then
  payload=$(cat)
  jq -r '.body' <<< "$payload" > "$COMMENT_BODY_PATH"
  jq -cn --argjson id 99 '{id:$id}'
elif [ "$method" = "GET" ] && [[ "$path" == */issues/comments/99 ]]; then
  jq -cn --rawfile body "$COMMENT_BODY_PATH" \
    '{id:99,body:($body | rtrimstr("\\n")),user:{type:"Bot",login:"github-actions[bot]"}}'
else
  printf '{}'
fi
`,
    );
    chmodSync(ghPath, 0o755);
    const result = spawnSync("bash", ["-c", run], {
      cwd: workdir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GH_TOKEN: "test-token",
        REPO: "syamaner/roastpilot-cloud",
        ISSUE_NUMBER: "42",
        TRIAGE_EXECUTION: "123.1",
        GITHUB_OUTPUT: outputPath,
        CALLS_PATH: callsPath,
        COMMENT_BODY_PATH: join(workdir, "comment-body"),
        SCENARIO_PATH: join(workdir, "scenario.json"),
        STATE_PATH: statePath,
      },
    });
    return {
      status: result.status,
      calls: readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean),
      commentBody: readFileSync(join(workdir, "comment-body"), "utf8").replace(
        /\n$/,
        "",
      ),
      output: readFileSync(outputPath, "utf8"),
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

function writeCalls(calls: readonly string[]): readonly string[] {
  return calls.filter((call) =>
    /--method (?:POST|PATCH|PUT|DELETE)/.test(call),
  );
}

describe("bounded triage context contract", () => {
  it("retains the opened-only trigger while establishing the two-phase hold", () => {
    const workflow = parseWorkflow(TRIAGE_WORKFLOW_PATH);
    const on = asMapping(workflow.on);
    const jobs = asMapping(workflow.jobs);
    const seed = asMapping(jobs?.seed);
    const triage = asMapping(jobs?.triage);
    const apply = asMapping(jobs?.apply);

    expect(asMapping(on?.issues)?.types).toEqual(["opened"]);
    expect(on).not.toHaveProperty("workflow_dispatch");
    expect(workflow).not.toHaveProperty("run-name");
    expect(workflow.concurrency).toEqual({
      group: "triage-issue-${{ github.event.issue.number }}",
      "cancel-in-progress": false,
    });
    expect(asMapping(seed?.outputs)).toEqual({
      triage_comment_id: "${{ steps.establish-hold.outputs.comment_id }}",
    });
    expect(asMapping(seed?.permissions)).toEqual({ issues: "write" });

    const hold = namedStep(
      seed,
      "Establish needs-triage seed or re-triage hold",
    );
    expect(asMapping(hold.env)).toMatchObject({
      ISSUE_NUMBER: "${{ github.event.issue.number }}",
      TRIAGE_EXECUTION:
        "${{ format('{0}.{1}', github.run_id, github.run_attempt) }}",
    });
    const holdRun = String(hold.run);
    expectOrdered(holdRun, [
      'issue=$(gh api "repos/$REPO/issues/$ISSUE_NUMBER")',
      `if jq -e 'has("pull_request")'`,
      "exit 1",
      `if [ "$(jq -r '.state' <<< "$issue")" != "open" ]; then`,
      "exit 1",
      'hold_generation="hold:$TRIAGE_EXECUTION"',
      "comments(first:100,after:$cursor)",
      'query_args=(-f query="$graphql_query"',
      'query_args+=(-f cursor="$cursor")',
      'response=$(gh api graphql "${query_args[@]}")',
      '.author.__typename == "Bot"',
      '.author.login == "github-actions"',
      ".fullDatabaseId",
      "matches=$(jq -cn",
      "multiple bot-owned triage comments make generation history ambiguous",
      "could not exhaust triage comments within 5000 entries",
      "comment_id=$(jq -r",
      "existing_body=$(jq -r",
      `if jq -e 'index("ready-to-implement") != null'`,
      '"repos/$REPO/issues/$ISSUE_NUMBER/labels/ready-to-implement"',
      'gh api --method POST "repos/$REPO/issues/$ISSUE_NUMBER/labels"',
      '-f "labels[]=needs-triage"',
      "for label in ready-to-spec needs-info wait-to-implement wontfix",
      'held_issue=$(gh api "repos/$REPO/issues/$ISSUE_NUMBER")',
      "re-triage readiness hold verification failed",
      "exit 1",
      "issues/comments/$comment_id",
      "issues/$ISSUE_NUMBER/comments",
      'echo "comment_id=$comment_id" >> "$GITHUB_OUTPUT"',
      'verified_comment=$(gh api "repos/$REPO/issues/comments/$comment_id")',
      ".body == $body",
      "re-triage generation hold verification failed",
      "exit 1",
    ]);
    expect(holdRun).not.toContain("--method PUT");
    expect(holdRun).not.toContain("gh issue edit");
    expect(holdRun).toContain(
      `comment_marker='${TRIAGE_COMMENT_MARKER}'`,
    );
    const normalizedHoldRun = holdRun.replace(/\s+/g, " ");
    expect(normalizedHoldRun).toContain(
      '.author.__typename == "Bot" and .author.login == "github-actions"',
    );
    expect(normalizedHoldRun).toContain(
      '.user.type == "Bot" and .user.login == "github-actions[bot]" and .body == $body',
    );
    const holdBodyAssignment = holdRun.match(
      /(hold_body="[\s\S]*?\$comment_marker")\n\s*payload=/,
    );
    expect(holdBodyAssignment?.[1]).toBeDefined();
    const renderHoldBody = (existingBody: string): string =>
      execFileSync(
        "bash",
        [
          "-c",
          `${holdBodyAssignment?.[1] ?? "exit 1"}; printf %s "$hold_body"`,
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            comment_marker: TRIAGE_COMMENT_MARKER,
            existing_body: existingBody,
            hold_generation: "hold:123.1",
          },
        },
      );
    const renderedHoldBody = renderHoldBody("");
    expect(renderedHoldBody).toBe(
      `${buildTriageGenerationMarker("hold:123.1")}\n${TRIAGE_COMMENT_MARKER}`,
    );
    expect(extractTriageGeneration(renderedHoldBody)).toBe("hold:123.1");
    const priorVerdict =
      `**Automated triage verdict: \`needs-info\`**\n\nPrior reason\n\n` +
      `${buildTriageGenerationMarker("122.1")}\n${TRIAGE_COMMENT_MARKER}`;
    const heldPriorVerdict = renderHoldBody(priorVerdict);
    expect(heldPriorVerdict).toContain("Prior reason");
    expect(heldPriorVerdict).toContain(buildTriageGenerationMarker("122.1"));
    expect(extractTriageGeneration(heldPriorVerdict)).toBe("hold:123.1");

    expect(triage?.needs).toBe("seed");
    expect(apply?.needs).toEqual(["seed", "triage"]);
    expect(
      asMapping(
        namedStep(apply, "Validate and apply the triage verdict").env,
      ),
    ).toMatchObject({
      TRUSTED_ISSUE_NUMBER: "${{ github.event.issue.number }}",
      TRUSTED_TRIAGE_COMMENT_ID:
        "${{ needs.seed.outputs.triage_comment_id }}",
      TRIAGE_EXECUTION:
        "${{ format('{0}.{1}', github.run_id, github.run_attempt) }}",
    });
  });

  it("uses an opaque cursor to patch a marker found after a full page", () => {
    const workflow = parseWorkflow(TRIAGE_WORKFLOW_PATH);
    const seed = asMapping(asMapping(workflow.jobs)?.seed);
    const holdRun = String(
      namedStep(seed, "Establish needs-triage seed or re-triage hold").run,
    );
    const markerBody = `prior verdict\n${TRIAGE_COMMENT_MARKER}`;
    const result = runSeedHold(holdRun, {
      graphqlPages: [
        {
          data: {
            repository: {
              issue: {
                comments: {
                  nodes: Array.from({ length: 100 }, (_, index) => ({
                    fullDatabaseId: String(index + 1),
                    body: `comment ${index + 1}`,
                    author: { __typename: "User", login: "contributor" },
                  })),
                  pageInfo: { hasNextPage: true, endCursor: "opaque-next" },
                },
              },
            },
          },
        },
        {
          data: {
            repository: {
              issue: {
                comments: {
                  nodes: [
                    {
                      fullDatabaseId: "99",
                      body: markerBody,
                      author: { __typename: "Bot", login: "github-actions" },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      ],
    });

    expect(
      result.status,
      `${result.stdout}\n${result.stderr}\n${result.calls.join("\n")}`,
    ).toBe(0);
    const graphQlCalls = result.calls.filter((call) =>
      call.includes("api graphql"),
    );
    expect(graphQlCalls).toHaveLength(2);
    expect(graphQlCalls[1]).toContain("-f cursor=opaque-next");
    expect(
      result.calls.some(
        (call) =>
          call.includes("--method PATCH") &&
          call.includes("issues/comments/99"),
      ),
    ).toBe(true);
    expect(
      result.calls.some(
        (call) =>
          call.includes("--method POST") && call.includes("issues/42/comments"),
      ),
    ).toBe(false);
  });

  it("performs no mutation before issue-kind and open checks", () => {
    const workflow = parseWorkflow(TRIAGE_WORKFLOW_PATH);
    const seed = asMapping(asMapping(workflow.jobs)?.seed);
    const holdRun = String(
      namedStep(seed, "Establish needs-triage seed or re-triage hold").run,
    );
    for (const issue of [
      { state: "open", pull_request: { url: "https://example.invalid/pr" } },
      { state: "closed" },
    ]) {
      const result = runSeedHold(holdRun, { issue });
      expect(result.status).toBe(1);
      expect(writeCalls(result.calls)).toEqual([]);
      expect(result.calls).toHaveLength(1);
    }
  });

  it("withdraws stale readiness before creating and verifying a fresh hold", () => {
    const workflow = parseWorkflow(TRIAGE_WORKFLOW_PATH);
    const seed = asMapping(asMapping(workflow.jobs)?.seed);
    const holdRun = String(
      namedStep(seed, "Establish needs-triage seed or re-triage hold").run,
    );
    const result = runSeedHold(holdRun, {
      issue: {
        state: "open",
        labels: [
          { name: "ready-to-implement" },
          { name: "ready-to-spec" },
          { name: "epic:F1" },
        ],
      },
      heldIssue: {
        state: "open",
        labels: [{ name: "needs-triage" }, { name: "epic:F1" }],
      },
    });

    expect(
      result.status,
      `${result.stdout}\n${result.stderr}\n${result.calls.join("\n")}`,
    ).toBe(0);
    const readyDelete = result.calls.findIndex(
      (call) =>
        call.includes("--method DELETE") &&
        call.includes("labels/ready-to-implement"),
    );
    const needsPost = result.calls.findIndex(
      (call) =>
        call.includes("--method POST") &&
        call.includes("/labels") &&
        call.includes("needs-triage"),
    );
    const specDelete = result.calls.findIndex(
      (call) =>
        call.includes("--method DELETE") &&
        call.includes("labels/ready-to-spec"),
    );
    const commentPost = result.calls.findIndex(
      (call) =>
        call.includes("--method POST") && call.includes("issues/42/comments"),
    );
    expect(readyDelete).toBeLessThan(needsPost);
    expect(needsPost).toBeLessThan(specDelete);
    expect(specDelete).toBeLessThan(commentPost);
    expect(
      result.calls.some(
        (call) =>
          call.includes("--method PATCH") &&
          call.includes("issues/comments"),
      ),
    ).toBe(false);
    expect(result.commentBody).toBe(
      `${buildTriageGenerationMarker("hold:123.1")}\n${TRIAGE_COMMENT_MARKER}`,
    );
    expect(result.output).toContain("comment_id=99");
  });

  it("rejects duplicate generation history before any mutation", () => {
    const workflow = parseWorkflow(TRIAGE_WORKFLOW_PATH);
    const seed = asMapping(asMapping(workflow.jobs)?.seed);
    const holdRun = String(
      namedStep(seed, "Establish needs-triage seed or re-triage hold").run,
    );
    const owned = (id: string) => ({
      fullDatabaseId: id,
      body: TRIAGE_COMMENT_MARKER,
      author: { __typename: "Bot", login: "github-actions" },
    });
    const result = runSeedHold(holdRun, {
      graphqlPages: [
        {
          data: {
            repository: {
              issue: {
                comments: {
                  nodes: [owned("98"), owned("99")],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      ],
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("generation history ambiguous");
    expect(writeCalls(result.calls)).toEqual([]);
  });

  it("rejects duplicate generation history accumulated across pages", () => {
    const workflow = parseWorkflow(TRIAGE_WORKFLOW_PATH);
    const seed = asMapping(asMapping(workflow.jobs)?.seed);
    const holdRun = String(
      namedStep(seed, "Establish needs-triage seed or re-triage hold").run,
    );
    const owned = (id: string) => ({
      fullDatabaseId: id,
      body: TRIAGE_COMMENT_MARKER,
      author: { __typename: "Bot", login: "github-actions" },
    });
    const result = runSeedHold(holdRun, {
      graphqlPages: [
        graphQlCommentsPage([owned("98")], {
          hasNextPage: true,
          endCursor: "next",
        }),
        graphQlCommentsPage([owned("99")], {
          hasNextPage: false,
          endCursor: null,
        }),
      ],
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("generation history ambiguous");
    expect(writeCalls(result.calls)).toEqual([]);
  });

  it("rejects malformed comment scans before any mutation", () => {
    const workflow = parseWorkflow(TRIAGE_WORKFLOW_PATH);
    const seed = asMapping(asMapping(workflow.jobs)?.seed);
    const holdRun = String(
      namedStep(seed, "Establish needs-triage seed or re-triage hold").run,
    );
    const result = runSeedHold(holdRun, {
      graphqlPages: [{ errors: [{ message: "partial result" }] }],
    });

    expect(result.status).toBe(5);
    expect(result.stderr).toContain("GraphQL comment scan returned errors");
    expect(writeCalls(result.calls)).toEqual([]);
  });

  it("rejects a present null GraphQL errors field before any mutation", () => {
    const workflow = parseWorkflow(TRIAGE_WORKFLOW_PATH);
    const seed = asMapping(asMapping(workflow.jobs)?.seed);
    const holdRun = String(
      namedStep(seed, "Establish needs-triage seed or re-triage hold").run,
    );
    const result = runSeedHold(holdRun, {
      graphqlPages: [
        {
          errors: null,
          data: {
            repository: {
              issue: {
                comments: {
                  nodes: [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      ],
    });

    expect(result.status).toBe(5);
    expect(result.stderr).toContain("GraphQL comment scan returned errors");
    expect(writeCalls(result.calls)).toEqual([]);
  });

  it.each([
    {
      name: "non-array nodes",
      page: graphQlCommentsPage({}, {
        hasNextPage: false,
        endCursor: null,
      }),
      error: "invalid GraphQL comment scan response",
    },
    {
      name: "missing next-page cursor",
      page: graphQlCommentsPage([], {
        hasNextPage: true,
        endCursor: "",
      }),
      error: "invalid GraphQL comment scan response",
    },
    {
      name: "non-boolean next-page flag",
      page: graphQlCommentsPage([], {
        hasNextPage: "false",
        endCursor: null,
      }),
      error: "invalid GraphQL comment scan response",
    },
    {
      name: "non-string end cursor",
      page: graphQlCommentsPage([], {
        hasNextPage: false,
        endCursor: 7,
      }),
      error: "invalid GraphQL comment scan response",
    },
    {
      name: "non-string comment body",
      page: graphQlCommentsPage(
        [
          {
            fullDatabaseId: "99",
            body: 42,
            author: { __typename: "User", login: "contributor" },
          },
        ],
        { hasNextPage: false, endCursor: null },
      ),
      error: "invalid GraphQL comment scan response",
    },
    {
      name: "non-string author typename",
      page: graphQlCommentsPage(
        [
          {
            fullDatabaseId: "99",
            body: "ordinary comment",
            author: { __typename: 7, login: "contributor" },
          },
        ],
        { hasNextPage: false, endCursor: null },
      ),
      error: "invalid GraphQL comment scan response",
    },
    {
      name: "non-string author login",
      page: graphQlCommentsPage(
        [
          {
            fullDatabaseId: "99",
            body: "ordinary comment",
            author: { __typename: "User", login: null },
          },
        ],
        { hasNextPage: false, endCursor: null },
      ),
      error: "invalid GraphQL comment scan response",
    },
    {
      name: "non-canonical owned comment id",
      page: graphQlCommentsPage(
        [
          {
            fullDatabaseId: "01",
            body: TRIAGE_COMMENT_MARKER,
            author: { __typename: "Bot", login: "github-actions" },
          },
        ],
        { hasNextPage: false, endCursor: null },
      ),
      error: "invalid GraphQL comment id",
    },
  ])("rejects $name before any mutation", ({ page, error }) => {
    const workflow = parseWorkflow(TRIAGE_WORKFLOW_PATH);
    const seed = asMapping(asMapping(workflow.jobs)?.seed);
    const holdRun = String(
      namedStep(seed, "Establish needs-triage seed or re-triage hold").run,
    );
    const result = runSeedHold(holdRun, { graphqlPages: [page] });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(error);
    expect(writeCalls(result.calls)).toEqual([]);
  });

  it("rejects an unexhausted bounded scan before any mutation", () => {
    const workflow = parseWorkflow(TRIAGE_WORKFLOW_PATH);
    const seed = asMapping(asMapping(workflow.jobs)?.seed);
    const holdRun = String(
      namedStep(seed, "Establish needs-triage seed or re-triage hold").run,
    );
    const result = runSeedHold(holdRun, {
      graphqlPages: Array.from({ length: 50 }, (_, index) => ({
        data: {
          repository: {
            issue: {
              comments: {
                nodes: [],
                pageInfo: {
                  hasNextPage: true,
                  endCursor: `cursor-${index + 1}`,
                },
              },
            },
          },
        },
      })),
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      "could not exhaust triage comments within 5000 entries",
    );
    expect(writeCalls(result.calls)).toEqual([]);
  });

  it("does not write a comment until the readiness hold verifies", () => {
    const workflow = parseWorkflow(TRIAGE_WORKFLOW_PATH);
    const seed = asMapping(asMapping(workflow.jobs)?.seed);
    const holdRun = String(
      namedStep(seed, "Establish needs-triage seed or re-triage hold").run,
    );
    const result = runSeedHold(holdRun, {
      heldIssue: {
        state: "open",
        labels: [{ name: "ready-to-implement" }],
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toContain("readiness hold verification failed");
    expect(
      writeCalls(result.calls).some((call) => call.includes("/comments")),
    ).toBe(false);
  });

  it("writes provenance-filtered current issue context for triage", () => {
    const workflow = parseWorkflow(TRIAGE_WORKFLOW_PATH);
    const triage = asMapping(asMapping(workflow.jobs)?.triage);
    const step = namedStep(triage, "Write issue context for the triage skill");
    const environment = asMapping(step.env);
    const run = String(step.run);

    expect(environment).toMatchObject({
      GH_TOKEN: "${{ secrets.GITHUB_TOKEN }}",
      REPO: "${{ github.repository }}",
      ISSUE_NUMBER: "${{ github.event.issue.number }}",
    });
    expectOrdered(run, [
      'gh issue view "$ISSUE_NUMBER" --repo "$REPO"',
      "--json number,author,title,body,state,comments",
      "jq -cj -f .claude/skills/triage/authorized-comments.jq",
      "> issue-context/issue.json",
    ]);
    expect(run).not.toContain("github.event.issue.title");
    expect(run).not.toContain("github.event.issue.body");
    expect(
      stepIndex(triage, "Checkout roastpilot-cloud (read-only)"),
    ).toBeLessThan(stepIndex(triage, "Write issue context for the triage skill"));
    expect(
      stepIndex(triage, "Write issue context for the triage skill"),
    ).toBeLessThan(stepIndex(triage, "Run the triage skill"));
    expect(namedStep(triage, "Run the triage skill").with).toMatchObject({
      prompt: expect.stringContaining(
        "evaluate issue #${{ github.event.issue.number }}",
      ),
    });

    const skill = readFileSync(TRIAGE_SKILL_PATH, "utf8");
    expect(skill).toContain(
      "title, body, state, and provenance-tagged comments from",
    );
    expect(skill).toContain("`authorized_clarification`");
    expect(skill).toContain("`factory_triage_history`");
    expect(skill).toContain("more than 50 comments");
    expect(skill).toContain("exceeds 64 KiB");
    expect(skill).not.toContain("freshly-opened issue structurally has");
  });

  it("retains only authorized clarifications and authenticated history", () => {
    const input = {
      number: 51,
      author: { login: "issue-author" },
      title: "Current issue",
      body: "Body",
      state: "OPEN",
      comments: [
        {
          author: { login: "issue-author" },
          authorAssociation: "NONE",
          createdAt: "2026-07-24T10:00:00Z",
          body: "Author answer",
        },
        ...["OWNER", "MEMBER", "COLLABORATOR"].map(
          (authorAssociation, index) => ({
            author: { login: authorAssociation.toLowerCase() },
            authorAssociation,
            createdAt: `2026-07-24T10:0${index + 1}:00Z`,
            body: `${authorAssociation} answer`,
          }),
        ),
        {
          author: { login: "outsider" },
          authorAssociation: "NONE",
          createdAt: "2026-07-24T10:10:00Z",
          body: `Spoofed history\n${TRIAGE_COMMENT_MARKER}`,
        },
        ...["FIRST_TIMER", "FIRST_TIME_CONTRIBUTOR", "CONTRIBUTOR"].map(
          (authorAssociation, index) => ({
            author: { login: `outsider-${index}` },
            authorAssociation,
            createdAt: `2026-07-24T10:10:0${index + 1}Z`,
            body: `${authorAssociation} claim`,
          }),
        ),
        {
          author: { login: "github-actions" },
          authorAssociation: "NONE",
          createdAt: "2026-07-24T10:11:00Z",
          body: "Unmarked automation",
        },
        {
          author: { login: "github-actions" },
          authorAssociation: "NONE",
          createdAt: "2026-07-24T10:12:00Z",
          body: TRIAGE_COMMENT_MARKER,
        },
        {
          author: { login: "github-actions" },
          authorAssociation: "NONE",
          createdAt: "2026-07-24T10:13:00Z",
          body: `Prior verdict\n${TRIAGE_COMMENT_MARKER}`,
        },
        ...[
          `Embedded ${TRIAGE_COMMENT_MARKER} marker`,
          `${TRIAGE_COMMENT_MARKER}\ntrailing text`,
          "<!-- roastpilot-factory:triage-verdict:edited -->",
        ].map((body, index) => ({
          author: { login: "github-actions" },
          authorAssociation: "NONE",
          createdAt: `2026-07-24T10:14:0${index}Z`,
          body,
        })),
        {
          author: null,
          authorAssociation: "NONE",
          createdAt: "2026-07-24T10:15:00Z",
          body: "Deleted commenter",
        },
      ],
    };
    const output = JSON.parse(runFilter(input)) as {
      readonly number: number;
      readonly title: string;
      readonly body: string;
      readonly state: string;
      readonly comments: readonly unknown[];
    };

    expect(output).toMatchObject({
      number: 51,
      title: "Current issue",
      body: "Body",
      state: "OPEN",
    });
    expect(output.comments).toEqual([
      {
        kind: "authorized_clarification",
        author: "issue-author",
        author_association: "NONE",
        created_at: "2026-07-24T10:00:00Z",
        body: "Author answer",
      },
      ...["OWNER", "MEMBER", "COLLABORATOR"].map(
        (association, index) => ({
          kind: "authorized_clarification",
          author: association.toLowerCase(),
          author_association: association,
          created_at: `2026-07-24T10:0${index + 1}:00Z`,
          body: `${association} answer`,
        }),
      ),
      {
        kind: "factory_triage_history",
        author: "github-actions",
        author_association: "NONE",
        created_at: "2026-07-24T10:12:00Z",
        body: TRIAGE_COMMENT_MARKER,
      },
      {
        kind: "factory_triage_history",
        author: "github-actions",
        author_association: "NONE",
        created_at: "2026-07-24T10:13:00Z",
        body: `Prior verdict\n${TRIAGE_COMMENT_MARKER}`,
      },
    ]);
  });

  it("does not null-match a deleted issue author", () => {
    const output = JSON.parse(
      runFilter({
        number: 51,
        author: null,
        title: "Deleted author",
        body: "Body",
        state: "OPEN",
        comments: [
          {
            author: null,
            authorAssociation: "NONE",
            createdAt: "2026-07-24T11:00:00Z",
            body: "Deleted commenter",
          },
        ],
      }),
    ) as { readonly comments: readonly unknown[] };

    expect(output.comments).toEqual([]);
  });

  it("fails closed above the exact count or serialized-byte limits", () => {
    const base = {
      number: 51,
      author: { login: "issue-author" },
      title: "Bounded context",
      body: "Body",
      state: "OPEN",
    };
    const comment = (index: number, body = "ok") => ({
      author: { login: "issue-author" },
      authorAssociation: "NONE",
      createdAt: `2026-07-24T10:00:${String(index).padStart(2, "0")}Z`,
      body,
    });

    expect(() =>
      runFilter({
        ...base,
        comments: Array.from({ length: 51 }, (_, index) => comment(index)),
      }),
    ).toThrow(/50-comment limit/);
    expect(() =>
      runFilter({
        ...base,
        comments: Array.from({ length: 50 }, (_, index) => comment(index)),
      }),
    ).not.toThrow();

    const emptyOutput = JSON.parse(
      runFilter({ ...base, comments: [comment(0, "")] }),
    ) as { readonly comments: readonly [{ readonly body: string }] };
    const emptyBytes = Buffer.byteLength(JSON.stringify(emptyOutput));
    const exactBody = "x".repeat(65_536 - emptyBytes);
    const exactOutput = runFilter({
      ...base,
      comments: [comment(0, exactBody)],
    });
    expect(Buffer.byteLength(exactOutput)).toBe(65_536);
    expect(() =>
      runFilter({ ...base, comments: [comment(0, `${exactBody}x`)] }),
    ).toThrow(/65536-byte limit/);
  });

  it("uses the same bounded context for implementation", () => {
    const workflow = parseWorkflow(IMPLEMENT_WORKFLOW_PATH);
    const implement = asMapping(asMapping(workflow.jobs)?.implement);
    const step = namedStep(
      implement,
      "Fetch target issue, verify it is ready-to-implement, write context for the agent",
    );
    const run = String(step.run);

    expectOrdered(run, [
      'if ! [[ "$ISSUE_NUMBER" =~ ^[1-9][0-9]*$ ]]; then',
      "exit 1",
      "--json number,author,title,body,state,labels,comments",
      `state=$(echo "$issue_json" | jq -r '.state')`,
      `labels=$(echo "$issue_json" | jq -r`,
      `if [ "$state" != "OPEN" ]; then`,
      "exit 1",
      `if ! echo ",$labels," | grep -q ",ready-to-implement,"; then`,
      "exit 1",
      "jq -cj -f .claude/skills/triage/authorized-comments.jq",
      "> issue-context/issue.json",
    ]);
    expect(implement?.outputs).toBeUndefined();
    expect(
      stepIndex(implement, "Checkout roastpilot-cloud (read-only)"),
    ).toBeLessThan(
      stepIndex(
        implement,
        "Fetch target issue, verify it is ready-to-implement, write context for the agent",
      ),
    );
    expect(
      stepIndex(
        implement,
        "Fetch target issue, verify it is ready-to-implement, write context for the agent",
      ),
    ).toBeLessThan(stepIndex(implement, "Run the implement agent"));
    expect(namedStep(implement, "Run the implement agent").with).toMatchObject({
      prompt: expect.stringContaining(
        "provenance-filtered authorized clarifications",
      ),
    });

    const publish = asMapping(asMapping(workflow.jobs)?.publish);
    expect(asMapping(publish?.concurrency)).toEqual({
      group: "factory-issue-privileged-${{ inputs.issue_number }}",
      queue: "max",
    });
    expect(
      asMapping(
        namedStep(publish, "Validate and publish the implement patch").env,
      ),
    ).not.toHaveProperty("EXPECTED_TRIAGE_GENERATION");
  });

  it("serializes only privileged issue mutations across both workflows", () => {
    const triageWorkflow = parseWorkflow(TRIAGE_WORKFLOW_PATH);
    const triageJobs = asMapping(triageWorkflow.jobs);
    const seed = asMapping(triageJobs?.seed);
    const triage = asMapping(triageJobs?.triage);
    const apply = asMapping(triageJobs?.apply);
    const sharedGroup =
      "factory-issue-privileged-${{ github.event.issue.number }}";

    expect(triageWorkflow.concurrency).toEqual({
      group: "triage-issue-${{ github.event.issue.number }}",
      "cancel-in-progress": false,
    });
    expect(asMapping(seed?.concurrency)).toEqual({
      group: sharedGroup,
      queue: "max",
    });
    expect(triage?.concurrency).toBeUndefined();
    expect(asMapping(apply?.concurrency)).toEqual({
      group: sharedGroup,
      queue: "max",
    });
  });

  it("preserves pause handling without activating manual dispatch", () => {
    const workflow = parseWorkflow(TRIAGE_WORKFLOW_PATH);
    const jobs = asMapping(workflow.jobs);

    expect(asMapping(jobs?.["pause-notice"])?.if).toBe(
      "vars.FACTORY_PAUSED == 'true'",
    );
    expect(asMapping(jobs?.seed)?.if).toBe(
      "vars.FACTORY_PAUSED != 'true'",
    );
    expect(asMapping(jobs?.triage)?.if).toBe(
      "vars.FACTORY_PAUSED != 'true'",
    );
    expect(asMapping(jobs?.apply)?.if).toBe(
      "always() && needs.seed.result == 'success' && vars.FACTORY_PAUSED != 'true'",
    );
    const runbook = readFileSync(RUNBOOK_PATH, "utf8");
    expect(runbook).not.toContain("gh workflow run triage-issues.yml");
  });

  it("denies triage-sanitizer edits in the implementing agent", () => {
    const workflow = parseWorkflow(IMPLEMENT_WORKFLOW_PATH);
    const implement = asMapping(asMapping(workflow.jobs)?.implement);
    const agent = namedStep(implement, "Run the implement agent");
    const withBlock = asMapping(agent.with);
    const args = String(withBlock?.claude_args);
    const prompt = String(withBlock?.prompt);

    for (const tool of ["Edit", "Write", "MultiEdit"]) {
      expect(args).toContain(`${tool}(.claude/skills/triage/**)`);
    }
    expect(prompt).toContain(".claude/skills/triage/**");
    expect(prompt).toContain("executable input sanitizer");
  });
});
