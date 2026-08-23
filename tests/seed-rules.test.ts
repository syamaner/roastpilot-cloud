import { describe, expect, it } from "vitest";
import type { SeedOutput, Violation } from "../scripts/seed/rules";
import { validateSeedOutput } from "../scripts/seed/rules";

function validOutput(): SeedOutput {
  return {
    cloudRoasts: [{
      id: "roast-1", idempotency_key: "idem-1", owner_id: null,
      public_slug: "ABCDEFGHJKLMNPQRS", visibility: "unlisted",
      bean_origin: "Test Origin", bean_varietal: null, bean_weight_g: 100,
      profile_name: null, roast_level: "medium", summary: {},
      operator_rating: 4, operator_notes: null, contributed_to_learning: true,
      roasted_at_utc: null, created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    }],
    roastTelemetry: [{
      roast_id: "roast-1", elapsed_s: 0, bean_temp_c: 20, env_temp_c: null,
      heat_percent: 50, fan_percent: 40, ror_c_per_min: null, raw: null,
    }],
    roastArtifacts: [{
      id: "artifact-1", roast_id: "roast-1", kind: "jsonl",
      stage_path: "@roast_artifacts/run-1/jsonl", byte_size: 10,
      created_at: "2026-01-01T00:00:00Z",
    }],
    tastingReviews: [{
      id: "review-1", roast_id: "roast-1", reviewer_name: null, score: 4,
      aroma: 50, acidity: 50, sweetness: 50, body: 50, aftertaste: 50,
      brew_method: null, notes: null, submitted_ip_hash: "a".repeat(64),
      created_at: "2026-01-01T00:00:00Z",
    }],
    referenceRoastSummaries: [{
      id: "summary-1", bean_origin: "Test Origin", roast_level: "medium",
      roast_count: 1, review_count: 1, avg_rating: 4,
      first_crack_temp_avg_c: 190, first_crack_temp_stddev_c: null,
      drop_temp_avg_c: 210, drop_temp_stddev_c: null,
      development_percent_avg: 20, first_crack_time_avg_s: 480,
      total_time_avg_s: 600, key_patterns: [],
      updated_at: "2026-01-01T00:00:00Z",
    }],
  };
}

function expectField(output: SeedOutput, field: string): Violation {
  const violation = validateSeedOutput(output).find((item) => item.field === field);
  expect(violation, `expected a violation for ${field}`).toBeDefined();
  return violation!;
}

function expectNoField(output: SeedOutput, field: string): void {
  expect(validateSeedOutput(output).some((item) => item.field === field)).toBe(false);
}

describe("validateSeedOutput", () => {
  it("accepts a fully valid output", () => {
    expect(validateSeedOutput(validOutput())).toEqual([]);
  });

  it.each([0, 6])("rejects score %s", (score) => {
    const output = validOutput();
    output.tastingReviews[0].score = score;
    expectField(output, "score");
  });

  it.each([1, 5])("accepts score boundary %s", (score) => {
    const output = validOutput();
    output.tastingReviews[0].score = score;
    expectNoField(output, "score");
  });

  it("rejects a fractional score", () => {
    const output = validOutput();
    output.tastingReviews[0].score = 3.5;
    expectField(output, "score");
  });

  it.each([0, 6])("rejects operator_rating %s", (rating) => {
    const output = validOutput();
    output.cloudRoasts[0].operator_rating = rating;
    expectField(output, "operator_rating");
  });

  it.each([1, 5])("accepts operator_rating boundary %s", (rating) => {
    const output = validOutput();
    output.cloudRoasts[0].operator_rating = rating;
    expectNoField(output, "operator_rating");
  });

  it.each(["aroma", "acidity", "sweetness", "body", "aftertaste"] as const)(
    "rejects %s outside its range at either boundary",
    (field) => {
      for (const invalid of [-1, 101]) {
        const output = validOutput();
        output.tastingReviews[0][field] = invalid;
        expectField(output, field);
      }
    },
  );

  it.each(["aroma", "acidity", "sweetness", "body", "aftertaste"] as const)(
    "accepts %s at both range boundaries",
    (field) => {
      for (const boundary of [0, 100]) {
        const output = validOutput();
        output.tastingReviews[0][field] = boundary;
        expectNoField(output, field);
      }
    },
  );

  it("rejects a fractional slider", () => {
    const output = validOutput();
    output.tastingReviews[0].aroma = 50.5;
    expectField(output, "aroma");
  });

  it.each(["deleted", ""])("rejects visibility %j", (visibility) => {
    const output = validOutput();
    output.cloudRoasts[0].visibility = visibility;
    expectField(output, "visibility");
  });

  it("rejects duplicate idempotency keys across cloud roasts", () => {
    const output = validOutput();
    output.cloudRoasts.push({ ...output.cloudRoasts[0], id: "roast-2" });
    expectField(output, "idempotency_key");
  });

  it("rejects telemetry that references an unknown roast", () => {
    const output = validOutput();
    output.roastTelemetry[0].roast_id = "missing-roast";
    expectField(output, "roast_id");
  });

  it("rejects an artifact that references an unknown roast", () => {
    const output = validOutput();
    output.roastArtifacts[0].roast_id = "missing-roast";
    expectField(output, "roast_id");
  });

  it("rejects a review that references an unknown roast", () => {
    const output = validOutput();
    output.tastingReviews[0].roast_id = "missing-roast";
    expectField(output, "roast_id");
  });

  it("rejects a 16-character slug", () => {
    const output = validOutput();
    output.cloudRoasts[0].public_slug = "A".repeat(16);
    expectField(output, "public_slug");
  });

  it("rejects a telemetry temperature key with an *_f suffix", () => {
    const output = validOutput();
    Object.assign(output.roastTelemetry[0], { bean_temp_f: 400 });
    expectField(output, "bean_temp_f");
  });

  it("rejects an unsupported artifact kind", () => {
    const output = validOutput();
    output.roastArtifacts[0].kind = "png";
    expectField(output, "kind");
  });

  it("rejects an artifact stage path with a bad shape", () => {
    const output = validOutput();
    output.roastArtifacts[0].stage_path = "@roast_artifacts/run-1/jsonl/file";
    expectField(output, "stage_path");
  });

  it("rejects a non-string artifact stage path", () => {
    const output = validOutput();
    output.roastArtifacts[0].stage_path = 42 as unknown as string;
    expectField(output, "stage_path");
  });

  it("rejects an artifact stage path whose run id equals its roast id", () => {
    const output = validOutput();
    output.roastArtifacts[0].stage_path = "@roast_artifacts/roast-1/jsonl";
    expectField(output, "stage_path");
  });

  it("rejects a raw IP in submitted_ip_hash", () => {
    const output = validOutput();
    output.tastingReviews[0].submitted_ip_hash = "192.168.0.1";
    expectField(output, "submitted_ip_hash");
  });

  it("rejects a missing NOT NULL column", () => {
    const output = validOutput();
    delete (output.roastArtifacts[0] as Partial<typeof output.roastArtifacts[0]>).kind;
    expectField(output, "kind");
  });

  it("rejects a summary roast count that disagrees with cloud roasts", () => {
    const output = validOutput();
    output.referenceRoastSummaries[0].roast_count = 2;
    expectField(output, "roast_count");
  });

  it("rejects a duplicate reference-summary logical key", () => {
    const output = validOutput();
    output.referenceRoastSummaries.push({
      ...output.referenceRoastSummaries[0],
      id: "summary-2",
    });
    expectField(output, "bean_origin|roast_level");
  });

  it("accepts distinct reference-summary logical keys", () => {
    const output = validOutput();
    output.referenceRoastSummaries.push({
      ...output.referenceRoastSummaries[0],
      id: "summary-2",
      bean_origin: "Other Test Origin",
      roast_count: 0,
    });
    expect(validateSeedOutput(output)).toEqual([]);
  });

  it("counts only contributing roasts in reference summaries", () => {
    const output = validOutput();
    output.cloudRoasts.push({
      ...output.cloudRoasts[0],
      id: "roast-2",
      idempotency_key: "idem-2",
      public_slug: "TUVWXYZabcdefghijk",
      contributed_to_learning: false,
    });
    expect(validateSeedOutput(output)).toEqual([]);
  });

  it("rejects a summary count that includes a non-contributing roast", () => {
    const output = validOutput();
    output.cloudRoasts.push({
      ...output.cloudRoasts[0],
      id: "roast-2",
      idempotency_key: "idem-2",
      public_slug: "TUVWXYZabcdefghijk",
      contributed_to_learning: false,
    });
    output.referenceRoastSummaries[0].roast_count = 2;
    expectField(output, "roast_count");
  });
});
