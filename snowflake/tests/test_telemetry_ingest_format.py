"""Text contract for the strict telemetry JSONL file format (issue #416)."""

from __future__ import annotations

import re
from pathlib import Path


MIGRATION = (
    Path(__file__).resolve().parent.parent
    / "migrations"
    / "V1.2.0__telemetry_ingest_format.sql"
).read_text(encoding="utf-8")
STRIPPED = re.sub(r"--[^\n]*(?:\n|$)|/\*.*?\*/", "", MIGRATION, flags=re.DOTALL)


def test_t_scope_is_one_file_format_and_zero_grants() -> None:
    creates = re.findall(r"\bcreate\s+([a-z]+(?:\s+[a-z]+)?)", STRIPPED, re.IGNORECASE)
    assert [item.lower() for item in creates] == ["file format"]
    assert re.search(r"\bgrant\b", STRIPPED, re.IGNORECASE) is None


def test_t_name_is_unquoted_and_schema_precedes_create() -> None:
    use_schema = re.search(r"\buse\s+schema\s+app\s*;", STRIPPED, re.IGNORECASE)
    create = re.search(
        r"\bcreate\s+file\s+format\s+roast_jsonl_format\b",
        STRIPPED,
        re.IGNORECASE,
    )
    assert use_schema is not None and create is not None
    assert use_schema.start() < create.start()
    assert '"roast_jsonl_format"' not in STRIPPED


def test_t_closed_option_set_is_exact() -> None:
    create = re.search(
        r"create\s+file\s+format\s+roast_jsonl_format(?P<body>.*?);",
        STRIPPED,
        re.IGNORECASE | re.DOTALL,
    )
    assert create is not None
    options = {
        key.lower(): value.lower()
        for key, value in re.findall(
            r"^\s*([a-z_]+)\s*=\s*([^\s;]+)\s*$",
            create.group("body"),
            re.IGNORECASE | re.MULTILINE,
        )
    }
    assert options == {"type": "json", "strip_outer_array": "false"}


def test_t_celsius_has_no_fahrenheit_token_or_conversion() -> None:
    assert (
        re.search(
            r"fahrenheit|_f\b|\*\s*9\s*/\s*5|\*\s*1\.8|\+\s*32",
            STRIPPED,
            re.IGNORECASE,
        )
        is None
    )
