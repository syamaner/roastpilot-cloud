"""C9-C2 runbook requirements; no live execution."""

from test_sync_coordination import position
from pathlib import Path
import re

import pytest
def runbook_checkout_root(test_file: Path) -> Path:
    """Resolve only the two admitted absolute test-file layouts."""
    if not test_file.is_absolute() or '..' in test_file.parts:
        raise ValueError('runbook test path must use an admitted absolute layout')
    if test_file.parts[-4:] == ('snowflake', 'mutants', 'tests', 'test_c2_runbooks.py'):
        return test_file.parents[3]
    if test_file.parts[-3:] == ('snowflake', 'tests', 'test_c2_runbooks.py'):
        return test_file.parents[2]
    raise ValueError('unknown runbook test layout')


def load_runbook_documents(test_file: Path) -> tuple[str, str, str]:
    """Read exactly the three static docs from the admitted checkout root."""
    root = runbook_checkout_root(test_file) / 'docs' / 'runbooks'
    return (
        (root / 'backup-export.md').read_text(encoding='utf-8'),
        (root / 'prod-deploy-runbook.md').read_text(encoding='utf-8'),
        (root / 'key-rotation.md').read_text(encoding='utf-8'),
    )


ROOT=runbook_checkout_root(Path(__file__))
BACKUP, PROD, KEY=load_runbook_documents(Path(__file__))
assert '## C9-C2 coordinated backup boundary' in BACKUP
assert '## Export procedure' in BACKUP
BOUNDARY=BACKUP.split('## C9-C2 coordinated backup boundary',1)[1].split('## Export procedure',1)[0]


EXPECTED_CAPTURE_TABLES = (
    'cloud_roasts', 'roast_telemetry', 'roast_artifacts', 'tasting_reviews',
    'reference_roast_summaries', 'cloud_sync_coordination',
    'cloud_roast_tombstones', 'cloud_roast_field_revisions',
)


def assert_capture_inventory(document):
    snapshot = 'SET backup_snapshot_ts = CURRENT_TIMESTAMP();'
    assert document.count(snapshot) == 1
    exports = document.split(snapshot, 1)[1].split('```', 1)[0]
    destinations = re.findall(r'COPY INTO @<approved_backup_stage>/<backup_id>/tables/([a-z_]+)/', exports)
    sources = re.findall(r'FROM app\.([a-z_]+) AT\(TIMESTAMP => \$backup_snapshot_ts\)', exports)
    assert tuple(destinations) == EXPECTED_CAPTURE_TABLES
    assert tuple(sources) == EXPECTED_CAPTURE_TABLES
    assert len(re.findall(r'COPY INTO', exports)) == 8
    assert 'Capture counts at that same point and record `$backup_snapshot_ts`:' in document
    count_tail = document.split('Capture counts at that same point and record `$backup_snapshot_ts`:', 1)[1]
    assert '```sql\n' in count_tail
    counts = count_tail.split('```sql\n', 1)[1].split('```', 1)[0]
    pairs = re.findall(r"SELECT '([a-z_]+)'(?: AS object_name)?, COUNT\(\*\)(?: AS row_count)? FROM app\.([a-z_]+) AT\(TIMESTAMP => \$backup_snapshot_ts\)", counts)
    assert tuple(label for label, _ in pairs) == EXPECTED_CAPTURE_TABLES
    assert tuple(table for _, table in pairs) == EXPECTED_CAPTURE_TABLES
    assert counts.count('COUNT(*)') == 8
    assert len(re.findall(r'\bSELECT\b', counts)) == 8
    assert '## C9-C2 coordinated backup boundary' in document and '## Export procedure' in document
    boundary = document.split('## C9-C2 coordinated backup boundary', 1)[1].split('## Export procedure', 1)[0]
    normalized = ' '.join(boundary.split())
    assert position(normalized, 'as S0') < position(normalized, 'same transaction across all eight table exports, counts and source profiles') < position(normalized, 'as S1')
    assert '**both transaction identifiers and both write_seq values must be equal**' in boundary


def test_rb_capture_eight_tables():
    assert_capture_inventory(BACKUP)


@pytest.mark.parametrize('defect', ['missing_count', 'duplicate_count', 'mismatched_count', 'wrong_snapshot', 'missing_export', 'duplicate_export'])
def test_rb_capture_inventory_rejects_missing_duplicate_mismatch(defect):
    count = "UNION ALL SELECT 'cloud_roast_field_revisions', COUNT(*) FROM app.cloud_roast_field_revisions AT(TIMESTAMP => $backup_snapshot_ts)"
    export = 'COPY INTO @<approved_backup_stage>/<backup_id>/tables/cloud_roast_field_revisions/'
    bad = BACKUP
    if defect == 'missing_count':
        bad = bad.replace(count, '')
    elif defect == 'duplicate_count':
        bad = bad.replace(count, count + '\n' + count)
    elif defect == 'mismatched_count':
        bad = bad.replace(count, count.replace("'cloud_roast_field_revisions'", "'cloud_roasts'"))
    elif defect == 'wrong_snapshot':
        bad = bad.replace(count, count.replace('$backup_snapshot_ts', 'CURRENT_TIMESTAMP()'))
    elif defect == 'missing_export':
        bad = bad.replace(export, 'COPY INTO @<approved_backup_stage>/<backup_id>/tables/missing/')
    else:
        bad = bad.replace(export, export + '\n' + export)
    assert bad != BACKUP
    with pytest.raises(AssertionError):
        assert_capture_inventory(bad)


def test_rb_capture_seq_and_txn_boundary():
    assert 'BEGIN; CALL app.cloud_sync_enter();' in BOUNDARY
    assert 'current_transaction()' in BOUNDARY and 'write_seq' in BOUNDARY and 'S0' in BOUNDARY and 'S1' in BOUNDARY
    assert '**both transaction identifiers and both write_seq values must be equal**' in BOUNDARY
    assert 'rejects the capture' in BOUNDARY and 'ROLLBACK' in BOUNDARY
    assert_concrete_capture_boundary(BACKUP)


def test_rb_capture_attempt_uses_fresh_session_and_rejects_uncertain_commands():
    capture = ' '.join(BACKUP.split('### Export all eight base tables', 1)[1]
                       .split('### Export the internal artifact stage', 1)[0].split())
    assert 'Start a fresh, dedicated SnowSQL session for each coordinated capture attempt, including retries.' in capture
    assert 'Any failed or indeterminate command rejects the capture' in capture
    assert 'A failed or indeterminate commit also rejects the capture.' in capture


def test_rb_rejected_and_partial_backup_prefixes_keep_original_hash_deadline():
    capture = ' '.join(BACKUP.split('### Export all eight base tables', 1)[1]
                       .split('### Export the internal artifact stage', 1)[0].split())
    assert (
        'Rollback does not remove unloaded files. Apply the same original 30-day review-hash '
        'deadline to rejected or partial backup prefixes and delete or re-scrub their files '
        'by that deadline.'
    ) in capture


def test_rb_restore_empty_target_conditions():
    assert 'All seven data tables must contain zero rows' in BOUNDARY
    assert 'exactly one row named `cloud_sync_writer`' in BOUNDARY


def test_rb_restore_no_lock_row_load_and_seq_floor():
    assert 'Never load the captured coordination row.' in BOUNDARY
    assert 'GREATEST(<captured S1>, COALESCE(MAX(accepted_write_seq),0), COALESCE(MAX(deletion_write_seq),0))' in BOUNDARY
    assert 'Do not PUT' in BOUNDARY and 'tombstoned identities' in BOUNDARY


def test_rb_restore_reconciliation_fail_closed():
    for term in ['unreconciled','post-capture deletion/ack state unverified','writers remain disconnected','coordinated target transaction','source capture protocol','reviews, telemetry, artifacts and field revisions','set the final coordination floor']:
        assert term in BOUNDARY


def test_rb_restore_quality_zero_before_commit():
    assert 'SELECT COUNT(*) FROM app.data_quality_violations' in BOUNDARY
    assert 'must return 0 before COMMIT' in BOUNDARY and 'ROLLBACK' in BOUNDARY


def test_rb_prod_p4_coordinated_insert_only():
    for term in ['BEGIN; CALL app.cloud_sync_enter();','zero COUNT(*)','cloud_roast_tombstones','three cloud_roast_field_revisions rows','revision 0','ROLLBACK, never a MERGE/update','INSERT its','app.recompute_reference_summary']:
        assert term in PROD


def test_rb_key_rotation_no_retired_verifier_instruction():
    assert '`upsert_roast_verify_live.py` is retired by C9-C2 and refuses' in KEY
    assert 'python3 snowflake/upsert_roast_verify_live.py --target' not in KEY
    assert 'no replacement\nlive write instrument exists until C9-C4' in KEY


def fixture_runbook_checkout(tmp_path):
    checkout = tmp_path / 'checkout'
    docs = checkout / 'docs' / 'runbooks'
    docs.mkdir(parents=True)
    for name, content in [('backup-export.md', 'backup source'), ('prod-deploy-runbook.md', 'prod source'), ('key-rotation.md', 'key source')]:
        (docs / name).write_text(content, encoding='utf-8')
    return checkout


def fixture_test_path(checkout, layout):
    tail = 'snowflake/tests/test_c2_runbooks.py' if layout == 'native' else 'snowflake/mutants/tests/test_c2_runbooks.py'
    path = checkout / tail
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch()
    return path


@pytest.mark.parametrize('layout', ['native', 'copied'])
def test_rb_input_layout_reads_same_checkout_documents(tmp_path, layout):
    checkout = fixture_runbook_checkout(tmp_path)
    path = fixture_test_path(checkout, layout)
    assert runbook_checkout_root(path) == checkout
    assert load_runbook_documents(path) == ('backup source', 'prod source', 'key source')


@pytest.mark.parametrize('layout', ['native', 'copied'])
@pytest.mark.parametrize('missing', ['backup-export.md', 'prod-deploy-runbook.md', 'key-rotation.md'])
def test_rb_input_layout_missing_document_fails(tmp_path, layout, missing):
    checkout = fixture_runbook_checkout(tmp_path)
    path = fixture_test_path(checkout, layout)
    (checkout / 'docs' / 'runbooks' / missing).unlink()
    with pytest.raises(FileNotFoundError):
        load_runbook_documents(path)


@pytest.mark.parametrize('tail', ['tests/test_c2_runbooks.py', 'snowflake/other/tests/test_c2_runbooks.py', 'snowflake/mutants/other/tests/test_c2_runbooks.py', 'snowflake/tests/other.py', 'snowflake/tests/../tests/test_c2_runbooks.py'])
def test_rb_input_layout_unknown_absolute_rejected(tmp_path, tail):
    with pytest.raises(ValueError):
        load_runbook_documents(tmp_path / tail)


def test_rb_input_layout_relative_rejected():
    with pytest.raises(ValueError):
        load_runbook_documents(Path('snowflake/tests/test_c2_runbooks.py'))


@pytest.mark.parametrize('layout', ['native', 'copied'])
@pytest.mark.parametrize('shadow_tail', ['snowflake/docs/runbooks', 'snowflake/mutants/docs/runbooks'])
def test_rb_input_layout_never_falls_back_to_shadow_docs(tmp_path, layout, shadow_tail):
    checkout = fixture_runbook_checkout(tmp_path)
    path = fixture_test_path(checkout, layout)
    shadow = checkout / shadow_tail
    shadow.mkdir(parents=True, exist_ok=True)
    for name in ['backup-export.md', 'prod-deploy-runbook.md', 'key-rotation.md']:
        (shadow / name).write_text('shadow source', encoding='utf-8')
    assert load_runbook_documents(path) == ('backup source', 'prod source', 'key source')
    (checkout / 'docs/runbooks/backup-export.md').unlink()
    with pytest.raises(FileNotFoundError):
        load_runbook_documents(path)


def assert_concrete_capture_boundary(document):
    start = '### Export all eight base tables'
    end = '### Export the internal artifact stage'
    assert start in document and end in document
    capture = document.split(start, 1)[1].split(end, 1)[0]
    anchors = [
        'BEGIN;\nCALL app.cloud_sync_enter();',
        'SET backup_s0_txn = (SELECT CURRENT_TRANSACTION());',
        "SET backup_s0_seq = (SELECT write_seq FROM app.cloud_sync_coordination WHERE lock_name = 'cloud_sync_writer');",
        "SELECT $backup_s0_txn AS transaction_id, $backup_s0_seq AS write_seq, 'S0' AS boundary;",
        'SET backup_snapshot_ts = CURRENT_TIMESTAMP();',
        'COPY INTO @<approved_backup_stage>/<backup_id>/tables/cloud_roasts/',
        'Capture counts at that same point and record `$backup_snapshot_ts`:',
        'source-snapshot VARIANT type/null',
        'SET backup_s1_txn = (SELECT CURRENT_TRANSACTION());',
        "SET backup_s1_seq = (SELECT write_seq FROM app.cloud_sync_coordination WHERE lock_name = 'cloud_sync_writer');",
        "SELECT $backup_s1_txn AS transaction_id, $backup_s1_seq AS write_seq, 'S1' AS boundary;",
        'SELECT IFF($backup_s0_txn IS NOT NULL AND $backup_s1_txn IS NOT NULL',
        "'ACCEPT', 'REJECT') AS capture_boundary_decision;",
        'run `ROLLBACK;`', 'run `COMMIT;`',
    ]
    assert all(anchor in capture for anchor in anchors)
    positions = [position(capture, anchor) for anchor in anchors]
    assert positions == sorted(positions) and len(set(positions)) == len(anchors)
    assert capture.count('CALL app.cloud_sync_enter();') == 1
    assert 'AND $backup_s0_seq IS NOT NULL AND $backup_s1_seq IS NOT NULL' in capture
    assert 'AND $backup_s0_txn = $backup_s1_txn AND $backup_s0_seq = $backup_s1_seq' in capture
    assert 'G1 must qualify SET/unload transaction continuity' in capture
    assert 'never an alternative to BEGIN/entry/S0/snapshot/reads/S1/equality/COMMIT' in capture


@pytest.mark.parametrize('defect', ['missing_begin', 'missing_enter', 'missing_s0', 'early_snapshot', 'missing_s1', 'early_s1', 'missing_equality'])
def test_rb_concrete_capture_boundary_rejects_missing_or_reordered_parts(defect):
    snapshot = 'SET backup_snapshot_ts = CURRENT_TIMESTAMP();'
    begin_enter = 'BEGIN;\nCALL app.cloud_sync_enter();'
    s0 = "SELECT $backup_s0_txn AS transaction_id, $backup_s0_seq AS write_seq, 'S0' AS boundary;"
    s1 = 'SET backup_s1_txn = (SELECT CURRENT_TRANSACTION());'
    replacements = {
        'missing_begin': ('BEGIN;\nCALL', 'CALL'),
        'missing_enter': ('CALL app.cloud_sync_enter();', ''),
        'missing_s0': (s0, ''),
        'early_snapshot': (begin_enter, snapshot + '\n' + begin_enter),
        'missing_s1': (s1, ''),
        'early_s1': (begin_enter, s1 + '\n' + begin_enter),
        'missing_equality': ('AND $backup_s0_txn = $backup_s1_txn AND $backup_s0_seq = $backup_s1_seq', ''),
    }
    old, new = replacements[defect]
    bad = BACKUP.replace(old, new)
    if defect == 'early_snapshot':
        bad = bad.replace(s0 + '\n' + snapshot, s0)
    assert bad != BACKUP
    with pytest.raises(AssertionError):
        assert_concrete_capture_boundary(bad)


def test_rb_fresh_capture_session_reselects_and_verifies_context_before_begin():
    capture = BACKUP.split('### Export all eight base tables', 1)[1].split(
        '### Export the internal artifact stage', 1
    )[0]
    begin = 'BEGIN;\nCALL app.cloud_sync_enter();'
    assert begin in capture
    before_begin = ' '.join(capture.split(begin, 1)[0].split())
    assert (
        'including retries. In every fresh session, reselect the documented owner role '
        '`ROASTPILOT_ADMIN`, the explicitly selected source database `<source_db>` and '
        'the `APP` schema.'
    ) in before_begin
    assert (
        'Before any capture command or `BEGIN`, verify those exact values with '
        '`CURRENT_ROLE()`, `CURRENT_DATABASE()` and `CURRENT_SCHEMA()`. '
        'Stop on a mismatch or any missing or uncertain result.'
    ) in before_begin


def test_rb_restore_rebuilds_reconciled_summaries_before_read_only_verification():
    restore = ' '.join(BOUNDARY.split('For restore,', 1)[1].split())
    steps = (
        'After loading and applying the required tombstone and revision reconciliation',
        'rebuild summaries in that same coordinated target transaction',
        'Do not load the captured derived rows.',
        'Clear the derived rows from `app.reference_roast_summaries`',
        'each distinct non-null `(bean_origin, roast_level)` group in the reconciled',
        '`app.recompute_reference_summary` once per group with bound connector parameters',
        'set the final coordination floor',
        'SELECT COUNT(*) FROM app.data_quality_violations',
        'must return 0 before COMMIT',
    )
    offsets = [position(restore, step) for step in steps]
    assert offsets == sorted(offsets)
    assert (
        'Any failed or indeterminate rebuild rejects recovery: roll back under '
        'the existing recovery rules and keep writers disconnected.'
    ) in restore
    verify = BACKUP.split('## Verify\n', 1)[1].split('## Ownership summary', 1)[0]
    assert (
        'Read the rebuilt summary rows and compare their keys and values with the '
        'manifest baseline. This verification is read-only:'
    ) in ' '.join(verify.split())
    assert 'FROM app.reference_roast_summaries' in verify
    assert not re.search(r'\brecompute\b|\brecompute_reference_summary\b', verify, re.IGNORECASE)
