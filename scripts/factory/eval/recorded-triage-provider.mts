import type { IssueSnapshot } from "./issue-snapshot-schema.mts";
import {
  MAX_PAYLOAD_BYTES,
  validateTriageVerdict,
  type ReadinessLabel,
} from "../triage-verdict-schema.mts";
import { isUtf8PayloadWithinLimit } from "./validation-common.mts";

/** Exactly what a future live provider consumes — answer-free by construction. */
export interface TriageProducerInputs {
  readonly issueNumber: number;
  readonly snapshot: IssueSnapshot;
  readonly decisionContextText: string | null;
}

export type TriageProduceResult =
  | { readonly ok: true; readonly readiness: ReadinessLabel }
  | { readonly ok: false; readonly errors: readonly string[] };

export interface TriageProvider {
  produce(inputs: TriageProducerInputs): Promise<TriageProduceResult>;
}

export function createRecordedTriageProvider(
  recordedVerdictText: string,
): TriageProvider {
  return {
    async produce(inputs): Promise<TriageProduceResult> {
      try {
        // Frozen replay deliberately ignores snapshot and decision content (corpus README §7).
        if (!isUtf8PayloadWithinLimit(recordedVerdictText, MAX_PAYLOAD_BYTES)) {
          return {
            ok: false,
            errors: ["recorded triage verdict exceeds 20000 UTF-8 bytes"],
          };
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(recordedVerdictText) as unknown;
        } catch {
          return {
            ok: false,
            errors: ["recorded triage verdict is not valid JSON"],
          };
        }

        const result = validateTriageVerdict(parsed, inputs.issueNumber);
        if (!result.ok) return { ok: false, errors: result.errors };
        return { ok: true, readiness: result.verdict.readiness };
      } catch {
        return {
          ok: false,
          errors: ["recorded triage provider failed while replaying the recorded verdict"],
        };
      }
    },
  };
}
