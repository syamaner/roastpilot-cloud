import { isValidSlug } from "../../lib/slug";
import type {
  CloudRoastRow,
  ReferenceRoastSummaryRow,
  RoastArtifactRow,
  RoastTelemetryRow,
  TastingReviewRow,
} from "./types";

export const SCORE_RANGE = { min: 1, max: 5 } as const;
export const OPERATOR_RATING_RANGE = { min: 1, max: 5 } as const;
export const SLIDER_RANGE = { min: 0, max: 100 } as const;
export const VISIBILITY_VALUES = ["private", "unlisted", "public"] as const;
export const ARTIFACT_KINDS = ["jsonl", "csv", "summary"] as const;
export const IP_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

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
const STAGE_PATH_PATTERN = new RegExp(
  `^@roast_artifacts/([^/]+)/(${ARTIFACT_KINDS.join("|")})$`,
);

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

export function validateSeedRow(table: SeedTable, row: unknown): Violation[] {
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

  if (table === "cloud_roasts") {
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
  }

  if (table === "roast_telemetry") {
    for (const field of Object.keys(value)) {
      if (field.endsWith("_" + "f")) {
        add(field, "temperature keys must use Celsius naming");
      }
    }
  }

  if (table === "roast_artifacts") {
    if (value.kind !== null && value.kind !== undefined &&
        (typeof value.kind !== "string" ||
          !(ARTIFACT_KINDS as readonly string[]).includes(value.kind))) {
      add("kind", "must be an allowed artifact kind");
    }
    if (value.stage_path !== null && value.stage_path !== undefined) {
      if (typeof value.stage_path !== "string") {
        add("stage_path", "must match the artifact stage path shape");
        return violations;
      }
      const match = STAGE_PATH_PATTERN.exec(value.stage_path);
      if (!match) {
        add("stage_path", "must match the artifact stage path shape");
      } else if (match[1] === value.roast_id) {
        add("stage_path", "run id must differ from roast id");
      }
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
  }

  return violations;
}

export function validateSeedOutput(output: SeedOutput): Violation[] {
  const violations = [
    ...output.cloudRoasts.flatMap((row) => validateSeedRow("cloud_roasts", row)),
    ...output.roastTelemetry.flatMap((row) => validateSeedRow("roast_telemetry", row)),
    ...output.roastArtifacts.flatMap((row) => validateSeedRow("roast_artifacts", row)),
    ...output.tastingReviews.flatMap((row) => validateSeedRow("tasting_reviews", row)),
    ...output.referenceRoastSummaries.flatMap((row) =>
      validateSeedRow("reference_roast_summaries", row)),
  ];

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

  for (const summary of output.referenceRoastSummaries) {
    const actual = output.cloudRoasts.filter(
      (roast) => roast.bean_origin === summary.bean_origin &&
        roast.roast_level === summary.roast_level &&
        roast.contributed_to_learning === true,
    ).length;
    if (summary.roast_count !== actual) {
      violations.push({
        table: "reference_roast_summaries",
        rowIdentity: `${summary.bean_origin}|${summary.roast_level}`,
        field: "roast_count", rule: "must equal the matching cloud roast count",
      });
    }
  }
  return violations;
}
