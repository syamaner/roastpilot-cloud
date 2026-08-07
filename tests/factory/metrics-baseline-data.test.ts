import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseLedger, parseManifest, type FactoryPrRecord } from "../../scripts/factory/factory-baseline-schema.mts";
import { serializeManifest, summarizeLensMetrics } from "../../scripts/factory/baseline-capture-logic.mts";

// D1 (9b Unit 2): the committed baseline data artefacts parse cleanly through
// the §1.2 closed grammar, stay in canonical serialised form (reviewable diffs),
// and pin every load-bearing field of the 27 Jul sample so a dropped, added, or
// silently altered record fails rather than passing a smoke check. This evidence
// feeds the 9h review-allocation analysis, so evidence loss must be detectable.
// Both files are conventional-record baseline EVIDENCE; nothing here is consumed
// by the promotion ratchet (evaluatePromotion filters to factory records).

const manifestText = readFileSync(new URL("../../scripts/factory/metrics/pr-baseline.json", import.meta.url), "utf8");
const ledgerText = readFileSync(new URL("../../scripts/factory/metrics/audit-ledger.json", import.meta.url), "utf8");

// A SHA-256 over the committed manifest bytes. This is the complete
// evidence-integrity pin: any change to any byte (issueNumber, sampledForAudit,
// a finding's lens/severity/description, a token value, anything the scalar
// snapshot and aggregates below do not enumerate) fails this assertion, so the
// committed baseline cannot drift silently. A legitimate baseline update is an
// explicit, reviewed digest change in the same commit. The canonical-serialise
// check verifies only formatting; the scalar snapshot and credit aggregate give
// a human-readable failure for the most load-bearing fields; this digest closes
// the rest.
const EXPECTED_MANIFEST_SHA256 = "691dc3c290c65a5e267fe51ce23e7caf9a14744c6544e9e49eb55eebfbcc41f4";

// The load-bearing scalar snapshot of each transcribed record, kept for a
// readable diff when one of these fields drifts (the digest above pins the rest).
type Snapshot = Pick<FactoryPrRecord,
  "headSha" | "issueType" | "execution" | "securitySurface" | "triageOverridden" |
  "firstPassCiGreen" | "postOpenReviewRounds" | "humanTouchMinutes"> & { findings: number; costs: number };

const EXPECTED: Record<number, Snapshot> = {
  150: { headSha: "4d26670fb28a881f17a94589619aee4201b86d01", issueType: "hardening", execution: "conventional", securitySurface: true, triageOverridden: false, firstPassCiGreen: false, postOpenReviewRounds: 1, humanTouchMinutes: 0, findings: 11, costs: 7 },
  152: { headSha: "e6fb6529754feeb0f7c9ae926d2de4df03e44e2c", issueType: "documentation", execution: "conventional", securitySurface: true, triageOverridden: false, firstPassCiGreen: true, postOpenReviewRounds: 1, humanTouchMinutes: 0, findings: 1, costs: 3 },
  153: { headSha: "48634dca6c896ee559072249b19fc312172dfc76", issueType: "security-fix", execution: "conventional", securitySurface: true, triageOverridden: false, firstPassCiGreen: true, postOpenReviewRounds: 0, humanTouchMinutes: 0, findings: 5, costs: 3 },
};

function records(): readonly FactoryPrRecord[] {
  const parsed = parseManifest(manifestText);
  if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
  return parsed.value.records;
}

describe("committed factory metrics baseline data (D1)", () => {
  it("parses the committed pr-baseline.json through the closed grammar", () => {
    const parsed = parseManifest(manifestText);
    expect(parsed.ok, parsed.ok ? "" : parsed.errors.join("\n")).toBe(true);
  });

  it("parses the committed audit-ledger.json through the closed grammar", () => {
    const parsed = parseLedger(ledgerText);
    expect(parsed.ok, parsed.ok ? "" : parsed.errors.join("\n")).toBe(true);
  });

  it("keeps pr-baseline.json byte-identical to its canonical serialisation", () => {
    const parsed = parseManifest(manifestText);
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    expect(serializeManifest(parsed.value)).toBe(manifestText);
  });

  it("pins the full committed baseline against silent drift (content digest)", () => {
    expect(createHash("sha256").update(manifestText).digest("hex")).toBe(EXPECTED_MANIFEST_SHA256);
  });

  it("commits an empty audit ledger for the baseline (no factory PRs exist yet)", () => {
    const parsed = parseLedger(ledgerText);
    if (!parsed.ok) throw new Error(parsed.errors.join("\n"));
    expect(parsed.value.entries).toHaveLength(0);
  });

  it("transcribes exactly the three 27 Jul records with every load-bearing field pinned", () => {
    const byPr = new Map(records().map((record) => [record.prNumber, record]));
    expect([...byPr.keys()].sort((a, b) => a - b)).toEqual([150, 152, 153]);
    for (const [prNumber, expected] of Object.entries(EXPECTED)) {
      const record = byPr.get(Number(prNumber));
      expect(record, `record for PR ${prNumber} is missing`).toBeDefined();
      expect({
        headSha: record!.headSha, issueType: record!.issueType, execution: record!.execution,
        securitySurface: record!.securitySurface, triageOverridden: record!.triageOverridden,
        firstPassCiGreen: record!.firstPassCiGreen, postOpenReviewRounds: record!.postOpenReviewRounds,
        humanTouchMinutes: record!.humanTouchMinutes,
        findings: record!.reviewFindings.length, costs: record!.lensCosts.length,
      }).toEqual(expected);
    }
  });

  it("pins the counterfactual-credit signal the review-allocation analysis reads", () => {
    const summaries = summarizeLensMetrics(records());
    const total = (key: "findings" | "credited" | "suppressed") => summaries.reduce((sum, entry) => sum + entry[key], 0);
    // Two unique-to-lens fsr blockers (#150 slice-9a, #153 issue-151 fix) earn credit;
    // the #150 mutation-gate failure is downstream-gate suppressed (a CI-gate catch,
    // no review credit); everything else is unassessed.
    expect(total("findings")).toBe(17);
    expect(total("credited")).toBe(2);
    expect(total("suppressed")).toBe(1);
  });
});
