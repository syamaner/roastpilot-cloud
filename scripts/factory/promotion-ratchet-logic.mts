import type { AuditLedgerEntry, FactoryPrRecord } from "./factory-baseline-schema.mts";

export const AUTONOMY_RUNGS = ["R0", "R1", "R2", "R3"] as const;
export type AutonomyRung = (typeof AUTONOMY_RUNGS)[number];
type RungProperty = { readonly dispatch: "paused" | "human" | "shadow" | "automatic"; readonly chaining: "off" | "draft-for-audit" | "triage-to-implement"; readonly merge: "human" };
export const RUNG_PROPERTIES: Record<AutonomyRung, RungProperty> = {
  R0: { dispatch: "paused", chaining: "off", merge: "human" },
  R1: { dispatch: "human", chaining: "off", merge: "human" },
  R2: { dispatch: "shadow", chaining: "draft-for-audit", merge: "human" },
  R3: { dispatch: "automatic", chaining: "triage-to-implement", merge: "human" },
};

export interface RatchetConfig { readonly windowMinimumPrs: number; readonly distinctIssueTypesMinimum: number; readonly maxOverrideRate: number; readonly minFirstPassGreenRate: number; readonly maxPostOpenReviewRoundMedian: number; readonly randomAuditSamplePercent: number; readonly wilsonZ: number }
export const DEFAULT_RATCHET_CONFIG: RatchetConfig = { windowMinimumPrs: 35, distinctIssueTypesMinimum: 3, maxOverrideRate: 0.10, minFirstPassGreenRate: 0.80, maxPostOpenReviewRoundMedian: 1, randomAuditSamplePercent: 20, wilsonZ: 1.96 };
export type HoldReason = "invalid-records" | "window-too-small" | "insufficient-issue-type-diversity" | "override-confidence-below-threshold" | "first-pass-green-below-threshold" | "review-round-median-above-threshold" | "security-audit-escape" | "audit-owed-unrecorded" | "already-at-top-rung";
export interface RatchetMetrics { readonly factoryRecordCount: number; readonly distinctIssueTypeCount: number; readonly overrideCount: number; readonly overrideWilsonLowerBound: number; readonly firstPassGreenCount: number; readonly firstPassGreenRate: number; readonly postOpenReviewRoundMedian: number | null; readonly duplicatePrNumbers: readonly number[]; readonly auditEscapePrNumbers: readonly number[]; readonly auditOwedUnrecordedPrNumbers: readonly number[] }
export type RatchetDecision =
  | { readonly decision: "promote"; readonly fromRung: AutonomyRung; readonly toRung: AutonomyRung; readonly metrics: RatchetMetrics }
  | { readonly decision: "hold"; readonly reasons: readonly HoldReason[]; readonly metrics: RatchetMetrics };

export function wilsonLowerBound(successes: number, trials: number, z: number): number {
  if (!Number.isInteger(successes) || !Number.isInteger(trials) || trials <= 0 || successes < 0 || successes > trials || !Number.isFinite(z) || z < 0) return 0;
  const proportion = successes / trials; const zSquared = z * z;
  return (proportion + zSquared / (2 * trials) - z * Math.sqrt((proportion * (1 - proportion) + zSquared / (4 * trials)) / trials)) / (1 + zSquared / trials);
}

export function isAuditOwedUnrecorded(record: FactoryPrRecord, ledgerEntries: readonly AuditLedgerEntry[]): boolean {
  return (record.securitySurface === true || record.sampledForAudit === true) && !ledgerEntries.some((entry) => entry.prNumber === record.prNumber);
}

export function deterministicAuditSampleDraw(prNumber: number, seed: string, percent: number): boolean {
  if (percent <= 0) return false; if (percent >= 100) return true;
  let hash = 0x811c9dc5;
  for (const character of `${seed}:${prNumber}`) { hash ^= character.charCodeAt(0); hash = Math.imul(hash, 0x01000193) >>> 0; }
  return hash % 100 < percent;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right); const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Caller/consumer preconditions, all operator-ratified in the F1-S6 9b review
 * as the ratchet consumer slice's responsibility rather than this pure layer's:
 * (i) records contains only factory PRs since the last recorded rung change;
 * this function persists no rung-generation state;
 * (ii) every sampledForAudit value was verified against the committed audit
 * sample seed; the F4 predicate consumes the recorded flag and does not re-draw;
 * (iii) every window record carries positive review-completion evidence. A
 * record with no recorded review lenses (empty lensCosts and reviewFindings),
 * or postOpenReviewRounds: 0 because the roster was skipped rather than a review
 * being genuinely clean, must not be supplied as promotable evidence.
 *
 * This function computes promote/hold correctly given a valid, complete, honest
 * window (factory-security-reviewer CONFIRMED-SOUND on that basis); enforcing
 * (i)-(iii) is the consumer's contract.
 */
export function evaluatePromotion(input: { readonly currentRung: AutonomyRung; readonly records: readonly FactoryPrRecord[]; readonly ledgerEntries: readonly AuditLedgerEntry[]; readonly config: RatchetConfig }): RatchetDecision {
  const window = input.records.filter((record) => record.execution === "factory"); const n = window.length;
  const counts = new Map<number, number>(); window.forEach((record) => counts.set(record.prNumber, (counts.get(record.prNumber) ?? 0) + 1));
  const duplicatePrNumbers = [...counts].filter(([, count]) => count > 1).map(([pr]) => pr).sort((a, b) => a - b);
  const overrides = window.filter((record) => record.triageOverridden).length;
  const greens = window.filter((record) => record.firstPassCiGreen).length;
  const issueTypes = new Set(window.map((record) => record.issueType)).size;
  const reviewMedian = median(window.map((record) => record.postOpenReviewRounds));
  const windowPrs = new Set(window.map((record) => record.prNumber));
  const auditEscapePrNumbers = [...new Set(input.ledgerEntries.filter((entry) => windowPrs.has(entry.prNumber) && entry.outcome === "escape").map((entry) => entry.prNumber))].sort((a, b) => a - b);
  const auditOwedUnrecordedPrNumbers = window.filter((record) => isAuditOwedUnrecorded(record, input.ledgerEntries)).map((record) => record.prNumber).sort((a, b) => a - b);
  const overrideWilsonLowerBound = wilsonLowerBound(n - overrides, n, input.config.wilsonZ);
  const metrics: RatchetMetrics = { factoryRecordCount: n, distinctIssueTypeCount: issueTypes, overrideCount: overrides, overrideWilsonLowerBound, firstPassGreenCount: greens, firstPassGreenRate: n === 0 ? 0 : greens / n, postOpenReviewRoundMedian: reviewMedian, duplicatePrNumbers, auditEscapePrNumbers, auditOwedUnrecordedPrNumbers };
  const reasons: HoldReason[] = [];
  if (duplicatePrNumbers.length) reasons.push("invalid-records");
  if (n < input.config.windowMinimumPrs) reasons.push("window-too-small");
  if (issueTypes < input.config.distinctIssueTypesMinimum) reasons.push("insufficient-issue-type-diversity");
  if (overrideWilsonLowerBound < 1 - input.config.maxOverrideRate) reasons.push("override-confidence-below-threshold");
  if (metrics.firstPassGreenRate < input.config.minFirstPassGreenRate) reasons.push("first-pass-green-below-threshold");
  if (reviewMedian !== null && reviewMedian > input.config.maxPostOpenReviewRoundMedian) reasons.push("review-round-median-above-threshold");
  if (auditEscapePrNumbers.length) reasons.push("security-audit-escape");
  if (auditOwedUnrecordedPrNumbers.length) reasons.push("audit-owed-unrecorded");
  if (input.currentRung === "R3") reasons.push("already-at-top-rung");
  if (reasons.length) return { decision: "hold", reasons, metrics };
  const index = AUTONOMY_RUNGS.indexOf(input.currentRung);
  return { decision: "promote", fromRung: input.currentRung, toRung: AUTONOMY_RUNGS[index + 1], metrics };
}
