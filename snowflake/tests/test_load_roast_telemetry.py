"""Text and fixture contract for LOAD_ROAST_TELEMETRY (issue #416)."""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path


SNOWFLAKE_DIR = Path(__file__).resolve().parent.parent
MIGRATION_PATH = SNOWFLAKE_DIR / "migrations" / "R__proc_load_roast_telemetry.sql"
MIGRATION = MIGRATION_PATH.read_text(encoding="utf-8")
STRIPPED = re.sub(r"--[^\n]*(?:\n|$)|/\*.*?\*/", "", MIGRATION, flags=re.DOTALL)

# Prompt-transcribed source-to-destination contract, deliberately not parsed
# from the migration. Tests below compare this independent literal to the SQL.
SOURCE_TO_DEST = (
    ("roast_id", "'<p_roast_id>'"),
    ("elapsed_s", "$1:monotonic_seconds::float"),
    ("bean_temp_c", "$1:bean_temp_c::float"),
    ("env_temp_c", "$1:env_temp_c::float"),
    ("heat_percent", "$1:heat_level_percent::int"),
    ("fan_percent", "$1:fan_level_percent::int"),
    ("ror_c_per_min", "null"),
    ("raw", "null"),
)

ROAST_ID = "01234567-89ab-cdef-0123-456789abcdef"
RUN_ID = "run_416-A"
TELEMETRY_KEYS = {
    "bean_temp_c",
    "cooling_on",
    "env_temp_c",
    "fan_level_percent",
    "heat_level_percent",
    "monotonic_seconds",
    "recorded_at_utc",
    "session_id",
    "type",
}
EVENT_KEYS = {
    "kind",
    "monotonic_seconds",
    "payload",
    "recorded_at_utc",
    "session_id",
    "type",
}


def _execute_expression() -> str:
    match = re.search(
        r"v_insert_sql\s*:=\s*(?P<expression>.*?)\n\s*"
        r"execute\s+immediate\s+:v_insert_sql\s*;",
        STRIPPED,
        re.IGNORECASE | re.DOTALL,
    )
    assert match is not None
    return match.group("expression")


def _render_dynamic_sql() -> str:
    """Render only the closed SQL-literal/validated-parameter concatenation."""
    tokens = re.findall(r"'(?:''|[^'])*'|\bp_roast_id\b|\bp_run_id\b", _execute_expression())
    rendered: list[str] = []
    for token in tokens:
        if token == "p_roast_id":
            rendered.append(ROAST_ID)
        elif token == "p_run_id":
            rendered.append(RUN_ID)
        else:
            rendered.append(token[1:-1].replace("''", "'"))
    return "".join(rendered)


def _insert_projection() -> tuple[list[str], list[str]]:
    dynamic_sql = _render_dynamic_sql()
    match = re.search(
        r"insert\s+into\s+app\.roast_telemetry\s*\((?P<columns>.*?)\)\s*"
        r"select\s+(?P<expressions>.*?)\s+from\s+@app\.roast_artifacts/",
        dynamic_sql,
        re.IGNORECASE | re.DOTALL,
    )
    assert match is not None
    columns = [item.strip() for item in match.group("columns").split(",")]
    expressions = [item.strip() for item in match.group("expressions").split(",")]
    expressions[0] = expressions[0].replace(ROAST_ID, "<p_roast_id>")
    return columns, expressions


def map_source_row(row: dict[str, object], roast_id: str) -> dict[str, object] | None:
    """Express the ratified mapping intent; this does not emulate Snowflake."""
    if row.get("type") != "telemetry":
        return None
    return {
        "roast_id": roast_id,
        "elapsed_s": row.get("monotonic_seconds"),
        "bean_temp_c": row.get("bean_temp_c"),
        "env_temp_c": row.get("env_temp_c"),
        "heat_percent": row.get("heat_level_percent"),
        "fan_percent": row.get("fan_level_percent"),
        "ror_c_per_min": None,
        "raw": None,
    }


def fixture_expected_rows(path: Path, roast_id: str) -> list[dict[str, object]]:
    """Derive live-verifier expectations from one real JSONL fixture."""
    rows = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]
    mapped = [map_source_row(row, roast_id) for row in rows]
    return [row for row in mapped if row is not None]


def test_t_exact_signature_and_attribute_run() -> None:
    expected = """create or replace procedure load_roast_telemetry(p_run_id string, p_roast_id string)
copy grants
returns string
language sql
execute as caller
as"""
    assert expected in STRIPPED
    assert len(re.findall(r"\bcreate\s+or\s+replace\s+procedure\b", STRIPPED, re.I)) == 1
    assert re.search(r"\bexecute\s+as\s+owner\b", STRIPPED, re.I) is None


def test_t_type_filter_is_byte_exact_and_type_appears_only_there() -> None:
    dynamic_sql = _render_dynamic_sql()
    assert "$1:type::string = 'telemetry'" in dynamic_sql
    assert len(re.findall(r"\btype\b", dynamic_sql, re.IGNORECASE)) == 1


def test_t_insert_projection_matches_independent_literal_exactly() -> None:
    columns, expressions = _insert_projection()
    assert columns == [destination for destination, _ in SOURCE_TO_DEST]
    assert expressions == [expression for _, expression in SOURCE_TO_DEST]


def test_t_private_source_and_unmapped_fields_never_persist() -> None:
    _, expressions = _insert_projection()
    assert expressions[-2:] == ["null", "null"]
    assert "$1:ror" not in STRIPPED.lower()
    for forbidden in ("recorded_at_utc", "cooling_on", "session_id"):
        assert forbidden not in STRIPPED.lower()


def test_t_stage_reference_uses_named_format_without_inline_json_type() -> None:
    dynamic_sql = _render_dynamic_sql()
    assert "(file_format => 'app.roast_jsonl_format')" in dynamic_sql
    stage_clause = dynamic_sql.split("from @app.roast_artifacts/", 1)[1]
    assert re.search(r"\btype\s*=\s*json\b", stage_clause, re.IGNORECASE) is None


def test_t_projection_contains_no_null_masking() -> None:
    _, expressions = _insert_projection()
    projection = ", ".join(expressions)
    assert re.search(
        r"\b(?:coalesce|ifnull|nvl|zeroifnull|try_cast|try_to_[a-z0-9_]*)\s*\(",
        projection,
        re.IGNORECASE,
    ) is None
    assert re.search(r"\bdefault\b", projection, re.IGNORECASE) is None


def test_t_run_id_guard_literal_executes_against_hostile_table() -> None:
    guard = re.search(
        r"regexp_like\s*\(\s*p_run_id\s*,\s*'(?P<grammar>\^\[0-9a-zA-Z_-\]\{1,64\}\$)'",
        STRIPPED,
    )
    assert guard is not None
    grammar = guard.group("grammar")
    hostile = (
        "a'b",
        "a\\b",
        "../x",
        "a/b",
        "a.b",
        "x@y",
        "a%b",
        "a" * 65,
        "",
        "a b",
        "a\nb",
    )
    assert all(re.fullmatch(grammar, candidate) is None for candidate in hostile)
    assert re.fullmatch(grammar, ROAST_ID) is not None
    assert re.fullmatch(grammar, "plainAlphanumeric42") is not None


def test_t_guards_precede_dynamic_sql_transaction_and_dml() -> None:
    roast_guard = re.search(r"regexp_like\s*\(\s*p_roast_id", STRIPPED, re.I)
    run_guard = re.search(r"regexp_like\s*\(\s*p_run_id", STRIPPED, re.I)
    transaction = re.search(r"begin\s+transaction\s*;", STRIPPED, re.I)
    execute = re.search(r"execute\s+immediate", STRIPPED, re.I)
    first_dml = re.search(r"delete\s+from\s+app\.roast_telemetry", STRIPPED, re.I)
    assert all(match is not None for match in (roast_guard, run_guard, transaction, execute, first_dml))
    assert roast_guard.start() < run_guard.start() < transaction.start() < execute.start()
    assert roast_guard.start() < first_dml.start()
    assert run_guard.start() < first_dml.start()


def test_t_replay_delete_is_bound_scoped_and_inside_transaction() -> None:
    transaction = re.search(
        r"begin\s+transaction\s*;(?P<body>.*?)\bcommit\s*;",
        STRIPPED,
        re.IGNORECASE | re.DOTALL,
    )
    assert transaction is not None
    delete = re.search(
        r"delete\s+from\s+app\.roast_telemetry\s+where\s+roast_id\s*=\s*:p_roast_id\s*;",
        transaction.group("body"),
        re.IGNORECASE,
    )
    execute = re.search(r"execute\s+immediate", transaction.group("body"), re.IGNORECASE)
    assert delete is not None and execute is not None and delete.start() < execute.start()
    assert len(re.findall(r"delete\s+from\s+app\.roast_telemetry", STRIPPED, re.I)) == 1
    assert re.search(r"\btruncate\b", STRIPPED, re.IGNORECASE) is None


def test_t_zero_row_guard_is_after_insert_before_commit() -> None:
    insert = re.search(r"execute\s+immediate", STRIPPED, re.IGNORECASE)
    guard = re.search(
        r"if\s*\(\s*sqlrowcount\s*=\s*0\s*\)\s*then\s*"
        r"raise\s+no_telemetry_loaded\s*;\s*end\s+if\s*;",
        STRIPPED,
        re.IGNORECASE,
    )
    commit = re.search(r"\bcommit\s*;", STRIPPED, re.IGNORECASE)
    assert insert is not None and guard is not None and commit is not None
    assert insert.start() < guard.start() < commit.start()


def test_t_transaction_rolls_back_and_reraises() -> None:
    assert re.search(
        r"exception\s+when\s+other\s+then\s+rollback\s*;\s*raise\s*;",
        STRIPPED,
        re.IGNORECASE,
    ) is not None


def test_t_dynamic_sql_interpolates_exactly_two_validated_parameters() -> None:
    without_literals = re.sub(r"'(?:''|[^'])*'", "", _execute_expression())
    variables = re.findall(r"\b[pv]_[a-z0-9_]+\b", without_literals, re.IGNORECASE)
    assert variables == ["p_roast_id", "p_run_id"]
    operators_only = re.sub(r"\bp_(?:roast|run)_id\b", "", without_literals)
    assert operators_only.replace("||", "").strip() == ";"
    executes = re.findall(r"execute\s+immediate\s+:v_insert_sql\s*;", STRIPPED, re.I)
    assert len(executes) == 1


def test_t_exception_codes_are_unique_across_procedures() -> None:
    codes: list[str] = []
    for path in sorted((SNOWFLAKE_DIR / "migrations").glob("R__proc_*.sql")):
        codes.extend(re.findall(r"exception\s*\(\s*(-200\d+)\s*,", path.read_text(), re.I))
    assert Counter(codes) == Counter({f"-2000{number}": 1 for number in range(1, 8)})


def test_t_stage_basename_is_single_and_pinned_adjacent() -> None:
    assert MIGRATION.count("roast.jsonl") == 1
    lines = MIGRATION.splitlines()
    basename_line = next(index for index, line in enumerate(lines) if "roast.jsonl" in line)
    pin_line = next(index for index, line in enumerate(lines) if "PINNED AT #417" in line)
    assert basename_line == pin_line + 1


def test_t_real_fixtures_have_independent_closed_shapes_and_counts() -> None:
    """Real rows cover the happy path; null-path intent needs synthetic tests below."""
    expected_counts = {
        "session-1": {"telemetry": 273, "event": 5},
        "session-2": {"telemetry": 270, "event": 5},
    }
    expected_first = {
        "session-1": (8.32387712498894, 24.0, 24.0, 0, 0, None, None),
        "session-2": (2.998852041986538, 38.0, 43.0, 0, 0, None, None),
    }
    for session in ("session-1", "session-2"):
        fixture = SNOWFLAKE_DIR / "fixtures" / "m1-export" / session / "roast.jsonl"
        source_rows = [json.loads(line) for line in fixture.read_text().splitlines()]
        counts = Counter(row["type"] for row in source_rows)
        assert counts == expected_counts[session]
        telemetry = [row for row in source_rows if row["type"] == "telemetry"]
        events = [row for row in source_rows if row["type"] == "event"]
        assert {frozenset(row) for row in telemetry} == {frozenset(TELEMETRY_KEYS)}
        assert {frozenset(row) for row in events} == {frozenset(EVENT_KEYS)}
        assert all(row["monotonic_seconds"] is not None for row in events)
        assert all(map_source_row(row, ROAST_ID) is None for row in events)
        assert all("ror_c_per_min" not in row for row in source_rows)
        assert all(
            all(
                row[key] is not None
                for key in (
                    "monotonic_seconds",
                    "bean_temp_c",
                    "env_temp_c",
                    "heat_level_percent",
                    "fan_level_percent",
                )
            )
            for row in telemetry
        )
        mapped = fixture_expected_rows(fixture, ROAST_ID)
        first = mapped[0]
        assert (
            first["elapsed_s"],
            first["bean_temp_c"],
            first["env_temp_c"],
            first["heat_percent"],
            first["fan_percent"],
            first["ror_c_per_min"],
            first["raw"],
        ) == expected_first[session]
        assert first["elapsed_s"] != 0


def test_t_synthetic_rows_pin_mapping_intent_not_snowflake_behavior() -> None:
    """Synthetic literals prove mapping intent, not Snowflake cast/constraint behaviour."""
    missing_bean = {
        "type": "telemetry",
        "monotonic_seconds": 1.0,
        "env_temp_c": 20.0,
        "heat_level_percent": 10,
        "fan_level_percent": 20,
    }
    null_bean = {
        "type": "telemetry",
        "monotonic_seconds": 2.0,
        "bean_temp_c": None,
        "env_temp_c": 21.0,
        "heat_level_percent": 11,
        "fan_level_percent": 21,
    }
    missing_elapsed = {
        "type": "telemetry",
        "bean_temp_c": 30.0,
        "env_temp_c": 22.0,
        "heat_level_percent": 12,
        "fan_level_percent": 22,
    }
    out_of_range_heat = {
        "type": "telemetry",
        "monotonic_seconds": 4.0,
        "bean_temp_c": 31.0,
        "env_temp_c": 23.0,
        "heat_level_percent": 250,
        "fan_level_percent": 23,
    }
    event = {
        "type": "event",
        "kind": "charge",
        "monotonic_seconds": 5.0,
        "payload": {},
    }
    assert map_source_row(missing_bean, ROAST_ID)["bean_temp_c"] is None
    assert map_source_row(null_bean, ROAST_ID)["bean_temp_c"] is None
    assert map_source_row(missing_elapsed, ROAST_ID)["elapsed_s"] is None
    assert map_source_row(out_of_range_heat, ROAST_ID)["heat_percent"] == 250
    assert map_source_row(event, ROAST_ID) is None


def test_t_data_quality_view_stays_at_nine_non_telemetry_branches() -> None:
    view = (SNOWFLAKE_DIR / "migrations" / "R__data_quality_view.sql").read_text()
    stripped = re.sub(r"--[^\n]*(?:\n|$)|/\*.*?\*/", "", view, flags=re.DOTALL)
    assert len(re.findall(r"\bunion\s+all\b", stripped, re.IGNORECASE)) == 8
    assert len(re.findall(r"\bselect\b", stripped, re.IGNORECASE)) == 9
    assert "roast_telemetry" not in stripped.lower()
