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
-- D-314-I: stage-file REMOVE is deferred to #341, gated on the C3 connector's
-- stage_path contract. This procedure deletes artifact rows but not yet staged
-- files; no real staged artifacts exist in C2. All temperatures are Celsius;
-- this procedure contains no Fahrenheit value or conversion.
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
  v_count int;
  v_bean_origin string;
  v_roast_level string;
begin
  -- Guard 1 (D-314-C): UUID shape on the input id, before any work.
  if (p_roast_id is null
      or not regexp_like(p_roast_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
    raise invalid_roast_id;
  end if;

  -- Existence + grouping capture (one aggregate row).
  select count(*), any_value(bean_origin), any_value(roast_level)
    into :v_count, :v_bean_origin, :v_roast_level
    from app.cloud_roasts where id = :p_roast_id;

  if (v_count = 0) then
    return 'no-op: roast not found';
  end if;

  if (v_count > 1) then
    raise ambiguous_roast_id;
  end if;

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
