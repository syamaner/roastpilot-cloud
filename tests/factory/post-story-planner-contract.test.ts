import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type GithubRequest,
  main,
  sanitizeContractForPosting,
  validateStoryPlannerContract,
} from "../../scripts/factory/post-story-planner-contract.mts";

const ISSUE_NUMBER = 17;
const REPOSITORY = "syamaner/roastpilot-cloud";
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

function stubPublisherEnvironment(
  contract = buildContract(),
  issueNumber = String(ISSUE_NUMBER),
): void {
  writeFileSync(contractPath, contract, "utf8");
  vi.stubEnv("GH_TOKEN", "test-token");
  vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
  vi.stubEnv("TARGET_ISSUE_NUMBER", issueNumber);
  vi.stubEnv("CONTRACT_PATH", contractPath);
}

function mockRequest(issueResponse: unknown): {
  readonly request: GithubRequest;
  readonly mock: ReturnType<typeof vi.fn>;
} {
  const mock = vi.fn(async (...call: RequestCall): Promise<unknown> => {
    const [, method] = call;
    if (method === "GET") {
      return issueResponse;
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
});

describe("main", () => {
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

  it("rechecks ready-to-spec and posts exactly one sanitized contract", async () => {
    const contract = withRegion(0, "Alpha beta gamma @codex review.");
    stubPublisherEnvironment(contract);
    const { request, mock } = mockRequest({
      labels: [{ name: "triaged" }, { name: "ready-to-spec" }],
    });

    await main(request);

    expect(mock).toHaveBeenCalledTimes(2);
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
      "POST",
      `/repos/syamaner/roastpilot-cloud/issues/${ISSUE_NUMBER}/comments`,
      { body: sanitizeContractForPosting(contract) },
    );
    const postedBody = mock.mock.calls[1]?.[3] as { readonly body: string };
    expect(postedBody.body).toContain("[codex trigger removed]");
    expect(postedBody.body).not.toContain("@codex review");
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
