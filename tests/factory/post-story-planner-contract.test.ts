import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_SPEC_GROUNDING_SUMMARY_COMMENT_LENGTH } from "../../scripts/factory/github-comment-limit.mts";
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
  const marker = STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER);
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

function stubPublisherEnvironment(
  contract = buildContract(),
  issueNumber = String(ISSUE_NUMBER),
): void {
  writeFileSync(contractPath, contract, "utf8");
  vi.stubEnv("GH_TOKEN", "test-token");
  vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
  vi.stubEnv("TARGET_ISSUE_NUMBER", issueNumber);
  vi.stubEnv("CONTRACT_PATH", contractPath);
  writeFileSync(
    revisionPath,
    JSON.stringify({ issueNumber: ISSUE_NUMBER, updatedAt: VALID_UPDATED_AT }),
    "utf8",
  );
  vi.stubEnv("REVISION_PATH", revisionPath);
}

function mockRequest(
  issueResponse: unknown,
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
});

describe("main", () => {
  it("T-C1: posts a final sanitized contract body at the GitHub comment limit", async () => {
    const contract = contractWithFinalBodyLength(
      MAX_SPEC_GROUNDING_SUMMARY_COMMENT_LENGTH,
    );
    const finalBody =
      `${sanitizeContractForPosting(contract)}\n${STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER)}`;
    stubPublisherEnvironment(contract);
    const { request, mock } = mockRequest({ labels: [{ name: "ready-to-spec" }] });

    expect(finalBody).toHaveLength(MAX_SPEC_GROUNDING_SUMMARY_COMMENT_LENGTH);
    await main(request);

    const posts = mock.mock.calls.filter((call) => call[1] === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.[3]).toEqual({ body: finalBody });
  });

  it("T-C2: rejects an oversized final body before any GitHub request", async () => {
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
    expect(mock).not.toHaveBeenCalled();
    expectNoPost(mock);
  });

  it("T-A1: matching captured and current revisions permit one issue GET and one POST", async () => {
    stubPublisherEnvironment();
    const { request, mock } = mockRequest({ labels: [{ name: "ready-to-spec" }] });

    await main(request);

    expect(
      mock.mock.calls.filter(
        (call) => call[1] === "GET" && !String(call[2]).includes("/comments?"),
      ),
    ).toHaveLength(1);
    expect(mock.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
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
      JSON.stringify({ issueNumber: ISSUE_NUMBER, updatedAt: VALID_UPDATED_AT, extra: true }),
      VALID_UPDATED_AT,
    ],
    [
      "an updatedAt outside the closed timestamp grammar",
      JSON.stringify({ issueNumber: ISSUE_NUMBER, updatedAt: "2026-08-27T12:34:56.000Z" }),
      "2026-08-27T12:34:56.000Z",
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

  it("B-I1/GUARD-I1: first publication performs one comment GET and one POST", async () => {
    const contract = withRegion(0, "Alpha beta gamma @codex review.");
    stubPublisherEnvironment(contract);
    const { request, mock } = mockRequest({
      labels: [{ name: "triaged" }, { name: "ready-to-spec" }],
    });

    await main(request);

    expect(mock).toHaveBeenCalledTimes(3);
    expect(mock).toHaveBeenNthCalledWith(
      1,
      "test-token",
      "GET",
      `/repos/syamaner/roastpilot-cloud/issues/${ISSUE_NUMBER}/comments?per_page=100&page=1`,
      undefined,
    );
    expect(mock).toHaveBeenNthCalledWith(
      2,
      "test-token",
      "GET",
      `/repos/syamaner/roastpilot-cloud/issues/${ISSUE_NUMBER}`,
      undefined,
    );
    expect(mock).toHaveBeenNthCalledWith(
      3,
      "test-token",
      "POST",
      `/repos/syamaner/roastpilot-cloud/issues/${ISSUE_NUMBER}/comments`,
      {
        body:
          sanitizeContractForPosting(contract) +
          "\n" +
          STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER),
      },
    );
    const commentGets = mock.mock.calls.filter(
      (call) => call[1] === "GET" && String(call[2]).includes("/comments?"),
    );
    expect(commentGets).toHaveLength(1);
    const postedBody = mock.mock.calls[2]?.[3] as { readonly body: string };
    expect(postedBody.body).toContain("[codex trigger removed]");
    expect(postedBody.body).not.toContain("@codex review");
  });

  it("B-I2/GUARD-I1: skips when the exact bot-authored issue marker is present", async () => {
    stubPublisherEnvironment();
    const { request, mock } = mockRequest(
      { labels: [{ name: "ready-to-spec" }] },
      [[{
        body: `prior contract\n${STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER)}`,
        user: { type: "Bot", login: "github-actions[bot]" },
      }]],
    );

    await main(request);

    expectNoPost(mock);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith(
      "test-token",
      "GET",
      `/repos/syamaner/roastpilot-cloud/issues/${ISSUE_NUMBER}/comments?per_page=100&page=1`,
      undefined,
    );
    expect(console.log).toHaveBeenCalledWith(
      `contract already posted on #${ISSUE_NUMBER}; skipping`,
    );
  });

  it("GUARD-I4: a bot-authored mid-body marker cannot suppress publication", async () => {
    stubPublisherEnvironment();
    const marker = STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER);
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
    const marker = STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER);
    expect(body).toBe(`${sanitizeContractForPosting(contract)}\n${marker}`);
    expect(body.endsWith(marker)).toBe(true);
    expect(body.match(/<!-- story-planner-contract:issue-17 -->/g)).toHaveLength(1);
  });

  it("B-I4: a marker for another issue does not suppress this issue", async () => {
    stubPublisherEnvironment();
    const { request, mock } = mockRequest(
      { labels: [{ name: "ready-to-spec" }] },
      [[{
        body: STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER + 1),
        user: { type: "Bot", login: "github-actions[bot]" },
      }]],
    );

    await main(request);

    expect(mock.mock.calls.filter((call) => call[1] === "POST")).toHaveLength(1);
  });

  it("B-I5: finds a bot-authored marker on comment page two and skips", async () => {
    stubPublisherEnvironment();
    const fullFirstPage = Array.from({ length: 100 }, () => ({
      body: "ordinary comment",
      user: { type: "User", login: "someone" },
    }));
    const { request, mock } = mockRequest(
      { labels: [{ name: "ready-to-spec" }] },
      [fullFirstPage, [{
        body: STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER),
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
      [[{ body: STORY_PLANNER_CONTRACT_MARKER(ISSUE_NUMBER), user }]],
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
    expect(mock).toHaveBeenCalledTimes(2);
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
    expect(mock).toHaveBeenCalledTimes(2);
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
    expect(mock).toHaveBeenCalledTimes(2);
    expectNoPost(mock);
  });
});
