#!/usr/bin/env python3
"""Operator-run live verification for UPSERT_ROAST (issue #417).

Only JSONL and summary fixtures are staged; no roast.csv exists. ``bean_origin`` and
``roast_level`` are deliberately null so recompute
returns through its null-grouping-key branch. Populating them would write a shared
reference-summary row this verifier cannot safely clean up, so AC-3's recompute
write path is deliberately not exercised live here.
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
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
ARTIFACT_KINDS = ("jsonl", "csv", "summary")
ARTIFACT_BASENAMES = {
    "jsonl": "roast.jsonl", "csv": "roast.csv", "summary": "summary.json"}
PUBLIC_SLUG = "123456789ABCDEFGH"
REPLAY_SLUG = "HGFEDCBA987654321"
ORIGINAL_NOTES, ROLLBACK_NOTES = "issue 417 live verifier", "this update must roll back"


class Cursor(Protocol):
    def execute(self, command: str, params: Sequence[object] | None = None) -> Any: ...
    def fetchone(self) -> object: ...
    def fetchall(self) -> Sequence[Sequence[object]]: ...


class Connection(Protocol):
    def cursor(self) -> Cursor: ...
    def close(self) -> None: ...


class UpsertRoastVerifyError(RuntimeError):
    """Raised when live upsert behavior differs from the ratified contract."""


def _validated_fixture_uri(fixture_path: Path) -> str:
    """Return a closed, quote-safe URI for the repository fixture tree."""
    resolved = fixture_path.resolve()
    if not resolved.is_relative_to(FIXTURES_DIR) or "'" in str(resolved):
        raise UpsertRoastVerifyError(f"rejected upsert fixture path: {fixture_path}")
    return resolved.as_uri()


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
            raise UpsertRoastVerifyError("upsert_roast returned invalid JSON") from None
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


def _stored_pair(row: object, labels: tuple[str, str] = ("ID", "PUBLIC_SLUG")) -> tuple[object, object]:
    if isinstance(row, Mapping):
        return row.get(labels[0]), row.get(labels[1])
    if isinstance(row, Sequence) and not isinstance(row, (str, bytes)) and len(row) == 2:
        return row[0], row[1]
    raise UpsertRoastVerifyError("stored roast query returned an unexpected row")


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


def _call_upsert(cursor: Cursor, payload: Mapping[str, object]) -> dict[str, object]:
    cursor.execute(
        "CALL app.upsert_roast(%s, %s)",
        (TEST_RUN_ID, json.dumps(payload, separators=(",", ":"))),
    )
    return _variant_object(_first_value(cursor.fetchone(), "UPSERT_ROAST"))


def _is_visibility_error(exc: BaseException) -> bool:
    message = str(exc).lower()
    return "-20012" in message or "visibility_change_not_supported" in message


def _cleanup(cursor: Cursor, command: str, params: Sequence[object] | None,
             errors: list[BaseException]) -> bool:
    try:
        cursor.execute(command) if params is None else cursor.execute(command, params)
        return True
    except BaseException as exc:
        errors.append(exc)
        return False


def verify_live_upsert(connection: Connection, expected_target: str) -> str:
    """Exercise staged paths, replay, rollback, and scoped opt-out purge."""
    if expected_target not in ALLOWED_TARGETS:
        raise UpsertRoastVerifyError(f"rejected upsert target: {expected_target!r}")
    if RUN_ID_PATTERN.fullmatch(TEST_RUN_ID) is None:
        raise UpsertRoastVerifyError("TEST_RUN_ID is not a lowercase UUID")
    expected_artifacts = {
        (kind, f"@app.roast_artifacts/{TEST_RUN_ID}/{basename}")
        for kind, basename in ARTIFACT_BASENAMES.items()
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
    resolved_roast_id: object | None = None
    try:
        for fixture_path in FIXTURE_PATHS:
            cursor.execute(
                f"PUT '{_validated_fixture_uri(fixture_path)}' "
                f"@app.roast_artifacts/{TEST_RUN_ID}/ "
                "AUTO_COMPRESS=FALSE OVERWRITE=TRUE"
            )
        cursor.execute(f"LIST @app.roast_artifacts/{TEST_RUN_ID}/")
        listed = {str(_first_value(row, "name")) for row in cursor.fetchall()}
        listed_basenames = {name.rsplit("/", 1)[-1] for name in listed}
        expected_staged = {path.name for path in FIXTURE_PATHS}
        if not expected_staged.issubset(listed_basenames) or any(
            name.endswith(".gz") for name in listed_basenames
        ):
            raise UpsertRoastVerifyError("staged fixture LIST is missing or compressed")

        payload = _payload()
        first = _call_upsert(cursor, payload)
        resolved_roast_id = first["cloud_roast_id"]
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
            (resolved_roast_id,),
        )
        if _count(cursor.fetchone(), "COUNT(*)") != len(ARTIFACT_KINDS):
            raise UpsertRoastVerifyError("artifact count does not match manifest")
        cursor.execute(
            "SELECT kind, stage_path FROM app.roast_artifacts WHERE roast_id = %s",
            (resolved_roast_id,),
        )
        actual_artifacts = {_stored_pair(row, ("KIND", "STAGE_PATH"))
                            for row in cursor.fetchall()}
        if actual_artifacts != expected_artifacts:
            raise UpsertRoastVerifyError("artifact kind and stage_path pairs do not match")

        preserved_select = (
            "SELECT id, idempotency_key, owner_id, public_slug, visibility, created_at, "
            "updated_at FROM app.cloud_roasts WHERE idempotency_key = %s"
        )
        cursor.execute(preserved_select, (TEST_RUN_ID,))
        before = tuple(cursor.fetchone())
        if len(before) != 7 or _stored_pair((before[0], before[3])) != (
            first["cloud_roast_id"], first["public_slug"]
        ):
            raise UpsertRoastVerifyError("stored id and slug do not match first return")
        slug_payload = dict(payload)
        slug_payload["public_slug"] = REPLAY_SLUG
        _call_upsert(cursor, slug_payload)
        cursor.execute(preserved_select, (TEST_RUN_ID,))
        after = tuple(cursor.fetchone())
        if len(after) != 7 or before[:6] != after[:6]:
            raise UpsertRoastVerifyError("slug replay changed a preserved column")
        try:
            updated_advanced = after[6] > before[6]
        except TypeError:
            updated_advanced = False
        if not updated_advanced:
            raise UpsertRoastVerifyError("slug replay did not advance updated_at")

        visibility_payload = dict(payload)
        visibility_payload["visibility"] = "unlisted"
        visibility_payload["operator_notes"] = ROLLBACK_NOTES
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
            "SELECT visibility, operator_notes FROM app.cloud_roasts "
            "WHERE idempotency_key = %s",
            (TEST_RUN_ID,),
        )
        stored_visibility, stored_notes = tuple(cursor.fetchone())
        if stored_visibility != payload["visibility"]:
            raise UpsertRoastVerifyError("failed visibility replay changed stored value")
        if stored_notes != payload["operator_notes"]:
            raise UpsertRoastVerifyError("failed visibility replay did not roll back update")

        cursor.execute(
            "INSERT INTO app.roast_telemetry "
            "(roast_id, elapsed_s, bean_temp_c, env_temp_c, heat_percent, "
            "fan_percent, ror_c_per_min, raw) "
            "SELECT %s, 0, 20, 21, 80, 30, NULL, PARSE_JSON('{}') UNION ALL "
            "SELECT %s, 5, 22, 23, 75, 35, 24, PARSE_JSON('{}') UNION ALL "
            "SELECT %s, 0, 20, 21, 80, 30, NULL, PARSE_JSON('{}')",
            (resolved_roast_id, resolved_roast_id, OTHER_ROAST_ID),
        )
        cursor.execute(
            "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
            (resolved_roast_id,),
        )
        if _count(cursor.fetchone(), "COUNT(*)") != 2:
            raise UpsertRoastVerifyError("telemetry setup did not insert two roast rows")

        opt_out_payload = dict(payload)
        opt_out_payload["contributed_to_learning"] = False
        opt_out_payload["artifact_kinds"] = []
        _call_upsert(cursor, opt_out_payload)
        cursor.execute(
            "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
            (resolved_roast_id,),
        )
        if _count(cursor.fetchone(), "COUNT(*)") != 0:
            raise UpsertRoastVerifyError("opt-out replay did not purge telemetry")
        cursor.execute(
            "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
            (OTHER_ROAST_ID,),
        )
        if _count(cursor.fetchone(), "COUNT(*)") != 1:
            raise UpsertRoastVerifyError("opt-out replay purged unrelated telemetry")
        return str(resolved_roast_id)
    except BaseException as exc:
        body_error = exc
        raise
    finally:
        cleanup_errors: list[BaseException] = []
        children_clean = resolved_roast_id is not None
        if resolved_roast_id is not None:
            children_clean = _cleanup(
                cursor, "DELETE FROM app.roast_artifacts WHERE roast_id = %s",
                (resolved_roast_id,), cleanup_errors,
            ) and children_clean
            children_clean = _cleanup(
                cursor, "DELETE FROM app.roast_telemetry WHERE roast_id = %s",
                (resolved_roast_id,), cleanup_errors,
            ) and children_clean
        _cleanup(cursor, "DELETE FROM app.roast_telemetry WHERE roast_id = %s",
                 (OTHER_ROAST_ID,), cleanup_errors)
        if children_clean:
            _cleanup(
                cursor,
                "DELETE FROM app.cloud_roasts WHERE id = %s AND idempotency_key = %s",
                (resolved_roast_id, TEST_RUN_ID), cleanup_errors,
            )
        else:
            cleanup_errors.insert(0, UpsertRoastVerifyError(
                f"parent cleanup skipped for run id {TEST_RUN_ID}: child cleanup failed"
            ))
        _cleanup(cursor, f"REMOVE @app.roast_artifacts/{TEST_RUN_ID}/", None, cleanup_errors)

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
            account=account, user=user, role=role, warehouse=warehouse,
            database=target, private_key=private_key)
    except Exception:
        raise UpsertRoastVerifyError(
            "Snowflake connection or authentication failed"
        ) from None


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, choices=sorted(ALLOWED_TARGETS))
    args = parser.parse_args(argv)
    try:
        connection = _connect(args.target)
    except UpsertRoastVerifyError as exc:
        print(f"upsert verification failed: {exc}", file=sys.stderr)
        return 1
    try:
        roast_id = verify_live_upsert(connection, args.target)
    except Exception as exc:
        print(f"upsert verification failed: {exc}", file=sys.stderr)
        return 1
    finally:
        connection.close()
    print(
        "verified UPSERT_ROAST replay preservation, visibility rollback, scoped "
        "opt-out telemetry purge, and staged artifact paths for the jsonl and "
        f"summary fixtures in {args.target} (cloud_roast_id={roast_id})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
