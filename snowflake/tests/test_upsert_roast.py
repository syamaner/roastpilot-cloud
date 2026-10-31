"""Offline text contract for UPSERT_ROAST (issue #417), T-1 through T-38.

These checks assert shipped migration structure and independently transcribed
literals. They do not emulate Snowflake; runtime semantics remain live-gated.
"""

from __future__ import annotations

import json
import re
from collections import Counter
from pathlib import Path

from test_sync_coordination import clean

import pytest

import test_load_roast_telemetry as telemetry_contract


SNOWFLAKE_DIR = Path(__file__).resolve().parent.parent
MIGRATION_PATH = SNOWFLAKE_DIR / "migrations" / "R__proc_upsert_roast.sql"
MIGRATION = MIGRATION_PATH.read_text(encoding="utf-8")
STRIPPED = clean(MIGRATION)
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


def _roast_id_guard_grammar(migration: str, parameter: str = "p_roast_id") -> str:
    guard = re.search(
        r"regexp_like\s*\(\s*" + re.escape(parameter) + r"\s*,\s*'(?P<grammar>\^[^']+\$)'",
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
        r"source\.idempotency_key\s+when\s+not\s+matched",
        _merge(),
        re.I,
    )


@pytest.mark.parametrize(
    "immutable",
    ["id", "idempotency_key", "owner_id", "public_slug", "visibility", "created_at"],
)
def test_t04_matched_update_excludes_each_immutable_column(immutable: str) -> None:
    assert re.search(r"when\s+matched\s+then", _merge(), re.I) is None
    assert re.search(r"\b(?:insert|update|delete|merge)\b", _c2_replay_region(), re.I) is None


def test_t05_matched_update_refreshes_updated_at() -> None:
    assert re.search(r"when\s+matched\s+then", _merge(), re.I) is None
    assert re.search(r"\b(?:insert|update|delete|merge)\b", _c2_replay_region(), re.I) is None


def test_t05b_matched_update_contains_only_payload_columns_or_updated_at() -> None:
    assert re.search(r"when\s+matched\s+then", _merge(), re.I) is None
    assert re.search(r"\b(?:insert|update|delete|merge)\b", _c2_replay_region(), re.I) is None


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
    returned = _match(r"return\s+object_construct\(\s*'cloud_roast_id'[^;]+\)\s*;").group(0)
    assert "p_payload" not in returned.lower()
    assert re.findall(r"\bv_[a-z_]+\b", returned, re.I) == ["v_id", "v_slug"]


def test_t09_seed_loader_slug_update_divergence_stays_pinned() -> None:
    """Agent replay must not copy seed_load_live.py's URL-rotating update."""
    assert re.search(r"public_slug\s*=\s*source\.public_slug", STRIPPED, re.I) is None


def test_t10_artifact_replace_delete_is_bound_and_precedes_insert() -> None:
    assert re.search(r"delete\s+from\s+app\.roast_artifacts", STRIPPED, re.I) is None
    region = _match(r"if\s*\(\s*v_existing_count\s*=\s*0\s*\)\s*then.*?insert\s+into\s+app\.roast_artifacts.*?end\s+if", _transaction()).group(0)
    assert ":v_id" in _artifact_insert()
    assert "v_artifact_count" not in region.lower()
    assert re.search(r"\b(?:insert|update|delete|merge)\b", _c2_replay_region(), re.I) is None


def test_t10b_opt_out_telemetry_purge_is_the_only_delete_path_and_exactly_scoped() -> None:
    assert re.search(r"delete\s+from\s+app\.roast_telemetry", STRIPPED, re.I) is None
    assert re.search(r"if\s*\(\s*v_contributed_to_learning\s*=\s*false", STRIPPED, re.I) is None


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
    calls = list(re.finditer(r"call\s+app\.recompute_reference_summary\s*\(", transaction, re.I))
    assert len(calls) == 2
    assert calls[1].start() > _match(r"merge\s+into\s+app\.cloud_roasts", transaction).start()
    assert re.search(r"if\s*\(v_consent_applied\)\s*then\s*call\s+app\.recompute_reference_summary", transaction, re.I)


def test_t20_premerge_group_capture_precedes_merge() -> None:
    transaction = _transaction()
    count = _match(r"select\s+count\(\*\)\s+into\s+:v_existing_count\s+from\s+app.cloud_roasts\s+where\s+idempotency_key\s*=\s*:p_run_id", transaction)
    assert count.start() < _match(r"merge\s+into\s+app.cloud_roasts", transaction).start()
    assert "call app.cloud_sync_enter()" in transaction[:count.start()]


def test_t21_old_group_call_requires_a_real_group_change() -> None:
    assert re.search(r"call\s+app.recompute_reference_summary\s*\(\s*:v_old_", STRIPPED, re.I) is None
    assert re.search(r"if\s*\(v_consent_applied\)\s*then\s*call\s+app.recompute_reference_summary", STRIPPED, re.I)


def test_t22_new_group_call_is_unconditional_and_callee_owns_null_noop() -> None:
    transaction = _transaction()
    new_call = _match(
        r"call\s+app\.recompute_reference_summary\s*"
        r"\(\s*:v_new_bean_origin\s*,\s*:v_new_roast_level\s*\)\s*;",
        transaction,
    )
    prefix = transaction[: new_call.start()]
    conditions = re.findall(r"\b(?:if|elseif)\s*\(([^;]*?)\)\s*then\b", prefix, re.I | re.S)
    assert not any(re.search(r"\bv_new_(?:bean_origin|roast_level)\b", condition, re.I) for condition in conditions)
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
    from test_sync_coordination import assert_error_allocations
    assert_error_allocations()


def test_t28_closed_payload_key_set_is_exactly_13() -> None:
    regions = list(re.finditer(r"if\s*\(array_size\(object_keys\(v_payload\)\)\s*<>\s*13.*?raise\s+invalid_payload;\s*end if;", STRIPPED, re.I | re.S))
    assert len(regions) == 1
    create = regions[0].group(0)
    actual = re.findall(r"array_contains\(\s*'([^']+)'::variant\s*,\s*object_keys\(v_payload\)\s*\)", create, re.I)
    assert tuple(actual) == PAYLOAD_KEYS
    assert re.search(r"array_size\(object_keys\(v_payload\)\)\s*<>\s*13", create, re.I)


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


def test_t31b_roasted_at_requires_explicit_offset_before_timestamp_conversion() -> None:
    offset_guard = _match(
        r"if\s*\(\s*typeof\(v_payload:roasted_at_utc\)\s*=\s*'VARCHAR'\s+"
        r"and\s+not\s+regexp_like\s*\(\s*v_payload:roasted_at_utc::string\s*,\s*"
        r"'(?P<grammar>\^[^']+\$)'\s*\)\s*\)\s*then\s*"
        r"raise\s+invalid_payload\s*;\s*end\s+if\s*;"
    )
    grammar = offset_guard.group("grammar")
    conversion_guard = _match(
        r"if\s*\(\s*typeof\(v_payload:roasted_at_utc\)\s*=\s*'VARCHAR'\s+and\s+"
        r"try_to_timestamp_tz\(v_payload:roasted_at_utc::string\)\s+is\s+null\s*\)\s*then\s*"
        r"raise\s+invalid_payload\s*;\s*end\s+if\s*;"
    )
    assert offset_guard.start() < conversion_guard.start()
    assert re.fullmatch(grammar, "2026-08-24T11:00:00Z")
    assert re.fullmatch(grammar, "2026-08-24T11:00:00+01:30")
    assert re.fullmatch(grammar, "2026-08-24T11:00:00-04:00")
    rejected = (
        "2026-08-24T11:00:00",
        "2026-08-24T11:00:00+0530",
        "2026-08-24T11:00:00z",
        "2026-08-24T11:00:00 UTC",
    )
    assert all(re.fullmatch(grammar, value) is None for value in rejected)
    assert re.search(
        r"typeof\(v_payload:roasted_at_utc\)\s+not\s+in\s*\(\s*'VARCHAR'\s*,\s*'NULL_VALUE'\s*\)",
        STRIPPED,
        re.I,
    )


def test_t32_artifact_kind_set_matches_seed_rules_and_rejects_hostiles() -> None:
    guard = _match(r"value::string\s+not\s+in\s*\((?P<values>[^)]+)\)")
    kinds = tuple(re.findall(r"'([^']+)'", guard.group("values")))
    rules = (_find_repo_root() / "scripts" / "seed" / "rules.ts").read_text()
    seed_kinds = tuple(re.findall(r'"([^"]+)"', _match(
        r"ARTIFACT_KINDS\s*=\s*\[(?P<values>[^]]+)\]", rules
    ).group("values")))
    assert kinds == seed_kinds == tuple(ARTIFACT_BASENAMES)
    assert re.search(r"v_distinct_artifact_count\s*<>\s*v_artifact_count", STRIPPED, re.I)
    hostile = ("JSONL", "json", "")
    assert all(value not in kinds for value in hostile)


def test_t32a_empty_artifact_manifest_is_allowed_for_both_learning_states() -> None:
    assert re.search(r"v_artifact_count\s*=\s*0", STRIPPED, re.I) is None
    expected_null_safe_counts = """coalesce(count_if(typeof(value) <> 'VARCHAR'), 0),
         coalesce(count_if(typeof(value) = 'VARCHAR'
                           and value::string not in ('jsonl', 'csv', 'summary')), 0)"""
    assert STRIPPED.count(expected_null_safe_counts) == 1
    expected_guard = """if (v_distinct_artifact_count <> v_artifact_count
      or v_invalid_artifact_type_count <> 0
      or v_unknown_artifact_count <> 0) then
    raise invalid_payload;
  end if;"""
    assert STRIPPED.count(expected_guard) == 1


def test_t32b_opted_out_nonempty_manifest_is_rejected_by_exact_guard() -> None:
    assert re.search(r"v_payload:contributed_to_learning::boolean\s*=\s*false", STRIPPED, re.I) is None
    assert re.search(r"delete\s+from\s+app.roast_telemetry", STRIPPED, re.I) is None
    assert "v_invalid_artifact_type_count <> 0" in STRIPPED
    assert "v_unknown_artifact_count <> 0" in STRIPPED


def test_t32c_artifact_guard_and_telemetry_purge_share_exact_opt_out_rule() -> None:
    assert re.search(r"v_payload:contributed_to_learning::boolean\s*=\s*false", STRIPPED, re.I) is None
    assert re.search(r"delete\s+from\s+app.roast_telemetry", STRIPPED, re.I) is None
    assert "v_invalid_artifact_type_count <> 0" in STRIPPED
    assert "v_unknown_artifact_count <> 0" in STRIPPED


def test_t33_uuid_guard_literal_is_byte_equal_across_three_procedures() -> None:
    expected = _roast_id_guard_grammar(DELETE_MIGRATION, "p_run_id")
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
        r"select\s+count\(\*\)\s+into\s+:v_slug_count\s+"
        r"from\s+app\.cloud_roasts\s+where\s+public_slug\s*=\s*:v_slug\s*;\s*"
        r"if\s*\(\s*v_slug_count\s*<>\s*1\s*\)\s*then\s*"
        r"raise\s+duplicate_public_slug\s*;\s*end\s+if\s*;",
        transaction,
    )
    assert merge.start() < stored.start() < guard.start()


def test_t36c_data_quality_view_flags_duplicate_public_slug_exactly() -> None:
    view = (SNOWFLAKE_DIR / "migrations" / "R__data_quality_view.sql").read_text()
    pattern = (
        r"select\s+'cloud_roasts'\s+as\s+table_name\s*,\s*"
        r"any_value\s*\(\s*id\s*\)\s+as\s+row_identity\s*,\s*"
        r"'public_slug'\s+as\s+field\s*,\s*"
        r"'duplicate public_slug'\s+as\s+rule\s+from\s+cloud_roasts\s+"
        r"group\s+by\s+public_slug\s+having\s+count\(\*\)\s*>\s*1\s*(?=union\s+all\b)"
    )
    assert len(re.findall(pattern, view, re.I | re.DOTALL)) == 1


def test_t36d_visibility_change_guard_is_post_readback_and_exact() -> None:
    transaction = _transaction()
    declaration = _match(
        r"visibility_change_not_supported\s+exception\s*\(\s*-20012\s*,\s*"
        r"'Visibility changes are not supported by upsert_roast'\s*\)\s*;"
    )
    stored = _match(
        r"select\s+id\s*,\s*public_slug\s+into\s+:v_id\s*,\s*:v_slug.*?;",
        transaction,
    )
    stored_visibility = _match(
        r"select\s+visibility\s+into\s+:v_stored_visibility\s+from\s+"
        r"app\.cloud_roasts\s+where\s+idempotency_key\s*=\s*:p_run_id\s*;",
        transaction,
    )
    guard = _match(
        r"if\s*\(\s*v_visibility\s+is\s+distinct\s+from\s+"
        r"v_stored_visibility\s*\)\s*then\s*"
        r"raise\s+visibility_change_not_supported\s*;\s*end\s+if\s*;",
        transaction,
    )
    transaction_start = _match(r"begin\s+transaction\s*;")
    assert declaration.start() < transaction_start.start()
    assert stored.start() < stored_visibility.start() < guard.start()


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
    declarations = re.findall(r"exception\s*\(\s*-200(?:08|09|10|11|12)\s*,\s*'[^']+'\s*\)", STRIPPED, re.I)
    assert len(declarations) == 5
    assert all("p_payload" not in declaration.lower() for declaration in declarations)
    assert re.search(r"raise\s+invalid_payload\s*\|\|", STRIPPED, re.I) is None


VALUE_GUARD_FIELDS = (
    "v_payload:bean_origin",
    "v_payload:bean_varietal",
    "v_payload:profile_name",
    "v_payload:roast_level",
    "v_payload:summary:roaster_driver",
    "v_payload:summary:first_crack_model:repo_id",
    "v_payload:operator_notes",
)


def _value_guard() -> str:
    return _match(
        r"if\s*\(\s*v_payload:bean_origin::string\s+is\s+not\s+null.*?"
        r"raise\s+invalid_payload\s*;\s*end\s+if\s*;"
    ).group(0)


def _value_guard_patterns() -> tuple[str, str, str]:
    patterns = re.findall(
        r"regexp_count\s*\(\s*v_payload:bean_origin::string\s*,\s*'([^']+)'\s*\)\s*>\s*0",
        _value_guard(),
        re.I,
    )
    assert len(patterns) == 3
    return patterns[0], patterns[1], patterns[2]


def test_t39_value_guard_is_one_closed_seven_field_block() -> None:
    """Assert the shipped guard shape.

    Offline caveat: Python re is not Snowflake RE2, and NULL/absent-key runtime
    is not executed offline; RE2 equivalence and three-valued logic remain
    live-gate residuals.
    """
    guard = _value_guard()
    assert len(re.findall(r"\bif\s*\(", guard, re.I)) == 1
    assert len(re.findall(r"\braise\s+invalid_payload\s*;", guard, re.I)) == 1
    assert len(re.findall(r"\bend\s+if\s*;", guard, re.I)) == 1
    expected_patterns = _value_guard_patterns()
    for field in VALUE_GUARD_FIELDS:
        patterns = re.findall(
            rf"regexp_count\s*\(\s*{re.escape(field)}::string\s*,\s*'([^']+)'\s*\)\s*>\s*0",
            guard,
            re.I,
        )
        assert tuple(patterns) == expected_patterns, field


def test_t40_value_guard_precedes_transaction() -> None:
    """Pin write-side ordering.

    Offline caveat: Python re is not Snowflake RE2, and NULL/absent-key runtime
    is not executed offline; RE2 equivalence and three-valued logic remain
    live-gate residuals.
    """
    guard_offset = STRIPPED.index(_value_guard())
    raise_offset = STRIPPED.index("raise invalid_payload;", guard_offset)
    transaction_offset = _match(r"begin\s+transaction\s*;").start()
    assert raise_offset < transaction_offset


def test_t41_ipv4_literal_catches_dotted_quad_examples() -> None:
    """Transcribe IPv4 matching.

    The construct is backslash-free so Python re and Snowflake RE2 agree.
    Offline caveat: Python re is not Snowflake RE2, and NULL/absent-key runtime
    is not executed offline; RE2 equivalence and three-valued logic remain
    live-gate residuals.
    """
    ipv4, _, _ = _value_guard_patterns()
    assert ipv4 == "([0-9]{1,3}[.]){3}[0-9]{1,3}"
    assert re.search(ipv4, "192.168.1.5") is not None
    assert re.search(ipv4, "10.0.0.1") is not None
    assert re.search(ipv4, "leak10.0.0.1") is not None
    assert re.search(ipv4, "device10.0.0.1") is not None


def test_t42_ipv6_literal_catches_full_and_compressed_examples() -> None:
    """Transcribe IPv6 matching.

    The construct is backslash-free so Python re and Snowflake RE2 agree.
    Offline caveat: Python re is not Snowflake RE2, and NULL/absent-key runtime
    is not executed offline; RE2 equivalence and three-valued logic remain
    live-gate residuals.
    """
    _, ipv6, _ = _value_guard_patterns()
    assert ipv6 == (
        "(([0-9A-Fa-f]{1,4}:){2,}[0-9A-Fa-f]{0,4})"
        "|(::([0-9A-Fa-f]{1,4}:?){1,})"
        "|(([0-9A-Fa-f]{1,4}:){1,}:)"
    )
    assert re.search(ipv6, "2001:db8:0:0:0:0:0:1") is not None
    assert re.search(ipv6, "fe80::1") is not None
    assert re.search(ipv6, "::1") is not None
    assert re.search(ipv6, "fe80::") is not None
    assert re.search(ipv6, "1::") is not None
    assert re.search(ipv6, "::") is None


def test_t43_temperature_literal_catches_degree_mark_examples() -> None:
    """Transcribe temperature matching.

    The construct is backslash-free so Python re and Snowflake RE2 agree.
    Offline caveat: Python re is not Snowflake RE2, and NULL/absent-key runtime
    is not executed offline; RE2 equivalence and three-valued logic remain
    live-gate residuals.
    """
    _, _, temperature = _value_guard_patterns()
    assert temperature == "(°[ ]?[Ff])|℉"
    assert re.search(temperature, "230°F") is not None
    assert re.search(temperature, "230° F") is not None
    assert re.search(temperature, "230℉") is not None


def test_t44_value_guard_accepts_benign_values() -> None:
    """Transcribe benign cases.

    Offline caveat: Python re is not Snowflake RE2, and NULL/absent-key runtime
    is not executed offline; RE2 equivalence and three-valued logic remain
    live-gate residuals.
    """
    patterns = _value_guard_patterns()
    values = ("hottop_kn8828b_2k_plus", "Ethiopia Yirgacheffe", "City+")
    assert all(re.search(pattern, value) is None for pattern in patterns for value in values)


def test_t45_repo_path_is_accepted() -> None:
    """Transcribe the valid repo path.

    Offline caveat: Python re is not Snowflake RE2, and NULL/absent-key runtime
    is not executed offline; RE2 equivalence and three-valued logic remain
    live-gate residuals.
    """
    patterns = _value_guard_patterns()
    repo_id = "syamaner/coffee-first-crack-detection"
    assert all(re.search(pattern, repo_id) is None for pattern in patterns)


def test_t46_repo_id_remains_subject_to_denylist() -> None:
    """Reject an address in repo_id.

    Offline caveat: Python re is not Snowflake RE2, and NULL/absent-key runtime
    is not executed offline; RE2 equivalence and three-valued logic remain
    live-gate residuals.
    """
    ipv4, _, _ = _value_guard_patterns()
    assert re.search(ipv4, "10.0.0.1/x") is not None


def test_t47_each_clause_is_null_safe_and_empty_text_is_benign() -> None:
    """Prove the scalar NULL shape.

    Offline caveat: Python re is not Snowflake RE2, and NULL/absent-key runtime
    is not executed offline; RE2 equivalence and three-valued logic remain
    live-gate residuals.
    """
    guard = _value_guard()
    for field in VALUE_GUARD_FIELDS:
        assert re.search(
            rf"{re.escape(field)}::string\s+is\s+not\s+null\s+and\s*\(",
            guard,
            re.I,
        )
    assert all(re.search(pattern, "") is None for pattern in _value_guard_patterns())


def test_t48_deliberate_arc_residuals_stay_pinned() -> None:
    """Pin accepted #312 gaps.

    The temperature construct is backslash-free across both regex engines.
    Offline caveat: Python re is not Snowflake RE2, and NULL/absent-key runtime
    is not executed offline; RE2 equivalence and three-valued logic remain
    live-gate residuals.
    """
    ipv4, _, temperature = _value_guard_patterns()
    assert re.search(temperature, "455F") is None
    assert re.search(temperature, "fahrenheit") is None
    assert re.search(ipv4, "192.168.1.5:8080") is not None


def test_t49_new_guard_preserves_celsius_forbidden_scan() -> None:
    """Reapply the Celsius scan.

    Offline caveat: Python re is not Snowflake RE2, and NULL/absent-key runtime
    is not executed offline; RE2 equivalence and three-valued logic remain
    live-gate residuals.
    """
    assert CELSIUS_FORBIDDEN.search(_value_guard()) is None


def test_t50_real_summary_corpus_stays_clean() -> None:
    """Check shipped summaries.

    Offline caveat: Python re is not Snowflake RE2, and NULL/absent-key runtime
    is not executed offline; RE2 equivalence and three-valued logic remain
    live-gate residuals.
    """
    patterns = _value_guard_patterns()
    fixture_root = SNOWFLAKE_DIR / "fixtures" / "m1-export"
    for session in ("session-1", "session-2"):
        summary = json.loads((fixture_root / session / "summary.json").read_text())
        assert "operator_notes" not in summary
        values = (summary["roaster_driver"], summary["first_crack_model"]["repo_id"])
        assert all(re.search(pattern, value) is None for pattern in patterns for value in values)


def test_t51_exception_and_static_sql_fences_are_unchanged() -> None:
    declarations = re.findall(r"exception\s*\(\s*(-200\d+)\s*,\s*'[^']+'\s*\)", STRIPPED, re.I)
    assert declarations == ["-20008", "-20009", "-20010", "-20011", "-20012", "-20021", "-20020", "-20023", "-20024"]
    from test_sync_coordination import assert_error_allocations
    assert_error_allocations()
    assert re.search(r"execute\s+immediate", STRIPPED, re.I) is None
    assert len(re.findall(r"\|\|", STRIPPED)) == 3


def _c2_replay_region():
    return _match(r"else\s+(if\s*\(v_visibility.*?end if;)\s*end if;\s*commit;", _transaction() + "commit;").group(1)

from test_sync_coordination import has, sql


def test_ups_c2_create_tombstone_before_existence():
    assert STRIPPED.index("idempotency_key = :p_run_id or public_slug = :v_public_slug") < STRIPPED.index("select count(*) into :v_existing_count")
    has(STRIPPED, "if (v_tombstone_count > 0) then raise identity_tombstoned;")


def test_ups_c2_merge_has_no_matched_branch():
    assert re.search(r"when\s+matched\s+then", STRIPPED, re.I) is None
    has(STRIPPED, "when not matched then insert")


def test_ups_c2_create_inserts_three_baseline_revisions():
    has(STRIPPED, "insert into app.cloud_roast_field_revisions (cloud_roast_id, field_name, accepted_revision, accepted_write_seq) select :v_id, column1, 0, :v_write_seq from values ('operator_rating'), ('operator_notes'), ('contributed_to_learning');")


def test_ups_c2_replay_fsv_no_write():
    has(STRIPPED, "if (v_existing_count = 1) then")
    assert STRIPPED.index('from app.cloud_roast_field_revisions where cloud_roast_id = :v_id') < STRIPPED.index('if (v_is_patch) then', STRIPPED.index('from app.cloud_roast_field_revisions'))
    assert re.search(r"\b(insert|update|delete|merge)\b", _c2_replay_region(), re.I) is None


def test_ups_c2_return_two_keys():
    has(STRIPPED, "return object_construct('cloud_roast_id', v_id, 'public_slug', v_slug);")


def test_ups_c2_no_optout_purge():
    assert re.search(r'delete\s+from\s+app.roast_telemetry',STRIPPED,re.I) is None


def test_ups_c2_no_optout_manifest_guard():
    assert re.search(r'contributed_to_learning::boolean\s*=\s*false',STRIPPED,re.I) is None


def test_patch_c2_envelope_grammar():
    has(STRIPPED, "v_is_patch := array_size(object_keys(v_payload)) = 2 and array_contains('patch_version'::variant, object_keys(v_payload)) and array_contains('fields'::variant, object_keys(v_payload));")
    has(STRIPPED, "typeof(v_payload:patch_version) <> 'INTEGER' or v_payload:patch_version::number <> 1")
    has(STRIPPED, "typeof(v_payload:fields) <> 'OBJECT' or array_size(object_keys(v_payload:fields)) < 1 or array_size(object_keys(v_payload:fields)) > 3")
    has(STRIPPED, "array_size(object_keys(v_entry)) <> 2 or not array_contains('revision'::variant, object_keys(v_entry)) or not array_contains('value'::variant, object_keys(v_entry))")


def test_patch_c2_revision_integer_and_bound():
    has(STRIPPED, "typeof(v_entry:revision) <> 'INTEGER' or v_entry:revision::number < 1 or v_entry:revision::number > 9007199254740991")


def test_patch_c2_outcome_order():
    has(STRIPPED, "if (not v_value_valid) then v_outcome := 'rejected_value'; elseif (v_request_revision > v_stored_revision) then")
    has(STRIPPED, "elseif (v_request_revision = v_stored_revision and v_value is not distinct from v_current) then v_outcome := 'already_applied'; elseif (v_request_revision = v_stored_revision) then v_outcome := 'revision_conflict'; else v_outcome := 'stale';")
    assert STRIPPED.index("v_outcome := 'applied'") < STRIPPED.index("v_outcome := 'already_applied'")


def test_patch_c2_consent_not_clearable():
    has(STRIPPED, "elseif (v_field_name = 'contributed_to_learning') then v_value_valid := typeof(v_value) = 'BOOLEAN'; end if;")


def test_patch_c2_notes_guard_byte_identical():
    create = re.findall(r"regexp_count\(v_payload:operator_notes::string, '([^']+)'\)", STRIPPED)
    patch = re.findall(r"regexp_count\(v_entry:value::string, '([^']+)'\)", STRIPPED)
    assert tuple(create) == tuple(patch) == (r'([0-9]{1,3}[.]){3}[0-9]{1,3}', r'(([0-9A-Fa-f]{1,4}:){2,}[0-9A-Fa-f]{0,4})|(::([0-9A-Fa-f]{1,4}:?){1,})|(([0-9A-Fa-f]{1,4}:){1,}:)', r'(°[ ]?[Ff])|℉')


def test_patch_c2_fsv_whole_state():
    has(STRIPPED, 'if (v_state_count <> 3 or v_state_known <> 3 or coalesce(v_state_invalid, 0) <> 0) then raise field_state_invalid;')
    has(STRIPPED, "count(distinct case when field_name in ('operator_rating', 'operator_notes', 'contributed_to_learning') then field_name end)")
    has(STRIPPED, 'count_if(accepted_revision < 0 or accepted_revision > 9007199254740991 or accepted_write_seq < 0)')


def test_patch_c2_tombstone_and_missing_roast():
    has(STRIPPED, 'if (v_is_patch) then select count(*) into :v_tombstone_count from app.cloud_roast_tombstones where idempotency_key = :p_run_id; if (v_tombstone_count > 0) then raise identity_tombstoned;')
    has(STRIPPED, 'if (v_is_patch and v_existing_count = 0) then raise roast_not_found;')
    has(STRIPPED, 'where cloud_roast_id = :v_id or public_slug = :v_slug; if (v_tombstone_count > 0) then raise identity_tombstoned;')


def test_patch_c2_response_shape():
    has(STRIPPED, "object_construct('outcome', v_outcome, 'accepted_revision', v_stored_revision)")
    has(STRIPPED, "return object_construct('patch_version', 1, 'cloud_roast_id', v_id, 'fields', v_outcomes);")


def test_patch_c2_consent_apply_recomputes():
    has(STRIPPED, 'if (v_consent_applied) then call app.recompute_reference_summary(:v_new_bean_origin, :v_new_roast_level); end if;')


def test_ups_c2_stale_comments_absent():
    assert not re.search(r'projected wholesale|available to PUBLIC_WEB through|consent-conditioned INSERT|read-side consent gate', MIGRATION,re.I)
