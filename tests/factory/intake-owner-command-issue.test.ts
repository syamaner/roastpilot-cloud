import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  computeApprovedRevision,
} from "../../scripts/factory/approve-revision.mts";
import {
  main,
  type GithubGraphql,
  type GithubRequest,
} from "../../scripts/factory/intake-owner-command-issue.mts";

const REPOSITORY = "syamaner/roastpilot-cloud";
const ISSUE_NUMBER = 390;
const COMMENT_ID = 1234;
const COMMENT_CREATED_AT = "2026-08-28T10:00:00Z";
const REST_BODY = "Exact REST issue body\nwith bytes preserved.";
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
  overrides: {
    issue?: unknown;
    repository?: unknown;
    graphql?: unknown;
    graphqlError?: Error;
  } = {},
): {
  request: GithubRequest;
  graphql: GithubGraphql;
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
          : { state: "open", body: REST_BODY }
        : "repository" in overrides
          ? overrides.repository
          : { full_name: REPOSITORY, fork: false };
    return response as T;
  };
  const graphql: GithubGraphql = async <T>(
    _token: string,
    query: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<T> => {
    calls.push(`GRAPHQL ${query} ${JSON.stringify(variables)}`);
    if (overrides.graphqlError) throw overrides.graphqlError;
    return ("graphql" in overrides
      ? overrides.graphql
      : {
          repository: {
            issue: {
              userContentEdits: {
                nodes: [],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        }) as T;
  };
  return { request, graphql, calls };
}

function ownerComment(
  body = "@claude approve",
  createdAt = COMMENT_CREATED_AT,
): unknown {
  return {
    body,
    created_at: createdAt,
    user: { login: "syamaner" },
  };
}

describe("issue owner-command intake entrypoint", () => {
  it("re-fetches all authorization records and emits approve outputs", async () => {
    const { request, graphql, calls } = requestFor(ownerComment());

    await main(request, graphql);

    expect(calls.slice(0, 3).sort()).toEqual([
      `GET /repos/${REPOSITORY}`,
      `GET /repos/${REPOSITORY}/issues/${ISSUE_NUMBER}`,
      `GET /repos/${REPOSITORY}/issues/comments/${COMMENT_ID}`,
    ].sort());
    expect(calls[3]).toBe(
      "GRAPHQL query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){userContentEdits(first:100){nodes{editedAt}pageInfo{hasNextPage}}}}} " +
        JSON.stringify({
          owner: "syamaner",
          repo: "roastpilot-cloud",
          number: ISSUE_NUMBER,
        }),
    );
    expect(readFileSync(outputPath, "utf8")).toBe(
      `proceed=true\nverb=approve\napproved_revision=${computeApprovedRevision(REST_BODY)}\n`,
    );
  });

  it.each([
    ["same-second", COMMENT_CREATED_AT],
    ["strictly after", "2026-08-28T10:00:00.001Z"],
  ])("M-B1 fails closed for a body edit %s the approve comment", async (_name, editedAt) => {
    const { request, graphql } = requestFor(ownerComment(), {
      graphql: {
        repository: {
          issue: {
            userContentEdits: {
              nodes: [{ editedAt }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    });

    await main(request, graphql);

    expect(readFileSync(outputPath, "utf8")).toBe("proceed=false\n");
  });

  it("parses explicit positive and negative offsets as the same absolute timeline", async () => {
    const { request, graphql } = requestFor(
      ownerComment("@claude approve", "2026-08-28T10:00:00+02:00"),
      {
        graphql: {
          repository: {
            issue: {
              userContentEdits: {
                nodes: [{ editedAt: "2026-08-28T02:59:59-05:00" }],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      },
    );

    await main(request, graphql);

    expect(readFileSync(outputPath, "utf8")).toContain("proceed=true\n");
  });

  it("fails closed for an equal absolute timestamp across explicit offsets", async () => {
    const { request, graphql } = requestFor(
      ownerComment("@claude approve", "2026-08-28T10:00:00+02:00"),
      {
        graphql: {
          repository: {
            issue: {
              userContentEdits: {
                nodes: [{ editedAt: "2026-08-28T03:00:00-05:00" }],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      },
    );

    await main(request, graphql);

    expect(readFileSync(outputPath, "utf8")).toBe("proceed=false\n");
  });

  it.each([
    ["accepts leap-year February 29", "2024-03-01T00:00:00Z", "2024-02-29T23:59:59Z", true],
    ["rejects non-leap-year February 29", "2023-03-01T00:00:00Z", "2023-02-29T23:59:59Z", false],
  ])("%s", async (_name, createdAt, editedAt, shouldProceed) => {
    const { request, graphql } = requestFor(
      ownerComment("@claude approve", createdAt),
      {
        graphql: {
          repository: {
            issue: {
              userContentEdits: {
                nodes: [{ editedAt }],
                pageInfo: { hasNextPage: false },
              },
            },
          },
        },
      },
    );

    await main(request, graphql);

    expect(readFileSync(outputPath, "utf8")).toBe(
      shouldProceed
        ? `proceed=true\nverb=approve\napproved_revision=${computeApprovedRevision(REST_BODY)}\n`
        : "proceed=false\n",
    );
  });

  it.each([
    ["month zero", "2026-00-01T00:00:00Z"],
    ["month thirteen", "2026-13-01T00:00:00Z"],
    ["day zero", "2026-01-00T00:00:00Z"],
    ["day beyond a 30-day month", "2026-04-31T00:00:00Z"],
    ["hour 24", "2026-01-01T24:00:00Z"],
    ["minute 60", "2026-01-01T00:60:00Z"],
    ["second 60", "2026-01-01T00:00:60Z"],
    ["offset hour 24", "2026-01-01T00:00:00+24:00"],
    ["offset minute 60", "2026-01-01T00:00:00-00:60"],
  ])("rejects an editedAt with %s", async (_name, editedAt) => {
    const { request, graphql } = requestFor(ownerComment(), {
      graphql: {
        repository: {
          issue: {
            userContentEdits: {
              nodes: [{ editedAt }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    });

    await main(request, graphql);

    expect(readFileSync(outputPath, "utf8")).toBe("proceed=false\n");
  });

  it("allows title-only edits and body edits strictly before review", async () => {
    const { request, graphql } = requestFor(ownerComment(), {
      graphql: {
        repository: {
          issue: {
            renamedTitleEvents: [{ createdAt: "2026-08-28T10:01:00Z" }],
            userContentEdits: {
              nodes: [{ editedAt: "2026-08-28T09:59:59Z" }],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    });

    await main(request, graphql);

    expect(readFileSync(outputPath, "utf8")).toContain(
      `approved_revision=${computeApprovedRevision(REST_BODY)}\n`,
    );
  });

  it("hashes the REST body, never a GraphQL body", async () => {
    const graphqlBody = "different GraphQL representation";
    const { request, graphql } = requestFor(ownerComment(), {
      graphql: {
        repository: {
          issue: {
            body: graphqlBody,
            userContentEdits: {
              nodes: [],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    });

    await main(request, graphql);

    const output = readFileSync(outputPath, "utf8");
    expect(output).toContain(computeApprovedRevision(REST_BODY));
    expect(output).not.toContain(computeApprovedRevision(graphqlBody));
  });

  it.each([
    ["non-record GraphQL data", null, undefined],
    ["non-record repository", { repository: null }, undefined],
    ["non-record issue", { repository: { issue: null } }, undefined],
    ["non-record edit node", {
      repository: {
        issue: {
          userContentEdits: {
            nodes: [null],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    }, undefined],
    ["malformed shape", { repository: { issue: {} } }, undefined],
    ["malformed editedAt", {
      repository: {
        issue: {
          userContentEdits: {
            nodes: [{ editedAt: "not-a-time" }],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    }, undefined],
    ["calendar-invalid editedAt", {
      repository: {
        issue: {
          userContentEdits: {
            nodes: [{ editedAt: "2026-02-30T10:00:00Z" }],
            pageInfo: { hasNextPage: false },
          },
        },
      },
    }, undefined],
    ["GraphQL errors", undefined, new Error("GraphQL errors")],
  ])("fails closed for %s", async (_name, graphqlResponse, graphqlError) => {
    const { request, graphql } = requestFor(ownerComment(), {
      graphql: graphqlResponse,
      graphqlError,
    });

    await main(request, graphql);

    expect(readFileSync(outputPath, "utf8")).toBe("proceed=false\n");
  });

  it("M-pagination fails closed when body-edit history exceeds one page", async () => {
    const { request, graphql } = requestFor(ownerComment(), {
      graphql: {
        repository: {
          issue: {
            userContentEdits: {
              nodes: [{ editedAt: "2026-08-28T09:00:00Z" }],
              pageInfo: { hasNextPage: true },
            },
          },
        },
      },
    });

    await main(request, graphql);

    expect(readFileSync(outputPath, "utf8")).toBe("proceed=false\n");
  });

  it("fails closed when the immutable approve-comment timestamp is absent", async () => {
    const { request, graphql } = requestFor({
      body: "@claude approve",
      user: { login: "syamaner" },
    });

    await main(request, graphql);

    expect(readFileSync(outputPath, "utf8")).toBe("proceed=false\n");
  });

  it("never captures a revision or calls GraphQL for respec", async () => {
    const { request, graphql, calls } = requestFor(ownerComment("@claude respec"));

    await main(request, graphql);

    expect(calls.some((call) => call.startsWith("GRAPHQL"))).toBe(false);
    expect(readFileSync(outputPath, "utf8")).toBe(
      "proceed=true\nverb=respec\n",
    );
  });

  it("emits only proceed false for an ineligible fetched author", async () => {
    const { request } = requestFor({
      body: "@claude approve",
      created_at: COMMENT_CREATED_AT,
      user: { login: "attacker" },
    });

    await main(request);

    expect(readFileSync(outputPath, "utf8")).toBe("proceed=false\n");
  });

  it("throws loudly for a malformed fetched comment", async () => {
    const { request } = requestFor({ body: "@claude approve" });
    await expect(main(request)).rejects.toThrow(TypeError);
  });

  it("throws loudly for a malformed fetched top-level record", async () => {
    const { request } = requestFor(
      ownerComment(),
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
    const { request } = requestFor(ownerComment());
    await expect(main(request)).rejects.toThrow(Error);
  });
});
