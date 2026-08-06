import { REVIEW_LENSES, parseManifest, type BaselineManifest, type FactoryPrRecord, type ReviewLens } from "./factory-baseline-schema.mts";

export type UpsertResult =
  | { readonly ok: true; readonly manifestText: string; readonly changed: boolean }
  | { readonly ok: false; readonly errors: readonly string[]; readonly manifestText: string };
export interface LensSummary { readonly lens: ReviewLens; readonly findings: number; readonly credited: number; readonly suppressed: number; readonly unassessed: number; readonly knownTokens: number; readonly knownWallClockSeconds: number; readonly unknownCostEntries: number }

function canonicalRecord(record: FactoryPrRecord): object {
  return {
    prNumber: record.prNumber, headSha: record.headSha, issueNumber: record.issueNumber,
    issueType: record.issueType, execution: record.execution,
    securitySurface: record.securitySurface, triageOverridden: record.triageOverridden,
    firstPassCiGreen: record.firstPassCiGreen,
    postOpenReviewRounds: record.postOpenReviewRounds, humanTouchMinutes: record.humanTouchMinutes,
    reviewFindings: record.reviewFindings.map((finding) => ({ lens: finding.lens, severity: finding.severity, description: finding.description, counterfactual: finding.counterfactual })),
    lensCosts: record.lensCosts.map((cost) => ({ lens: cost.lens, tokens: cost.tokens, wallClockSeconds: cost.wallClockSeconds })),
    sampledForAudit: record.sampledForAudit,
  };
}

export function serializeManifest(manifest: BaselineManifest): string {
  return `${JSON.stringify({ schemaVersion: manifest.schemaVersion, description: manifest.description, records: manifest.records.map(canonicalRecord) }, null, 2)}\n`;
}

export function upsertPrRecord(manifestText: string, record: FactoryPrRecord): UpsertResult {
  const parsed = parseManifest(manifestText);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, manifestText };
  const existing = parsed.value.records.find((candidate) => candidate.prNumber === record.prNumber);
  if (existing !== undefined) {
    if (JSON.stringify(canonicalRecord(existing)) === JSON.stringify(canonicalRecord(record))) return { ok: true, manifestText, changed: false };
    return { ok: false, errors: [`prNumber ${record.prNumber} already exists with different content`], manifestText };
  }
  const updatedText = serializeManifest({ ...parsed.value, records: [...parsed.value.records, record] });
  const validated = parseManifest(updatedText);
  return validated.ok ? { ok: true, manifestText: updatedText, changed: true } : { ok: false, errors: validated.errors, manifestText };
}

export function summarizeLensMetrics(records: readonly FactoryPrRecord[]): readonly LensSummary[] {
  const summaries = new Map<ReviewLens, LensSummary>(REVIEW_LENSES.map((lens) => [lens, { lens, findings: 0, credited: 0, suppressed: 0, unassessed: 0, knownTokens: 0, knownWallClockSeconds: 0, unknownCostEntries: 0 }]));
  for (const record of records) {
    for (const finding of record.reviewFindings) {
      const current = summaries.get(finding.lens)!;
      summaries.set(finding.lens, { ...current, findings: current.findings + 1, credited: current.credited + Number(finding.counterfactual === "unique-to-lens"), suppressed: current.suppressed + Number(finding.counterfactual === "downstream-gate-would-catch"), unassessed: current.unassessed + Number(finding.counterfactual === "unassessed") });
    }
    for (const cost of record.lensCosts) {
      const current = summaries.get(cost.lens)!;
      summaries.set(cost.lens, { ...current, knownTokens: current.knownTokens + (cost.tokens ?? 0), knownWallClockSeconds: current.knownWallClockSeconds + (cost.wallClockSeconds ?? 0), unknownCostEntries: current.unknownCostEntries + Number(cost.tokens === null) + Number(cost.wallClockSeconds === null) });
    }
  }
  return [...summaries.values()];
}
