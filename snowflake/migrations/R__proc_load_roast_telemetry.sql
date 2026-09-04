-- C3-S1 LOAD_ROAST_TELEMETRY proc (issue #416): replace one roast's telemetry
-- from its validated, staged JSONL export.
--
-- Scope fence: this file creates exactly one object -- the procedure below.
-- It contains zero GRANT statements and creates no other object.
--
-- D-416-C: this procedure deliberately executes as caller. Its sole caller,
-- ROASTPILOT_AGENT, already has INSERT and DELETE on APP.ROAST_TELEMETRY and
-- READ on APP.ROAST_ARTIFACTS. Caller-rights therefore confers nothing beyond
-- that existing data plane; owner-rights would instead run the dynamic SQL as
-- the deploy role and make the run-id guard the sole role-escalation boundary.
-- D-416-B uses INSERT SELECT because COPY transformations cannot carry the
-- mandatory record-kind filter. D-416-A leaves both optional output columns
-- NULL so no identifying source fields are persisted.
-- Snowflake treats a path in a stage reference as a prefix. The guarded run-id
-- prefix bounds the scan to one run directory; PATTERN prevents same-directory
-- roast.csv and summary.json artifacts from being opened and parsed as JSONL;
-- byte-exact METADATA$FILENAME equality pins the exact row source.
-- Snowflake full-matches PATTERN against the stage-relative path, but its
-- optional directory group deliberately also supports post-prefix matching
-- because that anchoring is unverifiable offline.
--
-- Residual: offline guard tests use Python ``re`` while Snowflake evaluates
-- REGEXP_LIKE with RE2. RE2's ``$`` is stricter (it has no trailing-newline
-- exception), so the guards are believed safe; exact equivalence is not
-- verified offline and is confirmed by the live gate.
-- Residual: -20007 cannot distinguish a legitimately telemetry-free export
-- from a missing or corrupt stage file. It also masks uploader compression or
-- naming mistakes: #417 must pin the agent connector PUT to AUTO_COMPRESS=FALSE
-- and the exact basename and case. The default TRUE stores that basename with
-- a .gz suffix, which matches neither PATTERN nor METADATA$FILENAME equality.
--
-- #419: Guard 3 is defence-in-depth, not an enforcement boundary. The
-- ROASTPILOT_AGENT role holds direct INSERT on app.roast_telemetry
-- (R__z_roles_grants.sql:34), so a direct INSERT bypasses this procedure's
-- consent guard. The true boundary -- revoking agent direct DML and moving to
-- owner-rights gated writes -- is deferred to a separate operator-owned issue
-- per D-419-B and is out of scope here. #430 (SUSPENDED), which also edits this
-- procedure, must preserve Guard 3's pre-transaction placement if it later
-- reorders the telemetry load.
--
-- The deploy connection sets no default schema (snowflake/README.md), so this
-- migration explicitly selects APP before creating the procedure.
use schema app;

create or replace procedure load_roast_telemetry(p_run_id string, p_roast_id string)
copy grants
returns string
language sql
execute as caller
as
$$
declare
  invalid_roast_id exception (-20005, 'Roast id must be a UUID');
  invalid_run_id exception (-20006, 'Run id contains disallowed characters');
  no_telemetry_loaded exception (-20007, 'No telemetry rows loaded');
  roast_not_contributing exception (-20013, 'Roast has not consented to learning');
  v_total_count int;
  v_contributing_count int;
  v_insert_sql string;
  v_loaded_rows int;
begin
  -- Guard 1: byte-identical UUID grammar to DELETE_ROAST.
  if (p_roast_id is null
      or not regexp_like(p_roast_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
    raise invalid_roast_id;
  end if;

  -- Guard 2: assert_sql_identifier_safe is not strictly stricter: it permits
  -- dollar signs and unbounded length, so the ratified closed grammar remains.
  if (p_run_id is null
      or not regexp_like(p_run_id, '^[0-9a-zA-Z_-]{1,64}$')) then
    raise invalid_run_id;
  end if;

  -- Guard 3 (#419 requirement (a)): consent gate, defence-in-depth only.
  -- Refuse the load unless the stored roast consent is affirmatively true.
  -- count(*) makes an empty id match unambiguously 0; coalesce guards against
  -- count_if returning NULL when no matching row satisfies the predicate (an
  -- opted-out single-row roast), which would otherwise make the comparison NULL
  -- and skip the raise -- a fail-open. Comparing contributing to total refuses
  -- any opted-out or mixed duplicate-id set.
  select
      count(*),
      coalesce(count_if(contributed_to_learning = true), 0)
    into :v_total_count, :v_contributing_count
    from app.cloud_roasts
    where id = :p_roast_id;
  if (v_total_count = 0 or v_contributing_count <> v_total_count) then
    raise roast_not_contributing;
  end if;

  begin
    begin transaction;
      delete from app.roast_telemetry where roast_id = :p_roast_id;

      v_insert_sql :=
        'insert into app.roast_telemetry ' ||
        '  (roast_id, elapsed_s, bean_temp_c, env_temp_c, heat_percent, fan_percent, ror_c_per_min, raw) ' ||
        'select ' ||
        '  ''' || p_roast_id || ''', ' ||
        '  $1:monotonic_seconds::float, ' ||
        '  $1:bean_temp_c::float, ' ||
        '  $1:env_temp_c::float, ' ||
        '  $1:heat_level_percent::int, ' ||
        '  $1:fan_level_percent::int, ' ||
        '  null, ' ||
        '  null ' ||
        'from @app.roast_artifacts/' || p_run_id || '/ ' ||
        '  (file_format => ''app.roast_jsonl_format'', pattern => ''(.*/)?roast[.]jsonl'') ' ||
        -- PINNED AT #417: this is the one admitted export basename.
        'where metadata$filename = ''' || p_run_id || '/roast.jsonl'' ' ||
        '  and $1:type::string = ''telemetry''';
      execute immediate :v_insert_sql;
      v_loaded_rows := sqlrowcount;
      if (v_loaded_rows = 0) then
        raise no_telemetry_loaded;
      end if;
    commit;
  exception
    when other then
      rollback;
      raise;
  end;

  return v_loaded_rows::string;
end;
$$;
