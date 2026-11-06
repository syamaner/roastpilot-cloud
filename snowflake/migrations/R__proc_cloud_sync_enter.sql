use schema app;
create or replace procedure cloud_sync_enter()
returns number(38,0)
language sql
execute as owner
as
$$
declare
  coordination_lock_unavailable exception (-20019, 'Cloud sync coordination lock did not resolve uniquely');
  coordination_requires_transaction exception (-20022, 'Coordinated write requires an active transaction');
  read_consistency_unverified exception (-20026, 'Account read consistency is not verified GLOBAL');
  transaction_scope_changed exception (-20027, 'Coordinated transaction changed during entry');
  v_txn_before string;
  v_txn_after string;
  v_show_qid string;
  v_rows integer;
  v_exact integer;
  v_write_seq number(38,0);
begin
  select current_transaction() into :v_txn_before;
  if (v_txn_before is null) then
    raise coordination_requires_transaction;
  end if;
  update app.cloud_sync_coordination set write_seq = write_seq + 1 where lock_name = 'cloud_sync_writer';
  if (sqlrowcount <> 1) then
    raise coordination_lock_unavailable;
  end if;
  begin
    show parameters like 'READ_CONSISTENCY_MODE' in account;
    v_show_qid := sqlid;
    select count(*), count_if("key" = 'READ_CONSISTENCY_MODE' and "value" = 'GLOBAL' and "level" = 'ACCOUNT')
      into :v_rows, :v_exact
      from table(result_scan(:v_show_qid));
  exception
    when other then
      raise read_consistency_unverified;
  end;
  if (coalesce(v_rows, 0) <> 1 or coalesce(v_exact, 0) <> 1) then
    raise read_consistency_unverified;
  end if;
  select current_transaction() into :v_txn_after;
  if (v_txn_after is null or v_txn_after <> v_txn_before) then
    raise transaction_scope_changed;
  end if;
  select write_seq into :v_write_seq from app.cloud_sync_coordination where lock_name = 'cloud_sync_writer';
  if (v_write_seq is null or v_write_seq < 0 or v_write_seq > 9007199254740991) then
    raise coordination_lock_unavailable;
  end if;
  return v_write_seq;
end;
$$;
