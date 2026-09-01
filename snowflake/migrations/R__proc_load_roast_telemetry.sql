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
        -- PINNED AT #417: this is the one admitted export basename.
        'from @app.roast_artifacts/' || p_run_id || '/roast.jsonl ' ||
        '  (file_format => ''app.roast_jsonl_format'') ' ||
        'where $1:type::string = ''telemetry''';
      execute immediate :v_insert_sql;
      v_loaded_rows := sqlrowcount;
      if (sqlrowcount = 0) then
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
