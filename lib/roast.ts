/**
 * Typed reads from PUBLIC_WEB's two secure views.
 *
 * D-C4-2 deliberately uses two clocks: headline times start when beans are
 * charged, while the curve's elapsed seconds start when the session starts.
 */

import { z } from "zod";
import { executeStatement, type SqlApiResult } from "./sqlapi";

const ROAST_COLUMNS = [
  "public_slug",
  "bean_origin",
  "bean_varietal",
  "bean_weight_g",
  "profile_name",
  "roast_level",
  "roasted_at_utc",
  "created_at",
  "summary",
  "curve",
] as const;

const REVIEW_COLUMNS = [
  "public_slug",
  "reviewer_name",
  "score",
  "aroma",
  "acidity",
  "sweetness",
  "body",
  "aftertaste",
  "brew_method",
  "notes",
  "created_at",
] as const;

const ROAST_STATEMENT =
  "select public_slug,bean_origin,bean_varietal,bean_weight_g,profile_name,roast_level,roasted_at_utc,created_at,summary,curve from roast_by_slug where public_slug = :1";
const REVIEWS_STATEMENT =
  "select public_slug,reviewer_name,score,aroma,acidity,sweetness,body,aftertaste,brew_method,notes,created_at from reviews_by_roast where public_slug = :1 order by created_at desc";

const isoTimestamp = z.iso.datetime({ offset: true });
const numberCell = z
  .string()
  .refine((value) => value.trim() !== "")
  .transform(Number)
  .pipe(z.number().finite());
const nullableNumberCell = numberCell.nullable();

export const CurveSampleSchema = z.strictObject({
  elapsed_s: z.number().finite().nullable(),
  bean_temp_c: z.number().finite().nullable(),
  env_temp_c: z.number().finite().nullable(),
  heat_percent: z.number().finite().nullable(),
  fan_percent: z.number().finite().nullable(),
  ror_c_per_min: z.number().finite().nullable(),
});

export interface CurveSample {
  elapsed_s: number | null;
  bean_temp_c: number | null;
  env_temp_c: number | null;
  heat_percent: number | null;
  fan_percent: number | null;
  ror_c_per_min: number | null;
}

export const RoastSummarySchema = z.object({
  started_at_utc: isoTimestamp,
  first_crack_at_utc: isoTimestamp,
  beans_added_at_utc: isoTimestamp,
  beans_dropped_at_utc: isoTimestamp,
  total_roast_seconds: z.number().finite(),
  development_time_percent: z.number().finite(),
});

export interface RoastSummary {
  started_at_utc: string;
  first_crack_at_utc: string;
  beans_added_at_utc: string;
  beans_dropped_at_utc: string;
  total_roast_seconds: number;
  development_time_percent: number;
}

export const RoastViewRowSchema = z.strictObject({
  public_slug: z.string(),
  bean_origin: z.string().nullable(),
  bean_varietal: z.string().nullable(),
  bean_weight_g: nullableNumberCell,
  profile_name: z.string().nullable(),
  roast_level: z.string().nullable(),
  roasted_at_utc: z.string().nullable(),
  created_at: z.string(),
  summary: RoastSummarySchema,
  curve: z.array(CurveSampleSchema).nullable(),
});

export const ReviewViewRowSchema = z.strictObject({
  public_slug: z.string(),
  reviewer_name: z.string().nullable(),
  score: numberCell,
  aroma: nullableNumberCell,
  acidity: nullableNumberCell,
  sweetness: nullableNumberCell,
  body: nullableNumberCell,
  aftertaste: nullableNumberCell,
  brew_method: z.string().nullable(),
  notes: z.string().nullable(),
  created_at: z.string(),
});

export interface RoastStats {
  totalRoastSeconds: number;
  firstCrackSeconds: number;
  developmentTimePercent: number;
  firstCrackTempC: number | null;
}

export interface Roast {
  public_slug: string;
  bean_origin: string | null;
  bean_varietal: string | null;
  bean_weight_g: number | null;
  profile_name: string | null;
  roast_level: string | null;
  roasted_at_utc: string | null;
  created_at: string;
  summary: RoastSummary;
  curve: CurveSample[] | null;
  stats: RoastStats;
}

export interface Review {
  public_slug: string;
  reviewer_name: string | null;
  score: number;
  aroma: number | null;
  acidity: number | null;
  sweetness: number | null;
  body: number | null;
  aftertaste: number | null;
  brew_method: string | null;
  notes: string | null;
  created_at: string;
}

/** A bounded validation failure that never exposes result-cell contents. */
export class RoastSchemaError extends Error {
  constructor() {
    super("Roast read data did not match the expected schema.");
    this.name = "RoastSchemaError";
  }
}

function schemaError(): RoastSchemaError {
  return new RoastSchemaError();
}

function assertColumns(
  result: SqlApiResult,
  expected: readonly string[],
): void {
  const actual = result.columns.map((column) => column.name.toLowerCase());
  if (
    actual.length !== expected.length ||
    actual.some((name, index) => name !== expected[index])
  ) {
    throw schemaError();
  }
}

function assertRowCount(result: SqlApiResult): void {
  if (result.rowCount !== result.rows.length) throw schemaError();
}

function parseVariant<T>(cell: string, schema: z.ZodType<T>): T {
  let value: unknown;
  try {
    value = JSON.parse(cell);
  } catch {
    throw schemaError();
  }

  const parsed = schema.safeParse(value);
  if (!parsed.success) throw schemaError();
  return parsed.data;
}

function parseRoastRow(row: ReadonlyArray<string | null>): Roast {
  if (row.length !== ROAST_COLUMNS.length || row[8] === null) {
    throw schemaError();
  }

  const summary = parseVariant(row[8], RoastSummarySchema);
  const curve =
    row[9] === null
      ? null
      : parseVariant(row[9], z.array(CurveSampleSchema));
  const parsed = RoastViewRowSchema.safeParse({
    public_slug: row[0],
    bean_origin: row[1],
    bean_varietal: row[2],
    bean_weight_g: row[3],
    profile_name: row[4],
    roast_level: row[5],
    roasted_at_utc: row[6],
    created_at: row[7],
    summary,
    curve,
  });
  if (!parsed.success) throw schemaError();

  const firstCrackSeconds =
    (Date.parse(summary.first_crack_at_utc) -
      Date.parse(summary.beans_added_at_utc)) /
    1_000;
  if (!Number.isFinite(firstCrackSeconds)) throw schemaError();

  return {
    ...parsed.data,
    stats: {
      totalRoastSeconds: summary.total_roast_seconds,
      firstCrackSeconds,
      developmentTimePercent: summary.development_time_percent,
      firstCrackTempC: firstCrackTempC(curve, summary),
    },
  };
}

function parseReviewRow(row: ReadonlyArray<string | null>): Review {
  if (row.length !== REVIEW_COLUMNS.length) throw schemaError();
  const parsed = ReviewViewRowSchema.safeParse({
    public_slug: row[0],
    reviewer_name: row[1],
    score: row[2],
    aroma: row[3],
    acidity: row[4],
    sweetness: row[5],
    body: row[6],
    aftertaste: row[7],
    brew_method: row[8],
    notes: row[9],
    created_at: row[10],
  });
  if (!parsed.success) throw schemaError();
  return parsed.data;
}

/** Returns the nearest valid curve temperature on the session-start clock. */
export function firstCrackTempC(
  curve: CurveSample[] | null,
  summary: RoastSummary,
): number | null {
  if (curve === null || curve.length === 0) return null;

  const firstCrackElapsed =
    (Date.parse(summary.first_crack_at_utc) -
      Date.parse(summary.started_at_utc)) /
    1_000;
  if (!Number.isFinite(firstCrackElapsed)) return null;

  let nearest: { elapsed: number; temperature: number; distance: number } | null =
    null;
  for (const sample of curve) {
    if (
      typeof sample.elapsed_s !== "number" ||
      !Number.isFinite(sample.elapsed_s) ||
      typeof sample.bean_temp_c !== "number" ||
      !Number.isFinite(sample.bean_temp_c)
    ) {
      continue;
    }
    const distance = Math.abs(sample.elapsed_s - firstCrackElapsed);
    if (
      nearest === null ||
      distance < nearest.distance ||
      (distance === nearest.distance && sample.elapsed_s < nearest.elapsed)
    ) {
      nearest = {
        elapsed: sample.elapsed_s,
        temperature: sample.bean_temp_c,
        distance,
      };
    }
  }
  return nearest?.temperature ?? null;
}

function slugBinding(slug: string) {
  return { "1": { type: "TEXT", value: slug } };
}

export async function getRoastBySlug(slug: string): Promise<Roast | null> {
  const result = await executeStatement(ROAST_STATEMENT, slugBinding(slug));
  assertColumns(result, ROAST_COLUMNS);
  assertRowCount(result);
  if (result.rowCount === 0) return null;
  if (result.rowCount !== 1) throw schemaError();
  return parseRoastRow(result.rows[0]);
}

export async function getReviewsByRoast(slug: string): Promise<Review[]> {
  const result = await executeStatement(REVIEWS_STATEMENT, slugBinding(slug));
  assertColumns(result, REVIEW_COLUMNS);
  assertRowCount(result);
  if (result.rowCount === 0) return [];
  return result.rows.map(parseReviewRow);
}
