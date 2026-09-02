#!/usr/bin/env python3
"""Operator-run live verification for UPSERT_ROAST (issue #417)."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol


ALLOWED_TARGETS = frozenset({"ROASTPILOT_DEV"})
EXPECTED_ROLE = "ROASTPILOT_AGENT"
TEST_RUN_ID = "01234567-89ab-cdef-0123-456789abcdef"
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


class Cursor(Protocol):
    def execute(self, command: str, params: Sequence[object] | None = None) -> Any: ...
    def fetchone(self) -> object: ...
    def fetchall(self) -> Sequence[Sequence[object]]: ...


class Connection(Protocol):
    def cursor(self) -> Cursor: ...
    def close(self) -> None: ...


class UpsertRoastVerifyError(RuntimeError):
    """Raised when live upsert behavior differs from the ratified contract."""


def _first_value(row: object, label: str) -> object:
    if isinstance(row, Mapping):
        return row.get(label)
    if isinstance(row, Sequence) and not isinstance(row, (str, bytes)) and row:
        return row[0]
    return None


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


def _count(row: object, label: str) -> int:
    value = _first_value(row, label)
    if isinstance(value, bool) or not isinstance(value, int):
        raise UpsertRoastVerifyError(f"{label} did not return an integer")
    return value


def _stored_pair(row: object) -> tuple[object, object]:
    if isinstance(row, Mapping):
        return row.get("ID"), row.get("PUBLIC_SLUG")
    if isinstance(row, Sequence) and not isinstance(row, (str, bytes)):
        if len(row) == 2:
            return row[0], row[1]
    raise UpsertRoastVerifyError("stored roast query returned an unexpected row")


def _payload() -> dict[str, object]:
    return {
        "public_slug": PUBLIC_SLUG,
        "visibility": "unlisted",
        "bean_origin": None,
        "bean_varietal": "C3-S2 verifier",
        "bean_weight_g": 250.0,
        "profile_name": "live verification",
        "roast_level": None,
        "operator_rating": 4,
        "operator_notes": "issue 417 live verifier",
        "contributed_to_learning": True,
        "roasted_at_utc": "2026-09-02T12:00:00Z",
        "summary": {},
        "artifact_kinds": list(ARTIFACT_KINDS),
    }


def _call_upsert(cursor: Cursor, payload: Mapping[str, object]) -> dict[str, object]:
    cursor.execute(
        "CALL app.upsert_roast(%s, %s)",
        (TEST_RUN_ID, json.dumps(payload, separators=(",", ":"))),
    )
    return _variant_object(_first_value(cursor.fetchone(), "UPSERT_ROAST"))


def _is_visibility_error(exc: BaseException) -> bool:
    message = str(exc).lower()
    return "-20012" in message or "visibility_change_not_supported" in message


def verify_live_upsert(connection: Connection, expected_target: str) -> str:
    """Exercise idempotency, immutable fields, artifacts, and opt-out purge."""
    if expected_target not in ALLOWED_TARGETS:
        raise UpsertRoastVerifyError(f"rejected upsert target: {expected_target!r}")
    if RUN_ID_PATTERN.fullmatch(TEST_RUN_ID) is None:
        raise UpsertRoastVerifyError("TEST_RUN_ID is not a lowercase UUID")
    expected_paths = {
        f"@app.roast_artifacts/{TEST_RUN_ID}/{ARTIFACT_BASENAMES[kind]}"
        for kind in ARTIFACT_KINDS
    }

    cursor = connection.cursor()
    cursor.execute("USE SECONDARY ROLES NONE")
    cursor.execute("SELECT CURRENT_DATABASE()")
    if _first_value(cursor.fetchone(), "CURRENT_DATABASE()") != expected_target:
        raise UpsertRoastVerifyError("connected database does not match target")
    cursor.execute("SELECT CURRENT_ROLE()")
    if _first_value(cursor.fetchone(), "CURRENT_ROLE()") != EXPECTED_ROLE:
        raise UpsertRoastVerifyError("connected role is not ROASTPILOT_AGENT")

    body_error: BaseException | None = None
    try:
        payload = _payload()
        first = _call_upsert(cursor, payload)
        second = _call_upsert(cursor, payload)

        cursor.execute(
            "SELECT COUNT(*) FROM app.cloud_roasts WHERE idempotency_key = %s",
            (TEST_RUN_ID,),
        )
        if _count(cursor.fetchone(), "COUNT(*)") != 1:
            raise UpsertRoastVerifyError("replay did not leave exactly one roast")
        if second != first:
            raise UpsertRoastVerifyError("identical replay returned a different object")

        cursor.execute(
            "SELECT COUNT(*) FROM app.roast_artifacts WHERE roast_id = %s",
            (first["cloud_roast_id"],),
        )
        if _count(cursor.fetchone(), "COUNT(*)") != len(ARTIFACT_KINDS):
            raise UpsertRoastVerifyError("artifact count does not match manifest")
        cursor.execute(
            "SELECT stage_path FROM app.roast_artifacts WHERE roast_id = %s",
            (first["cloud_roast_id"],),
        )
        actual_paths = {
            _first_value(row, "STAGE_PATH") for row in cursor.fetchall()
        }
        if actual_paths != expected_paths:
            raise UpsertRoastVerifyError("artifact stage paths do not match manifest")

        slug_payload = dict(payload)
        slug_payload["public_slug"] = REPLAY_SLUG
        _call_upsert(cursor, slug_payload)
        cursor.execute(
            "SELECT id, public_slug FROM app.cloud_roasts WHERE idempotency_key = %s",
            (TEST_RUN_ID,),
        )
        stored_pair = _stored_pair(cursor.fetchone())
        if stored_pair != (first["cloud_roast_id"], first["public_slug"]):
            raise UpsertRoastVerifyError("slug replay changed the stored id or slug")

        visibility_payload = dict(payload)
        visibility_payload["visibility"] = "private"
        try:
            _call_upsert(cursor, visibility_payload)
        except BaseException as exc:
            if not _is_visibility_error(exc):
                raise UpsertRoastVerifyError(
                    "visibility replay failed with an unexpected error"
                ) from exc
        else:
            raise UpsertRoastVerifyError("visibility replay unexpectedly succeeded")
        cursor.execute(
            "SELECT visibility FROM app.cloud_roasts WHERE idempotency_key = %s",
            (TEST_RUN_ID,),
        )
        if _first_value(cursor.fetchone(), "VISIBILITY") != payload["visibility"]:
            raise UpsertRoastVerifyError("failed visibility replay changed stored value")

        cursor.execute(
            "INSERT INTO app.roast_telemetry "
            "(roast_id, elapsed_s, bean_temp_c, env_temp_c, heat_percent, "
            "fan_percent, ror_c_per_min, raw) "
            "SELECT %s, %s, %s, %s, %s, %s, %s, PARSE_JSON(%s) UNION ALL "
            "SELECT %s, %s, %s, %s, %s, %s, %s, PARSE_JSON(%s)",
            (
                first["cloud_roast_id"], 0.0, 20.0, 21.0, 80, 30, None, "{}",
                first["cloud_roast_id"], 5.0, 22.0, 23.0, 75, 35, 24.0, "{}",
            ),
        )
        cursor.execute(
            "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
            (first["cloud_roast_id"],),
        )
        if _count(cursor.fetchone(), "COUNT(*)") != 2:
            raise UpsertRoastVerifyError("telemetry setup did not insert two rows")

        opt_out_payload = dict(payload)
        opt_out_payload["contributed_to_learning"] = False
        opt_out_payload["artifact_kinds"] = []
        _call_upsert(cursor, opt_out_payload)
        cursor.execute(
            "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
            (first["cloud_roast_id"],),
        )
        if _count(cursor.fetchone(), "COUNT(*)") != 0:
            raise UpsertRoastVerifyError("opt-out replay did not purge telemetry")
        return str(first["cloud_roast_id"])
    except BaseException as exc:
        body_error = exc
        raise
    finally:
        cleanup_errors: list[BaseException] = []
        try:
            cursor.execute(
                "DELETE FROM app.roast_artifacts WHERE roast_id IN "
                "(SELECT id FROM app.cloud_roasts WHERE idempotency_key = %s)",
                (TEST_RUN_ID,),
            )
        except BaseException as exc:
            cleanup_errors.append(exc)
        try:
            cursor.execute(
                "DELETE FROM app.roast_telemetry WHERE roast_id IN "
                "(SELECT id FROM app.cloud_roasts WHERE idempotency_key = %s)",
                (TEST_RUN_ID,),
            )
        except BaseException as exc:
            cleanup_errors.append(exc)
        try:
            cursor.execute(
                "DELETE FROM app.cloud_roasts WHERE idempotency_key = %s",
                (TEST_RUN_ID,),
            )
        except BaseException as exc:
            cleanup_errors.append(exc)
        try:
            cursor.execute(f"REMOVE @app.roast_artifacts/{TEST_RUN_ID}/")
        except BaseException as exc:
            cleanup_errors.append(exc)

        if cleanup_errors:
            if body_error is not None:
                for cleanup_error in cleanup_errors:
                    body_error.add_note(f"cleanup failed: {cleanup_error!r}")
            else:
                primary_cleanup_error = cleanup_errors[0]
                for cleanup_error in cleanup_errors[1:]:
                    primary_cleanup_error.add_note(
                        f"additional cleanup failure: {cleanup_error!r}"
                    )
                raise primary_cleanup_error


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise UpsertRoastVerifyError(f"missing required environment variable: {name}")
    return value


def _connect(target: str) -> Connection:  # pragma: no cover - real operator boundary
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
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, choices=sorted(ALLOWED_TARGETS))
    args = parser.parse_args(argv)
    connection = _connect(args.target)
    try:
        roast_id = verify_live_upsert(connection, args.target)
    except Exception as exc:
        print(f"upsert verification failed: {exc}", file=sys.stderr)
        return 1
    finally:
        connection.close()
    print(
        "verified UPSERT_ROAST idempotent replay, exact artifact paths, slug "
        f"preservation, visibility rejection, and opt-out telemetry purge in "
        f"{args.target} (cloud_roast_id={roast_id})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
