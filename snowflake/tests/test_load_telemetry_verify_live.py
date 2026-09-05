"""Contract tests for the operator-run live telemetry verifier (issue #416)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import load_telemetry_verify_live  # noqa: E402


STAND_IN_ROW = {
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
    STAND_IN_ROW[column] for column in load_telemetry_verify_live.SELECT_COLUMNS
)
SUMMARY_BEFORE = (0, 0, None, None, None, None, None, None, None, None)
SUMMARY_AFTER_OPT_IN = (1, 0, None, 24.0, None, 147.0, None, 25.0, 590.0, 1190.0)


class FakeCursor:
    def __init__(
        self,
        *,
        database: str = "ROASTPILOT_DEV",
        role: str = "ROASTPILOT_AGENT",
        loaded: object = "1",
        actual: list[tuple[object, ...]] | None = None,
        fail_on: str | None = None,
        cleanup_error_text: str = "scripted telemetry verification failure",
        cloud_preflight_count: object = 0,
        telemetry_preflight_count: object = 0,
        artifact_preflight_count: object = 0,
        summary_preflight_count: object = 0,
        stage_preflight_rows: tuple[str, ...] = (),
        missing_raises: bool = True,
        missing_error: str = "-20013 Roast has not consented to learning",
        missing_telemetry_count: object = 0,
        opt_out_raises: bool = True,
        opt_out_error: str = "-20013 Roast has not consented to learning",
        manifest_raises: bool = True,
        manifest_error: str = (
            "-20009 Payload does not match the closed roast grammar"
        ),
        summary_after_opt_out: tuple[object, ...] = SUMMARY_BEFORE,
        summary_after_opt_in: tuple[object, ...] = SUMMARY_AFTER_OPT_IN,
        rejected_manifest_artifact_count: object = 0,
        empty_manifest_artifact_count: object = 0,
    ) -> None:
        self.database = database
        self.role = role
        self.loaded = loaded
        self.actual = [EXPECTED_TUPLE] if actual is None else actual
        self.fail_on = fail_on
        self.cleanup_error_text = cleanup_error_text
        self.cloud_preflight_count = cloud_preflight_count
        self.telemetry_preflight_count = telemetry_preflight_count
        self.artifact_preflight_count = artifact_preflight_count
        self.summary_preflight_count = summary_preflight_count
        self.stage_preflight_rows = stage_preflight_rows
        self.missing_raises = missing_raises
        self.missing_error = missing_error
        self.missing_telemetry_count = missing_telemetry_count
        self.opt_out_raises = opt_out_raises
        self.opt_out_error = opt_out_error
        self.manifest_raises = manifest_raises
        self.manifest_error = manifest_error
        self.summary_rows = (
            summary_after_opt_out,
            summary_after_opt_in,
        )
        self.rejected_manifest_artifact_count = rejected_manifest_artifact_count
        self.empty_manifest_artifact_count = empty_manifest_artifact_count
        self.executed: list[tuple[str, tuple[object, ...] | None]] = []
        self.contributing = False
        self.summary_reads = 0
        self.sentinel_present = False
        self.last_upsert_kind: str | None = None

    def execute(self, command: str, params=None):
        normalized = tuple(params) if params is not None else None
        self.executed.append((command, normalized))
        load_roast_id = (
            normalized[1]
            if command.startswith("CALL app.load_roast_telemetry")
            and normalized is not None
            else None
        )
        expected_guard_call = (
            load_roast_id == load_telemetry_verify_live.MISSING_ROAST_ID
            or (
                load_roast_id == load_telemetry_verify_live.TEST_ROAST_ID
                and not self.contributing
            )
        )
        if (
            self.fail_on is not None
            and command.startswith(self.fail_on)
            and not expected_guard_call
        ):
            raise RuntimeError(self.cleanup_error_text)
        if command.startswith("INSERT INTO app.roast_telemetry"):
            self.sentinel_present = True
        elif command.startswith("UPDATE app.cloud_roasts"):
            self.contributing = True
        elif command.startswith("CALL app.load_roast_telemetry"):
            if load_roast_id == load_telemetry_verify_live.MISSING_ROAST_ID:
                if self.missing_raises:
                    raise RuntimeError(self.missing_error)
            elif not self.contributing:
                if self.opt_out_raises:
                    raise RuntimeError(self.opt_out_error)
            return self
        elif command.startswith("CALL app.upsert_roast"):
            assert normalized is not None
            payload = json.loads(str(normalized[1]))
            if payload["contributed_to_learning"] is False and payload["artifact_kinds"]:
                self.last_upsert_kind = "rejected_manifest"
                if self.manifest_raises:
                    raise RuntimeError(self.manifest_error)
            elif payload["contributed_to_learning"] is False:
                self.last_upsert_kind = "empty_manifest"
            else:
                self.last_upsert_kind = "contributing"
        return self

    def fetchone(self):
        command = self.executed[-1][0]
        if command == "SELECT CURRENT_DATABASE()":
            return (self.database,)
        if command == "SELECT CURRENT_ROLE()":
            return (self.role,)
        if command.startswith("SELECT COUNT(*) FROM app.cloud_roasts"):
            return (self.cloud_preflight_count,)
        if command.startswith("SELECT COUNT(*) FROM app.roast_artifacts"):
            if self.last_upsert_kind == "rejected_manifest":
                return (self.rejected_manifest_artifact_count,)
            if self.last_upsert_kind == "empty_manifest":
                return (self.empty_manifest_artifact_count,)
            return (self.artifact_preflight_count,)
        if command.startswith("SELECT COUNT(*) FROM app.reference_roast_summaries"):
            return (self.summary_preflight_count,)
        if command.startswith("SELECT COUNT(*) FROM app.roast_telemetry"):
            assert self.executed[-1][1] is not None
            if " IN " in command:
                return (self.telemetry_preflight_count,)
            roast_id = self.executed[-1][1][0]
            if roast_id == load_telemetry_verify_live.MISSING_ROAST_ID:
                return (self.missing_telemetry_count,)
            if roast_id == load_telemetry_verify_live.SENTINEL_ROAST_ID:
                return (1 if self.sentinel_present else 0,)
            return (0,)
        if command.startswith(
            "SELECT " + ", ".join(load_telemetry_verify_live.SUMMARY_COLUMNS)
        ):
            row = self.summary_rows[self.summary_reads]
            self.summary_reads += 1
            return row
        if command.startswith("CALL app.upsert_roast"):
            return (
                {
                    "cloud_roast_id": load_telemetry_verify_live.TEST_ROAST_ID,
                    "public_slug": load_telemetry_verify_live.PUBLIC_SLUG,
                },
            )
        if command.startswith("CALL app.load_roast_telemetry"):
            return (self.loaded,)
        raise AssertionError(f"unexpected fetchone after: {command}")

    def fetchall(self):
        command = self.executed[-1][0]
        if command.startswith("LIST "):
            return [(row,) for row in self.stage_preflight_rows]
        if command.startswith("SELECT roast_id, elapsed_s"):
            return self.actual
        raise AssertionError(f"unexpected fetchall after: {command}")


class FakeConnection:
    def __init__(
        self,
        *,
        close_error_text: str | None = None,
        **cursor_options: object,
    ) -> None:
        self.fake_cursor = FakeCursor(**cursor_options)
        self.close_error_text = close_error_text
        self.closed = False

    def cursor(self):
        return self.fake_cursor

    def close(self) -> None:
        self.closed = True
        if self.close_error_text is not None:
            raise RuntimeError(self.close_error_text)


def _patch_expected_helper(monkeypatch: pytest.MonkeyPatch) -> None:
    helper = lambda _path, _roast_id: [STAND_IN_ROW]  # noqa: E731
    monkeypatch.setattr(
        load_telemetry_verify_live,
        "_load_test_helper",
        lambda: helper,
    )


def _commands(connection: FakeConnection) -> list[str]:
    return [command for command, _ in connection.fake_cursor.executed]


def test_real_fixture_helper_derives_session_one_first_row() -> None:
    first_row = load_telemetry_verify_live._load_test_helper()(
        load_telemetry_verify_live.FIXTURE_PATH,
        load_telemetry_verify_live.TEST_ROAST_ID,
    )[0]

    assert first_row == {
        "roast_id": load_telemetry_verify_live.TEST_ROAST_ID,
        "elapsed_s": 8.32387712498894,
        "bean_temp_c": 24.0,
        "env_temp_c": 24.0,
        "heat_percent": 0,
        "fan_percent": 0,
        "ror_c_per_min": None,
        "raw": None,
    }


def test_first_value_reads_mapping_by_label() -> None:
    assert load_telemetry_verify_live._first_value(
        {"CURRENT_DATABASE()": "ROASTPILOT_DEV"},
        "CURRENT_DATABASE()",
    ) == "ROASTPILOT_DEV"


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
    assert commands[0:3] == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_DATABASE()",
        "SELECT CURRENT_ROLE()",
    ]
    assert commands.index("SELECT CURRENT_ROLE()") < next(
        index for index, command in enumerate(commands) if command.startswith("PUT ")
    )
    put = (
        f"PUT '{load_telemetry_verify_live.FIXTURE_PATH.resolve().as_uri()}' "
        f"@app.roast_artifacts/{load_telemetry_verify_live.TEST_RUN_ID} "
        "AUTO_COMPRESS=FALSE OVERWRITE=TRUE"
    )
    positive_call = (
        "CALL app.load_roast_telemetry(%s, %s)",
        (
            load_telemetry_verify_live.TEST_RUN_ID,
            load_telemetry_verify_live.TEST_ROAST_ID,
        ),
    )
    telemetry_select = (
        f"SELECT {', '.join(load_telemetry_verify_live.SELECT_COLUMNS)} "
        "FROM app.roast_telemetry WHERE roast_id = %s ORDER BY elapsed_s",
        (load_telemetry_verify_live.TEST_ROAST_ID,),
    )
    put_index = commands.index(put)
    update_index = next(
        index for index, command in enumerate(commands)
        if command.startswith("UPDATE app.cloud_roasts SET contributed_to_learning = TRUE")
    )
    positive_call_index = connection.fake_cursor.executed.index(
        positive_call, update_index
    )
    select_index = connection.fake_cursor.executed.index(
        telemetry_select, positive_call_index
    )
    assert put_index < update_index < positive_call_index < select_index
    load_roast_ids = [
        params[1]
        for command, params in connection.fake_cursor.executed
        if command.startswith("CALL app.load_roast_telemetry") and params is not None
    ]
    assert load_roast_ids == [
        load_telemetry_verify_live.MISSING_ROAST_ID,
        load_telemetry_verify_live.TEST_ROAST_ID,
        load_telemetry_verify_live.TEST_ROAST_ID,
    ]
    assert not any(
        command.startswith("CALL app.recompute_reference_summary")
        for command in commands
    )
    assert "SELECT COUNT(*) FROM app.data_quality_violations" not in commands
    upsert_payloads = [
        json.loads(str(params[1]))
        for command, params in connection.fake_cursor.executed
        if command.startswith("CALL app.upsert_roast") and params is not None
    ]
    assert [payload["contributed_to_learning"] for payload in upsert_payloads] == [
        False,
        False,
        True,
    ]
    assert connection.fake_cursor.executed[-5:] == [
        (
            "DELETE FROM app.roast_telemetry WHERE roast_id IN (%s, %s, %s)",
            (
                load_telemetry_verify_live.TEST_ROAST_ID,
                load_telemetry_verify_live.SENTINEL_ROAST_ID,
                load_telemetry_verify_live.MISSING_ROAST_ID,
            ),
        ),
        (
            "DELETE FROM app.roast_artifacts WHERE roast_id = %s",
            (load_telemetry_verify_live.TEST_ROAST_ID,),
        ),
        (
            "DELETE FROM app.cloud_roasts WHERE id = %s AND idempotency_key = %s",
            (
                load_telemetry_verify_live.TEST_ROAST_ID,
                load_telemetry_verify_live.TEST_RUN_ID,
            ),
        ),
        (
            "DELETE FROM app.reference_roast_summaries "
            "WHERE bean_origin = %s AND roast_level = %s",
            (
                load_telemetry_verify_live.BEAN_ORIGIN,
                load_telemetry_verify_live.ROAST_LEVEL,
            ),
        ),
        (
            f"REMOVE @app.roast_artifacts/{load_telemetry_verify_live.TEST_RUN_ID}/",
            None,
        ),
    ]


def test_main_connects_verifies_and_closes(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection()
    monkeypatch.setattr(load_telemetry_verify_live, "_connect", lambda _target: connection)

    assert load_telemetry_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 0
    assert connection.closed is True
    captured = capsys.readouterr()
    assert captured.out == "verified 1 telemetry rows in ROASTPILOT_DEV\n"
    assert captured.err == ""


def test_main_connect_failure_is_sanitised_load_telemetry(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def fail_connect(_target: str) -> None:
        raise RuntimeError(
            "account=SENTINELHOST.snowflakecomputing.com "
            "private_key=/secret/keys/agent.p8"
        )

    monkeypatch.setattr(load_telemetry_verify_live, "_connect", fail_connect)

    assert load_telemetry_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    captured = capsys.readouterr()
    assert "Snowflake connection or authentication failed" in captured.err
    assert "SENTINELHOST" not in captured.err
    assert "/secret/keys/agent.p8" not in captured.err


def test_main_key_read_failure_is_sanitised_load_telemetry(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def fail_connect(_target: str) -> None:
        raise FileNotFoundError("/secret/keys/agent.p8")

    monkeypatch.setattr(load_telemetry_verify_live, "_connect", fail_connect)

    assert load_telemetry_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    captured = capsys.readouterr()
    assert "Snowflake connection or authentication failed" in captured.err
    assert "SENTINELHOST" not in captured.err
    assert "/secret/keys/agent.p8" not in captured.err


def test_main_connect_validation_error_keeps_detail_load_telemetry(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def fail_connect(_target: str) -> None:
        raise load_telemetry_verify_live.TelemetryVerifyError(
            "missing required environment variable: SNOWFLAKE_ACCOUNT"
        )

    monkeypatch.setattr(load_telemetry_verify_live, "_connect", fail_connect)

    assert load_telemetry_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    captured = capsys.readouterr()
    assert captured.err == (
        "telemetry verification failed: missing required environment variable: "
        "SNOWFLAKE_ACCOUNT\n"
    )


def test_main_sanitises_an_unexpected_raw_failure(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    connection = FakeConnection()

    def failing_verify(_connection, _fixture_path, _target) -> int:
        raise RuntimeError(
            "account ab12345.eu-west-1.snowflakecomputing.com at /Users/op/key.p8"
        )

    monkeypatch.setattr(load_telemetry_verify_live, "_connect", lambda _target: connection)
    monkeypatch.setattr(load_telemetry_verify_live, "verify_live_load", failing_verify)

    assert load_telemetry_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == (
        "telemetry verification failed: telemetry verification failed\n"
    )
    assert "snowflakecomputing.com" not in captured.err
    assert "/Users/op" not in captured.err
    assert connection.closed is True


def test_main_surfaces_sanitised_close_failure_after_body_succeeds(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(
        close_error_text=(
            "close failed at ab12345.eu-west-1.snowflakecomputing.com "
            "/Users/op/key.p8"
        )
    )
    monkeypatch.setattr(load_telemetry_verify_live, "_connect", lambda _target: connection)

    assert load_telemetry_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.splitlines() == [
        "telemetry verification failed: telemetry verification cleanup failed",
        f"cleanup failed for run id {load_telemetry_verify_live.TEST_RUN_ID}: "
        "Snowflake connection close failed",
    ]
    assert "snowflakecomputing.com" not in captured.err
    assert "/Users/op" not in captured.err
    assert connection.closed is True


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
    assert _commands(connection) == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_DATABASE()",
    ]


def test_role_mismatch_rejects_before_put_or_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(role="ACCOUNTADMIN")
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match="connected role is not ROASTPILOT_AGENT",
    ):
        load_telemetry_verify_live.verify_live_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )
    assert _commands(connection) == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_DATABASE()",
        "SELECT CURRENT_ROLE()",
    ]


def _assert_preflight_collision(
    monkeypatch: pytest.MonkeyPatch,
    message: str,
    **cursor_options: object,
) -> FakeConnection:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(**cursor_options)
    with pytest.raises(load_telemetry_verify_live.TelemetryVerifyError, match=message):
        load_telemetry_verify_live.verify_live_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )
    mutation_prefixes = ("PUT ", "INSERT ", "UPDATE ", "DELETE ", "REMOVE ", "CALL ")
    assert not any(
        command.startswith(mutation_prefixes) for command in _commands(connection)
    )
    return connection


def test_sentinel_cloud_roast_collision_aborts_before_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = _assert_preflight_collision(
        monkeypatch,
        "telemetry verifier roast keys are already owned",
        cloud_preflight_count=1,
    )
    cloud_query = next(
        executed
        for executed in connection.fake_cursor.executed
        if executed[0].startswith("SELECT COUNT(*) FROM app.cloud_roasts")
    )
    assert cloud_query[1] is not None
    assert load_telemetry_verify_live.SENTINEL_ROAST_ID in cloud_query[1]


def test_telemetry_row_collision_aborts_before_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _assert_preflight_collision(
        monkeypatch,
        "telemetry verifier row keys are already owned",
        telemetry_preflight_count=1,
    )


def test_artifact_row_collision_aborts_before_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _assert_preflight_collision(
        monkeypatch,
        "telemetry verifier artifact key is already owned",
        artifact_preflight_count=1,
    )


def test_reference_summary_collision_aborts_before_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _assert_preflight_collision(
        monkeypatch,
        "telemetry verifier summary key is already owned",
        summary_preflight_count=1,
    )


def test_stage_prefix_collision_aborts_before_mutation(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _assert_preflight_collision(
        monkeypatch,
        "telemetry verifier stage prefix is already owned",
        stage_preflight_rows=("existing/roast.jsonl",),
    )


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


def test_raw_body_failure_is_wrapped(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(fail_on="CALL app.load_roast_telemetry")
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match="live verification body failed",
    ) as raised:
        load_telemetry_verify_live.verify_live_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )
    assert isinstance(raised.value.__cause__, RuntimeError)
    assert _commands(connection)[-2:] == [
        "DELETE FROM app.reference_roast_summaries "
        "WHERE bean_origin = %s AND roast_level = %s",
        f"REMOVE @app.roast_artifacts/{load_telemetry_verify_live.TEST_RUN_ID}/",
    ]


def test_body_error_survives_delete_cleanup_failure(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _patch_expected_helper(monkeypatch)
    mismatched = list(EXPECTED_TUPLE)
    mismatched[2] = 99.0
    connection = FakeConnection(actual=[tuple(mismatched)], fail_on="DELETE")
    monkeypatch.setattr(load_telemetry_verify_live, "_connect", lambda _target: connection)

    assert load_telemetry_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1

    assert _commands(connection)[-5:] == [
        "DELETE FROM app.roast_telemetry WHERE roast_id IN (%s, %s, %s)",
        "DELETE FROM app.roast_artifacts WHERE roast_id = %s",
        "DELETE FROM app.cloud_roasts WHERE id = %s AND idempotency_key = %s",
        "DELETE FROM app.reference_roast_summaries "
        "WHERE bean_origin = %s AND roast_level = %s",
        f"REMOVE @app.roast_artifacts/{load_telemetry_verify_live.TEST_RUN_ID}/",
    ]
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.splitlines() == [
        "telemetry verification failed: loaded telemetry does not match fixture expectation",
        (
            f"cleanup failed for run id {load_telemetry_verify_live.TEST_RUN_ID}: "
            "telemetry rows cleanup failed"
        ),
        (
            f"cleanup failed for run id {load_telemetry_verify_live.TEST_RUN_ID}: "
            "artifact rows cleanup failed"
        ),
        (
            f"cleanup failed for run id {load_telemetry_verify_live.TEST_RUN_ID}: "
            "cloud_roasts cleanup failed"
        ),
        (
            f"cleanup failed for run id {load_telemetry_verify_live.TEST_RUN_ID}: "
            "reference summary cleanup failed"
        ),
    ]
    assert connection.closed is True


def test_cleanup_error_surfaces_when_body_succeeds(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(fail_on="DELETE")
    monkeypatch.setattr(load_telemetry_verify_live, "_connect", lambda _target: connection)

    assert load_telemetry_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1

    assert _commands(connection)[-5:] == [
        "DELETE FROM app.roast_telemetry WHERE roast_id IN (%s, %s, %s)",
        "DELETE FROM app.roast_artifacts WHERE roast_id = %s",
        "DELETE FROM app.cloud_roasts WHERE id = %s AND idempotency_key = %s",
        "DELETE FROM app.reference_roast_summaries "
        "WHERE bean_origin = %s AND roast_level = %s",
        f"REMOVE @app.roast_artifacts/{load_telemetry_verify_live.TEST_RUN_ID}/",
    ]
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.splitlines() == [
        "telemetry verification failed: telemetry verification cleanup failed",
        (
            f"cleanup failed for run id {load_telemetry_verify_live.TEST_RUN_ID}: "
            "telemetry rows cleanup failed"
        ),
        (
            f"cleanup failed for run id {load_telemetry_verify_live.TEST_RUN_ID}: "
            "artifact rows cleanup failed"
        ),
        (
            f"cleanup failed for run id {load_telemetry_verify_live.TEST_RUN_ID}: "
            "cloud_roasts cleanup failed"
        ),
        (
            f"cleanup failed for run id {load_telemetry_verify_live.TEST_RUN_ID}: "
            "reference summary cleanup failed"
        ),
    ]
    assert connection.closed is True


def test_cleanup_failure_output_is_sanitised(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(
        fail_on="DELETE",
        cleanup_error_text=(
            "connect failed for account "
            "ab12345.eu-west-1.snowflakecomputing.com at /Users/op/.snowflake/key.p8"
        ),
    )
    monkeypatch.setattr(load_telemetry_verify_live, "_connect", lambda _target: connection)

    assert load_telemetry_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert "snowflakecomputing.com" not in captured.err
    assert "/Users/op" not in captured.err
    assert "telemetry rows cleanup failed" in captured.err


def test_main_preserves_body_and_cleanup_evidence_when_close_fails(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _patch_expected_helper(monkeypatch)
    mismatched = list(EXPECTED_TUPLE)
    mismatched[2] = 99.0
    connection = FakeConnection(
        actual=[tuple(mismatched)],
        fail_on="DELETE",
        close_error_text=(
            "close failed at ab12345.eu-west-1.snowflakecomputing.com "
            "/Users/op/key.p8"
        ),
    )
    monkeypatch.setattr(load_telemetry_verify_live, "_connect", lambda _target: connection)

    assert load_telemetry_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.splitlines() == [
        "telemetry verification failed: loaded telemetry does not match fixture expectation",
        f"cleanup failed for run id {load_telemetry_verify_live.TEST_RUN_ID}: "
        "telemetry rows cleanup failed",
        f"cleanup failed for run id {load_telemetry_verify_live.TEST_RUN_ID}: "
        "artifact rows cleanup failed",
        f"cleanup failed for run id {load_telemetry_verify_live.TEST_RUN_ID}: "
        "cloud_roasts cleanup failed",
        f"cleanup failed for run id {load_telemetry_verify_live.TEST_RUN_ID}: "
        "reference summary cleanup failed",
        f"cleanup failed for run id {load_telemetry_verify_live.TEST_RUN_ID}: "
        "Snowflake connection close failed",
    ]
    assert "snowflakecomputing.com" not in captured.err
    assert "/Users/op" not in captured.err
    assert connection.closed is True


def test_opt_out_call_carries_20013_and_inserts_no_rows() -> None:
    cursor = FakeCursor()
    load_telemetry_verify_live._expect_sql_error(
        cursor,
        "CALL app.load_roast_telemetry(%s, %s)",
        (
            load_telemetry_verify_live.TEST_RUN_ID,
            load_telemetry_verify_live.TEST_ROAST_ID,
        ),
        "-20013",
        "opt-out telemetry load",
    )
    cursor.execute(
        "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
        (load_telemetry_verify_live.TEST_ROAST_ID,),
    )
    assert cursor.fetchone() == (0,)


def test_missing_roast_call_must_raise_20013(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(missing_raises=False)
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match="missing-roast telemetry load unexpectedly succeeded",
    ):
        load_telemetry_verify_live.verify_live_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )


def test_missing_roast_call_must_insert_no_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(missing_telemetry_count=1)
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match="missing-roast telemetry load inserted rows",
    ):
        load_telemetry_verify_live.verify_live_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )


def test_opt_out_call_must_raise_instead_of_loading(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(opt_out_raises=False)
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match="opt-out telemetry load unexpectedly succeeded",
    ):
        load_telemetry_verify_live.verify_live_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )
    assert not any(
        command.startswith("UPDATE app.cloud_roasts SET contributed_to_learning = TRUE")
        for command in _commands(connection)
    )


def test_opt_out_recompute_must_leave_zero_contribution_summary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    changed = (1, *SUMMARY_BEFORE[1:])
    connection = FakeConnection(summary_after_opt_out=changed)
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match="opt-out roast contributed to the reference summary",
    ):
        load_telemetry_verify_live.verify_live_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )

def test_opt_in_recompute_must_move_count_and_averages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(summary_after_opt_in=SUMMARY_BEFORE)
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match="opt-in roast did not move the reference summary",
    ):
        load_telemetry_verify_live.verify_live_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )


def test_non_empty_opt_out_manifest_must_be_rejected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(manifest_raises=False)
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match="opt-out non-empty artifact manifest unexpectedly succeeded",
    ):
        load_telemetry_verify_live.verify_live_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )


def test_rejected_opt_out_manifest_must_leave_no_artifact_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(rejected_manifest_artifact_count=1)
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match="rejected opt-out manifest inserted artifact rows",
    ):
        load_telemetry_verify_live.verify_live_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )


def test_empty_opt_out_manifest_must_leave_no_artifact_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(empty_manifest_artifact_count=1)
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match="empty opt-out manifest left artifact rows",
    ):
        load_telemetry_verify_live.verify_live_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )
