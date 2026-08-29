import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_SPEC_GROUNDING_SUMMARY_COMMENT_LENGTH } from "../../scripts/factory/github-comment-limit.mts";
import {
  STORY_PLANNER_CONTRACT_MARKER,
  STORY_PLANNER_ESCALATE_MARKER,
  type GithubRequest,
  main,
  sanitizeContractForPosting,
  validateStoryPlannerEscalation,
} from "../../scripts/factory/post-story-planner-contract.mts";

const ISSUE_NUMBER = 17;
const REPOSITORY = "syamaner/roastpilot-cloud";
const VALID_UPDATED_AT = "2026-08-27T12:34:56Z";
const TRUSTED_ESCALATION_LINE =
  "This is a re-scoping question, not an authorization: no label has been changed and no work is authorized by this comment.";

type RequestCall = readonly [
  token: string,
  method: string,
  path: string,
  body?: unknown,
];

let temporaryDirectory: string;
let contractPath: string;
let escalatePath: string;
let revisionPath: string;

function escalationSentinel(issueNumber = ISSUE_NUMBER): string {
  return `ESCALATE-COMPLETE: story-planner escalation finished (issue #${issueNumber})`;
}

function buildEscalation(options: {
  readonly issueNumber?: number;
  readonly question?: string;
  readonly suffix?: readonly string[];
} = {}): string {
  return [
    "<!-- escalate:question -->",
    options.question ?? "Which bounded implementation scope should the planner contract?",
    escalationSentinel(options.issueNumber),
    ...(options.suffix ?? []),
    "",
  ].join("\n");
}

function contractSentinel(): string {
  return `CONTRACT-COMPLETE: story-planner contract finished (issue #${ISSUE_NUMBER})`;
}

function buildContract(): string {
  return [
    "<!-- contract:spec -->",
    "Alpha beta gamma requirements.",
    "<!-- contract:tests -->",
    "- Reject malformed payload safely.",
    "<!-- contract:pr-plan -->",
    "First second third review unit.",
    "<!-- contract:routing -->",
    "Schema privacy reviewer routing.",
    contractSentinel(),
    "",
  ].join("\n");
}

function stubPublisherEnvironment(): void {
  vi.stubEnv("GH_TOKEN", "test-token");
  vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
  vi.stubEnv("TARGET_ISSUE_NUMBER", String(ISSUE_NUMBER));
  vi.stubEnv("CONTRACT_PATH", contractPath);
  vi.stubEnv("ESCALATE_PATH", escalatePath);
  vi.stubEnv("REVISION_PATH", revisionPath);
  writeFileSync(
    revisionPath,
    JSON.stringify({ issueNumber: ISSUE_NUMBER, updatedAt: VALID_UPDATED_AT }),
    "utf8",
  );
}

function mockRequest(
  issueResponse: unknown = { labels: [{ name: "ready-to-spec" }] },
  commentPages: readonly (readonly unknown[])[] = [[]],
): {
  readonly request: GithubRequest;
  readonly mock: ReturnType<typeof vi.fn>;
} {
  const mock = vi.fn(async (...call: RequestCall): Promise<unknown> => {
    const [, method, path] = call;
    if (method === "GET" && path.includes("/comments?")) {
      const page = Number(new URL(path, "https://api.github.test").searchParams.get("page"));
      return commentPages[page - 1] ?? [];
    }
    if (method === "GET") {
      return typeof issueResponse === "object" && issueResponse !== null
        ? { updated_at: VALID_UPDATED_AT, ...issueResponse }
        : issueResponse;
    }
    if (method === "POST") {
      return { id: 123 };
    }
    throw new Error(`unexpected method ${method}`);
  });
  const request: GithubRequest = async <T>(
    token: string,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> => mock(token, method, path, body) as Promise<T>;
  return { request, mock };
}

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "story-planner-escalate-"));
  contractPath = join(temporaryDirectory, "contract.md");
  escalatePath = join(temporaryDirectory, "escalate.md");
  revisionPath = join(temporaryDirectory, "revision.json");
  stubPublisherEnvironment();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("validateStoryPlannerEscalation", () => {
  it("accepts one substantive issue-bound question", () => {
    expect(() =>
      validateStoryPlannerEscalation(buildEscalation(), ISSUE_NUMBER),
    ).not.toThrow();
  });

  it.each([
    "<!-- contract:spec -->",
    "<!-- story-planner-contract:issue-17 -->",
    "<!-- story-planner-escalate:issue-17 -->",
  ])("G2: rejects reserved marker prefix %s", (marker) => {
    // Mutation witness: removing the matching reserved-prefix guard accepts this forgery.
    expect(() =>
      validateStoryPlannerEscalation(
        buildEscalation({ question: `Which bounded scope applies? ${marker}` }),
        ISSUE_NUMBER,
      ),
    ).toThrow("escalation contains a reserved story-planner marker prefix");
  });

  it("rejects a missing question marker", () => {
    // Mutation witness: removing the exactly-once guard accepts a markerless question.
    const escalation = buildEscalation().replace("<!-- escalate:question -->\n", "");
    expect(() => validateStoryPlannerEscalation(escalation, ISSUE_NUMBER)).toThrow(
      "escalation must contain <!-- escalate:question --> exactly once",
    );
  });

  it("rejects a duplicate question marker", () => {
    // Mutation witness: checking only indexOf would accept the duplicate region marker.
    const escalation = buildEscalation().replace(
      "<!-- escalate:question -->",
      "<!-- escalate:question -->\n<!-- escalate:question -->",
    );
    expect(() => validateStoryPlannerEscalation(escalation, ISSUE_NUMBER)).toThrow(
      "escalation must contain <!-- escalate:question --> exactly once",
    );
  });

  it("rejects a vacuous question region", () => {
    // Mutation witness: removing isSubstantive accepts comment-only model output.
    expect(() =>
      validateStoryPlannerEscalation(
        buildEscalation({ question: "<!-- hidden substantive words only -->" }),
        ISSUE_NUMBER,
      ),
    ).toThrow("escalation region after <!-- escalate:question --> is empty or vacuous");
  });

  it.each([
    ["missing", (value: string) => value.replace(`${escalationSentinel()}\n`, "")],
    ["duplicate", (value: string) => value.replace(escalationSentinel(), `${escalationSentinel()}\n${escalationSentinel()}`)],
    ["not-final-line", (value: string) => value.replace(`${escalationSentinel()}\n`, `${escalationSentinel()}\ntrailing model text\n`)],
  ])("G6: rejects a %s escalation sentinel", (_shape, mutate) => {
    // Mutation witness: removing the count/final-line checks accepts one of these malformed sentinels.
    expect(() => validateStoryPlannerEscalation(mutate(buildEscalation()), ISSUE_NUMBER)).toThrow();
  });

  it("rejects a sentinel bound to another issue", () => {
    // Mutation witness: omitting issue binding accepts a question authored for another issue.
    expect(() => validateStoryPlannerEscalation(buildEscalation(), ISSUE_NUMBER + 1)).toThrow(
      "escalation terminal sentinel must appear exactly once",
    );
  });
});

describe("main escalation precedence and publication", () => {
  it("G4a: valid contract wins when both files exist", async () => {
    // Mutation witness: checking escalation first posts the wrong model output.
    writeFileSync(contractPath, buildContract(), "utf8");
    writeFileSync(escalatePath, buildEscalation(), "utf8");
    const { request, mock } = mockRequest();

    await main(request);

    const posts = mock.mock.calls.filter((call) => call[1] === "POST");
    expect(posts).toHaveLength(1);
    const body = (posts[0]?.[3] as { readonly body: string }).body;
    expect(body).toBe(
      `${sanitizeContractForPosting(buildContract())}\n${STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER)}`,
    );
    expect(body).not.toContain("<!-- escalate:question -->");
  });

  it("G4b: invalid present contract fails closed without consulting a valid escalation", async () => {
    // Mutation witness: falling through after contract validation failure posts the escalation.
    writeFileSync(contractPath, "invalid contract", "utf8");
    writeFileSync(escalatePath, buildEscalation(), "utf8");
    const { request, mock } = mockRequest();

    await expect(main(request)).rejects.toThrow("terminal sentinel must appear exactly once");
    expect(mock).not.toHaveBeenCalled();
  });

  it("G4c: rejects when neither output file exists", async () => {
    // Mutation witness: removing the terminal throw silently succeeds without operator output.
    const { request, mock } = mockRequest();
    await expect(main(request)).rejects.toThrow(
      "story-planner produced neither a contract nor an escalation file",
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it("G4c/G5: only-valid-escalate posts one sanitized question and never writes labels", async () => {
    // Mutation witness: adding the contract label mutation creates a PUT/labels call caught here.
    const escalation = buildEscalation({
      question: "Which bounded scope handles @codex review safely?",
    });
    writeFileSync(escalatePath, escalation, "utf8");
    const { request, mock } = mockRequest();

    await main(request);

    const posts = mock.mock.calls.filter((call) => call[1] === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.[2]).toBe(
      `/repos/syamaner/roastpilot-cloud/issues/${ISSUE_NUMBER}/comments`,
    );
    expect(posts[0]?.[3]).toEqual({
      body:
        `${sanitizeContractForPosting(escalation)}\n` +
        `${TRUSTED_ESCALATION_LINE}\n` +
        STORY_PLANNER_ESCALATE_MARKER(ISSUE_NUMBER),
    });
    expect(mock.mock.calls.some((call) => call[1] === "PUT")).toBe(false);
    expect(mock.mock.calls.some((call) => String(call[2]).includes("/labels"))).toBe(false);
    expect(mock).toHaveBeenCalledTimes(3);
  });

  it("G-escalate-label-withdrawn: refuses to post after ready-to-spec is withdrawn", async () => {
    // Mutation witness: removing the shared readiness check lets this escalation post.
    writeFileSync(escalatePath, buildEscalation(), "utf8");
    const { request, mock } = mockRequest({ labels: [{ name: "triaged" }] });

    await expect(main(request)).rejects.toThrow(
      "ready-to-spec was withdrawn before publish; refusing to post a stale contract",
    );

    expect(mock.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(0);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("G-escalate-not-revision-bound: posts despite a captured-revision mismatch", async () => {
    // Mutation witness: adding contract-style revision binding to escalation fails this test.
    writeFileSync(escalatePath, buildEscalation(), "utf8");
    const { request, mock } = mockRequest({
      labels: [{ name: "ready-to-spec" }],
      updated_at: "2026-08-27T12:34:57Z",
    });

    await main(request);

    expect(mock.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
  });

  it("rejects an oversized escalation before any GitHub request", async () => {
    // Mutation witness: removing the escalation length cap attempts the comment scan.
    const marker = STORY_PLANNER_ESCALATE_MARKER(ISSUE_NUMBER);
    const seed = buildEscalation();
    const seedLength =
      `${sanitizeContractForPosting(seed)}\n${TRUSTED_ESCALATION_LINE}\n${marker}`.length;
    const escalation = buildEscalation({
      question:
        "Which bounded implementation scope should the planner contract?" +
        "x".repeat(MAX_SPEC_GROUNDING_SUMMARY_COMMENT_LENGTH + 1 - seedLength),
    });
    writeFileSync(escalatePath, escalation, "utf8");
    const { request, mock } = mockRequest();

    await expect(main(request)).rejects.toThrow(
      `story-planner escalation comment length ${MAX_SPEC_GROUNDING_SUMMARY_COMMENT_LENGTH + 1} exceeds GitHub comment limit ${MAX_SPEC_GROUNDING_SUMMARY_COMMENT_LENGTH}`,
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it("G7: an exact bot-authored escalation marker makes a rerun post nothing", async () => {
    // Mutation witness: using the contract marker for escalation idempotency posts a duplicate.
    writeFileSync(escalatePath, buildEscalation(), "utf8");
    const escalationMarker = STORY_PLANNER_ESCALATE_MARKER(ISSUE_NUMBER);
    const contractMarker = STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER);
    const { request, mock } = mockRequest(undefined, [[{
      body: `prior question\n${escalationMarker}`,
      user: { type: "Bot", login: "github-actions[bot]" },
    }]]);

    expect(escalationMarker).not.toBe(contractMarker);
    expect(escalationMarker).toContain("story-planner-escalate:");
    expect(contractMarker).toContain("story-planner-contract:");
    await main(request);

    expect(mock.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(0);
    expect(mock).toHaveBeenCalledTimes(2);
  });
});
