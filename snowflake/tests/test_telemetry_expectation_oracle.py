"""Behavioural contract for the live verifier's telemetry expectation oracle."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from telemetry_expectation_oracle import fixture_expected_rows, map_source_row  # noqa: E402


ROAST_ID = "01234567-89ab-cdef-0123-456789abcdef"
TELEMETRY = {
    "type": "telemetry",
    "monotonic_seconds": 12.5,
    "bean_temp_c": 145.25,
    "env_temp_c": 176.75,
    "heat_level_percent": 63,
    "fan_level_percent": 42,
    "ror_c_per_min": 7.5,
    "raw": {"ignored": True},
}
EXPECTED = {
    "roast_id": ROAST_ID,
    "elapsed_s": 12.5,
    "bean_temp_c": 145.25,
    "env_temp_c": 176.75,
    "heat_percent": 63,
    "fan_percent": 42,
    "ror_c_per_min": None,
    "raw": None,
}


def test_full_mapping_and_hardcoded_null_columns() -> None:
    mapped = map_source_row(TELEMETRY, ROAST_ID)
    assert mapped == EXPECTED
    assert mapped["ror_c_per_min"] is None
    assert mapped["raw"] is None


@pytest.mark.parametrize("roast_id", [ROAST_ID, "another-roast"])
def test_roast_id_passthrough(roast_id: str) -> None:
    mapped = map_source_row(TELEMETRY, roast_id)
    assert mapped is not None
    assert mapped["roast_id"] == roast_id


def test_telemetry_filter_polarity() -> None:
    assert map_source_row({**TELEMETRY, "type": "event"}, ROAST_ID) is None
    assert map_source_row(TELEMETRY, ROAST_ID) is not None


@pytest.mark.parametrize(
    ("source_key", "output_key"),
    [
        ("monotonic_seconds", "elapsed_s"),
        ("bean_temp_c", "bean_temp_c"),
        ("env_temp_c", "env_temp_c"),
        ("heat_level_percent", "heat_percent"),
        ("fan_level_percent", "fan_percent"),
    ],
)
def test_source_key_wiring(source_key: str, output_key: str) -> None:
    mapped = map_source_row(TELEMETRY, ROAST_ID)
    assert mapped is not None
    assert mapped[output_key] == TELEMETRY[source_key]


@pytest.mark.parametrize(
    ("source_key", "output_key", "missing"),
    [
        ("bean_temp_c", "bean_temp_c", True),
        ("bean_temp_c", "bean_temp_c", False),
        ("monotonic_seconds", "elapsed_s", True),
    ],
)
def test_missing_and_explicit_null_values(
    source_key: str, output_key: str, missing: bool
) -> None:
    source = dict(TELEMETRY)
    if missing:
        del source[source_key]
    else:
        source[source_key] = None
    mapped = map_source_row(source, ROAST_ID)
    assert mapped is not None
    assert mapped[output_key] is None


def test_real_session_one_count_and_first_row() -> None:
    fixture = (
        Path(__file__).resolve().parent.parent
        / "fixtures" / "m1-export" / "session-1" / "roast.jsonl"
    )
    rows = fixture_expected_rows(fixture, ROAST_ID)
    assert len(rows) == 273
    assert rows[0] == {
        "roast_id": ROAST_ID,
        "elapsed_s": 8.32387712498894,
        "bean_temp_c": 24.0,
        "env_temp_c": 24.0,
        "heat_percent": 0,
        "fan_percent": 0,
        "ror_c_per_min": None,
        "raw": None,
    }


def test_mixed_fixture_drops_every_event_and_preserves_telemetry(tmp_path: Path) -> None:
    event = {**TELEMETRY, "type": "event"}
    second = {**TELEMETRY, "monotonic_seconds": 23.75, "bean_temp_c": 151.0}
    source_rows = [event, TELEMETRY, event, second, event]
    fixture = tmp_path / "roast.jsonl"
    fixture.write_text(
        "\n".join(json.dumps(row) for row in source_rows) + "\n", encoding="utf-8"
    )
    rows = fixture_expected_rows(fixture, ROAST_ID)
    assert len(rows) == 2
    assert rows == [EXPECTED, {**EXPECTED, "elapsed_s": 23.75, "bean_temp_c": 151.0}]
