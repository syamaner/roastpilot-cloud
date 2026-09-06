"""Fixture-derived telemetry expectations shared by live verification and tests."""

from __future__ import annotations

import json
from pathlib import Path


def map_source_row(row: dict[str, object], roast_id: str) -> dict[str, object] | None:
    """Express the ratified mapping intent; this does not emulate Snowflake."""
    if row.get("type") != "telemetry":
        return None
    return {
        "roast_id": roast_id,
        "elapsed_s": row.get("monotonic_seconds"),
        "bean_temp_c": row.get("bean_temp_c"),
        "env_temp_c": row.get("env_temp_c"),
        "heat_percent": row.get("heat_level_percent"),
        "fan_percent": row.get("fan_level_percent"),
        "ror_c_per_min": None,
        "raw": None,
    }


def fixture_expected_rows(path: Path, roast_id: str) -> list[dict[str, object]]:
    """Derive live-verifier expectations from one real JSONL fixture."""
    # encoding variants (None / "UTF-8") are behaviourally equivalent on the
    # repo's ASCII/UTF-8 fixtures, so the read is pragma'd; json.loads/splitlines
    # below stay mutable.
    text = path.read_text(encoding="utf-8")  # pragma: no mutate
    rows = [json.loads(line) for line in text.splitlines()]
    mapped = [map_source_row(row, roast_id) for row in rows]
    return [row for row in mapped if row is not None]
