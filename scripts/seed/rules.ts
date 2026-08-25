import { isIP } from "node:net";
import { isValidSlug } from "../../lib/slug.ts";
import type {
  CloudRoastRow,
  ReferenceRoastSummaryRow,
  RoastArtifactRow,
  RoastTelemetryRow,
  TastingReviewRow,
} from "./types.ts";

export const SCORE_RANGE = { min: 1, max: 5 } as const;
export const OPERATOR_RATING_RANGE = { min: 1, max: 5 } as const;
export const SLIDER_RANGE = { min: 0, max: 100 } as const;
export const VISIBILITY_VALUES = ["private", "unlisted", "public"] as const;
export const ARTIFACT_KINDS = ["jsonl", "csv", "summary"] as const;
export const IP_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

export const CLOUD_ROAST_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IP_RETENTION_DAYS = 30;
const RAW_IP_KEY_NAMES = new Set([
  "ip",
  "ipaddr",
  "ipaddress",
  "ip_address",
  "client_ip",
  "remote_ip",
  "remote_addr",
]);
const IP_TOKEN_DELIMITER_PATTERN = /[\s_,;()\[\]{}<>"'`\/\\|]+/;

export interface SeedOutput {
  cloudRoasts: CloudRoastRow[];
  roastTelemetry: RoastTelemetryRow[];
  roastArtifacts: RoastArtifactRow[];
  tastingReviews: TastingReviewRow[];
  referenceRoastSummaries: ReferenceRoastSummaryRow[];
}

export type SeedTable =
  | "cloud_roasts"
  | "roast_telemetry"
  | "roast_artifacts"
  | "tasting_reviews"
  | "reference_roast_summaries";

export interface Violation {
  table: SeedTable;
  rowIdentity: string;
  field: string;
  rule: string;
}

const REQUIRED_FIELDS: Record<SeedTable, readonly string[]> = {
  cloud_roasts: [
    "idempotency_key", "public_slug", "visibility", "summary",
    "contributed_to_learning", "created_at", "updated_at",
  ],
  roast_telemetry: ["roast_id", "elapsed_s"],
  roast_artifacts: ["roast_id", "kind", "stage_path", "created_at"],
  tasting_reviews: ["roast_id", "score", "created_at"],
  reference_roast_summaries: [
    "bean_origin", "roast_level", "roast_count", "review_count", "updated_at",
  ],
};

const SLIDER_FIELDS = [
  "aroma", "acidity", "sweetness", "body", "aftertaste",
] as const;

function recordOf(row: unknown): Record<string, unknown> {
  return typeof row === "object" && row !== null
    ? (row as Record<string, unknown>)
    : {};
}

function identity(table: SeedTable, row: Record<string, unknown>): string {
  if (table === "reference_roast_summaries") {
    return `${String(row.bean_origin)}|${String(row.roast_level)}`;
  }
  return String(row.id ?? row.roast_id ?? row.idempotency_key ?? "unknown");
}

function inRange(value: unknown, range: { min: number; max: number }): boolean {
  return typeof value === "number" && Number.isInteger(value) &&
    value >= range.min && value <= range.max;
}

// This is a key-name heuristic only: source data and typed Celsius columns
// remain the real guarantee when a differently named key hides a Fahrenheit value.
function isFahrenheitKey(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return lowerKey.endsWith("_" + "f") ||
    lowerKey.includes("fahren" + "heit") ||
    (lowerKey.endsWith("f") && lowerKey.includes("temp"));
}

function nonCelsiusKeyPaths(payload: unknown, parentPath: string): string[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((item, index) =>
      nonCelsiusKeyPaths(item, `${parentPath}[${index}]`));
  }
  if (typeof payload !== "object" || payload === null) {
    return [];
  }

  return Object.entries(payload).flatMap(([key, nested]) => {
    const path = `${parentPath}.${key}`;
    const lowerKey = key.toLowerCase();
    const isFahrenheitUnit = lowerKey.endsWith("unit") &&
      typeof nested === "string" &&
      (nested.toLowerCase() === "f" || nested.toLowerCase() === "fahrenheit");
    return [
      ...(isFahrenheitKey(key) || isFahrenheitUnit ? [path] : []),
      ...nonCelsiusKeyPaths(nested, path),
    ];
  });
}

// Candidate extraction followed by strict IP parsing catches embedded literals
// without treating version-like strings as IPv4.
function rawIpPaths(payload: unknown, parentPath: string): string[] {
  if (Array.isArray(payload)) {
    return payload.flatMap((item, index) =>
      rawIpPaths(item, `${parentPath}[${index}]`));
  }
  if (typeof payload === "string") {
    return containsRawIp(payload) ? [parentPath] : [];
  }
  if (typeof payload !== "object" || payload === null) {
    return [];
  }

  return Object.entries(payload).flatMap(([key, nested]) => {
    const path = `${parentPath}.${key}`;
    const exposedByKey = RAW_IP_KEY_NAMES.has(key.toLowerCase()) && nested !== null;
    return [
      ...(exposedByKey ? [path] : []),
      ...rawIpPaths(nested, path),
    ];
  });
}

function containsRawIp(text: string): boolean {
  return text.split(IP_TOKEN_DELIMITER_PATTERN).some((token) =>
    isIP(token.replace(/^\.+|\.+$/g, "")) !== 0
  );
}

function finiteOrNull(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

function integerPercentOrNull(value: unknown): boolean {
  return value === null || (typeof value === "number" && Number.isInteger(value) &&
    value >= 0 && value <= 100);
}

function averageFinite(values: readonly unknown[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) {
    if (typeof value !== "number" || !Number.isFinite(value)) return Number.NaN;
    total += value;
  }
  return total / values.length;
}

function approximatelyEqualNullable(
  actual: unknown,
  expected: number | null,
): boolean {
  if (actual === null && expected === null) return true;
  return typeof actual === "number" && Number.isFinite(actual) &&
    typeof expected === "number" && Number.isFinite(expected) &&
    Math.abs(actual - expected) <= 1e-6;
}

export function validateSeedRow(
  table: SeedTable,
  row: unknown,
  now: number = Date.now(),
): Violation[] {
  const value = recordOf(row);
  const rowIdentity = identity(table, value);
  const violations: Violation[] = [];
  const add = (field: string, rule: string): void => {
    violations.push({ table, rowIdentity, field, rule });
  };

  for (const field of REQUIRED_FIELDS[table]) {
    if (!(field in value) || value[field] === null || value[field] === undefined) {
      add(field, "must be present and non-null");
    }
  }

  for (const [field, fieldValue] of Object.entries(value)) {
    if (typeof fieldValue === "string" && containsRawIp(fieldValue)) {
      add(field, "raw IP address must never appear; IPs are stored hashed");
    }
  }

  if (table === "cloud_roasts") {
    if (value.id !== null && value.id !== undefined &&
        (typeof value.id !== "string" || !CLOUD_ROAST_ID_PATTERN.test(value.id))) {
      add("id", "explicit cloud roast id must be a lowercase UUID for delete_roast");
    }
    if (value.operator_rating !== null && value.operator_rating !== undefined &&
        !inRange(value.operator_rating, OPERATOR_RATING_RANGE)) {
      add("operator_rating", "must be within the operator rating range");
    }
    if (value.visibility !== null && value.visibility !== undefined &&
        (typeof value.visibility !== "string" ||
          !(VISIBILITY_VALUES as readonly string[]).includes(value.visibility))) {
      add("visibility", "must be an allowed visibility");
    }
    if (value.public_slug !== null && value.public_slug !== undefined &&
        (typeof value.public_slug !== "string" || !isValidSlug(value.public_slug))) {
      add("public_slug", "must be a valid high-entropy base58 slug");
    }
    for (const path of nonCelsiusKeyPaths(value.summary, "summary")) {
      add(path, "variant keys must use Celsius naming");
    }
    for (const path of new Set(rawIpPaths(value.summary, "summary"))) {
      add(path, "raw IP address must never appear; IPs are stored hashed");
    }
  }

  if (table === "roast_telemetry") {
    if (typeof value.elapsed_s !== "number" || !Number.isFinite(value.elapsed_s) ||
        value.elapsed_s < 0) {
      add("elapsed_s", "must be a finite number greater than or equal to zero");
    }
    for (const field of ["bean_temp_c", "env_temp_c"] as const) {
      if (!finiteOrNull(value[field])) {
        add(field, "must be a finite number or null");
      }
    }
    for (const field of ["heat_percent", "fan_percent"] as const) {
      if (!integerPercentOrNull(value[field])) {
        add(field, "must be an integer from 0 to 100 or null");
      }
    }
    if (!finiteOrNull(value.ror_c_per_min)) {
      add("ror_c_per_min", "must be a finite number or null");
    }
    for (const field of Object.keys(value)) {
      if (isFahrenheitKey(field)) {
        add(field, "temperature keys must use Celsius naming");
      }
    }
    for (const path of nonCelsiusKeyPaths(value.raw, "raw")) {
      add(path, "variant keys must use Celsius naming");
    }
    for (const path of new Set(rawIpPaths(value.raw, "raw"))) {
      add(path, "raw IP address must never appear; IPs are stored hashed");
    }
  }

  if (table === "roast_artifacts") {
    if (value.kind !== null && value.kind !== undefined &&
        (typeof value.kind !== "string" ||
          !(ARTIFACT_KINDS as readonly string[]).includes(value.kind))) {
      add("kind", "must be an allowed artifact kind");
    }
    // Exact format belongs to C3's stage_path contract (#341 / D-314-F).
    // Slice 1 asserts only that a supplied path is a non-empty string.
    if (value.stage_path !== null && value.stage_path !== undefined &&
        (typeof value.stage_path !== "string" || value.stage_path.length === 0)) {
      add("stage_path", "must be a non-empty string");
    }
  }

  if (table === "tasting_reviews") {
    if (value.score !== null && value.score !== undefined &&
        !inRange(value.score, SCORE_RANGE)) {
      add("score", "must be within the score range");
    }
    for (const field of SLIDER_FIELDS) {
      const slider = value[field];
      if (slider !== null && slider !== undefined && !inRange(slider, SLIDER_RANGE)) {
        add(field, "must be within the slider range");
      }
    }
    const ipHash = value.submitted_ip_hash;
    if (ipHash !== null && ipHash !== undefined &&
        (typeof ipHash !== "string" || !IP_HASH_PATTERN.test(ipHash))) {
      add("submitted_ip_hash", "must be a 64-character hexadecimal hash");
    }
    if (ipHash !== null && ipHash !== undefined) {
      const createdAt = typeof value.created_at === "string"
        ? Date.parse(value.created_at)
        : Number.NaN;
      const retentionMs = IP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
      if (Number.isNaN(createdAt)) {
        add(
          "created_at",
          "an IP-hash row requires a valid parseable created_at within retention",
        );
      } else if (createdAt > now) {
        add(
          "created_at",
          "an IP-hash row requires created_at to be no later than now",
        );
      } else if (now - createdAt >= retentionMs) {
        add(
          "submitted_ip_hash",
          "unpurged IP hash past the 30-day retention window must be null",
        );
      }
    }
  }

  if (table === "reference_roast_summaries") {
    const keyPatterns = value.key_patterns;
    if (keyPatterns !== null && keyPatterns !== undefined &&
        (!Array.isArray(keyPatterns) || keyPatterns.length !== 0)) {
      add("key_patterns", "must be the authoritative empty array in C2");
    }
  }

  return violations;
}

export function validateSeedOutput(
  output: SeedOutput,
  now: number = Date.now(),
): Violation[] {
  const violations = [
    ...output.cloudRoasts.flatMap((row) => validateSeedRow("cloud_roasts", row, now)),
    ...output.roastTelemetry.flatMap((row) =>
      validateSeedRow("roast_telemetry", row, now)),
    ...output.roastArtifacts.flatMap((row) =>
      validateSeedRow("roast_artifacts", row, now)),
    ...output.tastingReviews.flatMap((row) =>
      validateSeedRow("tasting_reviews", row, now)),
    ...output.referenceRoastSummaries.flatMap((row) =>
      validateSeedRow("reference_roast_summaries", row, now)),
  ];

  const roastIds = new Set(
    output.cloudRoasts.flatMap((row) =>
      typeof row.id === "string" ? [row.id] : []),
  );
  const childTables: readonly [
    SeedTable,
    readonly { roast_id: string }[],
  ][] = [
    ["roast_telemetry", output.roastTelemetry],
    ["roast_artifacts", output.roastArtifacts],
    ["tasting_reviews", output.tastingReviews],
  ];
  for (const [table, rows] of childTables) {
    for (const row of rows) {
      if (!roastIds.has(row.roast_id)) {
        violations.push({
          table,
          rowIdentity: identity(table, recordOf(row)),
          field: "roast_id",
          rule: "must reference a known cloud roast; orphan rows are forbidden",
        });
      }
    }
  }

  const idTables: readonly [
    SeedTable,
    readonly { id: string | null }[],
  ][] = [
    ["cloud_roasts", output.cloudRoasts],
    ["roast_artifacts", output.roastArtifacts],
    ["tasting_reviews", output.tastingReviews],
    ["reference_roast_summaries", output.referenceRoastSummaries],
  ];
  for (const [table, rows] of idTables) {
    const seenIds = new Set<string>();
    for (const row of rows) {
      if (typeof row.id === "string" && seenIds.has(row.id)) {
        violations.push({
          table,
          rowIdentity: row.id,
          field: "id",
          rule: "explicit primary-key id must be unique within its table",
        });
      }
      if (typeof row.id === "string") {
        seenIds.add(row.id);
      }
    }
  }

  const seenKeys = new Set<string>();
  for (const row of output.cloudRoasts) {
    if (seenKeys.has(row.idempotency_key)) {
      violations.push({
        table: "cloud_roasts", rowIdentity: row.idempotency_key,
        field: "idempotency_key", rule: "must be unique across cloud roasts",
      });
    }
    seenKeys.add(row.idempotency_key);
  }

  const seenSlugs = new Set<string>();
  for (const row of output.cloudRoasts) {
    if (typeof row.public_slug === "string" && seenSlugs.has(row.public_slug)) {
      violations.push({
        table: "cloud_roasts",
        rowIdentity: row.id ?? row.idempotency_key,
        field: "public_slug",
        rule: "must be unique across cloud roasts; duplicate slugs are forbidden",
      });
    }
    if (typeof row.public_slug === "string") {
      seenSlugs.add(row.public_slug);
    }
  }

  const summaryGroups = new Map<string, string>();
  for (const summary of output.referenceRoastSummaries) {
    const key = JSON.stringify([summary.bean_origin, summary.roast_level]);
    const rowIdentity = `${summary.bean_origin}|${summary.roast_level}`;
    if (summaryGroups.has(key)) {
      violations.push({
        table: "reference_roast_summaries",
        rowIdentity,
        field: "bean_origin|roast_level",
        rule: "must be a unique reference-summary logical key",
      });
    }
    summaryGroups.set(key, rowIdentity);
  }

  const contributingGroups = new Map<string, string>();
  for (const roast of output.cloudRoasts) {
    if (roast.contributed_to_learning !== true) continue;
    const key = JSON.stringify([roast.bean_origin, roast.roast_level]);
    contributingGroups.set(key, `${roast.bean_origin}|${roast.roast_level}`);
  }
  for (const [key, rowIdentity] of contributingGroups) {
    if (!summaryGroups.has(key)) {
      violations.push({
        table: "reference_roast_summaries",
        rowIdentity,
        field: "bean_origin|roast_level",
        rule: "every contributing roast group must have a reference summary",
      });
    }
  }
  for (const [key, rowIdentity] of summaryGroups) {
    if (!contributingGroups.has(key)) {
      violations.push({
        table: "reference_roast_summaries",
        rowIdentity,
        field: "bean_origin|roast_level",
        rule: "reference summary has no contributing roasts",
      });
    }
  }

  for (const summary of output.referenceRoastSummaries) {
    const contributingRoasts = output.cloudRoasts.filter(
      (roast) => roast.bean_origin === summary.bean_origin &&
        roast.roast_level === summary.roast_level &&
        roast.contributed_to_learning === true,
    );
    const contributingRoastIds = new Set(
      contributingRoasts.flatMap((roast) =>
        typeof roast.id === "string" ? [roast.id] : []),
    );
    const reviews = output.tastingReviews.filter((review) =>
      contributingRoastIds.has(review.roast_id));
    const expectedAvgRating = reviews.length === 0
      ? null
      : reviews.reduce((total, review) => total + review.score, 0) / reviews.length;
    const summaryVariants = contributingRoasts.map((roast) => recordOf(roast.summary));
    const expectedDevelopmentPercent = averageFinite(
      summaryVariants.map((variant) => variant.development_time_percent),
    );
    const expectedFirstCrackTime = averageFinite(summaryVariants.map((variant) => {
      const firstCrack = typeof variant.first_crack_at_utc === "string"
        ? Date.parse(variant.first_crack_at_utc)
        : Number.NaN;
      const beansAdded = typeof variant.beans_added_at_utc === "string"
        ? Date.parse(variant.beans_added_at_utc)
        : Number.NaN;
      return (firstCrack - beansAdded) / 1_000;
    }));
    const expectedTotalTime = averageFinite(
      summaryVariants.map((variant) => variant.total_roast_seconds),
    );
    const rowIdentity = `${summary.bean_origin}|${summary.roast_level}`;

    if (summary.roast_count !== contributingRoasts.length) {
      violations.push({
        table: "reference_roast_summaries",
        rowIdentity,
        field: "roast_count", rule: "must equal the matching cloud roast count",
      });
    }
    if (summary.review_count !== reviews.length) {
      violations.push({
        table: "reference_roast_summaries",
        rowIdentity,
        field: "review_count",
        rule: "must equal the matching contributing-roast review count",
      });
    }
    if (summary.avg_rating !== expectedAvgRating) {
      violations.push({
        table: "reference_roast_summaries",
        rowIdentity,
        field: "avg_rating",
        rule: "must equal the matching contributing-roast mean review score",
      });
    }
    for (const [field, expected] of [
      ["development_percent_avg", expectedDevelopmentPercent],
      ["first_crack_time_avg_s", expectedFirstCrackTime],
      ["total_time_avg_s", expectedTotalTime],
    ] as const) {
      if (!approximatelyEqualNullable(summary[field], expected)) {
        violations.push({
          table: "reference_roast_summaries",
          rowIdentity,
          field,
          rule: "must equal the matching contributing-roast summary mean",
        });
      }
    }
  }
  return violations;
}
