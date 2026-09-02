"""Offline text contract for UPSERT_ROAST (issue #417), T-1 through T-38.

These checks assert shipped migration structure and independently transcribed
literals. They do not emulate Snowflake; runtime semantics remain live-gated.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

import pytest

import test_load_roast_telemetry as telemetry_contract


SNOWFLAKE_DIR = Path(__file__).resolve().parent.parent
MIGRATION_PATH = SNOWFLAKE_DIR / "migrations" / "R__proc_upsert_roast.sql"
MIGRATION = MIGRATION_PATH.read_text(encoding="utf-8")
STRIPPED = re.sub(r"--[^\n]*(?:\n|$)|/\*.*?\*/", "", MIGRATION, flags=re.DOTALL)
DELETE_MIGRATION = (
    SNOWFLAKE_DIR / "migrations" / "R__proc_delete_roast.sql"
).read_text(encoding="utf-8")
TELEMETRY_MIGRATION = (
    SNOWFLAKE_DIR / "migrations" / "R__proc_load_roast_telemetry.sql"
).read_text(encoding="utf-8")
RECOMPUTE_MIGRATION = (
    SNOWFLAKE_DIR / "migrations" / "R__proc_recompute_summary.sql"
).read_text(encoding="utf-8")
CELSIUS_FORBIDDEN = re.compile(
    r"fahrenheit|_f\b|\*\s*9\s*/\s*5|\*\s*1\.8|\+\s*32",
    re.IGNORECASE,
)

RUN_ID = "01234567-89ab-cdef-0123-456789abcdef"
PAYLOAD_KEYS = (
    "public_slug",
    "visibility",
    "bean_origin",
    "bean_varietal",
    "bean_weight_g",
    "profile_name",
    "roast_level",
    "operator_rating",
    "operator_notes",
    "contributed_to_learning",
    "roasted_at_utc",
    "summary",
    "artifact_kinds",
)
ARTIFACT_BASENAMES = {
    "jsonl": "roast.jsonl",
    "csv": "roast.csv",
    "summary": "summary.json",
}
EXPECTED_STAGE_PATHS = {
    "jsonl": "@app.roast_artifacts/01234567-89ab-cdef-0123-456789abcdef/roast.jsonl",
    "csv": "@app.roast_artifacts/01234567-89ab-cdef-0123-456789abcdef/roast.csv",
    "summary": "@app.roast_artifacts/01234567-89ab-cdef-0123-456789abcdef/summary.json",
}
CLOUD_ROAST_COLUMNS = (
    "id",
    "idempotency_key",
    "owner_id",
    "public_slug",
    "visibility",
    "bean_origin",
    "bean_varietal",
    "bean_weight_g",
    "profile_name",
    "roast_level",
    "summary",
    "operator_rating",
    "operator_notes",
    "contributed_to_learning",
    "roasted_at_utc",
    "created_at",
    "updated_at",
)


def _match(pattern: str, text: str = STRIPPED) -> re.Match[str]:
    match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
    assert match is not None, f"pattern not found: {pattern}"
    return match


def _region(start_pattern: str, end_pattern: str, text: str = STRIPPED) -> str:
    start = _match(start_pattern, text)
    tail = text[start.end() :]
    end = _match(end_pattern, tail)
    return tail[: end.start()]


def _transaction() -> str:
    return _region(r"begin\s+transaction\s*;", r"\bcommit\s*;")


def _merge() -> str:
    return _region(r"merge\s+into\s+app\.cloud_roasts", r";", _transaction())


def _matched_set() -> str:
    return _region(
        r"when\s+matched\s+then\s+update\s+set",
        r"when\s+not\s+matched\s+then\s+insert",
        _merge(),
    )


def _insert_parts() -> tuple[list[str], list[str]]:
    match = _match(
        r"when\s+not\s+matched\s+then\s+insert\s*\((?P<columns>.*?)\)\s*"
        r"values\s*\((?P<values>.*?)\)\s*$",
        _merge(),
    )
    columns = [item.strip().lower() for item in match.group("columns").split(",")]
    values = [item.strip().lower() for item in match.group("values").split(",")]
    return columns, values


def _artifact_insert() -> str:
    return _region(
        r"insert\s+into\s+app\.roast_artifacts",
        r";",
        _transaction(),
    )


def _roast_id_guard_grammar(migration: str) -> str:
    guard = re.search(
        r"regexp_like\s*\(\s*p_roast_id\s*,\s*'(?P<grammar>\^[^']+\$)'",
        migration,
        re.IGNORECASE,
    )
    assert guard is not None
    return guard.group("grammar")


def _run_id_guard_grammar(migration: str) -> str:
    guard = re.search(
        r"regexp_like\s*\(\s*p_run_id\s*,\s*'(?P<grammar>\^[^']+\$)'",
        migration,
        re.IGNORECASE,
    )
    assert guard is not None
    return guard.group("grammar")


def _assert_celsius_only(value: object) -> None:
    assert CELSIUS_FORBIDDEN.search(json.dumps(value, sort_keys=True)) is None


def _find_repo_root() -> Path:
    marker = Path("scripts") / "seed" / "rules.ts"
    for candidate in Path(__file__).resolve().parents:
        if (candidate / marker).is_file():
            return candidate
    raise AssertionError(f"repository root containing {marker} not found from {__file__}")


def test_t01_exact_signature_attributes_and_single_create() -> None:
    expected = """create or replace procedure upsert_roast(p_run_id string, p_payload string)
copy grants
returns variant
language sql
execute as owner
as"""
    assert expected in STRIPPED
    assert len(re.findall(r"create\s+or\s+replace\s+procedure\b", STRIPPED, re.I)) == 1
    assert re.search(r"execute\s+as\s+caller", STRIPPED, re.I) is None


def test_t02_use_schema_precedes_create() -> None:
    use_schema = _match(r"use\s+schema\s+app\s*;")
    create = _match(r"create\s+or\s+replace\s+procedure")
    assert use_schema.start() < create.start()


def test_t03_single_merge_has_exact_idempotency_on_clause() -> None:
    assert len(re.findall(r"merge\s+into\s+app\.cloud_roasts\b", STRIPPED, re.I)) == 1
    assert re.search(
        r"\)\s+as\s+source\s+on\s+target\.idempotency_key\s*=\s*"
        r"source\.idempotency_key\s+when\s+matched",
        _merge(),
        re.I,
    )


@pytest.mark.parametrize(
    "immutable",
    ["id", "idempotency_key", "owner_id", "public_slug", "visibility", "created_at"],
)
def test_t04_matched_update_excludes_each_immutable_column(immutable: str) -> None:
    assignments = re.findall(r"\b([a-z_]+)\s*=", _matched_set(), re.I)
    assert immutable not in assignments, f"matched update leaked immutable column {immutable}"


def test_t05_matched_update_refreshes_updated_at() -> None:
    assert re.search(r"updated_at\s*=\s*current_timestamp\(\)", _matched_set(), re.I)


def test_t05b_matched_update_contains_only_payload_columns_or_updated_at() -> None:
    assignments = set(re.findall(r"\b([a-z_]+)\s*=", _matched_set(), re.I))
    expected = {
        "bean_origin",
        "bean_varietal",
        "bean_weight_g",
        "profile_name",
        "roast_level",
        "summary",
        "operator_rating",
        "operator_notes",
        "contributed_to_learning",
        "roasted_at_utc",
        "updated_at",
    }
    assert assignments == expected
    assert assignments <= set(PAYLOAD_KEYS) | {"updated_at"}


def test_t06_insert_has_all_17_columns_and_explicit_generators() -> None:
    columns, values = _insert_parts()
    assert columns == list(CLOUD_ROAST_COLUMNS)
    assert values == [f"source.{column}" for column in CLOUD_ROAST_COLUMNS]
    source = _region(r"using\s*\(\s*select", r"\)\s+as\s+source", _merge())
    assert re.search(r"uuid_string\(\)\s+as\s+id", source, re.I)
    assert len(re.findall(r"current_timestamp\(\)", source, re.I)) == 2


def test_t07_return_pair_is_read_after_merge_from_stored_row() -> None:
    merge = _match(r"merge\s+into\s+app\.cloud_roasts")
    stored = _match(
        r"select\s+id\s*,\s*public_slug\s+into\s+:v_id\s*,\s*:v_slug\s+"
        r"from\s+app\.cloud_roasts\s+where\s+idempotency_key\s*=\s*:p_run_id\s*;"
    )
    returned = _match(
        r"return\s+object_construct\(\s*'cloud_roast_id'\s*,\s*v_id\s*,\s*"
        r"'public_slug'\s*,\s*v_slug\s*\)\s*;"
    )
    assert merge.start() < stored.start() < returned.start()


def test_t08_return_never_reads_payload() -> None:
    returned = _match(r"return\s+object_construct\([^;]+\)\s*;").group(0)
    assert "p_payload" not in returned.lower()
    assert re.findall(r"\bv_[a-z_]+\b", returned, re.I) == ["v_id", "v_slug"]


def test_t09_seed_loader_slug_update_divergence_stays_pinned() -> None:
    """Agent replay must not copy seed_load_live.py's URL-rotating update."""
    assert re.search(r"public_slug\s*=\s*source\.public_slug", STRIPPED, re.I) is None


def test_t10_artifact_replace_delete_is_bound_and_precedes_insert() -> None:
    transaction = _transaction()
    delete = _match(
        r"delete\s+from\s+app\.roast_artifacts\s+where\s+roast_id\s*=\s*:v_id\s*;",
        transaction,
    )
    insert = _match(r"insert\s+into\s+app\.roast_artifacts", transaction)
    assert delete.start() < insert.start()
    assert len(re.findall(r"delete\s+from\s+app\.roast_artifacts", STRIPPED, re.I)) == 1
    assert ":p_run_id" not in delete.group(0)


@pytest.mark.parametrize("kind, expected_path", EXPECTED_STAGE_PATHS.items())
def test_t11_stage_path_renders_exact_closed_mapping(kind: str, expected_path: str) -> None:
    insert = _artifact_insert()
    assert re.search(
        r"'@app\.roast_artifacts/'\s*\|\|\s*:p_run_id\s*\|\|\s*'/'\s*\|\|\s*case",
        insert,
        re.I,
    )
    pairs = dict(re.findall(r"when\s+'([^']+)'\s+then\s+'([^']+)'", insert, re.I))
    assert pairs == ARTIFACT_BASENAMES
    rendered_path = f"@app.roast_artifacts/{RUN_ID}/{pairs[kind]}"
    assert rendered_path == expected_path


def test_t12_stage_path_never_uses_kind_as_terminal_basename() -> None:
    insert = _artifact_insert()
    assert not any(f"/{kind}'" in insert.lower() for kind in ARTIFACT_BASENAMES)


def test_t13_stage_path_is_not_caller_supplied() -> None:
    insert = _artifact_insert().lower()
    assert "p_payload" not in insert
    assert "v_payload" not in insert
    assert "stage_path" in insert


def test_t14_cloud_roast_id_never_enters_stage_path_expression() -> None:
    expression = _match(r"'@app\.roast_artifacts/'.*?end\s*,", _artifact_insert()).group(0)
    assert "v_id" not in expression.lower()


def test_t14b_run_id_never_enters_artifact_roast_id_expression() -> None:
    insert = _artifact_insert()
    projection = _match(r"select\s+uuid_string\(\)\s*,\s*:v_id\s*,", insert).group(0)
    assert "p_run_id" not in projection.lower()


def test_t15_artifact_insert_has_exact_columns_and_generated_null_fields() -> None:
    insert = _artifact_insert()
    columns = _match(r"\((?P<columns>.*?)\)\s*select", insert).group("columns")
    assert [item.strip().lower() for item in columns.split(",")] == [
        "id", "roast_id", "kind", "stage_path", "byte_size", "created_at"
    ]
    assert re.search(r"select\s+uuid_string\(\)\s*,\s*:v_id\s*,\s*artifact\.value::string", insert, re.I)
    assert re.search(r"end\s*,\s*null\s*,\s*current_timestamp\(\)", insert, re.I)


def test_t16_one_flatten_drives_one_artifact_insert() -> None:
    assert len(re.findall(r"insert\s+into\s+app\.roast_artifacts", STRIPPED, re.I)) == 1
    assert re.search(
        r"from\s+table\s*\(\s*flatten\s*\(\s*input\s*=>\s*:v_artifact_kinds\s*\)\s*\)",
        _artifact_insert(),
        re.I,
    )


def test_t17_jsonl_basename_byte_matches_telemetry_consumer() -> None:
    assert ARTIFACT_BASENAMES["jsonl"] == "roast.jsonl"
    consumer = re.findall(r"[a-z]+[.]jsonl", TELEMETRY_MIGRATION)
    assert consumer == [ARTIFACT_BASENAMES["jsonl"]]


def test_t18_telemetry_adjacent_basename_pin_remains_green() -> None:
    telemetry_contract.test_t_stage_basename_is_single_and_pinned_adjacent()


def test_t19_exactly_two_recomputes_are_after_merge_inside_transaction() -> None:
    transaction = _transaction()
    merge = _match(r"merge\s+into\s+app\.cloud_roasts", transaction)
    calls = list(re.finditer(r"call\s+app\.recompute_reference_summary\s*\(", transaction, re.I))
    assert len(calls) == 2
    assert all(merge.start() < call.start() for call in calls)


def test_t20_premerge_group_capture_precedes_merge() -> None:
    transaction = _transaction()
    capture = _match(
        r"select\s+count\(\*\)\s*,\s*any_value\(bean_origin\)\s*,\s*"
        r"any_value\(roast_level\).*?where\s+idempotency_key\s*=\s*:p_run_id\s*;",
        transaction,
    )
    merge = _match(r"merge\s+into\s+app\.cloud_roasts", transaction)
    assert capture.start() < merge.start()
    assert transaction[capture.end() : merge.start()].strip() == ""


def test_t21_old_group_call_requires_a_real_group_change() -> None:
    guard = _match(
        r"if\s*\(\s*v_existing_count\s*>\s*0.*?"
        r"v_old_bean_origin\s+is\s+distinct\s+from\s+v_new_bean_origin.*?"
        r"v_old_roast_level\s+is\s+distinct\s+from\s+v_new_roast_level.*?"
        r"call\s+app\.recompute_reference_summary\s*"
        r"\(\s*:v_old_bean_origin\s*,\s*:v_old_roast_level\s*\)\s*;.*?end\s+if\s*;"
    )
    assert re.search(r"\bor\b", guard.group(0), re.I)


def test_t22_new_group_call_is_unconditional_and_callee_owns_null_noop() -> None:
    transaction = _transaction()
    new_call = _match(
        r"call\s+app\.recompute_reference_summary\s*"
        r"\(\s*:v_new_bean_origin\s*,\s*:v_new_roast_level\s*\)\s*;",
        transaction,
    )
    prefix = transaction[: new_call.start()]
    assert re.search(r"if\s*\([^;]*v_new_(?:bean_origin|roast_level)", prefix, re.I) is None
    assert re.search(
        r"if\s*\(\s*bean_origin\s+is\s+null\s+or\s+roast_level\s+is\s+null\s*\)",
        RECOMPUTE_MIGRATION,
        re.I,
    )


def test_t23_scope_fence_has_no_grant_token() -> None:
    assert re.search(r"\bgrant\b", STRIPPED, re.I) is None


def test_t24_celsius_only() -> None:
    _assert_celsius_only(STRIPPED)


def test_t25_no_dynamic_sql_and_concat_only_builds_stage_path() -> None:
    assert re.search(r"execute\s+immediate", STRIPPED, re.I) is None
    insert = _artifact_insert()
    assert len(re.findall(r"\|\|", STRIPPED)) == 3
    assert len(re.findall(r"\|\|", insert)) == 3


def test_t26_transaction_has_one_rollback_reraise_handler() -> None:
    handlers = re.findall(
        r"exception\s+when\s+other\s+then\s+rollback\s*;\s*raise\s*;",
        STRIPPED,
        re.I,
    )
    assert len(handlers) == 1


def test_t27_exception_codes_are_the_unique_contiguous_allocation() -> None:
    codes: list[str] = []
    for path in sorted((SNOWFLAKE_DIR / "migrations").glob("R__proc_*.sql")):
        codes.extend(re.findall(r"exception\s*\(\s*(-200\d+)\s*,", path.read_text(), re.I))
    assert Counter(codes) == Counter({f"-{20000 + number}": 1 for number in range(1, 12)})


def test_t28_closed_payload_key_set_is_exactly_13() -> None:
    actual = re.findall(
        r"array_contains\(\s*'([^']+)'::variant\s*,\s*object_keys\(v_payload\)\s*\)",
        STRIPPED,
        re.I,
    )
    assert tuple(actual) == PAYLOAD_KEYS
    assert re.search(r"array_size\(object_keys\(v_payload\)\)\s*<>\s*13", STRIPPED, re.I)


def test_t29_slug_guard_rejects_hostile_table_and_accepts_boundaries() -> None:
    grammar = _match(
        r"regexp_like\s*\(\s*v_payload:public_slug::string\s*,\s*'(?P<grammar>\^[^']+\$)'"
    ).group("grammar")
    hostile = (
        "", "1" * 16, "1" * 65, "0" + "1" * 16, "O" + "1" * 16,
        "I" + "1" * 16, "l" + "1" * 16, "1-" + "1" * 15,
        "1_" + "1" * 15, "1/" + "1" * 15, "1'" + "1" * 15,
        "1" * 17 + "\n", "1" * 17 + " ",
    )
    assert all(re.fullmatch(grammar, value) is None for value in hostile)
    assert re.fullmatch(grammar, "123456789ABCDEFGHJKLMNP")
    assert re.fullmatch(grammar, "123456789ABCDEFGH")
    assert re.fullmatch(grammar, "1" * 64)


def test_t30_visibility_enum_matches_quality_view_and_rejects_hostile_table() -> None:
    guard = _match(r"visibility::string\s+not\s+in\s*\((?P<values>[^)]+)\)")
    guard_values = tuple(re.findall(r"'([^']+)'", guard.group("values")))
    view = (SNOWFLAKE_DIR / "migrations" / "R__data_quality_view.sql").read_text()
    view_values = tuple(re.findall(r"'([^']+)'", _match(
        r"visibility\s+not\s+in\s*\((?P<values>[^)]+)\)", view
    ).group("values")))
    assert guard_values == view_values == ("private", "unlisted", "public")
    assert all(value not in guard_values for value in ("Private", "PUBLIC", "", "unlisted ", "public;--"))


def test_t31_operator_rating_bounds_are_one_through_five() -> None:
    guard = _match(
        r"operator_rating::int\s*<\s*(?P<minimum>\d+)\s+or\s+"
        r"v_payload:operator_rating::int\s*>\s*(?P<maximum>\d+)"
    )
    minimum, maximum = int(guard.group("minimum")), int(guard.group("maximum"))
    assert (minimum, maximum) == (1, 5)
    assert all(not minimum <= value <= maximum for value in (0, 6, -1))
    assert all(minimum <= value <= maximum for value in (1, 5))


def test_t32_artifact_kind_set_matches_seed_rules_and_rejects_hostiles() -> None:
    guard = _match(r"value::string\s+not\s+in\s*\((?P<values>[^)]+)\)")
    kinds = tuple(re.findall(r"'([^']+)'", guard.group("values")))
    rules = (_find_repo_root() / "scripts" / "seed" / "rules.ts").read_text()
    seed_kinds = tuple(re.findall(r'"([^"]+)"', _match(
        r"ARTIFACT_KINDS\s*=\s*\[(?P<values>[^]]+)\]", rules
    ).group("values")))
    assert kinds == seed_kinds == tuple(ARTIFACT_BASENAMES)
    assert re.search(r"v_artifact_count\s*=\s*0", STRIPPED, re.I)
    assert re.search(r"v_distinct_artifact_count\s*<>\s*v_artifact_count", STRIPPED, re.I)
    assert all(value not in kinds for value in ("JSONL", "json", ""))


def test_t33_uuid_guard_literal_is_byte_equal_across_three_procedures() -> None:
    expected = _roast_id_guard_grammar(DELETE_MIGRATION)
    assert _roast_id_guard_grammar(TELEMETRY_MIGRATION) == expected
    assert _run_id_guard_grammar(MIGRATION) == expected


def test_t34_run_id_guard_rejects_hostile_table_by_design() -> None:
    """The C3-S1 live-verifier token is intentionally outside this UUID grammar."""
    grammar = _run_id_guard_grammar(MIGRATION)
    hostile = (
        "../x", "a/b", "a'b", "a\\b", RUN_ID.upper(), RUN_ID[:-1],
        RUN_ID + "\n", "", "c3_s1_live_verify",
    )
    assert all(re.fullmatch(grammar, value) is None for value in hostile)
    assert re.fullmatch(grammar, RUN_ID)


def test_t35_every_guard_precedes_transaction_and_first_dml() -> None:
    raises = list(re.finditer(r"raise\s+invalid_(?:run_id|payload)\s*;", STRIPPED, re.I))
    transaction = _match(r"begin\s+transaction\s*;")
    first_dml = _match(r"merge\s+into\s+app\.cloud_roasts")
    assert len(raises) >= 2
    assert all(guard.start() < transaction.start() < first_dml.start() for guard in raises)


def test_t36_ambiguity_guard_is_after_merge_before_commit() -> None:
    transaction = _transaction()
    merge = _match(r"merge\s+into\s+app\.cloud_roasts", transaction)
    guard = _match(
        r"select\s+count\(\*\)\s+into\s+:v_count\s+from\s+app\.cloud_roasts\s+"
        r"where\s+idempotency_key\s*=\s*:p_run_id\s*;\s*"
        r"if\s*\(\s*v_count\s*<>\s*1\s*\)\s*then\s*"
        r"raise\s+ambiguous_idempotency_key\s*;\s*end\s+if\s*;",
        transaction,
    )
    assert merge.start() < guard.start()


def test_t36b_duplicate_slug_guard_is_postmerge_and_counts_stored_slug() -> None:
    transaction = _transaction()
    merge = _match(r"merge\s+into\s+app\.cloud_roasts", transaction)
    stored = _match(
        r"select\s+id\s*,\s*public_slug\s+into\s+:v_id\s*,\s*:v_slug.*?;",
        transaction,
    )
    guard = _match(
        r"v_public_slug\s*:=\s*v_slug\s*;\s*"
        r"select\s+count\(\*\)\s+into\s+:v_slug_count\s+"
        r"from\s+app\.cloud_roasts\s+where\s+public_slug\s*=\s*:v_public_slug\s*;\s*"
        r"if\s*\(\s*v_slug_count\s*<>\s*1\s*\)\s*then\s*"
        r"raise\s+duplicate_public_slug\s*;\s*end\s+if\s*;",
        transaction,
    )
    assert merge.start() < stored.start() < guard.start()


def test_t36c_data_quality_view_flags_duplicate_public_slug_exactly() -> None:
    view = (SNOWFLAKE_DIR / "migrations" / "R__data_quality_view.sql").read_text()
    branch = _match(
        r"select\s+'cloud_roasts'\s+as\s+table_name\s*,\s*"
        r"public_slug\s+as\s+row_identity\s*,\s*'public_slug'\s+as\s+field\s*,\s*"
        r"'duplicate public_slug'\s+as\s+rule\s+from\s+cloud_roasts\s+"
        r"group\s+by\s+public_slug\s+having\s+count\(\*\)\s*>\s*1\s*;",
        view,
    )
    assert branch is not None


def test_t37_write_projections_have_no_null_masking_or_try_casts() -> None:
    projections = _merge() + _artifact_insert()
    assert re.search(
        r"\b(?:coalesce|ifnull|nvl|zeroifnull|try_cast|try_to_[a-z0-9_]*)\s*\(",
        projections,
        re.I,
    ) is None
    assert "uuid_string()" in projections.lower()
    assert "current_timestamp()" in projections.lower()


def test_t38_exception_messages_are_static_and_never_echo_payload() -> None:
    declarations = re.findall(r"exception\s*\(\s*-200(?:08|09|10|11)\s*,\s*'[^']+'\s*\)", STRIPPED, re.I)
    assert len(declarations) == 4
    assert all("p_payload" not in declaration.lower() for declaration in declarations)
    assert re.search(r"raise\s+invalid_payload\s*\|\|", STRIPPED, re.I) is None
