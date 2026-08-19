"""Schema-assertion tests for the C2-S1 base DDL migration (issue #307):
V1.1.0__base_tables.sql.

Parses the migration's TEXT (no Snowflake connection -- CI never connects)
into a structured schema and compares it against EXPECTED_SCHEMA, which
transcribes issue #307's AC-1..AC-5 column tables directly. Both the
migration and EXPECTED_SCHEMA are reviewed against the same issue body by
schema-migration-reviewer, closing the "migration and test wrong-but-
consistent" hole the original #318 attempt fell into.

Column defs are split on commas at paren depth 0 (not naively on every
comma), so `default parse_json('[]')`, `default current_timestamp()`, and
the stage's `encryption = (type = 'SNOWFLAKE_SSE')` clause never mis-split a
single column definition into two.
"""

from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import validate_migrations  # noqa: E402

SNOWFLAKE_DIR = Path(__file__).resolve().parent.parent
MIGRATION_PATH = SNOWFLAKE_DIR / "migrations" / "V1.1.0__base_tables.sql"

EXPECTED_TABLE_NAMES = [
    "cloud_roasts",
    "roast_telemetry",
    "roast_artifacts",
    "tasting_reviews",
    "reference_roast_summaries",
]


@dataclass(frozen=True)
class ColumnDef:
    name: str
    type: str
    not_null: bool
    default: str | None


def strip_line_comments(text: str) -> str:
    """Removes everything from `--` to end of line, on every line."""
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines())


def split_columns(body: str) -> list[str]:
    """Splits a `create table ( ... )` body into column-def strings on
    commas at paren depth 0 -- a comma inside `default parse_json('[]')` or
    any other nested-paren default never splits its own column definition.
    """
    parts: list[str] = []
    depth = 0
    current: list[str] = []
    for ch in body:
        if ch == "(":
            depth += 1
            current.append(ch)
        elif ch == ")":
            depth -= 1
            current.append(ch)
        elif ch == "," and depth == 0:
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    if current:
        parts.append("".join(current))
    return [part.strip() for part in parts if part.strip()]


def parse_column(col_text: str) -> ColumnDef:
    """Parses one column-def string into a ColumnDef, treating `not null`
    and `primary key` as constraint tokens (not part of the type), and
    `default` as capturing everything after it once those two constraint
    tokens are removed -- independent of whether `default` or `primary key`
    appears first in the source text.
    """
    tokens = col_text.split()
    name = tokens[0]
    without_name = col_text[len(name) :].strip()
    type_match = re.match(r"(\w+)", without_name)
    col_type = type_match.group(1).lower() if type_match else ""

    not_null = bool(re.search(r"\bnot\s+null\b", col_text, re.IGNORECASE))

    cleaned = re.sub(r"\bnot\s+null\b", " ", col_text, flags=re.IGNORECASE)
    cleaned = re.sub(r"\bprimary\s+key\b", " ", cleaned, flags=re.IGNORECASE)
    default_match = re.search(r"\bdefault\s+(.+)$", cleaned, re.IGNORECASE)
    default = default_match.group(1).strip() if default_match else None

    return ColumnDef(name=name, type=col_type, not_null=not_null, default=default)


def parse_migration(text: str) -> dict[str, list[ColumnDef]]:
    """Parses every `create table <name> ( ... );` block in the migration
    text into `{table_name: [ColumnDef, ...]}`, using balanced-paren
    scanning to find each table body's true closing paren (a non-greedy
    regex would stop at the first `)`, which is routinely inside a nested
    call like `uuid_string()` well before the table body actually ends).
    """
    stripped = strip_line_comments(text)
    schema: dict[str, list[ColumnDef]] = {}
    for match in re.finditer(r"create\s+table\s+(\w+)\s*\(", stripped, re.IGNORECASE):
        table_name = match.group(1)
        open_index = match.end() - 1
        depth = 0
        close_index = None
        for i in range(open_index, len(stripped)):
            if stripped[i] == "(":
                depth += 1
            elif stripped[i] == ")":
                depth -= 1
                if depth == 0:
                    close_index = i
                    break
        assert close_index is not None, f"unbalanced parentheses for table {table_name}"
        body = stripped[open_index + 1 : close_index]
        schema[table_name] = [parse_column(col) for col in split_columns(body)]
    return schema


EXPECTED_SCHEMA: dict[str, list[ColumnDef]] = {
    "cloud_roasts": [
        ColumnDef("id", "string", False, "uuid_string()"),
        ColumnDef("idempotency_key", "string", True, None),
        ColumnDef("owner_id", "string", False, None),
        ColumnDef("public_slug", "string", True, None),
        ColumnDef("visibility", "string", True, "'unlisted'"),
        ColumnDef("bean_origin", "string", False, None),
        ColumnDef("bean_varietal", "string", False, None),
        ColumnDef("bean_weight_g", "float", False, None),
        ColumnDef("profile_name", "string", False, None),
        ColumnDef("roast_level", "string", False, None),
        ColumnDef("summary", "variant", True, None),
        ColumnDef("operator_rating", "int", False, None),
        ColumnDef("operator_notes", "string", False, None),
        ColumnDef("contributed_to_learning", "boolean", True, "true"),
        ColumnDef("roasted_at_utc", "timestamp_tz", False, None),
        ColumnDef("created_at", "timestamp_tz", True, "current_timestamp()"),
        ColumnDef("updated_at", "timestamp_tz", True, "current_timestamp()"),
    ],
    "roast_telemetry": [
        ColumnDef("roast_id", "string", True, None),
        ColumnDef("elapsed_s", "float", True, None),
        ColumnDef("bean_temp_c", "float", False, None),
        ColumnDef("env_temp_c", "float", False, None),
        ColumnDef("heat_percent", "int", False, None),
        ColumnDef("fan_percent", "int", False, None),
        ColumnDef("ror_c_per_min", "float", False, None),
        ColumnDef("raw", "variant", False, None),
    ],
    "roast_artifacts": [
        ColumnDef("id", "string", False, "uuid_string()"),
        ColumnDef("roast_id", "string", True, None),
        ColumnDef("kind", "string", True, None),
        ColumnDef("stage_path", "string", True, None),
        ColumnDef("byte_size", "int", False, None),
        ColumnDef("created_at", "timestamp_tz", True, "current_timestamp()"),
    ],
    "tasting_reviews": [
        ColumnDef("id", "string", False, "uuid_string()"),
        ColumnDef("roast_id", "string", True, None),
        ColumnDef("reviewer_name", "string", False, None),
        ColumnDef("score", "int", True, None),
        ColumnDef("aroma", "smallint", False, None),
        ColumnDef("acidity", "smallint", False, None),
        ColumnDef("sweetness", "smallint", False, None),
        ColumnDef("body", "smallint", False, None),
        ColumnDef("aftertaste", "smallint", False, None),
        ColumnDef("brew_method", "string", False, None),
        ColumnDef("notes", "string", False, None),
        ColumnDef("submitted_ip_hash", "string", False, None),
        ColumnDef("created_at", "timestamp_tz", True, "current_timestamp()"),
    ],
    "reference_roast_summaries": [
        ColumnDef("id", "string", False, "uuid_string()"),
        ColumnDef("bean_origin", "string", True, None),
        ColumnDef("roast_level", "string", True, None),
        ColumnDef("roast_count", "int", True, None),
        ColumnDef("review_count", "int", True, None),
        ColumnDef("avg_rating", "float", False, None),
        ColumnDef("first_crack_temp_avg_c", "float", False, None),
        ColumnDef("first_crack_temp_stddev_c", "float", False, None),
        ColumnDef("drop_temp_avg_c", "float", False, None),
        ColumnDef("drop_temp_stddev_c", "float", False, None),
        ColumnDef("development_percent_avg", "float", False, None),
        ColumnDef("first_crack_time_avg_s", "float", False, None),
        ColumnDef("total_time_avg_s", "float", False, None),
        ColumnDef("key_patterns", "variant", False, "parse_json('[]')"),
        ColumnDef("updated_at", "timestamp_tz", True, "current_timestamp()"),
    ],
}

EXPECTED_COLUMN_COUNTS = {
    "cloud_roasts": 17,
    "roast_telemetry": 8,
    "roast_artifacts": 6,
    "tasting_reviews": 13,
    "reference_roast_summaries": 15,
}


def _not_null_names(columns: list[ColumnDef]) -> set[str]:
    return {col.name for col in columns if col.not_null}


def _column_names(columns: list[ColumnDef]) -> list[str]:
    return [col.name for col in columns]


MIGRATION_TEXT = MIGRATION_PATH.read_text(encoding="utf-8")
PARSED_SCHEMA = parse_migration(MIGRATION_TEXT)


class TestSplitColumns:
    def test_splits_simple_columns_on_top_level_commas(self) -> None:
        assert split_columns("a string, b int") == ["a string", "b int"]

    def test_does_not_split_inside_a_nested_paren_default(self) -> None:
        # The exact fragility this parser exists to avoid: a naive
        # comma-split would cut `parse_json('[]')`'s own argument list.
        body = "id string, key_patterns variant default parse_json('[]'), n int"
        assert split_columns(body) == [
            "id string",
            "key_patterns variant default parse_json('[]')",
            "n int",
        ]

    def test_does_not_split_inside_a_default_current_timestamp_call(self) -> None:
        body = "created_at timestamp_tz not null default current_timestamp()"
        assert split_columns(body) == [body]

    def test_ignores_leading_and_trailing_whitespace_and_blank_segments(self) -> None:
        assert split_columns("\n  a string,\n  b int,\n") == ["a string", "b int"]


class TestParseColumn:
    def test_parses_a_plain_nullable_column(self) -> None:
        assert parse_column("owner_id string") == ColumnDef("owner_id", "string", False, None)

    def test_parses_a_not_null_column(self) -> None:
        assert parse_column("idempotency_key string not null") == ColumnDef(
            "idempotency_key", "string", True, None
        )

    def test_parses_default_before_primary_key(self) -> None:
        assert parse_column("id string default uuid_string() primary key") == ColumnDef(
            "id", "string", False, "uuid_string()"
        )

    def test_parses_not_null_before_default(self) -> None:
        assert parse_column("visibility string not null default 'unlisted'") == ColumnDef(
            "visibility", "string", True, "'unlisted'"
        )

    def test_parses_default_with_nested_parens(self) -> None:
        assert parse_column("key_patterns variant default parse_json('[]')") == ColumnDef(
            "key_patterns", "variant", False, "parse_json('[]')"
        )


class TestParseMigration:
    def test_parses_all_five_tables(self) -> None:
        assert set(PARSED_SCHEMA.keys()) == set(EXPECTED_TABLE_NAMES)

    def test_strips_comments_before_parsing(self) -> None:
        text = "-- a comment mentioning create table fake (\ncreate table t (\n  a string\n);"
        parsed = parse_migration(text)
        assert set(parsed.keys()) == {"t"}


# T-TABLES: exactly the 5 expected table names, no others.
class TestTables:
    def test_exactly_the_five_expected_tables_exist(self) -> None:
        assert set(PARSED_SCHEMA.keys()) == set(EXPECTED_TABLE_NAMES)


# T-COUNT: 17/8/6/13/15 columns respectively.
class TestColumnCounts:
    def test_each_table_has_its_expected_column_count(self) -> None:
        for table, expected_count in EXPECTED_COLUMN_COUNTS.items():
            assert len(PARSED_SCHEMA[table]) == expected_count, table


# T-FULL: the full declared schema equals EXPECTED_SCHEMA, field by field.
class TestFullSchema:
    def test_parsed_schema_matches_expected_schema_exactly(self) -> None:
        assert PARSED_SCHEMA == EXPECTED_SCHEMA


# T-B1 (blocker 1): reference_roast_summaries named exactly that, and its
# logical key (bean_origin, roast_level) is both NOT NULL. Renaming the
# table or dropping either NOT NULL fails this test and only this test.
class TestBlocker1ReferenceRoastSummariesKey:
    def test_table_is_named_exactly_reference_roast_summaries(self) -> None:
        assert "reference_roast_summaries" in PARSED_SCHEMA

    def test_bean_origin_and_roast_level_are_both_not_null(self) -> None:
        key_columns = _not_null_names(PARSED_SCHEMA["reference_roast_summaries"])
        assert {"bean_origin", "roast_level"} <= key_columns


# T-B2 (blocker 2): cloud_roasts is exactly the 17 expected column names,
# and none of them is a stored temperature column.
class TestBlocker2CloudRoastsNoTemperatureColumn:
    def test_cloud_roasts_column_names_match_exactly(self) -> None:
        assert _column_names(PARSED_SCHEMA["cloud_roasts"]) == _column_names(
            EXPECTED_SCHEMA["cloud_roasts"]
        )

    def test_no_temperature_column_on_cloud_roasts(self) -> None:
        temp_pattern = re.compile(r"temp", re.IGNORECASE)
        offending = [col.name for col in PARSED_SCHEMA["cloud_roasts"] if temp_pattern.search(col.name)]
        assert offending == []


# T-B3 (blocker 3): each table's NOT NULL column set equals expected exactly
# -- a stray added NOT NULL fails this test.
class TestBlocker3NotNullSetsMatch:
    def test_not_null_column_sets_match_expected_per_table(self) -> None:
        for table, expected_columns in EXPECTED_SCHEMA.items():
            assert _not_null_names(PARSED_SCHEMA[table]) == _not_null_names(expected_columns), table


# T-B4 (blocker 4): submitted_ip_hash is nullable -- the >=30-day IP purge
# (AGENTS.md) sets it to NULL, which a NOT NULL constraint would forbid.
class TestBlocker4SubmittedIpHashNullable:
    def test_submitted_ip_hash_has_no_not_null_constraint(self) -> None:
        columns = {col.name: col for col in PARSED_SCHEMA["tasting_reviews"]}
        assert columns["submitted_ip_hash"].not_null is False


# T-B5 (blocker 5): roast_telemetry.raw is present and typed variant.
class TestBlocker5TelemetryRawVariant:
    def test_raw_column_present_and_typed_variant(self) -> None:
        columns = {col.name: col for col in PARSED_SCHEMA["roast_telemetry"]}
        assert "raw" in columns
        assert columns["raw"].type == "variant"


# T-C: no Fahrenheit value, suffix, or conversion arithmetic anywhere in the
# migration text.
class TestCelsiusOnly:
    def test_no_fahrenheit_token_or_conversion_arithmetic(self) -> None:
        pattern = re.compile(
            r"fahrenheit|_f\b|\*\s*9\s*/\s*5|\*\s*1\.8|\+\s*32",
            re.IGNORECASE,
        )
        assert pattern.search(strip_line_comments(MIGRATION_TEXT)) is None


# T-SCOPE: no grant/role/view/proc anywhere -- this migration is base tables
# and a stage only.
class TestScopeFence:
    def test_no_grant_role_view_or_procedure_statement(self) -> None:
        pattern = re.compile(
            r"\bgrant\s|\bcreate\s+role\b|\bcreate\s+(?:or\s+replace\s+)?(?:secure\s+)?view\b|"
            r"\bcreate\s+(?:or\s+replace\s+)?procedure\b",
            re.IGNORECASE,
        )
        assert pattern.search(strip_line_comments(MIGRATION_TEXT)) is None


# T-SCHEMA: `use schema app;` appears before the first `create table`.
class TestUseSchemaBeforeFirstTable:
    def test_use_schema_app_precedes_the_first_create_table(self) -> None:
        stripped = strip_line_comments(MIGRATION_TEXT)
        use_match = re.search(r"use\s+schema\s+app\s*;", stripped, re.IGNORECASE)
        first_table_match = re.search(r"create\s+table\b", stripped, re.IGNORECASE)
        assert use_match is not None
        assert first_table_match is not None
        assert use_match.start() < first_table_match.start()


# T-STAGE: the roast_artifacts stage exists with SNOWFLAKE_SSE encryption.
class TestArtifactStage:
    def test_stage_declared_with_snowflake_sse_encryption(self) -> None:
        stripped = strip_line_comments(MIGRATION_TEXT)
        pattern = re.compile(
            r"create\s+stage\s+roast_artifacts\s+encryption\s*=\s*\(\s*type\s*=\s*'SNOWFLAKE_SSE'\s*\)",
            re.IGNORECASE | re.DOTALL,
        )
        assert pattern.search(stripped) is not None


# T-RENDER: validate_migrations.py's offline render passes for the real,
# committed migrations directory (which now includes this file).
class TestRendersCleanlyOffline:
    def test_validate_migrations_passes_against_the_real_migrations_dir(self) -> None:
        assert validate_migrations.main() == 0
