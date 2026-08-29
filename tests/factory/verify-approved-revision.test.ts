import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildApprovedRevisionMarker,
  buildTriageGenerationMarker,
  TRIAGE_COMMENT_MARKER,
} from "../../scripts/factory/apply-triage-verdict-logic.mts";
import { canonicalIssueRevision } from "../../scripts/factory/approve-revision.mts";
import {
  main,
  verifyApprovedRevision,
} from "../../scripts/factory/verify-approved-revision.mts";

let workdir: string;
let contextPath: string;
const ISSUE_TITLE = "Current issue title";

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
    const comment = authorizingComment(
      canonicalIssueRevision(ISSUE_TITLE, "reviewed"),
    );
    expect(() => verifyApprovedRevision(ISSUE_TITLE, "mutated", comment)).toThrow(
      /does not match/,
    );
  });

  it("M-B3 accepts a current body matching the marker byte-for-byte", () => {
    const body = "reviewed body\nincluding trailing newline\n";
    const comment = authorizingComment(canonicalIssueRevision(ISSUE_TITLE, body));
    expect(() => verifyApprovedRevision(ISSUE_TITLE, body, comment)).not.toThrow();
  });

  it("M-B3 fails closed after a title-only edit", () => {
    const body = "approved body";
    const comment = authorizingComment(
      canonicalIssueRevision("Approved title", body),
    );
    expect(() => verifyApprovedRevision("Edited title", body, comment)).toThrow(
      /does not match/,
    );
  });

  it("M-B3 preserves the manual-dispatch path when no marker exists", () => {
    const legacyComment =
      `${buildTriageGenerationMarker("123.1")}\n${TRIAGE_COMMENT_MARKER}`;
    expect(() => verifyApprovedRevision(ISSUE_TITLE, "current body", legacyComment))
      .not.toThrow();
  });

  it.each([
    ["bad hex", "not-a-digest"],
    ["uppercase hex", "A".repeat(64)],
  ])("fails closed for a present-but-malformed marker with %s", (_name, revision) => {
    const malformedComment =
      `<!-- roastpilot-factory:approved-revision:${revision}:do-not-edit -->\n` +
      `${buildTriageGenerationMarker("123.1")}\n${TRIAGE_COMMENT_MARKER}`;
    expect(() => verifyApprovedRevision(ISSUE_TITLE, "current body", malformedComment)).toThrow(
      "malformed approved-revision marker",
    );
  });

  it("fails closed for a present approved-revision marker in non-terminal placement", () => {
    const revision = canonicalIssueRevision(ISSUE_TITLE, "current body");
    const misplacedComment =
      `${buildApprovedRevisionMarker(revision)}\n` +
      "untrusted trailing text\n" +
      `${buildTriageGenerationMarker("123.1")}\n${TRIAGE_COMMENT_MARKER}`;
    expect(() => verifyApprovedRevision(ISSUE_TITLE, "current body", misplacedComment)).toThrow(
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
    ["missing issue title", { body: "current", comments: [] }],
    ["non-string issue title", { title: 42, body: "current", comments: [] }],
    ["non-string issue body", { title: ISSUE_TITLE, body: 42, comments: [] }],
    ["non-array comments", { title: ISSUE_TITLE, body: "current", comments: {} }],
  ])("fails closed for a malformed %s", async (_name, context) => {
    await writeContext(context);
    await expect(main()).rejects.toThrow(
      "malformed title, body, or comments",
    );
  });

  it("fails closed when no factory triage history exists", async () => {
    await writeContext({ title: ISSUE_TITLE, body: "current", comments: [] });
    await expect(main()).rejects.toThrow(
      "expected exactly one authorizing triage comment body",
    );
  });

  it("fails closed when more than one factory triage history exists", async () => {
    await writeContext({
      body: "current",
      title: ISSUE_TITLE,
      comments: [history("first"), history("second")],
    });
    await expect(main()).rejects.toThrow(
      "expected exactly one authorizing triage comment body",
    );
  });

  it("fails closed when the authorizing history body is not a string", async () => {
    await writeContext({
      title: ISSUE_TITLE,
      body: "current",
      comments: [history(42)],
    });
    await expect(main()).rejects.toThrow(
      "expected exactly one authorizing triage comment body",
    );
  });

  it("accepts one authorizing history whose marker matches the current body", async () => {
    const body = "current body\nwith exact bytes\n";
    await writeContext({
      title: ISSUE_TITLE,
      body,
      comments: [
        history(authorizingComment(canonicalIssueRevision(ISSUE_TITLE, body))),
      ],
    });
    await expect(main()).resolves.toBeUndefined();
  });
});
