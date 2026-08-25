import type { ParsedExport, ParsedSummary } from "./parse-export.ts";
import {
  ARTIFACT_KINDS,
  type SeedOutput,
  VISIBILITY_VALUES,
} from "./rules.ts";
import {
  createSeededRng,
  synthCloudRoastId,
  synthIdempotencyKey,
  synthIpHash,
  synthReviewerName,
  synthSlug,
  type SeededRng,
} from "./synth.ts";
import type {
  CloudRoastRow,
  ReferenceRoastSummaryRow,
  RoastArtifactRow,
  RoastTelemetryRow,
  TastingReviewRow,
} from "./types.ts";

export const BEAN_ORIGINS = [
  "Ethiopia Yirgacheffe",
  "Colombia Huila",
  "Brazil Cerrado",
  "Guatemala Antigua",
] as const;
export const ROAST_LEVELS = ["light", "medium", "dark"] as const;
export const FIXED_SEED = 0x312c2;

const ROAST_COUNT = BEAN_ORIGINS.length * ROAST_LEVELS.length * 2;
const MAX_TELEMETRY_ROWS_PER_ROAST = 50;
const RETENTION_SAFE_DAYS = 20;

interface ClosedSummary {
  development_time_percent: number;
  development_time_seconds: number;
  total_roast_seconds: number;
  beans_added_at_utc: string;
  first_crack_at_utc: string;
  beans_dropped_at_utc: string;
  started_at_utc: string;
  metrics: {
    bean_ror_c_per_min: number;
    env_ror_c_per_min: number;
    bean_temp_delta_60s_c: number;
    env_temp_delta_60s_c: number;
    roast_elapsed_seconds: number;
  };
  first_crack_model: {
    confidence: number;
    confidence_threshold: number;
  };
}

interface RoastPerturbation {
  temperatureOffsetC: number;
  controlOffset: number;
  confidenceOffset: number;
}

function randomInteger(rng: SeededRng, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

function relativeIso(now: Date, rng: SeededRng): string {
  const maxOffsetSeconds = RETENTION_SAFE_DAYS * 24 * 60 * 60;
  return new Date(
    now.getTime() - randomInteger(rng, 0, maxOffsetSeconds) * 1_000,
  ).toISOString();
}

function childCreatedIso(
  parentCreatedMs: number,
  nowMs: number,
  rng: SeededRng,
): string {
  const childMs = parentCreatedMs +
    Math.floor(rng() * (nowMs - parentCreatedMs + 1));
  return new Date(childMs).toISOString();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function createPerturbation(rng: SeededRng): RoastPerturbation {
  return {
    temperatureOffsetC: rng() * 10 - 5,
    controlOffset: randomInteger(rng, -5, 5),
    confidenceOffset: rng() * 0.06 - 0.03,
  };
}

function epochMicroseconds(iso: string): bigint {
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(iso)?.[1] ?? "";
  const microseconds = fraction.padEnd(6, "0").slice(0, 6);
  const subMillisecond = microseconds.slice(3, 6).padEnd(3, "0");
  return BigInt(Date.parse(iso)) * BigInt(1_000) + BigInt(subMillisecond);
}

function isoFromEpochMicroseconds(value: bigint): string {
  const microsecondsPerSecond = BigInt(1_000_000);
  const wholeSeconds = value / microsecondsPerSecond;
  const withinSecond = value % microsecondsPerSecond;
  const datePrefix = new Date(Number(wholeSeconds) * 1_000)
    .toISOString().slice(0, 19);
  return `${datePrefix}.${withinSecond.toString().padStart(6, "0")}Z`;
}

function shiftIso(iso: string, offsetMicroseconds: bigint): string {
  return isoFromEpochMicroseconds(epochMicroseconds(iso) + offsetMicroseconds);
}

function closedSummary(
  source: ParsedSummary,
  roastedAt: string,
  perturbation: RoastPerturbation,
): ClosedSummary {
  const lifecycleOffset = epochMicroseconds(roastedAt) -
    epochMicroseconds(source.started_at_utc);
  return {
    development_time_percent: source.development_time_percent,
    development_time_seconds: source.development_time_seconds,
    total_roast_seconds: source.total_roast_seconds,
    beans_added_at_utc: shiftIso(source.beans_added_at_utc, lifecycleOffset),
    first_crack_at_utc: shiftIso(source.first_crack_at_utc, lifecycleOffset),
    beans_dropped_at_utc: shiftIso(source.beans_dropped_at_utc, lifecycleOffset),
    started_at_utc: shiftIso(source.started_at_utc, lifecycleOffset),
    metrics: {
      bean_ror_c_per_min: source.metrics.bean_ror_c_per_min,
      env_ror_c_per_min: source.metrics.env_ror_c_per_min,
      bean_temp_delta_60s_c: source.metrics.bean_temp_delta_60s_c,
      env_temp_delta_60s_c: source.metrics.env_temp_delta_60s_c,
      roast_elapsed_seconds: source.metrics.roast_elapsed_seconds,
    },
    first_crack_model: {
      confidence: clamp(
        source.first_crack_model.confidence + perturbation.confidenceOffset,
        0,
        1,
      ),
      confidence_threshold: source.first_crack_model.confidence_threshold,
    },
  };
}

function average(values: readonly number[]): number | null {
  /* v8 ignore next -- fixed fan-out gives every group roasts and 1-3 reviews */
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function generate(
  exports: ParsedExport[],
  opts: { now: Date },
): SeedOutput {
  if (exports.length === 0) {
    throw new Error("At least one parsed export is required");
  }
  if (Number.isNaN(opts.now.getTime())) {
    throw new Error("A valid generation time is required");
  }

  const rng = createSeededRng(FIXED_SEED);
  const cloudRoasts: CloudRoastRow[] = [];
  const roastTelemetry: RoastTelemetryRow[] = [];
  const roastArtifacts: RoastArtifactRow[] = [];
  const tastingReviews: TastingReviewRow[] = [];

  for (let index = 0; index < ROAST_COUNT; index += 1) {
    const group = Math.floor(index / 2);
    const beanOrigin = BEAN_ORIGINS[group % BEAN_ORIGINS.length];
    const roastLevel = ROAST_LEVELS[Math.floor(group / BEAN_ORIGINS.length)];
    const source = exports[index % exports.length];
    const roastId = synthCloudRoastId(rng);
    const nowMs = opts.now.getTime();
    const roastedAt = relativeIso(opts.now, rng);
    const createdAt = childCreatedIso(Date.parse(roastedAt), nowMs, rng);
    const parentCreatedMs = Date.parse(createdAt);
    const perturbation = createPerturbation(rng);
    const roast: CloudRoastRow = {
      id: roastId,
      idempotency_key: synthIdempotencyKey(rng),
      owner_id: null,
      public_slug: synthSlug(rng),
      visibility: VISIBILITY_VALUES[randomInteger(rng, 0, VISIBILITY_VALUES.length - 1)],
      bean_origin: beanOrigin,
      bean_varietal: index % 3 === 0 ? "Synthetic blend" : null,
      bean_weight_g: index % 2 === 0 ? 250 : null,
      profile_name: index % 4 === 0 ? "Synthetic preview profile" : null,
      roast_level: roastLevel,
      summary: closedSummary(source.summary, roastedAt, perturbation),
      operator_rating: index % 3 === 0 ? randomInteger(rng, 1, 5) : null,
      operator_notes: null,
      // Every fan-out roast contributes, so each §1.2 group reconciles to 2.
      // The exclusion filter is unit-tested in seed-rules.test.ts; a follow-up
      // can add non-contributing roasts for end-to-end exclusion realism.
      contributed_to_learning: true,
      roasted_at_utc: roastedAt,
      created_at: createdAt,
      updated_at: createdAt,
    };
    cloudRoasts.push(roast);

    const sampleStep = Math.max(
      1,
      Math.ceil(source.telemetry.length / MAX_TELEMETRY_ROWS_PER_ROAST),
    );
    source.telemetry.forEach((sample, sampleIndex) => {
      if (sampleIndex % sampleStep !== 0) return;
      const beanTempC = sample.bean_temp_c + perturbation.temperatureOffsetC;
      const envTempC = sample.env_temp_c + perturbation.temperatureOffsetC;
      const heatPercent = clamp(
        sample.heat_level_percent + perturbation.controlOffset,
        0,
        100,
      );
      const fanPercent = clamp(
        sample.fan_level_percent - perturbation.controlOffset,
        0,
        100,
      );
      const raw = {
        source: "synthetic",
        sample_elapsed_s: sample.monotonic_seconds,
        bean_temp_c: beanTempC,
        env_temp_c: envTempC,
        heat_percent: heatPercent,
        fan_percent: fanPercent,
      };
      roastTelemetry.push({
        roast_id: roastId,
        elapsed_s: sample.monotonic_seconds,
        bean_temp_c: beanTempC,
        env_temp_c: envTempC,
        heat_percent: heatPercent,
        fan_percent: fanPercent,
        ror_c_per_min: null,
        raw,
      });
    });

    const artifactCount = randomInteger(rng, 1, ARTIFACT_KINDS.length);
    for (let artifactIndex = 0; artifactIndex < artifactCount; artifactIndex += 1) {
      const kind = ARTIFACT_KINDS[artifactIndex];
      roastArtifacts.push({
        id: null,
        roast_id: roastId,
        kind,
        // D-314-F stores the relative run path; LIST/REMOVE adds the stage name.
        stage_path: `${roast.idempotency_key}/${kind}`,
        byte_size: artifactIndex % 2 === 0 ? randomInteger(rng, 1_024, 65_536) : null,
        created_at: childCreatedIso(parentCreatedMs, nowMs, rng),
      });
    }

    const reviewCount = randomInteger(rng, 1, 3);
    for (let reviewIndex = 0; reviewIndex < reviewCount; reviewIndex += 1) {
      const includeIpHash = reviewIndex % 2 === 0;
      tastingReviews.push({
        id: null,
        roast_id: roastId,
        reviewer_name: synthReviewerName(rng),
        score: randomInteger(rng, 1, 5),
        aroma: randomInteger(rng, 0, 100),
        acidity: reviewIndex % 3 === 0 ? null : randomInteger(rng, 0, 100),
        sweetness: randomInteger(rng, 0, 100),
        body: randomInteger(rng, 0, 100),
        aftertaste: reviewIndex % 2 === 0 ? null : randomInteger(rng, 0, 100),
        brew_method: reviewIndex % 2 === 0 ? "Synthetic pourover" : null,
        notes: null,
        submitted_ip_hash: includeIpHash ? synthIpHash(rng) : null,
        created_at: childCreatedIso(parentCreatedMs, nowMs, rng),
      });
    }
  }

  const referenceRoastSummaries: ReferenceRoastSummaryRow[] = [];
  for (const roastLevel of ROAST_LEVELS) {
    for (const beanOrigin of BEAN_ORIGINS) {
      const groupRoasts = cloudRoasts.filter(
        (roast) => roast.bean_origin === beanOrigin &&
          roast.roast_level === roastLevel &&
          roast.contributed_to_learning,
      );
      const roastIds = new Set(groupRoasts.map((roast) => roast.id));
      const reviews = tastingReviews.filter((review) => roastIds.has(review.roast_id));
      const summaries = groupRoasts.map((roast) => roast.summary as ClosedSummary);
      const firstCrackTimes = summaries.map(
        (summary) =>
          (Date.parse(summary.first_crack_at_utc) -
            Date.parse(summary.beans_added_at_utc)) / 1_000,
      );
      const keyPatterns: [] = [];
      referenceRoastSummaries.push({
        id: null,
        bean_origin: beanOrigin,
        roast_level: roastLevel,
        roast_count: groupRoasts.length,
        review_count: reviews.length,
        avg_rating: average(reviews.map((review) => review.score)),
        // Intentionally null per §1.2 / D-312-I in these directly written
        // summaries. The seed supplies the raw telemetry from which the D12
        // recompute_reference_summary proc derives these four values. The future
        // operator-run / #11-gated live-adapter slice (D-312-J) must invoke that
        // proc per bean-origin/roast-level group after loading to populate them.
        first_crack_temp_avg_c: null,
        first_crack_temp_stddev_c: null,
        drop_temp_avg_c: null,
        drop_temp_stddev_c: null,
        development_percent_avg: average(
          summaries.map((summary) => summary.development_time_percent),
        ),
        first_crack_time_avg_s: average(firstCrackTimes),
        total_time_avg_s: average(
          summaries.map((summary) => summary.total_roast_seconds),
        ),
        key_patterns: keyPatterns,
        updated_at: opts.now.toISOString(),
      });
    }
  }

  return {
    cloudRoasts,
    roastTelemetry,
    roastArtifacts,
    tastingReviews,
    referenceRoastSummaries,
  };
}
