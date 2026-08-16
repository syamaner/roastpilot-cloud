import type { LoadedCase } from "./corpus-loader-logic.mts";
import {
  createRecordedImplementProvider,
  type ImplementProducerInputs,
  type ImplementProvider,
} from "./recorded-implement-provider.mts";

export type ImplementReplay =
  | {
      readonly kind: "recorded-patch";
      readonly inputs: ImplementProducerInputs;
      readonly provider: ImplementProvider;
    }
  | { readonly kind: "triage-only" };

export function prepareRecordedImplementReplay(
  loadedCase: LoadedCase,
): ImplementReplay {
  if (loadedCase.recordedImplementPatchText === null) {
    return { kind: "triage-only" };
  }

  return {
    kind: "recorded-patch",
    inputs: {
      issueNumber: loadedCase.case.issueNumber,
      snapshot: loadedCase.snapshot,
      decisionContextText: loadedCase.decisionContextText,
      baseSha: loadedCase.case.baseSha,
    },
    provider: createRecordedImplementProvider(
      loadedCase.recordedImplementPatchText,
    ),
  };
}
