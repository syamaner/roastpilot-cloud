-- C9-C2 controlled deletion: durable identity/order tombstone before cascade.
-- Stage removal is point-in-time, after commit; cache revalidation stays pending.
-- Private stage bytes may return indefinitely; G1 runtime semantics unqualified.
use schema app;
create or replace procedure delete_roast(p_run_id string, p_public_slug string)
returns variant
language sql
execute as owner
as
$$
declare
  ambiguous_roast_id exception (-20004, 'Roast id matched more than one row');
  ambiguous_idempotency_key exception (-20010, 'Idempotency key did not resolve uniquely');
  writer_in_open_transaction exception (-20021, 'Writer must not run inside an open caller transaction');
  delete_identity_mismatch exception (-20025, 'Run id and public slug do not identify one roast or tombstone');
  v_outer_txn string;
  v_write_seq number(38,0);
  v_deletion_write_seq number(38,0);
  v_n int;
  v_ls int;
  v_t_k int;
  v_t_s int;
  v_t_ks int;
  v_t_i int;
  v_id string;
  v_slug string;
  v_captured_key string;
  v_bean_origin string;
  v_roast_level string;
  v_deletion string;
  v_stage_removal string default 'removed';
begin
  if (p_run_id is null
      or not regexp_like(p_run_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
    raise delete_identity_mismatch;
  end if;
  if (p_public_slug is null
      or not regexp_like(p_public_slug, '^[1-9A-HJ-NP-Za-km-z]{17,64}$')) then
    raise delete_identity_mismatch;
  end if;
  select current_transaction() into :v_outer_txn;
  if (v_outer_txn is not null) then
    raise writer_in_open_transaction;
  end if;
  begin
    begin transaction;
      call app.cloud_sync_enter() into :v_write_seq;
      select count(*) into :v_t_k from app.cloud_roast_tombstones where idempotency_key = :p_run_id;
      select count(*) into :v_t_s from app.cloud_roast_tombstones where public_slug = :p_public_slug;
      select count(*) into :v_t_ks from app.cloud_roast_tombstones where idempotency_key = :p_run_id and public_slug = :p_public_slug;
      select count(*) into :v_n from app.cloud_roasts where idempotency_key = :p_run_id;
      if (v_n > 1) then
        raise ambiguous_idempotency_key;
      end if;
      select count(*) into :v_ls from app.cloud_roasts where public_slug = :p_public_slug;
      if (v_t_k = 0 and v_t_s = 0 and v_n = 1) then
        select id, public_slug, idempotency_key, bean_origin, roast_level
          into :v_id, :v_slug, :v_captured_key, :v_bean_origin, :v_roast_level
          from app.cloud_roasts where idempotency_key = :p_run_id;
        select count(*) into :v_t_i from app.cloud_roast_tombstones where cloud_roast_id = :v_id;
        if (v_slug is distinct from p_public_slug or v_ls <> 1 or v_t_i > 0) then
          raise delete_identity_mismatch;
        end if;
        insert into app.cloud_roast_tombstones (cloud_roast_id, idempotency_key, public_slug, deletion_write_seq)
          values (:v_id, :v_captured_key, :v_slug, :v_write_seq);
        delete from app.tasting_reviews where roast_id = :v_id;
        delete from app.roast_telemetry where roast_id = :v_id;
        delete from app.roast_artifacts where roast_id = :v_id;
        delete from app.cloud_roast_field_revisions where cloud_roast_id = :v_id;
        delete from app.cloud_roasts where id = :v_id;
        if (sqlrowcount <> 1) then
          raise ambiguous_roast_id;
        end if;
        call app.recompute_reference_summary(:v_bean_origin, :v_roast_level);
        v_deletion := 'deleted';
        v_deletion_write_seq := v_write_seq;
      elseif (v_t_k = 0 and v_t_s = 0 and v_n = 0) then
        if (v_ls >= 1) then
          raise delete_identity_mismatch;
        end if;
        v_id := null;
        v_captured_key := p_run_id;
        insert into app.cloud_roast_tombstones (cloud_roast_id, idempotency_key, public_slug, deletion_write_seq)
          values (NULL, :v_captured_key, :p_public_slug, :v_write_seq);
        v_deletion := 'tombstoned_without_row';
        v_deletion_write_seq := v_write_seq;
      elseif (v_t_k = 1 and v_t_s = 1 and v_t_ks = 1 and v_n = 0 and v_ls = 0) then
        select cloud_roast_id, idempotency_key, deletion_write_seq
          into :v_id, :v_captured_key, :v_deletion_write_seq
          from app.cloud_roast_tombstones where idempotency_key = :p_run_id and public_slug = :p_public_slug;
        v_deletion := 'already_tombstoned';
      else
        raise delete_identity_mismatch;
      end if;
      if (v_captured_key is null or v_captured_key is distinct from p_run_id) then
        raise delete_identity_mismatch;
      end if;
    commit;
  exception
    when other then
      rollback;
      raise;
  end;
  begin
    execute immediate 'remove @app.roast_artifacts/' || :v_captured_key || '/';
  exception
    when other then
      v_stage_removal := 'failed';
  end;
  return object_construct_keep_null('cloud_roast_id', v_id, 'deletion', v_deletion,
    'deletion_write_seq', v_deletion_write_seq, 'stage_removal', v_stage_removal,
    'cache_invalidation', 'pending');
end;
$$;
