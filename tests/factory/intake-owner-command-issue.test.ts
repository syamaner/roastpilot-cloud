import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeApprovedRevision } from "../../scripts/factory/approve-revision.mts";
import {
  main,
  type GithubRequest,
} from "../../scripts/factory/intake-owner-command-issue.mts";

const REPOSITORY = "syamaner/roastpilot-cloud";
const ISSUE_NUMBER = 390;
const COMMENT_ID = 1234;
let temporaryDirectory: string;
let outputPath: string;

beforeEach(() => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "owner-issue-intake-"));
  outputPath = join(temporaryDirectory, "output");
  vi.stubEnv("GH_TOKEN", "test-token");
  vi.stubEnv("GITHUB_REPOSITORY", REPOSITORY);
  vi.stubEnv("TARGET_ISSUE_NUMBER", String(ISSUE_NUMBER));
  vi.stubEnv("COMMENT_ID", String(COMMENT_ID));
  vi.stubEnv("GITHUB_OUTPUT", outputPath);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(temporaryDirectory, { recursive: true, force: true });
});

function requestFor(
  comment: unknown,
  overrides: { issue?: unknown; repository?: unknown } = {},
): {
  request: GithubRequest;
  calls: string[];
} {
  const calls: string[] = [];
  const request: GithubRequest = async <T>(
    _token: string,
    method: string,
    path: string,
  ): Promise<T> => {
    calls.push(`${method} ${path}`);
    const response = path.endsWith(`/issues/comments/${COMMENT_ID}`)
      ? comment
      : path.endsWith(`/issues/${ISSUE_NUMBER}`)
        ? "issue" in overrides
          ? overrides.issue
          : { state: "open", body: "reviewed issue body" }
        : "repository" in overrides
          ? overrides.repository
          : { full_name: REPOSITORY, fork: false };
    return response as T;
  };
  return { request, calls };
}

describe("issue owner-command intake entrypoint", () => {
  it("re-fetches all authorization records and emits approve outputs", async () => {
    vi.stubEnv("GITHUB_EVENT_ISSUE_BODY", "stale webhook issue body");
    const { request, calls } = requestFor({
      body: "@claude approve",
      user: { login: "syamaner" },
    });

    await main(request);

    expect(calls.sort()).toEqual([
      `GET /repos/${REPOSITORY}`,
      `GET /repos/${REPOSITORY}/issues/${ISSUE_NUMBER}`,
      `GET /repos/${REPOSITORY}/issues/comments/${COMMENT_ID}`,
    ].sort());
    expect(readFileSync(outputPath, "utf8")).toBe(
      "proceed=true\nverb=approve\napproved_revision=" +
        `${computeApprovedRevision("reviewed issue body")}\n`,
    );
  });

  it("does not emit an approved revision for respec", async () => {
    const { request } = requestFor({
      body: "@claude respec",
      user: { login: "syamaner" },
    });

    await main(request);

    expect(readFileSync(outputPath, "utf8")).toBe(
      "proceed=true\nverb=respec\n",
    );
  });

  it("emits only proceed false for an ineligible fetched author", async () => {
    const { request } = requestFor({
      body: "@claude approve",
      user: { login: "attacker" },
    });

    await main(request);

    expect(readFileSync(outputPath, "utf8")).toBe("proceed=false\n");
  });

  it("fails closed on a non-string fetched issue body for approve", async () => {
    const { request } = requestFor(
      { body: "@claude approve", user: { login: "syamaner" } },
      { issue: { state: "open", body: null } },
    );

    await expect(main(request)).rejects.toThrow(TypeError);
    expect(() => readFileSync(outputPath, "utf8")).toThrow();
  });

  it("throws loudly for a malformed fetched comment", async () => {
    const { request } = requestFor({ body: "@claude approve" });
    await expect(main(request)).rejects.toThrow(TypeError);
  });

  it("throws loudly for a malformed fetched top-level record", async () => {
    const { request } = requestFor(
      { body: "@claude approve", user: { login: "syamaner" } },
      { repository: null },
    );
    await expect(main(request)).rejects.toThrow(TypeError);
  });

  it.each([
    ["GITHUB_REPOSITORY", "not-a-repository"],
    ["TARGET_ISSUE_NUMBER", "0"],
    ["COMMENT_ID", "9007199254740992"],
  ])("rejects malformed locator environment %s", async (name, value) => {
    vi.stubEnv(name, value);
    const { request } = requestFor({
      body: "@claude approve",
      user: { login: "syamaner" },
    });
    await expect(main(request)).rejects.toThrow(Error);
  });
});
