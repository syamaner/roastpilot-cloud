"""Fixed C9-C2 SQL contract oracles; not Snowflake execution evidence."""
from pathlib import Path
import re

import pytest

M = Path(__file__).resolve().parent.parent / 'migrations'

def clean(text):
    return re.sub('\'(?:\'\'|[^\'])*\'|"(?:""|[^"])*"|--[^\\n]*|/\\*.*?\\*/', lambda m: '' if m[0].startswith(('--','/*')) else m[0], text, flags=re.S)

def sql(name):
    return clean((M / name).read_text())

def tokens(text):
    return [x if x.startswith(("'", '"')) else x.lower() for x in re.findall('\'(?:\'\'|[^\'])*\'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9]*|[0-9]+|<>|>=|<=|:=|[^\\s]', clean(text))]

def has(text, expected):
    expected_tokens = tokens(expected)
    actual = tokens(text)
    assert any(actual[i:i+len(expected_tokens)] == expected_tokens for i in range(len(actual)-len(expected_tokens)+1)), expected

ENTER = 'R__proc_cloud_sync_enter.sql'
WRITERS = ['upsert_roast','load_roast_telemetry','delete_roast','submit_review']

# Fixed O2 mapping: retained source literals at MB plus contract section1.5.
ERRORS = {
  1: ('slug_not_resolved','Public slug did not resolve uniquely'),
  2: ('invalid_submitted_hash','Submitted hash must be 64 hexadecimal characters'),
  4: ('ambiguous_roast_id','Roast id matched more than one row'),
  5: ('invalid_roast_id','Roast id must be a UUID'),
  6: ('invalid_run_id','Run id contains disallowed characters'),
  7: ('no_telemetry_loaded','No telemetry rows loaded'),
  8: ('invalid_run_id','Run id must be a lowercase UUID'),
  9: ('invalid_payload','Payload does not match the closed roast grammar'),
  10: ('ambiguous_idempotency_key','Idempotency key did not resolve uniquely'),
  11: ('duplicate_public_slug','Public slug is not unique across roasts'),
  12: ('visibility_change_not_supported','Visibility changes are not supported by upsert_roast'),
  14: ('run_roast_mismatch','Run id and roast id do not identify the same roast'),
  17: ('invalid_score','Score must be an integer between 1 and 5'),
  18: ('invalid_slider','Slider values must be between 0 and 100'),
  19: ('coordination_lock_unavailable','Cloud sync coordination lock did not resolve uniquely'),
  20: ('identity_tombstoned','Roast identity is tombstoned'),
  21: ('writer_in_open_transaction','Writer must not run inside an open caller transaction'),
  22: ('coordination_requires_transaction','Coordinated write requires an active transaction'),
  23: ('field_state_invalid','Field revision state is invalid'),
  24: ('roast_not_found','Roast does not exist for this run id'),
  25: ('delete_identity_mismatch','Run id and public slug do not identify one roast or tombstone'),
  26: ('read_consistency_unverified','Account read consistency is not verified GLOBAL'),
  27: ('transaction_scope_changed','Coordinated transaction changed during entry'),
}
PER_PROC = {'cloud_sync_enter': {19,22,26,27},'upsert_roast': {8,9,10,11,12,20,21,23,24},'load_roast_telemetry': {5,6,7,14,20,21},'delete_roast': {4,10,21,25},'submit_review': {1,2,17,18},'recompute_summary':set()}
# submit_review also has the exact shared -20021 refusal.
PER_PROC['submit_review'].add(21)

def assert_error_allocations():
    seen=set()
    for name, expected in PER_PROC.items():
        declarations=re.findall(r"([a-z_]+)\s+exception\s*\(\s*-200([0-9]+)\s*,\s*'([^']*)'\s*\)",sql('R__proc_'+name+'.sql'),re.I)
        numbers=[int(x[1]) for x in declarations]
        assert len(numbers)==len(set(numbers)) and set(numbers)==expected
        for label,number,message in declarations:
            assert (label,int(number) in ERRORS and message)==(ERRORS[int(number)][0],ERRORS[int(number)][1])
            seen.add(int(number))
    assert seen==set(ERRORS) and 13 not in seen


def test_coord01_v140_exact_statements():
    assert tokens(sql('V1.4.0__cloud_sync_coordination.sql')) == tokens(V140_ORACLE)

def test_coord03_enter_exact_body():
    assert tokens(sql(ENTER)) == tokens(ENTER_ORACLE)

def test_coord04_enter_show_account_only_text():
    text=sql(ENTER);has(text,"show parameters like 'READ_CONSISTENCY_MODE' in account;")
    assert 'in session' not in text.lower()

def test_coord05_enter_result_scan_exact_predicate():
    text=sql(ENTER)
    has(text,'''count_if("key" = 'READ_CONSISTENCY_MODE' and "value" = 'GLOBAL' and "level" = 'ACCOUNT')''')
    has(text,'from table(result_scan(:v_show_qid));')
    has(text,'if (coalesce(v_rows, 0) <> 1 or coalesce(v_exact, 0) <> 1) then raise read_consistency_unverified;')
    has(text,'v_show_qid := sqlid;')
    assert len(re.findall('raise read_consistency_unverified;',text))==2

def test_coord06_enter_transaction_id_compared():
    text=sql(ENTER);has(text,'select current_transaction() into :v_txn_after;')
    has(text,'if (v_txn_after is null or v_txn_after <> v_txn_before) then raise transaction_scope_changed;')

def test_coord07_enter_forbidden_constructs():
    assert re.search(r'in\s+session|show\s+locks|show\s+transactions|list\s+@|alter\s+session|begin\s+transaction|\bcommit\s*;|\brollback\s*;|last_query_id|execute\s+immediate',sql(ENTER),re.I) is None

def test_coord08_enter_write_seq_bound():
    has(sql(ENTER),'if (v_write_seq is null or v_write_seq < 0 or v_write_seq > 9007199254740991) then raise coordination_lock_unavailable;')

def test_coord09_enter_ungranted():
    grants=sql('R__z_roles_grants.sql').lower()
    assert not re.search(r'grant[^;]*(?:cloud_sync_enter|cloud_sync_coordination|cloud_roast_field_revisions|cloud_roast_tombstones)',grants)

def test_coord10_acquire_literal_single_site():
    expected="update app.cloud_sync_coordination set write_seq = write_seq + 1 where lock_name = 'cloud_sync_writer';"
    sites=[p.name for p in M.glob('*.sql') for _ in re.finditer(re.escape(expected),clean(p.read_text()))]
    assert sites==[ENTER]

def test_coord11_writer_frame_every_writer():
    for name in WRITERS:
        text=sql('R__proc_'+name+'.sql')
        parts=re.split(r'begin\s+transaction\s*;',text,maxsplit=1,flags=re.I)
        assert len(parts) == 2
        before, after=parts
        has(before,'select current_transaction() into :v_outer_txn;')
        has(before,'if (v_outer_txn is not null) then raise writer_in_open_transaction; end if;')
        assert tokens(after)[:position(tokens(after), ';')+1]==tokens('call app.cloud_sync_enter() into :v_write_seq;')

def test_coord12_no_app_reference_before_begin():
    for name in WRITERS:
        text=sql('R__proc_'+name+'.sql').split('begin transaction;',1)[0]
        assert 'app.' not in text.lower()

def test_coord13_recompute_enters_first_no_txn_control():
    text=sql('R__proc_recompute_summary.sql')
    parts=re.split(r'\bbegin\b',text,maxsplit=1,flags=re.I)
    assert len(parts) == 2
    body=parts[1]
    assert tokens(body)[:position(tokens(body), ';')+1]==tokens('call app.cloud_sync_enter() into :v_enter_seq;')
    assert not re.search(r'begin\s+transaction|\bcommit\s*;|\brollback\s*;',text,re.I)

def test_coord14_error_codes_unique_static_20013_retired():
    assert_error_allocations()

def test_coord15_every_writer_rollback_reraise():
    for name in WRITERS:
        has(sql('R__proc_'+name+'.sql'),'exception when other then rollback; raise;')

ENTER_ORACLE = 'use schema app;\ncreate or replace procedure cloud_sync_enter()\nreturns number(38,0)\nlanguage sql\nexecute as owner\nas\n$$\ndeclare\n  coordination_lock_unavailable exception (-20019, \'Cloud sync coordination lock did not resolve uniquely\');\n  coordination_requires_transaction exception (-20022, \'Coordinated write requires an active transaction\');\n  read_consistency_unverified exception (-20026, \'Account read consistency is not verified GLOBAL\');\n  transaction_scope_changed exception (-20027, \'Coordinated transaction changed during entry\');\n  v_txn_before string;\n  v_txn_after string;\n  v_show_qid string;\n  v_rows integer;\n  v_exact integer;\n  v_write_seq number(38,0);\nbegin\n  select current_transaction() into :v_txn_before;\n  if (v_txn_before is null) then\n    raise coordination_requires_transaction;\n  end if;\n  update app.cloud_sync_coordination set write_seq = write_seq + 1 where lock_name = \'cloud_sync_writer\';\n  if (sqlrowcount <> 1) then\n    raise coordination_lock_unavailable;\n  end if;\n  begin\n    show parameters like \'READ_CONSISTENCY_MODE\' in account;\n    v_show_qid := sqlid;\n    select count(*), count_if("key" = \'READ_CONSISTENCY_MODE\' and "value" = \'GLOBAL\' and "level" = \'ACCOUNT\')\n      into :v_rows, :v_exact\n      from table(result_scan(:v_show_qid));\n  exception\n    when other then\n      raise read_consistency_unverified;\n  end;\n  if (coalesce(v_rows, 0) <> 1 or coalesce(v_exact, 0) <> 1) then\n    raise read_consistency_unverified;\n  end if;\n  select current_transaction() into :v_txn_after;\n  if (v_txn_after is null or v_txn_after <> v_txn_before) then\n    raise transaction_scope_changed;\n  end if;\n  select write_seq into :v_write_seq from app.cloud_sync_coordination where lock_name = \'cloud_sync_writer\';\n  if (v_write_seq is null or v_write_seq < 0 or v_write_seq > 9007199254740991) then\n    raise coordination_lock_unavailable;\n  end if;\n  return v_write_seq;\nend;\n$$;\n'
V140_ORACLE = "use schema app;\ncreate table cloud_sync_coordination (lock_name string not null, write_seq number(38,0) not null);\ninsert into cloud_sync_coordination (lock_name, write_seq) values ('cloud_sync_writer', 0);\nalter table cloud_roast_tombstones add column deletion_write_seq number(38,0);\nalter table cloud_roast_tombstones alter column cloud_roast_id drop not null;\ncreate table cloud_roast_field_revisions (cloud_roast_id string not null, field_name string not null, accepted_revision number(38,0) not null, accepted_write_seq number(38,0) not null);\ninsert into cloud_roast_field_revisions (cloud_roast_id, field_name, accepted_revision, accepted_write_seq) select r.id, f.column1, 0, 0 from cloud_roasts r cross join (values ('operator_rating'), ('operator_notes'), ('contributed_to_learning')) f;\ndrop procedure if exists delete_roast(string);"


def test_lexer_preserves_literal_comment_markers_and_doubled_quotes():
    raw = "select '--', '/*literal*/', 'it''s -- /* text */'; -- actual line\n/* actual block */ select 1;"
    expected = "select '--', '/*literal*/', 'it''s -- /* text */'; \n select 1;"
    assert clean(raw) == expected
    assert clean(clean(raw)) == expected
    assert tokens(raw) == ["select", "'--'", ",", "'/*literal*/'", ",", "'it''s -- /* text */'", ";", "select", "1", ";"]


def test_lexer_comments_cannot_supply_guard_tokens():
    guard = "where idempotency_key = :p_run_id or cloud_roast_id = :p_roast_id;"
    with pytest.raises(AssertionError):
        has("select 1; -- " + guard + "\n/* " + guard + " */", guard)


def test_lexer_literal_markers_do_not_hide_following_tombstone_guard():
    guard = "where idempotency_key = :p_run_id or cloud_roast_id = :p_roast_id;"
    raw = "if (contains(p_run_id, '--')) then raise invalid_run_id; end if; " + guard
    has(raw, guard)
    has(clean(raw), guard)


def test_lexer_missing_tombstone_operand_still_rejected():
    expected = "where idempotency_key = :p_run_id or cloud_roast_id = :p_roast_id;"
    absent = "if (contains(p_run_id, '--')) then raise invalid_run_id; end if; where idempotency_key = :p_run_id; -- or cloud_roast_id = :p_roast_id\n"
    for supplied in (absent, clean(absent)):
        with pytest.raises(AssertionError):
            has(supplied, expected)


def position(text, anchor, start=0):
    """Assert the required anchor before comparing source/list positions."""
    assert anchor in text[start:], f"required position anchor missing: {anchor!r}"
    return text.index(anchor, start)


def test_position_missing_anchor_is_assertion_not_lookup_error():
    with pytest.raises(AssertionError, match='required position anchor missing'):
        position('select 1;', 'raise invalid_payload;')
    with pytest.raises(AssertionError, match='required position anchor missing'):
        position(['BEGIN'], 'COMMIT')


def test_lexer_preserves_complete_double_quoted_identifiers():
    raw = "SELECT \"key\", \"va  lue\", \"level\", \"a\"\"--/*b\"; -- real\n/* real */ SELECT 'it''s';"
    expected = "SELECT \"key\", \"va  lue\", \"level\", \"a\"\"--/*b\"; \n SELECT 'it''s';"
    assert clean(raw) == expected
    assert clean(clean(raw)) == expected
    assert tokens(raw) == ['select', '"key"', ',', '"va  lue"', ',', '"level"', ',', '"a""--/*b"', ';', 'select', "'it''s'", ';']


@pytest.mark.parametrize('column', ['key', 'value', 'level'])
def test_lexer_quoted_column_case_is_significant(column):
    fixed = "count_if(\"key\" = 'READ_CONSISTENCY_MODE' and \"value\" = 'GLOBAL' and \"level\" = 'ACCOUNT')"
    with pytest.raises(AssertionError):
        has(fixed.replace('"' + column + '"', '"' + column.upper() + '"'), fixed)


def test_lexer_missing_guard_with_quoted_comment_marker_rejected():
    with pytest.raises(AssertionError):
        has('select "-- /* ""quoted"" name"; -- raise invalid_payload;\n', 'raise invalid_payload;')
