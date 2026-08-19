-- C2-S1 base DDL (issue #307): the five roast/review/reference base tables
-- plus the roast artifact stage. Rebuild of the closed #318 attempt -- every
-- column here transcribes issue #307's enumerated AC-1..AC-6 tables inline,
-- not "matches plan.md §4" indirection.
--
-- Scope fence (AC-8): no GRANT, CREATE ROLE, CREATE VIEW/SECURE VIEW, or
-- CREATE PROCEDURE in this file -- those are later C2 stories. Snowflake
-- enforces only NOT NULL; PRIMARY KEY is declared for documentation only.
-- All temperatures Celsius (AC-7): no Fahrenheit column or conversion
-- anywhere in this file.
--
-- The deploy connection sets no default schema (snowflake/README.md), so
-- relying on one would be fail-open -- this migration sets it explicitly
-- before the first create table.
use schema app;

-- AC-1: 17 columns, no others -- deliberately no stored temperature column;
-- first-crack/drop temps are derived from `summary` and aggregated in
-- reference_roast_summaries, never stored here (AC-1-NEG).
create table cloud_roasts (
  id string default uuid_string() primary key,
  idempotency_key string not null,
  owner_id string,
  public_slug string not null,
  visibility string not null default 'unlisted',
  bean_origin string,
  bean_varietal string,
  bean_weight_g float,
  profile_name string,
  roast_level string,
  summary variant not null,
  operator_rating int,
  operator_notes string,
  contributed_to_learning boolean not null default true,
  roasted_at_utc timestamp_tz,
  created_at timestamp_tz not null default current_timestamp(),
  updated_at timestamp_tz not null default current_timestamp()
);

-- AC-2: 8 columns; `raw` variant must be present (AC-2-NEG); no primary key
-- declared on this table.
create table roast_telemetry (
  roast_id string not null,
  elapsed_s float not null,
  bean_temp_c float,
  env_temp_c float,
  heat_percent int,
  fan_percent int,
  ror_c_per_min float,
  raw variant
);

-- AC-3: 6 columns. Table name intentionally matches the AC-6 stage name
-- below (roast_artifacts) -- faithful to the plan's `@roast_artifacts/...`
-- stage-reference form; not a naming mistake.
create table roast_artifacts (
  id string default uuid_string() primary key,
  roast_id string not null,
  kind string not null,
  stage_path string not null,
  byte_size int,
  created_at timestamp_tz not null default current_timestamp()
);

-- AC-4: 13 columns. `submitted_ip_hash` is deliberately NULLABLE
-- (AC-4-NEG): it is a hashed IP kept for rate-limiting only and purged at
-- >=30 days by setting it to NULL (AGENTS.md IP-purge invariant) -- a NOT
-- NULL constraint here would make that purge impossible.
create table tasting_reviews (
  id string default uuid_string() primary key,
  roast_id string not null,
  reviewer_name string,
  score int not null,
  aroma smallint,
  acidity smallint,
  sweetness smallint,
  body smallint,
  aftertaste smallint,
  brew_method string,
  notes string,
  submitted_ip_hash string,
  created_at timestamp_tz not null default current_timestamp()
);

-- AC-5: 15 columns. Logical key is the pair (bean_origin, roast_level),
-- both NOT NULL (AC-5-NEG) -- no UNIQUE declared here, upserted via MERGE in
-- a later C2 story. Columns 7-10 are Celsius aggregates and legitimately
-- live here; the no-stored-temperature rule is scoped to cloud_roasts only.
create table reference_roast_summaries (
  id string default uuid_string() primary key,
  bean_origin string not null,
  roast_level string not null,
  roast_count int not null,
  review_count int not null,
  avg_rating float,
  first_crack_temp_avg_c float,
  first_crack_temp_stddev_c float,
  drop_temp_avg_c float,
  drop_temp_stddev_c float,
  development_percent_avg float,
  first_crack_time_avg_s float,
  total_time_avg_s float,
  key_patterns variant default parse_json('[]'),
  updated_at timestamp_tz not null default current_timestamp()
);

-- AC-6: artifact stage, server-side encrypted.
create stage roast_artifacts
  encryption = (type = 'SNOWFLAKE_SSE');
