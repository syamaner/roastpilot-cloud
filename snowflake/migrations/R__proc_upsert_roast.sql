-- C3-S2 UPSERT_ROAST proc (issue #417): validate and upsert one agent roast,
-- replace its artifact manifest, and recompute affected reference summaries.
-- On a first sync, recompute_reference_summary runs before the current sync's
-- replacement telemetry is loaded because upsert_roast mints and returns the
-- roast id required by load_roast_telemetry. Its aggregates therefore exclude
-- this roast's telemetry. On replay, the caller already has the preserved roast
-- id and can order load_roast_telemetry before or after this procedure. Under
-- upsert-first ordering, replay aggregates for a contributing roast with both
-- bean_origin and roast_level populated combine the previous sync's telemetry
-- with the current sync's metadata. plan.md section 5 places telemetry before
-- the upsert, which is not executable on a first sync with the current signatures.
-- #430 owns the unresolved replay ordering.
--
-- Scope fence: this file creates exactly one object -- the procedure below.
-- It contains zero GRANT statements and creates no other object. The procedure
-- uses only static SQL. Under execute-as-owner the closed input guards are the
-- authorization boundary, so no caller value is ever interpolated into SQL.
--
-- Both arguments deliberately remain STRING. The live grant audit has confirmed
-- type aliases only for STRING, INT, and SMALLINT, and its bare lookup would fail
-- closed on an unconfirmed signature type. The run id is both idempotency key and
-- artifact-directory key by construction. Its lowercase UUID grammar is stricter
-- than LOAD_ROAST_TELEMETRY's run-id grammar by design. Under D-341-A, #341
-- requires DELETE_ROAST to construct the destructive directory prefix solely
-- from that run id and independently guard the derived run id with the same exact
-- lowercase UUID grammar. The strict grammar here keeps stored run ids inside
-- the grammar that DELETE_ROAST's independent guard will accept. A weaker grammar
-- here would admit run ids that guard rejects, leaving those roasts undeletable
-- with their staged files in place. It would not widen what REMOVE can target
-- unless both guards were weakened.
--
-- The payload is a closed 13-key grammar. Guard failures raise a static message
-- so roast metadata is never echoed into logs by those guards. Unvalidated
-- summary contents can still reach recompute_reference_summary casts, whose
-- Snowflake-generated errors can quote caller text and propagate unmodified
-- through the bare exception handler to the caller and query history.
-- Offline guard tests use Python re, while Snowflake REGEXP_LIKE uses RE2; exact
-- equivalence remains live-gate-only.
-- The summary VARIANT is validated only as a JSON object, with no validation of
-- its contents, and is projected wholesale into the roast_by_slug secure view.
-- For a roast whose visibility is not private, a raw IP address or a Fahrenheit
-- value in the agent's export is therefore available to PUBLIC_WEB through the
-- public read surface.
-- For a contributing roast with both bean_origin and roast_level populated,
-- recompute_reference_summary also reads the stored contents, casts their timing
-- values, and averages them into the shared reference_roast_summaries row for
-- the roast's (bean_origin, roast_level) group.
-- The procedure type-narrows the other twelve payload keys despite direct
-- cloud_roasts DML, but bean_origin, bean_varietal, profile_name, and roast_level
-- remain content-unvalidated projected free text. For summary itself it adds only
-- the top-level OBJECT check; #431's enforcement scope includes those free-text
-- keys and summary. The exposure is currently zero-instance because
-- roastpilot-agent has no cloud_sync module. Before a real caller ships, #431
-- requires enforcement. A curated view projection or a scan-only remedy does not
-- cover the aggregate path because it is a write-side read of the stored VARIANT;
-- only closed write-boundary validation covers both consumers. D-312-M is only a
-- possible precedent for the scan; by-construction does not transfer because
-- summary originates in the agent's export.
-- The cloud roasted_at_utc trailing-offset grammar is deliberately narrower than
-- seed_validate_live.py's trailing-offset grammar: numeric offsets must be
-- colon-separated, and the connector must emit either that form or uppercase Z.
-- This is not a general grammar comparison: the regex prefix is unconstrained,
-- and try_to_timestamp_tz may accept date spellings that seed_validate_live.py's
-- datetime.fromisoformat rejects.
-- Per #419, the empty-manifest guard rejects an opted-out roast that declares a
-- non-empty artifact manifest (contributed_to_learning = false and
-- artifact_count <> 0) before any write. This is a path-local raise on this
-- upsert path, not an enforcement boundary for the artifact-row half of
-- requirement (b): the agent role holds direct artifact-table DML independently.
-- contributed_to_learning = true is deliberately unconstrained and may also have
-- an empty manifest.
-- The telemetry purge is only a transactional best-effort revocation on this
-- upsert path, not an enforcement boundary: it removes the previously published
-- curve at the instant of the upsert. It does not close the revocation-replay
-- case either: load_roast_telemetry's Guard 3 is defence-in-depth only, and the
-- agent holds direct insert on app.roast_telemetry, so nothing prevents the purged
-- rows from being re-inserted from the still-staged export. With the current
-- signatures, the telemetry load necessarily runs after this procedure returns
-- on a first sync, so the purge does not cover a first-sync opt-out. On replay,
-- the caller has the preserved roast id and can load telemetry before or after
-- this procedure. plan.md section 5 specifies telemetry-first, and #430 owns the
-- unresolved replay ordering. Procedure-level enforcement is impossible while
-- the agent role holds direct telemetry-table DML; #419 owns that enforcement
-- contract.
-- Both halves of (b) remain open. The stage-file half is also open because staged
-- files survive an opt-out: the agent holds stage WRITE independently (#317), and
-- #341's directory-prefix REMOVE runs at deletion time rather than opt-out.
--
-- Replays preserve id, idempotency_key, owner_id, public_slug, visibility, and
-- created_at.
-- A divergent public_slug is deliberately tolerated because server-side slug
-- rotation (C4 regenerate_slug, including duplicate repair) is legitimate and
-- preserving the stored slug is correct. A divergent visibility is rejected:
-- silently preserving it could make a caller believe a revocation to private
-- succeeded. The actual visibility-update path remains deferred to C4.
-- Artifact replacement is idempotent over (roast_id, kind, stage_path) triples,
-- not artifact row ids, which are regenerated on replay. Paths are constructed
-- as @app.roast_artifacts/<run_id>/<basename> from a closed kind map. The agent
-- connector must PUT the exact lowercase basenames with AUTO_COMPRESS=FALSE.
-- A shrinking artifact_kinds replay can leave dropped files without surviving
-- manifest rows, which per-row stage_path iteration cannot see. D-341-A requires
-- #341 to read idempotency_key from cloud_roasts, fail closed unless the derived
-- run id matches the exact lowercase-UUID grammar, and issue one directory-scoped
-- REMOVE of @app.roast_artifacts/<run_id>/. Its guard validates the derived run
-- id rather than the stored path, and the procedure constructs the prefix itself
-- without interpolating a stored stage_path value.
-- The post-MERGE count guards catch pre-existing duplicate idempotency keys and
-- public slugs and fail closed. They close sequential/replay cases, but concurrent
-- MERGE snapshot visibility remains unverified in both directions until a live
-- gate proves it; neither guard is claimed to close that concurrency residual.
--
-- The deploy connection sets no default schema (snowflake/README.md), so this
-- migration explicitly selects APP before creating the procedure.
use schema app;

create or replace procedure upsert_roast(p_run_id string, p_payload string)
copy grants
returns variant
language sql
execute as owner
as
$$
declare
  invalid_run_id exception (-20008, 'Run id must be a lowercase UUID');
  invalid_payload exception (-20009, 'Payload does not match the closed roast grammar');
  ambiguous_idempotency_key exception (-20010, 'Idempotency key did not resolve uniquely');
  duplicate_public_slug exception (-20011, 'Public slug is not unique across roasts');
  visibility_change_not_supported exception (-20012, 'Visibility changes are not supported by upsert_roast');
  v_payload variant;
  v_artifact_kinds array;
  v_artifact_count int;
  v_distinct_artifact_count int;
  v_invalid_artifact_type_count int;
  v_unknown_artifact_count int;
  v_existing_count int;
  v_count int;
  v_slug_count int;
  v_id string;
  v_slug string;
  v_stored_visibility string;
  v_old_bean_origin string;
  v_old_roast_level string;
  v_new_bean_origin string;
  v_new_roast_level string;
  v_public_slug string;
  v_visibility string;
  v_bean_origin string;
  v_bean_varietal string;
  v_bean_weight_g float;
  v_profile_name string;
  v_roast_level string;
  v_summary variant;
  v_operator_rating int;
  v_operator_notes string;
  v_contributed_to_learning boolean;
  v_roasted_at_utc timestamp_tz;
begin
  -- Guard 1: byte-identical lowercase UUID grammar to DELETE_ROAST.
  if (p_run_id is null
      or not regexp_like(p_run_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
    raise invalid_run_id;
  end if;

  -- Guard 2: valid JSON object with exactly the independently enumerated keys.
  v_payload := try_parse_json(p_payload);
  if (v_payload is null or typeof(v_payload) <> 'OBJECT') then
    raise invalid_payload;
  end if;
  if (array_size(object_keys(v_payload)) <> 13
      or not array_contains('public_slug'::variant, object_keys(v_payload))
      or not array_contains('visibility'::variant, object_keys(v_payload))
      or not array_contains('bean_origin'::variant, object_keys(v_payload))
      or not array_contains('bean_varietal'::variant, object_keys(v_payload))
      or not array_contains('bean_weight_g'::variant, object_keys(v_payload))
      or not array_contains('profile_name'::variant, object_keys(v_payload))
      or not array_contains('roast_level'::variant, object_keys(v_payload))
      or not array_contains('operator_rating'::variant, object_keys(v_payload))
      or not array_contains('operator_notes'::variant, object_keys(v_payload))
      or not array_contains('contributed_to_learning'::variant, object_keys(v_payload))
      or not array_contains('roasted_at_utc'::variant, object_keys(v_payload))
      or not array_contains('summary'::variant, object_keys(v_payload))
      or not array_contains('artifact_kinds'::variant, object_keys(v_payload))) then
    raise invalid_payload;
  end if;

  if (typeof(v_payload:public_slug) <> 'VARCHAR') then
    raise invalid_payload;
  end if;
  if (not regexp_like(v_payload:public_slug::string, '^[1-9A-HJ-NP-Za-km-z]{17,64}$')) then
    raise invalid_payload;
  end if;

  if (typeof(v_payload:visibility) <> 'VARCHAR') then
    raise invalid_payload;
  end if;
  if (v_payload:visibility::string not in ('private', 'unlisted', 'public')) then
    raise invalid_payload;
  end if;

  if (typeof(v_payload:bean_origin) not in ('VARCHAR', 'NULL_VALUE')
      or typeof(v_payload:bean_varietal) not in ('VARCHAR', 'NULL_VALUE')
      or typeof(v_payload:profile_name) not in ('VARCHAR', 'NULL_VALUE')
      or typeof(v_payload:roast_level) not in ('VARCHAR', 'NULL_VALUE')
      or typeof(v_payload:operator_notes) not in ('VARCHAR', 'NULL_VALUE')) then
    raise invalid_payload;
  end if;
  if (typeof(v_payload:bean_weight_g) not in ('INTEGER', 'DECIMAL', 'DOUBLE', 'NULL_VALUE')) then
    raise invalid_payload;
  end if;

  if (typeof(v_payload:operator_rating) not in ('INTEGER', 'NULL_VALUE')) then
    raise invalid_payload;
  end if;
  if (typeof(v_payload:operator_rating) = 'INTEGER'
      and (v_payload:operator_rating::int < 1 or v_payload:operator_rating::int > 5)) then
    raise invalid_payload;
  end if;

  if (typeof(v_payload:contributed_to_learning) <> 'BOOLEAN'
      or typeof(v_payload:summary) <> 'OBJECT') then
    raise invalid_payload;
  end if;

  if (typeof(v_payload:roasted_at_utc) not in ('VARCHAR', 'NULL_VALUE')) then
    raise invalid_payload;
  end if;
  if (typeof(v_payload:roasted_at_utc) = 'VARCHAR'
      and not regexp_like(v_payload:roasted_at_utc::string,
                          '^.*(Z|[+-][0-9]{2}:[0-9]{2})$')) then
    raise invalid_payload;
  end if;
  if (typeof(v_payload:roasted_at_utc) = 'VARCHAR'
      and try_to_timestamp_tz(v_payload:roasted_at_utc::string) is null) then
    raise invalid_payload;
  end if;

  if (typeof(v_payload:artifact_kinds) <> 'ARRAY') then
    raise invalid_payload;
  end if;
  v_artifact_kinds := v_payload:artifact_kinds;
  select count(*), count(distinct value::string),
         coalesce(count_if(typeof(value) <> 'VARCHAR'), 0),
         coalesce(count_if(typeof(value) = 'VARCHAR'
                           and value::string not in ('jsonl', 'csv', 'summary')), 0)
    into :v_artifact_count, :v_distinct_artifact_count,
         :v_invalid_artifact_type_count, :v_unknown_artifact_count
    from table(flatten(input => :v_artifact_kinds));
  if (v_distinct_artifact_count <> v_artifact_count
      or v_invalid_artifact_type_count <> 0
      or v_unknown_artifact_count <> 0) then
    raise invalid_payload;
  end if;
  if (v_payload:contributed_to_learning::boolean = false
      and v_artifact_count <> 0) then
    raise invalid_payload;
  end if;

  -- Values are assigned only after their types and ranges have passed.
  v_public_slug := v_payload:public_slug::string;
  v_visibility := v_payload:visibility::string;
  v_bean_origin := v_payload:bean_origin::string;
  v_bean_varietal := v_payload:bean_varietal::string;
  v_bean_weight_g := v_payload:bean_weight_g::float;
  v_profile_name := v_payload:profile_name::string;
  v_roast_level := v_payload:roast_level::string;
  v_summary := v_payload:summary;
  v_operator_rating := v_payload:operator_rating::int;
  v_operator_notes := v_payload:operator_notes::string;
  v_contributed_to_learning := v_payload:contributed_to_learning::boolean;
  v_roasted_at_utc := v_payload:roasted_at_utc::timestamp_tz;

  begin
    begin transaction;
      -- Capture the old group in the same transaction snapshot as the MERGE.
      select count(*), any_value(bean_origin), any_value(roast_level)
        into :v_existing_count, :v_old_bean_origin, :v_old_roast_level
        from app.cloud_roasts where idempotency_key = :p_run_id;

      merge into app.cloud_roasts as target
      using (
        select uuid_string() as id, :p_run_id as idempotency_key,
               null::string as owner_id, :v_public_slug as public_slug,
               :v_visibility as visibility, :v_bean_origin as bean_origin,
               :v_bean_varietal as bean_varietal, :v_bean_weight_g as bean_weight_g,
               :v_profile_name as profile_name, :v_roast_level as roast_level,
               :v_summary as summary, :v_operator_rating as operator_rating,
               :v_operator_notes as operator_notes,
               :v_contributed_to_learning as contributed_to_learning,
               :v_roasted_at_utc as roasted_at_utc,
               current_timestamp() as created_at, current_timestamp() as updated_at
      ) as source
      on target.idempotency_key = source.idempotency_key
      when matched then update set
        bean_origin = source.bean_origin,
        bean_varietal = source.bean_varietal,
        bean_weight_g = source.bean_weight_g,
        profile_name = source.profile_name,
        roast_level = source.roast_level,
        summary = source.summary,
        operator_rating = source.operator_rating,
        operator_notes = source.operator_notes,
        contributed_to_learning = source.contributed_to_learning,
        roasted_at_utc = source.roasted_at_utc,
        updated_at = current_timestamp()
      when not matched then insert (
        id, idempotency_key, owner_id, public_slug, visibility, bean_origin,
        bean_varietal, bean_weight_g, profile_name, roast_level, summary,
        operator_rating, operator_notes, contributed_to_learning, roasted_at_utc,
        created_at, updated_at
      ) values (
        source.id, source.idempotency_key, source.owner_id, source.public_slug,
        source.visibility, source.bean_origin, source.bean_varietal,
        source.bean_weight_g, source.profile_name, source.roast_level,
        source.summary, source.operator_rating, source.operator_notes,
        source.contributed_to_learning, source.roasted_at_utc,
        source.created_at, source.updated_at
      );

      -- Guard 3: duplicate target keys are not rejected by Snowflake MERGE.
      select count(*) into :v_count
        from app.cloud_roasts where idempotency_key = :p_run_id;
      if (v_count <> 1) then
        raise ambiguous_idempotency_key;
      end if;

      -- Read the stable return pair and post-merge group from the stored row.
      select id, public_slug into :v_id, :v_slug
        from app.cloud_roasts where idempotency_key = :p_run_id;

      select visibility into :v_stored_visibility
        from app.cloud_roasts where idempotency_key = :p_run_id;
      if (v_visibility is distinct from v_stored_visibility) then
        raise visibility_change_not_supported;
      end if;

      -- Count the stored slug, not a differing replay input slug.
      select count(*) into :v_slug_count
        from app.cloud_roasts where public_slug = :v_slug;
      if (v_slug_count <> 1) then
        raise duplicate_public_slug;
      end if;

      select bean_origin, roast_level into :v_new_bean_origin, :v_new_roast_level
        from app.cloud_roasts where idempotency_key = :p_run_id;

      call app.recompute_reference_summary(:v_new_bean_origin, :v_new_roast_level);
      if (v_existing_count > 0
          and v_old_bean_origin is not null
          and v_old_roast_level is not null
          and (v_old_bean_origin is distinct from v_new_bean_origin
               or v_old_roast_level is distinct from v_new_roast_level)) then
        call app.recompute_reference_summary(:v_old_bean_origin, :v_old_roast_level);
      end if;

      -- #419 requirement (a): purge telemetry only on opt-out as a consent revocation, not cleanup.
      if (v_contributed_to_learning = false) then
        delete from app.roast_telemetry where roast_id = :v_id;
      end if;

      delete from app.roast_artifacts where roast_id = :v_id;
      insert into app.roast_artifacts (
        id, roast_id, kind, stage_path, byte_size, created_at
      )
      select uuid_string(), :v_id, artifact.value::string,
             '@app.roast_artifacts/' || :p_run_id || '/' ||
               case artifact.value::string
                 when 'jsonl' then 'roast.jsonl'
                 when 'csv' then 'roast.csv'
                 when 'summary' then 'summary.json'
               end,
             null, current_timestamp()
        from table(flatten(input => :v_artifact_kinds)) artifact;
    commit;
  exception
    when other then
      rollback;
      raise;
  end;

  return object_construct('cloud_roast_id', v_id, 'public_slug', v_slug);
end;
$$;
