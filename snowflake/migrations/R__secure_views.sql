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

-- AC-1/AC-2/AC-5/AC-9-NEG: exactly the 10 enumerated columns, in order.
-- `summary` is projected wholesale (D-311-B) -- the FC/drop-temp headline
-- stats derive from it plus `curve` at the C4 page layer, not here. `curve`
-- is an ordered array_agg(object_construct_keep_null(...)) over
-- roast_telemetry, carrying exactly the 6 Celsius keys even when a sensor
-- value is NULL; `raw` is deliberately excluded.
-- The row-owner column and `visibility` itself are deliberately not
-- projected (AC-7-NEG) -- visibility only gates the filter below.
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
  r.summary,
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
  ) as curve
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
