# Backup, export and disaster recovery

This runbook gives an operator the manual procedure for exporting and restoring
the Snowflake roast data graph and its staged artifact files.

## Context and decisions

Production is database `ROASTPILOT`; DEV is `ROASTPILOT_DEV`. Select the target
explicitly and never overwrite one environment with the other. Automated
exports are deferred to #552. This procedure creates no workflow, principal,
role, warehouse or grant and cannot weaken the grant boundary. See
[Production deployment](prod-deploy-runbook.md) and
[Key-pair rotation](key-rotation.md) for existing operator identities.

Use an approved backup stage as `<approved_backup_stage>` and a unique,
immutable `<backup_id>`. It must be outside the protected database and covered
by the approved retention, encryption and access policy.
Do not create a stage or grant here. Record the source database, timestamp,
query IDs, row counts, stage listing and checksums in a protected manifest;
never put exported data in the repository.

## Export principal

The expected owner role is `ROASTPILOT_ADMIN`. Exact ownership is
`[VERIFY-LIVE]`: as `ACCOUNTADMIN`, inspect the schema, all five tables and the
stage; stop if the owner is unknown or differs.

```sql
USE ROLE ACCOUNTADMIN;
SHOW OBJECTS IN SCHEMA ROASTPILOT.APP;
```

Run as the verified owner, using `ROASTPILOT` below or deliberately replacing
it with `ROASTPILOT_DEV` for a DEV rehearsal:

```sql
USE ROLE ROASTPILOT_ADMIN;
USE DATABASE ROASTPILOT;
USE SCHEMA APP;
```

`PUBLIC_WEB` must never perform this export. Its only read surface is two secure
views plus `app.submit_review`; both filter `visibility <> 'private'`, so a
view-sourced export silently omits private roasts. Export every table from the
`app.<base_table>` named below.
`ROASTPILOT_AGENT` can read these tables and the stage, but its table writes are
revoked: it is export-only and cannot perform the row restore.

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

Run each unload from its base table. Parquet is the explicit export format;
`HEADER=TRUE` preserves column names for the matching restore. `OVERWRITE=FALSE`
and a new `<backup_id>` prevent replacement of an earlier backup.

```sql
COPY INTO @<approved_backup_stage>/<backup_id>/tables/cloud_roasts/
  FROM app.cloud_roasts FILE_FORMAT=(TYPE=PARQUET COMPRESSION=SNAPPY)
  HEADER=TRUE OVERWRITE=FALSE DETAILED_OUTPUT=TRUE;
COPY INTO @<approved_backup_stage>/<backup_id>/tables/roast_telemetry/
  FROM app.roast_telemetry FILE_FORMAT=(TYPE=PARQUET COMPRESSION=SNAPPY)
  HEADER=TRUE OVERWRITE=FALSE DETAILED_OUTPUT=TRUE;
COPY INTO @<approved_backup_stage>/<backup_id>/tables/roast_artifacts/
  FROM app.roast_artifacts FILE_FORMAT=(TYPE=PARQUET COMPRESSION=SNAPPY)
  HEADER=TRUE OVERWRITE=FALSE DETAILED_OUTPUT=TRUE;
COPY INTO @<approved_backup_stage>/<backup_id>/tables/tasting_reviews/
  FROM app.tasting_reviews FILE_FORMAT=(TYPE=PARQUET COMPRESSION=SNAPPY)
  HEADER=TRUE OVERWRITE=FALSE DETAILED_OUTPUT=TRUE;
COPY INTO @<approved_backup_stage>/<backup_id>/tables/reference_roast_summaries/
  FROM app.reference_roast_summaries FILE_FORMAT=(TYPE=PARQUET COMPRESSION=SNAPPY)
  HEADER=TRUE OVERWRITE=FALSE DETAILED_OUTPUT=TRUE;
```

Capture each `app.<base_table>` row count without intervening writes. Quiesce
writers or use one operator-selected Time Travel point; consistency is
`[VERIFY-LIVE]`.

### Export the internal artifact stage

The internal stage uses `SNOWFLAKE_SSE`. Retain its complete listing. Paths use
the `idempotency_key`-derived `<run_id>` directory. Download every directory and
compute checksums:

```sql
LIST @app.roast_artifacts;
GET @app.roast_artifacts/<run_id>/
  file:///secure/roastpilot-backups/<backup_id>/stage/roast_artifacts/<run_id>/
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
PUT file:///secure/roastpilot-backups/<backup_id>/stage/roast_artifacts/<run_id>/*
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

All results here are `[VERIFY-LIVE]`. Compare all five table counts with the
manifest. Confirm zero orphan `roast_id` values in `app.roast_telemetry`,
`app.roast_artifacts` and `app.tasting_reviews` by left-joining each to
`app.cloud_roasts`. Confirm every `app.roast_artifacts.stage_path` resolves
under `@app.roast_artifacts` with its expected checksum.

Confirm no retained `submitted_ip_hash` is 30 days old or older. Require zero
owner-only data-quality violations. Compare the recomputed
`app.reference_roast_summaries` keys and counts with a fresh derivation, not the
snapshot. Keep the target isolated and stop if any count, orphan, stage mapping,
checksum, purge or aggregate check is unknown or fails.

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
