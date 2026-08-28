import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildApprovedRevisionMarker,
  buildTriageGenerationMarker,
  TRIAGE_COMMENT_MARKER,
} from "../../scripts/factory/apply-triage-verdict-logic.mts";
import { computeApprovedRevision } from "../../scripts/factory/approve-revision.mts";
import {
  main,
  verifyApprovedRevision,
} from "../../scripts/factory/verify-approved-revision.mts";

let workdir: string;
let contextPath: string;

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), "verify-approved-revision-"));
  contextPath = join(workdir, "issue-context.json");
  process.env.ISSUE_CONTEXT_PATH = contextPath;
});

afterEach(async () => {
  delete process.env.ISSUE_CONTEXT_PATH;
  await rm(workdir, { recursive: true, force: true });
});

function authorizingComment(revision: string): string {
  return (
    `${buildApprovedRevisionMarker(revision)}\n` +
    `${buildTriageGenerationMarker("123.1")}\n${TRIAGE_COMMENT_MARKER}`
  );
}

describe("implementation approved-revision consumer", () => {
  it("M-B3 fails closed when the current body differs from the marker", () => {
    const comment = authorizingComment(computeApprovedRevision("reviewed"));
    expect(() => verifyApprovedRevision("mutated", comment)).toThrow(
      /does not match/,
    );
  });

  it("M-B3 accepts a current body matching the marker byte-for-byte", () => {
    const body = "reviewed body\nincluding trailing newline\n";
    const comment = authorizingComment(computeApprovedRevision(body));
    expect(() => verifyApprovedRevision(body, comment)).not.toThrow();
  });

  it("M-B3 preserves the manual-dispatch path when no marker exists", () => {
    const legacyComment =
      `${buildTriageGenerationMarker("123.1")}\n${TRIAGE_COMMENT_MARKER}`;
    expect(() => verifyApprovedRevision("current body", legacyComment))
      .not.toThrow();
  });

  it.each([
    ["bad hex", "not-a-digest"],
    ["uppercase hex", "A".repeat(64)],
  ])("fails closed for a present-but-malformed marker with %s", (_name, revision) => {
    const malformedComment =
      `<!-- roastpilot-factory:approved-revision:${revision}:do-not-edit -->\n` +
      `${buildTriageGenerationMarker("123.1")}\n${TRIAGE_COMMENT_MARKER}`;
    expect(() => verifyApprovedRevision("current body", malformedComment)).toThrow(
      "malformed approved-revision marker",
    );
  });

  it("fails closed for a present approved-revision marker in non-terminal placement", () => {
    const revision = computeApprovedRevision("current body");
    const misplacedComment =
      `${buildApprovedRevisionMarker(revision)}\n` +
      "untrusted trailing text\n" +
      `${buildTriageGenerationMarker("123.1")}\n${TRIAGE_COMMENT_MARKER}`;
    expect(() => verifyApprovedRevision("current body", misplacedComment)).toThrow(
      "malformed approved-revision marker",
    );
  });
});

async function writeContext(context: unknown): Promise<void> {
  await writeFile(contextPath, JSON.stringify(context));
}

function history(body: unknown): Record<string, unknown> {
  return { kind: "factory_triage_history", body };
}

describe("approved-revision consumer entrypoint", () => {
  it("fails closed when ISSUE_CONTEXT_PATH is absent", async () => {
    delete process.env.ISSUE_CONTEXT_PATH;
    await expect(main()).rejects.toThrow(
      "missing required environment variable: ISSUE_CONTEXT_PATH",
    );
  });

  it.each([
    ["non-record context", null],
    ["non-string issue body", { body: 42, comments: [] }],
    ["non-array comments", { body: "current", comments: {} }],
  ])("fails closed for a malformed %s", async (_name, context) => {
    await writeContext(context);
    await expect(main()).rejects.toThrow("malformed body or comments");
  });

  it("fails closed when no factory triage history exists", async () => {
    await writeContext({ body: "current", comments: [] });
    await expect(main()).rejects.toThrow(
      "expected exactly one authorizing triage comment body",
    );
  });

  it("fails closed when more than one factory triage history exists", async () => {
    await writeContext({
      body: "current",
      comments: [history("first"), history("second")],
    });
    await expect(main()).rejects.toThrow(
      "expected exactly one authorizing triage comment body",
    );
  });

  it("fails closed when the authorizing history body is not a string", async () => {
    await writeContext({ body: "current", comments: [history(42)] });
    await expect(main()).rejects.toThrow(
      "expected exactly one authorizing triage comment body",
    );
  });

  it("accepts one authorizing history whose marker matches the current body", async () => {
    const body = "current body\nwith exact bytes\n";
    await writeContext({
      body,
      comments: [history(authorizingComment(computeApprovedRevision(body)))],
    });
    await expect(main()).resolves.toBeUndefined();
  });
});
