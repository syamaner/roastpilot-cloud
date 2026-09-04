#!/usr/bin/env python3
"""Operator-run live verification for LOAD_ROAST_TELEMETRY (#416/#419).

This serial-operator-only verifier owns fixed roast, run, stage-prefix, and
reference-summary keys. It refuses to run if any are already present, then
cleans only those keys. The fixture and all synthesized rows are de-identified.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sys
from collections.abc import Callable, Mapping, Sequence
from decimal import Decimal
from pathlib import Path
from typing import Any, Protocol


SNOWFLAKE_DIR = Path(__file__).resolve().parent
FIXTURES_DIR = (SNOWFLAKE_DIR / "fixtures").resolve()
FIXTURE_PATH = SNOWFLAKE_DIR / "fixtures" / "m1-export" / "session-1" / "roast.jsonl"
ALLOWED_TARGETS = frozenset({"ROASTPILOT_DEV"})
EXPECTED_ROLE = "ROASTPILOT_AGENT"
TEST_RUN_ID = "41900000-0000-0000-0000-000000000001"
TEST_ROAST_ID = "c3c3c3c3-4160-4160-4160-c3c3c3c3c3c3"
SENTINEL_ROAST_ID = "41900000-0000-0000-0000-000000000002"
MISSING_ROAST_ID = "41900000-0000-0000-0000-000000000003"
PUBLIC_SLUG = "419419419ABCDEFGH"
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


def _validated_fixture_uri(fixture_path: Path) -> str:
    """Return a closed, quote-safe URI for the repository fixture tree."""
    resolved = fixture_path.resolve()
    if not resolved.is_relative_to(FIXTURES_DIR) or "'" in str(resolved):
        raise TelemetryVerifyError(f"rejected telemetry fixture path: {fixture_path}")
    return resolved.as_uri()


def _load_test_helper() -> Callable[[Path, str], list[dict[str, object]]]:
    """Import the fixture expectation from its path-anchored test helper."""
    helper_path = SNOWFLAKE_DIR / "tests" / "test_load_roast_telemetry.py"
    spec = importlib.util.spec_from_file_location("telemetry_contract_helper", helper_path)
    if spec is None or spec.loader is None:  # pragma: no cover
        raise ImportError(f"cannot load telemetry contract helper from {helper_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    helper = getattr(module, "fixture_expected_rows")
    return helper


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


def _summary_row(cursor: Cursor) -> tuple[object, ...]:
    cursor.execute(
        f"SELECT {', '.join(SUMMARY_COLUMNS)} FROM app.reference_roast_summaries "
        "WHERE bean_origin = %s AND roast_level = %s",
        (BEAN_ORIGIN, ROAST_LEVEL),
    )
    return _row_values(
        cursor.fetchone(), tuple(column.upper() for column in SUMMARY_COLUMNS)
    )


def verify_live_load(
    connection: Connection,
    fixture_path: Path,
    expected_target: str,
) -> int:
    """Verify fail-closed consent, opted-in load, summaries, and artifacts."""
    if expected_target not in ALLOWED_TARGETS:
        raise TelemetryVerifyError(f"rejected telemetry target: {expected_target!r}")
    if UUID_PATTERN.fullmatch(TEST_RUN_ID) is None:
        raise TelemetryVerifyError("TEST_RUN_ID is not a lowercase UUID")
    if UUID_PATTERN.fullmatch(TEST_ROAST_ID) is None:
        raise TelemetryVerifyError("TEST_ROAST_ID is not a lowercase UUID")
    if UUID_PATTERN.fullmatch(SENTINEL_ROAST_ID) is None:
        raise TelemetryVerifyError("SENTINEL_ROAST_ID is not a lowercase UUID")
    if UUID_PATTERN.fullmatch(MISSING_ROAST_ID) is None:
        raise TelemetryVerifyError("MISSING_ROAST_ID is not a lowercase UUID")
    fixture_uri = _validated_fixture_uri(fixture_path)
    expected_dicts = _load_test_helper()(fixture_path, TEST_ROAST_ID)
    expected = [tuple(row[column] for column in SELECT_COLUMNS) for row in expected_dicts]
    cursor = connection.cursor()
    cursor.execute("USE SECONDARY ROLES NONE")
    cursor.execute("SELECT CURRENT_DATABASE()")
    if _first_value(cursor.fetchone(), "CURRENT_DATABASE()") != expected_target:
        raise TelemetryVerifyError("connected database does not match target")
    cursor.execute("SELECT CURRENT_ROLE()")
    if _first_value(cursor.fetchone(), "CURRENT_ROLE()") != EXPECTED_ROLE:
        raise TelemetryVerifyError("connected role is not ROASTPILOT_AGENT")

    cursor.execute(
        "SELECT COUNT(*) FROM app.cloud_roasts "
        "WHERE id IN (%s, %s, %s) OR idempotency_key = %s OR public_slug = %s",
        (
            TEST_ROAST_ID,
            SENTINEL_ROAST_ID,
            MISSING_ROAST_ID,
            TEST_RUN_ID,
            PUBLIC_SLUG,
        ),
    )
    if _count(cursor.fetchone()) != 0:
        raise TelemetryVerifyError("telemetry verifier roast keys are already owned")
    cursor.execute(
        "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id IN (%s, %s, %s)",
        (TEST_ROAST_ID, SENTINEL_ROAST_ID, MISSING_ROAST_ID),
    )
    if _count(cursor.fetchone()) != 0:
        raise TelemetryVerifyError("telemetry verifier row keys are already owned")
    cursor.execute(
        "SELECT COUNT(*) FROM app.roast_artifacts WHERE roast_id = %s",
        (TEST_ROAST_ID,),
    )
    if _count(cursor.fetchone()) != 0:
        raise TelemetryVerifyError("telemetry verifier artifact key is already owned")
    cursor.execute(
        "SELECT COUNT(*) FROM app.reference_roast_summaries "
        "WHERE bean_origin = %s AND roast_level = %s",
        (BEAN_ORIGIN, ROAST_LEVEL),
    )
    if _count(cursor.fetchone()) != 0:
        raise TelemetryVerifyError("telemetry verifier summary key is already owned")
    cursor.execute(f"LIST @app.roast_artifacts/{TEST_RUN_ID}/")
    if cursor.fetchall():
        raise TelemetryVerifyError("telemetry verifier stage prefix is already owned")

    body_error: BaseException | None = None
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

        cursor.execute(
            "INSERT INTO app.cloud_roasts "
            "(id, idempotency_key, owner_id, public_slug, visibility, bean_origin, "
            "bean_varietal, bean_weight_g, profile_name, roast_level, summary, "
            "operator_rating, operator_notes, contributed_to_learning, roasted_at_utc) "
            "SELECT %s, %s, NULL, %s, 'private', %s, 'C3-S4 live verifier', 250, "
            "'telemetry consent verification', %s, PARSE_JSON(%s), 4, NULL, FALSE, "
            "'2026-09-02T12:00:00Z'::timestamp_tz",
            (
                TEST_ROAST_ID,
                TEST_RUN_ID,
                PUBLIC_SLUG,
                BEAN_ORIGIN,
                ROAST_LEVEL,
                json.dumps(SUMMARY, separators=(",", ":")),
            ),
        )
        cursor.execute(
            "INSERT INTO app.roast_telemetry "
            "(roast_id, elapsed_s, bean_temp_c, env_temp_c, heat_percent, "
            "fan_percent, ror_c_per_min, raw) "
            "VALUES (%s, 0, 20, 21, 80, 30, NULL, PARSE_JSON('{}'))",
            (SENTINEL_ROAST_ID,),
        )

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
            raise TelemetryVerifyError(
                "opt-out roast contributed to the reference summary"
            )

        cursor.execute(
            "UPDATE app.cloud_roasts SET contributed_to_learning = TRUE "
            "WHERE id = %s AND idempotency_key = %s",
            (TEST_ROAST_ID, TEST_RUN_ID),
        )
        cursor.execute(
            "CALL app.load_roast_telemetry(%s, %s)",
            (TEST_RUN_ID, TEST_ROAST_ID),
        )
        loaded = _first_value(cursor.fetchone(), "LOAD_ROAST_TELEMETRY")
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
        body_error = exc
        raise
    finally:
        cleanup_errors: list[BaseException] = []
        cleanup_statements: tuple[tuple[str, tuple[object, ...] | None], ...] = (
            (
                "DELETE FROM app.roast_telemetry WHERE roast_id IN (%s, %s, %s)",
                (TEST_ROAST_ID, SENTINEL_ROAST_ID, MISSING_ROAST_ID),
            ),
            (
                "DELETE FROM app.roast_artifacts WHERE roast_id = %s",
                (TEST_ROAST_ID,),
            ),
            (
                "DELETE FROM app.cloud_roasts WHERE id = %s AND idempotency_key = %s",
                (TEST_ROAST_ID, TEST_RUN_ID),
            ),
            (
                "DELETE FROM app.reference_roast_summaries "
                "WHERE bean_origin = %s AND roast_level = %s",
                (BEAN_ORIGIN, ROAST_LEVEL),
            ),
            (f"REMOVE @app.roast_artifacts/{TEST_RUN_ID}/", None),
        )
        for command, params in cleanup_statements:
            try:
                if params is None:
                    cursor.execute(command)
                else:
                    cursor.execute(command, params)
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
        raise TelemetryVerifyError(f"missing required environment variable: {name}")
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
        # Commit direct setup before owner-rights upsert opens its transaction;
        # also persist ordered cleanup rather than relying on connection close.
        autocommit=True,
    )


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, choices=sorted(ALLOWED_TARGETS))
    args = parser.parse_args(argv)
    connection = _connect(args.target)
    try:
        count = verify_live_load(connection, FIXTURE_PATH, args.target)
    except Exception as exc:
        print(f"telemetry verification failed: {exc}", file=sys.stderr)
        return 1
    finally:
        connection.close()
    print(f"verified {count} telemetry rows in {args.target}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
