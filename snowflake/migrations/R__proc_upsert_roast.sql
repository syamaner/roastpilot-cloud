-- C9-C2: create is insert-only; per-field patches acknowledge ordered intent.
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
  writer_in_open_transaction exception (-20021, 'Writer must not run inside an open caller transaction');
  v_outer_txn string;
  v_write_seq number(38,0);
  identity_tombstoned exception (-20020, 'Roast identity is tombstoned');
  field_state_invalid exception (-20023, 'Field revision state is invalid');
  roast_not_found exception (-20024, 'Roast does not exist for this run id');
  v_state_count int;
  v_state_known int;
  v_state_invalid int;
  v_tombstone_count int;
  v_is_patch boolean;
  v_fields array;
  v_field_name string;
  v_entry variant;
  v_value variant;
  v_current variant;
  v_request_revision number(38,0);
  v_stored_revision number(38,0);
  v_outcome string;
  v_outcomes object default object_construct();
  v_value_valid boolean;
  v_any_applied boolean default false;
  v_consent_applied boolean default false;
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
  v_is_patch := array_size(object_keys(v_payload)) = 2
    and array_contains('patch_version'::variant, object_keys(v_payload))
    and array_contains('fields'::variant, object_keys(v_payload));
  if (v_is_patch) then
    if (typeof(v_payload:patch_version) <> 'INTEGER' or v_payload:patch_version::number <> 1
        or typeof(v_payload:fields) <> 'OBJECT'
        or array_size(object_keys(v_payload:fields)) < 1 or array_size(object_keys(v_payload:fields)) > 3) then
      raise invalid_payload;
    end if;
    v_fields := object_keys(v_payload:fields);
    for v_index in 0 to array_size(v_fields) - 1 do
      v_field_name := get(v_fields, v_index)::string;
      v_entry := get(v_payload:fields, v_field_name);
      if (v_field_name not in ('operator_rating', 'operator_notes', 'contributed_to_learning')
          or typeof(v_entry) <> 'OBJECT'
          or array_size(object_keys(v_entry)) <> 2
          or not array_contains('revision'::variant, object_keys(v_entry))
          or not array_contains('value'::variant, object_keys(v_entry))
          or typeof(v_entry:revision) <> 'INTEGER'
          or v_entry:revision::number < 1 or v_entry:revision::number > 9007199254740991) then
        raise invalid_payload;
      end if;
    end for;
  else
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

  -- #431 / D-431-D: enforce raw-IP-never-stored and Celsius-only on free text
  -- projected to roast_by_slug; operator_notes proactively enforces storage too.
  if (v_payload:bean_origin::string is not null
      and (regexp_count(v_payload:bean_origin::string, '([0-9]{1,3}[.]){3}[0-9]{1,3}') > 0
           or regexp_count(v_payload:bean_origin::string, '(([0-9A-Fa-f]{1,4}:){2,}[0-9A-Fa-f]{0,4})|(::([0-9A-Fa-f]{1,4}:?){1,})|(([0-9A-Fa-f]{1,4}:){1,}:)') > 0
           or regexp_count(v_payload:bean_origin::string, '(°[ ]?[Ff])|℉') > 0)
      or v_payload:bean_varietal::string is not null
      and (regexp_count(v_payload:bean_varietal::string, '([0-9]{1,3}[.]){3}[0-9]{1,3}') > 0
           or regexp_count(v_payload:bean_varietal::string, '(([0-9A-Fa-f]{1,4}:){2,}[0-9A-Fa-f]{0,4})|(::([0-9A-Fa-f]{1,4}:?){1,})|(([0-9A-Fa-f]{1,4}:){1,}:)') > 0
           or regexp_count(v_payload:bean_varietal::string, '(°[ ]?[Ff])|℉') > 0)
      or v_payload:profile_name::string is not null
      and (regexp_count(v_payload:profile_name::string, '([0-9]{1,3}[.]){3}[0-9]{1,3}') > 0
           or regexp_count(v_payload:profile_name::string, '(([0-9A-Fa-f]{1,4}:){2,}[0-9A-Fa-f]{0,4})|(::([0-9A-Fa-f]{1,4}:?){1,})|(([0-9A-Fa-f]{1,4}:){1,}:)') > 0
           or regexp_count(v_payload:profile_name::string, '(°[ ]?[Ff])|℉') > 0)
      or v_payload:roast_level::string is not null
      and (regexp_count(v_payload:roast_level::string, '([0-9]{1,3}[.]){3}[0-9]{1,3}') > 0
           or regexp_count(v_payload:roast_level::string, '(([0-9A-Fa-f]{1,4}:){2,}[0-9A-Fa-f]{0,4})|(::([0-9A-Fa-f]{1,4}:?){1,})|(([0-9A-Fa-f]{1,4}:){1,}:)') > 0
           or regexp_count(v_payload:roast_level::string, '(°[ ]?[Ff])|℉') > 0)
      or v_payload:summary:roaster_driver::string is not null
      and (regexp_count(v_payload:summary:roaster_driver::string, '([0-9]{1,3}[.]){3}[0-9]{1,3}') > 0
           or regexp_count(v_payload:summary:roaster_driver::string, '(([0-9A-Fa-f]{1,4}:){2,}[0-9A-Fa-f]{0,4})|(::([0-9A-Fa-f]{1,4}:?){1,})|(([0-9A-Fa-f]{1,4}:){1,}:)') > 0
           or regexp_count(v_payload:summary:roaster_driver::string, '(°[ ]?[Ff])|℉') > 0)
      or v_payload:summary:first_crack_model:repo_id::string is not null
      and (regexp_count(v_payload:summary:first_crack_model:repo_id::string, '([0-9]{1,3}[.]){3}[0-9]{1,3}') > 0
           or regexp_count(v_payload:summary:first_crack_model:repo_id::string, '(([0-9A-Fa-f]{1,4}:){2,}[0-9A-Fa-f]{0,4})|(::([0-9A-Fa-f]{1,4}:?){1,})|(([0-9A-Fa-f]{1,4}:){1,}:)') > 0
           or regexp_count(v_payload:summary:first_crack_model:repo_id::string, '(°[ ]?[Ff])|℉') > 0)
      or v_payload:operator_notes::string is not null
      and (regexp_count(v_payload:operator_notes::string, '([0-9]{1,3}[.]){3}[0-9]{1,3}') > 0
           or regexp_count(v_payload:operator_notes::string, '(([0-9A-Fa-f]{1,4}:){2,}[0-9A-Fa-f]{0,4})|(::([0-9A-Fa-f]{1,4}:?){1,})|(([0-9A-Fa-f]{1,4}:){1,}:)') > 0
           or regexp_count(v_payload:operator_notes::string, '(°[ ]?[Ff])|℉') > 0)) then
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

  end if;
  select current_transaction() into :v_outer_txn;
  if (v_outer_txn is not null) then
    raise writer_in_open_transaction;
  end if;
  begin
    begin transaction;
      call app.cloud_sync_enter() into :v_write_seq;
      if (v_is_patch) then
        select count(*) into :v_tombstone_count from app.cloud_roast_tombstones where idempotency_key = :p_run_id;
        if (v_tombstone_count > 0) then
          raise identity_tombstoned;
        end if;
      else
        select count(*) into :v_tombstone_count from app.cloud_roast_tombstones where idempotency_key = :p_run_id or public_slug = :v_public_slug;
        if (v_tombstone_count > 0) then
          raise identity_tombstoned;
        end if;
      end if;
      select count(*) into :v_existing_count from app.cloud_roasts where idempotency_key = :p_run_id;
      if (v_existing_count > 1) then
        raise ambiguous_idempotency_key;
      end if;
      if (v_is_patch and v_existing_count = 0) then
        raise roast_not_found;
      end if;
      if (v_existing_count = 1) then
        select id, public_slug, visibility, bean_origin, roast_level
          into :v_id, :v_slug, :v_stored_visibility, :v_new_bean_origin, :v_new_roast_level
          from app.cloud_roasts where idempotency_key = :p_run_id;
        select count(*) into :v_tombstone_count from app.cloud_roast_tombstones where cloud_roast_id = :v_id or public_slug = :v_slug;
        if (v_tombstone_count > 0) then
          raise identity_tombstoned;
        end if;
      select count(*), count(distinct case when field_name in ('operator_rating', 'operator_notes', 'contributed_to_learning') then field_name end),
             count_if(accepted_revision < 0 or accepted_revision > 9007199254740991 or accepted_write_seq < 0)
        into :v_state_count, :v_state_known, :v_state_invalid
        from app.cloud_roast_field_revisions where cloud_roast_id = :v_id;
      if (v_state_count <> 3 or v_state_known <> 3 or coalesce(v_state_invalid, 0) <> 0) then
        raise field_state_invalid;
      end if;
      end if;
      if (v_is_patch) then
        for v_index in 0 to array_size(v_fields) - 1 do
          v_field_name := get(v_fields, v_index)::string;
          v_entry := get(v_payload:fields, v_field_name);
          v_value := v_entry:value;
          v_request_revision := v_entry:revision::number;
          select accepted_revision into :v_stored_revision from app.cloud_roast_field_revisions
            where cloud_roast_id = :v_id and field_name = :v_field_name;
          select case :v_field_name when 'operator_rating' then to_variant(operator_rating)
                 when 'operator_notes' then to_variant(operator_notes)
                 when 'contributed_to_learning' then to_variant(contributed_to_learning) end
            into :v_current from app.cloud_roasts where id = :v_id;
          v_current := coalesce(v_current, parse_json('null'));
          v_value_valid := false;
          if (v_field_name = 'operator_rating') then
            v_value_valid := typeof(v_value) = 'NULL_VALUE' or (typeof(v_value) = 'INTEGER' and v_value::number between 1 and 5);
          elseif (v_field_name = 'operator_notes') then
            v_value_valid := typeof(v_value) in ('VARCHAR', 'NULL_VALUE');
            if (v_entry:value::string is not null
      and (regexp_count(v_entry:value::string, '([0-9]{1,3}[.]){3}[0-9]{1,3}') > 0
           or regexp_count(v_entry:value::string, '(([0-9A-Fa-f]{1,4}:){2,}[0-9A-Fa-f]{0,4})|(::([0-9A-Fa-f]{1,4}:?){1,})|(([0-9A-Fa-f]{1,4}:){1,}:)') > 0
           or regexp_count(v_entry:value::string, '(°[ ]?[Ff])|℉') > 0)) then
              v_value_valid := false;
            end if;
          elseif (v_field_name = 'contributed_to_learning') then
            v_value_valid := typeof(v_value) = 'BOOLEAN';
          end if;
          if (not v_value_valid) then
            v_outcome := 'rejected_value';
          elseif (v_request_revision > v_stored_revision) then
            if (v_field_name = 'operator_rating') then
              update app.cloud_roasts set operator_rating = iff(typeof(:v_value) = 'NULL_VALUE', null, :v_value::int) where id = :v_id;
            elseif (v_field_name = 'operator_notes') then
              update app.cloud_roasts set operator_notes = iff(typeof(:v_value) = 'NULL_VALUE', null, :v_value::string) where id = :v_id;
            else
              update app.cloud_roasts set contributed_to_learning = :v_value::boolean where id = :v_id;
              v_consent_applied := true;
            end if;
            update app.cloud_roast_field_revisions set accepted_revision = :v_request_revision, accepted_write_seq = :v_write_seq
              where cloud_roast_id = :v_id and field_name = :v_field_name;
            v_stored_revision := v_request_revision;
            v_any_applied := true;
            v_outcome := 'applied';
          elseif (v_request_revision = v_stored_revision and v_value is not distinct from v_current) then
            v_outcome := 'already_applied';
          elseif (v_request_revision = v_stored_revision) then
            v_outcome := 'revision_conflict';
          else
            v_outcome := 'stale';
          end if;
          v_outcomes := object_insert(v_outcomes, v_field_name, object_construct('outcome', v_outcome, 'accepted_revision', v_stored_revision));
        end for;
        if (v_any_applied) then
          update app.cloud_roasts set updated_at = current_timestamp() where id = :v_id;
        end if;
        if (v_consent_applied) then
          call app.recompute_reference_summary(:v_new_bean_origin, :v_new_roast_level);
        end if;
      else
        if (v_existing_count = 0) then
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

          insert into app.cloud_roast_field_revisions (cloud_roast_id, field_name, accepted_revision, accepted_write_seq)
          select :v_id, column1, 0, :v_write_seq from values ('operator_rating'), ('operator_notes'), ('contributed_to_learning');
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
          select bean_origin, roast_level into :v_new_bean_origin, :v_new_roast_level from app.cloud_roasts where id = :v_id;
          call app.recompute_reference_summary(:v_new_bean_origin, :v_new_roast_level);
        else
          if (v_visibility is distinct from v_stored_visibility) then
            raise visibility_change_not_supported;
          end if;
          select count(*) into :v_slug_count from app.cloud_roasts where public_slug = :v_slug;
          if (v_slug_count <> 1) then
            raise duplicate_public_slug;
          end if;
        end if;
      end if;
    commit;
  exception
    when other then
      rollback;
      raise;
  end;
  if (v_is_patch) then
    return object_construct('patch_version', 1, 'cloud_roast_id', v_id, 'fields', v_outcomes);
  end if;
  return object_construct('cloud_roast_id', v_id, 'public_slug', v_slug);
end;
$$;
