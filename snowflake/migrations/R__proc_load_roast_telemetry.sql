-- C3-S1 LOAD_ROAST_TELEMETRY proc (issue #416): replace one roast's telemetry
-- from its validated, staged JSONL export.
--
-- Scope fence: this file creates exactly one object -- the procedure below.
-- It contains zero GRANT statements and creates no other object.
--
-- D-446-H (#446): this procedure now executes as owner. Guard 3 plus the
-- consent-conditioned INSERT are the enforcement boundary for telemetry writes
-- through this procedure. Owner-rights is safe here because the body selects no
-- object dynamically: the write target is hard-coded, and both interpolants are
-- grammar-validated by Guards 1 and 2. Guard 2 also rejects `--`, the sole
-- reachable SQL comment sequence in the unquoted stage path. The owner's other
-- privileges are therefore unreachable through this procedure. Any future edit
-- introducing dynamic object selection would break this injection-free safety
-- property and must draw schema-migration-reviewer + privacy-auditor.
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
-- #419/#446: Guard 3 remains the clear pre-transaction fast-fail. The INSERT
-- atomically re-checks consent committed before that statement starts, closing
-- that check-then-write gap. Under read-committed it does not serialize against
-- a concurrent uncommitted UPSERT_ROAST opt-out, so that cross-procedure race is
-- a documented residual. The #446 Slice A revoke has landed and was
-- live-verified: the agent's direct telemetry DML is revoked (SELECT-only), so
-- Guard 3 plus the consent-conditioned INSERT are now the sole write boundary,
-- while ROAST_BY_SLUG and recompute independently gate reads on consent.
-- The agent retains stage WRITE; its direct telemetry DML is revoked per #446
-- Slice A, and its direct artifact-table DML is revoked per the #446
-- artifact-table revoke. D-446-N split requirement (b); its stage-file half is
-- an accepted residual per D-446-P. Stage WRITE is retained by design because
-- revoking it is availability-loss with no security gain: no owner-rights PUT
-- path exists, and the connector PUTs as the agent. Opted-out staged exports
-- linger as inert non-PII with no public read path (roast_artifacts is in
-- neither secure view). Their purge lifecycle is owned by deletion / #341,
-- which is deferred and wait-to-implement under D-341-B; its eventual
-- directory-prefix REMOVE is scoped to deletion time, not opt-out.
--
-- The two recompute call sites cover distinct changes and both are required:
-- UPSERT_ROAST's recompute covers metadata/membership change, including the
-- two-group recompute on a group change; this procedure's recompute covers
-- telemetry arrival. A first sync recomputes twice, once from UPSERT_ROAST with
-- no telemetry yet and once from this load. That is accepted and idempotent
-- because RECOMPUTE_REFERENCE_SUMMARY is a full MERGE recomputation of the group.
-- This recompute reads the loaded roast's (bean_origin, roast_level) from
-- app.cloud_roasts by p_roast_id inside the load transaction, so it observes the
-- freshly inserted (uncommitted) rows.
--
-- #430 Decision 2 (this recompute) is implemented; Decision 3 (the
-- run_id↔roast_id binding) is implemented as pre-transaction Guard 4
-- (the run id resolves globally to exactly one roast, which must be
-- `p_roast_id`; either mismatch raises -20014) plus the in-INSERT binding
-- predicates. The binding rule is that the run id must equal the roast's
-- idempotency key. D-430-C forward constraint:
-- the C3 connector MUST call with p_run_id = the roast's idempotency_key; the
-- procedure enforces it fail-closed. This is the #446 requirement-(b)
-- prerequisite -- so preserve Guard 3's pre-transaction placement.
--
-- The deploy connection sets no default schema (snowflake/README.md), so this
-- migration explicitly selects APP before creating the procedure.
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
  roast_not_contributing exception (-20013, 'Roast has not consented to learning');
  run_roast_mismatch exception (-20014, 'Run id and roast id do not identify the same roast');
  v_total_count int;
  v_contributing_count int;
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

  -- Guard 3 (#419 requirement (a)): clear pre-transaction consent fast-fail.
  -- The INSERT below repeats this condition atomically at the write boundary:
  -- exactly one row must match and it must be opted in, so an absent, opted-out,
  -- mixed, or duplicate-id set cannot pass during a consent race.
  -- Refuse the load unless the stored roast consent is affirmatively true.
  -- count(*) makes an empty id match unambiguously 0; coalesce guards against
  -- count_if returning NULL when no matching row satisfies the predicate (an
  -- opted-out single-row roast), which would otherwise make the comparison NULL
  -- and skip the raise -- a fail-open. Exact-one comparisons refuse every
  -- ambiguous duplicate-id set, including two rows that are both opted in.
  select
      count(*),
      coalesce(count_if(contributed_to_learning = true), 0)
    into :v_total_count, :v_contributing_count
    from app.cloud_roasts
    where id = :p_roast_id;
  if (v_total_count <> 1 or v_contributing_count <> 1) then
    raise roast_not_contributing;
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
        '  and $1:type::string = ''telemetry'' ' ||
        '  and (select count(*) from app.cloud_roasts where id = ''' || p_roast_id || ''') = 1 ' ||
        '  and (select count(*) from app.cloud_roasts where id = ''' || p_roast_id || ''' and coalesce(contributed_to_learning, false) = true) = 1' ||
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
