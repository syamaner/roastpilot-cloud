#!/usr/bin/env python3
"""Operator-run live verification for LOAD_ROAST_TELEMETRY (#416/#419).

This serial-operator-only verifier owns fixed roast, run, stage-prefix, and
reference-summary keys. It self-heals only its enumerated synthetic keys, then
cleans only those keys. The fixture and all synthesized rows are de-identified.
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

from telemetry_expectation_oracle import fixture_expected_rows
from verify_seed_connection import connect_seed


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
_REVOKED_AGENT_DML_COLUMNS = (
    ("cloud_roasts", "idempotency_key"),
    ("roast_telemetry", "roast_id"),
    ("tasting_reviews", "roast_id"),
    ("reference_roast_summaries", "bean_origin"),
)
REVOKED_AGENT_DML_PROBES = tuple(
    (table, privilege, command)
    for table, column in _REVOKED_AGENT_DML_COLUMNS
    for privilege, command in (
        (
            "INSERT",
            f"INSERT INTO app.{table} ({column}) "
            "SELECT '__RP_446_DENY_PROBE__' WHERE FALSE",
        ),
        ("UPDATE", f"UPDATE app.{table} SET {column} = {column} WHERE FALSE"),
        ("DELETE", f"DELETE FROM app.{table} WHERE FALSE"),
    )
)


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


def _expect_sql_error(
    cursor: Cursor,
    command: str,
    params: Sequence[object],
    code: str,
    label: str,
) -> None:
    try:
        cursor.execute(command, params)
        cursor.fetchone()
    except BaseException as exc:
        if code in str(exc):
            return
        raise TelemetryVerifyError(f"{label} returned an unexpected SQL error") from exc
    raise TelemetryVerifyError(f"{label} unexpectedly succeeded")


def _is_insufficient_privileges_error(exc: BaseException) -> bool:
    """Recognize Snowflake's authorization denial by message or SQL identity."""
    return (
        "insufficient privilege" in str(exc).casefold()
        or getattr(exc, "sqlstate", None) == "42501"
        or getattr(exc, "errno", None) == 3001
    )


def verify_agent_dml_revoked(cursor: Cursor) -> None:
    """Prove direct agent DML is denied without risking a data mutation."""
    for table, privilege, command in REVOKED_AGENT_DML_PROBES:
        try:
            cursor.execute(command)
        except BaseException as exc:
            if _is_insufficient_privileges_error(exc):
                continue
            raise TelemetryVerifyError(
                f"{table} {privilege} deny-probe returned an unexpected SQL error"
            ) from exc
        raise TelemetryVerifyError(
            f"{table} {privilege} revoke not effective: no-op DML unexpectedly succeeded"
        )


def _summary_row(cursor: Cursor) -> tuple[object, ...]:
    cursor.execute(
        f"SELECT {', '.join(SUMMARY_COLUMNS)} FROM app.reference_roast_summaries "
        "WHERE bean_origin = %s AND roast_level = %s",
        (BEAN_ORIGIN, ROAST_LEVEL),
    )
    # The cursor returns tuple-shaped rows here, so _row_values takes the
    # Sequence branch and only checks len(labels), never the label text, so the
    # .upper() case transform is equivalent.
    labels = tuple(column.upper() for column in SUMMARY_COLUMNS)  # pragma: no mutate
    return _row_values(cursor.fetchone(), labels)


def verify_live_load(
    connection: Connection,
    seed_connection: Connection,
    fixture_path: Path,
    expected_target: str,
) -> int:
    """Verify fail-closed consent, opted-in load, summaries, and artifacts."""
    if expected_target not in ALLOWED_TARGETS:
        raise TelemetryVerifyError(f"rejected telemetry target: {expected_target!r}")
    # These four IDs are hard-coded lowercase-UUID module constants, so the
    # guards can never fire: the raise bodies are statically unreachable
    # (no cover) and their text is unkillable by any test (no mutate).
    if UUID_PATTERN.fullmatch(TEST_RUN_ID) is None:
        raise TelemetryVerifyError("TEST_RUN_ID is not a lowercase UUID")  # pragma: no cover; pragma: no mutate
    if UUID_PATTERN.fullmatch(TEST_ROAST_ID) is None:
        raise TelemetryVerifyError("TEST_ROAST_ID is not a lowercase UUID")  # pragma: no cover; pragma: no mutate
    if UUID_PATTERN.fullmatch(SENTINEL_ROAST_ID) is None:
        raise TelemetryVerifyError("SENTINEL_ROAST_ID is not a lowercase UUID")  # pragma: no cover; pragma: no mutate
    if UUID_PATTERN.fullmatch(MISSING_ROAST_ID) is None:
        raise TelemetryVerifyError("MISSING_ROAST_ID is not a lowercase UUID")  # pragma: no cover; pragma: no mutate
    gate_a_ids = (
        MIXED_CONSENT_ROAST_ID,
        OPTED_OUT_ROAST_ID,
        CONSENT_FLIP_ROAST_ID,
    )
    if any(UUID_PATTERN.fullmatch(roast_id) is None for roast_id in gate_a_ids):
        raise TelemetryVerifyError("Gate-A roast id is not a lowercase UUID")  # pragma: no cover; pragma: no mutate
    fixture_uri = _validated_fixture_uri(fixture_path)
    expected_dicts = fixture_expected_rows(fixture_path, TEST_ROAST_ID)
    expected = [tuple(row[column] for column in SELECT_COLUMNS) for row in expected_dicts]
    cursor = connection.cursor()
    cursor.execute("USE SECONDARY ROLES NONE")
    cursor.execute("SELECT CURRENT_DATABASE()")
    # The cursor returns tuple-shaped rows here, so _first_value takes the
    # Sequence branch (row[0]) and ignores the label text/case entirely, making
    # the label mutant equivalent; the != comparison stays mutable on its own line.
    current_database = _first_value(cursor.fetchone(), "CURRENT_DATABASE()")  # pragma: no mutate
    if current_database != expected_target:
        raise TelemetryVerifyError("connected database does not match target")
    cursor.execute("SELECT CURRENT_ROLE()")
    # Tuple-shaped row: _first_value takes the Sequence branch (row[0]) and
    # ignores the label, so the label mutant is equivalent here too.
    current_role = _first_value(cursor.fetchone(), "CURRENT_ROLE()")  # pragma: no mutate
    if current_role != EXPECTED_ROLE:
        raise TelemetryVerifyError("connected role is not ROASTPILOT_AGENT")

    # This is intentionally a post-deploy assertion: it must fail before the
    # #446 repeatable revoke migration is live. Every statement is zero-row DML,
    # so an unexpectedly permitted probe still cannot mutate data.
    verify_agent_dml_revoked(cursor)
    seed_cursor = seed_connection.cursor()

    # Phase 1 classifies every reserved key without mutating either surface.
    cloud_preflight_query = (
        "SELECT COUNT(*) FROM app.cloud_roasts "
        "WHERE id IN (%s, %s, %s, %s, %s, %s) "
        "OR idempotency_key IN (%s, %s, %s, %s, %s) "
        "OR public_slug IN (%s, %s, %s, %s, %s)"
    )
    cloud_preflight_params = (
        TEST_ROAST_ID,
        SENTINEL_ROAST_ID,
        MISSING_ROAST_ID,
        *gate_a_ids,
        TEST_RUN_ID,
        MIXED_CONSENT_TRUE_RUN_ID,
        MIXED_CONSENT_FALSE_RUN_ID,
        OPTED_OUT_RUN_ID,
        CONSENT_FLIP_RUN_ID,
        PUBLIC_SLUG,
        MIXED_CONSENT_TRUE_SLUG,
        MIXED_CONSENT_FALSE_SLUG,
        OPTED_OUT_SLUG,
        CONSENT_FLIP_SLUG,
    )
    cloud_owned_query = (
        "SELECT COUNT(*) FROM app.cloud_roasts "
        "WHERE (id = %s AND idempotency_key = %s) "
        "OR id IN (%s, %s, %s)"
    )
    cloud_owned_params = (TEST_ROAST_ID, TEST_RUN_ID, *gate_a_ids)
    cloud_unhealable_query = (
        "SELECT COUNT(*) FROM app.cloud_roasts "
        "WHERE (id IN (%s, %s, %s, %s, %s, %s) "
        "OR idempotency_key IN (%s, %s, %s, %s, %s) "
        "OR public_slug IN (%s, %s, %s, %s, %s)) "
        "AND NOT COALESCE(((id = %s AND idempotency_key = %s) "
        "OR id IN (%s, %s, %s)), FALSE)"
    )
    cursor.execute(
        cloud_unhealable_query,
        (*cloud_preflight_params, *cloud_owned_params),
    )
    cloud_unhealable_count = _count(cursor.fetchone())
    cursor.execute(cloud_owned_query, cloud_owned_params)
    cloud_owned_count = _count(cursor.fetchone())

    telemetry_preflight_query = (
        "SELECT COUNT(*) FROM app.roast_telemetry "
        "WHERE roast_id IN (%s, %s, %s, %s, %s, %s)"
    )
    telemetry_preflight_params = (
        TEST_ROAST_ID,
        SENTINEL_ROAST_ID,
        MISSING_ROAST_ID,
        *gate_a_ids,
    )
    cursor.execute(telemetry_preflight_query, telemetry_preflight_params)
    telemetry_preflight_count = _count(cursor.fetchone())

    artifact_preflight_query = (
        "SELECT COUNT(*) FROM app.roast_artifacts "
        "WHERE roast_id IN (%s, %s, %s, %s)"
    )
    artifact_preflight_params = (TEST_ROAST_ID, *gate_a_ids)
    cursor.execute(artifact_preflight_query, artifact_preflight_params)
    artifact_preflight_count = _count(cursor.fetchone())

    summary_preflight_query = (
        "SELECT COUNT(*) FROM app.reference_roast_summaries "
        "WHERE bean_origin = %s AND roast_level = %s"
    )
    summary_preflight_params = (BEAN_ORIGIN, ROAST_LEVEL)
    cursor.execute(summary_preflight_query, summary_preflight_params)
    summary_preflight_count = _count(cursor.fetchone())

    stage_preflight_query = f"LIST @app.roast_artifacts/{TEST_RUN_ID}/"
    cursor.execute(stage_preflight_query)
    existing_stage_rows = cursor.fetchall()
    # Fake and real LIST rows are positional tuples, so the name label is ignored.
    stage_object_name = (
        _first_value(existing_stage_rows[0], "name")  # pragma: no mutate
        if len(existing_stage_rows) == 1
        else None
    )
    stage_marker = f"{TEST_RUN_ID}/"
    stage_relative_path = (
        stage_object_name.partition(stage_marker)[2]
        if isinstance(stage_object_name, str) and stage_marker in stage_object_name
        else None
    )
    stage_is_healable = stage_relative_path == FIXTURE_PATH.name

    if cloud_unhealable_count != 0:
        raise TelemetryVerifyError("telemetry verifier roast keys are already owned")
    if existing_stage_rows and not stage_is_healable:
        raise TelemetryVerifyError("telemetry verifier stage prefix is already owned")

    # Phase 2 is reachable only when every detected collision is healable.
    if telemetry_preflight_count != 0:
        try:
            seed_cursor.execute(
                "DELETE FROM app.roast_telemetry "
                "WHERE roast_id IN (%s, %s, %s, %s, %s, %s)",
                telemetry_preflight_params,
            )
        except BaseException as exc:
            raise TelemetryVerifyError(
                "telemetry verifier row keys are already owned"
            ) from exc
    if artifact_preflight_count != 0:
        try:
            seed_cursor.execute(
                "DELETE FROM app.roast_artifacts "
                "WHERE roast_id IN (%s, %s, %s, %s)",
                artifact_preflight_params,
            )
        except BaseException as exc:
            raise TelemetryVerifyError(
                "telemetry verifier artifact key is already owned"
            ) from exc
    if cloud_owned_count != 0:
        try:
            seed_cursor.execute(
                "DELETE FROM app.cloud_roasts "
                "WHERE (id = %s AND idempotency_key = %s) "
                "OR id IN (%s, %s, %s)",
                cloud_owned_params,
            )
        except BaseException as exc:
            raise TelemetryVerifyError(
                "telemetry verifier roast keys are already owned"
            ) from exc
    if summary_preflight_count != 0:
        try:
            seed_cursor.execute(
                "DELETE FROM app.reference_roast_summaries "
                "WHERE bean_origin = %s AND roast_level = %s",
                summary_preflight_params,
            )
        except BaseException as exc:
            raise TelemetryVerifyError(
                "telemetry verifier summary key is already owned"
            ) from exc
    if stage_is_healable:
        try:
            cursor.execute(f"REMOVE @app.roast_artifacts/{TEST_RUN_ID}/")
        except BaseException as exc:
            raise TelemetryVerifyError(
                "telemetry verifier stage prefix is already owned"
            ) from exc

    # Re-check every reserved namespace, including those absent in Phase 1.
    cursor.execute(cloud_preflight_query, cloud_preflight_params)
    if _count(cursor.fetchone()) != 0:
        raise TelemetryVerifyError("telemetry verifier roast keys are already owned")
    cursor.execute(telemetry_preflight_query, telemetry_preflight_params)
    if _count(cursor.fetchone()) != 0:
        raise TelemetryVerifyError("telemetry verifier row keys are already owned")
    cursor.execute(artifact_preflight_query, artifact_preflight_params)
    if _count(cursor.fetchone()) != 0:
        raise TelemetryVerifyError(
            "telemetry verifier artifact key is already owned"
        )
    cursor.execute(summary_preflight_query, summary_preflight_params)
    if _count(cursor.fetchone()) != 0:
        raise TelemetryVerifyError("telemetry verifier summary key is already owned")
    cursor.execute(stage_preflight_query)
    if cursor.fetchall():
        raise TelemetryVerifyError("telemetry verifier stage prefix is already owned")

    body_error: TelemetryVerifyError | None = None
    try:
        cursor.execute(
            f"PUT '{fixture_uri}' "
            f"@app.roast_artifacts/{TEST_RUN_ID} AUTO_COMPRESS=FALSE OVERWRITE=TRUE"
        )

        _expect_sql_error(
            cursor,
            "CALL app.load_roast_telemetry(%s, %s)",
            (TEST_RUN_ID, MISSING_ROAST_ID),
            "-20013",
            "missing-roast telemetry load",
        )
        cursor.execute(
            "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
            (MISSING_ROAST_ID,),
        )
        if _count(cursor.fetchone()) != 0:
            raise TelemetryVerifyError("missing-roast telemetry load inserted rows")

        seed_cursor.execute(
            "INSERT INTO app.cloud_roasts "
            "(id, idempotency_key, owner_id, public_slug, visibility, bean_origin, "
            "bean_varietal, bean_weight_g, profile_name, roast_level, summary, "
            "operator_rating, operator_notes, contributed_to_learning, roasted_at_utc) "
            "SELECT %s, %s, NULL, %s, 'private', %s, 'C3-S4 live verifier', 250, "
            "'telemetry consent verification', %s, PARSE_JSON(%s), 4, NULL, FALSE, "
            "'2026-09-02T12:00:00Z'::timestamp_tz "
            "UNION ALL SELECT %s, %s, NULL, %s, 'private', NULL, "
            "'Gate-A mixed true', 250, 'telemetry consent verification', NULL, "
            "PARSE_JSON(%s), 4, NULL, TRUE, "
            "'2026-09-02T12:00:00Z'::timestamp_tz "
            "UNION ALL SELECT %s, %s, NULL, %s, 'private', NULL, "
            "'Gate-A mixed false', 250, 'telemetry consent verification', NULL, "
            "PARSE_JSON(%s), 4, NULL, FALSE, "
            "'2026-09-02T12:00:00Z'::timestamp_tz "
            "UNION ALL SELECT %s, %s, NULL, %s, 'private', NULL, "
            "'Gate-A opted out', 250, 'telemetry consent verification', NULL, "
            "PARSE_JSON(%s), 4, NULL, FALSE, "
            "'2026-09-02T12:00:00Z'::timestamp_tz "
            "UNION ALL SELECT %s, %s, NULL, %s, 'private', NULL, "
            "'Gate-A consent flip', 250, 'telemetry consent verification', NULL, "
            "PARSE_JSON(%s), 4, NULL, TRUE, "
            "'2026-09-02T12:00:00Z'::timestamp_tz",
            (
                TEST_ROAST_ID,
                TEST_RUN_ID,
                PUBLIC_SLUG,
                BEAN_ORIGIN,
                ROAST_LEVEL,
                json.dumps(SUMMARY, separators=(",", ":")),
                MIXED_CONSENT_ROAST_ID,
                MIXED_CONSENT_TRUE_RUN_ID,
                MIXED_CONSENT_TRUE_SLUG,
                json.dumps(SUMMARY, separators=(",", ":")),
                MIXED_CONSENT_ROAST_ID,
                MIXED_CONSENT_FALSE_RUN_ID,
                MIXED_CONSENT_FALSE_SLUG,
                json.dumps(SUMMARY, separators=(",", ":")),
                OPTED_OUT_ROAST_ID,
                OPTED_OUT_RUN_ID,
                OPTED_OUT_SLUG,
                json.dumps(SUMMARY, separators=(",", ":")),
                CONSENT_FLIP_ROAST_ID,
                CONSENT_FLIP_RUN_ID,
                CONSENT_FLIP_SLUG,
                json.dumps(SUMMARY, separators=(",", ":")),
            ),
        )
        seed_cursor.execute(
            "INSERT INTO app.roast_telemetry "
            "(roast_id, elapsed_s, bean_temp_c, env_temp_c, heat_percent, "
            "fan_percent, ror_c_per_min, raw) "
            "SELECT %s, 0, 20, 21, 80, 30, NULL, PARSE_JSON('{}')",
            (SENTINEL_ROAST_ID,),
        )

        for roast_id, label in (
            (MIXED_CONSENT_ROAST_ID, "mixed-consent telemetry load"),
            (OPTED_OUT_ROAST_ID, "single opt-out telemetry load"),
        ):
            _expect_sql_error(
                cursor,
                "CALL app.load_roast_telemetry(%s, %s)",
                (TEST_RUN_ID, roast_id),
                "-20013",
                label,
            )
            cursor.execute(
                "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
                (roast_id,),
            )
            if _count(cursor.fetchone()) != 0:
                raise TelemetryVerifyError(f"{label} inserted rows")

        _expect_sql_error(
            cursor,
            "CALL app.load_roast_telemetry(%s, %s)",
            (TEST_RUN_ID, TEST_ROAST_ID),
            "-20013",
            "opt-out telemetry load",
        )
        cursor.execute(
            "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
            (TEST_ROAST_ID,),
        )
        if _count(cursor.fetchone()) != 0:
            raise TelemetryVerifyError("opt-out telemetry load inserted rows")
        cursor.execute(
            "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
            (SENTINEL_ROAST_ID,),
        )
        if _count(cursor.fetchone()) != 1:
            raise TelemetryVerifyError("opt-out telemetry load changed the sentinel row")

        _expect_sql_error(
            cursor,
            "CALL app.upsert_roast(%s, %s)",
            (TEST_RUN_ID, _payload(False, ("jsonl",))),
            "-20009",
            "opt-out non-empty artifact manifest",
        )
        cursor.execute(
            "SELECT COUNT(*) FROM app.roast_artifacts WHERE roast_id = %s",
            (TEST_ROAST_ID,),
        )
        if _count(cursor.fetchone()) != 0:
            raise TelemetryVerifyError("rejected opt-out manifest inserted artifact rows")

        cursor.execute(
            "CALL app.upsert_roast(%s, %s)",
            (TEST_RUN_ID, _payload(False, ())),
        )
        cursor.fetchone()
        cursor.execute(
            "SELECT COUNT(*) FROM app.roast_artifacts WHERE roast_id = %s",
            (TEST_ROAST_ID,),
        )
        if _count(cursor.fetchone()) != 0:
            raise TelemetryVerifyError("empty opt-out manifest left artifact rows")

        after_opt_out = _summary_row(cursor)
        if (
            after_opt_out[0] != 0
            or after_opt_out[1] != 0
            or any(value is not None for value in after_opt_out[2:])
        ):
            raise TelemetryVerifyError("opt-out roast contributed to the reference summary")

        # This probe deterministically exercises Guard 3's pre-transaction
        # consent rejection (-20013), which shares byte-identical consent logic
        # with the proc's consent-conditioned INSERT predicate. That INSERT
        # predicate's NEGATIVE branch in isolation is reachable only under a
        # consent opt-out committed in the window between Guard 3's read and the
        # INSERT statement (a read-committed concurrency race), which a single
        # synchronous verifier cannot trigger deterministically. That race is
        # the accepted residual per D-446-J (Gate B accept-residual); the INSERT
        # predicate's POSITIVE branch is covered by the opt-in happy path, and
        # the read-side consent gate (roast_by_slug + recompute) remains the
        # authoritative public boundary.
        seed_cursor.execute(
            "UPDATE app.cloud_roasts SET contributed_to_learning = "
            "CASE WHEN id = %s THEN TRUE ELSE FALSE END "
            "WHERE (id = %s AND idempotency_key = %s) "
            "OR (id = %s AND idempotency_key = %s)",
            (
                TEST_ROAST_ID,
                TEST_ROAST_ID,
                TEST_RUN_ID,
                CONSENT_FLIP_ROAST_ID,
                CONSENT_FLIP_RUN_ID,
            ),
        )
        _expect_sql_error(
            cursor,
            "CALL app.load_roast_telemetry(%s, %s)",
            (TEST_RUN_ID, CONSENT_FLIP_ROAST_ID),
            "-20013",
            "committed consent-flip telemetry load",
        )
        cursor.execute(
            "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
            (CONSENT_FLIP_ROAST_ID,),
        )
        if _count(cursor.fetchone()) != 0:
            raise TelemetryVerifyError("committed consent-flip telemetry load inserted rows")
        cursor.execute(
            "CALL app.load_roast_telemetry(%s, %s)",
            (TEST_RUN_ID, TEST_ROAST_ID),
        )
        # The cursor returns a tuple-shaped row, so _first_value takes the
        # Sequence branch (row[0]) and ignores the label text entirely, making
        # the label mutant equivalent here.
        loaded = _first_value(cursor.fetchone(), "LOAD_ROAST_TELEMETRY")  # pragma: no mutate
        cursor.execute(
            f"SELECT {', '.join(SELECT_COLUMNS)} FROM app.roast_telemetry "
            "WHERE roast_id = %s ORDER BY elapsed_s",
            (TEST_ROAST_ID,),
        )
        actual = [tuple(row) for row in cursor.fetchall()]
        if actual != expected:
            raise TelemetryVerifyError("loaded telemetry does not match fixture expectation")
        if str(loaded) != str(len(expected)):
            raise TelemetryVerifyError("procedure row count does not match fixture expectation")

        cursor.execute(
            "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
            (SENTINEL_ROAST_ID,),
        )
        if _count(cursor.fetchone()) != 1:
            raise TelemetryVerifyError("opt-in telemetry load changed the sentinel row")

        # Trigger the owner-rights recompute through the only agent-callable
        # write path; ROASTPILOT_AGENT has no direct USAGE on the recompute proc.
        cursor.execute(
            "CALL app.upsert_roast(%s, %s)",
            (TEST_RUN_ID, _payload(True, ())),
        )
        cursor.fetchone()
        after_opt_in = _summary_row(cursor)
        if after_opt_in[0] != 1 or after_opt_in == after_opt_out:
            raise TelemetryVerifyError("opt-in roast did not move the reference summary")
        if not any(value is not None for value in after_opt_in[3:]):
            raise TelemetryVerifyError("opt-in roast did not populate summary averages")

        # This agent-role verifier deliberately does not read
        # app.data_quality_violations, which is outside the exact agent surface.
        # test_load_roast_telemetry.py proves offline that the view has no
        # roast_telemetry branch; seed_validate_live.py performs the privileged
        # live zero-count assertion.
        return len(actual)
    except BaseException as exc:
        if isinstance(exc, TelemetryVerifyError):
            body_error = exc
            raise
        body_error = TelemetryVerifyError("live verification body failed")
        raise body_error from exc
    finally:
        cleanup_errors: list[TelemetryVerifyError] = []
        cleanup_statements: tuple[
            tuple[str, tuple[object, ...] | None, str], ...
        ] = (
            (
                "DELETE FROM app.roast_telemetry "
                "WHERE roast_id IN (%s, %s, %s, %s, %s, %s)",
                (TEST_ROAST_ID, SENTINEL_ROAST_ID, MISSING_ROAST_ID, *gate_a_ids),
                "telemetry rows cleanup",
            ),
            (
                "DELETE FROM app.roast_artifacts "
                "WHERE roast_id IN (%s, %s, %s, %s)",
                (TEST_ROAST_ID, *gate_a_ids),
                "artifact rows cleanup",
            ),
            (
                "DELETE FROM app.cloud_roasts "
                "WHERE (id = %s AND idempotency_key = %s) "
                "OR id IN (%s, %s, %s)",
                (TEST_ROAST_ID, TEST_RUN_ID, *gate_a_ids),
                "cloud_roasts cleanup",
            ),
            (
                "DELETE FROM app.reference_roast_summaries "
                "WHERE bean_origin = %s AND roast_level = %s",
                (BEAN_ORIGIN, ROAST_LEVEL),
                "reference summary cleanup",
            ),
            (
                f"REMOVE @app.roast_artifacts/{TEST_RUN_ID}/", None, "stage REMOVE cleanup"
            ),
        )
        for command, params, step in cleanup_statements:
            try:
                cleanup_cursor = (
                    cursor if command.startswith("REMOVE ") else seed_cursor
                )
                if params is None:
                    cleanup_cursor.execute(command)
                else:
                    cleanup_cursor.execute(command, params)
            except BaseException as exc:
                cleanup_error = TelemetryVerifyError(f"{step} failed")
                # _print_failure only reports the top-level failure's sanitised
                # cause summary. This nested cleanup cause is never printed, so
                # swapping it to None is behaviourally invisible to any test.
                cleanup_error.__cause__ = exc  # pragma: no mutate
                cleanup_errors.append(cleanup_error)

        if cleanup_errors:
            if body_error is not None:
                _attach_cleanup_failures(body_error, cleanup_errors)
            else:
                cleanup_failure = TelemetryVerifyError(
                    "telemetry verification cleanup failed"
                )
                _attach_cleanup_failures(cleanup_failure, cleanup_errors)
                raise cleanup_failure


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


def _connect(target: str) -> Connection:  # pragma: no cover; pragma: no mutate block - real operator boundary
    import snowflake.connector
    from assert_dev_ci_grants import load_private_key_der

    private_key_path = Path(_required_env("SNOWFLAKE_PRIVATE_KEY_FILE"))
    private_key = load_private_key_der(
        private_key_path.read_text(encoding="utf-8"),
        os.environ.get("SNOWFLAKE_PRIVATE_KEY_PASSPHRASE") or None,
    )
    return snowflake.connector.connect(
        account=_required_env("SNOWFLAKE_ACCOUNT"),
        user=_required_env("SNOWFLAKE_USER"),
        role=_required_env("SNOWFLAKE_ROLE"),
        warehouse=_required_env("SNOWFLAKE_WAREHOUSE"),
        database=target,
        private_key=private_key,
        # Commit direct setup before owner-rights upsert opens its transaction;
        # also persist ordered cleanup rather than relying on connection close.
        autocommit=True,
    )


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


def main(argv: Sequence[str] | None = None) -> int:  # pragma: no mutate block - CLI wrapper
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, choices=sorted(ALLOWED_TARGETS))
    args = parser.parse_args(argv)
    try:
        connection = _connect(args.target)
    except TelemetryVerifyError as exc:
        _print_failure(exc)
        return 1
    except Exception as exc:
        failure = TelemetryVerifyError("Snowflake connection or authentication failed")
        failure.__cause__ = exc
        _print_failure(failure)
        return 1
    try:
        seed_connection = connect_seed(args.target)
    except BaseException:
        try:
            connection.close()
        except BaseException:
            pass
        _print_failure(TelemetryVerifyError("Snowflake seed connection failed"))
        return 1
    failure: TelemetryVerifyError | None = None
    count = 0
    try:
        count = verify_live_load(connection, seed_connection, FIXTURE_PATH, args.target)
    except TelemetryVerifyError as exc:
        failure = exc
    except BaseException as exc:
        failure = TelemetryVerifyError("telemetry verification failed")
        failure.__cause__ = exc
    for label, open_connection in (
        ("Snowflake connection close failed", connection),
        ("Snowflake seed connection close failed", seed_connection),
    ):
        try:
            open_connection.close()
        except BaseException as exc:
            close_error = TelemetryVerifyError(label)
            close_error.__cause__ = exc
            if failure is None:
                failure = TelemetryVerifyError("telemetry verification cleanup failed")
            _attach_cleanup_failures(failure, (close_error,))
    if failure is not None:
        _print_failure(failure)
        return 1
    print(f"verified {count} telemetry rows in {args.target}")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
