"""Offline token/region checks for C2-S5 SUBMIT_REVIEW (issue #313).

Deliberately parses migration text rather than SQL, mirroring the neighboring
procedure suite and reusing its line-comment stripper. Hard ceiling: <=250
lines.
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
MIGRATION_PATH = SNOWFLAKE_DIR / "migrations" / "R__proc_submit_review.sql"
STRIPPED = strip_line_comments(MIGRATION_PATH.read_text(encoding="utf-8"))


def _region(start_pattern: str, end_pattern: str) -> str:
    start = re.search(start_pattern, STRIPPED, re.IGNORECASE | re.DOTALL)
    assert start is not None, f"start pattern not found: {start_pattern}"
    rest = STRIPPED[start.end() :]
    end = re.search(end_pattern, rest, re.IGNORECASE | re.DOTALL)
    assert end is not None, f"end pattern not found: {end_pattern}"
    return rest[: end.start()]


def test_t_sig_exact_signature_and_procedure_attributes():
    params = [
        ("p_public_slug", "string"),
        ("p_reviewer_name", "string"),
        ("p_score", "int"),
        ("p_aroma", "smallint"),
        ("p_acidity", "smallint"),
        ("p_sweetness", "smallint"),
        ("p_body", "smallint"),
        ("p_aftertaste", "smallint"),
        ("p_brew_method", "string"),
        ("p_notes", "string"),
        ("p_submitted_ip_hash", "string"),
    ]
    signature = r"\s*,\s*".join(rf"{name}\s+{kind}" for name, kind in params)
    header_match = re.search(
        rf"create\s+or\s+replace\s+procedure\s+submit_review\s*"
        rf"\(\s*{signature}\s*\)\s*copy\s+grants\s*returns\s+string\s*"
        rf"language\s+sql\s*execute\s+as\s+owner",
        STRIPPED,
        re.IGNORECASE,
    )
    assert header_match is not None


def test_t_one_object_only_one_procedure_and_no_grants():
    assert len(re.findall(r"create\s+or\s+replace\s+procedure\b", STRIPPED, re.IGNORECASE)) == 1
    assert re.search(
        r"create\s+(?:or\s+replace\s+)?(?:table|view|role|stage|function)\b",
        STRIPPED,
        re.IGNORECASE,
    ) is None
    assert re.search(r"\bgrant\b", STRIPPED, re.IGNORECASE) is None


def test_t_use_schema_precedes_create():
    use_match = re.search(r"use\s+schema\s+app\s*;", STRIPPED, re.IGNORECASE)
    create_match = re.search(r"create\s+or\s+replace\s+procedure", STRIPPED, re.IGNORECASE)
    assert use_match and create_match and use_match.start() < create_match.start()


def test_t_insert_cols_exact_allowed_columns_and_hash_column():
    match = re.search(
        r"insert\s+into\s+app\.tasting_reviews\s*\((.*?)\)\s*select\b",
        STRIPPED,
        re.IGNORECASE | re.DOTALL,
    )
    assert match is not None
    columns = [column.strip().lower() for column in match.group(1).split(",")]
    allowed = [
        "id", "roast_id", "reviewer_name", "score", "aroma", "acidity",
        "sweetness", "body", "aftertaste", "brew_method", "notes",
        "submitted_ip_hash",
    ]
    assert columns == allowed
    assert "submitted_ip_hash" in columns
    assert re.search(
        r"insert\s+into\s+app\.tasting_reviews\s*\(.*?\)\s*select\b.*?"
        r"from\s+app\.cloud_roasts\s+r\b.*?visibility\s*<>\s*'private'\s*;\s*"
        r"if\s*\(\s*sqlrowcount\s*<>\s*1\s*\)\s*then\s*raise\s+slug_not_resolved\s*;",
        STRIPPED,
        re.IGNORECASE | re.DOTALL,
    )


def test_t_recompute_called_once_with_looked_up_grouping_vars():
    calls = re.findall(r"call\s+recompute_reference_summary\s*\(", STRIPPED, re.IGNORECASE)
    assert len(calls) == 1
    assert re.search(
        r"call\s+recompute_reference_summary\s*"
        r"\(\s*:v_bean_origin\s*,\s*:v_roast_level\s*\)\s*;",
        STRIPPED,
        re.IGNORECASE,
    )


def test_t_purge_present_as_table_wide_hash_nulling_update():
    purge = _region(r"update\s+app\.tasting_reviews", r"return\s+v_review_id")
    assert re.search(r"set\s+submitted_ip_hash\s*=\s*null", purge, re.IGNORECASE)
    assert re.search(r"submitted_ip_hash\s+is\s+not\s+null", purge, re.IGNORECASE)
    assert re.search(
        r"created_at\s*<=\s*dateadd\s*\(\s*'day'\s*,\s*-30\s*,",
        purge,
        re.IGNORECASE,
    )


def test_t_no_check_range_constraint():
    assert re.search(r"\bcheck\s*\(", STRIPPED, re.IGNORECASE) is None


def test_t_celsius_has_no_fahrenheit_token_or_conversion():
    assert re.search(
        r"fahrenheit|_f\b|\*\s*9\s*/\s*5|\*\s*1\.8|\+\s*32",
        STRIPPED,
        re.IGNORECASE,
    ) is None


def test_t_render_validate_migrations_passes():
    assert validate_migrations.main() == 0


def test_t_no_raw_ip_identifier_and_only_hash_ip_tokens():
    forbidden = ("ip_address", "raw_ip", "client_ip", "remote_addr", "ip_raw", "p_ip")
    for identifier in forbidden:
        assert re.search(rf"\b{identifier}\b", STRIPPED, re.IGNORECASE) is None
    assert re.search(r"submitted_ip(?!_hash)", STRIPPED, re.IGNORECASE) is None
    ip_tokens = re.findall(r"\b[a-z_]*ip[a-z_]*\b", STRIPPED, re.IGNORECASE)
    assert ip_tokens
    normalized = {re.sub(r"^p_", "", token.lower()) for token in ip_tokens}
    assert normalized == {"submitted_ip_hash"}


def test_t_hash_shape_guard_raises_declared_exception():
    assert re.search(
        r"invalid_submitted_hash\s+exception\s*\([^;]+\)\s*;",
        STRIPPED,
        re.IGNORECASE,
    )
    assert re.search(
        r"if\s*\(\s*p_submitted_ip_hash\s+is\s+not\s+null\s+and\s+not\s+"
        r"regexp_like\s*\(\s*p_submitted_ip_hash\s*,\s*'\^\[0-9a-fA-F\]\{64\}\$'\s*\)\s*\)"
        r"\s*then\s*raise\s+invalid_submitted_hash\s*;",
        STRIPPED,
        re.IGNORECASE | re.DOTALL,
    )


def test_t_slug_filter_excludes_private_in_both_lookups_and_insert():
    matches = re.findall(r"visibility\s*<>\s*'private'", STRIPPED, re.IGNORECASE)
    assert len(matches) == 3


def test_t_slug_raise_count_guard_precedes_unique_select_and_write():
    count_match = re.search(
        r"select\s+count\s*\(\s*\*\s*\)\s+into\s+:v_count.*?"
        r"if\s*\(\s*v_count\s*<>\s*1\s*\)\s*then\s*raise\s+slug_not_resolved\s*;",
        STRIPPED,
        re.IGNORECASE | re.DOTALL,
    )
    declaration = re.search(r"slug_not_resolved\s+exception\s*\([^;]+\)\s*;", STRIPPED, re.IGNORECASE)
    unique_select = re.search(r"select\s+bean_origin\s*,\s*roast_level", STRIPPED, re.IGNORECASE)
    insert = re.search(r"insert\s+into\s+app\.tasting_reviews", STRIPPED, re.IGNORECASE)
    assert count_match and declaration and unique_select and insert
    assert count_match.start() < unique_select.start() < insert.start()


def test_t_atomic_write_trio_wrapped_in_transaction():
    invalid_raise = re.search(r"raise\s+invalid_submitted_hash\s*;", STRIPPED, re.IGNORECASE)
    slug_raise = re.search(r"raise\s+slug_not_resolved\s*;", STRIPPED, re.IGNORECASE)
    transaction = re.search(r"begin\s+transaction\s*;", STRIPPED, re.IGNORECASE)
    commit = re.search(r"\bcommit\s*;", STRIPPED, re.IGNORECASE)
    assert invalid_raise and slug_raise and transaction and commit
    assert invalid_raise.start() < transaction.start()
    assert slug_raise.start() < transaction.start()

    write_trio = STRIPPED[transaction.end() : commit.start()]
    insert = re.search(r"insert\s+into\s+app\.tasting_reviews\b", write_trio, re.IGNORECASE)
    recompute = re.search(r"call\s+recompute_reference_summary\s*\(", write_trio, re.IGNORECASE)
    purge = re.search(r"update\s+app\.tasting_reviews\b", write_trio, re.IGNORECASE)
    assert insert and recompute and purge
    assert insert.start() < recompute.start() < purge.start()
    assert re.search(
        r"\bcommit\s*;\s*exception\s+when\s+other\s+then\s+"
        r"rollback\s*;\s*raise\s*;",
        STRIPPED,
        re.IGNORECASE | re.DOTALL,
    )


def test_t_insert_revalidates_visibility_atomically():
    transaction = _region(r"begin\s+transaction\s*;", r"\bcommit\s*;")
    assert re.search(
        r"insert\s+into\s+app\.tasting_reviews\s*\(.*?\)\s*select\b.*?"
        r"from\s+app\.cloud_roasts\s+r\b.*?r\.public_slug\s*=\s*:p_public_slug\s+"
        r"and\s+r\.visibility\s*<>\s*'private'\s*;\s*"
        r"if\s*\(\s*sqlrowcount\s*<>\s*1\s*\)\s*then\s*"
        r"raise\s+slug_not_resolved\s*;\s*end\s+if\s*;",
        transaction,
        re.IGNORECASE | re.DOTALL,
    )


def test_t_purge_no_delete_from_tasting_reviews():
    assert re.search(r"delete\s+from\s+(?:app\.)?tasting_reviews\b", STRIPPED, re.IGNORECASE) is None
