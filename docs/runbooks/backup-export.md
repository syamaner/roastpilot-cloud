# Backup, export and disaster recovery

This runbook gives an operator the manual procedure for exporting and restoring
the Snowflake roast data graph and its staged artifact files.

## Context and decisions

Production is database `ROASTPILOT`; DEV is `ROASTPILOT_DEV`. Set `<source_db>`
deliberately to the one being exported and never mix environments. Automated
exports are deferred to #552. This procedure creates no workflow, principal,
role, warehouse or grant and cannot weaken the grant boundary. See
[Production deployment](prod-deploy-runbook.md) and
[Key-pair rotation](key-rotation.md) for existing operator identities.

Use an approved three-part backup stage as `<approved_backup_stage>` and a
unique, immutable `<backup_id>`. The stage must be in a dedicated backup
database outside the protected database and covered by the approved retention,
encryption and access policy.
Do not create a stage or grant here. Record the source database, timestamp,
query IDs, row counts, stage listing and checksums in a protected manifest;
never put exported data in the repository.

### Placeholder grammar

`<approved_backup_stage>` must be the exact existing three-part name
`<backup_db>.<schema>.<stage>`. Each unquoted segment must match
`^[A-Za-z_][A-Za-z0-9_$]*$`, and `<backup_db>` must be neither `ROASTPILOT` nor
`ROASTPILOT_DEV`. Before substitution, require `<backup_id>` and every
`idempotency_key`-derived `<run_id>` to be 1–64 characters and match
`^[0-9A-Za-z_]+(?:-[0-9A-Za-z_]+)*$`.
Semicolons, quotes, whitespace, `/../`, and `--` are forbidden in those IDs and
in every stage-name segment. `<source_db>` must be exactly `ROASTPILOT` or
`ROASTPILOT_DEV`; validate it and a later `<recovery_db>` as one unquoted
identifier segment under the same identifier grammar. These values reach a
multi-statement SnowSQL script and local paths; unknown or non-matching input
is an injection or traversal risk and must fail closed.

Snowflake named-stage grammar requires bare `@stage/path` references; quoting
the whole reference as a string is not valid named-stage syntax. The closed
grammars above protect those sites. The local `file://` operands below are
single-quoted, as Snowflake permits, but quoting does not replace validation.

## Export principal

The expected owner role is `ROASTPILOT_ADMIN`. Exact ownership is
`[VERIFY-LIVE]`: as `ACCOUNTADMIN`, inspect the schema, all five tables and the
stage; stop if the owner is unknown or differs.

```sql
USE ROLE ACCOUNTADMIN;
SHOW SCHEMAS LIKE 'APP' IN DATABASE <source_db>;
SHOW OBJECTS IN SCHEMA <source_db>.APP;
SHOW STAGES IN SCHEMA <source_db>.APP;
```

Accept only the exact `<source_db>.APP` schema row, the five named table rows
and the exact `ROAST_ARTIFACTS` stage row. All must show the expected owner
before switching roles; stop if any owner differs, is missing or is unknown.

Separately verify the real three-part backup destination before unloading PII:

```sql
SHOW STAGES IN SCHEMA <backup_db>.<schema>;
DESCRIBE STAGE <backup_db>.<schema>.<stage>;
SHOW GRANTS ON STAGE <backup_db>.<schema>.<stage>;
```

Accept exactly the intended stage. Confirm its database is not `ROASTPILOT` or
`ROASTPILOT_DEV`, and verify its owner, encryption configuration and access
policy from these live results. Missing, ambiguous or unexpected state fails
closed. This destination-stage check is distinct from the protected database's
`@app.roast_artifacts` ownership check above.

Run as the verified owner and select that same source database:

```sql
USE ROLE ROASTPILOT_ADMIN;
USE DATABASE <source_db>;
USE SCHEMA APP;
```

`PUBLIC_WEB` must never perform this export. Its only read surface is two secure
views plus `app.submit_review`; both filter `visibility <> 'private'`, so a
view-sourced export silently omits private roasts. Export every table from the
`app.<base_table>` named below.
`ROASTPILOT_AGENT` can read the tables and stage for export, but its direct table
`INSERT`, `UPDATE` and `DELETE` privileges are revoked, so it cannot perform the
bulk-`COPY` row restore; use the verified owner role for backup and restore. It
is not write-incapable generally: it retains stage `WRITE` and constrained
writes through the owner-rights `app.upsert_roast` and
`app.load_roast_telemetry` procedures.

## What is backed up

| Target | Kind | Relationship or handling |
| --- | --- | --- |
| `app.cloud_roasts` | Base table | Parent; `idempotency_key` determines the artifact run directory. |
| `app.roast_telemetry` | Base table | Child by `roast_id`; temperatures are Celsius. |
| `app.roast_artifacts` | Base table | Child rows containing `stage_path`; distinct from the stage. |
| `app.tasting_reviews` | Base table | Child rows; contains optional PII and nullable IP hashes. |
| `app.reference_roast_summaries` | Base table | Derived aggregate; export for evidence, recompute on restore. |
| `@app.roast_artifacts` | Internal stage | `SNOWFLAKE_SSE` files under `<run_id>/`, distinct from table rows. |

The row graph is `app.cloud_roasts` parent to telemetry, artifact rows and
reviews. Snowflake does not enforce foreign keys. Stage files and
`app.roast_artifacts` rows are a separate pair to capture and restore together.

## Export procedure

### Export all five base tables

Parquet is the explicit format. `HEADER=TRUE` is required on every unload so
Snowflake writes source column names instead of generated `_col0`, `_col1`, …
field names; the restore's `MATCH_BY_COLUMN_NAME` depends on those source names.
The VARIANT/Parquet round-trip is `[VERIFY-LIVE]`. A new `<backup_id>` and
`OVERWRITE=FALSE` prevent replacement.

For a non-quiesced table export, first pause stage writers and let in-flight
stage/row operations finish. In the same SnowSQL session, select one timestamp
once and apply it to every unload and count. Keep stage writers paused through
the complete `LIST`/`GET` and checksum window because stages have no Time Travel.

Before the first write, prove that both destinations are empty:

```sql
LIST @<approved_backup_stage>/<backup_id>/;
```

The `LIST` must return zero files. Stop if the prefix is non-empty: a reused or
partial `<backup_id>` must be resolved before export. Also confirm that
`file:///secure/roastpilot-backups/<backup_id>/stage/roast_artifacts/` is an
empty, operator-controlled local directory, newly created if necessary, before
any `GET`; stale local files must never be mixed into the new backup.

```sql
SET backup_snapshot_ts = CURRENT_TIMESTAMP();
COPY INTO @<approved_backup_stage>/<backup_id>/tables/cloud_roasts/
  FROM (SELECT * FROM app.cloud_roasts AT(TIMESTAMP => $backup_snapshot_ts))
  FILE_FORMAT=(TYPE=PARQUET COMPRESSION=SNAPPY) HEADER=TRUE OVERWRITE=FALSE DETAILED_OUTPUT=TRUE;
COPY INTO @<approved_backup_stage>/<backup_id>/tables/roast_telemetry/
  FROM (SELECT * FROM app.roast_telemetry AT(TIMESTAMP => $backup_snapshot_ts))
  FILE_FORMAT=(TYPE=PARQUET COMPRESSION=SNAPPY) HEADER=TRUE OVERWRITE=FALSE DETAILED_OUTPUT=TRUE;
COPY INTO @<approved_backup_stage>/<backup_id>/tables/roast_artifacts/
  FROM (SELECT * FROM app.roast_artifacts AT(TIMESTAMP => $backup_snapshot_ts))
  FILE_FORMAT=(TYPE=PARQUET COMPRESSION=SNAPPY) HEADER=TRUE OVERWRITE=FALSE DETAILED_OUTPUT=TRUE;
COPY INTO @<approved_backup_stage>/<backup_id>/tables/tasting_reviews/
  FROM (
    SELECT * REPLACE (
      IFF(created_at <= DATEADD('day', -30, CURRENT_TIMESTAMP()),
          NULL, submitted_ip_hash) AS submitted_ip_hash
    )
    FROM app.tasting_reviews AT(TIMESTAMP => $backup_snapshot_ts)
  )
  FILE_FORMAT=(TYPE=PARQUET COMPRESSION=SNAPPY) HEADER=TRUE OVERWRITE=FALSE DETAILED_OUTPUT=TRUE;
COPY INTO @<approved_backup_stage>/<backup_id>/tables/reference_roast_summaries/
  FROM (SELECT * FROM app.reference_roast_summaries AT(TIMESTAMP => $backup_snapshot_ts))
  FILE_FORMAT=(TYPE=PARQUET COMPRESSION=SNAPPY) HEADER=TRUE OVERWRITE=FALSE DETAILED_OUTPUT=TRUE;
```

Capture counts at that same point and record `$backup_snapshot_ts`:

```sql
SELECT 'cloud_roasts' AS object_name, COUNT(*) AS row_count FROM app.cloud_roasts AT(TIMESTAMP => $backup_snapshot_ts)
UNION ALL SELECT 'roast_telemetry', COUNT(*) FROM app.roast_telemetry AT(TIMESTAMP => $backup_snapshot_ts)
UNION ALL SELECT 'roast_artifacts', COUNT(*) FROM app.roast_artifacts AT(TIMESTAMP => $backup_snapshot_ts)
UNION ALL SELECT 'tasting_reviews', COUNT(*) FROM app.tasting_reviews AT(TIMESTAMP => $backup_snapshot_ts)
UNION ALL SELECT 'reference_roast_summaries', COUNT(*) FROM app.reference_roast_summaries AT(TIMESTAMP => $backup_snapshot_ts);
```

The protected manifest must also record source-snapshot VARIANT type/null
profiles for `app.cloud_roasts.summary`, `app.roast_telemetry.raw`, and
`app.reference_roast_summaries.key_patterns`, including non-null counts for the
nested `summary` paths used by summary recomputation. Preserve per-row presence
where needed to detect one row losing a value while another gains one. Record
every source `(bean_origin, roast_level)` key and its derived aggregate values from
`app.reference_roast_summaries` at `$backup_snapshot_ts`; exclude only identity
and update-timestamp fields. These are recovery acceptance baselines, not a
replacement for recomputation.

Alternatively, quiesce all table and stage writers before the first current-state
count and keep them paused until every `GET` and checksum finishes. Never mix
independent current-state reads while writers run. Snapshot consistency and the
quiescence boundary are `[VERIFY-LIVE]`.

The review unload keeps a non-null hash only while it remains inside its
original 30-day window; the exact live purge predicate is applied before bytes
reach Parquet. Time passing can age a retained hash after export. Therefore any
backup still holding a non-null hash must be deleted or re-scrubbed by that
hash's original 30-day deadline. The backup retention, encryption and access
policy must enforce that deadline; immutability does not override it.

### Export the internal artifact stage

The internal stage uses `SNOWFLAKE_SSE`. Retain its complete listing. Paths use
the `idempotency_key`-derived `<run_id>` directory. Download every directory and
compute checksums:

```sql
LIST @app.roast_artifacts;
GET @app.roast_artifacts/<run_id>/
  'file:///secure/roastpilot-backups/<backup_id>/stage/roast_artifacts/<run_id>/'
  PATTERN='.*';
```

`GET` and `PUT` are unavailable in a Snowsight worksheet. Run them with SnowSQL
or a file-transfer-capable connector. Preserve relative paths from `LIST`; do
not flatten run directories.
The files and exported `app.roast_artifacts` table are distinct targets. The
backup is incomplete unless both are present and reconcile.

## Privacy constraint

> **Privacy constraint (verbatim):** Hashed IP, never raw: `submitted_ip_hash` is
> a hash; no raw IP is stored or exported, and no step may reconstruct or derive
> one. `reviewer_name` is optional free-text PII, so the export is a PII-bearing
> artifact: store it encrypted, access-control it, and never paste it into an
> issue, pull request, chat or log. IP hashes are purged at 30 days or older by
> setting `submitted_ip_hash = NULL`; re-apply that purge after restore.
> Temperatures are Celsius everywhere; no Fahrenheit value or conversion is permitted.

## Restore and disaster recovery

Restore only into an empty target created by reviewed migrations. Verify its
database and owner role live. Never use `PUBLIC_WEB` or `ROASTPILOT_AGENT`.
Stop if identity, age, checksums, completeness or ownership is unknown.

Immediately before any load, deliberately select the recovery database rather
than inheriting the earlier source selection. `<recovery_db>` is the intended
recovery target, not a default alias for the manifest's source database:

```sql
USE DATABASE <recovery_db>;
USE SCHEMA APP;
SELECT CURRENT_DATABASE(), CURRENT_SCHEMA();
SELECT
  (SELECT COUNT(*) FROM app.cloud_roasts) AS cloud_roasts,
  (SELECT COUNT(*) FROM app.roast_telemetry) AS roast_telemetry,
  (SELECT COUNT(*) FROM app.roast_artifacts) AS roast_artifacts,
  (SELECT COUNT(*) FROM app.tasting_reviews) AS tasting_reviews,
  (SELECT COUNT(*) FROM app.reference_roast_summaries) AS reference_roast_summaries;
LIST @app.roast_artifacts;
```

`CURRENT_DATABASE()` must exactly equal the deliberately chosen recovery
target, all five counts must be zero, and `LIST @app.roast_artifacts;` must
return zero files. A non-empty stage is persisted state from a prior or partial
restore and must be cleaned through the approved recovery cleanup process before
this preflight is repeated. Stop before `COPY` if the target is the live source,
any table or stage is non-empty, or identity is unknown. Reusing the source name
is permissible only after the former source is unavailable, a fresh migration
has recreated an empty schema, and the operator has explicitly approved that
disaster-recovery target.

Snowflake does not enforce foreign keys; an out-of-order restore can silently
create orphans. Reverse the delete cascade: restore `app.cloud_roasts`, then
`app.roast_telemetry`, stage files, `app.roast_artifacts` rows, and finally
`app.tasting_reviews`.

### Restore the parent, telemetry and stage files

```sql
COPY INTO app.cloud_roasts
  FROM @<approved_backup_stage>/<backup_id>/tables/cloud_roasts/
  FILE_FORMAT=(TYPE=PARQUET) MATCH_BY_COLUMN_NAME=CASE_INSENSITIVE ON_ERROR=ABORT_STATEMENT PURGE=FALSE;
COPY INTO app.roast_telemetry
  FROM @<approved_backup_stage>/<backup_id>/tables/roast_telemetry/
  FILE_FORMAT=(TYPE=PARQUET) MATCH_BY_COLUMN_NAME=CASE_INSENSITIVE ON_ERROR=ABORT_STATEMENT PURGE=FALSE;
```

Upload every checksummed run directory to its original prefix before artifact
rows. Because `GET` preserved stored bytes, use `AUTO_COMPRESS=FALSE`; another
export method must explicitly match its compression.

```sql
PUT 'file:///secure/roastpilot-backups/<backup_id>/stage/roast_artifacts/<run_id>/*'
  @app.roast_artifacts/<run_id>/
  AUTO_COMPRESS=FALSE OVERWRITE=FALSE;
```

`PUT` also requires SnowSQL or a file-transfer-capable connector, not Snowsight.
Confirm each name, size and checksum `[VERIFY-LIVE]` before its row is loaded.

### Restore artifact rows and reviews

```sql
COPY INTO app.roast_artifacts
  FROM @<approved_backup_stage>/<backup_id>/tables/roast_artifacts/
  FILE_FORMAT=(TYPE=PARQUET) MATCH_BY_COLUMN_NAME=CASE_INSENSITIVE ON_ERROR=ABORT_STATEMENT PURGE=FALSE;
COPY INTO app.tasting_reviews
  FROM @<approved_backup_stage>/<backup_id>/tables/tasting_reviews/
  FILE_FORMAT=(TYPE=PARQUET) MATCH_BY_COLUMN_NAME=CASE_INSENSITIVE ON_ERROR=ABORT_STATEMENT PURGE=FALSE;
```

An old backup can revive already-purged `submitted_ip_hash` values. Before
admitting traffic, re-apply the retention rule:

```sql
UPDATE app.tasting_reviews
SET submitted_ip_hash = NULL
WHERE submitted_ip_hash IS NOT NULL
  AND created_at <= DATEADD('day', -30, CURRENT_TIMESTAMP());
```

If backup age or retention horizon is unknown, fail closed: set every non-null
`submitted_ip_hash` in restored `app.tasting_reviews` to `NULL`.

### Recompute the derived table

Do not load the exported `app.reference_roast_summaries` snapshot normally.
Clear target rows, query distinct non-null `(bean_origin, roast_level)` pairs
from `app.cloud_roasts`, then invoke `app.recompute_reference_summary` once per
pair with bound connector parameters. This rebuilds the table instead of
trusting a stale aggregate.

## Verify

Before accepting recovery, validate the restored semi-structured values:

```sql
SELECT
  COUNT(*) AS roast_count,
  COUNT_IF(summary IS NULL) AS summary_null,
  COUNT_IF(TYPEOF(summary) <> 'OBJECT') AS summary_not_object,
  COUNT_IF(summary:started_at_utc IS NOT NULL) AS started_at_present,
  COUNT_IF(summary:beans_added_at_utc IS NOT NULL) AS beans_added_present,
  COUNT_IF(summary:first_crack_at_utc IS NOT NULL) AS first_crack_present,
  COUNT_IF(summary:beans_dropped_at_utc IS NOT NULL) AS beans_dropped_present,
  COUNT_IF(summary:development_time_percent IS NOT NULL) AS development_present,
  COUNT_IF(summary:total_roast_seconds IS NOT NULL) AS total_seconds_present
FROM app.cloud_roasts;
SELECT
  COUNT_IF(raw IS NULL) AS raw_null,
  COUNT_IF(raw IS NOT NULL AND TYPEOF(raw) <> 'OBJECT') AS raw_not_object
FROM app.roast_telemetry;
SELECT
  COUNT_IF(key_patterns IS NULL) AS key_patterns_null,
  COUNT_IF(key_patterns IS NOT NULL AND TYPEOF(key_patterns) <> 'ARRAY') AS key_patterns_not_array
FROM app.reference_roast_summaries;
```

`summary_null` and every unexpected-type count must be zero. The other null,
nested-path and per-row presence results must equal the source-snapshot profiles
in the protected manifest; an unexpected loss is a restore failure even when
the procedure returned success. Apply the same comparison to any additional
VARIANT shape recorded in the manifest.

All results here are `[VERIFY-LIVE]`. Compare manifest counts only for the four
loaded tables: `app.cloud_roasts`, `app.roast_telemetry`, `app.roast_artifacts`
and `app.tasting_reviews`. Confirm zero orphan `roast_id` values in the three
child tables by left-joining each to `app.cloud_roasts`. Confirm every
`app.roast_artifacts.stage_path` resolves under `@app.roast_artifacts` with its
expected checksum.

Confirm no retained `submitted_ip_hash` is 30 days old or older. Require zero
owner-only data-quality violations. Recompute every present summary group, then
compare these freshly derived keys and values with the manifest baseline:

```sql
SELECT bean_origin, roast_level, roast_count, review_count, avg_rating,
       first_crack_temp_avg_c, first_crack_temp_stddev_c,
       drop_temp_avg_c, drop_temp_stddev_c, development_percent_avg,
       first_crack_time_avg_s, total_time_avg_s
FROM app.reference_roast_summaries
ORDER BY bean_origin, roast_level;
```

Never compare only the summary row count with the exported snapshot: an absent
or zero-count old group can legitimately change it. Procedure success alone is
not acceptance evidence; the VARIANT profiles and freshly derived aggregate
values must match the manifest. Keep the target isolated and stop if any check
is unknown or fails.

## Ownership summary

| Step | Owner and identity |
| --- | --- |
| Verify source and target ownership | Operator as `ACCOUNTADMIN` |
| Export all five base tables | Operator through verified `ROASTPILOT_ADMIN` ownership |
| `LIST` and `GET` `@app.roast_artifacts` | Operator through verified owner role using SnowSQL or connector |
| Protect the backup and manifest | Backup operator in the approved encrypted store |
| Apply migrations to an empty recovery target | Deployment operator through `ROASTPILOT_ADMIN` |
| Restore table rows in order | Operator through verified `ROASTPILOT_ADMIN` ownership |
| `PUT` stage files before artifact rows | Operator through verified owner role using SnowSQL or connector |
| Re-purge restored IP hashes | Operator through verified `ROASTPILOT_ADMIN` ownership |
| Recompute summaries and complete live verification | Operator through verified `ROASTPILOT_ADMIN` ownership |

Schemachange owns schema evolution; this manual procedure owns only the data and
file movement. No CI job or public application principal substitutes for the
operator identities above.
