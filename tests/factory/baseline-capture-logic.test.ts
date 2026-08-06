import { describe, expect, it } from "vitest";
import {
  serializeManifest,
  summarizeLensMetrics,
  upsertPrRecord,
} from "../../scripts/factory/baseline-capture-logic.mts";
import {
  parseManifest,
  type BaselineManifest,
  type FactoryPrRecord,
} from "../../scripts/factory/factory-baseline-schema.mts";

function record(overrides: Partial<FactoryPrRecord> = {}): FactoryPrRecord {
  return {
    prNumber: 10,
    headSha: "1".repeat(40),
    issueNumber: 9,
    issueType: "hardening",
    execution: "factory",
    securitySurface: false,
    triageOverridden: false,
    firstPassCiGreen: true,
    postOpenReviewRounds: 1,
    humanTouchMinutes: 5,
    reviewFindings: [],
    lensCosts: [],
    sampledForAudit: false,
    ...overrides,
  };
}

const baseline = (records: readonly FactoryPrRecord[] = [record()]): BaselineManifest => ({
  schemaVersion: 1,
  description: "captured baseline",
  records,
});

describe("baseline capture", () => {
  it("C1 serializes canonically and round-trips byte-identically", () => {
    const serialized = serializeManifest(baseline());
    expect(serialized.endsWith("\n")).toBe(true);
    expect(serialized.startsWith('{\n  "schemaVersion": 1,\n  "description"')).toBe(true);
    const parsed = parseManifest(serialized);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(serializeManifest(parsed.value)).toBe(serialized);
  });

  it("C2 appends a new PR then leaves byte-identical input on identical re-upsert", () => {
    const original = serializeManifest(baseline([]));
    const first = upsertPrRecord(original, record());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.changed).toBe(true);
    const second = upsertPrRecord(first.manifestText, record());
    expect(second).toEqual({ ok: true, manifestText: first.manifestText, changed: false });
  });

  it("T1 canonicalizes reordered populated records, strips extras, and compares canonical content", () => {
    const finding = { extraFinding: "strip", counterfactual: "unique-to-lens", description: "real finding", severity: "medium", lens: "qa" } as const;
    const cost = { extraCost: "strip", wallClockSeconds: 12, tokens: 400, lens: "qa" } as const;
    const reordered = {
      extraRecord: "strip", sampledForAudit: false, lensCosts: [cost], reviewFindings: [finding],
      humanTouchMinutes: 5, postOpenReviewRounds: 1, firstPassCiGreen: true,
      triageOverridden: false, securitySurface: false, execution: "factory",
      issueType: "hardening", issueNumber: 9, headSha: "1".repeat(40), prNumber: 10,
    } as const;
    const serialized = serializeManifest(baseline([reordered]));
    expect(serialized).not.toMatch(/extraRecord|extraFinding|extraCost/);
    expect(serialized).toContain('"lens": "qa",\n          "severity": "medium",\n          "description": "real finding",\n          "counterfactual": "unique-to-lens"');
    expect(serialized).toContain('"lens": "qa",\n          "tokens": 400,\n          "wallClockSeconds": 12');
    const parsed = parseManifest(serialized);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(serializeManifest(parsed.value)).toBe(serialized);

    const appended = upsertPrRecord(serializeManifest(baseline([])), reordered);
    expect(appended).toEqual({ ok: true, manifestText: serialized, changed: true });
    if (!appended.ok) return;
    const equalReordered = record({ lensCosts: [{ wallClockSeconds: 12, lens: "qa", tokens: 400 }], reviewFindings: [{ description: "real finding", counterfactual: "unique-to-lens", lens: "qa", severity: "medium" }] });
    expect(upsertPrRecord(appended.manifestText, equalReordered)).toEqual({ ok: true, manifestText: serialized, changed: false });
  });

  it("C3 refuses conflicting content and returns the unchanged manifest", () => {
    const original = serializeManifest(baseline());
    const result = upsertPrRecord(original, record({ issueNumber: 99 }));
    expect(result.ok).toBe(false);
    expect(result.manifestText).toBe(original);
    if (!result.ok) expect(result.errors.join(" ")).toContain("different content");
  });

  it("fails closed without changing malformed manifest input", () => {
    const result = upsertPrRecord("{", record());
    expect(result.ok).toBe(false);
    expect(result.manifestText).toBe("{");
  });

  it("H1 rejects an invalid input record and returns the original manifest unchanged", () => {
    const original = serializeManifest(baseline([]));
    const result = upsertPrRecord(original, record({ humanTouchMinutes: Number.NaN }));
    expect(result.ok).toBe(false);
    expect(result.manifestText).toBe(original);
    if (!result.ok) expect(result.errors.join(" ")).toContain("humanTouchMinutes");
  });
});

describe("lens metric attribution", () => {
  it("C4 attributes findings and costs to their exact lenses", () => {
    const records = [record({
      reviewFindings: [{ lens: "qa", severity: "medium", description: "missing negative case", counterfactual: "unique-to-lens" }],
      lensCosts: [{ lens: "qa", tokens: 400, wallClockSeconds: 12 }],
    })];
    const qa = summarizeLensMetrics(records).find((summary) => summary.lens === "qa");
    const ci = summarizeLensMetrics(records).find((summary) => summary.lens === "ci");
    expect(qa).toMatchObject({ findings: 1, credited: 1, knownTokens: 400, knownWallClockSeconds: 12 });
    expect(ci).toMatchObject({ findings: 0, credited: 0, knownTokens: 0 });
  });

  it("C5 separates suppressed and unassessed findings from credited findings", () => {
    const findings: FactoryPrRecord["reviewFindings"] = [
      { lens: "codex-local-review", severity: "low", description: "unique", counterfactual: "unique-to-lens" },
      { lens: "codex-local-review", severity: "medium", description: "CI catches", counterfactual: "downstream-gate-would-catch" },
      { lens: "codex-local-review", severity: "low", description: "not assessed", counterfactual: "unassessed" },
    ];
    const summary = summarizeLensMetrics([record({ reviewFindings: findings })]).find((item) => item.lens === "codex-local-review");
    expect(summary).toMatchObject({ findings: 3, credited: 1, suppressed: 1, unassessed: 1 });
  });

  it("C6 counts each null cost honestly without adding it to known sums", () => {
    const costs: FactoryPrRecord["lensCosts"] = [
      { lens: "claude-code-review", tokens: null, wallClockSeconds: 10 },
      { lens: "claude-code-review", tokens: 200, wallClockSeconds: null },
    ];
    const summary = summarizeLensMetrics([record({ lensCosts: costs })]).find((item) => item.lens === "claude-code-review");
    expect(summary).toMatchObject({ knownTokens: 200, knownWallClockSeconds: 10, unknownCostEntries: 2 });
  });

  it("T2 distinguishes real zero costs from measured-unavailable null", () => {
    const costs: FactoryPrRecord["lensCosts"] = [
      { lens: "ci", tokens: 0, wallClockSeconds: 0 },
      { lens: "ci", tokens: null, wallClockSeconds: 5 },
    ];
    const summary = summarizeLensMetrics([record({ lensCosts: costs })]).find((item) => item.lens === "ci");
    expect(summary).toMatchObject({ knownTokens: 0, knownWallClockSeconds: 5, unknownCostEntries: 1 });
  });
});
