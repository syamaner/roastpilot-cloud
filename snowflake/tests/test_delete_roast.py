"""Offline token/region checks for C2-S6 DELETE_ROAST (issue #314).

Parses migration text like the neighboring procedure suite and reuses its
line-comment stripper. Hard ceiling: <=250 lines.
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
MIGRATION_PATH = SNOWFLAKE_DIR / "migrations" / "R__proc_delete_roast.sql"
MIGRATION = MIGRATION_PATH.read_text(encoding="utf-8")
STRIPPED = strip_line_comments(MIGRATION)
TELEMETRY_STRIPPED = strip_line_comments(
    (SNOWFLAKE_DIR / "migrations" / "R__proc_load_roast_telemetry.sql").read_text(
        encoding="utf-8"
    )
)


def _match(pattern: str, text: str = STRIPPED) -> re.Match[str]:
    match = re.search(pattern, text, re.IGNORECASE | re.DOTALL)
    assert match is not None, f"pattern not found: {pattern}"
    return match


def _transaction() -> tuple[re.Match[str], re.Match[str], str]:
    start = _match(r"begin\s+transaction\s*;")
    commit = _match(r"\bcommit\s*;", STRIPPED[start.end() :])
    commit_start = start.end() + commit.start()
    return start, commit, STRIPPED[start.end() : commit_start]


def test_t_sig_exact_signature_and_procedure_attributes():
    _match(
        r"create\s+or\s+replace\s+procedure\s+delete_roast\s*"
        r"\(\s*p_roast_id\s+string\s*\)\s*copy\s+grants\s*returns\s+string\s*"
        r"language\s+sql\s*execute\s+as\s+owner"
    )


def test_t_one_object_only_one_procedure_and_no_grants():
    assert len(re.findall(r"create\s+or\s+replace\s+procedure\b", STRIPPED, re.I)) == 1
    assert re.search(
        r"create\s+(?:or\s+replace\s+)?(?:table|view|role|stage|function)\b",
        STRIPPED,
        re.I,
    ) is None
    assert re.search(r"\bgrant\b", STRIPPED, re.I) is None


def test_t_use_schema_precedes_create():
    use = _match(r"use\s+schema\s+app\s*;")
    create = _match(r"create\s+or\s+replace\s+procedure")
    assert use.start() < create.start()


def test_t_child_reviews_deleted_by_bound_roast_id():
    _match(r"delete\s+from\s+app\.tasting_reviews\s+where\s+roast_id\s*=\s*:p_roast_id\s*;")


def test_t_child_telemetry_deleted_by_bound_roast_id():
    _match(r"delete\s+from\s+app\.roast_telemetry\s+where\s+roast_id\s*=\s*:p_roast_id\s*;")


def test_t_child_artifacts_deleted_by_bound_roast_id():
    _match(r"delete\s+from\s+app\.roast_artifacts\s+where\s+roast_id\s*=\s*:p_roast_id\s*;")


def test_t_parent_roast_deleted_by_bound_id():
    _match(r"delete\s+from\s+app\.cloud_roasts\s+where\s+id\s*=\s*:p_roast_id\s*;")


def test_t_parent_rowcount_guard_after_delete_before_recompute_in_transaction():
    _, _, transaction = _transaction()
    parent_delete = _match(r"delete\s+from\s+app\.cloud_roasts\s+where\s+id\s*=\s*:p_roast_id\s*;", transaction)
    guard = _match(
        r"if\s*\(\s*sqlrowcount\s*<>\s*1\s*\)\s*then\s*"
        r"raise\s+ambiguous_roast_id\s*;\s*end\s+if\s*;",
        transaction,
    )
    recompute = _match(r"call\s+app\.recompute_reference_summary\s*\(", transaction)
    assert parent_delete.start() < guard.start() < recompute.start()


def test_t_stage_remove_is_the_only_dynamic_sql():
    removes = re.findall(r"remove\s+@app\.roast_artifacts/", STRIPPED, re.I)
    dynamic_sql = re.findall(r"execute\s+immediate\s+([^;]+);", STRIPPED, re.I)
    assert len(removes) == 1
    assert len(dynamic_sql) == 1
    assert re.fullmatch(r":v_remove_sql", dynamic_sql[0].strip(), re.I)
    assignment = _match(
        r"v_remove_sql\s*:=\s*'remove\s+@app\.roast_artifacts/'\s*\|\|\s*"
        r"v_idempotency_key\s*\|\|\s*'/'\s*;"
    )
    execution = _match(r"execute\s+immediate\s+:v_remove_sql\s*;")
    assert assignment.start() < execution.start()
    assert re.search(r"\bselect\b|\bstage_path\b", dynamic_sql[0], re.I) is None


def test_t_recompute_once_after_four_deletes_inside_transaction():
    _, _, transaction = _transaction()
    calls = list(re.finditer(r"call\s+app\.recompute_reference_summary\s*\(", STRIPPED, re.I))
    assert len(calls) == 1
    recompute = _match(
        r"call\s+app\.recompute_reference_summary\s*"
        r"\(\s*:v_bean_origin\s*,\s*:v_roast_level\s*\)\s*;",
        transaction,
    )
    deletes = list(re.finditer(r"delete\s+from\s+app\.", transaction, re.I))
    assert len(deletes) == 4
    assert all(delete.start() < recompute.start() for delete in deletes)


def test_t_grouping_capture_precedes_parent_delete():
    captures = re.findall(
        r"\binto\b[^;]*:v_bean_origin\s*,\s*:v_roast_level\s*,\s*:v_idempotency_key",
        STRIPPED,
        re.IGNORECASE,
    )
    assert len(captures) == 1
    capture = _match(
        r"select\s+count\s*\(\s*\*\s*\)\s*,\s*any_value\s*\(\s*bean_origin\s*\)\s*,\s*"
        r"any_value\s*\(\s*roast_level\s*\)\s*,\s*any_value\s*\(\s*idempotency_key\s*\)\s+"
        r"into\s+:v_count\s*,\s*:v_bean_origin\s*,\s*:v_roast_level\s*,\s*"
        r":v_idempotency_key\s+from\s+app\.cloud_roasts\s+where\s+id\s*=\s*:p_roast_id\s*;"
    )
    parent_delete = _match(r"delete\s+from\s+app\.cloud_roasts")
    assert capture.start() < parent_delete.start()


def test_t_txn_structure_wraps_deletes_and_recompute_with_rollback_reraise():
    _, _, transaction = _transaction()
    expected = (
        "app.tasting_reviews",
        "app.roast_telemetry",
        "app.roast_artifacts",
        "app.cloud_roasts",
    )
    positions = [_match(rf"delete\s+from\s+{re.escape(table)}\b", transaction).start() for table in expected]
    recompute = _match(r"call\s+app\.recompute_reference_summary\s*\(", transaction)
    assert positions == sorted(positions)
    assert positions[-1] < recompute.start()
    _match(
        r"\bcommit\s*;\s*exception\s+when\s+other\s+then\s+"
        r"rollback\s*;\s*raise\s*;"
    )


def test_t_no_cascade_clause():
    assert re.search(r"on\s+delete\s+cascade", STRIPPED, re.I) is None


def test_t_no_visibility_filter():
    assert re.search(r"visibility\s*<>\s*'private'", STRIPPED, re.I) is None


def test_t_celsius_has_no_fahrenheit_token_or_conversion():
    assert re.search(r"fahrenheit|_f\b|\*\s*9\s*/\s*5|\*\s*1\.8|\+\s*32", STRIPPED, re.I) is None


def test_t_no_check_constraint():
    assert re.search(r"\bcheck\s*\(", STRIPPED, re.I) is None


def test_t_render_validate_migrations_passes():
    assert validate_migrations.main() == 0


def test_t_shape_guard_declared_and_raised_before_transaction():
    declaration = _match(r"invalid_roast_id\s+exception\s*\(\s*-20003\s*,\s*'[^']+'\s*\)\s*;")
    guard = _match(
        r"if\s*\(\s*p_roast_id\s+is\s+null\s+or\s+not\s+regexp_like\s*\(\s*p_roast_id\s*,\s*"
        r"'\^\[0-9a-f\]\{8\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-\[0-9a-f\]\{4\}-"
        r"\[0-9a-f\]\{12\}\$'\s*\)\s*\)\s*then\s+raise\s+invalid_roast_id\s*;\s*end\s+if\s*;"
    )
    transaction = _match(r"begin\s+transaction\s*;")
    assert declaration.start() < guard.start() < transaction.start()


def test_t_noop_after_existence_select_before_transaction_and_without_raise():
    select = _match(r"select\s+count\s*\(\s*\*\s*\).*?from\s+app\.cloud_roasts.*?;")
    noop = _match(
        r"if\s*\(\s*v_count\s*=\s*0\s*\)\s*then\s*"
        r"return\s+'no-op:[^']*'\s*;\s*end\s+if\s*;"
    )
    transaction = _match(r"begin\s+transaction\s*;")
    assert select.start() < noop.start() < transaction.start()
    assert re.search(r"\braise\b", noop.group(0), re.I) is None


def test_t_ambiguous_id_guard_after_select_before_transaction():
    declaration = _match(r"ambiguous_roast_id\s+exception\s*\(\s*-20004\s*,\s*'[^']+'\s*\)\s*;")
    select = _match(r"select\s+count\s*\(\s*\*\s*\).*?from\s+app\.cloud_roasts.*?;")
    guard = _match(
        r"if\s*\(\s*v_count\s*>\s*1\s*\)\s*then\s*"
        r"raise\s+ambiguous_roast_id\s*;\s*end\s+if\s*;"
    )
    transaction = _match(r"begin\s+transaction\s*;")
    assert declaration.start() < select.start() < guard.start() < transaction.start()


def test_t_key_capture_reads_idempotency_key_into_local_before_transaction():
    declaration = _match(r"v_idempotency_key\s+string\s*;")
    capture = _match(
        r"select\s+count\s*\(\s*\*\s*\).*?any_value\s*\(\s*idempotency_key\s*\)\s+"
        r"into\s+:v_count\s*,\s*:v_bean_origin\s*,\s*:v_roast_level\s*,\s*"
        r":v_idempotency_key\s+from\s+app\.cloud_roasts.*?;"
    )
    transaction = _match(r"begin\s+transaction\s*;")
    assert declaration.start() < capture.start() < transaction.start()


def test_t_key_guard_matches_telemetry_containment_grammar_before_transaction():
    telemetry_grammar = _match(
        r"regexp_like\s*\(\s*p_run_id\s*,\s*'(?P<grammar>\^[^']+\$)'",
        TELEMETRY_STRIPPED,
    ).group("grammar")
    key_guard = _match(
        r"if\s*\(\s*v_idempotency_key\s+is\s+null\s+or\s+not\s+regexp_like\s*\(\s*"
        r"v_idempotency_key\s*,\s*'(?P<grammar>\^[^']+\$)'\s*\)\s*\)\s*then\s+"
        r"raise\s+invalid_idempotency_key\s*;\s*end\s+if\s*;",
        MIGRATION,
    )
    comment_guard = _match(
        r"if\s*\(\s*contains\s*\(\s*v_idempotency_key\s*,\s*'--'\s*\)\s*\)\s*then\s+"
        r"raise\s+invalid_idempotency_key\s*;\s*end\s+if\s*;",
        MIGRATION,
    )
    telemetry_comment_guard = _match(
        r"if\s*\(\s*contains\s*\(\s*p_run_id\s*,\s*'--'\s*\)\s*\)\s*then\s+"
        r"raise\s+invalid_run_id\s*;\s*end\s+if\s*;",
        (SNOWFLAKE_DIR / "migrations" / "R__proc_load_roast_telemetry.sql").read_text(
            encoding="utf-8"
        ),
    )
    noop = _match(r"if\s*\(\s*v_count\s*=\s*0\s*\).*?end\s+if\s*;", MIGRATION)
    ambiguous = _match(r"if\s*\(\s*v_count\s*>\s*1\s*\).*?end\s+if\s*;", MIGRATION)
    transaction = _match(r"begin\s+transaction\s*;", MIGRATION)
    _match(
        r"invalid_idempotency_key\s+exception\s*\(\s*-20015\s*,\s*"
        r"'Stored idempotency key contains disallowed characters'\s*\)\s*;"
    )
    assert key_guard.group("grammar") == telemetry_grammar == "^[0-9a-zA-Z_-]{1,64}$"
    assert "contains(p_run_id, '--')" in telemetry_comment_guard.group(0)
    assert (
        noop.start()
        < ambiguous.start()
        < key_guard.start()
        < comment_guard.start()
        < transaction.start()
    )


def test_t_key_uniqueness_guard_fails_closed_before_remove():
    grammar_guard = _match(
        r"if\s*\(\s*v_idempotency_key\s+is\s+null.*?"
        r"raise\s+invalid_idempotency_key\s*;\s*end\s+if\s*;",
        MIGRATION,
    )
    double_hyphen_guard = _match(
        r"if\s*\(\s*contains\s*\(\s*v_idempotency_key\s*,\s*'--'\s*\)\s*\)\s*then\s+"
        r"raise\s+invalid_idempotency_key\s*;\s*end\s+if\s*;",
        MIGRATION,
    )
    declaration = _match(
        r"nonunique_idempotency_key\s+exception\s*\(\s*-20016\s*,\s*"
        r"'Idempotency key is not unique; refusing destructive stage removal'\s*\)\s*;",
        MIGRATION,
    )
    guard = _match(
        r"select\s+count\s*\(\s*\*\s*\)\s+into\s+:v_key_count\s+"
        r"from\s+app\.cloud_roasts\s+where\s+idempotency_key\s*=\s*:v_idempotency_key\s*;\s*"
        r"if\s*\(\s*v_key_count\s*<>\s*1\s*\)\s*then\s+"
        r"raise\s+nonunique_idempotency_key\s*;\s*end\s+if\s*;",
        MIGRATION,
    )
    assignment = _match(r"v_remove_sql\s*:=\s*'remove\s+@app\.roast_artifacts/'", MIGRATION)
    execution = _match(r"execute\s+immediate\s+:v_remove_sql\s*;", MIGRATION)
    transaction = _match(r"begin\s+transaction\s*;", MIGRATION)
    assert declaration.start() < grammar_guard.start()
    assert (
        grammar_guard.start()
        < double_hyphen_guard.start()
        < guard.start()
        < assignment.start()
        < execution.start()
        < transaction.start()
    )


def test_t_key_grammar_rejects_malformed_stage_prefix_inputs():
    grammar = _match(
        r"regexp_like\s*\(\s*v_idempotency_key\s*,\s*'(?P<grammar>\^[^']+\$)'"
    ).group("grammar")
    compiled = re.compile(grammar)
    rejected = (
        "",
        "   ",
        None,
        "../",
        "..",
        "a/b",
        "@x",
        "synthetic--idempotency",
        "a" * 65,
        "has/slash",
        "has@sign",
        "has.dot",
        "has space",
    )
    accepted = (
        "synthetic-idempotency-3-AbC_123",
        "01234567-89ab-cdef-0123-456789abcdef",
        "a" * 64,
    )
    assert all(
        value is None or compiled.fullmatch(value) is None or "--" in value
        for value in rejected
    )
    assert all(compiled.fullmatch(value) is not None and "--" not in value for value in accepted)


def test_t_seed_row_idempotency_key_passes_stored_key_guard():
    grammar = _match(
        r"regexp_like\s*\(\s*v_idempotency_key\s*,\s*'(?P<grammar>\^[^']+\$)'"
    ).group("grammar")
    seed_key = "synthetic-idempotency-3-aB91_token"
    assert re.fullmatch(grammar, seed_key) is not None
    assert "--" not in seed_key


def test_t_remove_present_once_and_built_only_from_validated_key():
    assignments = re.findall(
        r"v_remove_sql\s*:=\s*'remove\s+@app\.roast_artifacts/'\s*\|\|\s*"
        r"v_idempotency_key\s*\|\|\s*'/'\s*;",
        STRIPPED,
        re.I,
    )
    assert len(assignments) == 1
    assert len(re.findall(r"execute\s+immediate\s+:v_remove_sql\s*;", STRIPPED, re.I)) == 1
    assert re.search(r"execute\s+immediate\s+'[^;]*\|\|", STRIPPED, re.I) is None


def test_t_remove_is_after_all_key_guards_before_transaction():
    guard = _match(
        r"if\s*\(\s*v_idempotency_key\s+is\s+null\s+or\s+not\s+regexp_like\s*\(\s*"
        r"v_idempotency_key\s*,\s*'\^[^']+\$'\s*\)\s*\)\s*then\s+"
        r"raise\s+invalid_idempotency_key\s*;\s*end\s+if\s*;\s*"
        r"if\s*\(\s*contains\s*\(\s*v_idempotency_key\s*,\s*'--'\s*\)\s*\)\s*then\s+"
        r"raise\s+invalid_idempotency_key\s*;\s*end\s+if\s*;",
        MIGRATION,
    )
    uniqueness_guard = _match(
        r"if\s*\(\s*v_key_count\s*<>\s*1\s*\)\s*then\s+"
        r"raise\s+nonunique_idempotency_key\s*;\s*end\s+if\s*;",
        MIGRATION,
    )
    assignment = _match(r"v_remove_sql\s*:=\s*'remove\s+@app\.roast_artifacts/'", MIGRATION)
    remove = _match(r"execute\s+immediate\s+:v_remove_sql\s*;", MIGRATION)
    transaction = _match(r"begin\s+transaction\s*;", MIGRATION)
    assert guard.end() < uniqueness_guard.start() < assignment.start() < remove.start() < transaction.start()


def test_t_no_stage_path_interpolation_and_single_remove():
    assert re.search(r"\bstage_path\b", STRIPPED, re.I) is None
    assert len(re.findall(r"\bremove\s+@", STRIPPED, re.I)) == 1
