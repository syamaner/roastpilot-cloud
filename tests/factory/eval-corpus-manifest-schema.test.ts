import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MANIFEST_CASE_ALLOWED_KEYS,
  MAX_MANIFEST_BYTES,
  validateCorpusManifest,
} from "../../scripts/factory/eval/corpus-manifest-schema.mts";
import { isUtf8PayloadWithinLimit } from "../../scripts/factory/eval/validation-common.mts";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const MANIFEST_URL = new URL("../../eval/corpus/manifest.json", import.meta.url);

interface CaseOptions {
  readonly caseId?: string;
  readonly issueNumber?: number;
  readonly stage?: "triage-and-implement" | "triage-only";
  readonly prNumber?: number | null;
  readonly implementPatchPath?: string | null;
  readonly decisionContextPath?: string | null;
}

function validCase(options: CaseOptions = {}): Record<string, unknown> {
  const caseId = options.caseId ?? "issue-009-example";
  const issueNumber = options.issueNumber ?? 9;
  const stage = options.stage ?? "triage-only";
  const prNumber =
    options.prNumber !== undefined
      ? options.prNumber
      : stage === "triage-and-implement"
        ? 10
        : null;
  const implementPatchPath =
    options.implementPatchPath !== undefined
      ? options.implementPatchPath
      : stage === "triage-and-implement"
        ? `inputs/${caseId}/recorded/implement.patch`
        : null;
  return {
    caseId,
    issueNumber,
    prNumber,
    stage,
    baseSha: SHA,
    capturedAt: "2026-08-16T08:57:42Z",
    pin: {
      actionRef: "v1.0.176",
      actionCommit: SHA,
      resolvedModel: null,
      triageSkillVersion: null,
      implementPromptVersion: null,
    },
    issueSnapshotPath: `inputs/${caseId}/issue-snapshot.json`,
    decisionContextPath:
      options.decisionContextPath === undefined
        ? null
        : options.decisionContextPath,
    recorded: {
      triageVerdictPath: `inputs/${caseId}/recorded/triage-verdict.json`,
      implementPatchPath,
    },
    notes: "A valid frozen corpus case.",
  };
}

function validManifest(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    description: "A valid manifest fixture.",
    cases: [validCase()],
  };
}

function expectSingleRejection(raw: unknown): void {
  const result = validateCorpusManifest(raw);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.errors).toHaveLength(1);
  }
}

function onlyCase(manifest: Record<string, unknown>): Record<string, unknown> {
  return (manifest.cases as Record<string, unknown>[])[0];
}

describe("validateCorpusManifest", () => {
  it("T1 validates the committed corpus manifest", () => {
    const raw = JSON.parse(readFileSync(MANIFEST_URL, "utf8")) as unknown;
    const result = validateCorpusManifest(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cases).toHaveLength(12);
    }
  });

  it.each([
    ["null", null],
    ["array", []],
    ["string", "manifest"],
    ["number", 1],
  ])("T2 rejects a non-object %s root", (_name, raw) => {
    expectSingleRejection(raw);
  });

  it("T3 rejects an unknown top-level key", () => {
    expectSingleRejection({ ...validManifest(), injected: true });
  });

  it("rejects an answer-verdict token in the top-level description", () => {
    expectSingleRejection({
      ...validManifest(),
      description: "Recorded cases expected ready-to-implement.",
    });
  });

  it("T4 rejects an unknown case key", () => {
    const manifest = validManifest();
    onlyCase(manifest).injected = true;
    expectSingleRejection(manifest);
  });

  it("T5 rejects an unknown pin key", () => {
    const manifest = validManifest();
    (onlyCase(manifest).pin as Record<string, unknown>).injected = true;
    expectSingleRejection(manifest);
  });

  it("T6 rejects an unknown recorded key", () => {
    const manifest = validManifest();
    (onlyCase(manifest).recorded as Record<string, unknown>).injected = true;
    expectSingleRejection(manifest);
  });

  it("T7 rejects schemaVersion 2", () => {
    expectSingleRejection({ ...validManifest(), schemaVersion: 2 });
  });

  it("T8 rejects an empty cases array", () => {
    expectSingleRejection({ ...validManifest(), cases: [] });
  });

  it("T9 rejects a duplicate caseId", () => {
    const corpusCase = validCase();
    expectSingleRejection({
      ...validManifest(),
      cases: [corpusCase, structuredClone(corpusCase)],
    });
  });

  it.each([...MANIFEST_CASE_ALLOWED_KEYS])(
    "T10 rejects a case missing required key %s",
    (key) => {
      const manifest = validManifest();
      delete onlyCase(manifest)[key];
      expectSingleRejection(manifest);
    },
  );

  it.each(["Triage-Only", "implement-only"])(
    "T11 rejects byte-inexact or unknown stage %s",
    (stage) => {
      const manifest = validManifest();
      onlyCase(manifest).stage = stage;
      expectSingleRejection(manifest);
    },
  );

  it.each([
    [
      "stage",
      {
        stage: "triage-and-implement",
        prNumber: null,
        implementPatchPath: null,
      },
    ],
    ["prNumber", { prNumber: 10 }],
    [
      "implementPatchPath",
      {
        implementPatchPath:
          "inputs/issue-009-example/recorded/implement.patch",
      },
    ],
  ] as const)("T12 rejects a lone %s implementation signal", (_name, options) => {
    expectSingleRejection({ ...validManifest(), cases: [validCase(options)] });
  });

  it("rejects a prNumber above Number.MAX_SAFE_INTEGER", () => {
    const manifest = {
      ...validManifest(),
      cases: [validCase({ stage: "triage-and-implement" })],
    };
    onlyCase(manifest).prNumber = 9_007_199_254_740_992;
    expectSingleRejection(manifest);
  });

  it.each(["a".repeat(39), "A".repeat(40)])(
    "T13 rejects an invalid baseSha %s",
    (baseSha) => {
      const manifest = validManifest();
      onlyCase(manifest).baseSha = baseSha;
      expectSingleRejection(manifest);
    },
  );

  it.each([
    "2026-08-16T08:57:42+00:00",
    "2026-08-16T08:57:42.123Z",
  ])("T14 rejects a non-canonical capturedAt %s", (capturedAt) => {
    const manifest = validManifest();
    onlyCase(manifest).capturedAt = capturedAt;
    expectSingleRejection(manifest);
  });

  it.each([
    "2026-99-99T99:99:99Z",
    "2026-13-01T00:00:00Z",
    "2026-02-30T08:57:42Z",
    "2026-00-10T00:00:00Z",
    "2026-08-00T00:00:00Z",
    "2026-08-16T24:00:00Z",
    "2026-08-16T00:60:00Z",
    "2026-08-16T00:00:60Z",
    "2026-02-29T00:00:00Z",
    "1900-02-29T00:00:00Z",
  ])("rejects a calendar-impossible capturedAt %s", (capturedAt) => {
    const manifest = validManifest();
    onlyCase(manifest).capturedAt = capturedAt;
    expectSingleRejection(manifest);
  });

  it("accepts a real leap-day capturedAt", () => {
    const manifest = validManifest();
    onlyCase(manifest).capturedAt = "2028-02-29T00:00:00Z";
    expect(validateCorpusManifest(manifest).ok).toBe(true);

    onlyCase(manifest).capturedAt = "2000-02-29T00:00:00Z";
    expect(validateCorpusManifest(manifest).ok).toBe(true);
  });

  it.each([
    ["issue-09-x", 9],
    ["issue-010-x", 9],
  ])("T15 rejects mismatched caseId %s", (caseId, issueNumber) => {
    expectSingleRejection({
      ...validManifest(),
      cases: [validCase({ caseId, issueNumber })],
    });
  });

  it("accepts a four-digit issue identity", () => {
    expect(
      validateCorpusManifest({
        ...validManifest(),
        cases: [
          validCase({ caseId: "issue-1000-example", issueNumber: 1000 }),
        ],
      }).ok,
    ).toBe(true);
  });

  it("rejects a four-digit caseId that mismatches issueNumber", () => {
    expectSingleRejection({
      ...validManifest(),
      cases: [
        validCase({ caseId: "issue-1000-example", issueNumber: 999 }),
      ],
    });
  });

  it.each([
    "inputs/issue-010-other/issue-snapshot.json",
    "../../secrets",
    "/tmp/issue-snapshot.json",
  ])("T16 rejects non-canonical issueSnapshotPath %s", (snapshotPath) => {
    const manifest = validManifest();
    onlyCase(manifest).issueSnapshotPath = snapshotPath;
    expectSingleRejection(manifest);
  });

  it("T17 rejects a non-canonical decisionContextPath and accepts null", () => {
    const invalid = validManifest();
    onlyCase(invalid).decisionContextPath =
      "inputs/issue-009-example/other-context.md";
    expectSingleRejection(invalid);
    expect(validateCorpusManifest(validManifest()).ok).toBe(true);
  });

  it("T18 exports the loader byte bound and UTF-8 guard", () => {
    expect(MAX_MANIFEST_BYTES).toBe(262_144);
    expect(isUtf8PayloadWithinLimit("é", 2)).toBe(true);
    expect(isUtf8PayloadWithinLimit("é", 1)).toBe(false);
  });

  it("T19 enforces required strings and accepts nullable resolvedModel", () => {
    const nullNotes = validManifest();
    onlyCase(nullNotes).notes = null;
    expectSingleRejection(nullNotes);

    const nullSha = validManifest();
    onlyCase(nullSha).baseSha = null;
    expectSingleRejection(nullSha);

    const nullableModel = validManifest();
    (onlyCase(nullableModel).pin as Record<string, unknown>).resolvedModel = null;
    expect(validateCorpusManifest(nullableModel).ok).toBe(true);
  });

  it("T20 rejects a non-SHA triageSkillVersion", () => {
    const manifest = validManifest();
    (onlyCase(manifest).pin as Record<string, unknown>).triageSkillVersion =
      "v1.2";
    expectSingleRejection(manifest);
  });

  it("rejects answer-verdict tokens in a caseId slug", () => {
    expectSingleRejection({
      ...validManifest(),
      cases: [validCase({ caseId: "issue-009-ready-to-implement" })],
    });
  });

  it.each(["ready-to-implement", "clean-pass", "READY-TO-IMPLEMENT"])(
    "rejects answer-verdict token %s in notes",
    (token) => {
      const manifest = validManifest();
      onlyCase(manifest).notes = `Recorded case leaked ${token}.`;
      expectSingleRejection(manifest);
    },
  );

  it("accepts topic words and non-token substrings", () => {
    const corpusCase = validCase({
      caseId: "issue-058-grant-hardening",
      issueNumber: 58,
    });
    corpusCase.notes = "The case is already frozen for hardening analysis.";
    expect(
      validateCorpusManifest({ ...validManifest(), cases: [corpusCase] }).ok,
    ).toBe(true);
  });

  it("rejects other malformed required top-level and nested fields", () => {
    const emptyDescription = validManifest();
    emptyDescription.description = "";
    expectSingleRejection(emptyDescription);

    const nonArrayCases = validManifest();
    nonArrayCases.cases = "not-an-array";
    expectSingleRejection(nonArrayCases);

    const nonObjectCase = validManifest();
    nonObjectCase.cases = [null];
    expectSingleRejection(nonObjectCase);

    const emptyActionRef = validManifest();
    (onlyCase(emptyActionRef).pin as Record<string, unknown>).actionRef = "";
    expectSingleRejection(emptyActionRef);

    const badActionCommit = validManifest();
    (onlyCase(badActionCommit).pin as Record<string, unknown>).actionCommit =
      "A".repeat(40);
    expectSingleRejection(badActionCommit);

    const emptyResolvedModel = validManifest();
    (onlyCase(emptyResolvedModel).pin as Record<string, unknown>).resolvedModel =
      "";
    expectSingleRejection(emptyResolvedModel);

    const badImplementVersion = validManifest();
    (
      onlyCase(badImplementVersion).pin as Record<string, unknown>
    ).implementPromptVersion = "main";
    expectSingleRejection(badImplementVersion);
  });

  it("rejects non-canonical recorded paths and accepts canonical optional paths", () => {
    const badTriagePath = validManifest();
    (
      onlyCase(badTriagePath).recorded as Record<string, unknown>
    ).triageVerdictPath = "inputs/issue-010-other/recorded/triage-verdict.json";
    expectSingleRejection(badTriagePath);

    const badImplementPath = {
      ...validManifest(),
      cases: [validCase({ stage: "triage-and-implement" })],
    };
    (
      onlyCase(badImplementPath).recorded as Record<string, unknown>
    ).implementPatchPath = "../../implement.patch";
    expectSingleRejection(badImplementPath);

    const withDecisionContext = validCase({
      decisionContextPath: "inputs/issue-009-example/decision-context.md",
    });
    expect(
      validateCorpusManifest({ ...validManifest(), cases: [withDecisionContext] })
        .ok,
    ).toBe(true);
  });
});
