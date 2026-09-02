-- C2-S8 data-quality audit view (issue #316): the live counterpart to the
-- four declarative constraint checks in scripts/seed/rules.ts, expanded to
-- exactly nine branches so each nullable slider is independently auditable.
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
  public_slug as row_identity,
  'public_slug' as field,
  'duplicate public_slug' as rule
from cloud_roasts
group by public_slug
having count(*) > 1;
