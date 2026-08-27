/**
 * Dependency-free deterministic mode guard for triage readiness. This leaf is
 * safe to load in the privileged triage apply process.
 */

import {
  READINESS_LABELS,
  type ReadinessLabel,
} from "./triage-verdict-schema.mts";

export type TriageMode = "pre-filter" | "readiness";

export interface TriageModeClampResult {
  readonly effectiveReadiness: ReadinessLabel;
  readonly clamped: boolean;
  readonly clampNotice: string | null;
}

const PRE_FILTER_CLAMPED_READINESS = new Set<ReadinessLabel>(
  READINESS_LABELS.filter(
    (readiness) =>
      readiness === "ready-to-implement" ||
      readiness === "ready-for-conventional-implementation" ||
      readiness === "wait-to-implement",
  ),
);

/** Maps unknown or absent workflow context to the non-authorizing mode. */
export function validateTriageMode(raw: string | undefined): TriageMode {
  return raw === "readiness" ? "readiness" : "pre-filter";
}

function buildClampNotice(originalReadiness: ReadinessLabel): string {
  return (
    `Pre-filter triage downgrade: readiness reduced from \`${originalReadiness}\` ` +
    "to `ready-to-spec`. A raw issue must be specced before it can authorize " +
    "implementation."
  );
}

/** Clamps authorizing or waiting verdicts while triaging a raw issue. */
export function clampTriageReadiness(
  mode: TriageMode,
  readiness: ReadinessLabel,
): TriageModeClampResult {
  if (mode === "pre-filter" && PRE_FILTER_CLAMPED_READINESS.has(readiness)) {
    return {
      effectiveReadiness: "ready-to-spec",
      clamped: true,
      clampNotice: buildClampNotice(readiness),
    };
  }

  return {
    effectiveReadiness: readiness,
    clamped: false,
    clampNotice: null,
  };
}
