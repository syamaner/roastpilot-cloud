import type { LoadedCase } from "./corpus-loader-logic.mts";
import {
  createRecordedTriageProvider,
  type TriageProducerInputs,
  type TriageProvider,
} from "./recorded-triage-provider.mts";

export interface TriageReplay {
  readonly inputs: TriageProducerInputs;
  readonly provider: TriageProvider;
}

export function prepareRecordedTriageReplay(
  loadedCase: LoadedCase,
): TriageReplay {
  return {
    inputs: {
      issueNumber: loadedCase.case.issueNumber,
      snapshot: loadedCase.snapshot,
      decisionContextText: loadedCase.decisionContextText,
    },
    provider: createRecordedTriageProvider(
      loadedCase.recordedTriageVerdictText,
    ),
  };
}
