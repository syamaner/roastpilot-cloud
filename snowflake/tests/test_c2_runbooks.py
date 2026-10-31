"""C9-C2 runbook requirements; no live execution."""
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
BACKUP=(ROOT/'docs/runbooks/backup-export.md').read_text()
BOUNDARY=BACKUP.split('## C9-C2 coordinated backup boundary',1)[1].split('## Export procedure',1)[0]
PROD=(ROOT/'docs/runbooks/prod-deploy-runbook.md').read_text()
KEY=(ROOT/'docs/runbooks/key-rotation.md').read_text()


def test_rb_capture_eight_tables():
    for name in ['cloud_roasts','roast_telemetry','roast_artifacts','tasting_reviews','reference_roast_summaries','cloud_sync_coordination','cloud_roast_tombstones','cloud_roast_field_revisions']:
        assert '/tables/'+name+'/' in BACKUP


def test_rb_capture_seq_and_txn_boundary():
    assert 'BEGIN; CALL app.cloud_sync_enter();' in BOUNDARY
    assert 'current_transaction()' in BOUNDARY and 'write_seq' in BOUNDARY and 'S0' in BOUNDARY and 'S1' in BOUNDARY
    assert '**both transaction identifiers and both write_seq values must be equal**' in BOUNDARY
    assert 'rejects the capture' in BOUNDARY and 'ROLLBACK' in BOUNDARY


def test_rb_restore_empty_target_conditions():
    assert 'All seven data tables must contain zero rows' in BOUNDARY
    assert 'exactly one row named `cloud_sync_writer`' in BOUNDARY


def test_rb_restore_no_lock_row_load_and_seq_floor():
    assert 'Never load the captured coordination row.' in BOUNDARY
    assert 'GREATEST(<captured S1>, COALESCE(MAX(accepted_write_seq),0), COALESCE(MAX(deletion_write_seq),0))' in BOUNDARY
    assert 'Do not PUT' in BOUNDARY and 'tombstoned identities' in BOUNDARY


def test_rb_restore_reconciliation_fail_closed():
    for term in ['unreconciled','post-capture deletion/ack state unverified','writers remain disconnected','coordinated target transaction','source capture protocol','reviews, telemetry, artifacts and field revisions','Raise the sequence floor again']:
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
