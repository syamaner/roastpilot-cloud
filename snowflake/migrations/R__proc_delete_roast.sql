-- C2-S6 DELETE_ROAST proc (issue #314): delete one roast and its dependent
-- rows, then recompute its former reference-summary group.
--
-- Scope fence: this file creates exactly one object -- the procedure below.
-- It contains zero GRANT statements and creates no other object.
-- The input is the internal roast id, not a public slug. Deliberately no
-- visibility filter applies: this owner-executed revocation path must delete
-- private roasts too.
--
-- The row cascade deletes reviews, telemetry, artifact rows, and the roast, then
-- recomputes the affected summary inside one all-or-nothing transaction. A UUID
-- guard rejects malformed input before any work; an ambiguous id fails closed.
-- The pre-transaction count is a fast path, while SQLROWCOUNT authoritatively
-- requires exactly one parent delete inside the transaction. A well-formed absent
-- id is an idempotent no-op.
--
-- D-314-I deferred stage-file removal to #341 until the C3 connector fixed its
-- path contract. D-341-A settles #341's mechanism: it reads idempotency_key from cloud_roasts,
-- validates it with load_roast_telemetry's containment grammar (1-64 alphanumeric,
-- underscore, or hyphen characters, with no double hyphen), and fails closed on
-- NULL, blank, or any mismatch. It issues one directory-scoped
-- REMOVE of @app.roast_artifacts/<run_id>/, constructed in-procedure, without
-- ever interpolating a stored artifact-path column value into REMOVE.
-- A key shared across roasts fails closed before REMOVE, so neither roast's
-- directory can be removed through an ambiguous containment boundary.
-- Files are removed first, so a committed row deletion implies its staged files
-- were already removed; a REMOVE failure starts no row work and is fully retryable.
-- If REMOVE succeeds and the later cascade rolls back, a still-present roast can
-- momentarily lack its files; re-running safely completes deletion because REMOVE
-- is idempotent on an empty prefix. This is not a deletion-completeness violation.
-- A delete racing a concurrent upload can still orphan it (ratified residual).
-- The prefix derives from idempotency_key; reassess the uniqueness guard when
-- R__proc_upsert_roast.sql's concurrent-MERGE snapshot-visibility residual closes.
-- All temperatures are Celsius; this procedure contains no Fahrenheit value or
-- conversion.
--
-- The deploy connection sets no default schema (snowflake/README.md), so this
-- migration explicitly selects APP before creating the procedure.
use schema app;

create or replace procedure delete_roast(p_roast_id string)
copy grants
returns string
language sql
execute as owner
as
$$
declare
  invalid_roast_id exception (-20003, 'Roast id must be a UUID');
  ambiguous_roast_id exception (-20004, 'Roast id matched more than one row');
  invalid_idempotency_key exception (-20015, 'Stored idempotency key contains disallowed characters');
  nonunique_idempotency_key exception (-20016, 'Idempotency key is not unique; refusing destructive stage removal');
  v_count int;
  v_key_count int;
  v_bean_origin string;
  v_roast_level string;
  v_idempotency_key string;
  v_remove_sql string;
begin
  -- Guard 1 (D-314-C): UUID shape on the input id, before any work.
  if (p_roast_id is null
      or not regexp_like(p_roast_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
    raise invalid_roast_id;
  end if;

  -- Existence + grouping capture (one aggregate row).
  select count(*), any_value(bean_origin), any_value(roast_level), any_value(idempotency_key)
    into :v_count, :v_bean_origin, :v_roast_level, :v_idempotency_key
    from app.cloud_roasts where id = :p_roast_id;

  if (v_count = 0) then
    return 'no-op: roast not found';
  end if;

  if (v_count > 1) then
    raise ambiguous_roast_id;
  end if;

  if (v_idempotency_key is null
      or not regexp_like(v_idempotency_key, '^[0-9a-zA-Z_-]{1,64}$')) then
    raise invalid_idempotency_key;
  end if;
  if (contains(v_idempotency_key, '--')) then
    raise invalid_idempotency_key;
  end if;

  select count(*)
    into :v_key_count
    from app.cloud_roasts
    where idempotency_key = :v_idempotency_key;
  if (v_key_count <> 1) then
    raise nonunique_idempotency_key;
  end if;

  v_remove_sql := 'remove @app.roast_artifacts/' || v_idempotency_key || '/';
  execute immediate :v_remove_sql;

  -- All-or-nothing DML: children then parent, recompute inside the transaction.
  begin
    begin transaction;
      delete from app.tasting_reviews where roast_id = :p_roast_id;
      delete from app.roast_telemetry where roast_id = :p_roast_id;
      delete from app.roast_artifacts where roast_id = :p_roast_id;
      delete from app.cloud_roasts     where id       = :p_roast_id;
      if (sqlrowcount <> 1) then
        raise ambiguous_roast_id;
      end if;
      call app.recompute_reference_summary(:v_bean_origin, :v_roast_level);
    commit;
  exception
    when other then
      rollback;
      raise;
  end;

  return 'deleted';
end;
$$;
