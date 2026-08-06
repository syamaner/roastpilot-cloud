import { describe, expect, it } from "vitest";
import {
  AUTONOMY_RUNGS,
  DEFAULT_RATCHET_CONFIG,
  RUNG_PROPERTIES,
  deterministicAuditSampleDraw,
  evaluatePromotion,
  isAuditOwedUnrecorded,
  wilsonLowerBound,
  type RatchetConfig,
} from "../../scripts/factory/promotion-ratchet-logic.mts";
import type { AuditLedgerEntry, FactoryPrRecord, IssueType } from "../../scripts/factory/factory-baseline-schema.mts";

function record(prNumber: number, overrides: Partial<FactoryPrRecord> = {}): FactoryPrRecord {
  return {
    prNumber,
    headSha: prNumber.toString(16).padStart(40, "0"),
    issueNumber: prNumber,
    issueType: "feature",
    execution: "factory",
    securitySurface: false,
    triageOverridden: false,
    firstPassCiGreen: true,
    postOpenReviewRounds: 1,
    humanTouchMinutes: 0,
    reviewFindings: [],
    lensCosts: [],
    sampledForAudit: false,
    ...overrides,
  };
}

const issueTypes: readonly IssueType[] = ["feature", "hardening", "security-fix"];
function window(size: number, override: (index: number) => Partial<FactoryPrRecord> = () => ({})): readonly FactoryPrRecord[] {
  return Array.from({ length: size }, (_, index) => record(index + 1, { issueType: issueTypes[index % issueTypes.length], ...override(index) }));
}

function evaluate(records: readonly FactoryPrRecord[], options: { currentRung?: "R0" | "R1" | "R2" | "R3"; ledgerEntries?: readonly AuditLedgerEntry[]; config?: RatchetConfig } = {}) {
  return evaluatePromotion({ currentRung: options.currentRung ?? "R1", records, ledgerEntries: options.ledgerEntries ?? [], config: options.config ?? DEFAULT_RATCHET_CONFIG });
}

function reasons(records: readonly FactoryPrRecord[], options: Parameters<typeof evaluate>[1] = {}): readonly string[] {
  const decision = evaluate(records, options);
  expect(decision.decision).toBe("hold");
  return decision.decision === "hold" ? decision.reasons : [];
}

describe("Wilson confidence", () => {
  it("R1 matches independently computed score constants", () => {
    expect(wilsonLowerBound(10, 10, 1.96)).toBeCloseTo(0.7224598312, 3);
    expect(wilsonLowerBound(35, 35, 1.96)).toBeCloseTo(0.9010957324, 3);
    expect(wilsonLowerBound(0, 10, 1.96)).toBeCloseTo(0, 3);
    expect(wilsonLowerBound(0, 10, 1.96)).toBeLessThan(0.31);
  });

  it("R1b returns zero for invalid trial and success counts", () => {
    expect(wilsonLowerBound(0, 0, 1.96)).toBe(0);
    expect(wilsonLowerBound(11, 10, 1.96)).toBe(0);
    expect(wilsonLowerBound(-1, 10, 1.96)).toBe(0);
    expect(wilsonLowerBound(1.5, 10, 1.96)).toBe(0);
    expect(wilsonLowerBound(1, 10.5, 1.96)).toBe(0);
    expect(wilsonLowerBound(1, 10, -1)).toBe(0);
  });

  it("R2a pins the K=35 Wilson break-even", () => {
    expect(wilsonLowerBound(34, 34, 1.96)).toBeCloseTo(0.8984820938, 3);
    expect(wilsonLowerBound(34, 34, 1.96)).toBeLessThan(0.9);
    expect(wilsonLowerBound(35, 35, 1.96)).toBeCloseTo(0.9010957324, 3);
    expect(wilsonLowerBound(35, 35, 1.96)).toBeGreaterThanOrEqual(0.9);
  });
});

describe("promotion decisions", () => {
  it("R2b holds a flawless 34-PR window and promotes a flawless 35-PR window by one rung", () => {
    expect(reasons(window(34))).toContain("window-too-small");
    const decision = evaluate(window(35), { currentRung: "R0" });
    expect(decision).toMatchObject({ decision: "promote", fromRung: "R0", toRung: "R1" });
  });

  it("R3 promotes a qualifying diverse audited window from R1 to R2", () => {
    const records = window(35, (index) => index < 2 ? { securitySurface: true } : {});
    const ledgerEntries = records.slice(0, 2).map((item) => ({ prNumber: item.prNumber, auditor: "rotated-auditor", performedAt: "2026-08-06T10:00:00Z", outcome: "clean" as const }));
    const decision = evaluate(records, { currentRung: "R1", ledgerEntries });
    expect(decision).toMatchObject({ decision: "promote", fromRung: "R1", toRung: "R2" });
    expect(decision.metrics).toMatchObject({ factoryRecordCount: 35, distinctIssueTypeCount: 3, firstPassGreenRate: 1, postOpenReviewRoundMedian: 1 });
  });

  it("R4 lets override confidence dominate an otherwise perfect window", () => {
    const records = window(40, (index) => ({ triageOverridden: index < 8 }));
    expect(reasons(records)).toContain("override-confidence-below-threshold");
  });

  it("R5 enforces the issue-type diversity floor", () => {
    expect(reasons(window(35, () => ({ issueType: "feature" })))).toContain("insufficient-issue-type-diversity");
  });

  it("R6 holds and names a security-surface PR whose audit is unrecorded", () => {
    const decision = evaluate(window(35, (index) => index === 6 ? { securitySurface: true } : {}));
    expect(decision.decision).toBe("hold");
    if (decision.decision === "hold") expect(decision.reasons).toContain("audit-owed-unrecorded");
    expect(decision.metrics.auditOwedUnrecordedPrNumbers).toEqual([7]);
  });

  it("R7 holds a sampled non-security PR whose audit is unrecorded", () => {
    const decision = evaluate(window(35, (index) => index === 10 ? { sampledForAudit: true } : {}));
    expect(decision.decision).toBe("hold");
    expect(decision.metrics.auditOwedUnrecordedPrNumbers).toEqual([11]);
  });

  it("R8 holds on any escape ledger entry for a window PR", () => {
    const ledgerEntries: readonly AuditLedgerEntry[] = [{ prNumber: 4, auditor: "auditor", performedAt: "2026-08-06T10:00:00Z", outcome: "escape" }];
    expect(reasons(window(35), { ledgerEntries })).toContain("security-audit-escape");
  });

  it("T4 ignores an escape ledger entry outside the factory window", () => {
    const ledgerEntries: readonly AuditLedgerEntry[] = [{ prNumber: 999, auditor: "auditor", performedAt: "2026-08-06T10:00:00Z", outcome: "escape" }];
    expect(evaluate(window(35), { ledgerEntries }).decision).toBe("promote");
  });

  it("R9 holds at a 0.75 first-pass green rate", () => {
    const records = window(40, (index) => ({ firstPassCiGreen: index < 30 }));
    expect(reasons(records)).toContain("first-pass-green-below-threshold");
  });

  it("R10 computes the even-window median as the mean of the middle values", () => {
    const records = window(36, (index) => ({ postOpenReviewRounds: index < 18 ? 1 : 2 }));
    const decision = evaluate(records);
    expect(decision.metrics.postOpenReviewRoundMedian).toBe(1.5);
    expect(decision.decision === "hold" ? decision.reasons : []).toContain("review-round-median-above-threshold");
  });

  it("R11 holds K-1 and empty windows, and defensively rejects duplicate PRs", () => {
    expect(reasons(window(DEFAULT_RATCHET_CONFIG.windowMinimumPrs - 1))).toContain("window-too-small");
    expect(reasons([])).toContain("window-too-small");
    const duplicate = [...window(35), record(1, { issueType: "schema" })];
    const decision = evaluate(duplicate);
    expect(decision.decision).toBe("hold");
    if (decision.decision === "hold") expect(decision.reasons).toContain("invalid-records");
    expect(decision.metrics.duplicatePrNumbers).toEqual([1]);
  });

  it("R12 excludes conventional records from every window metric", () => {
    const records = [...window(35, () => ({ execution: "conventional" })), ...window(5).map((item, index) => ({ ...item, prNumber: 100 + index }))];
    const decision = evaluate(records);
    expect(decision.metrics.factoryRecordCount).toBe(5);
    expect(decision.decision === "hold" ? decision.reasons : []).toContain("window-too-small");
  });

  it("R13 holds R3, advances exactly one rung, and structurally pins human merge", () => {
    expect(reasons(window(35), { currentRung: "R3" })).toContain("already-at-top-rung");
    expect(evaluate(window(35), { currentRung: "R2" })).toMatchObject({ decision: "promote", fromRung: "R2", toRung: "R3" });
    expect(AUTONOMY_RUNGS.map((rung) => RUNG_PROPERTIES[rung].merge)).toEqual(["human", "human", "human", "human"]);
  });

  it("R14 reports diversity, green, and audit failures together", () => {
    const records = window(35, (index) => ({ issueType: "feature", firstPassCiGreen: false, securitySurface: index === 4 }));
    const allReasons = reasons(records);
    expect(allReasons).toEqual(expect.arrayContaining(["insufficient-issue-type-diversity", "first-pass-green-below-threshold", "audit-owed-unrecorded"]));
  });

  it("R15 threads config so a 50% override allowance flips R4", () => {
    const records = window(40, (index) => ({ triageOverridden: index < 8 }));
    const config = { ...DEFAULT_RATCHET_CONFIG, maxOverrideRate: 0.5 };
    expect(evaluate(records, { config }).decision).toBe("promote");
  });

  it("T3 threads every other promotion threshold from config", () => {
    const perfect = window(35);
    const greenBoundary = window(35, (index) => ({ firstPassCiGreen: index < 34 }));
    const cases: readonly [readonly FactoryPrRecord[], Partial<RatchetConfig>][] = [
      [perfect, { windowMinimumPrs: 36 }],
      [perfect, { distinctIssueTypesMinimum: 4 }],
      [greenBoundary, { minFirstPassGreenRate: 0.98 }],
      [perfect, { maxPostOpenReviewRoundMedian: 0.5 }],
      [perfect, { wilsonZ: 2 }],
    ];
    for (const [records, override] of cases) {
      expect(evaluate(records).decision).toBe("promote");
      expect(evaluate(records, { config: { ...DEFAULT_RATCHET_CONFIG, ...override } }).decision).toBe("hold");
    }
  });

  it("R16 pins every ratified default", () => {
    expect(DEFAULT_RATCHET_CONFIG).toEqual({ windowMinimumPrs: 35, distinctIssueTypesMinimum: 3, maxOverrideRate: 0.10, minFirstPassGreenRate: 0.80, maxPostOpenReviewRoundMedian: 1, randomAuditSamplePercent: 20, wilsonZ: 1.96 });
  });

  it("T6a sorts every multi-entry PR-number metric ascending", () => {
    const records = [
      ...window(35, (index) => index === 2 || index === 7 ? { securitySurface: true } : {}),
      record(10),
      record(2),
    ];
    const ledgerEntries: readonly AuditLedgerEntry[] = [
      { prNumber: 9, auditor: "a", performedAt: "2026-08-06T10:00:00Z", outcome: "escape" },
      { prNumber: 1, auditor: "b", performedAt: "2026-08-06T10:00:00Z", outcome: "escape" },
    ];
    const decision = evaluate(records, { ledgerEntries });
    expect(decision.metrics.duplicatePrNumbers).toEqual([2, 10]);
    expect(decision.metrics.auditEscapePrNumbers).toEqual([1, 9]);
    expect(decision.metrics.auditOwedUnrecordedPrNumbers).toEqual([3, 8]);
  });
});

describe("audit selection", () => {
  it("R17 draws deterministically and honors closed percentage boundaries", () => {
    const first = Array.from({ length: 100 }, (_, index) => deterministicAuditSampleDraw(index + 1, "committed-seed", 20));
    const second = Array.from({ length: 100 }, (_, index) => deterministicAuditSampleDraw(index + 1, "committed-seed", 20));
    expect(second).toEqual(first);
    expect(first.some(Boolean)).toBe(true);
    expect(first.every(Boolean)).toBe(false);
    expect(Array.from({ length: 20 }, (_, index) => deterministicAuditSampleDraw(index, "seed", 0)).every((draw) => !draw)).toBe(true);
    expect(Array.from({ length: 20 }, (_, index) => deterministicAuditSampleDraw(index, "seed", 100)).every(Boolean)).toBe(true);
  });

  it("R18 implements the audit-owed/unrecorded truth table", () => {
    const clean: AuditLedgerEntry = { prNumber: 1, auditor: "a", performedAt: "2026-08-06T10:00:00Z", outcome: "clean" };
    expect(isAuditOwedUnrecorded(record(1), [])).toBe(false);
    expect(isAuditOwedUnrecorded(record(1, { securitySurface: true }), [])).toBe(true);
    expect(isAuditOwedUnrecorded(record(1, { sampledForAudit: true }), [])).toBe(true);
    expect(isAuditOwedUnrecorded(record(1, { securitySurface: true, sampledForAudit: true }), [clean])).toBe(false);
    expect(isAuditOwedUnrecorded(record(2, { sampledForAudit: true }), [clean])).toBe(true);
  });
});
