-- C2-S7 roles/grants manifest (issue #317): the complete Snowflake data-plane
-- privilege boundary for PUBLIC_WEB and ROASTPILOT_AGENT.
--
-- Scope fence: GRANT statements only. The two roles and every referenced
-- object already exist; this repeatable migration creates no role or object.
-- PUBLIC_WEB is limited to its three prerequisites, two secure views, and
-- SUBMIT_REVIEW. ROASTPILOT_AGENT receives only the deferred-Option-B data
-- plane: five tables and the internal artifact stage, with no procedure grant.
--
-- The deploy connection sets no default schema (snowflake/README.md), so this
-- migration explicitly selects APP before its first grant.
use schema app;

grant usage on database {{ env_var("SNOWFLAKE_DATABASE", "ROASTPILOT_DEV") }} to role PUBLIC_WEB;
grant usage on schema app to role PUBLIC_WEB;
grant usage on warehouse {{ env_var("SNOWFLAKE_WAREHOUSE", "DEV_CI_WH") }} to role PUBLIC_WEB;
grant select on view app.roast_by_slug to role PUBLIC_WEB;
grant select on view app.reviews_by_roast to role PUBLIC_WEB;
grant usage on procedure app.submit_review(string, string, int, smallint, smallint, smallint, smallint, smallint, string, string, string) to role PUBLIC_WEB;

grant usage on database {{ env_var("SNOWFLAKE_DATABASE", "ROASTPILOT_DEV") }} to role ROASTPILOT_AGENT;
grant usage on schema app to role ROASTPILOT_AGENT;
grant usage on warehouse {{ env_var("SNOWFLAKE_WAREHOUSE", "DEV_CI_WH") }} to role ROASTPILOT_AGENT;
grant select, insert, update, delete on table app.cloud_roasts to role ROASTPILOT_AGENT;
grant select, insert, update, delete on table app.roast_telemetry to role ROASTPILOT_AGENT;
grant select, insert, update, delete on table app.roast_artifacts to role ROASTPILOT_AGENT;
grant select, insert, update, delete on table app.tasting_reviews to role ROASTPILOT_AGENT;
grant select, insert, update, delete on table app.reference_roast_summaries to role ROASTPILOT_AGENT;
grant read, write on stage app.roast_artifacts to role ROASTPILOT_AGENT;
