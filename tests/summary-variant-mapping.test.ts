import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const mappedFields = [
  "started_at_utc",
  "first_crack_at_utc",
  "beans_dropped_at_utc",
  "beans_added_at_utc",
  "development_time_percent",
  "total_roast_seconds",
] as const;
const timestampFields = mappedFields.slice(0, 4);
const numericFields = mappedFields.slice(4);
const mappedFieldSet = new Set<string>(mappedFields);
const isoDatetime =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

type Summary = Record<string, unknown>;

function loadSummary(session: 1 | 2): Summary {
  return JSON.parse(
    readFileSync(
      join(
        process.cwd(),
        `snowflake/fixtures/m1-export/session-${session}/summary.json`,
      ),
      "utf8",
    ),
  ) as Summary;
}

function clone(summary: Summary): Summary {
  return JSON.parse(JSON.stringify(summary)) as Summary;
}

function allKeys(value: unknown): string[] {
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...allKeys(child)]);
}

function assertSummaryMapping(summary: Summary): void {
  for (const field of timestampFields) {
    const value = summary[field];
    if (
      typeof value !== "string" ||
      !isoDatetime.test(value) ||
      !Number.isFinite(Date.parse(value))
    ) {
      throw new Error(`${field} must be a non-null ISO datetime string`);
    }
  }
  for (const field of numericFields) {
    const value = summary[field];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw new Error(`${field} must be a non-null finite number`);
    }
  }

  for (const key of allKeys(summary)) {
    if (/(?:first_crack|drop)_temp/.test(key)) {
      throw new Error(`summary must not contain temperature field ${key}`);
    }
    if (key === "bean_origin" || key === "roast_level") {
      throw new Error(`summary must not contain synthesised field ${key}`);
    }
  }

  const metrics = summary.metrics;
  if (typeof metrics !== "object" || metrics === null || Array.isArray(metrics)) {
    throw new Error("summary.metrics must be present");
  }
  const metricDevelopment = (metrics as Summary).development_time_percent;
  if (
    typeof metricDevelopment !== "number" ||
    !Number.isFinite(metricDevelopment) ||
    metricDevelopment !== summary.development_time_percent
  ) {
    throw new Error("metrics development time must mirror the top-level field");
  }
}

const summaries = [loadSummary(1), loadSummary(2)];

describe("summary VARIANT mapping contract", () => {
  it.each(summaries)("T-MAP-present: session %# has six typed fields", (summary) => {
    expect(() => assertSummaryMapping(summary)).not.toThrow();
  });

  it.each(summaries)("T-MAP-nonnull: session %# maps no null fields", (summary) => {
    for (const field of mappedFields) expect(summary[field]).not.toBeNull();
  });

  it.each(summaries)("T-A1-absent: session %# has no FC/drop temp", (summary) => {
    expect(allKeys(summary).some((key) => /(?:first_crack|drop)_temp/.test(key))).toBe(false);
  });

  it.each(summaries)("T-A2-absent: session %# has no grouping fields", (summary) => {
    expect(allKeys(summary)).not.toContain("bean_origin");
    expect(allKeys(summary)).not.toContain("roast_level");
  });

  it("T-D1-decoy: metrics mirrors M5, whose mapping is top-level", () => {
    for (const summary of summaries) {
      const metrics = summary.metrics as Summary;
      expect(metrics).toBeDefined();
      expect(metrics.development_time_percent).toBe(summary.development_time_percent);
    }
    expect(summaries[0].development_time_percent).toBe(15.003);
  });

  it("T-nullable-outofscope: session 2 null lifecycle fields are not mapped", () => {
    expect(summaries[1].stopped_at_utc).toBeNull();
    expect(summaries[1].cooling_stopped_at_utc).toBeNull();
    expect(mappedFieldSet.has("stopped_at_utc")).toBe(false);
    expect(mappedFieldSet.has("cooling_stopped_at_utc")).toBe(false);
  });

  it.each(mappedFields.map((field, index) => [index + 1, field] as const))(
    "NEG-M%d-delete: deleting %s throws",
    (_number, field) => {
      const mutated = clone(summaries[0]);
      delete mutated[field];
      expect(() => assertSummaryMapping(mutated)).toThrow(field);
    },
  );

  it.each(mappedFields.map((field, index) => [index + 1, field] as const))(
    "NEG-M%d-retype: retyping %s throws",
    (_number, field) => {
      const mutated = clone(summaries[0]);
      mutated[field] = timestampFields.includes(field) ? 123 : "15.003";
      expect(() => assertSummaryMapping(mutated)).toThrow(field);
    },
  );

  it.each(["not-a-date", "2026-13-45T99:99:99Z"])(
    "NEG-M-retype-malformed-iso: %s throws",
    (value) => {
      const mutated = clone(summaries[0]);
      mutated.started_at_utc = value;
      expect(() => assertSummaryMapping(mutated)).toThrow("started_at_utc");
    },
  );

  it.each([
    ["first_crack_temp_avg_c", false],
    ["drop_temp_avg_c", true],
    ["avg_first_crack_temp_c", false],
    ["prev_drop_temp_avg_c", true],
  ] as const)("NEG-A1-inject: %s at a recursive depth throws", (field, nested) => {
    const mutated = clone(summaries[0]);
    if (nested) (mutated.first_crack_model as Summary)[field] = 200;
    else mutated[field] = 200;
    expect(() => assertSummaryMapping(mutated)).toThrow(field);
  });

  it("NEG-A1-companion: bean temp delta substring remains allowed", () => {
    const mutated = clone(summaries[0]);
    (mutated.first_crack_model as Summary).bean_temp_delta_60s_c = 1;
    expect(() => assertSummaryMapping(mutated)).not.toThrow();
  });

  it.each(["bean_origin", "roast_level"])("NEG-A2-inject: nested %s throws", (field) => {
    const mutated = clone(summaries[0]);
    (mutated.first_crack_model as Summary)[field] = "injected";
    expect(() => assertSummaryMapping(mutated)).toThrow(field);
  });

  it("NEG-D1-metrics-repoint: metrics cannot replace the top-level source", () => {
    const mutated = clone(summaries[0]);
    delete mutated.development_time_percent;
    expect((mutated.metrics as Summary).development_time_percent).toBe(15.003);
    expect(() => assertSummaryMapping(mutated)).toThrow("development_time_percent");
  });

  it("NEG-nullable: nulling a mapped session-2 field throws", () => {
    const mutated = clone(summaries[1]);
    mutated.beans_dropped_at_utc = null;
    expect(() => assertSummaryMapping(mutated)).toThrow("beans_dropped_at_utc");
  });
});
