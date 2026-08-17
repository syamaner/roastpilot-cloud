import {
  ISSUE_TYPES,
} from "./expected-result-schema.mts";
import { STAGES } from "./corpus-manifest-schema.mts";
import {
  IMPLEMENT_DIMENSIONS,
  TRIAGE_ONLY_DIMENSIONS,
  type EvalBaseline,
} from "./eval-baseline-schema.mts";
import { isPlainObject } from "./validation-common.mts";

export const RECORDED_TOLERANCE = 0;
export const RECORDED_MAX_RETRIES = 0;
export const REQUIRED_ISSUE_TYPE_FLOORS = {
  documentation: 2,
  feature: 2,
  hardening: 4,
  schema: 1,
  "security-fix": 3,
} as const;
export const REQUIRED_STAGE_FLOORS = {
  "triage-and-implement": 4,
  "triage-only": 8,
} as const;

type DimensionVerdict =
  | { readonly pass: true }
  | { readonly pass: false; readonly reason: string };

export type EvalVerdict =
  | { readonly pass: true }
  | { readonly pass: false; readonly reasons: readonly string[] };

export interface RecordedCaseRecord {
  readonly caseId: string;
  readonly stage: "triage-and-implement" | "triage-only";
  readonly issueType: (typeof ISSUE_TYPES)[number];
  readonly dimensions: Readonly<Record<string, DimensionVerdict>>;
  readonly recordedPrOutcome: unknown;
}

export interface RecordedEvalReport {
  readonly cases: readonly RecordedCaseRecord[];
}

type DimensionEntry = readonly [string, DimensionVerdict];

type MaterializedRecord =
  | {
      readonly valid: true;
      readonly caseId: string;
      readonly issueType: string;
      readonly stage: string;
      readonly dimensionEntries: readonly DimensionEntry[];
      readonly dimensionNames: readonly string[];
    }
  | {
      readonly valid: false;
      readonly caseId: string;
      readonly reason: string;
    };

function malformedVerdict(): DimensionVerdict {
  return { pass: false, reason: "malformed verdict" };
}

function materializeVerdict(raw: unknown): DimensionVerdict {
  if (!isPlainObject(raw)) return malformedVerdict();
  try {
    const keys = Reflect.ownKeys(raw);
    const pass = raw.pass;
    if (pass === true && keys.length === 1 && keys[0] === "pass") {
      return { pass: true };
    }
    if (
      pass === false &&
      keys.length === 2 &&
      keys.includes("pass") &&
      keys.includes("reason")
    ) {
      const reason = raw.reason;
      if (typeof reason === "string") return { pass: false, reason };
    }
  } catch {
    return malformedVerdict();
  }
  return malformedVerdict();
}

function malformedRecord(caseId: unknown): MaterializedRecord {
  const displayCaseId = typeof caseId === "string"
    ? caseId
    : "<malformed record>";
  return {
    valid: false,
    caseId: displayCaseId,
    reason: `${displayCaseId} record: malformed record`,
  };
}

function materializeRecord(record: unknown): MaterializedRecord {
  let caseId: unknown;
  try {
    if (!isPlainObject(record)) return malformedRecord(caseId);
    caseId = record.caseId;
    const issueType = record.issueType;
    const stage = record.stage;
    const dimensions = record.dimensions;
    if (
      typeof caseId !== "string" ||
      typeof issueType !== "string" ||
      typeof stage !== "string" ||
      !(STAGES as readonly string[]).includes(stage) ||
      !isPlainObject(dimensions)
    ) {
      return malformedRecord(caseId);
    }
    const dimensionEntries = Object.entries(dimensions).map(
      ([name, verdict]) => [name, materializeVerdict(verdict)] as const,
    );
    return {
      valid: true,
      caseId,
      issueType,
      stage,
      dimensionEntries,
      dimensionNames: dimensionEntries.map(([name]) => name).sort(),
    };
  } catch {
    return malformedRecord(caseId);
  }
}

function sameOrderedStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function addFloorReasons(
  counts: Readonly<Record<string, number>>,
  floors: Readonly<Record<string, number>>,
  bucketName: string,
  reasons: string[],
): void {
  for (const [name, floor] of Object.entries(floors)) {
    const count = counts[name] ?? 0;
    if (count < floor) {
      reasons.push(
        `${bucketName} ${name} count ${String(count)} is below required floor ${String(floor)}`,
      );
    }
  }
}

export function evaluateAgainstBaseline(
  report: RecordedEvalReport,
  baseline: EvalBaseline | undefined,
  corpusSha256: string,
): EvalVerdict {
  const reasons: string[] = [];
  try {
    const rawCases = Array.isArray(report.cases) ? report.cases : [];
    const snapshots = rawCases.map(materializeRecord);
    let baselineCases: ReadonlyMap<
      string,
      EvalBaseline["cases"][number]
    > | undefined;
    if (baseline === undefined) {
      reasons.push("absent baseline prevents recorded evaluation");
    } else {
      if (corpusSha256 !== baseline.corpus.corpusSha256) {
        reasons.push("corpus SHA-256 does not byte-match the baseline");
      }

      const reportCaseIds = snapshots.map((snapshot) => snapshot.caseId).sort();
      if (!sameOrderedStrings(reportCaseIds, baseline.corpus.caseIds)) {
        reasons.push("report caseId set does not byte-match the baseline");
      }

      baselineCases = new Map(
        baseline.cases.map((entry) => [entry.caseId, entry] as const),
      );
    }

    const nonPassReasons: string[] = [];
    const issueTypeCounts: Record<string, number> = {};
    const stageCounts: Record<string, number> = {};
    for (const snapshot of snapshots) {
      if (!snapshot.valid) {
        nonPassReasons.push(snapshot.reason);
        continue;
      }
      const stageDimensions = snapshot.stage === "triage-and-implement"
        ? IMPLEMENT_DIMENSIONS
        : TRIAGE_ONLY_DIMENSIONS;
      if (!sameOrderedStrings(snapshot.dimensionNames, stageDimensions)) {
        reasons.push(`${snapshot.caseId} dimension set does not match its stage`);
      }
      const expected = baselineCases?.get(snapshot.caseId);
      if (expected !== undefined) {
        if (!sameOrderedStrings(snapshot.dimensionNames, expected.dimensions)) {
          reasons.push(
            `${snapshot.caseId} dimension set does not byte-match the baseline`,
          );
        }
        if (snapshot.issueType !== expected.issueType) {
          reasons.push(`${snapshot.caseId} issueType does not match the baseline`);
        }
      }
      issueTypeCounts[snapshot.issueType] =
        (issueTypeCounts[snapshot.issueType] ?? 0) + 1;
      stageCounts[snapshot.stage] = (stageCounts[snapshot.stage] ?? 0) + 1;
      for (const [dimension, verdict] of snapshot.dimensionEntries) {
        if (verdict.pass === false) {
          nonPassReasons.push(
            `${snapshot.caseId} ${dimension}: ${verdict.reason}`,
          );
        }
      }
    }
    if (nonPassReasons.length > RECORDED_TOLERANCE) {
      reasons.push(...nonPassReasons);
    }

    addFloorReasons(
      issueTypeCounts,
      REQUIRED_ISSUE_TYPE_FLOORS,
      "issueType",
      reasons,
    );
    addFloorReasons(stageCounts, REQUIRED_STAGE_FLOORS, "stage", reasons);
  } catch {
    reasons.push("recorded evaluation inputs are not inspectable");
  }
  return reasons.length === 0 ? { pass: true } : { pass: false, reasons };
}
