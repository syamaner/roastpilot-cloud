-- Base data-model tables + artifact stage (C2-S1, issue #307).
--
-- Creates the five tables plan.md §4 lists (cloud_roasts, roast_telemetry,
-- roast_artifacts, tasting_reviews, reference_roast_summaries) and the
-- roast_artifacts stage, inside the `app` schema the bootstrap migration
-- (V1.0.0) created. Deliberately contains no GRANT, secure view, or stored
-- procedure -- those land in C2-S3 (views), C2-S4/S5/S6 (procs), and C2-S7
-- (grants); account-role creation is operator-provisioned (D106, C2-S2).
--
-- Snowflake enforces NOT NULL only (see ../README.md "Snowflake enforces
-- only NOT NULL"): PRIMARY KEY/FOREIGN KEY here are documentation, not
-- enforced constraints. `idempotency_key` intentionally carries no UNIQUE
-- declaration -- idempotency is enforced by the write path via
-- `MERGE ... ON idempotency_key`, never a constraint (AGENTS.md). Range/enum
-- rules (ratings 1-5, flavor sliders 0-100, visibility values) live in the
-- Zod schema and the Pydantic model, not here.
--
-- Every temperature column is Celsius (`_c` suffix, e.g. charge_temp_c,
-- drop_temp_c, rate_of_rise_c_per_min) -- there is no other temperature
-- unit or unit conversion anywhere in this migration.

create table if not exists app.cloud_roasts (
  cloud_roast_id string not null,
  idempotency_key string not null,
  public_slug string not null,
  visibility string not null default 'private',
  contributed_to_learning boolean not null default true,
  bean_name string,
  roast_profile_name string,
  roasted_at timestamp_tz not null,
  charge_temp_c float not null,
  drop_temp_c float not null,
  first_crack_temp_c float,
  first_crack_time_seconds number,
  development_time_seconds number,
  total_roast_time_seconds number not null,
  batch_weight_grams_in float,
  batch_weight_grams_out float,
  summary variant not null,
  created_at timestamp_tz not null default current_timestamp(),
  updated_at timestamp_tz not null default current_timestamp(),
  primary key (cloud_roast_id)
)
  comment = 'One row per roast synced from the local agent (plan.md §4). visibility is one of private, unlisted, public -- enforced in Zod/Pydantic, not here.';

create table if not exists app.roast_telemetry (
  telemetry_id string not null,
  cloud_roast_id string not null,
  elapsed_seconds number not null,
  bean_temp_c float,
  environment_temp_c float,
  rate_of_rise_c_per_min float,
  fan_speed_percent number,
  heater_percent number,
  recorded_at timestamp_tz not null,
  created_at timestamp_tz not null default current_timestamp(),
  primary key (telemetry_id),
  foreign key (cloud_roast_id) references app.cloud_roasts (cloud_roast_id)
)
  comment = 'Time-series temperature/rate-of-rise samples for one roast (drives the RoastCurve component). rate_of_rise_c_per_min is degrees Celsius per minute.';

create table if not exists app.roast_artifacts (
  artifact_id string not null,
  cloud_roast_id string not null,
  artifact_type string not null,
  stage_file_path string not null,
  content_type string,
  size_bytes number,
  created_at timestamp_tz not null default current_timestamp(),
  primary key (artifact_id),
  foreign key (cloud_roast_id) references app.cloud_roasts (cloud_roast_id)
)
  comment = 'Metadata rows for files under the roast_artifacts stage (roast log exports, curve images). stage_file_path points into that stage; deletion of a row must be paired with removing the staged file (delete_roast proc, C2-S6).';

create table if not exists app.tasting_reviews (
  review_id string not null,
  cloud_roast_id string not null,
  rating number not null,
  aroma_score number,
  acidity_score number,
  body_score number,
  sweetness_score number,
  aftertaste_score number,
  reviewer_name string,
  review_comment string,
  submitted_ip_hash string not null,
  submitted_at timestamp_tz not null default current_timestamp(),
  primary key (review_id),
  foreign key (cloud_roast_id) references app.cloud_roasts (cloud_roast_id)
)
  comment = 'Public tasting reviews submitted anonymously via /r/[slug] (StarRating + FlavorSliders). rating is 1-5, *_score sliders are 0-100, both enforced in Zod/Pydantic, not here. submitted_ip_hash is a hash only -- the raw IP is never stored -- and rows are purged at >= 30 days by a scheduled job (C2), not by this migration.';

create table if not exists app.reference_roast_summaries (
  reference_summary_id string not null,
  bean_name string not null,
  roast_profile_name string,
  sample_size number not null,
  summary variant not null,
  computed_at timestamp_tz not null default current_timestamp(),
  primary key (reference_summary_id)
)
  comment = 'Aggregated, anonymized reference curves built from roasts with contributed_to_learning = true (plan.md §4); summary holds the aggregate curve/statistics payload.';

create stage if not exists app.roast_artifacts
  encryption = (type = 'SNOWFLAKE_SSE')
  comment = 'Backing stage for app.roast_artifacts rows -- roast log exports and curve images, server-side encrypted.';
