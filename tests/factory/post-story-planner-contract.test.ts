import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_SPEC_GROUNDING_SUMMARY_COMMENT_LENGTH } from "../../scripts/factory/github-comment-limit.mts";
import { canonicalIssueRevision } from "../../scripts/factory/approve-revision.mts";
import {
  STORY_PLANNER_CONTRACT_MARKER,
  type GithubRequest,
  main,
  sanitizeContractForPosting,
  validateStoryPlannerContract,
} from "../../scripts/factory/post-story-planner-contract.mts";

const ISSUE_NUMBER = 17;
const REPOSITORY = "syamaner/roastpilot-cloud";
const VALID_UPDATED_AT = "2026-08-27T12:34:56Z";
const ISSUE_TITLE = "Current REST issue title";
const ISSUE_BODY = "Current REST issue body";
const ISSUE_REVISION = canonicalIssueRevision(ISSUE_TITLE, ISSUE_BODY);
const CONTRACT_EXCERPT_MAX_BYTES = 32_000;
const MARKERS = [
  "<!-- contract:spec -->",
  "<!-- contract:tests -->",
  "<!-- contract:pr-plan -->",
  "<!-- contract:routing -->",
] as const;
const VALID_REGIONS = [
  "Alpha beta gamma requirements.",
  "- Reject malformed payload safely.",
  "First second third review unit.",
  "Schema privacy reviewer routing.",
] as const;

type RequestCall = readonly [
  token: string,
  method: string,
  path: string,
  body?: unknown,
];

let temporaryDirectory: string;
let contractPath: string;
let revisionPath: string;

function sentinel(issueNumber = ISSUE_NUMBER): string {
  return `CONTRACT-COMPLETE: story-planner contract finished (issue #${issueNumber})`;
}

function buildContract(options: {
  readonly issueNumber?: number;
  readonly regions?: readonly string[];
  readonly markerOrder?: readonly string[];
  readonly suffix?: readonly string[];
} = {}): string {
  const regions = options.regions ?? VALID_REGIONS;
  const markerOrder = options.markerOrder ?? MARKERS;
  const sections = markerOrder.flatMap((marker, index) => [
    marker,
    regions[index] ?? VALID_REGIONS[index]!,
  ]);
  return [
    ...sections,
    sentinel(options.issueNumber),
    ...(options.suffix ?? []),
    "",
  ].join("\n");
}

function withRegion(index: number, region: string): string {
  const regions: string[] = [...VALID_REGIONS];
  regions[index] = region;
  return buildContract({ regions });
}

function contractWithFinalBodyLength(targetLength: number): string {
  const marker = STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER, ISSUE_REVISION);
  const seed = withRegion(0, "Alpha beta gamma requirements.");
  const seedFinalLength = `${sanitizeContractForPosting(seed)}\n${marker}`.length;
  if (targetLength < seedFinalLength) {
    throw new Error("target final body length is shorter than the valid contract seed");
  }
  return withRegion(
    0,
    `Alpha beta gamma requirements.${"x".repeat(targetLength - seedFinalLength)}`,
  );
}

function contractWithFinalSerializedBodyLength(targetLength: number): string {
  const marker = STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER, ISSUE_REVISION);
  const seed = withRegion(0, "Alpha beta gamma requirements.");
  const seedFinalBody = `${sanitizeContractForPosting(seed)}\n${marker}`;
  const seedSerializedLength = Buffer.byteLength(JSON.stringify(seedFinalBody));
  if (targetLength < seedSerializedLength) {
    throw new Error("target serialized body length is shorter than the valid contract seed");
  }
  return withRegion(
    0,
    `Alpha beta gamma requirements.${"x".repeat(targetLength - seedSerializedLength)}`,
  );
}

function stubPublisherEnvironment(
  contract = buildContract(),
  issueNumber = String(ISSUE_NUMBER),
  preparedRevision = ISSUE_REVISION,
): void {
  writeFileSync(contractPath, contract, "utf8");
  vi.stubEnv("GH_TOKEN", "test-token");
  vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
  vi.stubEnv("TARGET_ISSUE_NUMBER", issueNumber);
  vi.stubEnv("CONTRACT_PATH", contractPath);
  writeFileSync(
    revisionPath,
    JSON.stringify({
      issueNumber: ISSUE_NUMBER,
      updatedAt: VALID_UPDATED_AT,
      preparedRevision,
    }),
    "utf8",
  );
  vi.stubEnv("REVISION_PATH", revisionPath);
}

function mockRequest(
  issueResponse: unknown,
  commentPages: readonly (readonly unknown[])[] = [[]],
  subsequentIssueResponses: readonly unknown[] = [],
): {
  readonly request: GithubRequest;
  readonly mock: ReturnType<typeof vi.fn>;
} {
  let issueGetIndex = 0;
  const issueResponses = [issueResponse, ...subsequentIssueResponses];
  const mock = vi.fn(async (...call: RequestCall): Promise<unknown> => {
    const [, method, path] = call;
    if (method === "GET" && path.includes("/comments?")) {
      const page = Number(new URL(path, "https://api.github.test").searchParams.get("page"));
      return commentPages[page - 1] ?? [];
    }
    if (method === "GET") {
      const selectedIssueResponse =
        issueResponses[Math.min(issueGetIndex++, issueResponses.length - 1)];
      return typeof selectedIssueResponse === "object" && selectedIssueResponse !== null
        ? {
            title: ISSUE_TITLE,
            body: ISSUE_BODY,
            updated_at: VALID_UPDATED_AT,
            ...selectedIssueResponse,
          }
        : selectedIssueResponse;
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

function expectNoPost(mock: ReturnType<typeof vi.fn>): void {
  expect(mock.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(0);
}

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "story-planner-publisher-"));
  contractPath = join(temporaryDirectory, "contract.md");
  revisionPath = join(temporaryDirectory, "revision.json");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

describe("validateStoryPlannerContract", () => {
  it("rejects a malformed revision when constructing the trusted marker", () => {
    expect(() => STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER, "not-a-digest")).toThrow(
      "story-planner contract revision must be a SHA-256 hex digest",
    );
  });

  it("accepts a well-formed issue-bound contract", () => {
    expect(() => validateStoryPlannerContract(buildContract(), ISSUE_NUMBER)).not.toThrow();
  });

  it("rejects a missing terminal sentinel", () => {
    const contract = buildContract().replace(`${sentinel()}\n`, "");
    expect(() => validateStoryPlannerContract(contract, ISSUE_NUMBER)).toThrow(
      "terminal sentinel must appear exactly once",
    );
  });

  it("rejects a duplicate terminal sentinel", () => {
    const contract = buildContract({ suffix: [sentinel()] });
    expect(() => validateStoryPlannerContract(contract, ISSUE_NUMBER)).toThrow(
      "terminal sentinel must appear exactly once",
    );
  });

  it("rejects a sentinel bound to a different issue number", () => {
    expect(() => validateStoryPlannerContract(buildContract(), ISSUE_NUMBER + 1)).toThrow(
      "terminal sentinel must appear exactly once",
    );
  });

  it("rejects content after the single issue-bound sentinel", () => {
    const contract = buildContract({ suffix: ["unexpected trailing content"] });
    expect(() => validateStoryPlannerContract(contract, ISSUE_NUMBER)).toThrow(
      "contract is missing the issue-bound terminal sentinel as its final non-empty line",
    );
  });

  it.each(MARKERS)("rejects a missing required marker: %s", (marker) => {
    const contract = buildContract().replace(`${marker}\n`, "");
    expect(() => validateStoryPlannerContract(contract, ISSUE_NUMBER)).toThrow(
      `contract must contain ${marker} exactly once`,
    );
  });

  it.each(MARKERS)("rejects a duplicate required marker: %s", (marker) => {
    const contract = buildContract().replace(marker, `${marker}\n${marker}`);
    expect(() => validateStoryPlannerContract(contract, ISSUE_NUMBER)).toThrow(
      `contract must contain ${marker} exactly once`,
    );
  });

  it("rejects required markers in the wrong order", () => {
    const markerOrder = [MARKERS[0], MARKERS[2], MARKERS[1], MARKERS[3]];
    expect(() =>
      validateStoryPlannerContract(buildContract({ markerOrder }), ISSUE_NUMBER),
    ).toThrow("contract markers are not in the required order");
  });

  it("accepts a region with at least three distinct case-folded words", () => {
    expect(() =>
      validateStoryPlannerContract(withRegion(0, "Alpha alpha beta gamma"), ISSUE_NUMBER),
    ).not.toThrow();
  });

  it.each([
    ["fewer than three distinct words", "one two"],
    ["comment-only content", "<!-- alpha beta gamma -->"],
    ["one repeated word", "x x x"],
    ["comments plus fewer than three visible words", "<!-- alpha beta gamma --> one two"],
  ])("rejects a vacuous region with %s", (_label, region) => {
    expect(() => validateStoryPlannerContract(withRegion(0, region), ISSUE_NUMBER)).toThrow(
      `contract region after ${MARKERS[0]} is empty or vacuous`,
    );
  });

  it("rejects a substantive tests region without a Markdown bullet", () => {
    const contract = withRegion(1, "Negative malformed payload cases documented.");
    expect(() => validateStoryPlannerContract(contract, ISSUE_NUMBER)).toThrow(
      "contract tests region must contain at least one Markdown test bullet",
    );
  });

  it("rejects a substantive tests region without a negative-case indicator", () => {
    const contract = withRegion(1, "- Valid payload succeeds safely.");
    expect(() => validateStoryPlannerContract(contract, ISSUE_NUMBER)).toThrow(
      "contract tests region must contain a negative-case indicator",
    );
  });

  it("B-C1: accepts a visible Markdown bullet with a negative case", () => {
    expect(() =>
      validateStoryPlannerContract(
        withRegion(1, "Context covers expected behavior.\n- Must fail malformed payloads."),
        ISSUE_NUMBER,
      ),
    ).not.toThrow();
  });

  it("GUARD-C1: rejects a test bullet that exists only inside an HTML comment", () => {
    expect(() =>
      validateStoryPlannerContract(
        withRegion(
          1,
          "Visible negative cases documented.\n<!--\n- Reject malformed payload\n-->",
        ),
        ISSUE_NUMBER,
      ),
    ).toThrow("contract tests region must contain at least one Markdown test bullet");
  });

  it("GUARD-C2: rejects a negative token that exists only inside an HTML comment", () => {
    expect(() =>
      validateStoryPlannerContract(
        withRegion(1, "- Valid payload behavior documented.\n<!-- reject -->"),
        ISSUE_NUMBER,
      ),
    ).toThrow("contract tests region must contain a negative-case indicator");
  });

  it.each([
    ["fewer than three distinct words", "one two"],
    ["comment-only content", "<!-- alpha beta gamma -->"],
    ["one repeated word", "x x x"],
    ["comments plus two visible words", "<!-- alpha beta gamma --> one two"],
  ])("B-C2: keeps the isSubstantive vacuity rejection for %s", (_label, region) => {
    expect(() => validateStoryPlannerContract(withRegion(0, region), ISSUE_NUMBER)).toThrow(
      `contract region after ${MARKERS[0]} is empty or vacuous`,
    );
  });

  it("N-I8/GUARD-I3: rejects a model-authored reserved marker prefix", () => {
    const contract = withRegion(
      0,
      "Alpha beta gamma <!-- story-planner-contract:issue-17 -->",
    );
    expect(() => validateStoryPlannerContract(contract, ISSUE_NUMBER)).toThrow(
      "contract contains the reserved story-planner contract marker prefix",
    );
  });

  it.each(["<!-- escalate:question -->", "<!-- story-planner-escalate:issue-17 -->"])(
    "G3: rejects the escalation marker prefix %s in a contract",
    (marker) => {
      // Mutation witness: removing either symmetric disjointness guard accepts this contract.
      expect(() =>
        validateStoryPlannerContract(
          withRegion(0, `Alpha beta gamma ${marker}`),
          ISSUE_NUMBER,
        ),
      ).toThrow("contract contains a reserved story-planner escalation marker prefix");
    },
  );
});

describe("main", () => {
  it("T-C1: posts a final sanitized contract body at the triage excerpt limit", async () => {
    const contract = contractWithFinalSerializedBodyLength(
      CONTRACT_EXCERPT_MAX_BYTES,
    );
    const finalBody =
      `${sanitizeContractForPosting(contract)}\n${STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER, ISSUE_REVISION)}`;
    stubPublisherEnvironment(contract);
    const { request, mock } = mockRequest({ labels: [{ name: "ready-to-spec" }] });

    expect(Buffer.byteLength(JSON.stringify(finalBody))).toBe(
      CONTRACT_EXCERPT_MAX_BYTES,
    );
    await main(request);

    const posts = mock.mock.calls.filter((call) => call[1] === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.[3]).toEqual({ body: finalBody });
  });

  it("rejects an escape-heavy contract over the excerpt budget before POST", async () => {
    const contract = withRegion(
      0,
      `Alpha beta gamma requirements.${'"'.repeat(16_000)}`,
    );
    stubPublisherEnvironment(contract);
    const { request, mock } = mockRequest({ labels: [{ name: "ready-to-spec" }] });

    await expect(main(request)).rejects.toThrow(
      /serialized comment length .* exceeds triage excerpt limit 32000/u,
    );
    expect(mock).toHaveBeenCalledTimes(2);
    expectNoPost(mock);
  });

  it("T-C2: rejects an oversized final body before POST", async () => {
    const actualLength = MAX_SPEC_GROUNDING_SUMMARY_COMMENT_LENGTH + 1;
    const contract = contractWithFinalBodyLength(actualLength);
    stubPublisherEnvironment(contract);
    const { request, mock } = mockRequest({ labels: [{ name: "ready-to-spec" }] });

    const rejection = main(request).catch((error: unknown) => error);
    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      `story-planner contract comment length ${actualLength} exceeds GitHub comment limit ${MAX_SPEC_GROUNDING_SUMMARY_COMMENT_LENGTH}`,
    );
    expect((error as Error).message).not.toContain(contract);
    expect(mock).toHaveBeenCalledTimes(2);
    expectNoPost(mock);
  });

  it("T-H2-match: matching prepared and current revisions bind the posted marker", async () => {
    const contract = buildContract();
    stubPublisherEnvironment(contract);
    const { request, mock } = mockRequest({ labels: [{ name: "ready-to-spec" }] });

    await main(request);

    expect(
      mock.mock.calls.filter(
        (call) => call[1] === "GET" && !String(call[2]).includes("/comments?"),
      ),
    ).toHaveLength(2);
    const posts = mock.mock.calls.filter((call) => call[1] === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.[3]).toEqual({
      body:
        `${sanitizeContractForPosting(contract)}\n` +
        STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER, ISSUE_REVISION),
    });
  });

  it("rejects an edit after dedup at the final pre-POST revision check", async () => {
    stubPublisherEnvironment();
    const { request, mock } = mockRequest(
      { labels: [{ name: "ready-to-spec" }] },
      [[]],
      [{
        labels: [{ name: "ready-to-spec" }],
        title: "Edited after the dedup scan",
      }],
    );

    await expect(main(request)).rejects.toThrow(
      "issue was modified after planning (revision binding mismatch); refusing to post a contract planned against stale content",
    );
    expect(
      mock.mock.calls.filter(
        (call) => call[1] === "GET" && !String(call[2]).includes("/comments?"),
      ),
    ).toHaveLength(2);
    expectNoPost(mock);
  });

  it("rejects a non-string title from the final pre-POST re-fetch", async () => {
    stubPublisherEnvironment();
    const { request, mock } = mockRequest(
      { labels: [{ name: "ready-to-spec" }] },
      [[]],
      [{ labels: [{ name: "ready-to-spec" }], title: 42 }],
    );

    await expect(main(request)).rejects.toThrow(
      "issue title is malformed; refusing to publish",
    );
    expectNoPost(mock);
  });

  it("rejects a non-string, non-null body from the final pre-POST re-fetch", async () => {
    stubPublisherEnvironment();
    const { request, mock } = mockRequest(
      { labels: [{ name: "ready-to-spec" }] },
      [[]],
      [{ labels: [{ name: "ready-to-spec" }], body: { malformed: true } }],
    );

    await expect(main(request)).rejects.toThrow(
      "issue body is malformed; refusing to publish",
    );
    expectNoPost(mock);
  });

  it.each([
    ["missing", undefined],
    ["non-string", 42],
    ["outside the closed grammar", "2026-08-27T12:34:56.000Z"],
  ])(
    "rejects a %s updated_at from the final pre-POST re-fetch",
    async (_label, updatedAt) => {
      stubPublisherEnvironment();
      const { request, mock } = mockRequest(
        { labels: [{ name: "ready-to-spec" }] },
        [[]],
        [{ labels: [{ name: "ready-to-spec" }], updated_at: updatedAt }],
      );

      await expect(main(request)).rejects.toThrow(
        "issue updated_at is malformed; refusing to publish",
      );
      expectNoPost(mock);
    },
  );

  it("rejects an updated_at mismatch at the final pre-POST revision check", async () => {
    stubPublisherEnvironment();
    const { request, mock } = mockRequest(
      { labels: [{ name: "ready-to-spec" }] },
      [[]],
      [{
        labels: [{ name: "ready-to-spec" }],
        updated_at: "2026-08-27T12:34:57Z",
      }],
    );

    await expect(main(request)).rejects.toThrow(
      "issue was modified after planning (revision binding mismatch); refusing to post a contract planned against stale content",
    );
    expectNoPost(mock);
  });

  it("T-A2: rejects a stale captured revision without making a POST", async () => {
    stubPublisherEnvironment();
    const { request, mock } = mockRequest({
      labels: [{ name: "ready-to-spec" }],
      updated_at: "2026-08-27T12:34:57Z",
    });

    await expect(main(request)).rejects.toThrow(
      "issue was modified after planning (revision binding mismatch); refusing to post a contract planned against stale content",
    );
    expectNoPost(mock);
  });

  it.each([
    ["a missing file", null, VALID_UPDATED_AT],
    ["non-JSON content", "{not-json", VALID_UPDATED_AT],
    [
      "an open shape with an extra property",
      JSON.stringify({
        issueNumber: ISSUE_NUMBER,
        updatedAt: VALID_UPDATED_AT,
        preparedRevision: ISSUE_REVISION,
        extra: true,
      }),
      VALID_UPDATED_AT,
    ],
    [
      "an updatedAt outside the closed timestamp grammar",
      JSON.stringify({
        issueNumber: ISSUE_NUMBER,
        updatedAt: "2026-08-27T12:34:56.000Z",
        preparedRevision: ISSUE_REVISION,
      }),
      "2026-08-27T12:34:56.000Z",
    ],
    [
      "a missing preparedRevision",
      JSON.stringify({ issueNumber: ISSUE_NUMBER, updatedAt: VALID_UPDATED_AT }),
      VALID_UPDATED_AT,
    ],
    [
      "a non-hex preparedRevision",
      JSON.stringify({
        issueNumber: ISSUE_NUMBER,
        updatedAt: VALID_UPDATED_AT,
        preparedRevision: "not-a-digest",
      }),
      VALID_UPDATED_AT,
    ],
  ])(
    "T-A3: rejects revision.json with %s without making a POST",
    async (_label, revisionContents, issueUpdatedAt) => {
      stubPublisherEnvironment();
      if (revisionContents === null) {
        rmSync(revisionPath);
      } else {
        writeFileSync(revisionPath, revisionContents, "utf8");
      }
      const { request, mock } = mockRequest({
        labels: [{ name: "ready-to-spec" }],
        updated_at: issueUpdatedAt,
      });

      await expect(main(request)).rejects.toThrow();
      expectNoPost(mock);
    },
  );

  it("rejects a missing REVISION_PATH environment variable without making a POST", async () => {
    stubPublisherEnvironment();
    vi.stubEnv("REVISION_PATH", "");
    const { request, mock } = mockRequest({ labels: [{ name: "ready-to-spec" }] });

    await expect(main(request)).rejects.toThrow(
      "missing required environment variable: REVISION_PATH",
    );
    expectNoPost(mock);
  });

  it.each([
    ["an absent updated_at", undefined],
    ["an updated_at outside the closed timestamp grammar", "2026-08-27T12:34:56.000Z"],
  ])("T-A4: rejects issue GET with %s without making a POST", async (_label, updatedAt) => {
    stubPublisherEnvironment();
    const { request, mock } = mockRequest({
      labels: [{ name: "ready-to-spec" }],
      updated_at: updatedAt,
    });

    await expect(main(request)).rejects.toThrow(
      "issue updated_at is malformed; refusing to publish",
    );
    expectNoPost(mock);
  });

  it.each([undefined, 42, { unexpected: "shape" }])(
    "rejects a non-string REST issue body %j without making a POST",
    async (body) => {
      stubPublisherEnvironment();
      const { request, mock } = mockRequest({
        labels: [{ name: "ready-to-spec" }],
        body,
      });

      await expect(main(request)).rejects.toThrow(
        "issue body is malformed; refusing to publish",
      );
      expectNoPost(mock);
    },
  );

  it.each([undefined, null, 42])(
    "rejects a malformed REST issue title %j without making a POST",
    async (title) => {
      stubPublisherEnvironment();
      const { request, mock } = mockRequest({
        labels: [{ name: "ready-to-spec" }],
        title,
      });

      await expect(main(request)).rejects.toThrow(
        "issue title is malformed; refusing to publish",
      );
      expectNoPost(mock);
    },
  );

  it("posts a null-body issue contract with the empty-body revision", async () => {
    const contract = buildContract();
    const nullBodyRevision = canonicalIssueRevision(ISSUE_TITLE, null);
    stubPublisherEnvironment(contract, String(ISSUE_NUMBER), nullBodyRevision);
    const { request, mock } = mockRequest({
      labels: [{ name: "ready-to-spec" }],
      body: null,
    });

    await main(request);

    const post = mock.mock.calls.find((call) => call[1] === "POST");
    const body = (post?.[3] as { readonly body: string }).body;
    expect(body).toBe(
      `${sanitizeContractForPosting(contract)}\n${STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER, nullBodyRevision)}`,
    );
  });

  it.each(["01", "1.0", "abc"])(
    "rejects non-canonical TARGET_ISSUE_NUMBER %j before making a request",
    async (issueNumber) => {
      stubPublisherEnvironment(buildContract(), issueNumber);
      const { request, mock } = mockRequest({ labels: [{ name: "ready-to-spec" }] });

      await expect(main(request)).rejects.toThrow(
        "TARGET_ISSUE_NUMBER must be a canonical positive decimal integer",
      );
      expect(mock).not.toHaveBeenCalled();
    },
  );

  it("rejects an empty TARGET_ISSUE_NUMBER at the required-env boundary", async () => {
    stubPublisherEnvironment(buildContract(), "");
    const { request, mock } = mockRequest({ labels: [{ name: "ready-to-spec" }] });

    await expect(main(request)).rejects.toThrow(
      "missing required environment variable: TARGET_ISSUE_NUMBER",
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it("rejects a positive decimal beyond Number's safe integer range", async () => {
    stubPublisherEnvironment(buildContract(), "9007199254740992");
    const { request, mock } = mockRequest({ labels: [{ name: "ready-to-spec" }] });

    await expect(main(request)).rejects.toThrow(
      "TARGET_ISSUE_NUMBER exceeds JavaScript's safe integer range",
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it("rejects a non-canonical repository before making a request", async () => {
    stubPublisherEnvironment();
    vi.stubEnv("GITHUB_REPOSITORY", "owner/repo/extra");
    const { request, mock } = mockRequest({ labels: [{ name: "ready-to-spec" }] });

    await expect(main(request)).rejects.toThrow(
      'GITHUB_REPOSITORY must be canonical "owner/repo"',
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it("T-H3-no-marker/GUARD-I1: first publication performs one comment GET and one POST", async () => {
    const contract = withRegion(0, "Alpha beta gamma @codex review.");
    stubPublisherEnvironment(contract);
    const { request, mock } = mockRequest({
      labels: [{ name: "triaged" }, { name: "ready-to-spec" }],
    });

    await main(request);

    expect(mock).toHaveBeenCalledTimes(4);
    expect(mock).toHaveBeenNthCalledWith(
      1,
      "test-token",
      "GET",
      `/repos/syamaner/roastpilot-cloud/issues/${ISSUE_NUMBER}`,
      undefined,
    );
    expect(mock).toHaveBeenNthCalledWith(
      2,
      "test-token",
      "GET",
      `/repos/syamaner/roastpilot-cloud/issues/${ISSUE_NUMBER}/comments?per_page=100&page=1`,
      undefined,
    );
    expect(mock).toHaveBeenNthCalledWith(
      3,
      "test-token",
      "GET",
      `/repos/syamaner/roastpilot-cloud/issues/${ISSUE_NUMBER}`,
      undefined,
    );
    expect(mock).toHaveBeenNthCalledWith(
      4,
      "test-token",
      "POST",
      `/repos/syamaner/roastpilot-cloud/issues/${ISSUE_NUMBER}/comments`,
      {
        body:
          sanitizeContractForPosting(contract) +
          "\n" +
          STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER, ISSUE_REVISION),
      },
    );
    const commentGets = mock.mock.calls.filter(
      (call) => call[1] === "GET" && String(call[2]).includes("/comments?"),
    );
    expect(commentGets).toHaveLength(1);
    const postedBody = mock.mock.calls[3]?.[3] as { readonly body: string };
    expect(postedBody.body).toContain("[codex trigger removed]");
    expect(postedBody.body).not.toContain("@codex review");
  });

  it("T-H3-recovery: posts when a bot-authored marker has a stale revision", async () => {
    stubPublisherEnvironment();
    const priorRevision = canonicalIssueRevision(
      "prior title revision",
      "prior body revision",
    );
    const { request, mock } = mockRequest(
      { labels: [{ name: "ready-to-spec" }] },
      [[{
        body: `prior contract\n${STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER, priorRevision)}`,
        user: { type: "Bot", login: "github-actions[bot]" },
      }]],
    );

    await main(request);

    const posts = mock.mock.calls.filter((call) => call[1] === "POST");
    expect(posts).toHaveLength(1);
    expect((posts[0]?.[3] as { readonly body: string }).body).toContain(
      STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER, ISSUE_REVISION),
    );
  });

  it("T-H3-malformed-marker rejects a malformed bot marker without POST", async () => {
    stubPublisherEnvironment();
    const { request, mock } = mockRequest(
      { labels: [{ name: "ready-to-spec" }] },
      [[{
        body: `contract\n<!-- story-planner-contract:issue-${ISSUE_NUMBER}:rev-bad -->`,
        user: { type: "Bot", login: "github-actions[bot]" },
      }]],
    );

    await expect(main(request)).rejects.toThrow(
      "malformed story-planner contract marker",
    );
    expectNoPost(mock);
  });

  it("GUARD-I4: a bot-authored mid-body marker cannot suppress publication", async () => {
    stubPublisherEnvironment();
    const marker = STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER, ISSUE_REVISION);
    const { request, mock } = mockRequest(
      { labels: [{ name: "ready-to-spec" }] },
      [[{
        body: `Triage reasoning:\n\`\`\`text\n${marker}\n\`\`\`\nVerdict follows.`,
        user: { type: "Bot", login: "github-actions[bot]" },
      }]],
    );

    await main(request);

    expect(mock.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
  });

  it("B-I3: appends the trusted marker byte-unchanged after sanitized model text", async () => {
    const contract = withRegion(0, "Alpha beta gamma @codex review.");
    stubPublisherEnvironment(contract);
    const { request, mock } = mockRequest({ labels: [{ name: "ready-to-spec" }] });

    await main(request);

    const post = mock.mock.calls.find((call) => call[1] === "POST");
    const body = (post?.[3] as { readonly body: string }).body;
    const marker = STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER, ISSUE_REVISION);
    expect(body).toBe(`${sanitizeContractForPosting(contract)}\n${marker}`);
    expect(body.endsWith(marker)).toBe(true);
    expect(body).toContain(
      `:rev-${canonicalIssueRevision(ISSUE_TITLE, ISSUE_BODY)} -->`,
    );
  });

  it.each([
    ["title", "Edited REST title", ISSUE_BODY],
    ["body", ISSUE_TITLE, "Edited REST body"],
  ])("T-H2-samesecond rejects a same-timestamp %s edit", async (_field, title, issueBody) => {
    stubPublisherEnvironment();
    const { request, mock } = mockRequest({
      labels: [{ name: "ready-to-spec" }],
      title,
      body: issueBody,
    });

    await expect(main(request)).rejects.toThrow(
      "issue was modified after planning (revision binding mismatch)",
    );
    expect(canonicalIssueRevision(title, issueBody)).not.toBe(ISSUE_REVISION);
    expectNoPost(mock);
  });

  it("B-I4: a marker for another issue does not suppress this issue", async () => {
    stubPublisherEnvironment();
    const { request, mock } = mockRequest(
      { labels: [{ name: "ready-to-spec" }] },
      [[{
        body: STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER + 1, ISSUE_REVISION),
        user: { type: "Bot", login: "github-actions[bot]" },
      }]],
    );

    await main(request);

    expect(mock.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
  });

  it("T-H3-dedup: finds a current-revision bot marker on page two and skips", async () => {
    stubPublisherEnvironment();
    const fullFirstPage = Array.from({ length: 100 }, () => ({
      body: "ordinary comment",
      user: { type: "User", login: "someone" },
    }));
    const { request, mock } = mockRequest(
      { labels: [{ name: "ready-to-spec" }] },
      [fullFirstPage, [{
        body: STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER, ISSUE_REVISION),
        user: { type: "Bot", login: "github-actions[bot]" },
      }]],
    );

    await main(request);

    expectNoPost(mock);
    expect(
      mock.mock.calls.filter(
        (call) => call[1] === "GET" && String(call[2]).includes("/comments?"),
      ),
    ).toHaveLength(2);
  });

  it("continues after a full comment page and stops on a shorter page", async () => {
    stubPublisherEnvironment();
    const fullFirstPage = Array.from({ length: 100 }, () => ({
      body: "ordinary comment",
      user: { type: "User", login: "someone" },
    }));
    const { request, mock } = mockRequest(
      { labels: [{ name: "ready-to-spec" }] },
      [fullFirstPage, [{
        body: "short final page",
        user: { type: "User", login: "someone" },
      }]],
    );

    await main(request);

    expect(
      mock.mock.calls.filter(
        (call) => call[1] === "GET" && String(call[2]).includes("/comments?"),
      ),
    ).toHaveLength(2);
    expect(mock.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
  });

  it("deduplicates a marker found during a fully saturated bounded scan", async () => {
    stubPublisherEnvironment();
    const ordinaryFullPage = Array.from({ length: 100 }, () => ({
      body: "ordinary comment",
      user: { type: "User", login: "someone" },
    }));
    const markerFullPage = [
      {
        body: STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER, ISSUE_REVISION),
        user: { type: "Bot", login: "github-actions[bot]" },
      },
      ...ordinaryFullPage.slice(1),
    ];
    const { request, mock } = mockRequest(
      { labels: [{ name: "ready-to-spec" }] },
      [markerFullPage, ...Array.from({ length: 49 }, () => ordinaryFullPage)],
    );

    await main(request);

    expect(
      mock.mock.calls.filter(
        (call) => call[1] === "GET" && String(call[2]).includes("/comments?"),
      ),
    ).toHaveLength(50);
    expectNoPost(mock);
  });

  it("N-I6: posts with a warning after the bounded comment scan is exhausted", async () => {
    stubPublisherEnvironment();
    const fullPage = Array.from({ length: 100 }, () => ({
      body: "ordinary comment",
      user: { type: "User", login: "someone" },
    }));
    const { request, mock } = mockRequest(
      { labels: [{ name: "ready-to-spec" }] },
      Array.from({ length: 50 }, () => fullPage),
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await main(request);

    expect(mock.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Scanned 50 pages of comments"),
    );
  });

  it.each([
    ["human author", { type: "User", login: "github-actions[bot]" }],
    ["different bot", { type: "Bot", login: "other-bot[bot]" }],
    ["missing author", null],
  ])("N-I7/GUARD-I2: %s with the marker does not suppress publication", async (_label, user) => {
    stubPublisherEnvironment();
    const { request, mock } = mockRequest(
      { labels: [{ name: "ready-to-spec" }] },
      [[{ body: STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER, ISSUE_REVISION), user }]],
    );

    await main(request);

    expect(mock.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
  });

  it("rejects when ready-to-spec was withdrawn and makes no POST", async () => {
    stubPublisherEnvironment();
    const { request, mock } = mockRequest({ labels: [{ name: "triaged" }] });

    await expect(main(request)).rejects.toThrow(
      "ready-to-spec was withdrawn before publish; refusing to post a stale contract",
    );
    expect(mock).toHaveBeenCalledTimes(1);
    expectNoPost(mock);
  });

  it.each([
    ["a primitive response", "malformed"],
    ["a null response", null],
    ["a missing labels field", {}],
    ["a non-array labels field", { labels: "ready-to-spec" }],
  ])("rejects malformed issue GET data with %s and makes no POST", async (_label, issue) => {
    stubPublisherEnvironment();
    const { request, mock } = mockRequest(issue);

    await expect(main(request)).rejects.toThrow(
      "issue labels response is malformed; refusing to publish",
    );
    expect(mock).toHaveBeenCalledTimes(1);
    expectNoPost(mock);
  });

  it.each([
    ["a primitive label", "ready-to-spec"],
    ["a null label", null],
    ["a label without name", {}],
    ["a label with non-string name", { name: 7 }],
  ])("rejects malformed label data with %s and makes no POST", async (_label, label) => {
    stubPublisherEnvironment();
    const { request, mock } = mockRequest({ labels: [label] });

    await expect(main(request)).rejects.toThrow(
      "issue labels response is malformed; refusing to publish",
    );
    expect(mock).toHaveBeenCalledTimes(1);
    expectNoPost(mock);
  });
});
