-- C2-S4 recompute_reference_summary proc (issue #310): the single-source-
-- of-truth aggregation proc (plan.md §7, D12) that both write planes
-- (SUBMIT_REVIEW #313, DELETE_ROAST #314 -- out of scope here) call after
-- they mutate cloud_roasts/tasting_reviews. Repeatable (R__) migration with
-- `copy grants` (D-310-B, the #311 COPY-GRANTS learning) so grants added
-- later (#317) survive a re-apply.
--
-- Scope fence (NEG-4): this file creates exactly one object -- the
-- procedure below. No GRANT, no role, no view, no table, no function.
--
-- Two time anchors, verified by fixture arithmetic (D-310-A): the
-- telemetry temperature join is `started_at_utc`-anchored, to match
-- `roast_telemetry.elapsed_s` (monotonic-zeroed at session start); the
-- reported `first_crack_time_avg_s` metric is `beans_added_at_utc`-anchored
-- (charge-relative), to stay on the same clock as `summary:total_roast_seconds`.
-- Conflating the two anchors is a silent mis-derivation in both directions.
--
-- No roast-level value ever reads `summary:metrics` (AC-7/NEG-3): that path
-- holds end-of-session snapshots, forbidden for roast-level values --
-- `development_percent_avg`/`total_time_avg_s` read the top-level
-- `summary:development_time_percent`/`summary:total_roast_seconds` instead.
-- Only `contributed_to_learning = true` rows ever aggregate (AC-3/NEG-1).
-- All temperatures Celsius (AC-19): no Fahrenheit token or conversion here.
--
-- The deploy connection sets no default schema (snowflake/README.md), so
-- relying on one would be fail-open -- this migration sets it explicitly
-- before the create.
use schema app;

create or replace procedure recompute_reference_summary(bean_origin string, roast_level string)
returns string
language sql
execute as owner
copy grants
as
begin
  merge into reference_roast_summaries t
  using (
    with contributing as (
      select r.id, r.summary
      from cloud_roasts r
      where r.bean_origin = :bean_origin
        and r.roast_level = :roast_level
        and r.contributed_to_learning = true
    ),
    per_roast as (
      select
        c.id,
        -- FC temp: nearest roast_telemetry row to the started_at-anchored
        -- FC elapsed offset. NULL-guarded (NEG-E): a roast with no
        -- first_crack_at_utc contributes a NULL FC temp, never a spurious
        -- nearest row.
        case
          when c.summary:first_crack_at_utc is null then null
          else (
            select min_by(tm.bean_temp_c, abs(tm.elapsed_s
              - datediff(millisecond, c.summary:started_at_utc::timestamp_tz,
                                      c.summary:first_crack_at_utc::timestamp_tz) / 1000.0))
            from roast_telemetry tm
            where tm.roast_id = c.id
          )
        end as fc_temp_c,
        -- Drop temp: same started_at-anchored join, against the drop offset.
        case
          when c.summary:beans_dropped_at_utc is null then null
          else (
            select min_by(tm.bean_temp_c, abs(tm.elapsed_s
              - datediff(millisecond, c.summary:started_at_utc::timestamp_tz,
                                      c.summary:beans_dropped_at_utc::timestamp_tz) / 1000.0))
            from roast_telemetry tm
            where tm.roast_id = c.id
          )
        end as drop_temp_c,
        c.summary:development_time_percent::float as dev_pct,
        -- FC time: charge-relative (beans_added_at_utc-anchored), matching
        -- summary:total_roast_seconds -- NOT the started_at anchor above.
        datediff(millisecond, c.summary:beans_added_at_utc::timestamp_tz,
                              c.summary:first_crack_at_utc::timestamp_tz) / 1000.0 as fc_time_s,
        c.summary:total_roast_seconds::float as total_s
      from contributing c
    ),
    review_rollup as (
      select count(tr.id) as review_count, avg(tr.score) as avg_rating
      from contributing c
      join tasting_reviews tr on tr.roast_id = c.id
    )
    select
      :bean_origin as bean_origin,
      :roast_level as roast_level,
      (select count(*) from contributing) as roast_count,
      (select review_count from review_rollup) as review_count,
      (select avg_rating from review_rollup) as avg_rating,
      avg(pr.fc_temp_c) as first_crack_temp_avg_c,
      stddev(pr.fc_temp_c) as first_crack_temp_stddev_c,
      avg(pr.drop_temp_c) as drop_temp_avg_c,
      stddev(pr.drop_temp_c) as drop_temp_stddev_c,
      avg(pr.dev_pct) as development_percent_avg,
      avg(pr.fc_time_s) as first_crack_time_avg_s,
      avg(pr.total_s) as total_time_avg_s
    from per_roast pr
    -- no GROUP BY (AC-15/G13): scalar aggregation over per_roast returns
    -- exactly one source row even when zero roasts contribute (aggregates
    -- -> NULL, roast_count/review_count -> 0), so a recompute after a
    -- delete cascade removes the last contributing roast still WRITES
    -- roast_count=0 instead of leaving a stale row behind.
  ) s
  on t.bean_origin = s.bean_origin and t.roast_level = s.roast_level
  when matched then update set
    roast_count = s.roast_count,
    review_count = s.review_count,
    avg_rating = s.avg_rating,
    first_crack_temp_avg_c = s.first_crack_temp_avg_c,
    first_crack_temp_stddev_c = s.first_crack_temp_stddev_c,
    drop_temp_avg_c = s.drop_temp_avg_c,
    drop_temp_stddev_c = s.drop_temp_stddev_c,
    development_percent_avg = s.development_percent_avg,
    first_crack_time_avg_s = s.first_crack_time_avg_s,
    total_time_avg_s = s.total_time_avg_s,
    key_patterns = parse_json('[]'),
    updated_at = current_timestamp()
  when not matched then insert (
    bean_origin, roast_level, roast_count, review_count, avg_rating,
    first_crack_temp_avg_c, first_crack_temp_stddev_c,
    drop_temp_avg_c, drop_temp_stddev_c,
    development_percent_avg, first_crack_time_avg_s, total_time_avg_s,
    key_patterns, updated_at
  ) values (
    s.bean_origin, s.roast_level, s.roast_count, s.review_count, s.avg_rating,
    s.first_crack_temp_avg_c, s.first_crack_temp_stddev_c,
    s.drop_temp_avg_c, s.drop_temp_stddev_c,
    s.development_percent_avg, s.first_crack_time_avg_s, s.total_time_avg_s,
    parse_json('[]'), current_timestamp()
  );
  return 'recomputed';
end;
