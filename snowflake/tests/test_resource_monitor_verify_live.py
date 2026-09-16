"""Fail-closed checks for the operator's read-only monitor verifier."""

from __future__ import annotations

import sys
from copy import deepcopy
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from resource_monitor_verify_live import ResourceMonitorVerifyError, _percentages, verify_live  # noqa: E402

MONITOR_QUERY = "SHOW RESOURCE MONITORS"
WAREHOUSE_QUERY = "SHOW WAREHOUSES LIKE 'ROASTPILOT_WH'"
TIMEOUT_QUERY = "SHOW PARAMETERS LIKE 'STATEMENT_TIMEOUT_IN_SECONDS' IN WAREHOUSE ROASTPILOT_WH"
QUERIES = ["USE SECONDARY ROLES NONE", MONITOR_QUERY, WAREHOUSE_QUERY, TIMEOUT_QUERY]


def good_rows() -> dict[str, list[dict[str, object]]]:
    return {
        MONITOR_QUERY: [{
            "name": "ROASTPILOT_MONITOR",
            "credit_quota": "5",
            "frequency": "MONTHLY",
            "notify_at": "50",
            "suspend_at": "100",
            "suspend_immediately_at": "110",
        }],
        WAREHOUSE_QUERY: [{
            "name": "ROASTPILOT_WH",
            "size": "X-Small",
            "auto_suspend": "60",
            "auto_resume": "true",
            "resource_monitor": "ROASTPILOT_MONITOR",
        }],
        TIMEOUT_QUERY: [{
            "key": "STATEMENT_TIMEOUT_IN_SECONDS",
            "value": "300",
            "level": "WAREHOUSE",
        }],
    }


class MockDictCursor:
    def __init__(self, rows: dict[str, object]) -> None:
        self.rows = rows
        self.commands: list[str] = []

    def execute(self, command: str) -> None:
        self.commands.append(command)

    def fetchall(self) -> object:
        return deepcopy(self.rows[self.commands[-1]])


class MockConnection:
    def __init__(self, rows: dict[str, object]) -> None:
        self.mock_cursor = MockDictCursor(rows)
        self.cursor_class: object | None = None

    def cursor(self, cursor_class: object) -> MockDictCursor:
        self.cursor_class = cursor_class
        return self.mock_cursor

    def close(self) -> None:
        pass


def run(rows: dict[str, object]) -> MockConnection:
    import snowflake.connector

    connection = MockConnection(rows)
    verify_live(connection)
    assert connection.cursor_class is snowflake.connector.DictCursor
    assert connection.mock_cursor.commands == QUERIES
    return connection


def test_all_correct_and_warehouse_level_timeout() -> None:
    rows = good_rows()
    assert rows[TIMEOUT_QUERY][0]["level"] == "WAREHOUSE"
    run(rows)


def test_timeout_level_casing_and_whitespace_normalised() -> None:
    rows = good_rows()
    rows[TIMEOUT_QUERY][0]["level"] = "warehouse "
    run(rows)


def test_numeric_values_and_hardened_timeout_pass() -> None:
    rows = good_rows()
    rows[MONITOR_QUERY][0]["credit_quota"] = 5
    rows[WAREHOUSE_QUERY][0]["auto_suspend"] = 60
    rows[TIMEOUT_QUERY][0]["value"] = 300
    run(rows)


@pytest.mark.parametrize(
    ("value", "expected"),
    [(0, [0]), (50, [50]), (" 50% , 80% ", [50, 80])],
)
def test_percentage_parser_accepts_numeric_boundary_and_show_formats(
    value: object, expected: list[int]
) -> None:
    assert _percentages(value, "monitor notify_at") == expected


@pytest.mark.parametrize("value", [-1, "50,", "50,bad%"])
def test_percentage_parser_rejects_malformed_values(value: object) -> None:
    with pytest.raises(ResourceMonitorVerifyError) as exc:
        _percentages(value, "monitor notify_at")
    assert str(exc.value) == "monitor notify_at: malformed trigger percentages"


def test_frequency_casing_and_whitespace_normalised() -> None:
    rows = good_rows()
    rows[MONITOR_QUERY][0]["frequency"] = "monthly "
    run(rows)


@pytest.mark.parametrize("notify", ["50,80", "80,50", "50%", "50,80%", " 50% , 80% ", 50])
def test_notify_can_have_other_thresholds(notify: object) -> None:
    rows = good_rows()
    rows[MONITOR_QUERY][0]["notify_at"] = notify
    run(rows)


def test_percent_suffixed_suspend_thresholds_pass() -> None:
    rows = good_rows()
    rows[MONITOR_QUERY][0]["suspend_at"] = " 100% "
    rows[MONITOR_QUERY][0]["suspend_immediately_at"] = "110%"
    run(rows)


@pytest.mark.parametrize("resume", ["true", "TRUE", True])
def test_known_good_auto_resume(resume: object) -> None:
    rows = good_rows()
    rows[WAREHOUSE_QUERY][0]["auto_resume"] = resume
    run(rows)


@pytest.mark.parametrize(
    ("query", "column", "value", "message"),
    [
        (MONITOR_QUERY, "credit_quota", "4", "monitor credit_quota differs from expected 5"),
        (MONITOR_QUERY, "credit_quota", "5 ", "monitor credit_quota: expected a number"),
        (MONITOR_QUERY, "frequency", "DAILY", "monitor frequency differs from expected MONTHLY"),
        (MONITOR_QUERY, "frequency", "WEEKLY", "monitor frequency differs from expected MONTHLY"),
        (MONITOR_QUERY, "notify_at", "80", "monitor notify_at lacks expected 50"),
        (MONITOR_QUERY, "suspend_at", "90", "monitor suspend_at differs from expected 100"),
        (MONITOR_QUERY, "suspend_immediately_at", "120", "monitor suspend_immediately_at differs from expected 110"),
        (WAREHOUSE_QUERY, "size", "Small", "warehouse size differs from expected X-Small"),
        (WAREHOUSE_QUERY, "auto_suspend", "600", "warehouse auto_suspend differs from expected 60"),
        (WAREHOUSE_QUERY, "auto_resume", "false", "warehouse auto_resume is not true"),
        (WAREHOUSE_QUERY, "auto_resume", "", "warehouse auto_resume is not true"),
        (WAREHOUSE_QUERY, "auto_resume", "unknown", "warehouse auto_resume is not true"),
        (WAREHOUSE_QUERY, "resource_monitor", "", "warehouse resource_monitor differs from expected ROASTPILOT_MONITOR"),
        (WAREHOUSE_QUERY, "resource_monitor", "OTHER_MONITOR", "warehouse resource_monitor differs from expected ROASTPILOT_MONITOR"),
        (TIMEOUT_QUERY, "value", "172800", "warehouse statement timeout differs from expected 300"),
        (TIMEOUT_QUERY, "value", "0", "warehouse statement timeout differs from expected 300"),
        (TIMEOUT_QUERY, "value", "600", "warehouse statement timeout differs from expected 300"),
        (TIMEOUT_QUERY, "value", "", "statement timeout value: expected a number"),
        (TIMEOUT_QUERY, "value", "abc", "statement timeout value: expected a number"),
        (TIMEOUT_QUERY, "level", "ACCOUNT", "warehouse statement timeout is not set at warehouse level"),
        (TIMEOUT_QUERY, "level", "", "warehouse statement timeout is not set at warehouse level"),
        (MONITOR_QUERY, "credit_quota", "five", "monitor credit_quota: expected a number"),
        (MONITOR_QUERY, "credit_quota", True, "monitor credit_quota: expected a number"),
    ],
)
def test_drift_rejected(query: str, column: str, value: object, message: str) -> None:
    rows = good_rows()
    rows[query][0][column] = value
    with pytest.raises(ResourceMonitorVerifyError, match=f"^{message}$"):
        run(rows)


@pytest.mark.parametrize(
    ("query", "column", "message"),
    [
        (MONITOR_QUERY, "name", f"{MONITOR_QUERY}: missing name column"),
        (MONITOR_QUERY, "credit_quota", "monitor: missing credit_quota column"),
        (MONITOR_QUERY, "frequency", "monitor: missing frequency column"),
        (MONITOR_QUERY, "notify_at", "monitor: missing notify_at column"),
        (MONITOR_QUERY, "suspend_at", "monitor: missing suspend_at column"),
        (MONITOR_QUERY, "suspend_immediately_at", "monitor: missing suspend_immediately_at column"),
        (WAREHOUSE_QUERY, "name", f"{WAREHOUSE_QUERY}: missing name column"),
        (WAREHOUSE_QUERY, "size", "warehouse: missing size column"),
        (WAREHOUSE_QUERY, "auto_suspend", "warehouse: missing auto_suspend column"),
        (WAREHOUSE_QUERY, "auto_resume", "warehouse: missing auto_resume column"),
        (WAREHOUSE_QUERY, "resource_monitor", "warehouse: missing resource_monitor column"),
        (TIMEOUT_QUERY, "value", "statement timeout: missing value column"),
        (TIMEOUT_QUERY, "level", "statement timeout: missing level column"),
        (TIMEOUT_QUERY, "key", f"{TIMEOUT_QUERY}: missing key column"),
    ],
)
def test_missing_column_rejected(query: str, column: str, message: str) -> None:
    rows = good_rows()
    del rows[query][0][column]
    with pytest.raises(ResourceMonitorVerifyError) as exc:
        run(rows)
    assert str(exc.value) == message


@pytest.mark.parametrize("query", [MONITOR_QUERY, WAREHOUSE_QUERY, TIMEOUT_QUERY])
def test_required_row_absent(query: str) -> None:
    rows = good_rows()
    rows[query] = []
    with pytest.raises(ResourceMonitorVerifyError) as exc:
        run(rows)
    expected = {
        MONITOR_QUERY: "ROASTPILOT_MONITOR",
        WAREHOUSE_QUERY: "ROASTPILOT_WH",
        TIMEOUT_QUERY: "STATEMENT_TIMEOUT_IN_SECONDS",
    }[query]
    assert str(exc.value) == f"{query}: expected exactly one {expected} row, found 0"


@pytest.mark.parametrize("query", [MONITOR_QUERY, WAREHOUSE_QUERY, TIMEOUT_QUERY])
def test_exact_row_overmatch_rejected(query: str) -> None:
    rows = good_rows()
    rows[query].append(deepcopy(rows[query][0]))
    with pytest.raises(ResourceMonitorVerifyError) as exc:
        run(rows)
    expected = {
        MONITOR_QUERY: "ROASTPILOT_MONITOR",
        WAREHOUSE_QUERY: "ROASTPILOT_WH",
        TIMEOUT_QUERY: "STATEMENT_TIMEOUT_IN_SECONDS",
    }[query]
    assert str(exc.value) == f"{query}: expected exactly one {expected} row, found 2"


@pytest.mark.parametrize("query", [MONITOR_QUERY, WAREHOUSE_QUERY, TIMEOUT_QUERY])
def test_byte_exact_name_post_filter(query: str) -> None:
    rows = good_rows()
    name_column = "key" if query == TIMEOUT_QUERY else "name"
    rows[query][0][name_column] = "ROASTPILOT0WH" if query == WAREHOUSE_QUERY else "lookalike"
    with pytest.raises(ResourceMonitorVerifyError) as exc:
        run(rows)
    assert str(exc.value).startswith(f"{query}: expected exactly one ")
    assert str(exc.value).endswith("row, found 0")


@pytest.mark.parametrize("query", [MONITOR_QUERY, WAREHOUSE_QUERY, TIMEOUT_QUERY])
def test_malformed_name_rejected(query: str) -> None:
    rows = good_rows()
    name_column = "key" if query == TIMEOUT_QUERY else "name"
    rows[query][0][name_column] = None
    with pytest.raises(ResourceMonitorVerifyError) as exc:
        run(rows)
    assert str(exc.value) == f"{query}: malformed name"


@pytest.mark.parametrize("query", [MONITOR_QUERY, WAREHOUSE_QUERY, TIMEOUT_QUERY])
@pytest.mark.parametrize("bad_rows", [None, {}, [None]])
def test_unknown_cursor_shape_rejected(query: str, bad_rows: object) -> None:
    rows = good_rows()
    rows[query] = bad_rows
    with pytest.raises(ResourceMonitorVerifyError) as exc:
        run(rows)
    assert str(exc.value) == f"{query}: malformed DictCursor rows"


@pytest.mark.parametrize(
    ("value", "message"),
    [
        (None, "monitor credit_quota: expected a number"),
        (False, "monitor credit_quota: expected a number"),
        (5.5, "monitor credit_quota differs from expected 5"),
        ("NaN", "monitor credit_quota: expected a number"),
        ("Infinity", "monitor credit_quota: expected a number"),
        (float("nan"), "monitor credit_quota: expected a finite number"),
        (float("inf"), "monitor credit_quota: expected a finite number"),
        ([], "monitor credit_quota: expected a number"),
        ({}, "monitor credit_quota: expected a number"),
    ],
)
def test_unknown_quota_shape_rejected(value: object, message: str) -> None:
    rows = good_rows()
    rows[MONITOR_QUERY][0]["credit_quota"] = value
    with pytest.raises(ResourceMonitorVerifyError) as exc:
        run(rows)
    assert str(exc.value) == message


@pytest.mark.parametrize("value", [None, "", "50,", "50.0", "50%%", "50,bad%", True])
def test_malformed_notify_shape_rejected(value: object) -> None:
    rows = good_rows()
    rows[MONITOR_QUERY][0]["notify_at"] = value
    with pytest.raises(ResourceMonitorVerifyError) as exc:
        run(rows)
    assert str(exc.value) == "monitor notify_at: malformed trigger percentages"


@pytest.mark.parametrize("column", ["suspend_at", "suspend_immediately_at"])
def test_malformed_suspend_trigger_shape_rejected(column: str) -> None:
    rows = good_rows()
    rows[MONITOR_QUERY][0][column] = "bad"
    with pytest.raises(ResourceMonitorVerifyError) as exc:
        run(rows)
    assert str(exc.value) == f"monitor {column}: malformed trigger percentages"


@pytest.mark.parametrize("value", ["0.5", True, None])
def test_invalid_auto_suspend_rejected(value: object) -> None:
    rows = good_rows()
    rows[WAREHOUSE_QUERY][0]["auto_suspend"] = value
    with pytest.raises(ResourceMonitorVerifyError) as exc:
        run(rows)
    if value == "0.5":
        assert str(exc.value) == "warehouse auto_suspend: expected an integer"


@pytest.mark.parametrize("value", ["0.5", True, None])
def test_invalid_timeout_rejected(value: object) -> None:
    rows = good_rows()
    rows[TIMEOUT_QUERY][0]["value"] = value
    with pytest.raises(ResourceMonitorVerifyError) as exc:
        run(rows)
    if value == "0.5":
        assert str(exc.value) == "statement timeout value: expected an integer"
