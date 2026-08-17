import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  IMPLEMENT_DIMENSIONS,
  TRIAGE_ONLY_DIMENSIONS,
  type EvalBaseline,
} from "../../scripts/factory/eval/eval-baseline-schema.mts";
import { loadCorpus } from "../../scripts/factory/eval/corpus-loader.mts";
import {
  RECORDED_MAX_RETRIES,
  RECORDED_TOLERANCE,
  REQUIRED_ISSUE_TYPE_FLOORS,
  REQUIRED_STAGE_FLOORS,
  evaluateAgainstBaseline,
  type RecordedCaseRecord,
  type RecordedEvalReport,
} from "../../scripts/factory/eval/eval-verdict-logic.mts";

const CORPUS_SHA256 = "b".repeat(64);
const CORPUS_ROOT = fileURLToPath(
  new URL("../../eval/corpus/", import.meta.url),
);

interface CaseDefinition {
  readonly caseId: string;
  readonly stage: RecordedCaseRecord["stage"];
  readonly issueType: RecordedCaseRecord["issueType"];
}

const CASE_DEFINITIONS: readonly CaseDefinition[] = [
  { caseId: "issue-009-registry-reconciliation", stage: "triage-and-implement", issueType: "documentation" },
  { caseId: "issue-023-dryrun-second", stage: "triage-only", issueType: "documentation" },
  { caseId: "issue-026-health-route-dryrun", stage: "triage-and-implement", issueType: "feature" },
  { caseId: "issue-058-grant-hardening", stage: "triage-and-implement", issueType: "hardening" },
  { caseId: "issue-059-public-grant-audit", stage: "triage-only", issueType: "schema" },
  { caseId: "issue-120-executable-closure", stage: "triage-only", issueType: "hardening" },
  { caseId: "issue-151-summary-binding", stage: "triage-and-implement", issueType: "security-fix" },
  { caseId: "issue-194-comment-injection", stage: "triage-only", issueType: "security-fix" },
  { caseId: "issue-205-retarget-hardening", stage: "triage-only", issueType: "security-fix" },
  { caseId: "issue-274-inert-noop", stage: "triage-only", issueType: "hardening" },
  { caseId: "issue-281-dryrun-utility", stage: "triage-only", issueType: "feature" },
  { caseId: "issue-284-vitest-timeout", stage: "triage-only", issueType: "hardening" },
];

function dimensionNames(definition: CaseDefinition): readonly string[] {
  return definition.stage === "triage-and-implement"
    ? IMPLEMENT_DIMENSIONS
    : TRIAGE_ONLY_DIMENSIONS;
}

function passingDimensions(
  names: readonly string[],
): RecordedCaseRecord["dimensions"] {
  return Object.fromEntries(
    names.map((name) => [name, { pass: true as const }]),
  );
}

function baselineFrom(
  definitions: readonly CaseDefinition[] = CASE_DEFINITIONS,
): EvalBaseline {
  const sorted = [...definitions].sort((left, right) =>
    left.caseId.localeCompare(right.caseId),
  );
  return {
    schemaVersion: 1,
    corpus: {
      corpusSha256: CORPUS_SHA256,
      caseIds: sorted.map((entry) => entry.caseId),
    },
    cases: sorted.map((entry) => ({
      caseId: entry.caseId,
      issueType: entry.issueType,
      dimensions: dimensionNames(entry),
    })),
  };
}

function reportFrom(
  definitions: readonly CaseDefinition[] = CASE_DEFINITIONS,
): RecordedEvalReport {
  return {
    cases: definitions.map((entry) => ({
      ...entry,
      dimensions: passingDimensions(dimensionNames(entry)),
      recordedPrOutcome: { deliberatelyIgnored: true },
    })),
  };
}

function expectReasons(result: ReturnType<typeof evaluateAgainstBaseline>) {
  expect(result.pass).toBe(false);
  if (result.pass) throw new Error("expected a non-pass verdict");
  return result.reasons;
}

describe("recorded evaluation aggregate verdict", () => {
  it("T126 passes a matching deterministic replay and pins zero retry tolerance", () => {
    const report = reportFrom();
    Object.defineProperty(report.cases[0], "recordedPrOutcome", {
      get() { throw new Error("recordedPrOutcome must remain unread"); },
    });
    expect(
      evaluateAgainstBaseline(
        report,
        baselineFrom(),
        CORPUS_SHA256,
      ),
    ).toEqual({ pass: true });
    expect(RECORDED_TOLERANCE).toBe(0);
    expect(RECORDED_MAX_RETRIES).toBe(0);
  });

  it("T127 rejects an absent baseline", () => {
    const reasons = expectReasons(
      evaluateAgainstBaseline(reportFrom(), undefined, CORPUS_SHA256),
    );
    expect(reasons.some((reason) => reason.includes("absent baseline"))).toBe(true);
  });

  it("T128 rejects a corpus hash mismatch", () => {
    expectReasons(
      evaluateAgainstBaseline(reportFrom(), baselineFrom(), "c".repeat(64)),
    );
  });

  it("T129 rejects case-set drift in both directions", () => {
    const complete = reportFrom();
    const replacement = complete.cases.find(
      (entry) => entry.caseId === "issue-274-inert-noop",
    )!;
    const missingBaselineCase: RecordedEvalReport = {
      cases: complete.cases
        .filter((entry) => entry.caseId !== "issue-120-executable-closure")
        .concat(replacement),
    };
    expect(
      evaluateAgainstBaseline(
        missingBaselineCase,
        baselineFrom(),
        CORPUS_SHA256,
      ).pass,
    ).toBe(false);

    const extraDefinition: CaseDefinition = {
      caseId: "issue-999-extra-case",
      stage: "triage-only",
      issueType: "hardening",
    };
    expect(
      evaluateAgainstBaseline(
        reportFrom([...CASE_DEFINITIONS, extraDefinition]),
        baselineFrom(),
        CORPUS_SHA256,
      ).pass,
    ).toBe(false);
  });

  it("T130 rejects per-case dimension-set drift", () => {
    const report = reportFrom();
    const drifted: RecordedEvalReport = {
      cases: report.cases.map((entry) =>
        entry.caseId === "issue-009-registry-reconciliation"
          ? { ...entry, dimensions: passingDimensions(TRIAGE_ONLY_DIMENSIONS) }
          : entry,
      ),
    };
    expectReasons(
      evaluateAgainstBaseline(drifted, baselineFrom(), CORPUS_SHA256),
    );
  });

  it("T131 makes one non-pass dimension fail the whole verdict with context", () => {
    const report = reportFrom();
    const failed: RecordedEvalReport = {
      cases: report.cases.map((entry) =>
        entry.caseId === "issue-009-registry-reconciliation"
          ? {
              ...entry,
              dimensions: {
                ...entry.dimensions,
                compile: { pass: false, reason: "compiler rejected patch" },
              },
            }
          : entry,
      ),
    };
    const reasons = expectReasons(
      evaluateAgainstBaseline(failed, baselineFrom(), CORPUS_SHA256),
    );
    expect(reasons).toContain(
      "issue-009-registry-reconciliation compile: compiler rejected patch",
    );
  });

  it("T148 treats a truthy non-boolean dimension pass as non-pass", () => {
    const report = reportFrom();
    const malformed: RecordedEvalReport = {
      cases: report.cases.map((entry) =>
        entry.caseId === "issue-009-registry-reconciliation"
          ? {
              ...entry,
              dimensions: {
                ...entry.dimensions,
                compile: {
                  pass: "false",
                  reason: "pass must be the boolean true",
                } as unknown as RecordedCaseRecord["dimensions"][string],
              },
            }
          : entry,
      ),
    };
    expect(
      evaluateAgainstBaseline(
        malformed,
        baselineFrom(),
        CORPUS_SHA256,
      ).pass,
    ).toBe(false);
  });

  it("T149 uses one dimension enumeration for set and verdict checks", () => {
    const target = {
      ...passingDimensions(IMPLEMENT_DIMENSIONS),
      compile: { pass: false as const, reason: "hidden compile failure" },
    };
    let enumerationCount = 0;
    const dimensions = new Proxy(target, {
      ownKeys(value) {
        enumerationCount += 1;
        const keys = Reflect.ownKeys(value);
        return enumerationCount === 1
          ? keys
          : keys.filter((key) => key !== "compile");
      },
    });
    const report = reportFrom();
    const hostile: RecordedEvalReport = {
      cases: report.cases.map((entry) =>
        entry.caseId === "issue-009-registry-reconciliation"
          ? { ...entry, dimensions }
          : entry,
      ),
    };
    expect(
      evaluateAgainstBaseline(
        hostile,
        baselineFrom(),
        CORPUS_SHA256,
      ).pass,
    ).toBe(false);
  });

  it("T150 rejects dimensions that match the baseline but not the case stage", () => {
    const caseId = "issue-009-registry-reconciliation";
    const triageDimensions = passingDimensions(TRIAGE_ONLY_DIMENSIONS);
    const report = reportFrom();
    const mismatchedReport: RecordedEvalReport = {
      cases: report.cases.map((entry) =>
        entry.caseId === caseId
          ? { ...entry, dimensions: triageDimensions }
          : entry,
      ),
    };
    const baseline = baselineFrom();
    const matchingBaseline: EvalBaseline = {
      ...baseline,
      cases: baseline.cases.map((entry) =>
        entry.caseId === caseId
          ? { ...entry, dimensions: TRIAGE_ONLY_DIMENSIONS }
          : entry,
      ),
    };
    expect(
      evaluateAgainstBaseline(
        mismatchedReport,
        matchingBaseline,
        CORPUS_SHA256,
      ).pass,
    ).toBe(false);
  });

  it("T151 rejects an issueType relabel that would inflate a floor", () => {
    const extraDocumentationCase: CaseDefinition = {
      caseId: "issue-999-extra-documentation",
      stage: "triage-only",
      issueType: "documentation",
    };
    const definitions = [...CASE_DEFINITIONS, extraDocumentationCase];
    const report = reportFrom(definitions);
    const relabeled: RecordedEvalReport = {
      cases: report.cases.map((entry) =>
        entry.caseId === "issue-009-registry-reconciliation"
          ? { ...entry, issueType: "schema" }
          : entry,
      ),
    };
    expect(
      evaluateAgainstBaseline(
        relabeled,
        baselineFrom(definitions),
        CORPUS_SHA256,
      ).pass,
    ).toBe(false);
  });

  it("T152 rejects a passing verdict with contradictory extra fields", () => {
    const report = reportFrom();
    const malformed: RecordedEvalReport = {
      cases: report.cases.map((entry) =>
        entry.caseId === "issue-009-registry-reconciliation"
          ? {
              ...entry,
              dimensions: {
                ...entry.dimensions,
                compile: {
                  pass: true,
                  reason: "contradictory",
                } as unknown as RecordedCaseRecord["dimensions"][string],
              },
            }
          : entry,
      ),
    };
    expect(
      evaluateAgainstBaseline(
        malformed,
        baselineFrom(),
        CORPUS_SHA256,
      ).pass,
    ).toBe(false);
  });

  it("T153 snapshots a stateful caseId before every downstream check", () => {
    const caseId = "issue-009-registry-reconciliation";
    const extraDocumentationCase: CaseDefinition = {
      caseId: "issue-999-extra-documentation",
      stage: "triage-only",
      issueType: "documentation",
    };
    const definitions = [...CASE_DEFINITIONS, extraDocumentationCase];
    const report = reportFrom(definitions);
    let caseIdReads = 0;
    const attacked: RecordedEvalReport = {
      cases: report.cases.map((entry) => {
        if (entry.caseId !== caseId) return entry;
        const relabeled = { ...entry, issueType: "schema" as const };
        Object.defineProperty(relabeled, "caseId", {
          enumerable: true,
          get() {
            caseIdReads += 1;
            return caseIdReads === 1 ? caseId : "issue-998-divergent";
          },
        });
        return relabeled;
      }),
    };
    expect(
      evaluateAgainstBaseline(
        attacked,
        baselineFrom(definitions),
        CORPUS_SHA256,
      ).pass,
    ).toBe(false);
  });

  it("T154 rejects a non-array cases container with a fabricated map result", () => {
    const report = reportFrom();
    const fabricatedSnapshots = report.cases.map((entry) => {
      const dimensionEntries = Object.entries(entry.dimensions);
      return {
        valid: true as const,
        caseId: entry.caseId,
        issueType: entry.issueType,
        stage: entry.stage,
        dimensionEntries,
        dimensionNames: dimensionEntries.map(([name]) => name).sort(),
      };
    });
    const hostileCases = {
      map() { return fabricatedSnapshots; },
    };
    const hostileReport = {
      cases: hostileCases as unknown as RecordedEvalReport["cases"],
    };
    expect(
      evaluateAgainstBaseline(
        hostileReport,
        baselineFrom(),
        CORPUS_SHA256,
      ).pass,
    ).toBe(false);
  });

  it("T155 rejects an out-of-domain stage before it can satisfy floors", () => {
    const caseId = "issue-023-dryrun-second";
    const extraDocumentationCase: CaseDefinition = {
      caseId: "issue-999-extra-documentation",
      stage: "triage-only",
      issueType: "documentation",
    };
    const definitions = [...CASE_DEFINITIONS, extraDocumentationCase];
    const report = reportFrom(definitions);
    const malformed: RecordedEvalReport = {
      cases: report.cases.map((entry) =>
        entry.caseId === caseId
          ? {
              ...entry,
              stage: "bogus" as unknown as RecordedCaseRecord["stage"],
            }
          : entry,
      ),
    };
    expect(
      evaluateAgainstBaseline(
        malformed,
        baselineFrom(definitions),
        CORPUS_SHA256,
      ).pass,
    ).toBe(false);
  });

  it("fails closed for malformed records and hostile verdict shapes", () => {
    const report = reportFrom();
    const first = report.cases[0];
    const throwingRecord = new Proxy(first, {
      get(target, key, receiver) {
        if (key === "dimensions") throw new Error("hostile dimensions getter");
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const throwingVerdict = new Proxy({ pass: true }, {
      ownKeys() { throw new Error("hostile verdict ownKeys"); },
    });
    const replacements: readonly unknown[] = [
      null,
      { ...first, caseId: 1 },
      { ...first, issueType: 1 },
      { ...first, stage: 1 },
      { ...first, dimensions: null },
      throwingRecord,
      { ...first, dimensions: { ...first.dimensions, compile: null } },
      { ...first, dimensions: { ...first.dimensions, compile: throwingVerdict } },
      {
        ...first,
        dimensions: {
          ...first.dimensions,
          compile: { pass: false, reason: 1 },
        },
      },
    ];
    for (const replacement of replacements) {
      const malformed = {
        cases: [
          replacement as RecordedCaseRecord,
          ...report.cases.slice(1),
        ],
      };
      expect(
        evaluateAgainstBaseline(
          malformed,
          baselineFrom(),
          CORPUS_SHA256,
        ).pass,
      ).toBe(false);
    }
  });

  it("T132 uses the schema floor as the sole catcher", () => {
    const hypothetical = CASE_DEFINITIONS
      .filter((entry) => entry.issueType !== "schema")
      .concat({
        caseId: "issue-999-hypothetical-hardening",
        stage: "triage-only",
        issueType: "hardening",
      });
    const reasons = expectReasons(
      evaluateAgainstBaseline(
        reportFrom(hypothetical),
        baselineFrom(hypothetical),
        CORPUS_SHA256,
      ),
    );
    expect(reasons).toEqual([
      "issueType schema count 0 is below required floor 1",
    ]);
  });

  it("T133 pins literal floors to the real committed corpus census", async () => {
    const loaded = await loadCorpus(CORPUS_ROOT);
    if (!loaded.ok) throw new Error(loaded.errors.join("; "));
    const issueTypes: Record<string, number> = {};
    const stages: Record<string, number> = {};
    for (const entry of loaded.value.cases) {
      issueTypes[entry.expected.issueType] =
        (issueTypes[entry.expected.issueType] ?? 0) + 1;
      stages[entry.case.stage] = (stages[entry.case.stage] ?? 0) + 1;
    }
    expect(issueTypes).toEqual(REQUIRED_ISSUE_TYPE_FLOORS);
    expect(stages).toEqual(REQUIRED_STAGE_FLOORS);
  });

  it("fails closed for uninspectable aggregate inputs", () => {
    const hostile = new Proxy({ cases: [] }, {
      get() { throw new Error("hostile get"); },
    });
    expect(
      evaluateAgainstBaseline(
        hostile as RecordedEvalReport,
        baselineFrom(),
        CORPUS_SHA256,
      ).pass,
    ).toBe(false);
  });
});
