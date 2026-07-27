/**
 * Bounded ordered canonical values for GitHub Actions execution evidence.
 *
 * Mapping entries remain arrays so integer-like and prototype-named keys
 * cannot reorder or mutate the resulting evidence.
 */

export const MAX_WORKFLOW_CANONICAL_VALUES = 16_384;
export const MAX_WORKFLOW_CANONICAL_DEPTH = 32;

/**
 * One recursively canonical JSON-safe value.
 */
export type WorkflowCanonicalValue =
  | { readonly kind: "null" }
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "integer"; readonly value: number }
  | { readonly kind: "string"; readonly value: string }
  | {
      readonly kind: "sequence";
      readonly items: readonly WorkflowCanonicalValue[];
    }
  | {
      readonly kind: "mapping";
      readonly entries: readonly WorkflowCanonicalMappingEntry[];
    };

/**
 * One ordered string-keyed canonical mapping entry.
 */
export interface WorkflowCanonicalMappingEntry {
  readonly key: string;
  readonly value: WorkflowCanonicalValue;
}

/**
 * Result of one incremental canonical-value emission.
 */
export type WorkflowCanonicalValueResult =
  | { readonly kind: "canonical"; readonly value: WorkflowCanonicalValue }
  | {
      readonly kind: "resource-limit" | "unsupported-value";
      readonly detail: string;
    };

/**
 * Per-workflow incremental canonical-value emitter.
 */
export class WorkflowCanonicalValueBuilder {
  #emittedValues = 0;
  #deepestEmission = 0;

  /**
   * Number of emissions consumed so far.
   */
  get emittedValues(): number {
    return this.#emittedValues;
  }

  /**
   * Deepest emitted value so far, with a root depth of 1.
   */
  get deepestEmission(): number {
    return this.#deepestEmission;
  }

  /**
   * Canonicalize one value within this workflow's shared budget.
   *
   * @param input - Null, scalar, sequence, or string-keyed Map input.
   * @returns Canonical evidence or the first fail-closed violation.
   */
  canonicalize(input: unknown): WorkflowCanonicalValueResult {
    return this.#canonicalizeAtDepth(input, 1);
  }

  #consume(depth: number): WorkflowCanonicalValueResult | undefined {
    if (depth > MAX_WORKFLOW_CANONICAL_DEPTH) {
      return {
        kind: "resource-limit",
        detail: `canonical value exceeds depth ${MAX_WORKFLOW_CANONICAL_DEPTH}`,
      };
    }
    if (this.#emittedValues >= MAX_WORKFLOW_CANONICAL_VALUES) {
      return {
        kind: "resource-limit",
        detail: `canonical value exceeds ${MAX_WORKFLOW_CANONICAL_VALUES} emitted values`,
      };
    }
    this.#emittedValues += 1;
    this.#deepestEmission = Math.max(this.#deepestEmission, depth);
    return undefined;
  }

  #canonicalizeAtDepth(
    input: unknown,
    depth: number,
  ): WorkflowCanonicalValueResult {
    const consumed = this.#consume(depth);
    if (consumed !== undefined) {
      return consumed;
    }
    if (input === null) {
      return { kind: "canonical", value: { kind: "null" } };
    }
    if (typeof input === "string") {
      return {
        kind: "canonical",
        value: { kind: "string", value: input },
      };
    }
    if (typeof input === "boolean") {
      return {
        kind: "canonical",
        value: { kind: "boolean", value: input },
      };
    }
    if (typeof input === "number") {
      return Number.isFinite(input) &&
        Number.isSafeInteger(input) &&
        !Object.is(input, -0)
        ? {
            kind: "canonical",
            value: { kind: "integer", value: input },
          }
        : {
            kind: "unsupported-value",
            detail:
              "canonical numeric values must be finite safe integers other than negative zero",
          };
    }
    if (Array.isArray(input)) {
      const items: WorkflowCanonicalValue[] = [];
      for (const entry of input) {
        const result = this.#canonicalizeAtDepth(entry, depth + 1);
        if (result.kind !== "canonical") {
          return result;
        }
        items.push(result.value);
      }
      return {
        kind: "canonical",
        value: { kind: "sequence", items },
      };
    }
    if (input instanceof Map) {
      const entries: WorkflowCanonicalMappingEntry[] = [];
      for (const [key, entry] of input.entries()) {
        if (typeof key !== "string") {
          return {
            kind: "unsupported-value",
            detail: "canonical mapping keys must be strings",
          };
        }
        const keyConsumption = this.#consume(depth + 1);
        if (keyConsumption !== undefined) {
          return keyConsumption;
        }
        const value = this.#canonicalizeAtDepth(entry, depth + 1);
        if (value.kind !== "canonical") {
          return value;
        }
        entries.push({ key, value: value.value });
      }
      return {
        kind: "canonical",
        value: { kind: "mapping", entries },
      };
    }
    return {
      kind: "unsupported-value",
      detail:
        "canonical values must be null, scalar, sequence, or string-keyed mapping",
    };
  }
}
