-- C2-S5 SUBMIT_REVIEW proc (issue #313): one public review write followed
-- by recomputation of the affected reference summary.
--
-- Scope fence: this file creates exactly one object -- the procedure below.
-- No GRANT, role, table, view, function, or stage is created here.
--
-- §A resolves the anonymous public slug rather than accepting an internal
-- roast id, and fails closed unless exactly one non-private roast matches.
-- §B accepts only an already-hashed, SHA-256-shaped value: a raw IP never
-- enters this procedure, is never hashed here, and cannot land in storage.
-- The opportunistic purge is table-wide and sets expired hashes to NULL;
-- it never deletes tasting reviews. All temperatures are Celsius, with no
-- Fahrenheit value or conversion anywhere in this procedure.
-- Both guards raise before any write; insert, recompute, and purge form one
-- all-or-nothing transaction that rolls back and re-raises on any failure.
-- The pre-transaction slug check is a fast fail only: the INSERT revalidates
-- non-private visibility atomically and requires exactly one affected row.
--
-- The deploy connection sets no default schema (snowflake/README.md), so
-- relying on one would be fail-open -- this migration sets it explicitly
-- before the create.
use schema app;

create or replace procedure submit_review(
  p_public_slug string,
  p_reviewer_name string,
  p_score int,
  p_aroma smallint,
  p_acidity smallint,
  p_sweetness smallint,
  p_body smallint,
  p_aftertaste smallint,
  p_brew_method string,
  p_notes string,
  p_submitted_ip_hash string
)
copy grants
returns string
language sql
execute as owner
as
$$
declare
  slug_not_resolved exception (-20001, 'Public slug did not resolve uniquely');
  invalid_submitted_hash exception (-20002, 'Submitted hash must be 64 hexadecimal characters');
  invalid_score exception (-20017, 'Score must be an integer between 1 and 5');
  invalid_slider exception (-20018, 'Slider values must be between 0 and 100');
  v_count int;
  v_bean_origin string;
  v_roast_level string;
begin
  if (p_submitted_ip_hash is not null
      and not regexp_like(p_submitted_ip_hash, '^[0-9a-fA-F]{64}$')) then
    raise invalid_submitted_hash;
  end if;

  if (p_score is null or p_score < 1 or p_score > 5) then
    raise invalid_score;
  end if;

  if ((p_aroma      is not null and (p_aroma      < 0 or p_aroma      > 100))
   or (p_acidity    is not null and (p_acidity    < 0 or p_acidity    > 100))
   or (p_sweetness  is not null and (p_sweetness  < 0 or p_sweetness  > 100))
   or (p_body       is not null and (p_body       < 0 or p_body       > 100))
   or (p_aftertaste is not null and (p_aftertaste < 0 or p_aftertaste > 100))) then
    raise invalid_slider;
  end if;

  select count(*) into :v_count
  from app.cloud_roasts
  where public_slug = :p_public_slug
    and visibility <> 'private';

  if (v_count <> 1) then
    raise slug_not_resolved;
  end if;

  select bean_origin, roast_level
  into :v_bean_origin, :v_roast_level
  from app.cloud_roasts
  where public_slug = :p_public_slug
    and visibility <> 'private';

  let v_review_id string := uuid_string();

  begin
    begin transaction;
    insert into app.tasting_reviews (
      id, roast_id, reviewer_name, score, aroma, acidity, sweetness, body,
      aftertaste, brew_method, notes, submitted_ip_hash
    )
    select
      :v_review_id, r.id, :p_reviewer_name, :p_score, :p_aroma, :p_acidity,
      :p_sweetness, :p_body, :p_aftertaste, :p_brew_method, :p_notes,
      :p_submitted_ip_hash
    from app.cloud_roasts r
    where r.public_slug = :p_public_slug
      and r.visibility <> 'private';

    if (sqlrowcount <> 1) then
      raise slug_not_resolved;
    end if;

    call recompute_reference_summary(:v_bean_origin, :v_roast_level);

    update app.tasting_reviews
    set submitted_ip_hash = null
    where submitted_ip_hash is not null
      and created_at <= dateadd('day', -30, current_timestamp());
    commit;
  exception
    when other then
      rollback;
      raise;
  end;

  return v_review_id;
end;
$$;
