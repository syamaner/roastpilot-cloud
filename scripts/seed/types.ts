export interface CloudRoastRow {
  id: string | null;
  idempotency_key: string;
  owner_id: string | null;
  public_slug: string;
  visibility: string;
  bean_origin: string | null;
  bean_varietal: string | null;
  bean_weight_g: number | null;
  profile_name: string | null;
  roast_level: string | null;
  summary: unknown;
  operator_rating: number | null;
  operator_notes: string | null;
  contributed_to_learning: boolean;
  roasted_at_utc: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoastTelemetryRow {
  roast_id: string;
  elapsed_s: number;
  bean_temp_c: number | null;
  env_temp_c: number | null;
  heat_percent: number | null;
  fan_percent: number | null;
  ror_c_per_min: number | null;
  raw: unknown | null;
}

export interface RoastArtifactRow {
  id: string | null;
  roast_id: string;
  kind: string;
  stage_path: string;
  byte_size: number | null;
  created_at: string;
}

export interface TastingReviewRow {
  id: string | null;
  roast_id: string;
  reviewer_name: string | null;
  score: number;
  aroma: number | null;
  acidity: number | null;
  sweetness: number | null;
  body: number | null;
  aftertaste: number | null;
  brew_method: string | null;
  notes: string | null;
  submitted_ip_hash: string | null;
  created_at: string;
}

export interface ReferenceRoastSummaryRow {
  id: string | null;
  bean_origin: string;
  roast_level: string;
  roast_count: number;
  review_count: number;
  avg_rating: number | null;
  first_crack_temp_avg_c: number | null;
  first_crack_temp_stddev_c: number | null;
  drop_temp_avg_c: number | null;
  drop_temp_stddev_c: number | null;
  development_percent_avg: number | null;
  first_crack_time_avg_s: number | null;
  total_time_avg_s: number | null;
  key_patterns: unknown | null;
  updated_at: string;
}
