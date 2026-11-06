#!/usr/bin/env python3
"""Operator-run live verification for UPSERT_ROAST (issue #417).

Only JSONL and summary fixtures are staged; no roast.csv exists. ``bean_origin``
and ``roast_level`` are deliberately null so recompute returns through its
null-grouping-key branch. Populating them would write a shared reference-summary
row this verifier cannot safely clean up, so AC-3's recompute write path is
deliberately not exercised live here. The procedure source establishes its
write-then-rollback ordering; this run observes only rejection with no net
visibility, notes, or timestamp change.

Snowflake's exact ``LIST`` name-column prefix spelling for this
schema-qualified internal stage remains a live-gate-only unknown; verification
therefore anchors on the case-insensitive run-id path segment.

The connection explicitly pins autocommit rather than inheriting an account or
user setting, so direct telemetry setup and every ordered cleanup statement are
persisted when the session closes.

This is a serial-operator-only instrument. Its ownership checks are
point-in-time reads; concurrent invocations using the fixed ``TEST_RUN_ID`` can
pass together and one invocation's cleanup can remove the other's live state.
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
FIXTURE_PATHS = (
    SNOWFLAKE_DIR / "fixtures" / "m1-export" / "session-1" / "roast.jsonl",
    SNOWFLAKE_DIR / "fixtures" / "m1-export" / "session-1" / "summary.json",
)
ALLOWED_TARGETS = frozenset({"ROASTPILOT_DEV"})
EXPECTED_ROLE = "ROASTPILOT_AGENT"
TEST_RUN_ID = "01234567-89ab-cdef-0123-456789abcdef"
OTHER_ROAST_ID = "41700000-0000-0000-0000-000000000001"
RUN_ID_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
ARTIFACT_KINDS = ("jsonl", "csv", "summary")
ARTIFACT_BASENAMES = {
    "jsonl": "roast.jsonl",
    "csv": "roast.csv",
    "summary": "summary.json",
}
PUBLIC_SLUG = "123456789ABCDEFGH"
REPLAY_SLUG = "HGFEDCBA987654321"
ORIGINAL_NOTES = "issue 417 live verifier"
ROLLBACK_NOTES = "this update must roll back"
PRESERVED_COLUMNS = (
    "ID",
    "IDEMPOTENCY_KEY",
    "OWNER_ID",
    "PUBLIC_SLUG",
    "VISIBILITY",
    "CREATED_AT",
    "UPDATED_AT",
)


class Cursor(Protocol):
    def execute(self, command: str, params: Sequence[object] | None = None) -> Any: ...
    def fetchone(self) -> object: ...
    def fetchall(self) -> Sequence[Sequence[object]]: ...


class Connection(Protocol):
    def cursor(self) -> Cursor: ...
    def close(self) -> None: ...


class UpsertRoastVerifyError(RuntimeError):
    """Raised when live upsert behavior differs from the ratified contract."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.cleanup_failures: list[str] = []
        self.resolved_roast_id: object | None = None
        self.cleanup_unsafe = False


def _validated_fixture_uri(fixture_path: Path) -> str:
    """Return a closed, quote-safe URI for the repository fixture tree."""
    resolved = fixture_path.resolve()
    if not resolved.is_relative_to(FIXTURES_DIR) or "'" in str(resolved):
        raise UpsertRoastVerifyError("rejected upsert fixture path")
    # Path.as_uri(), not the apostrophe pre-check, closes the PUT literal: it
    # percent-encodes every path byte outside the RFC 3986 unreserved set.
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
        values: list[object] = []
        missing = object()
        for label in labels:
            if label in row:
                values.append(row[label])
                continue
            folded_label = label.casefold()
            matching_value = next(
                (
                    value
                    for key, value in row.items()
                    if isinstance(key, str) and key.casefold() == folded_label
                ),
                missing,
            )
            if matching_value is missing:
                raise UpsertRoastVerifyError("live query returned an incomplete row")
            values.append(matching_value)
        return tuple(values)
    if isinstance(row, Sequence) and not isinstance(row, (str, bytes)):
        if len(row) == len(labels):
            return tuple(row)
    raise UpsertRoastVerifyError("live query returned an unexpected row shape")


def _variant_object(value: object) -> dict[str, object]:
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except json.JSONDecodeError:
            raise UpsertRoastVerifyError(
                "upsert_roast returned invalid JSON"
            ) from None
    if not isinstance(value, Mapping):
        raise UpsertRoastVerifyError("upsert_roast did not return an object")
    result = dict(value)
    if set(result) != {"cloud_roast_id", "public_slug"}:
        raise UpsertRoastVerifyError("upsert_roast returned an unexpected object")
    return result


def _count(row: object, label: str) -> int | Decimal:
    value = _first_value(row, label)
    if isinstance(value, bool) or not isinstance(value, (int, Decimal)):
        raise UpsertRoastVerifyError(f"{label} did not return a numeric count")
    return value


def _stored_pair(
    row: object,
    labels: tuple[str, str] = ("ID", "PUBLIC_SLUG"),
) -> tuple[object, object]:
    values = _row_values(row, labels)
    return values[0], values[1]


def _payload() -> dict[str, object]:
    return {
        "public_slug": PUBLIC_SLUG,
        "visibility": "private",
        "bean_origin": None,
        "bean_varietal": "C3-S2 verifier",
        "bean_weight_g": 250.0,
        "profile_name": "live verification",
        "roast_level": None,
        "operator_rating": 4,
        "operator_notes": ORIGINAL_NOTES,
        "contributed_to_learning": True,
        "roasted_at_utc": "2026-09-02T12:00:00Z",
        "summary": {},
        "artifact_kinds": list(ARTIFACT_KINDS),
    }








def _encoded_payload(payload: Mapping[str, object]) -> str:
    try:
        return json.dumps(payload, separators=(",", ":"))
    except BaseException as exc:
        raise UpsertRoastVerifyError("payload encoding failed") from exc




def _is_visibility_error(exc: BaseException) -> bool:
    message = str(exc).lower()
    return "-20012" in message or "visibility_change_not_supported" in message


def _is_invalid_payload_error(exc: BaseException) -> bool:
    message = str(exc).lower()
    return "-20009" in message or "invalid_payload" in message


























def _attach_cleanup_failures(
    failure: UpsertRoastVerifyError,
    cleanup_errors: Sequence[UpsertRoastVerifyError],
    resolved_roast_id: object | None = None,
) -> None:
    failure.resolved_roast_id = resolved_roast_id
    for cleanup_error in cleanup_errors:
        message = f"cleanup failed for run id {TEST_RUN_ID}: {cleanup_error}"
        if resolved_roast_id is not None:
            message += f"; diagnostic cloud_roast_id={resolved_roast_id}"
        failure.cleanup_failures.append(message)
        failure.add_note(message)


def verify_live_upsert(*_args: object, **_kwargs: object) -> NoReturn:
    """Refuse the retired write instrument before any argument access."""
    raise UpsertRoastVerifyError(RETIRED_MESSAGE)


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise UpsertRoastVerifyError(f"missing required environment variable: {name}")
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


def _print_failure(failure: UpsertRoastVerifyError) -> None:
    print(f"upsert verification failed: {failure}", file=sys.stderr)
    if failure.__cause__ is not None:
        print(f"root cause: {_sanitised_cause(failure.__cause__)}", file=sys.stderr)
    for cleanup_failure in failure.cleanup_failures:
        print(cleanup_failure, file=sys.stderr)


def main(argv: Sequence[str] | None = None) -> int:
    """Refuse the retired write instrument without inspecting arguments."""
    print(RETIRED_MESSAGE, file=sys.stderr)
    return 1


if __name__ == "__main__":  # pragma: no cover - script entry point
    raise SystemExit(main())
