#!/usr/bin/env python3
"""Operator-run live verification for LOAD_ROAST_TELEMETRY (#416/#419).

This serial-operator-only verifier owns fixed roast, run, stage-prefix, and
reference-summary keys. It self-heals only its enumerated synthetic keys, then
cleans only those keys. The fixture and all synthesized rows are de-identified.
"""
from __future__ import annotations

import json
import os
import re
import sys
from collections.abc import Mapping, Sequence
from decimal import Decimal
from pathlib import Path
from typing import Any, NoReturn, Protocol



RETIRED_MESSAGE = "superseded by the C9-C2 coordinated write protocol; C9-C4 owns live qualification"

SNOWFLAKE_DIR = Path(__file__).resolve().parent
FIXTURES_DIR = (SNOWFLAKE_DIR / "fixtures").resolve()
FIXTURE_PATH = SNOWFLAKE_DIR / "fixtures" / "m1-export" / "session-1" / "roast.jsonl"
ALLOWED_TARGETS = frozenset({"ROASTPILOT_DEV"})
EXPECTED_ROLE = "ROASTPILOT_AGENT"
TEST_RUN_ID = "41900000-0000-0000-0000-000000000001"
TEST_ROAST_ID = "c3c3c3c3-4160-4160-4160-c3c3c3c3c3c3"
SENTINEL_ROAST_ID = "41900000-0000-0000-0000-000000000002"
MISSING_ROAST_ID = "41900000-0000-0000-0000-000000000003"
MIXED_CONSENT_ROAST_ID = "41900000-0000-0000-0000-000000000004"
OPTED_OUT_ROAST_ID = "41900000-0000-0000-0000-000000000005"
CONSENT_FLIP_ROAST_ID = "41900000-0000-0000-0000-000000000006"
MIXED_CONSENT_TRUE_RUN_ID = "41900000-0000-0000-0000-000000000007"
MIXED_CONSENT_FALSE_RUN_ID = "41900000-0000-0000-0000-000000000008"
OPTED_OUT_RUN_ID = "41900000-0000-0000-0000-000000000009"
CONSENT_FLIP_RUN_ID = "41900000-0000-0000-0000-00000000000a"
PUBLIC_SLUG = "419419419ABCDEFGH"
MIXED_CONSENT_TRUE_SLUG = "419419419ABCDEFGI"
MIXED_CONSENT_FALSE_SLUG = "419419419ABCDEFGJ"
OPTED_OUT_SLUG = "419419419ABCDEFGK"
CONSENT_FLIP_SLUG = "419419419ABCDEFGL"
BEAN_ORIGIN = "__C3_S4_419_LIVE_ORIGIN__"
ROAST_LEVEL = "__C3_S4_419_LIVE_LEVEL__"
UUID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
SELECT_COLUMNS = (
    "roast_id",
    "elapsed_s",
    "bean_temp_c",
    "env_temp_c",
    "heat_percent",
    "fan_percent",
    "ror_c_per_min",
    "raw",
)
SUMMARY_COLUMNS = (
    "roast_count",
    "review_count",
    "avg_rating",
    "first_crack_temp_avg_c",
    "first_crack_temp_stddev_c",
    "drop_temp_avg_c",
    "drop_temp_stddev_c",
    "development_percent_avg",
    "first_crack_time_avg_s",
    "total_time_avg_s",
)
SUMMARY = {
    "started_at_utc": "2026-09-02T12:00:00Z",
    "beans_added_at_utc": "2026-09-02T12:00:10Z",
    "first_crack_at_utc": "2026-09-02T12:10:00Z",
    "beans_dropped_at_utc": "2026-09-02T12:20:00Z",
    "development_time_percent": 25.0,
    "total_roast_seconds": 1190.0,
}


class Cursor(Protocol):
    def execute(self, command: str, params: Sequence[object] | None = None) -> Any: ...
    def fetchone(self) -> object: ...
    def fetchall(self) -> Sequence[Sequence[object]]: ...


class Connection(Protocol):
    def cursor(self) -> Cursor: ...
    def close(self) -> None: ...


class TelemetryVerifyError(RuntimeError):
    """Raised when live telemetry differs from the fixture-derived contract."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.cleanup_failures: list[str] = []


def _validated_fixture_uri(fixture_path: Path) -> str:
    """Return a closed, quote-safe URI for the repository fixture tree."""
    resolved = fixture_path.resolve()
    if not resolved.is_relative_to(FIXTURES_DIR) or "'" in str(resolved):
        raise TelemetryVerifyError(f"rejected telemetry fixture path: {fixture_path}")
    return resolved.as_uri()


def _first_value(row: object, label: str) -> object:
    if isinstance(row, Mapping):
        if label in row:
            return row[label]
        folded_label = label.casefold()
        return next(
            (
                value
                for key, value in row.items()
                if isinstance(key, str) and key.casefold() == folded_label
            ),
            None,
        )
    if isinstance(row, Sequence) and not isinstance(row, (str, bytes)) and row:
        return row[0]
    return None


def _row_values(row: object, labels: Sequence[str]) -> tuple[object, ...]:
    if isinstance(row, Mapping):
        missing = object()
        values: list[object] = []
        for label in labels:
            folded_label = label.casefold()
            value = next(
                (
                    item
                    for key, item in row.items()
                    if isinstance(key, str) and key.casefold() == folded_label
                ),
                missing,
            )
            if value is missing:
                raise TelemetryVerifyError("live query returned an incomplete row")
            values.append(value)
        return tuple(values)
    if isinstance(row, Sequence) and not isinstance(row, (str, bytes)):
        if len(row) == len(labels):
            return tuple(row)
    raise TelemetryVerifyError("live query returned an unexpected row shape")


def _count(row: object, label: str = "COUNT(*)") -> int | Decimal:
    value = _first_value(row, label)
    if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
        raise TelemetryVerifyError(f"{label} did not return a numeric count")
    return value


def _payload(contributing: bool, artifact_kinds: Sequence[str]) -> str:
    return json.dumps(
        {
            "public_slug": PUBLIC_SLUG,
            "visibility": "private",
            "bean_origin": BEAN_ORIGIN,
            "bean_varietal": "C3-S4 live verifier",
            "bean_weight_g": 250.0,
            "profile_name": "telemetry consent verification",
            "roast_level": ROAST_LEVEL,
            "operator_rating": 4,
            "operator_notes": None,
            "contributed_to_learning": contributing,
            "roasted_at_utc": "2026-09-02T12:00:00Z",
            "summary": SUMMARY,
            "artifact_kinds": list(artifact_kinds),
        },
        separators=(",", ":"),
    )




def _is_insufficient_privileges_error(exc: BaseException) -> bool:
    """Recognize Snowflake's authorization denial by message or SQL identity."""
    return (
        "insufficient privilege" in str(exc).casefold()
        or getattr(exc, "sqlstate", None) == "42501"
        or getattr(exc, "errno", None) == 3001
    )


def verify_agent_dml_revoked(*_args: object, **_kwargs: object) -> NoReturn:
    """Refuse the retired write instrument before any argument access."""
    raise TelemetryVerifyError(RETIRED_MESSAGE)




def verify_live_load(*_args: object, **_kwargs: object) -> NoReturn:
    """Refuse the retired write instrument before any argument access."""
    raise TelemetryVerifyError(RETIRED_MESSAGE)


def _attach_cleanup_failures(
    failure: TelemetryVerifyError,
    cleanup_errors: Sequence[TelemetryVerifyError],
) -> None:
    for cleanup_error in cleanup_errors:
        message = f"cleanup failed for run id {TEST_RUN_ID}: {cleanup_error}"
        failure.cleanup_failures.append(message)
        failure.add_note(message)


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise TelemetryVerifyError(f"missing required environment variable: {name}")
    return value




def _sanitised_cause(exc: BaseException) -> str:
    try:
        try:
            name = (
                re.sub(r"[^A-Za-z0-9_.]", "", type(exc).__name__)[:64]
                or "UnknownError"
            )
        except BaseException:
            name = "UnknownError"
        parts = [name]
        try:
            from snowflake.connector.errors import Error as _SnowflakeError
        except BaseException:
            _SnowflakeError = ()
        if issubclass(type(exc), _SnowflakeError):
            try:
                # Missing attribute is caught below and becomes the same None.
                errno = getattr(exc, "errno", None)  # pragma: no mutate
            except BaseException:
                # Empty-string mutant fails the exact-int check identically.
                errno = None  # pragma: no mutate
            try:
                # Missing attribute is caught below and becomes the same None.
                sqlstate = getattr(exc, "sqlstate", None)  # pragma: no mutate
            except BaseException:
                # Empty-string mutant fails the five-character check identically.
                sqlstate = None  # pragma: no mutate
            if type(errno) is int and -1_000_000_000 < errno < 1_000_000_000:
                parts.append(f"errno={errno}")
            if type(sqlstate) is str and re.fullmatch(
                r"[A-Za-z0-9]{5}", sqlstate
            ):
                parts.append(f"sqlstate={sqlstate}")
        return " ".join(parts)
    except BaseException:
        return "UnknownError"


def _print_failure(failure: TelemetryVerifyError) -> None:
    print(f"telemetry verification failed: {failure}", file=sys.stderr)
    if failure.__cause__ is not None:
        print(f"root cause: {_sanitised_cause(failure.__cause__)}", file=sys.stderr)
    for cleanup_failure in failure.cleanup_failures:
        print(cleanup_failure, file=sys.stderr)


def main(argv: Sequence[str] | None = None) -> int:
    """Refuse the retired write instrument without inspecting arguments."""
    print(RETIRED_MESSAGE, file=sys.stderr)
    return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
