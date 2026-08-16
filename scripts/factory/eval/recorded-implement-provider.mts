import type { IssueSnapshot } from "./issue-snapshot-schema.mts";
import { isUtf8PayloadWithinLimit } from "./validation-common.mts";

/** Must byte-equal the loader's patch bound (drift-pinned by test T87). */
export const MAX_RECORDED_PATCH_BYTES = 2_097_152;

/** Exactly what a future live implement provider consumes — answer-free by construction. */
export interface ImplementProducerInputs {
  readonly issueNumber: number;
  readonly snapshot: IssueSnapshot;
  readonly decisionContextText: string | null;
  readonly baseSha: string;
}

export type ImplementProduceResult =
  | { readonly ok: true; readonly patchText: string }
  | { readonly ok: false; readonly errors: readonly string[] };

export interface ImplementProvider {
  produce(inputs: ImplementProducerInputs): Promise<ImplementProduceResult>;
}

export function createRecordedImplementProvider(
  recordedPatchText: string,
): ImplementProvider {
  return {
    async produce(inputs): Promise<ImplementProduceResult> {
      try {
        // Frozen replay deliberately ignores inputs (corpus README §7).
        void inputs;
        if (!isUtf8PayloadWithinLimit(recordedPatchText, MAX_RECORDED_PATCH_BYTES)) {
          return {
            ok: false,
            errors: ["recorded implement patch exceeds 2097152 UTF-8 bytes"],
          };
        }

        if (recordedPatchText.includes("\0")) {
          return {
            ok: false,
            errors: ["recorded implement patch contains a NUL byte"],
          };
        }

        if (!recordedPatchText.startsWith("diff --git ")) {
          return {
            ok: false,
            errors: ["recorded implement patch does not begin with a git diff header"],
          };
        }

        if (
          /^GIT binary patch/m.test(recordedPatchText) ||
          /^Binary files .* differ$/m.test(recordedPatchText)
        ) {
          return {
            ok: false,
            errors: ["recorded implement patch contains a binary patch section"],
          };
        }

        if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m.test(recordedPatchText)) {
          return {
            ok: false,
            errors: ["recorded implement patch contains no unified-diff hunk"],
          };
        }

        return { ok: true, patchText: recordedPatchText };
      } catch {
        return {
          ok: false,
          errors: ["recorded implement provider failed while replaying the recorded patch"],
        };
      }
    },
  };
}
