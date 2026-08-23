-- C2-S7 roles/grants manifest (issue #317): the Snowflake object-level
-- privilege boundary for PUBLIC_WEB and ROASTPILOT_AGENT.
--
-- Ordering fence: the `z` prefix is deliberate. schemachange applies
-- repeatable scripts in alphanumeric filename order (deploy.py), and a GRANT
-- requires its target object to exist at apply time (unlike a late-bound
-- procedure body). The view grants below depend on R__secure_views.sql, which
-- would otherwise sort after this file, so this migration sorts after every
-- object-creating repeatable on fresh targets as well as existing ones.
--
-- Scope fence: GRANT statements only, and only for objects the deploy role
-- owns. The two roles and every referenced object already exist; this
-- repeatable migration creates no role or object. The account-level
-- prerequisites (USAGE ON DATABASE and USAGE ON WAREHOUSE for PUBLIC_WEB and
-- ROASTPILOT_AGENT) are operator-provisioned ACCOUNTADMIN DDL (D106-class,
-- like role creation), not part of this migration. PUBLIC_WEB is limited here
-- to APP schema usage, two secure views, and SUBMIT_REVIEW. ROASTPILOT_AGENT
-- receives only APP schema usage and the deferred-Option-B data plane: five
-- tables and the internal artifact stage, with no procedure grant.
--
-- The deploy connection sets no default schema (snowflake/README.md), so this
-- migration explicitly selects APP before its first grant.
use schema app;

grant usage on schema app to role PUBLIC_WEB;
grant select on view app.roast_by_slug to role PUBLIC_WEB;
grant select on view app.reviews_by_roast to role PUBLIC_WEB;
grant usage on procedure app.submit_review(string, string, int, smallint, smallint, smallint, smallint, smallint, string, string, string) to role PUBLIC_WEB;

grant usage on schema app to role ROASTPILOT_AGENT;
grant select, insert, update, delete on table app.cloud_roasts to role ROASTPILOT_AGENT;
grant select, insert, update, delete on table app.roast_telemetry to role ROASTPILOT_AGENT;
grant select, insert, update, delete on table app.roast_artifacts to role ROASTPILOT_AGENT;
grant select, insert, update, delete on table app.tasting_reviews to role ROASTPILOT_AGENT;
grant select, insert, update, delete on table app.reference_roast_summaries to role ROASTPILOT_AGENT;
grant read, write on stage app.roast_artifacts to role ROASTPILOT_AGENT;
