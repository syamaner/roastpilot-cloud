import { describe, expect, it } from "vitest";
import {
  IMPLEMENT_DIMENSIONS,
  MAX_BASELINE_BYTES,
  TRIAGE_ONLY_DIMENSIONS,
  validateEvalBaseline,
} from "../../scripts/factory/eval/eval-baseline-schema.mts";
import { isUtf8PayloadWithinLimit } from "../../scripts/factory/eval/validation-common.mts";

const CORPUS_SHA256 = "a".repeat(64);
const CASE_IDS = [
  "issue-009-registry-reconciliation",
  "issue-023-dryrun-second",
  "issue-026-health-route-dryrun",
  "issue-058-grant-hardening",
  "issue-059-public-grant-audit",
  "issue-120-executable-closure",
  "issue-151-summary-binding",
  "issue-194-comment-injection",
  "issue-205-retarget-hardening",
  "issue-274-inert-noop",
  "issue-281-dryrun-utility",
  "issue-284-vitest-timeout",
] as const;
const IMPLEMENT_CASE_IDS = new Set([
  "issue-009-registry-reconciliation",
  "issue-026-health-route-dryrun",
  "issue-058-grant-hardening",
  "issue-151-summary-binding",
]);
const ISSUE_TYPES_BY_CASE_ID = {
  "issue-009-registry-reconciliation": "documentation",
  "issue-023-dryrun-second": "documentation",
  "issue-026-health-route-dryrun": "feature",
  "issue-058-grant-hardening": "hardening",
  "issue-059-public-grant-audit": "schema",
  "issue-120-executable-closure": "hardening",
  "issue-151-summary-binding": "security-fix",
  "issue-194-comment-injection": "security-fix",
  "issue-205-retarget-hardening": "security-fix",
  "issue-274-inert-noop": "hardening",
  "issue-281-dryrun-utility": "feature",
  "issue-284-vitest-timeout": "hardening",
} as const;

function validBaseline(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    corpus: { corpusSha256: CORPUS_SHA256, caseIds: [...CASE_IDS] },
    cases: CASE_IDS.map((caseId) => ({
      caseId,
      issueType: ISSUE_TYPES_BY_CASE_ID[caseId],
      dimensions: IMPLEMENT_CASE_IDS.has(caseId)
        ? [...IMPLEMENT_DIMENSIONS]
        : [...TRIAGE_ONLY_DIMENSIONS],
    })),
  };
}

function corpus(value: Record<string, unknown>): Record<string, unknown> {
  return value.corpus as Record<string, unknown>;
}

function cases(value: Record<string, unknown>): Record<string, unknown>[] {
  return value.cases as Record<string, unknown>[];
}

describe("recorded evaluation baseline schema", () => {
  it("T124 accepts the canonical twelve-case baseline", () => {
    expect(validateEvalBaseline(validBaseline()).ok).toBe(true);
  });

  const invalidFixtures: readonly [
    string,
    () => unknown,
    string,
  ][] = [
    ["an unknown top-level key", () => ({ ...validBaseline(), extra: true }), "unexpected key"],
    ["schemaVersion 2", () => ({ ...validBaseline(), schemaVersion: 2 }), "schemaVersion"],
    ["a string schemaVersion", () => ({ ...validBaseline(), schemaVersion: "1" }), "schemaVersion"],
    ["an uppercase SHA-256", () => {
      const value = validBaseline(); corpus(value).corpusSha256 = "A".repeat(64); return value;
    }, "SHA-256"],
    ["a 63-character SHA-256", () => {
      const value = validBaseline(); corpus(value).corpusSha256 = "a".repeat(63); return value;
    }, "SHA-256"],
    ["a 65-character SHA-256", () => {
      const value = validBaseline(); corpus(value).corpusSha256 = "a".repeat(65); return value;
    }, "SHA-256"],
    ["unsorted corpus caseIds", () => {
      const value = validBaseline();
      const caseIds = corpus(value).caseIds as string[];
      [caseIds[1], caseIds[2]] = [caseIds[2], caseIds[1]];
      return value;
    }, "strictly ascending"],
    ["duplicate corpus caseIds", () => {
      const value = validBaseline();
      const caseIds = corpus(value).caseIds as string[];
      caseIds[1] = caseIds[0];
      return value;
    }, "strictly ascending"],
    ["case-list divergence", () => {
      const value = validBaseline();
      cases(value).at(-1)!.caseId = "issue-285-divergent";
      return value;
    }, "byte-equal baseline.corpus.caseIds"],
    ["a missing implement dimension", () => {
      const value = validBaseline();
      cases(value)[0].dimensions = IMPLEMENT_DIMENSIONS.slice(1);
      return value;
    }, "dimension set"],
    ["an extra dimension", () => {
      const value = validBaseline();
      cases(value)[0].dimensions = [...IMPLEMENT_DIMENSIONS, "unknown"];
      return value;
    }, "dimension set"],
    ["an unsorted dimension set", () => {
      const value = validBaseline();
      const dimensions = [...IMPLEMENT_DIMENSIONS];
      [dimensions[0], dimensions[1]] = [dimensions[1], dimensions[0]];
      cases(value)[0].dimensions = dimensions;
      return value;
    }, "dimension set"],
    ["a prOutcome dimension", () => {
      const value = validBaseline();
      cases(value)[0].dimensions = [...IMPLEMENT_DIMENSIONS, "prOutcome"];
      return value;
    }, "dimension set"],
    ["a non-object raw value", () => "baseline", "baseline must be an object"],
    ["a null raw value", () => null, "baseline must be an object"],
    ["an array raw value", () => [], "baseline must be an object"],
    ["a non-object corpus", () => ({ ...validBaseline(), corpus: null }), "baseline.corpus must be an object"],
    ["an unknown corpus key", () => {
      const value = validBaseline(); corpus(value).extra = true; return value;
    }, "unexpected key"],
    ["a non-array caseIds", () => {
      const value = validBaseline(); corpus(value).caseIds = "case"; return value;
    }, "non-empty array"],
    ["empty corpus caseIds", () => {
      const value = validBaseline(); corpus(value).caseIds = []; return value;
    }, "non-empty array"],
    ["an invalid corpus caseId", () => {
      const value = validBaseline();
      (corpus(value).caseIds as string[])[0] = "ISSUE-009-invalid";
      return value;
    }, "corpus case-id pattern"],
    ["a non-array cases value", () => ({ ...validBaseline(), cases: null }), "baseline.cases must be an array"],
    ["a non-object case", () => {
      const value = validBaseline(); (value.cases as unknown[])[0] = null; return value;
    }, "baseline.cases[0] must be an object"],
    ["an unknown case key", () => {
      const value = validBaseline(); cases(value)[0].extra = true; return value;
    }, "unexpected key"],
    ["a missing case issueType", () => {
      const value = validBaseline(); delete cases(value)[0].issueType; return value;
    }, "issueType must be a known issue type"],
    ["an out-of-domain case issueType", () => {
      const value = validBaseline(); cases(value)[0].issueType = "bogus"; return value;
    }, "issueType must be a known issue type"],
    ["an invalid case caseId", () => {
      const value = validBaseline(); cases(value)[0].caseId = "invalid"; return value;
    }, "corpus case-id pattern"],
    ["a non-string dimension", () => {
      const value = validBaseline(); cases(value)[0].dimensions = [1]; return value;
    }, "array of strings"],
    ["a duplicate dimension", () => {
      const value = validBaseline();
      cases(value)[0].dimensions = [
        ...IMPLEMENT_DIMENSIONS,
        IMPLEMENT_DIMENSIONS.at(-1),
      ];
      return value;
    }, "dimension set"],
    ["unsorted cases", () => {
      const value = validBaseline();
      const entries = cases(value);
      [entries[1], entries[2]] = [entries[2], entries[1]];
      return value;
    }, "strictly ascending by caseId"],
  ];

  it.each(invalidFixtures)("T125 rejects %s", (_name, fixture, expectedReasonSubstring) => {
    const result = validateEvalBaseline(fixture());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected an invalid baseline");
    expect(
      result.errors.some((error) => error.includes(expectedReasonSubstring)),
    ).toBe(true);
  });

  it("T125 rejects oversized baseline text before parsing", () => {
    const oversizedText = "x".repeat(MAX_BASELINE_BYTES + 1);
    expect(
      isUtf8PayloadWithinLimit(oversizedText, MAX_BASELINE_BYTES),
    ).toBe(false);
  });

  it("fails closed for an uninspectable baseline", () => {
    const hostile = new Proxy({}, {
      ownKeys() { throw new Error("hostile ownKeys"); },
    });
    expect(validateEvalBaseline(hostile).ok).toBe(false);
  });
});
