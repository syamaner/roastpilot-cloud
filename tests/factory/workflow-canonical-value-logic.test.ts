import { describe, expect, it } from "vitest";

import {
  MAX_WORKFLOW_CANONICAL_DEPTH,
  MAX_WORKFLOW_CANONICAL_VALUES,
  WorkflowCanonicalValueBuilder,
} from "../../scripts/factory/workflow-canonical-value-logic.mts";

function nestedValue(depth: number): unknown {
  let value: unknown = "leaf";
  for (let current = 1; current < depth; current += 1) {
    value = [value];
  }
  return value;
}

describe("ordered workflow canonical values (issue #120 slice 120d-1b1)", () => {
  it("counts the root at depth one and every mapping key", () => {
    const builder = new WorkflowCanonicalValueBuilder();
    const result = builder.canonicalize(
      new Map([
        ["10", true],
        ["2", null],
      ]),
    );

    expect(result).toEqual({
      kind: "canonical",
      value: {
        kind: "mapping",
        entries: [
          {
            key: "10",
            value: { kind: "boolean", value: true },
          },
          { key: "2", value: { kind: "null" } },
        ],
      },
    });
    expect(builder.emittedValues).toBe(5);
    expect(builder.deepestEmission).toBe(2);
  });

  it("accepts exactly 16,384 emissions and rejects the next incrementally", () => {
    const accepted = new WorkflowCanonicalValueBuilder();
    expect(
      accepted.canonicalize(
        Array.from(
          { length: MAX_WORKFLOW_CANONICAL_VALUES - 1 },
          () => null,
        ),
      ).kind,
    ).toBe("canonical");
    expect(accepted.emittedValues).toBe(
      MAX_WORKFLOW_CANONICAL_VALUES,
    );

    const rejected = new WorkflowCanonicalValueBuilder();
    expect(
      rejected.canonicalize(
        Array.from(
          { length: MAX_WORKFLOW_CANONICAL_VALUES },
          () => null,
        ),
      ),
    ).toEqual({
      kind: "resource-limit",
      detail: `canonical value exceeds ${MAX_WORKFLOW_CANONICAL_VALUES} emitted values`,
    });
    expect(rejected.emittedValues).toBe(
      MAX_WORKFLOW_CANONICAL_VALUES,
    );
  });

  it("accepts depth 32, rejects depth 33, and enforces depth independently", () => {
    const accepted = new WorkflowCanonicalValueBuilder();
    expect(
      accepted.canonicalize(
        nestedValue(MAX_WORKFLOW_CANONICAL_DEPTH),
      ).kind,
    ).toBe("canonical");
    expect(accepted.deepestEmission).toBe(
      MAX_WORKFLOW_CANONICAL_DEPTH,
    );

    const rejected = new WorkflowCanonicalValueBuilder();
    expect(
      rejected.canonicalize(
        nestedValue(MAX_WORKFLOW_CANONICAL_DEPTH + 1),
      ),
    ).toEqual({
      kind: "resource-limit",
      detail: `canonical value exceeds depth ${MAX_WORKFLOW_CANONICAL_DEPTH}`,
    });
    expect(rejected.emittedValues).toBe(
      MAX_WORKFLOW_CANONICAL_DEPTH,
    );
  });

  it("preserves sequence and hazardous mapping-key order without prototypes", () => {
    const first = new WorkflowCanonicalValueBuilder().canonicalize(
      new Map<string, unknown>([
        ["__proto__", "safe"],
        ["constructor", 1],
        ["prototype", false],
      ]),
    );
    const reversed = new WorkflowCanonicalValueBuilder().canonicalize(
      new Map<string, unknown>([
        ["prototype", false],
        ["constructor", 1],
        ["__proto__", "safe"],
      ]),
    );

    expect(first).not.toEqual(reversed);
    expect(({} as Record<string, unknown>).safe).toBeUndefined();
  });

  it.each([
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    -0,
  ])("rejects non-injective number %s", (value) => {
    expect(
      new WorkflowCanonicalValueBuilder().canonicalize(value),
    ).toEqual(
      expect.objectContaining({ kind: "unsupported-value" }),
    );
  });

  it("rejects non-string mapping keys", () => {
    expect(
      new WorkflowCanonicalValueBuilder().canonicalize(
        new Map<unknown, unknown>([[1, "value"]]),
      ),
    ).toEqual({
      kind: "unsupported-value",
      detail: "canonical mapping keys must be strings",
    });
  });

  it("stops before a mapping key that would cross the value ceiling", () => {
    const builder = new WorkflowCanonicalValueBuilder();
    expect(
      builder.canonicalize(
        Array.from(
          { length: MAX_WORKFLOW_CANONICAL_VALUES - 2 },
          () => null,
        ),
      ).kind,
    ).toBe("canonical");

    expect(
      builder.canonicalize(new Map([["blocked", null]])),
    ).toEqual({
      kind: "resource-limit",
      detail: `canonical value exceeds ${MAX_WORKFLOW_CANONICAL_VALUES} emitted values`,
    });
  });

  it("rejects plain objects rather than enumerating prototype-bearing input", () => {
    expect(
      new WorkflowCanonicalValueBuilder().canonicalize({
        safe: true,
      }),
    ).toEqual({
      kind: "unsupported-value",
      detail:
        "canonical values must be null, scalar, sequence, or string-keyed mapping",
    });
  });

  it("propagates an unsupported nested mapping value", () => {
    expect(
      new WorkflowCanonicalValueBuilder().canonicalize(
        new Map([["unsafe", { hidden: true }]]),
      ),
    ).toEqual({
      kind: "unsupported-value",
      detail:
        "canonical values must be null, scalar, sequence, or string-keyed mapping",
    });
  });
});
