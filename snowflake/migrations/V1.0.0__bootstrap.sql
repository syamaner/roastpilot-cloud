-- schemachange bootstrap (C1-S2, issue #2).
--
-- Proves the migration pipeline end-to-end without pre-empting the C2 schema
-- build. C2 owns cloud_roasts, roast_telemetry, roast_artifacts,
-- tasting_reviews, reference_roast_summaries, roles/grants, secure views,
-- and stored procedures (plan.md §4, §11). This migration only creates the
-- application-schema namespace those objects will live in.
--
-- Runs against whatever database the deploy command targets (ROASTPILOT_DEV
-- by default; see ../README.md). schemachange's own change-history table
-- (METADATA.CHANGE_HISTORY, per schemachange-config.yml) is created
-- separately by the --schemachange-create-change-history-table flag, not by
-- this script.

create schema if not exists app
  comment = 'roastpilot-cloud application schema: C2 builds the roast/review/reference tables, roles, secure views, and stored procedures here (plan.md §4).';
