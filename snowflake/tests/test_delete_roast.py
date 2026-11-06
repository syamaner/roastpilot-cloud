"""Offline token/region checks for C2-S6 DELETE_ROAST (issue #314).

Parses migration text like the neighboring procedure suite and reuses its
line-comment stripper. Keep one module per procedure under test and each test
single-purpose.
"""
from __future__ import annotations

from test_sync_coordination import position

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
    has(SQL, 'create or replace procedure delete_roast(p_run_id string, p_public_slug string) copy grants returns variant language sql execute as owner')


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
    has(SQL, 'delete from app.tasting_reviews where roast_id = :v_id;')


def test_t_child_telemetry_deleted_by_bound_roast_id():
    has(SQL, 'delete from app.roast_telemetry where roast_id = :v_id;')


def test_t_child_artifacts_deleted_by_bound_roast_id():
    has(SQL, 'delete from app.roast_artifacts where roast_id = :v_id;')


def test_t_parent_roast_deleted_by_bound_id():
    has(SQL, 'delete from app.cloud_roasts where id = :v_id;')


def test_t_parent_rowcount_guard_after_delete_before_recompute_in_transaction():
    has(SQL, 'delete from app.cloud_roasts where id = :v_id; if (sqlrowcount <> 1) then raise ambiguous_roast_id; end if; call app.recompute_reference_summary(:v_bean_origin, :v_roast_level);')


def test_t_stage_remove_is_the_only_dynamic_sql():
    assert len(re.findall(r'execute\s+immediate', SQL, re.I)) == 1
    has(SQL, "execute immediate 'remove @app.roast_artifacts/' || :v_captured_key || '/';")


def test_t_recompute_once_after_five_deletes_inside_transaction():
    assert len(re.findall(r'call\s+app.recompute_reference_summary', SQL, re.I)) == 1
    assert len(re.findall(r'delete\s+from', SQL, re.I)) == 5
    assert position(SQL.lower(), 'delete from app.cloud_roast_field_revisions') < position(SQL.lower(), 'delete from app.cloud_roasts') < position(SQL.lower(), 'call app.recompute_reference_summary') < position(SQL.lower(), 'commit;')


def test_t_grouping_capture_precedes_parent_delete():
    has(SQL, 'select id, public_slug, idempotency_key, bean_origin, roast_level into :v_id, :v_slug, :v_captured_key, :v_bean_origin, :v_roast_level from app.cloud_roasts where idempotency_key = :p_run_id;')
    assert position(SQL, 'into :v_id, :v_slug') < position(SQL, 'delete from app.cloud_roasts')


def test_t_txn_structure_wraps_deletes_and_recompute_with_rollback_reraise():
    has(SQL, 'exception when other then rollback; raise;')
    assert position(SQL, 'begin transaction;') < position(SQL, 'delete from app.tasting_reviews') < position(SQL, 'commit;') < position(SQL, 'execute immediate')


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
    has(SQL, "delete_identity_mismatch exception (-20025, 'Run id and public slug do not identify one roast or tombstone');")
    assert position(SQL, 'raise delete_identity_mismatch;') < position(SQL, 'begin transaction;')


def test_t_never_created_branch_tombstones_without_fabricated_identity():
    has(SQL, "v_id := null; v_captured_key := p_run_id; insert into app.cloud_roast_tombstones (cloud_roast_id, idempotency_key, public_slug, deletion_write_seq) values (NULL, :v_captured_key, :p_public_slug, :v_write_seq); v_deletion := 'tombstoned_without_row';")
    assert 'no-op: roast not found' not in SQL


def test_t_ambiguous_id_guard_after_entry_before_delete():
    has(SQL, 'if (v_n > 1) then raise ambiguous_idempotency_key; end if;')
    assert position(SQL, 'call app.cloud_sync_enter()') < position(SQL, 'if (v_n > 1)') < position(SQL, 'delete from app.cloud_roasts')


def test_t_key_capture_reads_idempotency_key_under_lock():
    assert position(SQL, 'call app.cloud_sync_enter()') < position(SQL, 'into :v_id, :v_slug, :v_captured_key') < position(SQL, 'commit;')
    has(SQL, 'if (v_captured_key is null or v_captured_key is distinct from p_run_id) then raise delete_identity_mismatch; end if;')


def test_t_key_guard_matches_telemetry_containment_grammar_before_transaction():
    match = re.search(r"regexp_like\(p_run_id, '([^']+)'\)", SQL)
    assert match is not None
    grammar = match[1]
    assert grammar == UUID_GRAMMAR
    assert position(SQL, 'regexp_like(p_run_id') < position(SQL, 'begin transaction;')
    assert re.fullmatch(grammar, '01234567-89ab-cdef-0123-456789abcdef')


def test_t_key_uniqueness_guard_fails_closed_before_remove():
    has(SQL, 'if (v_n > 1) then raise ambiguous_idempotency_key; end if;')
    has(SQL, 'if (v_slug is distinct from p_public_slug or v_ls <> 1 or v_t_i > 0) then raise delete_identity_mismatch; end if;')
    assert position(SQL, 'if (v_captured_key is null') < position(SQL, 'execute immediate')


def test_t_key_grammar_rejects_malformed_stage_prefix_inputs():
    for value in (None, '', '../x', 'a/b', "a'b", 'a\\b', 'run--1', 'A'*36, '01234567-89ab-cdef-0123-456789abcdef\n'):
        assert value is None or re.fullmatch(UUID_GRAMMAR, value) is None


def test_t_seed_row_idempotency_key_passes_stored_key_guard():
    assert re.fullmatch(UUID_GRAMMAR, '01234567-89ab-cdef-0123-456789abcdef')
    assert re.fullmatch(UUID_GRAMMAR, 'seed-1') is None


def test_t_remove_present_once_and_built_only_from_validated_key():
    has(SQL, "execute immediate 'remove @app.roast_artifacts/' || :v_captured_key || '/';")
    assert SQL.lower().count('remove @') == 1
    assert 'stage_path' not in SQL.lower()


def test_t_remove_is_after_validated_key_and_commit():
    assert position(SQL, 'if (v_captured_key is null') < position(SQL, 'commit;') < position(SQL, 'execute immediate')
    assert 'from app.' not in SQL[position(SQL, 'commit;'):]


def test_t_no_stage_path_interpolation_and_single_remove():
    assert 'stage_path' not in SQL.lower()
    assert SQL.lower().count('remove @') == 1

from test_sync_coordination import has
SQL = STRIPPED if 'STRIPPED' in globals() else re.sub(r'--[^\n]*', '', MIGRATION)
UUID_GRAMMAR = r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

from test_sync_coordination import has, sql


def test_del_c2_signature_and_pre_lock_grammars():
    test_t_sig_exact_signature_and_procedure_attributes()
    has(SQL, "regexp_like(p_public_slug, '^[1-9A-HJ-NP-Za-km-z]{17,64}$')")
    has(SQL, "regexp_like(p_run_id, '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')")
    assert 'app.' not in SQL[:position(SQL, 'begin transaction;')]


def test_del_c2_branch_table():
    has(SQL,'if (v_n > 1) then raise ambiguous_idempotency_key;')
    for condition in ['v_t_k = 0 and v_t_s = 0 and v_n = 1','v_t_k = 0 and v_t_s = 0 and v_n = 0','v_t_k = 1 and v_t_s = 1 and v_t_ks = 1 and v_n = 0 and v_ls = 0']:
        has(SQL,condition)
    has(SQL,'if (v_slug is distinct from p_public_slug or v_ls <> 1 or v_t_i > 0) then raise delete_identity_mismatch;')


def test_del_c2_tombstone_insert_before_cascade():
    has(SQL,'insert into app.cloud_roast_tombstones (cloud_roast_id, idempotency_key, public_slug, deletion_write_seq) values (:v_id, :v_captured_key, :v_slug, :v_write_seq);')
    assert position(SQL, 'values (:v_id, :v_captured_key, :v_slug, :v_write_seq)') < position(SQL, 'delete from app.tasting_reviews')


def test_del_c2_null_id_only_without_row():
    has(SQL,"v_id := null; v_captured_key := p_run_id; insert into app.cloud_roast_tombstones (cloud_roast_id, idempotency_key, public_slug, deletion_write_seq) values (NULL, :v_captured_key, :p_public_slug, :v_write_seq); v_deletion := 'tombstoned_without_row';")
    assert 'uuid_string' not in SQL.lower()


def test_del_c2_no_row_slug_collision_refused():
    has(SQL,'elseif (v_t_k = 0 and v_t_s = 0 and v_n = 0) then if (v_ls >= 1) then raise delete_identity_mismatch; end if;')


def test_del_c2_cascade_includes_field_revisions():
    has(SQL,'delete from app.cloud_roast_field_revisions where cloud_roast_id = :v_id;')
    assert position(SQL, 'delete from app.cloud_roast_field_revisions') < position(SQL, 'delete from app.cloud_roasts')


def test_del_c2_remove_after_commit_from_captured_key():
    assert position(SQL, 'commit;') < position(SQL, 'execute immediate')
    has(SQL,"execute immediate 'remove @app.roast_artifacts/' || :v_captured_key || '/';")
    assert 'from app.' not in SQL[position(SQL, 'commit;'):]


def test_del_c2_every_branch_runs_remove():
    has(SQL,"commit; exception when other then rollback; raise; end; begin execute immediate 'remove @app.roast_artifacts/' || :v_captured_key || '/'; exception when other then v_stage_removal := 'failed'; end;")
    assert 'return ' not in SQL[:position(SQL, 'execute immediate')].lower()
    assert all("v_deletion := '"+x+"'" in SQL for x in ['deleted','tombstoned_without_row','already_tombstoned'])


def test_del_c2_return_shape_cache_pending():
    has(SQL,"return object_construct_keep_null('cloud_roast_id', v_id, 'deletion', v_deletion, 'deletion_write_seq', v_deletion_write_seq, 'stage_removal', v_stage_removal, 'cache_invalidation', 'pending');")
    assert "'complete'" not in SQL


def test_del_c2_copy_grants_preserves_controlled_signature():
    has(SQL, 'create or replace procedure delete_roast(p_run_id string, p_public_slug string) copy grants returns variant language sql execute as owner')
