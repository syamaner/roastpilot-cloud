import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BEAN_ORIGINS,
  generate,
  ROAST_LEVELS,
} from "../scripts/seed/generate";
import { parseExportDir } from "../scripts/seed/parse-export";
import {
  CLOUD_ROAST_ID_PATTERN,
  validateSeedOutput,
} from "../scripts/seed/rules";
import { createSeededRng, synthCloudRoastId } from "../scripts/seed/synth";

const NOW = new Date("2026-08-24T12:00:00.000Z");
const FIXTURE_ROOT = new URL("../snowflake/fixtures/m1-export/", import.meta.url);
const PARSED_EXPORTS = ["session-1", "session-2"].map((session) =>
  parseExportDir(fileURLToPath(new URL(`${session}/`, FIXTURE_ROOT))),
);

const RAW_KEYS = [
  "bean_temp_c",
  "env_temp_c",
  "fan_percent",
  "heat_percent",
  "sample_elapsed_s",
  "source",
];
const SUMMARY_KEYS = [
  "beans_added_at_utc",
  "beans_dropped_at_utc",
  "development_time_percent",
  "development_time_seconds",
  "first_crack_at_utc",
  "first_crack_model",
  "metrics",
  "started_at_utc",
  "total_roast_seconds",
];
const SUMMARY_METRIC_KEYS = [
  "bean_ror_c_per_min",
  "bean_temp_delta_60s_c",
  "env_ror_c_per_min",
  "env_temp_delta_60s_c",
  "roast_elapsed_seconds",
];
const SUMMARY_MODEL_KEYS = ["confidence", "confidence_threshold"];
const SUMMARY_ISO_KEYS = new Set([
  "beans_added_at_utc",
  "beans_dropped_at_utc",
  "first_crack_at_utc",
  "started_at_utc",
]);

function logicalKey(beanOrigin: string | null, roastLevel: string | null): string {
  return JSON.stringify([beanOrigin, roastLevel]);
}

function isoMicroseconds(iso: string): bigint {
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(iso)?.[1] ?? "";
  const microseconds = fraction.padEnd(6, "0").slice(0, 6);
  return BigInt(Date.parse(iso)) * BigInt(1_000) +
    BigInt(microseconds.slice(3, 6).padEnd(3, "0"));
}

function intervalMicroseconds(start: string, end: string): bigint {
  return isoMicroseconds(end) - isoMicroseconds(start);
}

describe("generate", () => {
  it("rejects an empty parsed-export input", () => {
    expect(() => generate([], { now: NOW })).toThrow(
      "At least one parsed export is required",
    );
  });

  it("rejects an invalid generation time", () => {
    expect(() => generate(PARSED_EXPORTS, { now: new Date("invalid") })).toThrow(
      "A valid generation time is required",
    );
  });

  it("handles source lifecycle timestamps without fractional seconds", () => {
    const source = PARSED_EXPORTS[0];
    const withoutFraction = (iso: string): string =>
      iso.replace(/\.\d+(?=Z|[+-]\d{2}:\d{2}$)/, "");
    const output = generate([{
      ...source,
      summary: {
        ...source.summary,
        started_at_utc: withoutFraction(source.summary.started_at_utc),
        beans_added_at_utc: withoutFraction(source.summary.beans_added_at_utc),
        first_crack_at_utc: withoutFraction(source.summary.first_crack_at_utc),
        beans_dropped_at_utc: withoutFraction(source.summary.beans_dropped_at_utc),
      },
    }], { now: NOW });

    expect(validateSeedOutput(output, NOW.getTime())).toEqual([]);
  });

  it("fans parsed exports out across all five seed tables", () => {
    const output = generate(PARSED_EXPORTS, { now: NOW });

    expect(output.cloudRoasts).toHaveLength(24);
    expect(output.roastTelemetry.length).toBeGreaterThan(0);
    expect(output.roastArtifacts.length).toBeGreaterThan(0);
    expect(output.tastingReviews.length).toBeGreaterThan(0);
    expect(output.referenceRoastSummaries).toHaveLength(12);
  });

  it("creates every parent and child in causal order before now", () => {
    const output = generate(PARSED_EXPORTS, { now: NOW });
    const parents = new Map(output.cloudRoasts.map((roast) => [roast.id, roast]));

    for (const roast of output.cloudRoasts) {
      if (roast.roasted_at_utc === null) {
        throw new Error("Expected synthetic roast timestamp");
      }
      expect(Date.parse(roast.roasted_at_utc)).toBeLessThanOrEqual(
        Date.parse(roast.created_at),
      );
      expect(Date.parse(roast.created_at)).toBeLessThanOrEqual(NOW.getTime());
    }
    for (const child of [...output.roastArtifacts, ...output.tastingReviews]) {
      const parent = parents.get(child.roast_id);
      if (parent === undefined) throw new Error("Expected child parent roast");
      expect(Date.parse(child.created_at)).toBeGreaterThanOrEqual(
        Date.parse(parent.created_at),
      );
      expect(Date.parse(child.created_at)).toBeLessThanOrEqual(NOW.getTime());
    }
    for (const summary of output.referenceRoastSummaries) {
      expect(summary.updated_at).toBe(NOW.toISOString());
    }
  });

  it("passes the complete seed-output contract", () => {
    const output = generate(PARSED_EXPORTS, { now: NOW });

    expect(validateSeedOutput(output, NOW.getTime())).toEqual([]);
  });

  it("emits exactly one synthetic reference summary per configured group", () => {
    const output = generate(PARSED_EXPORTS, { now: NOW });
    const keys = output.referenceRoastSummaries.map((summary) =>
      logicalKey(summary.bean_origin, summary.roast_level));

    expect(new Set(keys).size).toBe(12);
    expect(output.referenceRoastSummaries.every((summary) =>
      (BEAN_ORIGINS as readonly string[]).includes(summary.bean_origin) &&
      (ROAST_LEVELS as readonly string[]).includes(summary.roast_level),
    )).toBe(true);
  });

  it("produces 24 distinct summary and telemetry value variations", () => {
    const output = generate(PARSED_EXPORTS, { now: NOW });
    const summaries = output.cloudRoasts.map((roast) => JSON.stringify(roast.summary));
    const curveSignatures = output.cloudRoasts.map((roast) =>
      JSON.stringify(output.roastTelemetry
        .filter((row) => row.roast_id === roast.id)
        .map((row) => [
          row.bean_temp_c,
          row.env_temp_c,
          row.heat_percent,
          row.fan_percent,
        ])),
    );

    expect(new Set(summaries).size).toBe(24);
    expect(new Set(curveSignatures).size).toBe(24);
    for (let index = 0; index < curveSignatures.length - 2; index += 1) {
      expect(curveSignatures[index]).not.toBe(curveSignatures[index + 2]);
    }
    expect(output.roastTelemetry.every((row) =>
      Number.isFinite(row.bean_temp_c) &&
      Number.isFinite(row.env_temp_c) &&
      Number.isInteger(row.heat_percent) &&
      row.heat_percent !== null &&
      row.heat_percent >= 0 &&
      row.heat_percent <= 100 &&
      Number.isInteger(row.fan_percent) &&
      row.fan_percent !== null &&
      row.fan_percent >= 0 &&
      row.fan_percent <= 100,
    )).toBe(true);
  });

  it("shifts lifecycle provenance while preserving source intervals exactly", () => {
    const output = generate(PARSED_EXPORTS, { now: NOW });

    output.cloudRoasts.forEach((roast, index) => {
      const source = PARSED_EXPORTS[index % PARSED_EXPORTS.length].summary;
      const summary = roast.summary as {
        development_time_percent: number;
        development_time_seconds: number;
        total_roast_seconds: number;
        metrics: {
          bean_ror_c_per_min: number;
          env_ror_c_per_min: number;
          bean_temp_delta_60s_c: number;
          env_temp_delta_60s_c: number;
          roast_elapsed_seconds: number;
        };
        started_at_utc: string;
        beans_added_at_utc: string;
        first_crack_at_utc: string;
        beans_dropped_at_utc: string;
      };
      expect(summary.development_time_percent).toBe(source.development_time_percent);
      expect(summary.development_time_seconds).toBe(source.development_time_seconds);
      expect(summary.total_roast_seconds).toBe(source.total_roast_seconds);
      expect(summary.metrics).toEqual(source.metrics);
      expect(summary.started_at_utc).not.toBe(source.started_at_utc);
      expect(Date.parse(summary.started_at_utc)).toBe(Date.parse(roast.roasted_at_utc!));
      expect(intervalMicroseconds(
        summary.beans_added_at_utc,
        summary.first_crack_at_utc,
      )).toBe(intervalMicroseconds(
        source.beans_added_at_utc,
        source.first_crack_at_utc,
      ));
      expect(intervalMicroseconds(
        summary.started_at_utc,
        summary.first_crack_at_utc,
      )).toBe(intervalMicroseconds(
        source.started_at_utc,
        source.first_crack_at_utc,
      ));
      expect(intervalMicroseconds(
        summary.started_at_utc,
        summary.beans_dropped_at_utc,
      )).toBe(intervalMicroseconds(
        source.started_at_utc,
        source.beans_dropped_at_utc,
      ));
    });
  });

  it("reconciles every roast and review bidirectionally with its summary", () => {
    const output = generate(PARSED_EXPORTS, { now: NOW });
    const summaries = new Map(output.referenceRoastSummaries.map((summary) => [
      logicalKey(summary.bean_origin, summary.roast_level),
      summary,
    ]));

    for (const roast of output.cloudRoasts) {
      expect(summaries.has(logicalKey(roast.bean_origin, roast.roast_level))).toBe(true);
    }
    for (const summary of output.referenceRoastSummaries) {
      const roasts = output.cloudRoasts.filter((roast) =>
        roast.bean_origin === summary.bean_origin &&
        roast.roast_level === summary.roast_level &&
        roast.contributed_to_learning,
      );
      const roastIds = new Set(roasts.map((roast) => roast.id));
      const reviews = output.tastingReviews.filter((review) =>
        roastIds.has(review.roast_id));
      expect(summary.roast_count).toBe(roasts.length);
      expect(summary.review_count).toBe(reviews.length);
      expect(summary.avg_rating).toBe(
        reviews.reduce((total, review) => total + review.score, 0) / reviews.length,
      );
    }
  });

  it("constructs telemetry raw variants from the closed synthetic shape", () => {
    const output = generate(PARSED_EXPORTS, { now: NOW });

    for (const row of output.roastTelemetry) {
      expect(row.raw).not.toBeNull();
      const raw = row.raw as Record<string, unknown>;
      expect(Object.keys(raw).sort()).toEqual(RAW_KEYS);
      expect(raw.source).toBe("synthetic");
      for (const key of RAW_KEYS.filter((key) => key !== "source")) {
        expect(typeof raw[key]).toBe("number");
      }
      expect(raw).not.toHaveProperty("recorded_at_utc");
      expect(raw).not.toHaveProperty("session_id");
      expect(raw).not.toHaveProperty("type");
    }
  });

  it("constructs cloud summaries from the closed proc-compatible shape", () => {
    const output = generate(PARSED_EXPORTS, { now: NOW });

    for (const roast of output.cloudRoasts) {
      const summary = roast.summary as Record<string, unknown>;
      expect(Object.keys(summary).sort()).toEqual(SUMMARY_KEYS);
      for (const key of SUMMARY_KEYS) {
        if (SUMMARY_ISO_KEYS.has(key)) {
          expect(typeof summary[key]).toBe("string");
          expect(Number.isNaN(Date.parse(summary[key] as string))).toBe(false);
        } else if (key !== "metrics" && key !== "first_crack_model") {
          expect(typeof summary[key]).toBe("number");
        }
      }
      const metrics = summary.metrics as Record<string, unknown>;
      expect(Object.keys(metrics).sort()).toEqual(SUMMARY_METRIC_KEYS);
      for (const key of SUMMARY_METRIC_KEYS) {
        expect(typeof metrics[key]).toBe("number");
      }
      const model = summary.first_crack_model as Record<string, unknown>;
      expect(Object.keys(model).sort()).toEqual(SUMMARY_MODEL_KEYS);
      for (const key of SUMMARY_MODEL_KEYS) {
        expect(typeof model[key]).toBe("number");
      }
      expect(summary).toHaveProperty("beans_added_at_utc");
      expect(summary).toHaveProperty("first_crack_at_utc");
      expect(summary).not.toHaveProperty("session_id");
      expect(summary).not.toHaveProperty("roaster_driver");
      expect(summary).not.toHaveProperty("first_crack_confidence");
    }
  });

  it("is byte-identical for the same exports and generation time", () => {
    const first = generate(PARSED_EXPORTS, { now: NOW });
    const second = generate(PARSED_EXPORTS, { now: NOW });

    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("generates valid parent ids and wires every child to one", () => {
    expect(synthCloudRoastId(createSeededRng(42))).toMatch(CLOUD_ROAST_ID_PATTERN);
    const output = generate(PARSED_EXPORTS, { now: NOW });
    const roastIds = new Set(output.cloudRoasts.map((roast) => roast.id));

    expect(output.cloudRoasts.every((roast) =>
      typeof roast.id === "string" && CLOUD_ROAST_ID_PATTERN.test(roast.id),
    )).toBe(true);
    expect([
      ...output.roastTelemetry,
      ...output.roastArtifacts,
      ...output.tastingReviews,
    ].every((child) => roastIds.has(child.roast_id))).toBe(true);
    for (const artifact of output.roastArtifacts) {
      const roast = output.cloudRoasts.find((row) => row.id === artifact.roast_id);
      if (roast === undefined) throw new Error("Expected artifact parent roast");
      expect(roast.idempotency_key).not.toBe(roast.id);
      expect(artifact.stage_path).toBe(`${roast.idempotency_key}/${artifact.kind}`);
      expect(artifact.stage_path.startsWith("@")).toBe(false);
    }
  });
});
