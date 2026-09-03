#!/usr/bin/env python3
"""Operator-run live verification for UPSERT_ROAST (issue #417).

Only JSONL and summary fixtures are staged; no roast.csv exists. ``bean_origin``
and ``roast_level`` are deliberately null so recompute returns through its
null-grouping-key branch. Populating them would write a shared reference-summary
row this verifier cannot safely clean up, so AC-3's recompute write path is
deliberately not exercised live here.
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


def _validated_fixture_uri(fixture_path: Path) -> str:
    """Return a closed, quote-safe URI for the repository fixture tree."""
    resolved = fixture_path.resolve()
    if not resolved.is_relative_to(FIXTURES_DIR) or "'" in str(resolved):
        raise UpsertRoastVerifyError(f"rejected upsert fixture path: {fixture_path}")
    # Path.as_uri(), not the apostrophe pre-check, closes the PUT literal: it
    # percent-encodes every path byte outside the RFC 3986 unreserved set.
    return resolved.as_uri()


def _first_value(row: object, label: str) -> object:
    if isinstance(row, Mapping):
        return row.get(label)
    if isinstance(row, Sequence) and not isinstance(row, (str, bytes)) and row:
        return row[0]
    return None


def _row_values(row: object, labels: Sequence[str]) -> tuple[object, ...]:
    if isinstance(row, Mapping):
        if any(label not in row for label in labels):
            raise UpsertRoastVerifyError("live query returned an incomplete row")
        return tuple(row[label] for label in labels)
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


def _cleanup(
    cursor: Cursor,
    command: str,
    params: Sequence[object] | None,
    step: str,
    errors: list[BaseException],
) -> bool:
    try:
        _execute(cursor, command, params, step)
        return True
    except UpsertRoastVerifyError as exc:
        errors.append(exc)
        return False


def verify_live_upsert(connection: Connection, expected_target: str) -> str:
    """Exercise staged paths, replay, rollback, and scoped opt-out purge."""
    if expected_target not in ALLOWED_TARGETS:
        raise UpsertRoastVerifyError(f"rejected upsert target: {expected_target!r}")
    if RUN_ID_PATTERN.fullmatch(TEST_RUN_ID) is None:
        raise UpsertRoastVerifyError("TEST_RUN_ID is not a lowercase UUID")

    staged_names = {path.name for path in FIXTURE_PATHS}
    if not staged_names <= set(ARTIFACT_BASENAMES.values()):
        raise UpsertRoastVerifyError(
            "staged fixture names are outside artifact grammar"
        )
    expected_artifacts = {
        (kind, f"@app.roast_artifacts/{TEST_RUN_ID}/{basename}")
        for kind, basename in ARTIFACT_BASENAMES.items()
    }

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

    body_error: BaseException | None = None
    resolved_roast_id: object | None = None
    sentinel_owned = False
    try:
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
        listed_names = {
            str(_first_value(row, "name")).rsplit("/", 1)[-1]
            for row in listed_rows
        }
        if listed_names != staged_names or any(
            name.endswith(".gz") for name in listed_names
        ):
            raise UpsertRoastVerifyError(
                "staged fixture LIST is not exact or uncompressed"
            )

        payload = _payload()
        first = _call_upsert(cursor, payload)
        resolved_roast_id = first["cloud_roast_id"]
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
            raise UpsertRoastVerifyError("replay did not leave exactly one roast")
        if second != first:
            raise UpsertRoastVerifyError("identical replay returned a different object")

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

        preserved_select = (
            "SELECT id, idempotency_key, owner_id, public_slug, visibility, "
            "created_at, updated_at FROM app.cloud_roasts WHERE idempotency_key = %s"
        )
        before = _row_values(
            _fetchone(
                cursor,
                preserved_select,
                (TEST_RUN_ID,),
                "pre-replay preserved-column query",
            ),
            PRESERVED_COLUMNS,
        )
        if _stored_pair((before[0], before[3])) != (
            first["cloud_roast_id"],
            first["public_slug"],
        ):
            raise UpsertRoastVerifyError("stored id and slug do not match first return")

        slug_payload = dict(payload)
        slug_payload["public_slug"] = REPLAY_SLUG
        _call_upsert(cursor, slug_payload)
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
                "visibility rollback query",
            ),
            ("VISIBILITY", "OPERATOR_NOTES", "UPDATED_AT"),
        )
        if visibility_state[0] != payload["visibility"]:
            raise UpsertRoastVerifyError(
                "failed visibility replay changed stored value"
            )
        if visibility_state[1] != payload["operator_notes"]:
            raise UpsertRoastVerifyError(
                "failed visibility replay did not roll back update"
            )
        if visibility_state[2] != after[6]:
            raise UpsertRoastVerifyError("failed visibility replay changed updated_at")

        _execute(
            cursor,
            "DELETE FROM app.roast_telemetry WHERE roast_id = %s",
            (OTHER_ROAST_ID,),
            "sentinel pre-cleanup",
        )
        sentinel_owned = True
        sentinel_before_row = _fetchone(
            cursor,
            "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
            (OTHER_ROAST_ID,),
            "sentinel baseline query",
        )
        sentinel_before = _count(sentinel_before_row, "COUNT(*)")
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
            raise UpsertRoastVerifyError(
                "telemetry setup did not insert two roast rows"
            )

        _call_upsert(cursor, payload)
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

        opt_out_payload = dict(payload)
        opt_out_payload["contributed_to_learning"] = False
        opt_out_payload["artifact_kinds"] = []
        if set(opt_out_payload) != set(payload):
            raise UpsertRoastVerifyError("opt-out payload changed the closed key set")
        _call_upsert(cursor, opt_out_payload)
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
        if sentinel_after - sentinel_before != 1:
            raise UpsertRoastVerifyError("opt-out replay changed unrelated telemetry")
        return str(resolved_roast_id)
    except BaseException as exc:
        if isinstance(exc, UpsertRoastVerifyError):
            body_error = exc
            raise
        body_error = UpsertRoastVerifyError("live verification body failed")
        raise body_error from exc
    finally:
        cleanup_errors: list[BaseException] = []
        children_clean = True
        if resolved_roast_id is None:
            _cleanup(
                cursor,
                "DELETE FROM app.cloud_roasts WHERE idempotency_key = %s",
                (TEST_RUN_ID,),
                "safety-net parent cleanup",
                cleanup_errors,
            )
        else:
            artifact_clean = _cleanup(
                cursor,
                "DELETE FROM app.roast_artifacts WHERE roast_id = %s",
                (resolved_roast_id,),
                "artifact cleanup",
                cleanup_errors,
            )
            telemetry_clean = _cleanup(
                cursor,
                "DELETE FROM app.roast_telemetry WHERE roast_id = %s",
                (resolved_roast_id,),
                "roast telemetry cleanup",
                cleanup_errors,
            )
            children_clean = artifact_clean and telemetry_clean
            if children_clean:
                _cleanup(
                    cursor,
                    "DELETE FROM app.cloud_roasts "
                    "WHERE id = %s AND idempotency_key = %s",
                    (resolved_roast_id, TEST_RUN_ID),
                    "parent cleanup",
                    cleanup_errors,
                )
            else:
                cleanup_errors.insert(
                    0,
                    UpsertRoastVerifyError(
                        f"parent cleanup skipped for run id {TEST_RUN_ID}: "
                        "child cleanup failed"
                    ),
                )

        if sentinel_owned:
            _cleanup(
                cursor,
                "DELETE FROM app.roast_telemetry WHERE roast_id = %s",
                (OTHER_ROAST_ID,),
                "sentinel telemetry cleanup",
                cleanup_errors,
            )

        remove_ran = False
        if children_clean:
            remove_ran = _cleanup(
                cursor,
                f"REMOVE @app.roast_artifacts/{TEST_RUN_ID}/",
                None,
                "stage REMOVE cleanup",
                cleanup_errors,
            )
        if remove_ran:
            try:
                remaining = _fetchall(
                    cursor,
                    f"LIST @app.roast_artifacts/{TEST_RUN_ID}/",
                    None,
                    "post-REMOVE LIST cleanup",
                )
            except UpsertRoastVerifyError as exc:
                cleanup_errors.append(exc)
            else:
                if remaining:
                    cleanup_errors.append(
                        UpsertRoastVerifyError("stage REMOVE verification failed")
                    )

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
            account=account,
            user=user,
            role=role,
            warehouse=warehouse,
            database=target,
            private_key=private_key,
        )
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
        close_error = UpsertRoastVerifyError("Snowflake connection close failed")
        if failure is None:
            failure = close_error
        else:
            failure.add_note(f"cleanup failed: {close_error!r}")
    if failure is not None:
        print(f"upsert verification failed: {failure}", file=sys.stderr)
        return 1

    print(
        "verified UPSERT_ROAST replay preservation, visibility rollback, conditional "
        "and scoped opt-out telemetry purge, and staged artifact PUT/REMOVE paths for "
        f"the jsonl and summary fixtures in {args.target} (cloud_roast_id={roast_id})"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
