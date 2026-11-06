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
        'set the preliminary coordination floor',
        'SELECT COUNT(*) FROM app.data_quality_violations',
        'must return 0 before proceeding to reconciliation',
        'Reconciliation is itself coordinated',
        'makes restore **unreconciled**: STOP',
        'If source history is unreachable',
        'writers remain disconnected without an explicit operator decision',
        'Never accept unknown post-capture deletion/ack state as ordinary recovery success.',
        'Resolve reconciliation eligibility before rebuilding summaries.',
        'after the required reconciliation and the eligibility decision are complete.',
        'After loading and applying the required tombstone and revision reconciliation',
        'rebuild summaries in that same coordinated target transaction',
        'Do not load the captured derived rows.',
        'Execute `DELETE FROM app.reference_roast_summaries` inside '
        'that same target transaction.',
        'Do not use `TRUNCATE` or any implicit-commit operation inside '
        'this coordinated restore boundary.',
        'each distinct non-null `(bean_origin, roast_level)` group in the reconciled',
        '`app.recompute_reference_summary` once per group with bound connector parameters',
        'set the final coordination floor',
        'SELECT COUNT(*) FROM app.data_quality_violations',
        'must return 0 before COMMIT',
    )
    offset = 0
    for step in steps:
        offset = position(restore, step, offset) + len(step)
    assert (
        'Any failed or indeterminate rebuild rejects recovery: roll back under '
        'the existing recovery rules and keep writers disconnected.'
    ) in restore
    verify = BACKUP.split('## Verify\n', 1)[1].split('## Ownership summary', 1)[0]
    assert (
        'Read the rebuilt summary rows and compare their keys and values with the '
        'reconciliation acceptance baseline. This verification is read-only:'
    ) in ' '.join(verify.split())
    assert 'FROM app.reference_roast_summaries' in verify
    assert not re.search(r'\brecompute\b|\brecompute_reference_summary\b', verify, re.IGNORECASE)


def test_rb_restore_provisional_rows_reconcile_before_files_and_commit():
    restore = ' '.join(BACKUP.split('## Restore and disaster recovery', 1)[1]
                       .split('## Verify', 1)[0].split())
    steps = (
        'All COPY templates below are provisional row loads',
        'COPY INTO app.cloud_roasts',
        'COPY INTO app.roast_telemetry',
        'COPY INTO app.roast_artifacts',
        'COPY INTO app.tasting_reviews',
        '### Load tombstones and field revisions',
        '### Reconcile the complete graph before files',
        'Apply the preliminary coordination floor and zero-quality check',
        'Resolve reconciliation eligibility before any PUT.',
        '### Derive a separate reconciliation acceptance baseline',
        '### Upload and verify only retained artifact files',
        "PUT 'file:///secure/roastpilot-backups/",
        "Verify each retained file's name, size and checksum",
        '### Rebuild and finish the coordinated target transaction',
        'Only after full file verification, rebuild summaries',
        'final coordination floor and zero-quality check before COMMIT',
    )
    offset = 0
    for step in steps:
        offset = position(restore, step, offset) + len(step)
    assert 'uncommitted coordinated target transaction' in restore
    assert 'do not expose the rows or reconnect any writer' in restore
    assert 'All row loads must be complete before the next step' in restore
    assert 'no PUT and no ordinary recovery success' in restore
    assert 'roll back target rows and keep writers disconnected' in restore
    assert 'A failed post-commit verification keeps the target isolated and unaccepted.' in restore


def test_rb_reconciliation_acceptance_baseline_has_independent_provenance():
    baseline = ' '.join(BACKUP.split(
        '### Derive a separate reconciliation acceptance baseline', 1
    )[1].split('### Upload and verify only retained artifact files', 1)[0].split())
    for required in (
        'Preserve the original protected capture manifest and exports unchanged',
        'Derive and protect a separate reconciliation acceptance baseline independently',
        'verified, eligible deletion reconciliation evidence',
        'Record the original manifest identity and the accepted reconciliation evidence',
        'Never derive expected results from restored-target query results',
        'or rewrite the original manifest to match the target',
        'Unknown or unprovable expectations reject recovery.',
        'No restored summary output is an oracle for itself.',
    ):
        assert required in baseline


def test_rb_reconciliation_baseline_filters_matching_rows_and_preserves_profiles():
    baseline = ' '.join(BACKUP.split(
        '### Derive a separate reconciliation acceptance baseline', 1
    )[1].split('### Upload and verify only retained artifact files', 1)[0].split())
    for required in (
        'existing validated identity and cascade rules',
        'Count each matching captured identity once',
        'repeated tombstones must not double-count it',
        'a tombstone matching no captured row must not subtract any row',
        'Do not decrement counts by the number of tombstones.',
        'telemetry, artifact, review and field-revision rows',
        'Ambiguous identity is a STOP',
        'Expected VARIANT null/type/presence profiles',
        'per-row presence for retained identities',
        'Expected reference-summary keys and every aggregate value',
        '`contributed_to_learning = true` filter',
        'Retained opted-out rows still count in loaded tables',
        'existing grouping, time anchors, telemetry selection/tie rules and null semantics',
        'expected rebuilt `key_patterns` values',
        'With unchanged reconciliation, retain the original applicable expectations.',
        'the expected roast count is one in the derived acceptance baseline',
        'the original capture evidence still records two',
    ):
        assert required in baseline
    for table in ('cloud_roasts', 'roast_telemetry', 'roast_artifacts', 'tasting_reviews'):
        assert '`app.' + table + '`' in baseline


def test_rb_restore_file_inventory_rejects_missing_unexpected_and_tombstoned_files():
    files = ' '.join(BACKUP.split(
        '### Upload and verify only retained artifact files', 1
    )[1].split('### Rebuild and finish the coordinated target transaction', 1)[0].split())
    for required in (
        'Only after eligibility and the independent baseline/retained-artifact inventory are complete',
        'Do not PUT stage files for tombstoned identities.',
        'every local file it selects is in that retained-artifact inventory',
        'otherwise STOP without uploading it',
        "Verify each retained file's name, size and checksum and the complete permitted target-stage inventory",
        'against the independently derived retained-artifact inventory',
        'Missing, unexpected, tombstoned, unmatched or unverified files reject recovery.',
        'A provisional metadata row is not evidence that its file exists or is correct.',
        'Stage effects do not roll back.',
        'If disallowed or unverified files were already uploaded, STOP and keep the target isolated',
        'existing separately authorised recovery cleanup and empty-target preflight rules',
        'no automatic REMOVE, new cleanup recipe, actor or privilege',
        'does not prove permanent prefix emptiness or atomic erasure',
        'it never excuses preventable operator restore uploads',
    ):
        assert required in files


def test_rb_verify_compares_all_results_to_reconciliation_acceptance_baseline():
    verify = ' '.join(BACKUP.split('## Verify', 1)[1]
                      .split('## Ownership summary', 1)[0].split())
    for required in (
        'reconciliation acceptance baseline',
        'null, nested-path and per-row presence results must equal',
        'Compare the reconciliation acceptance baseline counts only for the four loaded tables',
        'compare their keys and values with the reconciliation acceptance baseline',
        'complete target-stage listing to the independently derived retained-artifact inventory',
        'No missing, unexpected or tombstoned file is acceptable.',
        'This verification is read-only',
        'Keep the target isolated and stop if any check is unknown or fails.',
    ):
        assert required in verify
    assert 'must match the reconciliation acceptance baseline' in verify



def test_rb_control_metadata_copy_preserves_captured_values():
    start = '### Load tombstones and field revisions'
    end = '### Reconcile the complete graph before files'
    assert start in BACKUP and end in BACKUP
    loads = ' '.join(BACKUP.split(start, 1)[1].split(end, 1)[0].split())
    for table in ('cloud_roast_tombstones', 'cloud_roast_field_revisions'):
        expected = (
            'COPY INTO app.' + table
            + ' FROM @<approved_backup_stage>/<backup_id>/tables/' + table + '/ '
            + 'FILE_FORMAT=(TYPE=PARQUET) MATCH_BY_COLUMN_NAME=CASE_INSENSITIVE '
            + 'ON_ERROR=ABORT_STATEMENT PURGE=FALSE;'
        )
        assert loads.count(expected) == 1
    assert 'without initialising or resetting accepted revisions or write sequences' in loads
    assert 'SAME isolated, uncommitted, coordinated target transaction' in loads
    assert 'Never load the captured coordination row.' in loads
    assert 'COPY INTO app.cloud_sync_coordination' not in loads
    assert 'G1 must still qualify both commands and transaction continuity' in loads


def test_rb_control_baseline_preserves_all_tombstone_fields_and_nulls():
    start = '### Derive a separate reconciliation acceptance baseline'
    end = '### Compare exact control state before files'
    assert start in BACKUP and end in BACKUP
    baseline = ' '.join(BACKUP.split(start, 1)[1].split(end, 1)[0].split())
    for required in (
        'preserve every captured tombstone and include every eligible authoritative tombstone',
        'Bind all four fields exactly: `cloud_roast_id`, `idempotency_key`, `public_slug`, `deletion_write_seq`.',
        'Preserve legitimate NULL cloud IDs and legacy NULL deletion sequences exactly',
        'never invent an ID or coerce a legacy NULL sequence to zero',
        'Never derive expected results from restored-target query results',
        'Derive all expected rows and counts only from the immutable captured inputs and verified eligible reconciliation evidence.',
        'These TWO counts do not replace the FOUR loaded data-table counts or exact control-state comparisons.',
    ):
        assert required in baseline


def test_rb_control_baseline_preserves_captured_revision_values():
    start = '### Derive a separate reconciliation acceptance baseline'
    end = '### Compare exact control state before files'
    assert start in BACKUP and end in BACKUP
    baseline = ' '.join(BACKUP.split(start, 1)[1].split(end, 1)[0].split())
    for required in (
        'Exact retained per-field revision rows for every surviving restored roast',
        '`cloud_roast_id`, `field_name`, `accepted_revision`, `accepted_write_seq`',
        'from the captured state under the unchanged eligibility rules',
        'Exclude revision rows only for identities removed by the accepted deletion reconciliation.',
        'Preserve the exact captured acknowledgement values',
        'do not fabricate revision-zero rows, restore newer edits/acknowledgements or infer values from the target',
    ):
        assert required in baseline


def test_rb_control_comparison_is_complete_null_safe_and_not_count_only():
    start = '### Compare exact control state before files'
    end = '### Upload and verify only retained artifact files'
    assert start in BACKUP and end in BACKUP
    comparison = ' '.join(BACKUP.split(start, 1)[1].split(end, 1)[0].split())
    for required in (
        'compare BOTH complete target protocol-metadata tables with the independently expected rows and every field value',
        'Require null-safe equality and no missing, extra, duplicate or mismatched row.',
        'NULL matches only an expected NULL',
        'an unexpected NULL or a NULL-to-value change rejects recovery',
        'Count equality or a zero-quality result alone is insufficient.',
        'without filtering or DISTINCT that could hide missing, extra or duplicate control state',
        'SELECT cloud_roast_id, idempotency_key, public_slug, deletion_write_seq FROM app.cloud_roast_tombstones;',
        'SELECT cloud_roast_id, field_name, accepted_revision, accepted_write_seq FROM app.cloud_roast_field_revisions;',
        'actual target state for comparison, never the source of expected state',
        'check both supplementary protocol-table counts',
        'Any unknown, failed or indeterminate comparison rejects recovery and keeps writers disconnected.',
    ):
        assert required in comparison


def test_rb_control_verification_before_put_commit_and_after_restore():
    start = '## Restore and disaster recovery'
    end = '## Verify'
    assert start in BACKUP and end in BACKUP
    restore = ' '.join(BACKUP.split(start, 1)[1].split(end, 1)[0].split())
    steps = (
        'COPY INTO app.cloud_roast_tombstones',
        'COPY INTO app.cloud_roast_field_revisions',
        '### Reconcile the complete graph before files',
        '### Derive a separate reconciliation acceptance baseline',
        '### Compare exact control state before files',
        'Exact control-state verification must succeed BEFORE any PUT',
        "PUT 'file:///secure/roastpilot-backups/",
        '### Rebuild and finish the coordinated target transaction',
        'Only after full file verification, rebuild summaries',
        'Then repeat the exact control-state comparison against the same protected expected rows.',
        'Only after it succeeds, apply the final coordination floor and zero-quality check before COMMIT',
    )
    offset = 0
    for step in steps:
        offset = position(restore, step, offset) + len(step)
    assert 'Before COMMIT, roll back target rows under the existing rules' in restore
    assert 'after COMMIT, keep the target isolated and unaccepted' in restore
    verify = ' '.join(BACKUP.split('## Verify', 1)[1].split('## Ownership summary', 1)[0].split())
    assert 'Repeat both complete protocol-metadata table comparisons and their supplementary counts in this read-only post-restore verification.' in verify
    assert 'same protected expected tombstone and retained revision rows' in verify
    assert 'Null-safe exact equality must again reject every missing, extra, duplicate or mismatched row and unexpected NULL/value change.' in verify


def test_rb_control_state_failure_examples_reject_valid_shapes():
    start = '### Compare exact control state before files'
    end = '### Upload and verify only retained artifact files'
    assert start in BACKUP and end in BACKUP
    comparison = ' '.join(BACKUP.split(start, 1)[1].split(end, 1)[0].split())
    assert 'A target missing even one captured permanent tombstone must be rejected even when all FOUR data-table counts and data quality pass.' in comparison
    assert 'A target with three structurally valid revision rows but lower or different `accepted_revision` or `accepted_write_seq` must be rejected despite passing shape checks.' in comparison
    assert 'Missing, extra or duplicate control rows and unexpected NULL/value changes reject recovery.' in comparison



def test_rb_captured_inputs_match_original_manifest_before_adjusted_baseline():
    start = '### Bind captured inputs to original evidence'
    end = '### Load provisional parent and telemetry rows'
    assert start in BACKUP and end in BACKUP
    inputs = ' '.join(BACKUP.split(start, 1)[1].split(end, 1)[0].split())
    for required in (
        'Before deriving any reconciliation acceptance baseline',
        'complete captured table-file inventory and each file checksum',
        'protected immutable original capture manifest',
        'Reconstruct the complete captured row sets and require the original recorded row counts for ALL EIGHT captured tables',
        'original capture counts, before accepted deletions adjust any later expectations, not target counts',
        'Missing or extra files, checksum mismatch, missing or extra rows, conflicting evidence',
        'any unknown, failed or indeterminate check rejects recovery',
        'Do not alter the original manifest, exports, original counts or capture procedure to make an incomplete backup pass.',
    ):
        assert required in inputs
    for table in EXPECTED_CAPTURE_TABLES:
        assert '`' + table + '`' in inputs
    restore = BACKUP.split('## Restore and disaster recovery', 1)[1]
    assert position(restore, start) < position(restore, end)
    assert position(restore, start) < position(restore, '### Derive a separate reconciliation acceptance baseline')


def test_rb_incomplete_captured_control_evidence_rejects_before_derivation():
    start = '### Bind captured inputs to original evidence'
    end = '### Load provisional parent and telemetry rows'
    assert start in BACKUP and end in BACKUP
    inputs = ' '.join(BACKUP.split(start, 1)[1].split(end, 1)[0].split())
    assert 'Explicitly include the complete captured tombstone and field-revision row sets.' in inputs
    assert 'An incomplete captured tombstone or field-revision row set must be rejected against the original manifest counts and file evidence before adjusted baseline derivation.' in inputs


def test_rb_value_baseline_binds_captured_identity_nulls_and_private_values():
    start = '### Derive a separate reconciliation acceptance baseline'
    end = '### Compare exact control state before files'
    assert start in BACKUP and end in BACKUP
    baseline = ' '.join(BACKUP.split(start, 1)[1].split(end, 1)[0].split())
    for required in (
        'Exact captured `operator_rating`, `operator_notes` and `contributed_to_learning` values',
        'for every surviving retained roast, bound to its captured `id`, `idempotency_key` and `public_slug`',
        'Exclude ONLY identities removed by the existing accepted deletion reconciliation.',
        'Preserve explicit SQL NULL in nullable ratings and private notes exactly',
        'preserve the consent boolean exactly',
        'Never initialise or reset these values or revisions, infer expected values from the target, or restore newer edits/acknowledgements.',
        'protected and operator-only',
        'never put private note content or other roast data into public logs, repository fixtures, PRs or new public projections',
        'Never derive expected results from restored-target query results',
    ):
        assert required in baseline


def test_rb_target_value_observation_requires_exact_independent_complete_rows():
    start = '#### Compare retained roast values with acknowledgements'
    end = '### Upload and verify only retained artifact files'
    assert start in BACKUP and end in BACKUP
    comparison = ' '.join(BACKUP.split(start, 1)[1].split(end, 1)[0].split())
    for required in (
        'Observe the complete target roast identity/value rows read-only',
        'alongside the complete tombstone and field-revision comparisons',
        'SELECT id, idempotency_key, public_slug, operator_rating, operator_notes, contributed_to_learning FROM app.cloud_roasts;',
        'Require null-safe exact complete row/value equality against the independently expected retained captured roast rows',
        'no missing, extra, duplicate, identity, field-value or NULL mismatch',
        'Bind each value to its captured `id`, `idempotency_key` and `public_slug`',
        'preserve legitimate explicit SQL NULL ratings/notes and the consent boolean exactly',
        'it never defines expected values',
        'Do not change data or reset revisions to make verification pass.',
        'private note results must not be copied into public logs, repository fixtures, PRs or public projections',
    ):
        assert required in comparison


def test_rb_value_comparison_precedes_put_commit_and_repeats_read_only():
    start = '## Restore and disaster recovery'
    end = '## Verify'
    assert start in BACKUP and end in BACKUP
    restore = ' '.join(BACKUP.split(start, 1)[1].split(end, 1)[0].split())
    steps = (
        '### Bind captured inputs to original evidence',
        '### Derive a separate reconciliation acceptance baseline',
        'Exact captured `operator_rating`, `operator_notes` and `contributed_to_learning` values',
        '#### Compare retained roast values with acknowledgements',
        'tombstone/revision verification BEFORE any PUT',
        "PUT 'file:///secure/roastpilot-backups/",
        '### Rebuild and finish the coordinated target transaction',
        'Repeat the null-safe exact retained roast identity/value comparison alongside those control-state checks against the same independent captured-value expectations.',
        'Only after it succeeds, apply the final coordination floor and zero-quality check before COMMIT',
    )
    offset = 0
    for step in steps:
        offset = position(restore, step, offset) + len(step)
    assert 'before COMMIT roll back target rows; after COMMIT keep the target isolated and unaccepted, with writers disconnected' in restore
    verify = ' '.join(BACKUP.split('## Verify', 1)[1].split('## Ownership summary', 1)[0].split())
    assert 'Repeat the exact retained roast identity/value comparison read-only alongside the tombstone/revision comparisons after restore.' in verify
    assert 'Use the same independent protected captured-value expectations' in verify
    assert 'reject every missing, extra, duplicate, identity, value or NULL mismatch' in verify


def test_rb_wrong_value_rejected_despite_correct_acknowledgements_and_counts():
    start = '#### Compare retained roast values with acknowledgements'
    end = '### Upload and verify only retained artifact files'
    assert start in BACKUP and end in BACKUP
    comparison = ' '.join(BACKUP.split(start, 1)[1].split(end, 1)[0].split())
    assert 'A target with the correct captured revision rows but a different or missing `operator_rating`, `operator_notes` or `contributed_to_learning` value must be rejected, even when counts, shapes, tombstones and revision comparisons pass.' in comparison
    assert 'a lost nullable rating/private note represented by an unexpected NULL' in comparison
    assert 'Matching acknowledgement numbers, counts, valid field types, VARIANT profiles or aggregates alone is insufficient.' in comparison
    assert 'The FOUR data-table count comparisons and TWO supplementary protocol-table counts are all required; none replaces the exact state comparisons.' in comparison
