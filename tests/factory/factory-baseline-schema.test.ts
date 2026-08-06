import { describe, expect, it } from "vitest";
import {
  MAX_MANIFEST_BYTES,
  REQUIRED_RECORD_FIELDS,
  parseLedger,
  parseManifest,
  type FactoryPrRecord,
} from "../../scripts/factory/factory-baseline-schema.mts";

function validRecord(overrides: Partial<FactoryPrRecord> = {}): FactoryPrRecord {
  return {
    prNumber: 101,
    headSha: "a".repeat(40),
    issueNumber: 9,
    issueType: "feature",
    execution: "factory",
    securitySurface: false,
    triageOverridden: false,
    firstPassCiGreen: true,
    postOpenReviewRounds: 1,
    humanTouchMinutes: 12.5,
    reviewFindings: [{ lens: "codex-connector", severity: "medium", description: "Found a real issue", counterfactual: "unique-to-lens" }],
    lensCosts: [{ lens: "codex-connector", tokens: 1200, wallClockSeconds: 45.5 }],
    sampledForAudit: false,
    ...overrides,
  };
}

function manifest(records: readonly unknown[] = [validRecord()], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 1, description: "F1-S6 baseline", records, ...overrides });
}

function ledger(entries: readonly unknown[] = [{ prNumber: 101, auditor: "operator-a", performedAt: "2026-08-06T10:11:12Z", outcome: "clean" }], overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ schemaVersion: 1, entries, ...overrides });
}

function errorsOf(result: ReturnType<typeof parseManifest> | ReturnType<typeof parseLedger>): string {
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.errors.join(" ");
}

describe("factory baseline manifest schema", () => {
  it("S1 parses a valid manifest without changing values", () => {
    const record = validRecord();
    const result = parseManifest(manifest([record]));
    expect(result).toEqual({ ok: true, value: { schemaVersion: 1, description: "F1-S6 baseline", records: [record] } });
  });

  it("S2 rejects and names every omitted required record field", () => {
    for (const field of REQUIRED_RECORD_FIELDS) {
      const candidate: Record<string, unknown> = { ...validRecord() };
      delete candidate[field];
      expect(errorsOf(parseManifest(manifest([candidate])))).toContain(field);
    }
  });

  it("S3 rejects unknown record and top-level keys", () => {
    expect(errorsOf(parseManifest(manifest([{ ...validRecord(), surprise: true }])))).toContain("surprise");
    expect(errorsOf(parseManifest(manifest(undefined, { surprise: true })))).toContain("surprise");
  });

  it("T5 rejects every omitted manifest top-level field and a non-string description", () => {
    for (const field of ["schemaVersion", "description", "records"] as const) {
      const candidate: Record<string, unknown> = { schemaVersion: 1, description: "baseline", records: [validRecord()] };
      delete candidate[field];
      expect(errorsOf(parseManifest(JSON.stringify(candidate)))).toContain(field);
    }
    expect(errorsOf(parseManifest(manifest(undefined, { description: 42 })))).toContain("description");
  });

  it("S4 rejects an unknown issue type byte-exactly", () => {
    expect(errorsOf(parseManifest(manifest([{ ...validRecord(), issueType: "Feature" }])))).toContain("issueType");
  });

  it("S5 rejects an unknown review lens in findings and costs", () => {
    const result = parseManifest(manifest([{ ...validRecord(), reviewFindings: [{ lens: "other", severity: "low", description: "x", counterfactual: "unassessed" }], lensCosts: [{ lens: "other", tokens: 1, wallClockSeconds: 2 }] }]));
    const errors = errorsOf(result);
    expect(errors).toContain("reviewFindings[0].lens");
    expect(errors).toContain("lensCosts[0].lens");
  });

  it("S6 rejects an unknown counterfactual", () => {
    const findings = [{ lens: "qa", severity: "low", description: "x", counterfactual: "probably-caught" }];
    expect(errorsOf(parseManifest(manifest([{ ...validRecord(), reviewFindings: findings }])))).toContain("counterfactual");
  });

  it("S8 rejects wrong versions, non-objects, invalid JSON, and oversized input", () => {
    expect(errorsOf(parseManifest(manifest(undefined, { schemaVersion: 2 })))).toContain("schemaVersion");
    expect(errorsOf(parseManifest("[]"))).toContain("object");
    expect(errorsOf(parseManifest("{"))).toContain("invalid JSON");
    expect(errorsOf(parseManifest(" ".repeat(MAX_MANIFEST_BYTES + 1)))).toContain("exceeds");
  });

  it("S9 rejects duplicate PR numbers for the whole manifest", () => {
    expect(errorsOf(parseManifest(manifest([validRecord(), validRecord({ headSha: "b".repeat(40) })])))).toContain("duplicates 101");
  });

  it("S10 rejects NaN/null, infinity, negative, and fractional numeric values", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["postOpenReviewRounds", { postOpenReviewRounds: -1 }],
      ["postOpenReviewRounds", { postOpenReviewRounds: 1.5 }],
      ["humanTouchMinutes", { humanTouchMinutes: Number.NaN }],
      ["humanTouchMinutes", { humanTouchMinutes: Number.POSITIVE_INFINITY }],
      ["humanTouchMinutes", { humanTouchMinutes: -0.1 }],
      ["tokens", { lensCosts: [{ lens: "ci", tokens: 1.5, wallClockSeconds: 1 }] }],
      ["tokens", { lensCosts: [{ lens: "ci", tokens: -1, wallClockSeconds: 1 }] }],
    ];
    for (const [field, overrides] of cases) {
      expect(errorsOf(parseManifest(manifest([{ ...validRecord(), ...overrides }])))).toContain(field);
    }
    const raw = manifest().replace('"wallClockSeconds":45.5', '"wallClockSeconds":Infinity');
    expect(errorsOf(parseManifest(raw))).toContain("invalid JSON");
  });

  it("S11 rejects a non-40-hex head SHA", () => {
    for (const headSha of ["a".repeat(39), "g".repeat(40), `${"a".repeat(40)} `]) {
      expect(errorsOf(parseManifest(manifest([{ ...validRecord(), headSha }])))).toContain("headSha");
    }
  });

  it("S12 rejects absent cost keys but accepts explicit null without coercion", () => {
    const missing = parseManifest(manifest([{ ...validRecord(), lensCosts: [{ lens: "ci", wallClockSeconds: null }] }]));
    expect(errorsOf(missing)).toContain("tokens");
    const accepted = parseManifest(manifest([{ ...validRecord(), lensCosts: [{ lens: "ci", tokens: null, wallClockSeconds: null }] }]));
    expect(accepted.ok).toBe(true);
    if (accepted.ok) expect(accepted.value.records[0].lensCosts[0].tokens).toBeNull();
  });

  it("S14 accumulates errors and names every independently failing field", () => {
    const result = parseManifest(manifest([{ ...validRecord(), prNumber: 0, headSha: "bad", issueNumber: -1, sampledForAudit: "no" }]));
    const errors = errorsOf(result);
    for (const field of ["prNumber", "headSha", "issueNumber", "sampledForAudit"]) expect(errors).toContain(field);
  });
});

describe("audit ledger schema", () => {
  it("S13 parses valid entries and allows multiple entries for one PR", () => {
    const entries = [
      { prNumber: 101, auditor: "operator-a", performedAt: "2026-08-06T10:11:12Z", outcome: "clean" },
      { prNumber: 101, auditor: "operator-b", performedAt: "2026-08-06T11:11:12Z", outcome: "findings-fixed" },
    ];
    expect(parseLedger(ledger(entries))).toEqual({ ok: true, value: { schemaVersion: 1, entries } });
  });

  it("S7 rejects an unknown outcome so it cannot read as clean", () => {
    expect(errorsOf(parseLedger(ledger([{ prNumber: 101, auditor: "a", performedAt: "2026-08-06T10:11:12Z", outcome: "unknown" }])))).toContain("outcome");
  });

  it("S13 rejects empty auditors and malformed timestamps", () => {
    const result = parseLedger(ledger([{ prNumber: 101, auditor: " ", performedAt: "2026-08-06", outcome: "clean" }]));
    const errors = errorsOf(result);
    expect(errors).toContain("auditor");
    expect(errors).toContain("performedAt");
  });

  it("H2 rejects impossible and rollover timestamps but accepts a real instant", () => {
    for (const performedAt of [
      "2026-13-01T00:00:00Z",
      "2026-01-99T00:00:00Z",
      "2026-01-01T99:00:00Z",
      "2026-02-30T00:00:00Z",
    ]) {
      expect(errorsOf(parseLedger(ledger([{ prNumber: 101, auditor: "a", performedAt, outcome: "clean" }])))).toContain("performedAt");
    }
    expect(parseLedger(ledger([{ prNumber: 101, auditor: "a", performedAt: "2024-02-29T23:59:59Z", outcome: "clean" }])).ok).toBe(true);
  });

  it("applies the closed top-level grammar and schema version to ledgers", () => {
    expect(errorsOf(parseLedger(ledger(undefined, { schemaVersion: 2, extra: true })))).toMatch(/schemaVersion.*extra|extra.*schemaVersion/);
    expect(errorsOf(parseLedger("null"))).toContain("object");
  });

  it("T5 rejects every omitted ledger top-level field", () => {
    for (const field of ["schemaVersion", "entries"] as const) {
      const candidate: Record<string, unknown> = { schemaVersion: 1, entries: [] };
      delete candidate[field];
      expect(errorsOf(parseLedger(JSON.stringify(candidate)))).toContain(field);
    }
  });

  it("T6b rejects invalid JSON and oversized ledger payloads on its own path", () => {
    expect(errorsOf(parseLedger("{"))).toContain("invalid JSON");
    expect(errorsOf(parseLedger(" ".repeat(MAX_MANIFEST_BYTES + 1)))).toContain("exceeds");
  });
});
