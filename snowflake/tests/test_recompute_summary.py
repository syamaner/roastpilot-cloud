"""Token-presence/region-slice tests for the C2-S4 aggregation proc
migration (issue #310): R__proc_recompute_summary.sql. Deliberately not a
SQL parser (#307-bounce pre-emption, same style as test_secure_views.py) --
reuses strip_line_comments from test_base_tables_schema.py. NEG-E (a NULL
first_crack_at_utc contributes a NULL FC temp, not a spurious nearest row)
is a live-Snowflake-semantics claim this text-parse suite cannot prove --
that is a reviewer-verified check per the issue, not a gap in this file.
Hard ceiling: <=250 lines.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import validate_migrations  # noqa: E402
from test_base_tables_schema import strip_line_comments  # noqa: E402

SNOWFLAKE_DIR = Path(__file__).resolve().parent.parent
MIGRATION_PATH = SNOWFLAKE_DIR / "migrations" / "R__proc_recompute_summary.sql"
STRIPPED = strip_line_comments(MIGRATION_PATH.read_text(encoding="utf-8"))


def _region(start_pattern: str, end_pattern: str) -> str:
    start = re.search(start_pattern, STRIPPED, re.IGNORECASE | re.DOTALL)
    assert start is not None, f"start pattern not found: {start_pattern}"
    rest = STRIPPED[start.end():]
    end = re.search(end_pattern, rest, re.IGNORECASE | re.DOTALL)
    assert end is not None, f"end pattern not found: {end_pattern}"
    return rest[: end.start()]


CONTRIBUTING_REGION = _region(r"with\s+contributing\s+as\s*\(", r"\)\s*,\s*per_roast\s+as\s*\(")
PER_ROAST_REGION = _region(r"per_roast\s+as\s*\(", r"\)\s*,\s*review_rollup\s+as\s*\(")
REVIEW_ROLLUP_REGION = _region(r"review_rollup\s+as\s*\(", r"\)\s*\n\s*select\s*\n\s*:bean_origin")
OUTER_SELECT_REGION = _region(r":bean_origin\s+as\s+bean_origin", r"from\s+per_roast\s+pr")
USING_REGION = _region(r"\busing\s*\(", r"\)\s*s\s*\n\s*on\s+t\.bean_origin")
UPDATE_SET_REGION = _region(r"when\s+matched\s+then\s+update\s+set", r"when\s+not\s+matched\s+then\s+insert\s*\(")
INSERT_COLS_REGION = _region(r"when\s+not\s+matched\s+then\s+insert\s*\(", r"\)\s*values\s*\(")
INSERT_VALUES_REGION = _region(r"\)\s*values\s*\(", r"\)\s*;\s*\n\s*return")


def test_exactly_one_procedure_and_no_other_object():
    procs = re.findall(r"create\s+or\s+replace\s+procedure\b", STRIPPED, re.IGNORECASE)
    assert len(procs) == 1
    others = re.findall(
        r"create\s+(?:or\s+replace\s+)?(table|view|role|stage|function)\b", STRIPPED, re.IGNORECASE
    )
    assert others == []


def test_procedure_signature_matches_exactly():
    assert re.search(
        r"create\s+or\s+replace\s+procedure\s+recompute_reference_summary\s*"
        r"\(\s*bean_origin\s+string\s*,\s*roast_level\s+string\s*\)",
        STRIPPED,
        re.IGNORECASE,
    )


def test_single_merge_into_reference_roast_summaries():
    merges = re.findall(r"merge\s+into\s+reference_roast_summaries\b", STRIPPED, re.IGNORECASE)
    assert len(merges) == 1


def test_merge_on_clause_keys_on_both_columns():
    on_clause = _region(r"\)\s*s\s*\n\s*on\s+", r"when\s+matched")
    assert re.search(r"bean_origin\s*=\s*s\.bean_origin", on_clause, re.IGNORECASE)
    assert re.search(r"roast_level\s*=\s*s\.roast_level", on_clause, re.IGNORECASE)
    assert re.search(r"\band\b", on_clause, re.IGNORECASE)


def test_only_contribution_filter_is_contributed_to_learning_true():
    matches = re.findall(r"contributed_to_learning\s*=\s*true", STRIPPED, re.IGNORECASE)
    assert len(matches) == 1
    assert re.search(r"contributed_to_learning\s*=\s*false", STRIPPED, re.IGNORECASE) is None


def test_filter_params_are_bind_prefixed_not_bare_tautologies():
    assert re.search(r"r\.bean_origin\s*=\s*:bean_origin\b", CONTRIBUTING_REGION, re.IGNORECASE)
    assert re.search(r"r\.roast_level\s*=\s*:roast_level\b", CONTRIBUTING_REGION, re.IGNORECASE)
    # A bare `= bean_origin` (no leading `:`) resolves to the column itself,
    # i.e. a tautology matching every row -- this can only match a mutant
    # that dropped the bind prefix, since the real text always has `= :`.
    assert re.search(r"=\s*bean_origin\b", CONTRIBUTING_REGION, re.IGNORECASE) is None
    assert re.search(r"=\s*roast_level\b", CONTRIBUTING_REGION, re.IGNORECASE) is None


def test_temperature_derivation_reads_only_roast_telemetry():
    for token in (
        "roast_telemetry", "bean_temp_c", "first_crack_at_utc", "beans_dropped_at_utc", "elapsed_s",
    ):
        assert re.search(re.escape(token), PER_ROAST_REGION, re.IGNORECASE), token


def test_telemetry_join_offset_is_started_at_anchored():
    fc_join = _region(r"first_crack_at_utc\s+is\s+null\s+then\s+null\s+else", r"end\s+as\s+fc_temp_c")
    drop_join = _region(r"beans_dropped_at_utc\s+is\s+null\s+then\s+null\s+else", r"end\s+as\s+drop_temp_c")
    for region, anchor_target in ((fc_join, "first_crack_at_utc"), (drop_join, "beans_dropped_at_utc")):
        assert re.search(
            rf"(datediff|timestampdiff)\([^)]*started_at_utc[^)]*{anchor_target}", region, re.IGNORECASE | re.DOTALL
        )


def test_first_crack_time_is_charge_relative_beans_added_anchored():
    fc_time_region = _region(r"c\.summary:development_time_percent[^,]*,", r"as\s+fc_time_s")
    assert re.search(
        r"(datediff|timestampdiff)\([^)]*beans_added_at_utc[^)]*first_crack_at_utc",
        fc_time_region,
        re.IGNORECASE | re.DOTALL,
    )
    assert "started_at_utc" not in fc_time_region.lower()


def test_no_roast_level_value_reads_summary_metrics():
    assert re.search(r"summary\s*:\s*metrics|summary\s*\[\s*['\"]metrics", STRIPPED, re.IGNORECASE) is None


def test_no_temperature_read_from_a_summary_path():
    for region in (PER_ROAST_REGION,):
        assert re.search(r"summary\s*:\s*\w*temp", region, re.IGNORECASE) is None


def test_development_percent_avg_from_top_level_summary_field():
    assert re.search(r"summary\s*:\s*development_time_percent\b", STRIPPED, re.IGNORECASE)
    assert re.search(r"summary\s*:\s*metrics\s*:\s*development_percent\b", STRIPPED, re.IGNORECASE) is None


def test_total_time_avg_s_from_top_level_summary_field():
    assert re.search(r"summary\s*:\s*total_roast_seconds\b", STRIPPED, re.IGNORECASE)
    assert re.search(r"summary\s*:\s*metrics\s*:\s*roast_elapsed_seconds\b", STRIPPED, re.IGNORECASE) is None


def test_aggregate_functions_match_expected_columns():
    for col in ("first_crack_temp_avg_c", "drop_temp_avg_c"):
        assert re.search(rf"avg\(pr\.\w+\)\s+as\s+{col}\b", OUTER_SELECT_REGION, re.IGNORECASE)
    for col in ("first_crack_temp_stddev_c", "drop_temp_stddev_c"):
        assert re.search(rf"stddev\(pr\.\w+\)\s+as\s+{col}\b", OUTER_SELECT_REGION, re.IGNORECASE)
    assert re.search(r"count\(\*\)", USING_REGION, re.IGNORECASE)
    assert re.search(r"count\(tr\.id\)\s+as\s+review_count", REVIEW_ROLLUP_REGION, re.IGNORECASE)
    assert re.search(r"avg\(tr\.score\)\s+as\s+avg_rating", REVIEW_ROLLUP_REGION, re.IGNORECASE)


def test_key_patterns_always_empty_array():
    matches = re.findall(r"key_patterns\s*=\s*parse_json\('\[\]'\)", STRIPPED, re.IGNORECASE)
    assert len(matches) == 1
    assert re.search(r"key_patterns", UPDATE_SET_REGION, re.IGNORECASE)
    assert re.search(r"parse_json\('\[\]'\)", INSERT_VALUES_REGION, re.IGNORECASE)


def test_id_absent_from_insert_columns_and_update_set():
    assert re.search(r"\bid\b", UPDATE_SET_REGION, re.IGNORECASE) is None
    assert re.search(r"\bid\b", INSERT_COLS_REGION, re.IGNORECASE) is None


def test_updated_at_current_timestamp_on_update_and_insert():
    assert re.search(r"updated_at\s*=\s*current_timestamp\(\)", UPDATE_SET_REGION, re.IGNORECASE)
    assert re.search(r"current_timestamp\(\)", INSERT_VALUES_REGION, re.IGNORECASE)


def test_merge_source_has_no_group_by():
    assert re.search(r"group\s+by", USING_REGION, re.IGNORECASE) is None


def test_copy_grants_present_on_procedure():
    header = _region(r"create\s+or\s+replace\s+procedure", r"\bas\b\s*\n\s*begin")
    assert re.search(r"\bcopy\s+grants\b", header, re.IGNORECASE)


def test_execute_as_owner_present():
    header = _region(r"create\s+or\s+replace\s+procedure", r"\bas\b\s*\n\s*begin")
    assert re.search(r"\bexecute\s+as\s+owner\b", header, re.IGNORECASE)


def test_use_schema_app_precedes_procedure_create():
    use_match = re.search(r"use\s+schema\s+app\s*;", STRIPPED, re.IGNORECASE)
    create_match = re.search(r"create\s+or\s+replace\s+procedure", STRIPPED, re.IGNORECASE)
    assert use_match and create_match and use_match.start() < create_match.start()


def test_no_fahrenheit_token_or_conversion():
    assert re.search(r"fahrenheit|_f\b|\*\s*9\s*/\s*5|\*\s*1\.8|\+\s*32", STRIPPED, re.IGNORECASE) is None


def test_no_grant_or_second_create_object():
    assert re.search(r"\bgrant\b", STRIPPED, re.IGNORECASE) is None
    assert re.search(r"\bto\s+public\b", STRIPPED, re.IGNORECASE) is None


def test_only_one_contribution_source():
    sources = re.findall(r"from\s+cloud_roasts\b", STRIPPED, re.IGNORECASE)
    assert len(sources) == 1


def test_validate_migrations_passes():
    assert validate_migrations.main() == 0
