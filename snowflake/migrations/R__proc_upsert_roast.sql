-- C3-S2 UPSERT_ROAST proc (issue #417): validate and upsert one agent roast,
-- replace its artifact manifest, and recompute affected reference summaries.
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
-- than LOAD_ROAST_TELEMETRY's run-id grammar by design, because #341 will consume
-- the persisted path in REMOVE; #341 must still validate the stored path again.
--
-- The payload is a closed 13-key grammar. Failures raise a static message so
-- roast metadata is never echoed into logs. Offline guard tests use Python re,
-- while Snowflake REGEXP_LIKE uses RE2; exact equivalence remains live-gate-only.
--
-- Replays preserve id, idempotency_key, owner_id, public_slug, visibility, and
-- created_at.
-- Artifact replacement is idempotent over (roast_id, kind, stage_path) triples,
-- not artifact row ids, which are regenerated on replay. Paths are constructed
-- as @app.roast_artifacts/<run_id>/<basename> from a closed kind map. The agent
-- connector must PUT the exact lowercase basenames with AUTO_COMPRESS=FALSE.
-- A shrinking artifact_kinds replay can leave dropped files without manifest
-- rows, so #341's deletion contract is directory-scoped: derive the run id from
-- cloud_roasts.idempotency_key and REMOVE @app.roast_artifacts/<run_id>/ rather
-- than iterating the surviving per-row stage_path values.
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
  duplicate_public_slug exception (-20011, 'Public slug did not resolve uniquely');
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
      and try_to_timestamp_tz(v_payload:roasted_at_utc::string) is null) then
    raise invalid_payload;
  end if;

  if (typeof(v_payload:artifact_kinds) <> 'ARRAY') then
    raise invalid_payload;
  end if;
  v_artifact_kinds := v_payload:artifact_kinds;
  select count(*), count(distinct value::string),
         count_if(typeof(value) <> 'VARCHAR'),
         count_if(typeof(value) = 'VARCHAR'
                  and value::string not in ('jsonl', 'csv', 'summary'))
    into :v_artifact_count, :v_distinct_artifact_count,
         :v_invalid_artifact_type_count, :v_unknown_artifact_count
    from table(flatten(input => :v_artifact_kinds));
  if (v_artifact_count = 0
      or v_distinct_artifact_count <> v_artifact_count
      or v_invalid_artifact_type_count <> 0
      or v_unknown_artifact_count <> 0) then
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
      -- Count the stored immutable slug, not a differing replay input slug.
      v_public_slug := v_slug;
      select count(*) into :v_slug_count
        from app.cloud_roasts where public_slug = :v_public_slug;
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
