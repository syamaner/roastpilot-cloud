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

import argparse
import json
import os
import re
import sys
from collections.abc import Mapping, Sequence
from decimal import Decimal
from pathlib import Path
from typing import Any, Protocol


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


def _execute(
    cursor: Cursor,
    command: str,
    params: Sequence[object] | None,
    step: str,
) -> None:
    try:
        if params is None:
            cursor.execute(command)
        else:
            cursor.execute(command, params)
    except UpsertRoastVerifyError:
        raise
    except BaseException as exc:
        raise UpsertRoastVerifyError(f"{step} failed") from exc


def _fetchone(
    cursor: Cursor,
    command: str,
    params: Sequence[object] | None,
    step: str,
) -> object:
    _execute(cursor, command, params, step)
    try:
        return cursor.fetchone()
    except UpsertRoastVerifyError:
        raise
    except BaseException as exc:
        raise UpsertRoastVerifyError(f"{step} failed") from exc


def _fetchall(
    cursor: Cursor,
    command: str,
    params: Sequence[object] | None,
    step: str,
) -> Sequence[Sequence[object]]:
    _execute(cursor, command, params, step)
    try:
        return cursor.fetchall()
    except UpsertRoastVerifyError:
        raise
    except BaseException as exc:
        raise UpsertRoastVerifyError(f"{step} failed") from exc


def _encoded_payload(payload: Mapping[str, object]) -> str:
    try:
        return json.dumps(payload, separators=(",", ":"))
    except BaseException as exc:
        raise UpsertRoastVerifyError("payload encoding failed") from exc


def _call_upsert(cursor: Cursor, payload: Mapping[str, object]) -> dict[str, object]:
    row = _fetchone(
        cursor,
        "CALL app.upsert_roast(%s, %s)",
        (TEST_RUN_ID, _encoded_payload(payload)),
        "upsert call",
    )
    return _variant_object(_first_value(row, "UPSERT_ROAST"))


def _is_visibility_error(exc: BaseException) -> bool:
    message = str(exc).lower()
    return "-20012" in message or "visibility_change_not_supported" in message


def _call_expect_visibility_error(
    cursor: Cursor,
    payload: Mapping[str, object],
) -> None:
    try:
        cursor.execute(
            "CALL app.upsert_roast(%s, %s)",
            (TEST_RUN_ID, _encoded_payload(payload)),
        )
        cursor.fetchone()
    except BaseException as exc:
        if _is_visibility_error(exc):
            return
        raise UpsertRoastVerifyError(
            "visibility replay failed with an unexpected error"
        ) from exc
    raise UpsertRoastVerifyError("visibility replay unexpectedly succeeded")


def _cleanup_statement(
    cursor: Cursor,
    command: str,
    params: Sequence[object] | None,
    step: str,
    errors: list[UpsertRoastVerifyError],
) -> bool:
    try:
        _execute(cursor, command, params, step)
        return True
    except UpsertRoastVerifyError as exc:
        errors.append(exc)
        return False


def _preflight(connection: Connection, expected_target: str) -> Cursor:
    """Validate the target and identity before permitting any live write."""
    if expected_target not in ALLOWED_TARGETS:
        raise UpsertRoastVerifyError(f"rejected upsert target: {expected_target!r}")
    if RUN_ID_PATTERN.fullmatch(TEST_RUN_ID) is None:
        raise UpsertRoastVerifyError("TEST_RUN_ID is not a lowercase UUID")
    try:
        cursor = connection.cursor()
    except UpsertRoastVerifyError:
        raise
    except BaseException as exc:
        raise UpsertRoastVerifyError("Snowflake cursor setup failed") from exc
    _execute(cursor, "USE SECONDARY ROLES NONE", None, "secondary-role hardening")
    database_row = _fetchone(
        cursor, "SELECT CURRENT_DATABASE()", None, "database assertion"
    )
    if _first_value(database_row, "CURRENT_DATABASE()") != expected_target:
        raise UpsertRoastVerifyError("connected database does not match target")
    role_row = _fetchone(cursor, "SELECT CURRENT_ROLE()", None, "role assertion")
    if _first_value(role_row, "CURRENT_ROLE()") != EXPECTED_ROLE:
        raise UpsertRoastVerifyError("connected role is not ROASTPILOT_AGENT")
    existing_run_row = _fetchone(
        cursor,
        "SELECT COUNT(*) FROM app.cloud_roasts WHERE idempotency_key = %s",
        (TEST_RUN_ID,),
        "test run ownership query",
    )
    if _count(existing_run_row, "COUNT(*)") != 0:
        raise UpsertRoastVerifyError("test run id is already owned")
    sentinel_owner_row = _fetchone(
        cursor,
        "SELECT COUNT(*) FROM app.cloud_roasts WHERE id = %s",
        (OTHER_ROAST_ID,),
        "sentinel ownership query",
    )
    if _count(sentinel_owner_row, "COUNT(*)") != 0:
        raise UpsertRoastVerifyError("sentinel roast id is already owned")
    sentinel_telemetry_row = _fetchone(
        cursor,
        "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
        (OTHER_ROAST_ID,),
        "sentinel telemetry ownership query",
    )
    if _count(sentinel_telemetry_row, "COUNT(*)") != 0:
        raise UpsertRoastVerifyError(
            f"sentinel telemetry id is already owned: {OTHER_ROAST_ID}"
        )
    stage_prefix = f"@app.roast_artifacts/{TEST_RUN_ID}/"
    existing_stage_rows = _fetchall(
        cursor,
        f"LIST {stage_prefix}",
        None,
        "test stage ownership query",
    )
    if existing_stage_rows:
        raise UpsertRoastVerifyError(
            f"test stage prefix contains {len(existing_stage_rows)} existing file(s): "
            f"{stage_prefix}"
        )
    return cursor


def _stage_and_verify_fixtures(cursor: Cursor) -> None:
    """PUT the two available fixtures and verify their exact recursive LIST."""
    staged_names = {path.name for path in FIXTURE_PATHS}
    if not staged_names <= set(ARTIFACT_BASENAMES.values()):
        raise UpsertRoastVerifyError(
            "staged fixture names are outside artifact grammar"
        )
    for fixture_path in FIXTURE_PATHS:
        _execute(
            cursor,
            f"PUT '{_validated_fixture_uri(fixture_path)}' "
            f"@app.roast_artifacts/{TEST_RUN_ID}/ "
            "AUTO_COMPRESS=FALSE OVERWRITE=TRUE",
            None,
            "staging fixture PUT",
        )
    listed_rows = _fetchall(
        cursor,
        f"LIST @app.roast_artifacts/{TEST_RUN_ID}/",
        None,
        "staging fixture LIST",
    )
    listed_names: set[str] = set()
    for row in listed_rows:
        listed_path = str(_first_value(row, "name"))
        path_segments = listed_path.split("/")
        run_index = next(
            (
                index
                for index, segment in enumerate(path_segments)
                if segment.casefold() == TEST_RUN_ID.casefold()
            ),
            None,
        )
        if run_index is None:
            raise UpsertRoastVerifyError("staged fixture LIST has an invalid prefix")
        relative_segments = path_segments[run_index + 1 :]
        if len(relative_segments) != 1 or not relative_segments[0]:
            raise UpsertRoastVerifyError("staged fixture LIST contains a nested path")
        relative_name = relative_segments[0]
        listed_names.add(relative_name)
    if any(name.lower().endswith(".gz") for name in listed_names):
        raise UpsertRoastVerifyError("staged fixture LIST contains a compressed file")
    if listed_names != staged_names:
        raise UpsertRoastVerifyError("staged fixture LIST is not exact")


def _verify_replay_idempotency(
    cursor: Cursor,
) -> tuple[dict[str, object], dict[str, object], object, tuple[object, ...]]:
    """Verify identical calls return equally and leave one roast."""
    payload = _payload()
    first = _call_upsert(cursor, payload)
    owned_roast_id = None
    try:
        preserved_select = (
            "SELECT id, idempotency_key, owner_id, public_slug, visibility, "
            "created_at, updated_at FROM app.cloud_roasts "
            "WHERE idempotency_key = %s"
        )
        first_call_baseline = _row_values(
            _fetchone(
                cursor,
                preserved_select,
                (TEST_RUN_ID,),
                "first-call preserved-column query",
            ),
            PRESERVED_COLUMNS,
        )
        second = _call_upsert(cursor, payload)
        roast_count_row = _fetchone(
            cursor,
            "SELECT COUNT(*) FROM app.cloud_roasts WHERE idempotency_key = %s",
            (TEST_RUN_ID,),
            "roast count query",
        )
        # Defence in depth: independently re-assert the procedure's own
        # ambiguous_idempotency_key guard as part of AC-4's live evidence.
        if _count(roast_count_row, "COUNT(*)") != 1:
            ambiguous_error = UpsertRoastVerifyError(
                "replay did not leave exactly one roast"
            )
            ambiguous_error.cleanup_unsafe = True
            try:
                roast_id_rows = _fetchall(
                    cursor,
                    "SELECT id FROM app.cloud_roasts WHERE idempotency_key = %s",
                    (TEST_RUN_ID,),
                    "ambiguous replay id query",
                )
            except BaseException as exc:
                setattr(exc, "cleanup_unsafe", ambiguous_error.cleanup_unsafe)
                raise
            roast_ids = [str(_first_value(row, "ID")) for row in roast_id_rows]
            recorded_ids = ", ".join(roast_ids) if roast_ids else "none returned"
            ambiguous_error.args = (
                "replay did not leave exactly one roast; "
                f"ids for run id {TEST_RUN_ID}: {recorded_ids}",
            )
            raise ambiguous_error
        if second != first:
            raise UpsertRoastVerifyError(
                "identical replay returned a different object"
            )
        owned_roast_id = _row_values(
            _fetchone(
                cursor,
                "SELECT id FROM app.cloud_roasts WHERE idempotency_key = %s",
                (TEST_RUN_ID,),
                "owned roast id query",
            ),
            ("ID",),
        )[0]
        owned_id_count_row = _fetchone(
            cursor,
            "SELECT COUNT(*) FROM app.cloud_roasts WHERE id = %s",
            (owned_roast_id,),
            "owned roast id uniqueness query",
        )
        if _count(owned_id_count_row, "COUNT(*)") != 1:
            collision_error = UpsertRoastVerifyError(
                f"owned roast id {owned_roast_id} is not unique for run id "
                f"{TEST_RUN_ID}; cleanup was not attempted"
            )
            collision_error.cleanup_unsafe = True
            raise collision_error
        identical_replay_state = _row_values(
            _fetchone(
                cursor,
                preserved_select,
                (TEST_RUN_ID,),
                "identical replay preserved-column query",
            ),
            PRESERVED_COLUMNS,
        )
        if identical_replay_state[:6] != first_call_baseline[:6]:
            raise UpsertRoastVerifyError(
                "identical replay changed a preserved column"
            )
        try:
            identical_updated_non_decreasing = (
                identical_replay_state[6] >= first_call_baseline[6]
            )
        except TypeError:
            identical_updated_non_decreasing = False
        if not identical_updated_non_decreasing:
            raise UpsertRoastVerifyError(
                "identical replay did not preserve non-decreasing updated_at"
            )
    except BaseException as exc:
        # Preserve the procedure return for diagnostics only. Cleanup is
        # steered exclusively by the id read through the owned run key above.
        setattr(exc, "resolved_roast_id", first["cloud_roast_id"])
        if owned_roast_id is not None:
            setattr(exc, "cleanup_roast_id", owned_roast_id)
        raise
    return payload, first, owned_roast_id, first_call_baseline


def _verify_artifact_manifest(cursor: Cursor, resolved_roast_id: object) -> None:
    """Verify the exact closed kind and stored-stage-path pair set."""
    expected_artifacts = {
        (kind, f"@app.roast_artifacts/{TEST_RUN_ID}/{basename}")
        for kind, basename in ARTIFACT_BASENAMES.items()
    }
    artifact_count_row = _fetchone(
        cursor,
        "SELECT COUNT(*) FROM app.roast_artifacts WHERE roast_id = %s",
        (resolved_roast_id,),
        "artifact count query",
    )
    if _count(artifact_count_row, "COUNT(*)") != len(ARTIFACT_KINDS):
        raise UpsertRoastVerifyError("artifact count does not match manifest")
    artifact_rows = _fetchall(
        cursor,
        "SELECT kind, stage_path FROM app.roast_artifacts WHERE roast_id = %s",
        (resolved_roast_id,),
        "artifact query",
    )
    actual_artifacts = {
        _stored_pair(row, ("KIND", "STAGE_PATH")) for row in artifact_rows
    }
    if actual_artifacts != expected_artifacts:
        raise UpsertRoastVerifyError(
            "artifact kind and stage_path pairs do not match"
        )


def _verify_preserved_columns(
    cursor: Cursor,
    payload: Mapping[str, object],
    first: Mapping[str, object],
    before: tuple[object, ...],
) -> tuple[object, ...]:
    """Verify slug replay preservation and return its stored row."""
    preserved_select = (
        "SELECT id, idempotency_key, owner_id, public_slug, visibility, "
        "created_at, updated_at FROM app.cloud_roasts WHERE idempotency_key = %s"
    )
    if (
        first["public_slug"] != payload["public_slug"]
        or before[3] != payload["public_slug"]
    ):
        raise UpsertRoastVerifyError("first call substituted the requested slug")
    if _stored_pair((before[0], before[3])) != (
        first["cloud_roast_id"],
        first["public_slug"],
    ):
        raise UpsertRoastVerifyError("stored id and slug do not match first return")

    slug_payload = dict(payload)
    slug_payload["public_slug"] = REPLAY_SLUG
    slug_result = _call_upsert(cursor, slug_payload)
    if slug_result != first:
        raise UpsertRoastVerifyError(
            "divergent-slug replay returned a different object"
        )
    after = _row_values(
        _fetchone(
            cursor,
            preserved_select,
            (TEST_RUN_ID,),
            "post-replay preserved-column query",
        ),
        PRESERVED_COLUMNS,
    )
    if before[:6] != after[:6]:
        raise UpsertRoastVerifyError("slug replay changed a preserved column")
    try:
        updated_advanced = after[6] > before[6]
    except TypeError:
        updated_advanced = False
    if not updated_advanced:
        raise UpsertRoastVerifyError("slug replay did not advance updated_at")
    return after


def _verify_visibility_rollback(
    cursor: Cursor,
    payload: Mapping[str, object],
    expected_updated_at: object,
) -> None:
    """Verify visibility change rejection leaves no observable net change."""
    visibility_payload = dict(payload)
    visibility_payload["visibility"] = "unlisted"
    visibility_payload["operator_notes"] = ROLLBACK_NOTES
    _call_expect_visibility_error(cursor, visibility_payload)
    visibility_state = _row_values(
        _fetchone(
            cursor,
            "SELECT visibility, operator_notes, updated_at FROM app.cloud_roasts "
            "WHERE idempotency_key = %s",
            (TEST_RUN_ID,),
            "visibility no-net-change query",
        ),
        ("VISIBILITY", "OPERATOR_NOTES", "UPDATED_AT"),
    )
    if visibility_state[0] != payload["visibility"]:
        raise UpsertRoastVerifyError("failed visibility replay changed stored value")
    if visibility_state[1] != payload["operator_notes"]:
        raise UpsertRoastVerifyError(
            "failed visibility replay changed operator_notes"
        )
    if visibility_state[2] != expected_updated_at:
        raise UpsertRoastVerifyError("failed visibility replay changed updated_at")


def _verify_telemetry_purge_scope(
    cursor: Cursor,
    payload: Mapping[str, object],
    first: Mapping[str, object],
    owned_roast_id: object,
    preserved_state: tuple[object, ...],
) -> None:
    """Verify purge is conditional, effective, and scoped to this roast."""
    resolved_roast_id = first["cloud_roast_id"]
    _execute(
        cursor,
        "INSERT INTO app.roast_telemetry "
        "(roast_id, elapsed_s, bean_temp_c, env_temp_c, heat_percent, "
        "fan_percent, ror_c_per_min, raw) "
        "SELECT %s, 0, 20, 21, 80, 30, NULL, PARSE_JSON('{}') UNION ALL "
        "SELECT %s, 5, 22, 23, 75, 35, 24, PARSE_JSON('{}') UNION ALL "
        "SELECT %s, 0, 20, 21, 80, 30, NULL, PARSE_JSON('{}')",
        (resolved_roast_id, resolved_roast_id, OTHER_ROAST_ID),
        "telemetry setup insert",
    )
    telemetry_setup_row = _fetchone(
        cursor,
        "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
        (resolved_roast_id,),
        "telemetry setup query",
    )
    if _count(telemetry_setup_row, "COUNT(*)") != 2:
        raise UpsertRoastVerifyError("telemetry setup did not insert two roast rows")

    control_result = _call_upsert(cursor, payload)
    if control_result != first:
        raise UpsertRoastVerifyError(
            "contributing replay returned a different object"
        )
    control_roast_count_row = _fetchone(
        cursor,
        "SELECT COUNT(*) FROM app.cloud_roasts WHERE idempotency_key = %s",
        (TEST_RUN_ID,),
        "contributing replay roast count query",
    )
    if _count(control_roast_count_row, "COUNT(*)") != 1:
        ambiguous_error = UpsertRoastVerifyError(
            "contributing replay changed the roast count"
        )
        ambiguous_error.cleanup_unsafe = True
        raise ambiguous_error
    control_count_row = _fetchone(
        cursor,
        "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
        (resolved_roast_id,),
        "contributing replay telemetry query",
    )
    if _count(control_count_row, "COUNT(*)") != 2:
        raise UpsertRoastVerifyError(
            "contributing replay unexpectedly purged telemetry"
        )
    control_preserved_state = _row_values(
        _fetchone(
            cursor,
            "SELECT id, idempotency_key, owner_id, public_slug, visibility, "
            "created_at, updated_at FROM app.cloud_roasts "
            "WHERE idempotency_key = %s",
            (TEST_RUN_ID,),
            "contributing replay preserved-column query",
        ),
        PRESERVED_COLUMNS,
    )
    if control_preserved_state[:6] != preserved_state[:6]:
        raise UpsertRoastVerifyError(
            "contributing replay changed a preserved column"
        )
    try:
        control_updated_non_decreasing = (
            control_preserved_state[6] >= preserved_state[6]
        )
    except TypeError:
        control_updated_non_decreasing = False
    if not control_updated_non_decreasing:
        raise UpsertRoastVerifyError(
            "contributing replay did not preserve non-decreasing updated_at"
        )
    pre_opt_out_updated_at = control_preserved_state[6]

    opt_out_payload = dict(payload)
    opt_out_payload["contributed_to_learning"] = False
    opt_out_payload["artifact_kinds"] = []
    opt_out_result = _call_upsert(cursor, opt_out_payload)
    if opt_out_result != first:
        raise UpsertRoastVerifyError("opt-out replay returned a different object")
    purged_count_row = _fetchone(
        cursor,
        "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
        (resolved_roast_id,),
        "opt-out telemetry query",
    )
    if _count(purged_count_row, "COUNT(*)") != 0:
        raise UpsertRoastVerifyError("opt-out replay did not purge telemetry")
    sentinel_after_row = _fetchone(
        cursor,
        "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
        (OTHER_ROAST_ID,),
        "sentinel result query",
    )
    sentinel_after = _count(sentinel_after_row, "COUNT(*)")
    if sentinel_after != 1:
        raise UpsertRoastVerifyError(
            "opt-out replay did not preserve one unrelated telemetry row"
        )
    final_roast_count_row = _fetchone(
        cursor,
        "SELECT COUNT(*) FROM app.cloud_roasts WHERE idempotency_key = %s",
        (TEST_RUN_ID,),
        "opt-out replay roast count query",
    )
    if _count(final_roast_count_row, "COUNT(*)") != 1:
        ambiguous_error = UpsertRoastVerifyError(
            "opt-out replay changed the roast count"
        )
        ambiguous_error.cleanup_unsafe = True
        raise ambiguous_error
    final_preserved_state = _row_values(
        _fetchone(
            cursor,
            "SELECT id, idempotency_key, owner_id, public_slug, visibility, "
            "created_at, updated_at FROM app.cloud_roasts "
            "WHERE idempotency_key = %s",
            (TEST_RUN_ID,),
            "opt-out replay preserved-column query",
        ),
        PRESERVED_COLUMNS,
    )
    if final_preserved_state[:6] != preserved_state[:6]:
        raise UpsertRoastVerifyError("opt-out replay changed a preserved column")
    try:
        final_updated_advanced = final_preserved_state[6] > pre_opt_out_updated_at
    except TypeError:
        final_updated_advanced = False
    if not final_updated_advanced:
        raise UpsertRoastVerifyError(
            "opt-out replay did not advance updated_at"
        )
    final_artifact_count_row = _fetchone(
        cursor,
        "SELECT COUNT(*) FROM app.roast_artifacts WHERE roast_id = %s",
        (owned_roast_id,),
        "opt-out replay artifact count query",
    )
    if _count(final_artifact_count_row, "COUNT(*)") != 0:
        raise UpsertRoastVerifyError(
            "opt-out replay did not clear the artifact manifest"
        )


def _cleanup_all(
    cursor: Cursor,
    resolved_roast_id: object | None,
) -> list[UpsertRoastVerifyError]:
    """Revalidate identity, then attempt every ordered cleanup action."""
    cleanup_errors: list[UpsertRoastVerifyError] = []
    try:
        cleanup_identity_rows = _fetchall(
            cursor,
            "SELECT id FROM app.cloud_roasts WHERE idempotency_key = %s",
            (TEST_RUN_ID,),
            "cleanup identity query",
        )
        cleanup_roast_ids = [
            _first_value(row, "ID") for row in cleanup_identity_rows
        ]
    except BaseException as exc:
        if isinstance(exc, UpsertRoastVerifyError):
            identity_error = exc
            identity_error.args = (
                "cleanup identity revalidation failed "
                f"[idempotency_key={TEST_RUN_ID}; observed_ids=unknown]",
            )
        else:
            identity_error = UpsertRoastVerifyError(
                "cleanup identity revalidation failed "
                f"[idempotency_key={TEST_RUN_ID}; observed_ids=unknown]"
            )
            identity_error.__cause__ = exc
        identity_error.cleanup_unsafe = True
        cleanup_errors.append(identity_error)
        return cleanup_errors
    if (
        len(cleanup_roast_ids) != 1
        or resolved_roast_id is None
        or cleanup_roast_ids[0] != resolved_roast_id
    ):
        observed_ids = ", ".join(str(roast_id) for roast_id in cleanup_roast_ids)
        if not observed_ids:
            observed_ids = "none"
        identity_error = UpsertRoastVerifyError(
            "cleanup identity is not uniquely verified "
            f"[idempotency_key={TEST_RUN_ID}; carried_id={resolved_roast_id}; "
            f"observed_ids={observed_ids}]"
        )
        identity_error.cleanup_unsafe = True
        cleanup_errors.append(identity_error)
        return cleanup_errors
    try:
        cleanup_id_count_row = _fetchone(
            cursor,
            "SELECT COUNT(*) FROM app.cloud_roasts WHERE id = %s",
            (resolved_roast_id,),
            "cleanup roast id uniqueness query",
        )
        cleanup_id_count = _count(cleanup_id_count_row, "COUNT(*)")
    except BaseException as exc:
        uniqueness_error = UpsertRoastVerifyError(
            "cleanup roast id uniqueness revalidation failed "
            f"[idempotency_key={TEST_RUN_ID}; resolved_roast_id={resolved_roast_id}]"
        )
        uniqueness_error.__cause__ = exc
        uniqueness_error.cleanup_unsafe = True
        cleanup_errors.append(uniqueness_error)
        return cleanup_errors
    if cleanup_id_count != 1:
        uniqueness_error = UpsertRoastVerifyError(
            "cleanup roast id is not globally unique "
            f"[idempotency_key={TEST_RUN_ID}; resolved_roast_id={resolved_roast_id}]"
        )
        uniqueness_error.cleanup_unsafe = True
        cleanup_errors.append(uniqueness_error)
        return cleanup_errors
    if resolved_roast_id is None:
        child_where = (
            "roast_id IN (SELECT id FROM app.cloud_roasts "
            "WHERE idempotency_key = %s)"
        )
        child_params: tuple[object, ...] = (TEST_RUN_ID,)
        child_address = f"idempotency_key={TEST_RUN_ID}"
    else:
        child_where = (
            "(roast_id = %s OR roast_id IN (SELECT id FROM app.cloud_roasts "
            "WHERE idempotency_key = %s))"
        )
        child_params = (resolved_roast_id, TEST_RUN_ID)
        child_address = (
            f"roast_id={resolved_roast_id} OR idempotency_key={TEST_RUN_ID}"
        )
    stage_prefix = f"@app.roast_artifacts/{TEST_RUN_ID}/"

    _cleanup_statement(
        cursor,
        f"DELETE FROM app.roast_artifacts WHERE {child_where}",
        child_params,
        f"artifact cleanup [{child_address}]",
        cleanup_errors,
    )
    _cleanup_statement(
        cursor,
        f"DELETE FROM app.roast_telemetry WHERE {child_where}",
        child_params,
        f"roast telemetry cleanup [{child_address}]",
        cleanup_errors,
    )
    _cleanup_statement(
        cursor,
        "DELETE FROM app.roast_telemetry WHERE roast_id = %s",
        (OTHER_ROAST_ID,),
        f"sentinel telemetry cleanup [roast_id={OTHER_ROAST_ID}]",
        cleanup_errors,
    )
    _cleanup_statement(
        cursor,
        "DELETE FROM app.cloud_roasts WHERE idempotency_key = %s",
        (TEST_RUN_ID,),
        f"parent cleanup [idempotency_key={TEST_RUN_ID}]",
        cleanup_errors,
    )
    remove_ran = _cleanup_statement(
        cursor,
        f"REMOVE {stage_prefix}",
        None,
        f"stage REMOVE cleanup [stage_prefix={stage_prefix}]",
        cleanup_errors,
    )
    if remove_ran:
        try:
            remaining = _fetchall(
                cursor,
                f"LIST {stage_prefix}",
                None,
                f"post-REMOVE LIST cleanup [stage_prefix={stage_prefix}]",
            )
        except UpsertRoastVerifyError as exc:
            cleanup_errors.append(exc)
        else:
            if remaining:
                cleanup_errors.append(
                    UpsertRoastVerifyError(
                        "stage REMOVE verification failed "
                        f"[stage_prefix={stage_prefix}]"
                    )
                )
    return cleanup_errors


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


def verify_live_upsert(connection: Connection, expected_target: str) -> str:
    """Exercise replay, no-net-change rejection, and scoped opt-out purge."""
    cursor: Cursor | None = None
    preflight_complete = False
    resolved_roast_id: object | None = None
    returned_roast_id: object | None = None
    body_error: UpsertRoastVerifyError | None = None
    try:
        cursor = _preflight(connection, expected_target)
        preflight_complete = True
        _stage_and_verify_fixtures(cursor)
        payload, first, resolved_roast_id, first_call_baseline = (
            _verify_replay_idempotency(cursor)
        )
        returned_roast_id = first["cloud_roast_id"]
        _verify_artifact_manifest(cursor, returned_roast_id)
        preserved_state = _verify_preserved_columns(
            cursor,
            payload,
            first,
            first_call_baseline,
        )
        _verify_visibility_rollback(cursor, payload, preserved_state[6])
        _verify_telemetry_purge_scope(
            cursor,
            payload,
            first,
            resolved_roast_id,
            preserved_state,
        )
        return str(returned_roast_id)
    except BaseException as exc:
        if resolved_roast_id is None:
            resolved_roast_id = getattr(exc, "cleanup_roast_id", None)
        if isinstance(exc, UpsertRoastVerifyError):
            body_error = exc
            if returned_roast_id is not None:
                body_error.resolved_roast_id = returned_roast_id
            raise
        body_error = UpsertRoastVerifyError("live verification body failed")
        body_error.resolved_roast_id = (
            getattr(exc, "resolved_roast_id", None)
            or returned_roast_id
            or resolved_roast_id
        )
        raise body_error from exc
    finally:
        cleanup_is_safe = body_error is None or not body_error.cleanup_unsafe
        if preflight_complete and cursor is not None and cleanup_is_safe:
            cleanup_errors = _cleanup_all(cursor, resolved_roast_id)
            if cleanup_errors:
                if body_error is not None:
                    diagnostic_roast_id = body_error.resolved_roast_id
                    if diagnostic_roast_id is None:
                        diagnostic_roast_id = resolved_roast_id
                    _attach_cleanup_failures(
                        body_error,
                        cleanup_errors,
                        diagnostic_roast_id,
                    )
                else:
                    cleanup_failure = UpsertRoastVerifyError(
                        "live verification cleanup failed"
                    )
                    _attach_cleanup_failures(
                        cleanup_failure,
                        cleanup_errors,
                        returned_roast_id or resolved_roast_id,
                    )
                    raise cleanup_failure


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise UpsertRoastVerifyError(f"missing required environment variable: {name}")
    return value


def _connect(target: str) -> Connection:  # pragma: no cover - real operator boundary
    try:
        import snowflake.connector
        from assert_dev_ci_grants import load_private_key_der
    except Exception:
        raise UpsertRoastVerifyError("Snowflake connector setup failed") from None

    try:
        private_key_path = Path(_required_env("SNOWFLAKE_PRIVATE_KEY_FILE"))
        private_key = load_private_key_der(
            private_key_path.read_text(encoding="utf-8"),
            os.environ.get("SNOWFLAKE_PRIVATE_KEY_PASSPHRASE") or None,
        )
    except UpsertRoastVerifyError:
        raise
    except Exception:
        raise UpsertRoastVerifyError(
            "SNOWFLAKE_PRIVATE_KEY_FILE configuration failed"
        ) from None

    account = _required_env("SNOWFLAKE_ACCOUNT")
    user = _required_env("SNOWFLAKE_USER")
    role = _required_env("SNOWFLAKE_ROLE")
    warehouse = _required_env("SNOWFLAKE_WAREHOUSE")
    try:
        return snowflake.connector.connect(
            account=account,
            user=user,
            role=role,
            warehouse=warehouse,
            database=target,
            private_key=private_key,
            autocommit=True,
        )
    except Exception:
        raise UpsertRoastVerifyError(
            "Snowflake connection or authentication failed"
        ) from None


def _print_failure(failure: UpsertRoastVerifyError) -> None:
    print(f"upsert verification failed: {failure}", file=sys.stderr)
    for cleanup_failure in failure.cleanup_failures:
        print(cleanup_failure, file=sys.stderr)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, choices=sorted(ALLOWED_TARGETS))
    args = parser.parse_args(argv)
    try:
        connection = _connect(args.target)
    except UpsertRoastVerifyError as exc:
        _print_failure(exc)
        return 1

    failure: UpsertRoastVerifyError | None = None
    roast_id = ""
    try:
        roast_id = verify_live_upsert(connection, args.target)
    except UpsertRoastVerifyError as exc:
        failure = exc
    except BaseException:
        failure = UpsertRoastVerifyError("live verification failed")
    try:
        connection.close()
    except BaseException:
        resolved_roast_id = (
            failure.resolved_roast_id if failure is not None else None
        )
        if resolved_roast_id is None and roast_id:
            resolved_roast_id = roast_id
        close_error = UpsertRoastVerifyError("Snowflake connection close failed")
        if failure is None:
            failure = UpsertRoastVerifyError("live verification cleanup failed")
        _attach_cleanup_failures(failure, (close_error,), resolved_roast_id)
    if failure is not None:
        _print_failure(failure)
        return 1

    print(
        "verified UPSERT_ROAST replay preservation, visibility change rejection with "
        "no net change, conditional and scoped opt-out telemetry purge, and staged "
        "artifact PUT/REMOVE paths for the jsonl and summary fixtures in "
        f"{args.target} (cloud_roast_id={roast_id})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
