"""Identity-only staged tombstone DDL text checks; no live-state proof."""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_base_tables_schema import split_columns, strip_line_comments

MIGRATIONS = Path(__file__).resolve().parent.parent / "migrations"
PATH = MIGRATIONS / "V1.3.0__cloud_roast_tombstones.sql"
SQL = strip_line_comments(PATH.read_text(encoding="utf-8"))


def test_tomb1_exact_three_identity_columns():
    assert re.fullmatch(r"\s*use\s+schema\s+app\s*;\s*create\s+table\s+cloud_roast_tombstones\s*\((.*?)\)\s*;\s*", SQL, re.IGNORECASE | re.DOTALL)
    body = re.search(r"\((.*?)\)", SQL, re.DOTALL).group(1)
    assert split_columns(body) == ["cloud_roast_id string not null", "idempotency_key string not null", "public_slug string not null"]


def test_tomb2_no_payload_grant_or_constraint():
    assert re.search(r"\b(grant|revoke|view|procedure|function|stage|sequence|default|primary|unique|foreign|alter|insert|delete)\b", SQL, re.IGNORECASE) is None
    assert len(re.findall(r"\bcreate\b", SQL, re.IGNORECASE)) == 1
    columns = {part.split()[0] for part in split_columns(re.search(r"\((.*?)\)", SQL, re.DOTALL).group(1))}
    assert not columns & {"summary", "operator_notes", "notes", "reviewer_name", "operator_rating", "score", "visibility", "curve", "raw", "created_at", "updated_at", "seq", "ordering"}
    assert not any(name.startswith("bean_") for name in columns)


def test_tomb3_table_only_in_its_migration():
    assert [p.name for p in MIGRATIONS.rglob("*.sql") if "cloud_roast_tombstones" in p.read_text()] == [PATH.name]
