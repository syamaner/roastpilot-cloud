#!/usr/bin/env python3
"""Operator-run live verification for LOAD_ROAST_TELEMETRY (issue #416)."""
from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from collections.abc import Callable, Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol


SNOWFLAKE_DIR = Path(__file__).resolve().parent
FIXTURE_PATH = SNOWFLAKE_DIR / "fixtures" / "m1-export" / "session-1" / "roast.jsonl"
ALLOWED_TARGETS = frozenset({"ROASTPILOT_PREVIEW", "ROASTPILOT_DEV"})
TEST_RUN_ID = "c3_s1_live_verify"
TEST_ROAST_ID = "c3c3c3c3-4160-4160-4160-c3c3c3c3c3c3"
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


class Cursor(Protocol):
    def execute(self, command: str, params: Sequence[object] | None = None) -> Any: ...
    def fetchone(self) -> object: ...
    def fetchall(self) -> Sequence[Sequence[object]]: ...


class Connection(Protocol):
    def cursor(self) -> Cursor: ...
    def close(self) -> None: ...


class TelemetryVerifyError(RuntimeError):
    """Raised when live telemetry differs from the fixture-derived contract."""


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
        return row.get(label)
    if isinstance(row, Sequence) and not isinstance(row, (str, bytes)) and row:
        return row[0]
    return None


def verify_live_load(
    connection: Connection,
    fixture_path: Path,
    expected_target: str,
) -> int:
    """PUT one real fixture, call the proc, and compare every loaded value."""
    if expected_target not in ALLOWED_TARGETS:
        raise TelemetryVerifyError(f"rejected telemetry target: {expected_target!r}")
    expected_dicts = _load_test_helper()(fixture_path, TEST_ROAST_ID)
    expected = [tuple(row[column] for column in SELECT_COLUMNS) for row in expected_dicts]
    cursor = connection.cursor()
    cursor.execute("USE SECONDARY ROLES NONE")
    cursor.execute("SELECT CURRENT_DATABASE()")
    if _first_value(cursor.fetchone(), "CURRENT_DATABASE()") != expected_target:
        raise TelemetryVerifyError("connected database does not match target")

    cursor.execute(
        f"PUT '{fixture_path.resolve().as_uri()}' "
        f"@app.roast_artifacts/{TEST_RUN_ID} AUTO_COMPRESS=FALSE OVERWRITE=TRUE"
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
    return len(actual)


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
