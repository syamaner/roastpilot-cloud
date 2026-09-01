-- C3-S1 telemetry ingest file format (issue #416): strict JSONL parsing for
-- staged roast telemetry exports.
--
-- Scope fence: this file creates exactly one object -- the file format below.
-- It contains zero GRANT statements and creates no other object.
--
-- The deploy connection sets no default schema (snowflake/README.md), so this
-- migration explicitly selects APP before creating the file format.
use schema app;

create file format roast_jsonl_format
  type = json
  strip_outer_array = false;
