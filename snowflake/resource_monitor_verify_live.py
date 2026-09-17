#!/usr/bin/env python3
"""Read-only operator check of the shared warehouse resource monitor (#547)."""

from __future__ import annotations

import os
import re
import sys
from collections.abc import Mapping, Sequence
from decimal import Decimal
from pathlib import Path
from typing import Protocol

from assert_dev_ci_grants import identifiers_match, load_private_key_der

EXPECTED_MONITOR = "ROASTPILOT_MONITOR"
EXPECTED_CREDIT_QUOTA = 5
EXPECTED_FREQUENCY = "MONTHLY"
EXPECTED_NOTIFY_PCT = 50
EXPECTED_SUSPEND_PCT = 100
EXPECTED_SUSPEND_IMMEDIATE_PCT = 110  # Validated live 17 Sep 2026: ROASTPILOT_MONITOR has a 110% suspend-immediate trigger.
EXPECTED_WAREHOUSE = "ROASTPILOT_WH"
EXPECTED_SIZE = "X-Small"
EXPECTED_AUTO_SUSPEND = 60
EXPECTED_STATEMENT_TIMEOUT = 300
EXPECTED_TIMEOUT_LEVEL = "WAREHOUSE"


class ResourceMonitorVerifyError(RuntimeError):
    """The live configuration could not be proven to match the contract."""


class Cursor(Protocol):
    def execute(self, command: str) -> object: ...
    def fetchall(self) -> object: ...


class Connection(Protocol):
    def cursor(self, cursor_class: object) -> Cursor: ...
    def close(self) -> None: ...


def _rows(cursor: Cursor, query: str) -> list[Mapping[str, object]]:
    cursor.execute(query)
    result = cursor.fetchall()
    if not isinstance(result, (list, tuple)) or any(not isinstance(row, Mapping) for row in result):
        raise ResourceMonitorVerifyError(f"{query}: malformed DictCursor rows")
    return list(result)


def _field(row: Mapping[str, object], column: str, source: str) -> object:
    if column not in row:
        raise ResourceMonitorVerifyError(f"{source}: missing {column} column")
    return row[column]


def _name(row: Mapping[str, object], column: str, source: str) -> str:
    value = _field(row, column, source)
    if not isinstance(value, str):
        raise ResourceMonitorVerifyError(f"{source}: malformed name")
    return value


def _exact_row(
    rows: list[Mapping[str, object]], expected: str, source: str, column: str = "name"
) -> Mapping[str, object]:
    # SHOW ... LIKE treats _ as a wildcard. The returned name is identity.
    matches = [row for row in rows if identifiers_match(_name(row, column, source), expected)]
    if len(matches) != 1:
        raise ResourceMonitorVerifyError(f"{source}: expected exactly one {expected} row, found {len(matches)} (verify the object exists and the current role has privilege to see it; SHOW returns only objects the role can access)")
    return matches[0]


def _number(value: object, source: str) -> Decimal:
    if isinstance(value, bool):
        raise ResourceMonitorVerifyError(f"{source}: expected a number")
    if isinstance(value, str):
        if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", value) is None:
            raise ResourceMonitorVerifyError(f"{source}: expected a number")
    elif type(value) not in (int, float, Decimal):
        raise ResourceMonitorVerifyError(f"{source}: expected a number")
    number = Decimal(str(value))
    if not number.is_finite():
        raise ResourceMonitorVerifyError(f"{source}: expected a finite number")
    return number


def _percentages(value: object, source: str) -> list[int]:
    # Validated live 17 Sep 2026: SHOW returns "50%", "100%", "110%" and comma-lists such as "50%,90%"; split/strip parsing works.
    if type(value) is int and value >= 0:
        return [value]
    if not isinstance(value, str):
        raise ResourceMonitorVerifyError(f"{source}: malformed trigger percentages")
    parts = [part.strip().removesuffix("%").strip() for part in value.split(",")]
    if any(re.fullmatch(r"[0-9]+", part) is None for part in parts):
        raise ResourceMonitorVerifyError(f"{source}: malformed trigger percentages")
    return [int(part) for part in parts]


def _integer(value: object, source: str) -> int:
    number = _number(value, source)
    if number != int(number):
        raise ResourceMonitorVerifyError(f"{source}: expected an integer")
    return int(number)


def verify_live(connection: Connection) -> None:
    """Read three SHOW result sets and reject any drift or unknown shape."""
    import snowflake.connector

    cursor = connection.cursor(snowflake.connector.DictCursor)
    cursor.execute("USE SECONDARY ROLES NONE")

    monitor = _exact_row(_rows(cursor, "SHOW RESOURCE MONITORS"), EXPECTED_MONITOR, "SHOW RESOURCE MONITORS")
    quota = _number(_field(monitor, "credit_quota", "monitor"), "monitor credit_quota")
    if quota != EXPECTED_CREDIT_QUOTA:
        raise ResourceMonitorVerifyError("monitor credit_quota differs from expected 5")
    frequency = _field(monitor, "frequency", "monitor")
    # Validated live 17 Sep 2026: frequency returns uppercase "MONTHLY".
    if not isinstance(frequency, str) or frequency.strip().upper() != EXPECTED_FREQUENCY:
        raise ResourceMonitorVerifyError("monitor frequency differs from expected MONTHLY")
    notify = _percentages(_field(monitor, "notify_at", "monitor"), "monitor notify_at")
    if EXPECTED_NOTIFY_PCT not in notify:
        raise ResourceMonitorVerifyError("monitor notify_at lacks expected 50")
    suspend = _percentages(_field(monitor, "suspend_at", "monitor"), "monitor suspend_at")
    if suspend != [EXPECTED_SUSPEND_PCT]:
        raise ResourceMonitorVerifyError("monitor suspend_at differs from expected 100")
    immediate = _percentages(_field(monitor, "suspend_immediately_at", "monitor"), "monitor suspend_immediately_at")
    if immediate != [EXPECTED_SUSPEND_IMMEDIATE_PCT]:
        raise ResourceMonitorVerifyError("monitor suspend_immediately_at differs from expected 110")

    warehouse_query = f"SHOW WAREHOUSES LIKE '{EXPECTED_WAREHOUSE}'"
    warehouse = _exact_row(_rows(cursor, warehouse_query), EXPECTED_WAREHOUSE, warehouse_query)
    size = _field(warehouse, "size", "warehouse")
    if type(size) is not str or size != EXPECTED_SIZE:
        raise ResourceMonitorVerifyError("warehouse size differs from expected X-Small")
    suspend_seconds = _integer(_field(warehouse, "auto_suspend", "warehouse"), "warehouse auto_suspend")
    if suspend_seconds != EXPECTED_AUTO_SUSPEND:
        raise ResourceMonitorVerifyError("warehouse auto_suspend differs from expected 60")
    resume = _field(warehouse, "auto_resume", "warehouse")
    if resume is not True and resume not in ("true", "TRUE"):
        raise ResourceMonitorVerifyError("warehouse auto_resume is not true")
    bound_monitor = _field(warehouse, "resource_monitor", "warehouse")
    if type(bound_monitor) is not str or not identifiers_match(bound_monitor, EXPECTED_MONITOR):
        raise ResourceMonitorVerifyError("warehouse resource_monitor differs from expected ROASTPILOT_MONITOR")

    parameter_query = f"SHOW PARAMETERS LIKE 'STATEMENT_TIMEOUT_IN_SECONDS' IN WAREHOUSE {EXPECTED_WAREHOUSE}"
    timeout_rows = _rows(cursor, parameter_query)
    timeout = _exact_row(timeout_rows, "STATEMENT_TIMEOUT_IN_SECONDS", parameter_query, "key")
    seconds = _integer(_field(timeout, "value", "statement timeout"), "statement timeout value")
    if seconds != EXPECTED_STATEMENT_TIMEOUT:
        raise ResourceMonitorVerifyError("warehouse statement timeout differs from expected 300")
    level = _field(timeout, "level", "statement timeout")
    # Validated live 17 Sep 2026: parameter level returns uppercase "WAREHOUSE".
    if not isinstance(level, str) or level.strip().upper() != EXPECTED_TIMEOUT_LEVEL:
        raise ResourceMonitorVerifyError("warehouse statement timeout is not set at warehouse level")


def _required_env(name: str) -> str:  # pragma: no cover; pragma: no mutate block - operator connection boundary
    value = os.environ.get(name)
    if not value:
        raise ResourceMonitorVerifyError(f"missing required environment variable: {name}")
    return value


def _connect() -> Connection:  # pragma: no cover; pragma: no mutate block - real operator connection
    import snowflake.connector

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
        private_key=private_key,
    )


def main(argv: Sequence[str] | None = None) -> int:  # pragma: no cover; pragma: no mutate block - CLI wrapper
    if (sys.argv[1:] if argv is None else argv):
        print("resource monitor verification failed: unexpected arguments", file=sys.stderr)
        return 1
    connection: Connection | None = None
    close_failed = False
    try:
        connection = _connect()
        verify_live(connection)
    except ResourceMonitorVerifyError as exc:
        print(f"resource monitor verification failed: {exc}", file=sys.stderr)
        return 1
    except Exception:
        print("resource monitor verification failed: unexpected error", file=sys.stderr)
        return 1
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:
                print("resource monitor verification: failed to close connection", file=sys.stderr)
                close_failed = True
    if close_failed:
        return 1
    print("resource monitor verification passed")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
