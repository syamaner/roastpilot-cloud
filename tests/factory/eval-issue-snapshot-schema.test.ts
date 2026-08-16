import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAX_SNAPSHOT_BYTES,
  SNAPSHOT_ALLOWED_KEYS,
  validateIssueSnapshot,
} from "../../scripts/factory/eval/issue-snapshot-schema.mts";
import { isUtf8PayloadWithinLimit } from "../../scripts/factory/eval/validation-common.mts";

const CORPUS_URL = new URL("../../eval/corpus/", import.meta.url);
const COMMITTED_MANIFEST = JSON.parse(
  readFileSync(new URL("manifest.json", CORPUS_URL), "utf8"),
) as { readonly cases: readonly { readonly issueSnapshotPath: string }[] };
const SNAPSHOT_PATHS = COMMITTED_MANIFEST.cases.map(
  ({ issueSnapshotPath }) => new URL(issueSnapshotPath, CORPUS_URL),
);

function validSnapshot(): Record<string, unknown> {
  return {
    issueNumber: 9,
    title: "A valid frozen issue",
    body: "Acceptance criteria and bounded scope.",
    labels: ["needs-triage"],
    state: "OPEN",
    snapshotAt: "2026-08-16T08:57:42Z",
    sourceUrl: "https://github.com/syamaner/roastpilot-cloud/issues/9",
  };
}

function expectSingleRejection(raw: unknown): void {
  const result = validateIssueSnapshot(raw);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors).toHaveLength(1);
  }
}

describe("validateIssueSnapshot", () => {
  it.each(SNAPSHOT_PATHS)("T21 validates committed snapshot %s", (path) => {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    expect(validateIssueSnapshot(raw).ok, path.href).toBe(true);
  });

  it("T22 rejects an unknown key", () => {
    expectSingleRejection({ ...validSnapshot(), injected: true });
  });

  it.each([...SNAPSHOT_ALLOWED_KEYS])(
    "T23 rejects a missing required key %s",
    (key) => {
      const snapshot = validSnapshot();
      delete snapshot[key];
      expectSingleRejection(snapshot);
    },
  );

  it("T24 rejects a case-variant state", () => {
    expectSingleRejection({ ...validSnapshot(), state: "open" });
  });

  it("T25 rejects an empty label and labels encoded as a string", () => {
    expectSingleRejection({ ...validSnapshot(), labels: [""] });
    expectSingleRejection({ ...validSnapshot(), labels: "needs-triage" });
  });

  it.each([
    "https://github.com/syamaner/roastpilot-cloud/issues/10",
    "http://github.com/syamaner/roastpilot-cloud/issues/9",
    "https://github.com/syamaner/roastpilot-cloud/issues/9/",
  ])("T26 rejects a non-canonical sourceUrl %s", (sourceUrl) => {
    expectSingleRejection({ ...validSnapshot(), sourceUrl });
  });

  it("T27 exports the loader byte bound and UTF-8 guard", () => {
    expect(MAX_SNAPSHOT_BYTES).toBe(262_144);
    expect(isUtf8PayloadWithinLimit("é", 2)).toBe(true);
    expect(isUtf8PayloadWithinLimit("é", 1)).toBe(false);
  });

  it.each([
    "2026-08-16T08:57:42+00:00",
    "2026-08-16T08:57:42.123Z",
    "2026-02-30T08:57:42Z",
  ])("T28 rejects a non-instant snapshotAt %s", (snapshotAt) => {
    expectSingleRejection({ ...validSnapshot(), snapshotAt });
  });

  it("rejects a non-object snapshot", () => {
    expectSingleRejection(null);
  });

  it("rejects invalid scalar and label bounds without cascades", () => {
    expectSingleRejection({ ...validSnapshot(), issueNumber: 0 });
    expectSingleRejection({ ...validSnapshot(), title: "" });
    expectSingleRejection({ ...validSnapshot(), body: "" });
    expectSingleRejection({
      ...validSnapshot(),
      labels: Array.from({ length: 31 }, () => "label"),
    });
    expectSingleRejection({
      ...validSnapshot(),
      labels: ["x".repeat(101)],
    });
  });

  it("rejects an issueNumber above Number.MAX_SAFE_INTEGER", () => {
    const issueNumber = 9_007_199_254_740_992;
    expectSingleRejection({
      ...validSnapshot(),
      issueNumber,
      sourceUrl: `https://github.com/syamaner/roastpilot-cloud/issues/${String(issueNumber)}`,
    });
  });
});
