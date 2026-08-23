import { describe, expect, it } from "vitest";
import type { SeedOutput, Violation } from "../scripts/seed/rules";
import { validateSeedOutput, validateSeedRow } from "../scripts/seed/rules";

const ROAST_ID_ONE = "11111111-1111-1111-1111-111111111111";
const ROAST_ID_TWO = "22222222-2222-2222-2222-222222222222";

function validOutput(): SeedOutput {
  return {
    cloudRoasts: [{
      id: ROAST_ID_ONE, idempotency_key: "idem-1", owner_id: null,
      public_slug: "ABCDEFGHJKLMNPQRS", visibility: "unlisted",
      bean_origin: "Test Origin", bean_varietal: null, bean_weight_g: 100,
      profile_name: null, roast_level: "medium", summary: {},
      operator_rating: 4, operator_notes: null, contributed_to_learning: true,
      roasted_at_utc: null, created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    }],
    roastTelemetry: [{
      roast_id: ROAST_ID_ONE, elapsed_s: 0, bean_temp_c: 20, env_temp_c: null,
      heat_percent: 50, fan_percent: 40, ror_c_per_min: null, raw: null,
    }],
    roastArtifacts: [{
      id: "artifact-1", roast_id: ROAST_ID_ONE, kind: "jsonl",
      stage_path: "@roast_artifacts/run-1/jsonl", byte_size: 10,
      created_at: "2026-01-01T00:00:00Z",
    }],
    tastingReviews: [{
      id: "review-1", roast_id: ROAST_ID_ONE, reviewer_name: null, score: 4,
      aroma: 50, acidity: 50, sweetness: 50, body: 50, aftertaste: 50,
      brew_method: null, notes: null, submitted_ip_hash: null,
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

function expectField(output: SeedOutput, field: string, now?: number): Violation {
  const violation = validateSeedOutput(output, now).find((item) => item.field === field);
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

  it("reports missing fields without throwing for a non-object row", () => {
    const violations = validateSeedRow("cloud_roasts", "not-an-object");
    expect(violations.map((violation) => violation.field)).toEqual([
      "idempotency_key",
      "public_slug",
      "visibility",
      "summary",
      "contributed_to_learning",
      "created_at",
      "updated_at",
    ]);
    expect(violations.every((violation) => violation.rowIdentity === "unknown"))
      .toBe(true);
  });

  it("rejects an explicit cloud id that is not a delete_roast UUID", () => {
    const row = { ...validOutput().cloudRoasts[0], id: "roast-1" };
    expect(validateSeedRow("cloud_roasts", row).some((item) => item.field === "id"))
      .toBe(true);
  });

  it("accepts a lowercase UUID cloud id", () => {
    const row = { ...validOutput().cloudRoasts[0], id: ROAST_ID_ONE };
    expect(validateSeedRow("cloud_roasts", row).some((item) => item.field === "id"))
      .toBe(false);
  });

  it("allows a null cloud id for database assignment", () => {
    const row = { ...validOutput().cloudRoasts[0], id: null };
    expect(validateSeedRow("cloud_roasts", row).some((item) => item.field === "id"))
      .toBe(false);
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
    output.cloudRoasts.push({ ...output.cloudRoasts[0], id: ROAST_ID_TWO });
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

  it("rejects a non-string slug without entering uniqueness tracking", () => {
    const output = validOutput();
    (output.cloudRoasts[0] as unknown as { public_slug: unknown }).public_slug = 42;
    expectField(output, "public_slug");
  });

  it("rejects a telemetry temperature key with an *_f suffix", () => {
    const output = validOutput();
    Object.assign(output.roastTelemetry[0], { bean_temp_f: 400 });
    expectField(output, "bean_temp_f");
  });

  it("rejects a capitalised top-level telemetry *_F key", () => {
    const output = validOutput();
    Object.assign(output.roastTelemetry[0], { bean_temp_F: 400 });
    expectField(output, "bean_temp_F");
  });

  it("rejects a nested cloud summary key with an *_f suffix", () => {
    const output = validOutput();
    output.cloudRoasts[0].summary = { profile: { bean_temp_f: 400 } };
    expectField(output, "summary.profile.bean_temp_f");
  });

  it("rejects a nested telemetry raw key with an *_f suffix", () => {
    const output = validOutput();
    output.roastTelemetry[0].raw = { samples: [{ env_temp_f: 390 }] };
    expectField(output, "raw.samples[0].env_temp_f");
  });

  it("rejects a camelCase Fahrenheit key in a cloud summary", () => {
    const output = validOutput();
    output.cloudRoasts[0].summary = { beanTempF: 400 };
    expectField(output, "summary.beanTempF");
  });

  it("rejects a camelCase Fahrenheit key in telemetry raw", () => {
    const output = validOutput();
    output.roastTelemetry[0].raw = { temperatureF: 390 };
    expectField(output, "raw.temperatureF");
  });

  it("rejects a case-insensitive nested key containing fahrenheit", () => {
    const output = validOutput();
    output.cloudRoasts[0].summary = { notes: { FahrenheitReading: 400 } };
    expectField(output, "summary.notes.FahrenheitReading");
  });

  it("accepts clean nested Celsius variant payloads", () => {
    const output = validOutput();
    output.cloudRoasts[0].summary = { notes: { beanTempC: 200 } };
    output.roastTelemetry[0].raw = { samples: [{ temperature_c: 190 }] };
    expect(validateSeedOutput(output)).toEqual([]);
  });

  it("rejects an IP-named key carrying a non-null value", () => {
    const output = validOutput();
    output.roastTelemetry[0].raw = { ip_address: "192.168.1.20" };
    expectField(output, "raw.ip_address");
  });

  it("rejects a nested raw IPv4 string value", () => {
    const output = validOutput();
    output.cloudRoasts[0].summary = { notes: { source: "10.0.0.5" } };
    expectField(output, "summary.notes.source");
  });

  it("rejects a nested raw IPv6 string value", () => {
    const output = validOutput();
    output.roastTelemetry[0].raw = { metadata: { source: "2001:db8::1" } };
    expectField(output, "raw.metadata.source");
  });

  it("accepts a benign three-part version string", () => {
    const output = validOutput();
    output.cloudRoasts[0].summary = { notes: { version: "1.2.3" } };
    expect(validateSeedOutput(output)).toEqual([]);
  });

  it("accepts a null value under an IP-named key", () => {
    const output = validOutput();
    output.roastTelemetry[0].raw = { ip: null, label: "synthetic" };
    expect(validateSeedOutput(output)).toEqual([]);
  });

  it("rejects an unsupported artifact kind", () => {
    const output = validOutput();
    output.roastArtifacts[0].kind = "png";
    expectField(output, "kind");
  });

  it("rejects an empty artifact stage path", () => {
    const output = validOutput();
    output.roastArtifacts[0].stage_path = "";
    expectField(output, "stage_path");
  });

  it("rejects a non-string artifact stage path", () => {
    const output = validOutput();
    output.roastArtifacts[0].stage_path = 42 as unknown as string;
    expectField(output, "stage_path");
  });

  it("accepts any non-empty artifact stage path pending the C3 contract", () => {
    const output = validOutput();
    output.roastArtifacts[0].stage_path = "run-1/arbitrary-name.bin";
    expectNoField(output, "stage_path");
  });

  it("rejects a raw IP in submitted_ip_hash", () => {
    const output = validOutput();
    output.tastingReviews[0].submitted_ip_hash = "192.168.0.1";
    expectField(output, "submitted_ip_hash", Date.parse("2026-01-02T00:00:00Z"));
  });

  it("rejects an unpurged IP hash 31 days after review creation", () => {
    const now = Date.parse("2026-03-15T00:00:00Z");
    const output = validOutput();
    output.tastingReviews[0].submitted_ip_hash = "a".repeat(64);
    output.tastingReviews[0].created_at =
      new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
    expectField(output, "submitted_ip_hash", now);
  });

  it("allows a null hash on a review older than 30 days", () => {
    const now = Date.parse("2026-03-15T00:00:00Z");
    const output = validOutput();
    output.tastingReviews[0].submitted_ip_hash = null;
    output.tastingReviews[0].created_at =
      new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
    expect(validateSeedOutput(output, now)).toEqual([]);
  });

  it("allows an IP hash 29 days after review creation", () => {
    const now = Date.parse("2026-03-15T00:00:00Z");
    const output = validOutput();
    output.tastingReviews[0].submitted_ip_hash = "a".repeat(64);
    output.tastingReviews[0].created_at =
      new Date(now - 29 * 24 * 60 * 60 * 1000).toISOString();
    expect(validateSeedOutput(output, now)).toEqual([]);
  });

  it("rejects an unpurged IP hash at exactly 30 days", () => {
    const now = Date.parse("2026-03-15T00:00:00Z");
    const output = validOutput();
    output.tastingReviews[0].submitted_ip_hash = "a".repeat(64);
    output.tastingReviews[0].created_at =
      new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    expectField(output, "submitted_ip_hash", now);
  });

  it("does not crash or apply retention to an unparseable created_at", () => {
    const output = validOutput();
    output.tastingReviews[0].submitted_ip_hash = "a".repeat(64);
    output.tastingReviews[0].created_at = "not-a-timestamp";
    expect(validateSeedOutput(output, Date.parse("2026-03-15T00:00:00Z")))
      .toEqual([]);
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

  it("accepts the authoritative empty key_patterns array", () => {
    const output = validOutput();
    output.referenceRoastSummaries[0].key_patterns = [];
    expectNoField(output, "key_patterns");
  });

  it("allows null key_patterns for the database default", () => {
    const output = validOutput();
    output.referenceRoastSummaries[0].key_patterns = null;
    expectNoField(output, "key_patterns");
  });

  it("rejects non-empty key_patterns", () => {
    const output = validOutput();
    output.referenceRoastSummaries[0].key_patterns = [{ x: 1 }];
    expectField(output, "key_patterns");
  });

  it("rejects non-array key_patterns", () => {
    const output = validOutput();
    output.referenceRoastSummaries[0].key_patterns = "not-an-array";
    expectField(output, "key_patterns");
  });

  it("rejects a duplicate reference-summary logical key", () => {
    const output = validOutput();
    output.referenceRoastSummaries.push({
      ...output.referenceRoastSummaries[0],
      id: "summary-2",
    });
    expectField(output, "bean_origin|roast_level");
  });

  it("rejects duplicate explicit cloud roast ids", () => {
    const output = validOutput();
    output.cloudRoasts.push({
      ...output.cloudRoasts[0],
      idempotency_key: "idem-2",
      public_slug: "TUVWXYZabcdefghijk",
      contributed_to_learning: false,
    });
    expectField(output, "id");
  });

  it("rejects duplicate public slugs across cloud roasts", () => {
    const output = validOutput();
    output.cloudRoasts[0].id = null;
    output.roastTelemetry = [];
    output.roastArtifacts = [];
    output.tastingReviews = [];
    output.cloudRoasts.push({
      ...output.cloudRoasts[0],
      id: null,
      idempotency_key: "idem-2",
      contributed_to_learning: false,
    });
    expect(expectField(output, "public_slug").rowIdentity).toBe("idem-2");
  });

  it("accepts distinct public slugs across cloud roasts", () => {
    const output = validOutput();
    output.cloudRoasts.push({
      ...output.cloudRoasts[0],
      id: ROAST_ID_TWO,
      idempotency_key: "idem-2",
      public_slug: "TUVWXYZabcdefghijk",
      contributed_to_learning: false,
    });
    expectNoField(output, "public_slug");
  });

  it("accepts distinct and null explicit ids", () => {
    const output = validOutput();
    output.cloudRoasts.push(
      {
        ...output.cloudRoasts[0],
        id: ROAST_ID_TWO,
        idempotency_key: "idem-2",
        public_slug: "TUVWXYZabcdefghijk",
        contributed_to_learning: false,
      },
      {
        ...output.cloudRoasts[0],
        id: null,
        idempotency_key: "idem-3",
        public_slug: "mnopqrstuvwxyz12345",
        contributed_to_learning: false,
      },
    );
    expectNoField(output, "id");
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
      id: ROAST_ID_TWO,
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
      id: ROAST_ID_TWO,
      idempotency_key: "idem-2",
      public_slug: "TUVWXYZabcdefghijk",
      contributed_to_learning: false,
    });
    output.referenceRoastSummaries[0].roast_count = 2;
    expectField(output, "roast_count");
  });
});
