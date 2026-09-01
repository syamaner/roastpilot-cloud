"""Contract tests for the operator-run live telemetry verifier (issue #416)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import load_telemetry_verify_live  # noqa: E402


EXPECTED_ROW = {
    "roast_id": load_telemetry_verify_live.TEST_ROAST_ID,
    "elapsed_s": 8.25,
    "bean_temp_c": 24.0,
    "env_temp_c": 25.0,
    "heat_percent": 10,
    "fan_percent": 20,
    "ror_c_per_min": None,
    "raw": None,
}
EXPECTED_TUPLE = tuple(
    EXPECTED_ROW[column] for column in load_telemetry_verify_live.SELECT_COLUMNS
)


class FakeCursor:
    def __init__(
        self,
        *,
        database: str = "ROASTPILOT_DEV",
        loaded: object = "1",
        actual: list[tuple[object, ...]] | None = None,
        fail_on: str | None = None,
    ) -> None:
        self.database = database
        self.loaded = loaded
        self.actual = [EXPECTED_TUPLE] if actual is None else actual
        self.fail_on = fail_on
        self.executed: list[tuple[str, tuple[object, ...] | None]] = []

    def execute(self, command: str, params=None):
        normalized = tuple(params) if params is not None else None
        self.executed.append((command, normalized))
        if self.fail_on is not None and command.startswith(self.fail_on):
            raise RuntimeError("scripted telemetry verification failure")
        return self

    def fetchone(self):
        command = self.executed[-1][0]
        if command == "SELECT CURRENT_DATABASE()":
            return (self.database,)
        if command.startswith("CALL app.load_roast_telemetry"):
            return (self.loaded,)
        raise AssertionError(f"unexpected fetchone after: {command}")

    def fetchall(self):
        return self.actual


class FakeConnection:
    def __init__(self, **cursor_options: object) -> None:
        self.fake_cursor = FakeCursor(**cursor_options)
        self.closed = False

    def cursor(self):
        return self.fake_cursor

    def close(self) -> None:
        self.closed = True


def _patch_expected_helper(monkeypatch: pytest.MonkeyPatch) -> None:
    helper = lambda _path, _roast_id: [EXPECTED_ROW]  # noqa: E731
    monkeypatch.setattr(
        load_telemetry_verify_live,
        "_load_test_helper",
        lambda: helper,
    )


def _commands(connection: FakeConnection) -> list[str]:
    return [command for command, _ in connection.fake_cursor.executed]


def test_happy_path_pins_put_call_select_and_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection()

    assert load_telemetry_verify_live.verify_live_load(
        connection,
        load_telemetry_verify_live.FIXTURE_PATH,
        "ROASTPILOT_DEV",
    ) == 1

    commands = _commands(connection)
    assert commands[0:2] == ["USE SECONDARY ROLES NONE", "SELECT CURRENT_DATABASE()"]
    assert commands[2] == (
        f"PUT '{load_telemetry_verify_live.FIXTURE_PATH.resolve().as_uri()}' "
        f"@app.roast_artifacts/{load_telemetry_verify_live.TEST_RUN_ID} "
        "AUTO_COMPRESS=FALSE OVERWRITE=TRUE"
    )
    assert connection.fake_cursor.executed[3] == (
        "CALL app.load_roast_telemetry(%s, %s)",
        (
            load_telemetry_verify_live.TEST_RUN_ID,
            load_telemetry_verify_live.TEST_ROAST_ID,
        ),
    )
    assert commands[4] == (
        f"SELECT {', '.join(load_telemetry_verify_live.SELECT_COLUMNS)} "
        "FROM app.roast_telemetry WHERE roast_id = %s ORDER BY elapsed_s"
    )
    assert commands[-2:] == [
        "DELETE FROM app.roast_telemetry WHERE roast_id = %s",
        f"REMOVE @app.roast_artifacts/{load_telemetry_verify_live.TEST_RUN_ID}/",
    ]


def test_allowed_targets_are_dev_only_and_preview_is_rejected() -> None:
    assert load_telemetry_verify_live.ALLOWED_TARGETS == frozenset({"ROASTPILOT_DEV"})
    connection = FakeConnection()
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match="rejected telemetry target",
    ):
        load_telemetry_verify_live.verify_live_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_PREVIEW",
        )
    assert connection.fake_cursor.executed == []


def test_database_mismatch_rejects_before_put_or_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(database="ROASTPILOT_PROD")
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match="connected database does not match target",
    ):
        load_telemetry_verify_live.verify_live_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )
    assert _commands(connection) == ["USE SECONDARY ROLES NONE", "SELECT CURRENT_DATABASE()"]


def test_row_count_mismatch_is_detected(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(loaded="2")
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match="procedure row count",
    ):
        load_telemetry_verify_live.verify_live_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )


def test_actual_value_mismatch_is_detected(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_expected_helper(monkeypatch)
    mismatched = list(EXPECTED_TUPLE)
    mismatched[2] = 99.0
    connection = FakeConnection(actual=[tuple(mismatched)])
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match="loaded telemetry does not match fixture expectation",
    ):
        load_telemetry_verify_live.verify_live_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )


@pytest.mark.parametrize(
    "fixture_path",
    [
        Path("/tmp/outside-fixtures.jsonl"),
        load_telemetry_verify_live.FIXTURES_DIR / "bad'fixture.jsonl",
    ],
)
def test_fixture_path_must_be_under_fixtures_and_quote_free(fixture_path: Path) -> None:
    connection = FakeConnection()
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match="rejected telemetry fixture path",
    ):
        load_telemetry_verify_live.verify_live_load(
            connection,
            fixture_path,
            "ROASTPILOT_DEV",
        )
    assert connection.fake_cursor.executed == []


def test_cleanup_runs_when_the_live_body_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(fail_on="CALL app.load_roast_telemetry")
    with pytest.raises(RuntimeError, match="scripted telemetry verification failure"):
        load_telemetry_verify_live.verify_live_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )
    assert _commands(connection)[-2:] == [
        "DELETE FROM app.roast_telemetry WHERE roast_id = %s",
        f"REMOVE @app.roast_artifacts/{load_telemetry_verify_live.TEST_RUN_ID}/",
    ]
