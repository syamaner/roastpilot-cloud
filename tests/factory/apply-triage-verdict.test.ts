import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../../scripts/factory/apply-triage-verdict.mts";
import {
  TRIAGE_COMMENT_MARKER,
  extractApprovedRevision,
} from "../../scripts/factory/apply-triage-verdict-logic.mts";
import { computeApprovedRevision } from "../../scripts/factory/approve-revision.mts";

/**
 * Integration-style tests for the privileged CLI entrypoint: stub `fetch`
 * (no real network) and drive `main()` through env vars + a temp verdict
 * file, the same inputs the workflow wires up. The schema/logic decisions
 * themselves are unit-tested in triage-verdict-schema.test.ts and
 * apply-triage-verdict-logic.test.ts; this file proves the entrypoint wires
 * them together correctly end to end, including the fail-closed path.
 */

interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
  readonly authorization: string | null;
}

function mockFetch(
  handlers: Record<string, (call: FetchCall) => Response>,
  options?: {
    readonly verificationLabels?: readonly string[];
  },
): { fetchMock: ReturnType<typeof vi.fn>; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let lastWrittenLabels: readonly string[] | null = null;
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    const headers = new Headers(init?.headers);
    const call: FetchCall = {
      url,
      method,
      body,
      authorization: headers.get("authorization"),
    };
    calls.push(call);
    const key = `${method} ${url.replace("https://api.github.com", "")}`;
    if (
      key ===
        "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100" &&
      lastWrittenLabels !== null
    ) {
      const labels = options?.verificationLabels ?? lastWrittenLabels;
      return jsonResponse(labels.map((name) => ({ name })));
    }
    const handler =
      handlers[key] ??
      (key === "GET /repos/syamaner/roastpilot-cloud/issues/42"
        ? () => jsonResponse({ state: "open", body: null })
        : key ===
            "GET /repos/syamaner/roastpilot-cloud/issues/comments/99"
          ? () =>
              jsonResponse({
                id: 99,
                body:
                  "<!-- roastpilot-factory:triage-generation:hold:123.1:do-not-edit -->\n" +
                  TRIAGE_COMMENT_MARKER,
                user: { type: "Bot", login: "github-actions[bot]" },
              })
          : key ===
              "PATCH /repos/syamaner/roastpilot-cloud/issues/comments/99"
            ? () => jsonResponse({})
        : undefined);
    if (!handler) {
      throw new Error(`unexpected fetch call: ${key}`);
    }
    const response = handler(call);
    if (
      key === "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels" &&
      response.ok
    ) {
      lastWrittenLabels = (body as { readonly labels: readonly string[] })
        .labels;
    }
    return response;
  });
  return { fetchMock, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let workdir: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "triage-verdict-"));
  process.env.GH_TOKEN = "test-token";
  process.env.FACTORY_APP_TOKEN = "app-token";
  process.env.GITHUB_REPOSITORY = "syamaner/roastpilot-cloud";
  process.env.TRUSTED_ISSUE_NUMBER = "42";
  process.env.TRUSTED_TRIAGE_COMMENT_ID = "99";
  process.env.TRIAGE_JOB_RESULT = "success";
  process.env.TRIAGE_EXECUTION = "123.1";
  process.env.TRIAGE_MODE = "readiness";
  process.env.APPROVED_REVISION = "";
  process.exitCode = undefined;
});

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  delete process.env.GH_TOKEN;
  delete process.env.FACTORY_APP_TOKEN;
  delete process.env.GITHUB_REPOSITORY;
  delete process.env.TRUSTED_ISSUE_NUMBER;
  delete process.env.TRUSTED_TRIAGE_COMMENT_ID;
  delete process.env.TRIAGE_JOB_RESULT;
  delete process.env.TRIAGE_EXECUTION;
  delete process.env.TRIAGE_MODE;
  delete process.env.APPROVED_REVISION;
  delete process.env.VERDICT_PATH;
  process.exitCode = undefined;
});

describe("main — valid verdict path", () => {
  it("M-B2a fails closed when the freshly fetched REST body no longer matches approval", async () => {
    const currentBody = "Current REST body";
    process.env.APPROVED_REVISION = computeApprovedRevision("Reviewed body");
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "The story has a complete implementation contract.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42": () =>
        jsonResponse({ state: "open", body: currentBody }),
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "ready-to-implement" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      labels: ["needs-triage"],
    });
    const commentBody = (
      calls.find((call) => call.method === "PATCH")?.body as { body: string }
    ).body;
    expect(commentBody).toContain(
      "approved issue revision no longer matches the current REST issue body",
    );
    expect(commentBody).not.toContain("approved-revision:");
    expect(commentBody).toContain("triage-generation:hold:123.1");
  });

  it("embeds the matching REST-body revision only in an authorizing verdict", async () => {
    const currentBody = "Current REST body\nwith trailing bytes.\n";
    process.env.APPROVED_REVISION = computeApprovedRevision(currentBody);
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "The story has a complete implementation contract.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42": () =>
        jsonResponse({ state: "open", body: currentBody }),
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "needs-triage" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    const commentBody = (
      calls.find((call) => call.method === "PATCH")?.body as { body: string }
    ).body;
    expect(extractApprovedRevision(commentBody)).toBe(
      process.env.APPROVED_REVISION,
    );
  });

  it("fails malformed non-empty APPROVED_REVISION through the fallback", async () => {
    process.env.APPROVED_REVISION = "not-a-digest";
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "ready-to-implement" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      labels: ["needs-triage"],
    });
  });

  it("defaults an absent APPROVED_REVISION to the marker-free manual path", async () => {
    delete process.env.APPROVED_REVISION;
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "The manual triage verdict is authorizing.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "needs-triage" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    const commentBody = (
      calls.find((call) => call.method === "PATCH")?.body as { body: string }
    ).body;
    expect(commentBody).not.toContain("approved-revision:");
    expect(commentBody).toContain("triage-generation:123.1");
  });

  it("uses the App token only for a ready-to-spec label PUT and verification", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-spec",
        reasoning: "The story needs a planning contract.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100":
        () => jsonResponse([{ name: "needs-triage" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    const put = calls.find((call) => call.method === "PUT");
    const labelReads = calls.filter((call) => call.url.includes("/labels"));
    const patch = calls.find((call) => call.method === "PATCH");
    expect(put?.authorization).toBe("Bearer app-token");
    expect(labelReads[0]?.authorization).toBe("Bearer test-token");
    expect(labelReads.at(-1)?.authorization).toBe("Bearer app-token");
    expect(patch?.authorization).toBe("Bearer test-token");
  });

  it("falls back to GITHUB_TOKEN when the optional App token is empty", async () => {
    process.env.FACTORY_APP_TOKEN = "";
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-spec",
        reasoning: "The story needs a planning contract.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100":
        () => jsonResponse([{ name: "needs-triage" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(calls.find((call) => call.method === "PUT")?.authorization).toBe(
      "Bearer test-token",
    );
  });

  it("falls back to GITHUB_TOKEN when FACTORY_APP_TOKEN is absent", async () => {
    delete process.env.FACTORY_APP_TOKEN;
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-spec",
        reasoning: "The story needs a planning contract.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100":
        () => jsonResponse([{ name: "needs-triage" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(calls.find((call) => call.method === "PUT")?.authorization).toBe(
      "Bearer test-token",
    );
    const commentWrites = calls.filter((call) => call.method === "PATCH");
    expect(commentWrites).toHaveLength(1);
    expect(commentWrites[0]?.authorization).toBe("Bearer test-token");
  });

  it("keeps ready-to-implement label and comment writes on GITHUB_TOKEN", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "The story is ready for factory implementation.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100":
        () => jsonResponse([{ name: "needs-triage" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    for (const call of calls.filter(
      (candidate) => candidate.method === "PUT" || candidate.method === "PATCH",
    )) {
      expect(call.authorization).toBe("Bearer test-token");
    }
  });

  it("uses GITHUB_TOKEN for the fallback after an App label PUT failure", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-spec",
        reasoning: "The story needs a planning contract.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;
    let putAttempts = 0;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100":
        () => jsonResponse([{ name: "needs-triage" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () => {
        putAttempts += 1;
        return putAttempts === 1
          ? new Response("App write unavailable", { status: 503 })
          : jsonResponse({});
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(main()).rejects.toThrow(/503/);

    const puts = calls.filter((call) => call.method === "PUT");
    const patches = calls.filter((call) => call.method === "PATCH");
    expect(puts).toHaveLength(2);
    expect(puts[0]?.authorization).toBe("Bearer app-token");
    expect(puts[1]?.authorization).toBe("Bearer test-token");
    expect(puts[1]?.body).toEqual({ labels: ["needs-triage"] });
    expect(patches).toHaveLength(2);
    expect(patches.every((call) => call.authorization === "Bearer test-token"))
      .toBe(true);
  });

  it.each([
    ["pre-filter", "ready-to-spec", true],
    ["readiness", "ready-to-implement", false],
  ] as const)(
    "composes %s mode into the effective label and comment readiness",
    async (mode, expectedReadiness, expectsClamp) => {
      const verdictPath = join(workdir, "verdict.json");
      await writeFile(
        verdictPath,
        JSON.stringify({
          issue_number: 42,
          readiness: "ready-to-implement",
          reasoning: "The story has complete inline acceptance criteria.",
          missing_info_questions: [],
        }),
      );
      process.env.VERDICT_PATH = verdictPath;
      process.env.TRIAGE_MODE = mode;

      const { fetchMock, calls } = mockFetch({
        "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100":
          () => jsonResponse([{ name: "needs-triage" }]),
        "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
          jsonResponse({}),
      });
      vi.stubGlobal("fetch", fetchMock);

      await main();

      expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
        labels: [expectedReadiness],
      });
      const commentBody = (
        calls.find((call) => call.method === "PATCH")?.body as {
          readonly body: string;
        }
      ).body;
      expect(commentBody).toContain(
        `Automated triage verdict: \`${expectedReadiness}\``,
      );
      expect(commentBody.includes("Pre-filter triage downgrade")).toBe(
        expectsClamp,
      );
    },
  );

  it("surfaces both deterministic downgrade reasons when both guards apply", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "The submitted story meets the intake bar.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;
    process.env.TRIAGE_MODE = "pre-filter";

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42": () =>
        jsonResponse({
          state: "open",
          body: "### Acceptance criteria\n- [ ] Schema matches section 4",
        }),
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "needs-triage" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    const commentBody = (
      calls.find((call) => call.method === "PATCH")?.body as {
        readonly body: string;
      }
    ).body;
    expect(commentBody).toContain("Pre-filter triage downgrade");
    expect(commentBody).toContain("Automated intake downgrade");
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      labels: ["ready-to-spec"],
    });
  });

  it("B8/G9: deterministically downgrades a delegating AC without echoing it", async () => {
    const rawCriterion =
      "UNTRUSTED-SENTINEL: the cloud schema matches §4 exactly";
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "The submitted story meets the intake bar.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42": () =>
        jsonResponse({
          state: "open",
          body: `### Acceptance criteria\n- [ ] ${rawCriterion}`,
        }),
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "needs-triage" }, { name: "epic:F1" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    const putBody = calls.find((call) => call.method === "PUT")?.body as {
      readonly labels: readonly string[];
    };
    expect(putBody.labels).toContain("ready-to-spec");
    expect(putBody.labels).not.toContain("ready-to-implement");
    const commentBody = (
      calls.find((call) => call.method === "PATCH")?.body as {
        readonly body: string;
      }
    ).body;
    expect(commentBody).toContain("Automated intake downgrade");
    expect(commentBody).toContain("matched: `matches-section`");
    expect(commentBody).not.toContain(rawCriterion);
    expect(commentBody).toContain(
      "Automated triage verdict: `ready-to-spec`",
    );
  });

  it("replaces the hold before enabling and verifying readiness", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "Meets the intake bar in full.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "needs-triage" }, { name: "epic:F1" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    const putLabels = calls.find((c) => c.method === "PUT");
    expect(putLabels?.body).toEqual({
      labels: expect.arrayContaining(["epic:F1", "ready-to-implement"]),
    });
    expect((putLabels?.body as { labels: string[] }).labels).not.toContain(
      "needs-triage",
    );
    const patchComment = calls.find(
      (c) => c.method === "PATCH" && c.url.includes("/comments/99"),
    );
    expect((patchComment?.body as { body: string }).body).toContain(
      TRIAGE_COMMENT_MARKER,
    );
    expect((patchComment?.body as { body: string }).body).toContain(
      "triage-generation:123.1:do-not-edit",
    );

    const firstLabelReadIndex = calls.findIndex(
      (c) => c.method === "GET" && c.url.includes("/labels"),
    );
    const verifyIndex = calls.findLastIndex(
      (c) => c.method === "GET" && c.url.includes("/labels"),
    );
    const putIndex = calls.findIndex((c) => c.method === "PUT");
    const patchIndex = calls.findIndex(
      (c) => c.method === "PATCH" && c.url.includes("/comments/99"),
    );
    expect(patchIndex).toBeGreaterThanOrEqual(0);
    expect(firstLabelReadIndex).toBeGreaterThan(patchIndex);
    expect(putIndex).toBeGreaterThan(firstLabelReadIndex);
    expect(verifyIndex).toBeGreaterThan(putIndex);
  });

  it("retries label application from the exact final generation", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "Meets the intake bar in full.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/comments/99": () =>
        jsonResponse({
          id: 99,
          body:
            "<!-- roastpilot-factory:triage-generation:123.1:do-not-edit -->\n" +
            TRIAGE_COMMENT_MARKER,
          user: { type: "Bot", login: "github-actions[bot]" },
        }),
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "needs-triage" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    expect(calls.find((call) => call.method === "PUT")?.body).toEqual({
      labels: ["ready-to-implement"],
    });
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
      body: expect.stringContaining("triage-generation:123.1:do-not-edit"),
    });
  });

  it("does not enable readiness when the final-generation comment update fails", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "Meets the intake bar in full.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock, calls } = mockFetch({
      "PATCH /repos/syamaner/roastpilot-cloud/issues/comments/99": () =>
        new Response("service unavailable", { status: 503 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(main()).rejects.toThrow(/503/);

    expect(calls.some((c) => c.url.includes("/labels"))).toBe(false);
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("resets readiness when the verification read does not match the PUT", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "Meets the intake bar in full.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock, calls } = mockFetch(
      {
        "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100":
          () => jsonResponse([{ name: "needs-triage" }]),
        "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
          jsonResponse({}),
      },
      { verificationLabels: ["needs-triage"] },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(main()).rejects.toThrow(/readiness verification failed/);

    expect(calls.findIndex((call) => call.method === "PATCH")).toBeLessThan(
      calls.findIndex((call) => call.method === "PUT"),
    );
    const puts = calls.filter((call) => call.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[1]?.body).toEqual({ labels: ["needs-triage"] });
    const patches = calls.filter((call) => call.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect((patches[1]?.body as { body: string }).body).toContain(
      "triage-generation:hold:123.1:do-not-edit",
    );
  });

  it("resets readiness after an ambiguous authorizing PUT failure", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "Meets the intake bar in full.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;
    let putAttempts = 0;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse(
          putAttempts === 0
            ? [{ name: "needs-triage" }]
            : [{ name: "ready-to-implement" }],
        ),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () => {
        putAttempts += 1;
        return putAttempts === 1
          ? new Response("response lost", { status: 503 })
          : jsonResponse({});
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(main()).rejects.toThrow(/503/);

    const puts = calls.filter((call) => call.method === "PUT");
    expect(puts).toHaveLength(2);
    expect(puts[0]?.body).toEqual({ labels: ["ready-to-implement"] });
    expect(puts[1]?.body).toEqual({ labels: ["needs-triage"] });
    const firstPut = calls.indexOf(puts[0] as FetchCall);
    const fallbackRead = calls.findIndex(
      (call, index) =>
        index > firstPut &&
        call.method === "GET" &&
        call.url.includes("/labels"),
    );
    const fallbackPut = calls.indexOf(puts[1] as FetchCall);
    const fallbackVerify = calls.findIndex(
      (call, index) =>
        index > fallbackPut &&
        call.method === "GET" &&
        call.url.includes("/labels"),
    );
    const patches = calls.filter((call) => call.method === "PATCH");
    expect(patches).toHaveLength(2);
    const fallbackPatch = calls.indexOf(patches[1] as FetchCall);
    expect(firstPut).toBeLessThan(fallbackRead);
    expect(fallbackRead).toBeLessThan(fallbackPut);
    expect(fallbackPut).toBeLessThan(fallbackVerify);
    expect(fallbackVerify).toBeLessThan(fallbackPatch);
    expect((patches[1]?.body as { body: string }).body).toContain(
      "triage-generation:hold:123.1:do-not-edit",
    );
  });

  it("fails closed when the ambiguous-write fallback reset PUT fails", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "Meets the intake bar in full.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;
    let putAttempts = 0;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse(
          putAttempts === 0
            ? [{ name: "needs-triage" }]
            : [{ name: "ready-to-implement" }],
        ),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () => {
        putAttempts += 1;
        return new Response(
          putAttempts === 1 ? "response lost" : "reset unavailable",
          { status: putAttempts === 1 ? 503 : 502 },
        );
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(main()).rejects.toThrow(/502/);

    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
  });

  it("fails closed when the ambiguous-write fallback verification fails", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "Meets the intake bar in full.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;
    let putAttempts = 0;

    const { fetchMock, calls } = mockFetch(
      {
        "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100":
          () =>
            jsonResponse(
              putAttempts === 0
                ? [{ name: "needs-triage" }]
                : [{ name: "ready-to-implement" }],
            ),
        "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () => {
          putAttempts += 1;
          return putAttempts === 1
            ? new Response("response lost", { status: 503 })
            : jsonResponse({});
        },
      },
      { verificationLabels: ["ready-to-implement"] },
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(main()).rejects.toThrow(/readiness verification failed/);

    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
  });

  it("fails closed when restoring the exact hold comment fails", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "Meets the intake bar in full.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;
    let putAttempts = 0;
    let patchAttempts = 0;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse(
          putAttempts === 0
            ? [{ name: "needs-triage" }]
            : [{ name: "ready-to-implement" }],
        ),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () => {
        putAttempts += 1;
        return putAttempts === 1
          ? new Response("response lost", { status: 503 })
          : jsonResponse({});
      },
      "PATCH /repos/syamaner/roastpilot-cloud/issues/comments/99": () => {
        patchAttempts += 1;
        return patchAttempts === 1
          ? jsonResponse({})
          : new Response("comment unavailable", { status: 502 });
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(main()).rejects.toThrow(/502/);

    const puts = calls.filter((call) => call.method === "PUT");
    expect(puts[1]?.body).toEqual({ labels: ["needs-triage"] });
    const patches = calls.filter((call) => call.method === "PATCH");
    expect(patches).toHaveLength(2);
    expect((patches[1]?.body as { body: string }).body).toContain(
      "triage-generation:hold:123.1:do-not-edit",
    );
  });

  it("records a non-Error ambiguous write failure before rethrowing it", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "Meets the intake bar in full.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;
    let putAttempts = 0;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "needs-triage" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () => {
        putAttempts += 1;
        if (putAttempts === 1) {
          throw "transport vanished";
        }
        return jsonResponse({});
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(main()).rejects.toBe("transport vanished");

    const patches = calls.filter(
      (call) => call.method === "PATCH" && call.url.includes("/comments/99"),
    );
    expect(patches).toHaveLength(2);
    expect((patches[1]?.body as { body: string }).body).toContain(
      "validated verdict readiness apply failed: transport vanished",
    );
  });

  it("keeps verified needs-triage when the fallback comment fails", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "Meets the intake bar in full.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;
    let putAttempts = 0;
    let patchAttempts = 0;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse(
          putAttempts === 0
            ? [{ name: "needs-triage" }]
            : [{ name: "ready-to-implement" }],
        ),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () => {
        putAttempts += 1;
        return putAttempts === 1
          ? new Response("response lost", { status: 503 })
          : jsonResponse({});
      },
      "PATCH /repos/syamaner/roastpilot-cloud/issues/comments/99": () => {
        patchAttempts += 1;
        return patchAttempts === 1
          ? jsonResponse({})
          : new Response("comment unavailable", { status: 502 });
      },
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(main()).rejects.toThrow(/502/);

    const puts = calls.filter((call) => call.method === "PUT");
    expect(puts[1]?.body).toEqual({ labels: ["needs-triage"] });
    expect(
      calls.findLastIndex(
        (call) => call.method === "GET" && call.url.includes("/labels"),
      ),
    ).toBeGreaterThan(calls.indexOf(puts[1] as FetchCall));
  });

  it("edits the existing bot comment instead of posting a duplicate on re-run", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "needs-info",
        reasoning: "Missing acceptance criteria.",
        missing_info_questions: ["What defines done here?"],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "needs-triage" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
      "PATCH /repos/syamaner/roastpilot-cloud/issues/comments/99": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch).toBeDefined();
    const post = calls.find(
      (c) => c.method === "POST" && c.url.includes("/comments"),
    );
    expect(post).toBeUndefined();
  });

  it.each(["hold:123.1", "123.1"])(
    "rejects generation %s when the comment is not owned by github-actions[bot]",
    async (commentGeneration) => {
      const verdictPath = join(workdir, "verdict.json");
      await writeFile(
        verdictPath,
        JSON.stringify({
          issue_number: 42,
          readiness: "ready-to-implement",
          reasoning: "Meets the bar.",
          missing_info_questions: [],
        }),
      );
      process.env.VERDICT_PATH = verdictPath;

      const { fetchMock, calls } = mockFetch({
        "GET /repos/syamaner/roastpilot-cloud/issues/comments/99": () =>
          jsonResponse({
            id: 99,
            body:
              `<!-- roastpilot-factory:triage-generation:${commentGeneration}:do-not-edit -->\n` +
              TRIAGE_COMMENT_MARKER,
            user: { type: "Bot", login: "some-other-app[bot]" },
          }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(main()).rejects.toThrow(/triage generation is not/);

      expect(calls.some((c) => c.url.includes("/labels"))).toBe(false);
    },
  );

  it.each(["hold:123.1", "123.1"])(
    "rejects generation %s when the returned id differs from the trusted id",
    async (commentGeneration) => {
      const { fetchMock, calls } = mockFetch({
        "GET /repos/syamaner/roastpilot-cloud/issues/comments/99": () =>
          jsonResponse({
            id: 98,
            body:
              `<!-- roastpilot-factory:triage-generation:${commentGeneration}:do-not-edit -->\n` +
              TRIAGE_COMMENT_MARKER,
            user: { type: "Bot", login: "github-actions[bot]" },
          }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(main()).rejects.toThrow(/triage generation is not/);

      expect(calls).toHaveLength(2);
      expect(calls[1]?.url).toContain("/issues/comments/99");
      expect(calls.some((call) => call.method !== "GET")).toBe(false);
    },
  );

  it.each(["hold:456.1", "456.1"])(
    "rejects stale generation %s from a newer execution",
    async (commentGeneration) => {
      const verdictPath = join(workdir, "verdict.json");
      await writeFile(
        verdictPath,
        JSON.stringify({
          issue_number: 42,
          readiness: "ready-to-implement",
          reasoning: "Meets the bar.",
          missing_info_questions: [],
        }),
      );
      process.env.VERDICT_PATH = verdictPath;

      const { fetchMock, calls } = mockFetch({
        "GET /repos/syamaner/roastpilot-cloud/issues/comments/99": () =>
          jsonResponse({
            id: 99,
            body:
              "A newer re-triage is in progress.\n" +
              `<!-- roastpilot-factory:triage-generation:${commentGeneration}:do-not-edit -->\n` +
              TRIAGE_COMMENT_MARKER,
            user: { type: "Bot", login: "github-actions[bot]" },
          }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(main()).rejects.toThrow(
        new RegExp(`found ${commentGeneration.replace(".", "\\.")}`),
      );

      expect(calls.some((c) => c.url.includes("/labels"))).toBe(false);
    },
  );

  it("rejects a malformed trusted hold-comment id before any network call", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "Meets the bar.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    process.env.TRUSTED_TRIAGE_COMMENT_ID = "not-a-number";
    const { fetchMock, calls } = mockFetch({});
    vi.stubGlobal("fetch", fetchMock);

    await expect(main()).rejects.toThrow(
      /TRUSTED_TRIAGE_COMMENT_ID must be a positive integer/,
    );

    expect(calls).toEqual([]);
  });
});

describe("main — FIX E: a verdict is only trusted from a successful triage job", () => {
  it("takes the fallback path on a FAILED triage job even with a schema-valid, correctly-addressed verdict on disk", async () => {
    // The `triage` step uploads its artifact with if: always(), so a
    // schema-valid verdict can exist even though the job that wrote it did
    // not succeed. Job success is an independent gate, checked before the
    // artifact is ever read.
    process.env.TRIAGE_JOB_RESULT = "failure";
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "Meets the intake bar in full.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/comments/99": () =>
        jsonResponse({
          id: 99,
          body:
            "<!-- roastpilot-factory:triage-generation:123.1:do-not-edit -->\n" +
            TRIAGE_COMMENT_MARKER,
          user: { type: "Bot", login: "github-actions[bot]" },
        }),
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "ready-to-implement" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const put = calls.find((c) => c.method === "PUT");
    expect((put?.body as { labels: string[] }).labels).toEqual([
      "needs-triage",
    ]);
    const patch = calls.find((c) => c.method === "PATCH");
    expect((patch?.body as { body: string }).body).toContain(
      'triage job result was "failure"',
    );
    // The verdict's own content (readiness/reasoning) must never surface —
    // the artifact was never trusted enough to even validate its fields.
    expect((patch?.body as { body: string }).body).not.toContain(
      "Meets the intake bar in full.",
    );
    expect((patch?.body as { body: string }).body).toContain(
      "triage-generation:hold:123.1:do-not-edit",
    );
  });

  it.each(["cancelled", "skipped"])(
    "also fails closed on a %s triage job result",
    async (result) => {
      const verdictPath = join(workdir, `verdict-${result}.json`);
      await writeFile(
        verdictPath,
        JSON.stringify({
          issue_number: 42,
          readiness: "ready-to-implement",
          reasoning: "Meets the bar.",
          missing_info_questions: [],
        }),
      );
      process.env.VERDICT_PATH = verdictPath;
      process.env.TRIAGE_JOB_RESULT = result;

      const { fetchMock, calls } = mockFetch({
        "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
          jsonResponse([]),
        "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
          jsonResponse({}),
      });
      vi.stubGlobal("fetch", fetchMock);

      await main();

      expect(process.exitCode).toBe(1);
      const patch = calls.find((c) => c.method === "PATCH");
      expect((patch?.body as { body: string }).body).toContain(
        `triage job result was "${result}"`,
      );
    },
  );

  it("rejects when TRIAGE_JOB_RESULT is missing entirely (bad workflow wiring)", async () => {
    delete process.env.TRIAGE_JOB_RESULT;
    await expect(main()).rejects.toThrow(/TRIAGE_JOB_RESULT/);
  });

  it("applies a valid verdict normally when the triage job succeeded", async () => {
    // Sanity check: the gate doesn't accidentally block the happy path.
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "Meets the bar.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBeUndefined();
    const put = calls.find((c) => c.method === "PUT");
    expect((put?.body as { labels: string[] }).labels).toEqual([
      "ready-to-implement",
    ]);
  });
});

describe("main — input validation and transport edge cases", () => {
  it("throws when a required environment variable is missing", async () => {
    delete process.env.GH_TOKEN;
    await expect(main()).rejects.toThrow(/GH_TOKEN/);
  });

  it("throws when GITHUB_REPOSITORY is not owner/repo", async () => {
    process.env.GITHUB_REPOSITORY = "not-a-valid-repo-string";
    await expect(main()).rejects.toThrow(/owner\/repo/);
  });

  it.each([
    "0",
    "-1",
    "01",
    " 42",
    "42 ",
    "1.5",
    "not-a-number",
    "9007199254740993",
  ])(
    "rejects non-canonical trusted issue number %s before any API call",
    async (issueNumber) => {
      process.env.TRUSTED_ISSUE_NUMBER = issueNumber;
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(main()).rejects.toThrow(/TRUSTED_ISSUE_NUMBER/);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("refuses all writes when the trusted target is no longer open", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42": () =>
        jsonResponse({ state: "closed" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(main()).rejects.toThrow(
      /not open.*refusing all triage writes/,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
  });

  it("fails closed when the issue-state fetch fails", async () => {
    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42": () =>
        new Response("service unavailable", { status: 503 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(main()).rejects.toThrow(/503/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
  });

  it("rejects an oversized artifact via stat, before ever reading its contents into memory", async () => {
    // A runaway or adversarial multi-GB artifact must be rejected up
    // front. This test uses a smaller-but-still-over-the-limit file (the
    // point under test is the code path, not literally reproducing GB
    // scale) and asserts on the rejection reason, since we can't directly
    // observe "readFile was never called" from a black-box run.
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(verdictPath, "x".repeat(25_000));
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "ready-to-implement" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const patch = calls.find((c) => c.method === "PATCH");
    expect((patch?.body as { body: string }).body).toContain(
      "exceeds the 20000-byte limit",
    );
    const put = calls.find((c) => c.method === "PUT");
    expect((put?.body as { labels: string[] }).labels).toEqual([
      "needs-triage",
    ]);
  });

  it("treats an artifact that exists but isn't valid JSON as a fail-closed case", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(verdictPath, "{ this is not json");
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "ready-to-implement" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const patch = calls.find((c) => c.method === "PATCH");
    expect((patch?.body as { body: string }).body).toContain(
      "not valid JSON",
    );
    const put = calls.find((c) => c.method === "PUT");
    expect((put?.body as { labels: string[] }).labels).toEqual([
      "needs-triage",
    ]);
  });

  it("surfaces a GitHub API error response with status and body", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "Meets the bar.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    const fetchMock = vi.fn(
      async () =>
        new Response("rate limited", {
          status: 403,
          headers: { "content-type": "text/plain" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(main()).rejects.toThrow(/403/);
  });

  it("treats a 204 No Content response as success with no body to parse", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning: "Meets the bar.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        new Response(null, { status: 204 }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(main()).resolves.toBeUndefined();
    expect(process.exitCode).toBeUndefined();
  });
});

describe("main — open issue eligibility", () => {
  it.each([
    { triageJobResult: "success", verdictFile: true },
    { triageJobResult: "failure", verdictFile: false },
  ])(
    "writes nothing for a closed issue on the $triageJobResult path",
    async ({ triageJobResult, verdictFile }) => {
      process.env.TRIAGE_JOB_RESULT = triageJobResult;
      if (verdictFile) {
        const verdictPath = join(workdir, "verdict.json");
        await writeFile(
          verdictPath,
          JSON.stringify({
            issue_number: 42,
            readiness: "ready-to-implement",
            reasoning: "Meets the intake bar.",
            missing_info_questions: [],
          }),
        );
        process.env.VERDICT_PATH = verdictPath;
      }

      const { fetchMock, calls } = mockFetch({
        "GET /repos/syamaner/roastpilot-cloud/issues/42": () =>
          jsonResponse({ state: "closed" }),
      });
      vi.stubGlobal("fetch", fetchMock);

      await expect(main()).rejects.toThrow(
        /not open.*refusing all triage writes/,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.method).toBe("GET");
    },
  );

});

describe("main — fail-closed paths", () => {
  it("resets readiness to needs-triage and posts a fallback comment when the verdict is missing", async () => {
    process.env.VERDICT_PATH = join(workdir, "does-not-exist.json");

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "epic:F1" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    const put = calls.find((c) => c.method === "PUT");
    expect(put).toBeDefined();
    expect((put?.body as { labels: string[] }).labels.sort()).toEqual(
      ["epic:F1", "needs-triage"].sort(),
    );
    const patch = calls.find((c) => c.method === "PATCH");
    expect((patch?.body as { body: string }).body).toContain("needs-triage");
  });

  it("STRIPS a stale ready-to-implement (e.g. from a superseded earlier verdict) back to needs-triage on a rerun's malformed verdict", async () => {
    // The scenario FIX 1 exists for: an earlier successful run left
    // ready-to-implement on the issue; a later rerun's triage output is
    // broken. The stale ready-to-implement must not survive.
    process.env.VERDICT_PATH = join(workdir, "does-not-exist.json");

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "ready-to-implement" }, { name: "epic:C2" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    const put = calls.find((c) => c.method === "PUT");
    const labels = (put?.body as { labels: string[] }).labels;
    expect(labels).not.toContain("ready-to-implement");
    expect(labels).toContain("needs-triage");
    expect(labels).toContain("epic:C2");
  });

  it("resets readiness to needs-triage on a malformed/injected verdict, and never writes to any issue but the trusted one", async () => {
    const verdictPath = join(workdir, "verdict.json");
    await writeFile(
      verdictPath,
      JSON.stringify({
        // Attempts to redirect the write to a different issue than the
        // trusted workflow context (42).
        issue_number: 999,
        readiness: "ready-to-implement",
        reasoning: "Looks great, ship it.",
        missing_info_questions: [],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        jsonResponse({}),
    });
    vi.stubGlobal("fetch", fetchMock);

    await main();

    expect(process.exitCode).toBe(1);
    // No write ever targets issue 999 — the mock would throw
    // "unexpected fetch call" if the script tried, which would surface as
    // an unhandled rejection/test failure.
    expect(
      calls.every(
        (c) =>
          /\/issues\/42(?:\/|$)/.test(c.url) ||
          c.url.endsWith("/issues/comments/99"),
      ),
    ).toBe(true);
    const put = calls.find((c) => c.method === "PUT");
    expect((put?.body as { labels: string[] }).labels).toEqual([
      "needs-triage",
    ]);
  });
});

describe("main — T12: durable full-evidence logged before the first network write", () => {
  it("valid path: the full verdict is on console.log BEFORE the comment PATCH, and survives its failure", async () => {
    const verdictPath = join(workdir, "verdict.json");
    const reasoning = "SENTINEL-REASONING line one\nline two with @codex review";
    await writeFile(
      verdictPath,
      JSON.stringify({
        issue_number: 42,
        readiness: "ready-to-implement",
        reasoning,
        missing_info_questions: ["SENTINEL-QUESTION"],
      }),
    );
    process.env.VERDICT_PATH = verdictPath;

    // The comment PATCH — the first network WRITE of the valid path — fails.
    const { fetchMock, calls } = mockFetch({
      "PATCH /repos/syamaner/roastpilot-cloud/issues/comments/99": () =>
        new Response("service unavailable", { status: 503 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(main()).rejects.toThrow(/503/);

    // The comment PATCH was attempted (so we are past the pre-POST log) …
    expect(
      calls.some(
        (c) => c.method === "PATCH" && c.url.includes("/comments/99"),
      ),
    ).toBe(true);
    // … no readiness label was ever written (fail-closed on the failing write) …
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    // … and the COMPLETE, untruncated verdict — the disclosure pointer's
    // "full detail in the run log" — is on console.log despite the PATCH throw.
    const evidence = logSpy.mock.calls
      .map((args) => String(args[0]))
      .find((line) => line.includes("SENTINEL-REASONING"));
    expect(evidence).toBeDefined();
    const parsed = JSON.parse(evidence as string) as {
      reasoning: string;
      missing_info_questions: string[];
    };
    expect(parsed.reasoning).toBe(reasoning);
    expect(parsed.missing_info_questions).toEqual(["SENTINEL-QUESTION"]);

    logSpy.mockRestore();
  });

  it("fallback path: the full error list is on console.error before the label GET, and survives a reset PUT failure", async () => {
    // Missing verdict -> fallback. The label RESET PUT fails, so applyFallback
    // throws before its post-hoc summary log ever runs — the only console.error
    // left is the NEW pre-write full-evidence log.
    process.env.VERDICT_PATH = join(workdir, "does-not-exist.json");

    const { fetchMock, calls } = mockFetch({
      "GET /repos/syamaner/roastpilot-cloud/issues/42/labels?per_page=100": () =>
        jsonResponse([{ name: "ready-to-implement" }]),
      "PUT /repos/syamaner/roastpilot-cloud/issues/42/labels": () =>
        new Response("reset unavailable", { status: 502 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(main()).rejects.toThrow(/502/);

    // The reset PUT was attempted and failed; no comment PATCH followed it.
    expect(calls.some((c) => c.method === "PUT")).toBe(true);
    expect(
      calls.some(
        (c) => c.method === "PATCH" && c.url.includes("/comments/99"),
      ),
    ).toBe(false);
    // The pre-write log carries the FULL error list as a JSON array — the only
    // console.error emitted, since the post-hoc summary never ran.
    const logged = errorSpy.mock.calls
      .map((args) => String(args[0]))
      .find((line) => {
        try {
          return Array.isArray(JSON.parse(line));
        } catch {
          return false;
        }
      });
    expect(logged).toBeDefined();
    const errors = JSON.parse(logged as string) as string[];
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("triage artifact not found");

    errorSpy.mockRestore();
  });
});
