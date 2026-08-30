import { execFileSync } from "node:child_process";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { canonicalIssueRevision } from "../../scripts/factory/approve-revision.mts";
import { TRIAGE_COMMENT_MARKER } from "../../scripts/factory/apply-triage-verdict-logic.mts";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));
vi.mock("../../scripts/factory/untrusted-text.mts", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../scripts/factory/untrusted-text.mts")
  >();
  return {
    ...actual,
    sanitizeUntrustedTextForPostedBody: vi.fn(
      actual.sanitizeUntrustedTextForPostedBody,
    ),
  };
});

const untrustedText = await import(
  "../../scripts/factory/untrusted-text.mts"
);

const {
  appendImplementCostToPrBody,
  appendImplementCostToStepSummary,
  buildImplementCostNote,
  main,
  MAX_PATCH_BYTES,
} = await import(
  "../../scripts/factory/publish-implement-patch.mts"
);

/**
 * Covers only the rejection paths that happen BEFORE any `git` command is
 * ever invoked (env validation, job-result gate, missing/oversized patch
 * artifact) — `execFileSync` stays mocked and unused for these, and each
 * test asserts it. Everything that depends on git's actual `--numstat`/
 * `--summary` output (the patch-path guard, valid-patch application,
 * idempotency, and the exploit-reproduction cases) is deliberately NOT
 * mocked here — `publish-implement-patch.real-git.test.ts` runs those
 * against a real repository instead, for exactly the reason this guard
 * was rewritten: don't trust an assumption about what git's output looks
 * like when you can just ask git.
 */

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function mockFetch(
  handlers: Record<string, (call: FetchCall) => Response>,
): { fetchMock: ReturnType<typeof vi.fn>; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ url, method, body });
    const key = `${method} ${url.replace("https://api.github.com", "")}`;
    const handler = handlers[key];
    if (!handler) {
      throw new Error(`unexpected fetch call: ${key}`);
    }
    return handler({ url, method, body });
  });
  return { fetchMock, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const VALID_DIFF = `diff --git a/lib/new-file.ts b/lib/new-file.ts
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/lib/new-file.ts
@@ -0,0 +1,1 @@
+export const x = 1;
`;

const ISSUE_TITLE = "[F1-S3] Implement workflow";
const ISSUE_BODY = "Build the approved implementation.";

function mockSuccessfulGit(): void {
  vi.mocked(execFileSync).mockImplementation((_file, args) => {
    const gitArgs = args as readonly string[];
    if (gitArgs[0] === "apply" && gitArgs[1] === "--numstat") {
      return "1\t0\tlib/new-file.ts\0";
    }
    if (gitArgs[0] === "rev-parse") {
      return `${"a".repeat(40)}\n`;
    }
    if (gitArgs[0] === "write-tree") {
      return `${"b".repeat(40)}\n`;
    }
    if (gitArgs[0] === "diff-index") {
      return "A\0lib/new-file.ts\0";
    }
    if (gitArgs[0] === "diff" && gitArgs.includes("--text")) {
      return VALID_DIFF;
    }
    if (gitArgs[0] === "diff" && gitArgs.includes("--numstat")) {
      return "1\t0\tlib/new-file.ts\0";
    }
    return "";
  });
}

function issueRevisionFetchHandlers(
  body: string | null,
): Record<string, (call: FetchCall) => Response> {
  return {
    "POST /graphql": () =>
      jsonResponse({
        data: {
          repository: {
            issue: {
              comments: {
                nodes: [
                  {
                    body:
                      "<!-- roastpilot-factory:triage-generation:123.1:do-not-edit -->\n" +
                      TRIAGE_COMMENT_MARKER,
                    author: { __typename: "Bot", login: "github-actions" },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      }),
    "GET /repos/syamaner/roastpilot-cloud/issues/6": () =>
      jsonResponse({
        title: ISSUE_TITLE,
        body,
        state: "open",
        labels: [{ name: "ready-to-implement" }],
      }),
    "GET /repos/syamaner/roastpilot-cloud/pulls?state=open&per_page=100&page=1": () =>
      jsonResponse([]),
    "POST /repos/syamaner/roastpilot-cloud/pulls": () =>
      jsonResponse(
        {
          number: 99,
          html_url: "https://github.com/o/r/pull/99",
        },
        201,
      ),
    "GET /repos/syamaner/roastpilot-cloud/issues/6/comments?per_page=100&page=1": () =>
      jsonResponse([]),
    "POST /repos/syamaner/roastpilot-cloud/issues/6/comments": () =>
      jsonResponse({}, 201),
  };
}

describe("implement cost provenance", () => {
  it("P1: renders one valid inert line in the PR provenance and publisher summary", () => {
    const note = buildImplementCostNote("2.9373", "62");
    expect(note).toBe(
      "- **Implement run:** cost: `$2.9373 USD across 62 turns`",
    );
    expect(note.split("\n")).toHaveLength(1);

    const body = appendImplementCostToPrBody(
      "## Provenance\n\n- **Model:** `claude`\n- **Prompt/skill version:** `sha`\n",
      note,
    );
    const summary = appendImplementCostToStepSummary(
      "## Factory publish summary\n\n- **PR:** #1\n",
      note,
    );
    expect(body).toContain(`- **Model:** \`claude\`\n${note}\n- **Prompt/skill version:**`);
    expect(summary).toContain(`- **PR:** #1\n${note}\n`);
    expect(body.match(/\*\*Implement run:\*\*/g)).toHaveLength(1);
    expect(summary.match(/\*\*Implement run:\*\*/g)).toHaveLength(1);
  });

  it("P2/G9: malformed crossed values render unavailable and never render raw input", () => {
    const rawCost = "1e3";
    const rawTurns = "01";
    const note = buildImplementCostNote(rawCost, rawTurns);
    expect(note).toBe("- **Implement run:** cost: unavailable");
    expect(note).not.toContain(rawCost);
    expect(note).not.toContain(rawTurns);
    expect(buildImplementCostNote("10000.01", "62")).toBe(
      "- **Implement run:** cost: unavailable",
    );
    expect(buildImplementCostNote("1", "100001")).toBe(
      "- **Implement run:** cost: unavailable",
    );
  });

  it("P3: valid cost rendering routes through untrusted-text neutralisation as defense in depth", () => {
    const sanitizeSpy = vi.mocked(
      untrustedText.sanitizeUntrustedTextForPostedBody,
    );
    sanitizeSpy.mockClear();

    expect(buildImplementCostNote("2.9373", "62")).toBe(
      "- **Implement run:** cost: `$2.9373 USD across 62 turns`",
    );
    expect(sanitizeSpy).toHaveBeenCalledOnce();
    expect(sanitizeSpy).toHaveBeenCalledWith("$2.9373 USD across 62 turns");
  });

});

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "publish-patch-"));
  process.env.GH_TOKEN = "test-token";
  process.env.GITHUB_REPOSITORY = "syamaner/roastpilot-cloud";
  process.env.TRUSTED_ISSUE_NUMBER = "6";
  process.env.IMPLEMENT_JOB_RESULT = "success";
  process.env.EXPECTED_TRIAGE_GENERATION = "123.1";
  process.env.EXPECTED_ISSUE_REVISION = canonicalIssueRevision(
    ISSUE_TITLE,
    ISSUE_BODY,
  );
  process.env.RUN_URL = "https://github.com/o/r/actions/runs/1";
  process.exitCode = undefined;
  vi.mocked(execFileSync).mockReset();
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.TRUSTED_ISSUE_NUMBER;
  delete process.env.IMPLEMENT_JOB_RESULT;
  delete process.env.EXPECTED_TRIAGE_GENERATION;
  delete process.env.EXPECTED_ISSUE_REVISION;
  delete process.env.RUN_URL;
  delete process.env.PATCH_PATH;
  process.exitCode = undefined;
});

describe("main — input validation", () => {
  it("throws when GITHUB_REPOSITORY is not owner/repo", async () => {
    process.env.GITHUB_REPOSITORY = "not-a-valid-repo-string";
    await expect(main()).rejects.toThrow(/owner\/repo/);
  });

  it.each(["051", " 51", "51 ", "0", "-1", "1.5", "9007199254740992"])(
    "rejects non-canonical or unsafe issue number %s before any write",
    async (issueNumber) => {
      process.env.TRUSTED_ISSUE_NUMBER = issueNumber;
      const { fetchMock, calls } = mockFetch({});
      vi.stubGlobal("fetch", fetchMock);

      await expect(main()).rejects.toThrow(/TRUSTED_ISSUE_NUMBER/);

      expect(calls).toEqual([]);
      expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    },
  );
});

describe("main — fail-closed paths that never reach git (no branch, no PR, one comment)", () => {
  it.each([undefined, "not-a-revision", "A".repeat(64)])(
    "T-H1-malformed-env: rejects missing or malformed issue revision %s",
    async (revision) => {
      if (revision === undefined) {
        delete process.env.EXPECTED_ISSUE_REVISION;
      } else {
        process.env.EXPECTED_ISSUE_REVISION = revision;
      }
      const patchPath = join(workdir, "patch.diff");
      await writeFile(patchPath, VALID_DIFF);
      process.env.PATCH_PATH = patchPath;
      const { fetchMock, calls } = mockFetch({
        "GET /repos/syamaner/roastpilot-cloud/issues/6/comments?per_page=100&page=1": () =>
          jsonResponse([]),
        "POST /repos/syamaner/roastpilot-cloud/issues/6/comments": () =>
          jsonResponse({}, 201),
      });
      vi.stubGlobal("fetch", fetchMock);

      await main();

      expect(process.exitCode).toBe(1);
      expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
      expect(
        (calls.find((call) => call.method === "POST")?.body as { body: string })
          .body,
      ).toContain("did not report a canonical lowercase SHA-256 issue revision");
    },
  );

  it("rejects a stale captured generation before invoking any local git command", async () => {
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, VALID_DIFF);
    process.env.PATCH_PATH = patchPath;
    process.env.EXPECTED_TRIAGE_GENERATION = "456.1";

    const { fetchMock, calls } = mockFetch({
      "POST /graphql": () =>
        jsonResponse({
          data: {
            repository: {
              issue: {
                comments: {
                  nodes: [
                    {
                      body:
                        "<!-- roastpilot-factory:triage-generation:123.1:do-not-edit -->\n" +
                        TRIAGE_COMMENT_MARKER,
                      author: {
                        __typename: "Bot",
                        login: "github-actions",
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
      "GET /repos/syamaner/roastpilot-cloud/issues/6/comments?per_page=100&page=1": () =>
        jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/6/comments": () =>
        jsonResponse({}, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    expect(calls.some((call) => call.url.includes("/pulls"))).toBe(false);
    expect(calls.some((call) => call.url.endsWith("/issues/6"))).toBe(false);
    const comment = calls.find(
      (call) =>
        call.method === "POST" && call.url.endsWith("/issues/6/comments"),
    );
    expect((comment?.body as { body: string }).body).toContain(
      "triage generation changed from 456.1 to 123.1",
    );
  });

  it("rejects a missing captured generation before reading the patch", async () => {
    delete process.env.EXPECTED_TRIAGE_GENERATION;
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, VALID_DIFF);
    process.env.PATCH_PATH = patchPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/6/comments?per_page=100&page=1": () =>
        jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/6/comments": () =>
        jsonResponse({}, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    expect(calls.some((call) => call.method === "POST")).toBe(true);
    expect((calls.find((call) => call.method === "POST")?.body as { body: string }).body).toContain(
      "did not report an authorizing",
    );
  });

  it("rejects missing bot-owned terminal history before invoking git", async () => {
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, VALID_DIFF);
    process.env.PATCH_PATH = patchPath;

    const { fetchMock, calls } = mockFetch({
      "POST /graphql": () =>
        jsonResponse({
          data: {
            repository: {
              issue: {
                comments: {
                  nodes: [
                    {
                      body:
                        "<!-- roastpilot-factory:triage-generation:123.1:do-not-edit -->\n" +
                        TRIAGE_COMMENT_MARKER,
                      author: { __typename: "Bot", login: "another-app" },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
      "GET /repos/syamaner/roastpilot-cloud/issues/6/comments?per_page=100&page=1": () =>
        jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/6/comments": () =>
        jsonResponse({}, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    const comment = calls.find(
      (call) =>
        call.method === "POST" && call.url.endsWith("/issues/6/comments"),
    );
    expect((comment?.body as { body: string }).body).toContain(
      "has no bot-owned terminal triage comment",
    );
  });

  it("rejects a FAILED implement job without ever reading the patch or calling git", async () => {
    process.env.IMPLEMENT_JOB_RESULT = "failure";
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, VALID_DIFF);
    process.env.PATCH_PATH = patchPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/6/comments?per_page=100&page=1": () =>
        jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/6/comments": () =>
        jsonResponse({}, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    const comment = calls.find((c) => c.method === "POST");
    expect((comment?.body as { body: string }).body).toContain(
      'implement job result was "failure"',
    );
  });

  it("rejects a missing patch artifact", async () => {
    process.env.PATCH_PATH = join(workdir, "does-not-exist.diff");

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/6/comments?per_page=100&page=1": () =>
        jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/6/comments": () =>
        jsonResponse({}, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    const comment = calls.find((c) => c.method === "POST");
    expect((comment?.body as { body: string }).body).toContain(
      "patch artifact not found",
    );
  });

  it("allows an exactly 2 MiB patch artifact to reach git validation", async () => {
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, "");
    await truncate(patchPath, MAX_PATCH_BYTES);
    process.env.PATCH_PATH = patchPath;

    const { fetchMock } = mockFetch({
      "POST /graphql": () =>
        jsonResponse({
          data: {
            repository: {
              issue: {
                comments: {
                  nodes: [
                    {
                      body:
                        "<!-- roastpilot-factory:triage-generation:123.1:do-not-edit -->\n" +
                        TRIAGE_COMMENT_MARKER,
                      author: {
                        __typename: "Bot",
                        login: "github-actions",
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        }),
      "GET /repos/syamaner/roastpilot-cloud/issues/6/comments?per_page=100&page=1": () =>
        jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/6/comments": () =>
        jsonResponse({}, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(vi.mocked(execFileSync)).toHaveBeenCalled();
  });

  it("rejects a 2 MiB plus one byte patch artifact before invoking git", async () => {
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, "");
    await truncate(patchPath, MAX_PATCH_BYTES + 1);
    process.env.PATCH_PATH = patchPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/6/comments?per_page=100&page=1": () =>
        jsonResponse([]),
      "POST /repos/syamaner/roastpilot-cloud/issues/6/comments": () =>
        jsonResponse({}, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    const comment = calls.find((c) => c.method === "POST");
    expect((comment?.body as { body: string }).body).toContain(
      "exceeds the 2097152-byte limit",
    );
  });
});

describe("main — H1 issue revision guard", () => {
  it("T-H1-match: pushes when the fresh canonical digest matches", async () => {
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, VALID_DIFF);
    process.env.PATCH_PATH = patchPath;
    mockSuccessfulGit();
    const { fetchMock, calls } = mockFetch(
      issueRevisionFetchHandlers(ISSUE_BODY),
    );
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
      "git",
      ["push", "--force", "origin", expect.stringMatching(/^feature\/6-/)],
      expect.any(Object),
    );
    expect(
      calls.filter(
        (call) => call.method === "POST" && call.url.endsWith("/pulls"),
      ),
    ).toHaveLength(1);
  });

  it("T-H1-mismatch: rejects an edited body before push and posts exactly one failure comment", async () => {
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, VALID_DIFF);
    process.env.PATCH_PATH = patchPath;
    mockSuccessfulGit();
    const { fetchMock, calls } = mockFetch(
      issueRevisionFetchHandlers("Body edited after the implement snapshot."),
    );
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(
      vi.mocked(execFileSync).mock.calls.some(
        ([, args]) => (args as readonly string[])[0] === "push",
      ),
    ).toBe(false);
    expect(calls.some((call) => call.url.endsWith("/pulls"))).toBe(false);
    const failureComments = calls.filter(
      (call) =>
        call.method === "POST" && call.url.endsWith("/issues/6/comments"),
    );
    expect(failureComments).toHaveLength(1);
    expect((failureComments[0]?.body as { body: string }).body).toContain(
      "issue revision changed",
    );
  });

  it("T-H1-malformed-issue-fields: rejects an omitted fresh REST body before push and posts exactly one failure comment", async () => {
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, VALID_DIFF);
    process.env.PATCH_PATH = patchPath;
    process.env.EXPECTED_ISSUE_REVISION = canonicalIssueRevision(
      ISSUE_TITLE,
      null,
    );
    mockSuccessfulGit();
    const handlers = issueRevisionFetchHandlers(null);
    handlers["GET /repos/syamaner/roastpilot-cloud/issues/6"] = () =>
      jsonResponse({
        title: ISSUE_TITLE,
        state: "open",
        labels: [{ name: "ready-to-implement" }],
      });
    const { fetchMock, calls } = mockFetch(handlers);
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(
      vi.mocked(execFileSync).mock.calls.some(
        ([, args]) => (args as readonly string[])[0] === "push",
      ),
    ).toBe(false);
    expect(calls.some((call) => call.url.endsWith("/pulls"))).toBe(false);
    const failureComments = calls.filter(
      (call) =>
        call.method === "POST" && call.url.endsWith("/issues/6/comments"),
    );
    expect(failureComments).toHaveLength(1);
    expect((failureComments[0]?.body as { body: string }).body).toContain(
      "REST issue title/body is malformed",
    );
  });

  it("T-H1-edit-during-pr-lookup: re-fetches after PR lookup and rejects an intervening scope edit", async () => {
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, VALID_DIFF);
    process.env.PATCH_PATH = patchPath;
    mockSuccessfulGit();
    let prLookupCompleted = false;
    const handlers = issueRevisionFetchHandlers(ISSUE_BODY);
    handlers[
      "GET /repos/syamaner/roastpilot-cloud/pulls?state=open&per_page=100&page=1"
    ] = () => {
      prLookupCompleted = true;
      return jsonResponse([]);
    };
    handlers["GET /repos/syamaner/roastpilot-cloud/issues/6"] = () =>
      jsonResponse({
        title: ISSUE_TITLE,
        body: prLookupCompleted
          ? "Body edited while the PR lookup was running."
          : ISSUE_BODY,
        state: "open",
        labels: [{ name: "ready-to-implement" }],
      });
    const { fetchMock, calls } = mockFetch(handlers);
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(prLookupCompleted).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(
      calls.filter(
        (call) =>
          call.method === "GET" && call.url.endsWith("/issues/6"),
      ),
    ).toHaveLength(2);
    expect(
      vi.mocked(execFileSync).mock.calls.some(
        ([, args]) => (args as readonly string[])[0] === "push",
      ),
    ).toBe(false);
    expect(
      vi.mocked(execFileSync).mock.calls.some(
        ([, args]) => (args as readonly string[])[0] === "commit",
      ),
    ).toBe(false);
    expect(
      calls.some(
        (call) => call.method === "POST" && call.url.endsWith("/pulls"),
      ),
    ).toBe(false);
    const failureComments = calls.filter(
      (call) =>
        call.method === "POST" && call.url.endsWith("/issues/6/comments"),
    );
    expect(failureComments).toHaveLength(1);
    expect((failureComments[0]?.body as { body: string }).body).toContain(
      "issue revision changed",
    );
  });

  it("T-H1-edit-during-patch-prep: revalidates after commit and rejects an edit before push", async () => {
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, VALID_DIFF);
    process.env.PATCH_PATH = patchPath;
    mockSuccessfulGit();
    let issueFetchCount = 0;
    let prepCompletedBeforeFinalFetch = false;
    const handlers = issueRevisionFetchHandlers(ISSUE_BODY);
    handlers["GET /repos/syamaner/roastpilot-cloud/issues/6"] = () => {
      issueFetchCount += 1;
      if (issueFetchCount === 3) {
        prepCompletedBeforeFinalFetch = vi.mocked(execFileSync).mock.calls.some(
          ([, args]) => (args as readonly string[])[0] === "commit",
        );
      }
      return jsonResponse({
        title: ISSUE_TITLE,
        body:
          issueFetchCount === 3
            ? "Body edited while the local patch was being prepared."
            : ISSUE_BODY,
        state: "open",
        labels: [{ name: "ready-to-implement" }],
      });
    };
    const { fetchMock, calls } = mockFetch(handlers);
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(prepCompletedBeforeFinalFetch).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(
      calls.filter(
        (call) =>
          call.method === "GET" && call.url.endsWith("/issues/6"),
      ),
    ).toHaveLength(3);
    expect(
      vi.mocked(execFileSync).mock.calls.some(
        ([, args]) => (args as readonly string[])[0] === "push",
      ),
    ).toBe(false);
    expect(
      calls.some(
        (call) => call.method === "POST" && call.url.endsWith("/pulls"),
      ),
    ).toBe(false);
    const failureComments = calls.filter(
      (call) =>
        call.method === "POST" && call.url.endsWith("/issues/6/comments"),
    );
    expect(failureComments).toHaveLength(1);
    expect((failureComments[0]?.body as { body: string }).body).toContain(
      "issue revision changed",
    );
  });

  it("T-H1-null-body: maps a REST null body to the canonical empty string and pushes", async () => {
    const patchPath = join(workdir, "patch.diff");
    await writeFile(patchPath, VALID_DIFF);
    process.env.PATCH_PATH = patchPath;
    process.env.EXPECTED_ISSUE_REVISION = canonicalIssueRevision(
      ISSUE_TITLE,
      null,
    );
    mockSuccessfulGit();
    const { fetchMock } = mockFetch(issueRevisionFetchHandlers(null));
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    expect(
      vi.mocked(execFileSync).mock.calls.some(
        ([, args]) => (args as readonly string[])[0] === "push",
      ),
    ).toBe(true);
  });
});

describe("main — IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN (factory.md §13 publisher-identity switch)", () => {
  afterEach(() => {
    delete process.env.IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN;
  });

  it("PATCHes the prior comment when it was authored by the configured login", async () => {
    process.env.IMPLEMENT_JOB_RESULT = "failure";
    process.env.IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN = "roastpilot-factory[bot]";

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/6/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 42,
            body: "prior failure\n\n<!-- roastpilot-factory:implement-failure:do-not-edit -->",
            user: { type: "Bot", login: "roastpilot-factory[bot]" },
          },
        ]),
      "PATCH /repos/syamaner/roastpilot-cloud/issues/comments/42": () => jsonResponse({}, 200),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeDefined();
    expect((patch?.body as { body: string }).body).toContain('implement job result was "failure"');
  });

  it("does NOT match a prior comment authored by a different login than configured (no cross-identity edit)", async () => {
    process.env.IMPLEMENT_JOB_RESULT = "failure";
    process.env.IMPLEMENT_FAILURE_COMMENT_AUTHOR_LOGIN = "roastpilot-factory[bot]";

    const { fetchMock, calls } = mockFetch({
      // The prior comment is from the OLD (GITHUB_TOKEN) identity — a
      // publisher-identity switch must not silently adopt/edit a comment
      // posted under the previous identity; it posts a fresh one instead.
      "GET /repos/syamaner/roastpilot-cloud/issues/6/comments?per_page=100&page=1": () =>
        jsonResponse([
          {
            id: 42,
            body: "prior failure\n\n<!-- roastpilot-factory:implement-failure:do-not-edit -->",
            user: { type: "Bot", login: "github-actions[bot]" },
          },
        ]),
      "POST /repos/syamaner/roastpilot-cloud/issues/6/comments": () => jsonResponse({}, 201),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const post = calls.find((c) => c.method === "POST");
    expect(post).toBeDefined();
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
});
