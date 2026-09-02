"""Contract tests for the operator-run live upsert verifier (issue #417)."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import upsert_roast_verify_live  # noqa: E402


ROAST_ID = "c3c3c3c3-4170-4170-4170-c3c3c3c3c3c3"
FIRST_RESULT = {
    "cloud_roast_id": ROAST_ID,
    "public_slug": upsert_roast_verify_live.PUBLIC_SLUG,
}


class FakeCursor:
    def __init__(
        self,
        *,
        database: str = "ROASTPILOT_DEV",
        role: str = "ROASTPILOT_AGENT",
        replay_result: dict[str, object] | None = None,
        artifact_paths: set[str] | None = None,
        visibility_raises: bool = True,
        visibility_error: str = "-20012 visibility_change_not_supported",
        telemetry_survives: bool = False,
        fail_on: set[str] | None = None,
    ) -> None:
        self.database = database
        self.role = role
        self.replay_result = FIRST_RESULT if replay_result is None else replay_result
        self.artifact_paths = (
            {
                f"@app.roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/"
                f"{upsert_roast_verify_live.ARTIFACT_BASENAMES[kind]}"
                for kind in upsert_roast_verify_live.ARTIFACT_KINDS
            }
            if artifact_paths is None
            else artifact_paths
        )
        self.visibility_raises = visibility_raises
        self.visibility_error = visibility_error
        self.telemetry_survives = telemetry_survives
        self.fail_on = set() if fail_on is None else fail_on
        self.executed: list[tuple[str, tuple[object, ...] | None]] = []
        self.call_results: list[dict[str, object]] = []
        self.telemetry_present = False
        self.last_call_result: dict[str, object] | None = None

    def execute(self, command: str, params=None):
        normalized = tuple(params) if params is not None else None
        self.executed.append((command, normalized))
        if any(command.startswith(prefix) for prefix in self.fail_on):
            raise RuntimeError(f"scripted cleanup failure: {command.split()[0]}")
        if command.startswith("CALL app.upsert_roast"):
            assert normalized is not None
            payload = json.loads(str(normalized[1]))
            if payload["visibility"] == "private":
                if self.visibility_raises:
                    raise RuntimeError(self.visibility_error)
                self.last_call_result = FIRST_RESULT
            elif payload["contributed_to_learning"] is False:
                if not self.telemetry_survives:
                    self.telemetry_present = False
                self.last_call_result = FIRST_RESULT
            elif len(self.call_results) == 1:
                self.last_call_result = self.replay_result
            else:
                self.last_call_result = FIRST_RESULT
            self.call_results.append(self.last_call_result)
        elif command.startswith("INSERT INTO app.roast_telemetry"):
            self.telemetry_present = True
        return self

    def fetchone(self):
        command = self.executed[-1][0]
        if command == "SELECT CURRENT_DATABASE()":
            return (self.database,)
        if command == "SELECT CURRENT_ROLE()":
            return (self.role,)
        if command.startswith("CALL app.upsert_roast"):
            return (self.last_call_result,)
        if command.startswith("SELECT COUNT(*) FROM app.cloud_roasts"):
            return (1,)
        if command.startswith("SELECT COUNT(*) FROM app.roast_artifacts"):
            return (len(upsert_roast_verify_live.ARTIFACT_KINDS),)
        if command.startswith("SELECT id, public_slug"):
            return (ROAST_ID, upsert_roast_verify_live.PUBLIC_SLUG)
        if command.startswith("SELECT visibility"):
            return ("unlisted",)
        if command.startswith("SELECT COUNT(*) FROM app.roast_telemetry"):
            return (2 if self.telemetry_present else 0,)
        raise AssertionError(f"unexpected fetchone after: {command}")

    def fetchall(self):
        return [(path,) for path in sorted(self.artifact_paths)]


class FakeConnection:
    def __init__(self, **cursor_options: object) -> None:
        self.fake_cursor = FakeCursor(**cursor_options)
        self.closed = False

    def cursor(self):
        return self.fake_cursor

    def close(self) -> None:
        self.closed = True


def _commands(connection: FakeConnection) -> list[str]:
    return [command for command, _ in connection.fake_cursor.executed]


def _cleanup_commands() -> list[str]:
    return [
        "DELETE FROM app.roast_artifacts WHERE roast_id IN "
        "(SELECT id FROM app.cloud_roasts WHERE idempotency_key = %s)",
        "DELETE FROM app.roast_telemetry WHERE roast_id IN "
        "(SELECT id FROM app.cloud_roasts WHERE idempotency_key = %s)",
        "DELETE FROM app.cloud_roasts WHERE idempotency_key = %s",
        f"REMOVE @app.roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/",
    ]


def test_test_run_id_is_a_lowercase_uuid() -> None:
    assert re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        upsert_roast_verify_live.TEST_RUN_ID,
    )
    assert upsert_roast_verify_live.RUN_ID_PATTERN.fullmatch(
        upsert_roast_verify_live.TEST_RUN_ID
    )


def test_first_value_reads_mapping_by_label() -> None:
    assert upsert_roast_verify_live._first_value(
        {"CURRENT_DATABASE()": "ROASTPILOT_DEV"},
        "CURRENT_DATABASE()",
    ) == "ROASTPILOT_DEV"


def test_happy_path_pins_assertions_calls_binding_and_cleanup() -> None:
    connection = FakeConnection()

    assert upsert_roast_verify_live.verify_live_upsert(
        connection, "ROASTPILOT_DEV"
    ) == ROAST_ID

    commands = _commands(connection)
    assert commands[:3] == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_DATABASE()",
        "SELECT CURRENT_ROLE()",
    ]
    calls = [entry for entry in connection.fake_cursor.executed if entry[0].startswith("CALL")]
    assert len(calls) == 5
    assert all(command == "CALL app.upsert_roast(%s, %s)" for command, _ in calls)
    assert all(params is not None and params[0] == upsert_roast_verify_live.TEST_RUN_ID
               for _, params in calls)
    assert calls[0][1] == calls[1][1]
    assert json.loads(str(calls[2][1][1]))["public_slug"] == (
        upsert_roast_verify_live.REPLAY_SLUG
    )
    assert json.loads(str(calls[3][1][1]))["visibility"] == "private"
    opt_out = json.loads(str(calls[4][1][1]))
    assert opt_out["contributed_to_learning"] is False
    assert opt_out["artifact_kinds"] == []
    assert not any(command.startswith("PUT ") for command in commands)
    assert commands[-4:] == _cleanup_commands()
    assert connection.fake_cursor.executed[-4:-1] == [
        (command, (upsert_roast_verify_live.TEST_RUN_ID,))
        for command in _cleanup_commands()[:3]
    ]


def test_main_connects_verifies_prints_self_describing_evidence_and_closes(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    connection = FakeConnection()
    monkeypatch.setattr(upsert_roast_verify_live, "_connect", lambda _target: connection)

    assert upsert_roast_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 0
    assert connection.closed is True
    output = capsys.readouterr().out
    assert "UPSERT_ROAST" in output
    assert "idempotent replay" in output
    assert "exact artifact paths" in output
    assert "visibility rejection" in output
    assert "opt-out telemetry purge" in output
    assert ROAST_ID in output


def test_allowed_targets_are_dev_only_and_preview_is_rejected() -> None:
    assert upsert_roast_verify_live.ALLOWED_TARGETS == frozenset({"ROASTPILOT_DEV"})
    connection = FakeConnection()
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="rejected upsert target",
    ):
        upsert_roast_verify_live.verify_live_upsert(
            connection, "ROASTPILOT_PREVIEW"
        )
    assert connection.fake_cursor.executed == []


def test_parser_rejects_non_dev_target_before_connect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connected = False

    def unexpected_connect(_target: str):
        nonlocal connected
        connected = True
        raise AssertionError("connect must not run")

    monkeypatch.setattr(upsert_roast_verify_live, "_connect", unexpected_connect)
    with pytest.raises(SystemExit):
        upsert_roast_verify_live.main(["--target", "ROASTPILOT_PREVIEW"])
    assert connected is False


def test_database_mismatch_rejects_before_any_write() -> None:
    connection = FakeConnection(database="ROASTPILOT_PROD")
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="connected database does not match target",
    ):
        upsert_roast_verify_live.verify_live_upsert(connection, "ROASTPILOT_DEV")
    assert _commands(connection) == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_DATABASE()",
    ]


def test_role_mismatch_rejects_before_any_write() -> None:
    connection = FakeConnection(role="ACCOUNTADMIN")
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="connected role is not ROASTPILOT_AGENT",
    ):
        upsert_roast_verify_live.verify_live_upsert(connection, "ROASTPILOT_DEV")
    assert _commands(connection) == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_DATABASE()",
        "SELECT CURRENT_ROLE()",
    ]


def test_replay_equality_mismatch_is_detected_and_cleaned() -> None:
    connection = FakeConnection(
        replay_result={"cloud_roast_id": ROAST_ID, "public_slug": "HGFEDCBA987654321"}
    )
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="identical replay returned a different object",
    ):
        upsert_roast_verify_live.verify_live_upsert(connection, "ROASTPILOT_DEV")
    assert _commands(connection)[-4:] == _cleanup_commands()


def test_stage_path_set_mismatch_is_detected() -> None:
    connection = FakeConnection(artifact_paths={"@app.roast_artifacts/wrong/path"})
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="artifact stage paths do not match manifest",
    ):
        upsert_roast_verify_live.verify_live_upsert(connection, "ROASTPILOT_DEV")


def test_visibility_call_not_raising_is_a_failure() -> None:
    connection = FakeConnection(visibility_raises=False)
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="visibility replay unexpectedly succeeded",
    ):
        upsert_roast_verify_live.verify_live_upsert(connection, "ROASTPILOT_DEV")
    assert _commands(connection)[-4:] == _cleanup_commands()


def test_unexpected_visibility_error_is_not_swallowed() -> None:
    connection = FakeConnection(visibility_error="-20009 invalid payload")
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="visibility replay failed with an unexpected error",
    ) as raised:
        upsert_roast_verify_live.verify_live_upsert(connection, "ROASTPILOT_DEV")
    assert isinstance(raised.value.__cause__, RuntimeError)


def test_telemetry_purge_assertion_fails_when_rows_survive() -> None:
    connection = FakeConnection(telemetry_survives=True)
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="opt-out replay did not purge telemetry",
    ):
        upsert_roast_verify_live.verify_live_upsert(connection, "ROASTPILOT_DEV")
    assert _commands(connection)[-4:] == _cleanup_commands()


def test_cleanup_runs_on_success_and_binds_run_id() -> None:
    connection = FakeConnection()
    upsert_roast_verify_live.verify_live_upsert(connection, "ROASTPILOT_DEV")

    assert _commands(connection)[-4:] == _cleanup_commands()
    assert all(
        params == (upsert_roast_verify_live.TEST_RUN_ID,)
        for _, params in connection.fake_cursor.executed[-4:-1]
    )


def test_cleanup_runs_on_body_error() -> None:
    connection = FakeConnection(artifact_paths=set())
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError):
        upsert_roast_verify_live.verify_live_upsert(connection, "ROASTPILOT_DEV")
    assert _commands(connection)[-4:] == _cleanup_commands()


def test_cleanup_errors_are_notes_and_do_not_mask_body_error() -> None:
    connection = FakeConnection(
        replay_result={"cloud_roast_id": "different", "public_slug": "different"},
        fail_on={
            "DELETE FROM app.roast_artifacts",
            "DELETE FROM app.roast_telemetry",
        },
    )
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="identical replay returned a different object",
    ) as raised:
        upsert_roast_verify_live.verify_live_upsert(connection, "ROASTPILOT_DEV")

    assert _commands(connection)[-4:] == _cleanup_commands()
    assert raised.value.__notes__ == [
        "cleanup failed: RuntimeError('scripted cleanup failure: DELETE')",
        "cleanup failed: RuntimeError('scripted cleanup failure: DELETE')",
    ]


def test_cleanup_error_surfaces_when_body_succeeds() -> None:
    connection = FakeConnection(fail_on={"DELETE FROM app.roast_artifacts"})
    with pytest.raises(RuntimeError, match="scripted cleanup failure: DELETE"):
        upsert_roast_verify_live.verify_live_upsert(connection, "ROASTPILOT_DEV")
    assert _commands(connection)[-4:] == _cleanup_commands()
