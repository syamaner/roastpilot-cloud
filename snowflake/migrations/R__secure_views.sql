-- C2-S3 secure views (issue #311): the two secure views that make up
-- PUBLIC_WEB's entire read surface (AGENTS.md invariant; plan.md §5).
-- Repeatable (R__) migration -- schemachange re-applies it whenever its
-- checksum changes, ordered after the versioned set, so it runs after
-- V1.1.0__base_tables.sql. Both views use the `COPY` + `GRANTS` clause to
-- retain their privileges across each re-apply.
--
-- Scope fence (AC-10): this file only creates the two secure views below;
-- no privilege grants, and no role, procedure, function, table, or stage
-- is created here. The privileges that let PUBLIC_WEB actually SELECT
-- these views are issue #317; until then these views are inert objects.
-- All temperatures Celsius (AC-12): no Fahrenheit column or conversion
-- anywhere in this file.
--
-- The deploy connection sets no default schema (snowflake/README.md), so
-- relying on one would be fail-open -- this migration sets it explicitly
-- before the first create.
use schema app;

-- D220 curated summary v1 exposes only the closed timing/statistics shape.
-- The owner's integer operator rating is appended after the curve.
-- Consent is independent of public visibility: S8/R4 supersede D-446-A.
-- The ordered curve keeps its six Celsius keys, including null sensors.
-- Visibility still excludes private roasts; internal metadata stays private.
create or replace secure view roast_by_slug copy grants as
select
  r.public_slug,
  r.bean_origin,
  r.bean_varietal,
  r.bean_weight_g,
  r.profile_name,
  r.roast_level,
  r.roasted_at_utc,
  r.created_at,
  object_construct_keep_null(
    'curated_version', 1,
    'started_at_utc', case when typeof(r.summary:started_at_utc) = 'VARCHAR' and regexp_like(r.summary:started_at_utc::string, '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$') then r.summary:started_at_utc::string else null end,
    'first_crack_at_utc', case when typeof(r.summary:first_crack_at_utc) = 'VARCHAR' and regexp_like(r.summary:first_crack_at_utc::string, '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$') then r.summary:first_crack_at_utc::string else null end,
    'beans_added_at_utc', case when typeof(r.summary:beans_added_at_utc) = 'VARCHAR' and regexp_like(r.summary:beans_added_at_utc::string, '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$') then r.summary:beans_added_at_utc::string else null end,
    'beans_dropped_at_utc', case when typeof(r.summary:beans_dropped_at_utc) = 'VARCHAR' and regexp_like(r.summary:beans_dropped_at_utc::string, '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?(Z|[+-][0-9]{2}:[0-9]{2})$') then r.summary:beans_dropped_at_utc::string else null end,
    'total_roast_seconds', case when typeof(r.summary:total_roast_seconds) in ('INTEGER', 'DECIMAL', 'DOUBLE') then r.summary:total_roast_seconds else null end,
    'development_time_percent', case when typeof(r.summary:development_time_percent) in ('INTEGER', 'DECIMAL', 'DOUBLE') then r.summary:development_time_percent else null end
  ) as summary,
  (
    select array_agg(
      object_construct_keep_null(
        'elapsed_s', t.elapsed_s,
        'bean_temp_c', t.bean_temp_c,
        'env_temp_c', t.env_temp_c,
        'heat_percent', t.heat_percent,
        'fan_percent', t.fan_percent,
        'ror_c_per_min', t.ror_c_per_min
      )
    ) within group (order by t.elapsed_s)
    from roast_telemetry t
    where t.roast_id = r.id
  ) as curve,
  r.operator_rating
from cloud_roasts r
where r.visibility <> 'private';

-- AC-3/AC-6/AC-7-NEG/AC-8-NEG: exactly the 11 enumerated columns. Joins to
-- cloud_roasts so a private roast's reviews are excluded by the same
-- visibility filter -- a review row has no visibility column of its own,
-- so this join is the only place that inheritance can be enforced.
-- The hashed-IP column is deliberately not projected (AC-8-NEG).
create or replace secure view reviews_by_roast copy grants as
select
  r.public_slug,
  tr.reviewer_name,
  tr.score,
  tr.aroma,
  tr.acidity,
  tr.sweetness,
  tr.body,
  tr.aftertaste,
  tr.brew_method,
  tr.notes,
  tr.created_at
from tasting_reviews tr
join cloud_roasts r on tr.roast_id = r.id
where r.visibility <> 'private';
