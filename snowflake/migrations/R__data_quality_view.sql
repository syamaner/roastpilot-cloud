-- C2-S8 data-quality audit view (issue #316): the live counterpart to the
-- five declarative constraint checks in scripts/seed/rules.ts, expanded to
-- exactly ten branches so each nullable slider is independently auditable.
-- Repeatable (R__) migration -- schemachange re-applies it whenever its
-- checksum changes, ordered after the versioned set, so it runs after
-- V1.1.0__base_tables.sql. Grants are deliberately not copied: this view is
-- granted to nobody, so each re-apply resets it to owner-only and fails
-- closed against an accidental PUBLIC_WEB grant. Any future legitimate grant
-- belongs in R__z_roles_grants.sql, which sorts after this migration.
--
-- Scope fence: this file only creates the internal audit view below; it
-- grants no privileges and projects only non-PII violation metadata.
--
-- The deploy connection sets no default schema (snowflake/README.md), so
-- relying on one would be fail-open -- this migration sets it explicitly
-- before the create.
use schema app;

create or replace view data_quality_violations as
select
  'tasting_reviews' as table_name,
  id as row_identity,
  'score' as field,
  'score out of 1-5' as rule
from tasting_reviews
where score < 1 or score > 5

union all

select
  'cloud_roasts' as table_name,
  id as row_identity,
  'operator_rating' as field,
  'operator_rating out of 1-5' as rule
from cloud_roasts
where operator_rating is not null
  and (operator_rating < 1 or operator_rating > 5)

union all

select
  'tasting_reviews' as table_name,
  id as row_identity,
  'aroma' as field,
  'slider out of 0-100' as rule
from tasting_reviews
where aroma is not null and (aroma < 0 or aroma > 100)

union all

select
  'tasting_reviews' as table_name,
  id as row_identity,
  'acidity' as field,
  'slider out of 0-100' as rule
from tasting_reviews
where acidity is not null and (acidity < 0 or acidity > 100)

union all

select
  'tasting_reviews' as table_name,
  id as row_identity,
  'sweetness' as field,
  'slider out of 0-100' as rule
from tasting_reviews
where sweetness is not null and (sweetness < 0 or sweetness > 100)

union all

select
  'tasting_reviews' as table_name,
  id as row_identity,
  'body' as field,
  'slider out of 0-100' as rule
from tasting_reviews
where body is not null and (body < 0 or body > 100)

union all

select
  'tasting_reviews' as table_name,
  id as row_identity,
  'aftertaste' as field,
  'slider out of 0-100' as rule
from tasting_reviews
where aftertaste is not null and (aftertaste < 0 or aftertaste > 100)

union all

select
  'cloud_roasts' as table_name,
  id as row_identity,
  'visibility' as field,
  'visibility not in allowed set' as rule
from cloud_roasts
where visibility not in ('private', 'unlisted', 'public')

union all

select
  'cloud_roasts' as table_name,
  idempotency_key as row_identity,
  'idempotency_key' as field,
  'duplicate idempotency_key' as rule
from cloud_roasts
group by idempotency_key
having count(*) > 1

union all

select
  'cloud_roasts' as table_name,
  any_value(id) as row_identity,
  'public_slug' as field,
  'duplicate public_slug' as rule
from cloud_roasts
group by public_slug
having count(*) > 1

union all

select 'cloud_roasts' as table_name, r.id as row_identity, 'tombstone' as field, 'live roast matches tombstone' as rule
from cloud_roasts r where exists (select 1 from cloud_roast_tombstones t where t.idempotency_key = r.idempotency_key or t.public_slug = r.public_slug or t.cloud_roast_id = r.id)

union all

select 'cloud_roast_tombstones' as table_name, idempotency_key as row_identity, 'idempotency_key' as field, 'duplicate tombstone idempotency_key' as rule
from cloud_roast_tombstones group by idempotency_key having count(*) > 1

union all

select 'cloud_roast_tombstones' as table_name, any_value(idempotency_key) as row_identity, 'public_slug' as field, 'duplicate tombstone public_slug' as rule
from cloud_roast_tombstones group by public_slug having count(*) > 1

union all

select 'cloud_roast_tombstones' as table_name, any_value(idempotency_key) as row_identity, 'cloud_roast_id' as field, 'duplicate tombstone cloud_roast_id' as rule
from cloud_roast_tombstones where cloud_roast_id is not null group by cloud_roast_id having count(*) > 1

union all

select 'cloud_sync_coordination' as table_name, 'cloud_sync_writer' as row_identity, 'lock_name' as field, 'coordination row set not exactly one lock row' as rule
from cloud_sync_coordination having count(*) <> 1 or coalesce(count_if(lock_name = 'cloud_sync_writer'), 0) <> 1

union all

select 'cloud_sync_coordination' as table_name, lock_name as row_identity, 'write_seq' as field, 'coordination write_seq out of range' as rule
from cloud_sync_coordination where write_seq < 0 or write_seq > 9007199254740991

union all

select 'cloud_roasts' as table_name, r.id as row_identity, 'field_revisions' as field, 'field revision rows not exactly three known fields' as rule
from cloud_roasts r left join cloud_roast_field_revisions f on f.cloud_roast_id = r.id group by r.id
having count(f.field_name) <> 3 or count(distinct case when f.field_name in ('operator_rating', 'operator_notes', 'contributed_to_learning') then f.field_name end) <> 3

union all

select 'cloud_roast_field_revisions' as table_name, cloud_roast_id as row_identity, field_name as field, 'unknown field or orphan revision' as rule
from cloud_roast_field_revisions where field_name not in ('operator_rating', 'operator_notes', 'contributed_to_learning') or not exists (select 1 from cloud_roasts r where r.id = cloud_roast_id)

union all

select 'cloud_roast_field_revisions' as table_name, cloud_roast_id as row_identity, field_name as field, 'revision value out of range' as rule
from cloud_roast_field_revisions where accepted_revision < 0 or accepted_revision > 9007199254740991 or accepted_write_seq < 0

union all

select 'cloud_roast_field_revisions' as table_name, cloud_roast_id as row_identity, field_name as field, 'accepted_write_seq above coordination write_seq' as rule
from cloud_roast_field_revisions where accepted_write_seq > (select max(write_seq) from cloud_sync_coordination where lock_name = 'cloud_sync_writer')

union all

select 'cloud_roast_tombstones' as table_name, idempotency_key as row_identity, 'deletion_write_seq' as field, 'tombstone sequence invalid' as rule
from cloud_roast_tombstones where deletion_write_seq is not null and (deletion_write_seq < 0 or deletion_write_seq > (select max(write_seq) from cloud_sync_coordination where lock_name = 'cloud_sync_writer'));
