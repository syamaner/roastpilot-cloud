-- C9-C2: this procedure now executes as owner; telemetry is consent-independent.
-- The body selects no object dynamically: the write target is hard-coded, and
-- both interpolants are grammar-validated by Guards 1 and 2.
-- Guard 2 also rejects `--`, the sole reachable SQL comment sequence in the unquoted stage path.
-- Coordinated tombstone and exact binding checks are under the shared lock.
-- The agent's direct telemetry DML is revoked (SELECT-only); it retains stage WRITE
-- and its direct artifact-table DML is revoked. These procedure checks plus
-- revoked direct DML are now the sole write boundary. Any future edit introducing
-- dynamic object selection would break this injection-free safety property.
-- #430 Decision 2 (this recompute) is implemented; Decision 3 (the run_id↔roast_id binding) is implemented under the coordination lock.
-- The run id resolves globally to exactly one roast, which must be `p_roast_id`; either mismatch raises -20014.
-- The C3 connector MUST call with p_run_id = the roast's idempotency_key;
-- this retains the #446 requirement-(b) prerequisite without withholding curves.
-- The two recompute call sites cover distinct changes and both are required:
-- UPSERT_ROAST's recompute covers metadata/membership change; this procedure's recompute covers telemetry arrival.
-- A first sync recomputes twice. This is accepted and idempotent because it is a full MERGE recomputation of the group.
-- D-416-B retains INSERT SELECT's record-kind filter; D-416-A keeps optional columns NULL.
-- Stage bytes are private storage, not consent or deletion-completion evidence.
-- Exact RE2 equivalence, stage races and runtime compilation remain unproven until G1.
use schema app;

create or replace procedure load_roast_telemetry(p_run_id string, p_roast_id string)
copy grants
returns string
language sql
execute as owner
as
$$
declare
  invalid_roast_id exception (-20005, 'Roast id must be a UUID');
  invalid_run_id exception (-20006, 'Run id contains disallowed characters');
  no_telemetry_loaded exception (-20007, 'No telemetry rows loaded');
  run_roast_mismatch exception (-20014, 'Run id and roast id do not identify the same roast');
  writer_in_open_transaction exception (-20021, 'Writer must not run inside an open caller transaction');
  v_outer_txn string;
  v_write_seq number(38,0);
  identity_tombstoned exception (-20020, 'Roast identity is tombstoned');
  v_tombstone_count int;
  v_total_count int;
  v_binding_count int;
  v_insert_sql string;
  v_loaded_rows int;
  v_bean_origin string;
  v_roast_level string;
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
  -- The closed charset excludes every other SQL comment opener. Reject its one
  -- reachable sequence before p_run_id enters the unquoted stage path.
  if (contains(p_run_id, '--')) then
    raise invalid_run_id;
  end if;

  select current_transaction() into :v_outer_txn;
  if (v_outer_txn is not null) then
    raise writer_in_open_transaction;
  end if;
  begin
    begin transaction;
      call app.cloud_sync_enter() into :v_write_seq;
      select count(*) into :v_tombstone_count from app.cloud_roast_tombstones where idempotency_key = :p_run_id or cloud_roast_id = :p_roast_id;
      if (v_tombstone_count > 0) then
        raise identity_tombstoned;
      end if;
  -- Guard 4: the run id must resolve to exactly one roast globally (idempotency_key
  -- uniqueness is not enforced by Snowflake, so a run key shared across roasts must
  -- fail closed, never admit either target), and that roast must be p_roast_id.
  select count(*)
    into :v_binding_count
    from app.cloud_roasts
    where idempotency_key = :p_run_id;
  if (v_binding_count <> 1) then
    raise run_roast_mismatch;
  end if;
  select count(*)
    into :v_binding_count
    from app.cloud_roasts
    where idempotency_key = :p_run_id and id = :p_roast_id;
  if (v_binding_count <> 1) then
    raise run_roast_mismatch;
  end if;

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
        '  and $1:type::string = ''telemetry'' ' ||
        '  and (select count(*) from app.cloud_roasts where id = ''' || p_roast_id || ''') = 1 ' ||
        '  and (select count(*) from app.cloud_roasts where idempotency_key = ''' || p_run_id || ''') = 1 ' ||
        '  and (select count(*) from app.cloud_roasts where idempotency_key = ''' || p_run_id || ''' and id = ''' || p_roast_id || ''') = 1';
      execute immediate :v_insert_sql;
      v_loaded_rows := sqlrowcount;
      if (v_loaded_rows = 0) then
        raise no_telemetry_loaded;
      end if;
      select bean_origin, roast_level
        into :v_bean_origin, :v_roast_level
        from app.cloud_roasts
        where id = :p_roast_id;
      call app.recompute_reference_summary(:v_bean_origin, :v_roast_level);
    commit;
  exception
    when other then
      rollback;
      raise;
  end;

  return v_loaded_rows::string;
end;
$$;
