"""Contract tests for the operator-run live telemetry verifier (issue #416)."""

from __future__ import annotations

import json
import re
import sys
from decimal import Decimal
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
        cloud_preflight_counts: tuple[object, ...] | None = None,
        cloud_unhealable_rows: tuple[tuple[object, object], ...] | None = None,
        telemetry_preflight_count: object = 0,
        telemetry_preflight_counts: tuple[object, ...] | None = None,
        artifact_preflight_count: object = 0,
        artifact_preflight_counts: tuple[object, ...] | None = None,
        summary_preflight_count: object = 0,
        summary_preflight_counts: tuple[object, ...] | None = None,
        stage_preflight_rows: tuple[str, ...] = (),
        stage_preflight_reads: tuple[tuple[str, ...], ...] | None = None,
        allowed_probe: str | None = None,
        missing_raises: bool = True,
        missing_error: str = "-20013 Roast has not consented to learning",
        missing_telemetry_count: object = 0,
        opt_out_raises: bool = True,
        opt_out_error: str = "-20013 Roast has not consented to learning",
        gate_a_raises: bool = True,
        gate_a_error: str = "-20013 Roast has not consented to learning",
        gate_a_telemetry_count: object = 0,
        gate_a_success_ids: set[str] | None = None,
        gate_a_telemetry_counts: dict[str, object] | None = None,
        manifest_raises: bool = True,
        manifest_error: str = (
            "-20009 Payload does not match the closed roast grammar"
        ),
        summary_after_opt_out: tuple[object, ...] = SUMMARY_BEFORE,
        summary_after_opt_in: tuple[object, ...] = SUMMARY_AFTER_OPT_IN,
        rejected_manifest_artifact_count: object = 0,
        empty_manifest_artifact_count: object = 0,
        opt_out_telemetry_count: object = 0,
        sentinel_counts: tuple[object, ...] | None = None,
    ) -> None:
        self.database = database
        self.role = role
        self.loaded = loaded
        self.actual = [EXPECTED_TUPLE] if actual is None else actual
        self.fail_on = fail_on
        self.cleanup_error_text = cleanup_error_text
        self.cloud_preflight_counts = (
            (cloud_preflight_count, 0, 0)
            if cloud_preflight_counts is None
            else cloud_preflight_counts
        )
        self.cloud_unhealable_rows = cloud_unhealable_rows
        self.telemetry_preflight_counts = (
            (telemetry_preflight_count, 0)
            if telemetry_preflight_counts is None
            else telemetry_preflight_counts
        )
        self.artifact_preflight_counts = (
            (artifact_preflight_count, 0)
            if artifact_preflight_counts is None
            else artifact_preflight_counts
        )
        self.summary_preflight_counts = (
            (summary_preflight_count, 0)
            if summary_preflight_counts is None
            else summary_preflight_counts
        )
        self.stage_preflight_reads = (
            (stage_preflight_rows, ())
            if stage_preflight_reads is None
            else stage_preflight_reads
        )
        self.allowed_probe = allowed_probe
        self.missing_raises = missing_raises
        self.missing_error = missing_error
        self.missing_telemetry_count = missing_telemetry_count
        self.opt_out_raises = opt_out_raises
        self.opt_out_error = opt_out_error
        self.gate_a_raises = gate_a_raises
        self.gate_a_error = gate_a_error
        self.gate_a_telemetry_count = gate_a_telemetry_count
        self.gate_a_success_ids = set() if gate_a_success_ids is None else gate_a_success_ids
        self.gate_a_telemetry_counts = (
            {} if gate_a_telemetry_counts is None else gate_a_telemetry_counts
        )
        self.manifest_raises = manifest_raises
        self.manifest_error = manifest_error
        self.summary_rows = (
            summary_after_opt_out,
            summary_after_opt_in,
        )
        self.rejected_manifest_artifact_count = rejected_manifest_artifact_count
        self.empty_manifest_artifact_count = empty_manifest_artifact_count
        self.opt_out_telemetry_count = opt_out_telemetry_count
        self.sentinel_counts = sentinel_counts
        self.executed: list[tuple[str, tuple[object, ...] | None]] = []
        self.contributing = False
        self.summary_reads = 0
        self.sentinel_reads = 0
        self.sentinel_present = True
        self.primary_load_calls = 0
        self.last_upsert_kind: str | None = None
        self.cloud_preflight_reads = 0
        self.telemetry_preflight_reads = 0
        self.artifact_preflight_reads = 0
        self.summary_preflight_reads = 0
        self.stage_preflight_read_count = 0

    def execute(self, command: str, params=None):
        normalized = tuple(params) if params is not None else None
        self.executed.append((command, normalized))
        if command in {
            probe_command
            for _, _, probe_command in load_telemetry_verify_live.REVOKED_AGENT_DML_PROBES
        }:
            if command == self.allowed_probe:
                return self
            raise RuntimeError(
                "003001 (42501): SQL access control error: Insufficient privileges"
            )
        load_roast_id = (
            normalized[1]
            if command.startswith("CALL app.load_roast_telemetry")
            and normalized is not None
            else None
        )
        expected_guard_call = (
            load_roast_id == load_telemetry_verify_live.MISSING_ROAST_ID
            or load_roast_id
            in {
                load_telemetry_verify_live.MIXED_CONSENT_ROAST_ID,
                load_telemetry_verify_live.OPTED_OUT_ROAST_ID,
                load_telemetry_verify_live.CONSENT_FLIP_ROAST_ID,
            }
            or (
                load_roast_id == load_telemetry_verify_live.TEST_ROAST_ID
                and self.primary_load_calls == 0
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
            elif load_roast_id in {
                load_telemetry_verify_live.MIXED_CONSENT_ROAST_ID,
                load_telemetry_verify_live.OPTED_OUT_ROAST_ID,
                load_telemetry_verify_live.CONSENT_FLIP_ROAST_ID,
            }:
                if (
                    self.gate_a_raises
                    and load_roast_id not in self.gate_a_success_ids
                ):
                    raise RuntimeError(self.gate_a_error)
            elif self.primary_load_calls == 0:
                self.primary_load_calls += 1
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
            if self.cloud_unhealable_rows is not None and "IS NOT TRUE" in command:
                return (len(self.cloud_unhealable_rows),)
            value = self.cloud_preflight_counts[self.cloud_preflight_reads]
            self.cloud_preflight_reads += 1
            return (value,)
        if command.startswith("SELECT COUNT(*) FROM app.roast_artifacts"):
            if self.last_upsert_kind == "rejected_manifest":
                return (self.rejected_manifest_artifact_count,)
            if self.last_upsert_kind == "empty_manifest":
                return (self.empty_manifest_artifact_count,)
            value = self.artifact_preflight_counts[self.artifact_preflight_reads]
            self.artifact_preflight_reads += 1
            return (value,)
        if command.startswith("SELECT COUNT(*) FROM app.reference_roast_summaries"):
            value = self.summary_preflight_counts[self.summary_preflight_reads]
            self.summary_preflight_reads += 1
            return (value,)
        if command.startswith("SELECT COUNT(*) FROM app.roast_telemetry"):
            assert self.executed[-1][1] is not None
            if " IN " in command:
                value = self.telemetry_preflight_counts[
                    self.telemetry_preflight_reads
                ]
                self.telemetry_preflight_reads += 1
                return (value,)
            roast_id = self.executed[-1][1][0]
            if roast_id == load_telemetry_verify_live.MISSING_ROAST_ID:
                return (self.missing_telemetry_count,)
            if roast_id == load_telemetry_verify_live.SENTINEL_ROAST_ID:
                if self.sentinel_counts is not None:
                    value = self.sentinel_counts[self.sentinel_reads]
                    self.sentinel_reads += 1
                    return (value,)
                return (1 if self.sentinel_present else 0,)
            if roast_id in {
                load_telemetry_verify_live.MIXED_CONSENT_ROAST_ID,
                load_telemetry_verify_live.OPTED_OUT_ROAST_ID,
                load_telemetry_verify_live.CONSENT_FLIP_ROAST_ID,
            }:
                return (
                    self.gate_a_telemetry_counts.get(
                        str(roast_id), self.gate_a_telemetry_count
                    ),
                )
            return (self.opt_out_telemetry_count,)
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
            rows = self.stage_preflight_reads[self.stage_preflight_read_count]
            self.stage_preflight_read_count += 1
            return [(row,) for row in rows]
        if command.startswith("SELECT roast_id, elapsed_s"):
            return self.actual
        raise AssertionError(f"unexpected fetchall after: {command}")


class FakeConnection:
    def __init__(
        self,
        *,
        close_error_text: str | None = None,
        make_seed: bool = True,
        **cursor_options: object,
    ) -> None:
        self.fake_cursor = FakeCursor(**cursor_options)
        self.close_error_text = close_error_text
        self.closed = False
        self.seed_connection = (
            FakeConnection(make_seed=False, **cursor_options) if make_seed else None
        )

    def cursor(self):
        return self.fake_cursor

    def close(self) -> None:
        self.closed = True
        if self.close_error_text is not None:
            raise RuntimeError(self.close_error_text)


def _patch_expected_helper(monkeypatch: pytest.MonkeyPatch) -> None:
    def helper(path: object, roast_id: object) -> list[dict[str, object]]:
        # Pin the arguments verify_live_load passes so a mutation dropping either
        # (fixture_path/TEST_ROAST_ID -> None) is caught rather than swallowed.
        assert path == load_telemetry_verify_live.FIXTURE_PATH
        assert roast_id == load_telemetry_verify_live.TEST_ROAST_ID
        return [STAND_IN_ROW]

    monkeypatch.setattr(
        load_telemetry_verify_live,
        "fixture_expected_rows",
        helper,
    )


def _commands(connection: FakeConnection) -> list[str]:
    return [command for command, _ in connection.fake_cursor.executed]


def _verify_load(
    connection: FakeConnection,
    fixture_path: Path,
    expected_target: str,
) -> int:
    assert connection.seed_connection is not None
    return load_telemetry_verify_live.verify_live_load(
        connection,
        connection.seed_connection,
        fixture_path,
        expected_target,
    )


def test_real_fixture_helper_derives_session_one_first_row() -> None:
    first_row = load_telemetry_verify_live.fixture_expected_rows(
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


def test_first_value_matches_mapping_label_case_insensitively() -> None:
    assert load_telemetry_verify_live._first_value(
        {"current_database()": "ROASTPILOT_DEV"},
        "CURRENT_DATABASE()",
    ) == "ROASTPILOT_DEV"


def test_first_value_returns_none_when_folded_label_absent() -> None:
    assert (
        load_telemetry_verify_live._first_value({"OTHER": "value"}, "COUNT(*)")
        is None
    )


def test_first_value_reads_first_sequence_element() -> None:
    assert load_telemetry_verify_live._first_value(("first", "second"), "LABEL") == "first"


@pytest.mark.parametrize("row", ["a string", b"bytes", (), None])
def test_first_value_returns_none_for_unsupported_row_shapes(row: object) -> None:
    assert load_telemetry_verify_live._first_value(row, "LABEL") is None


def test_row_values_reads_mapping_labels_case_insensitively() -> None:
    row = {"roast_count": 3, "REVIEW_COUNT": 5}
    assert load_telemetry_verify_live._row_values(
        row, ("ROAST_COUNT", "review_count")
    ) == (3, 5)


def test_row_values_rejects_mapping_missing_a_label() -> None:
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match="^live query returned an incomplete row$",
    ):
        load_telemetry_verify_live._row_values({"ROAST_COUNT": 1}, ("ROAST_COUNT", "REVIEW_COUNT"))


def test_row_values_preserves_explicit_none_mapping_values() -> None:
    assert load_telemetry_verify_live._row_values(
        {"A": None, "B": 2}, ("A", "B")
    ) == (None, 2)


def test_row_values_accepts_sequence_of_matching_length() -> None:
    assert load_telemetry_verify_live._row_values((1, 2, 3), ("A", "B", "C")) == (1, 2, 3)


@pytest.mark.parametrize("row", [(1, 2), "not a row", b"bytes", None])
def test_row_values_rejects_unexpected_row_shapes(row: object) -> None:
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match="^live query returned an unexpected row shape$",
    ):
        load_telemetry_verify_live._row_values(row, ("A", "B", "C"))


@pytest.mark.parametrize("value", [0, 7, Decimal("3")])
def test_count_returns_numeric_values(value: object) -> None:
    assert load_telemetry_verify_live._count({"COUNT(*)": value}) == value


@pytest.mark.parametrize("value", [True, "3", None, 1.5])
def test_count_rejects_non_numeric_values(value: object) -> None:
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^COUNT\(\*\) did not return a numeric count$",
    ):
        load_telemetry_verify_live._count({"COUNT(*)": value})


class _RaisingCursor:
    def __init__(self, error: BaseException) -> None:
        self.error = error

    def execute(self, command: str, params=None):
        raise self.error

    def fetchone(self):  # pragma: no cover - never reached once execute raises
        raise AssertionError("fetchone should not be called")


class _DenyProbeCursor:
    def __init__(
        self,
        error: BaseException,
        *,
        succeed_on: str | None = None,
    ) -> None:
        self.error = error
        self.succeed_on = succeed_on
        self.executed: list[str] = []

    def execute(self, command: str, params=None):
        assert params is None
        self.executed.append(command)
        if command != self.succeed_on:
            raise self.error


class _SnowflakeAuthorizationError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        sqlstate: str | None = None,
        errno: int | None = None,
    ) -> None:
        super().__init__(message)
        self.sqlstate = sqlstate
        self.errno = errno


@pytest.mark.parametrize(
    "error",
    [
        RuntimeError("Insufficient privileges to operate on table"),
        _SnowflakeAuthorizationError("access denied", sqlstate="42501"),
        _SnowflakeAuthorizationError("access denied", errno=3001),
    ],
)
def test_insufficient_privilege_detection_accepts_snowflake_denial_signals(
    error: BaseException,
) -> None:
    assert load_telemetry_verify_live._is_insufficient_privileges_error(error)


def test_insufficient_privilege_detection_rejects_unrelated_errors() -> None:
    assert not load_telemetry_verify_live._is_insufficient_privileges_error(
        RuntimeError("object does not exist")
    )


def test_agent_dml_revoke_probe_passes_only_after_all_12_attempts_are_denied() -> None:
    cursor = _DenyProbeCursor(RuntimeError("Insufficient privileges"))

    load_telemetry_verify_live.verify_agent_dml_revoked(cursor)

    expected_commands = [
        command
        for _, _, command in load_telemetry_verify_live.REVOKED_AGENT_DML_PROBES
    ]
    assert cursor.executed == expected_commands
    assert len(cursor.executed) == 12
    assert all("WHERE FALSE" in command for command in cursor.executed)


def test_agent_dml_revoke_probe_matrix_and_columns_are_independently_pinned() -> None:
    assert {
        (table, privilege)
        for table, privilege, _ in load_telemetry_verify_live.REVOKED_AGENT_DML_PROBES
    } == {
        (table, privilege)
        for table in (
            "cloud_roasts",
            "roast_telemetry",
            "tasting_reviews",
            "reference_roast_summaries",
        )
        for privilege in ("INSERT", "UPDATE", "DELETE")
    }
    expected_columns = {
        "cloud_roasts": "idempotency_key",
        "roast_telemetry": "roast_id",
        "tasting_reviews": "roast_id",
        "reference_roast_summaries": "bean_origin",
    }
    for table, privilege, command in load_telemetry_verify_live.REVOKED_AGENT_DML_PROBES:
        assert f"app.{table}" in command
        if privilege in {"INSERT", "UPDATE"}:
            assert expected_columns[table] in command


def test_agent_dml_revoke_probe_fails_loudly_if_an_attempt_succeeds() -> None:
    table = "tasting_reviews"
    privilege = "UPDATE"
    command = next(
        probe_command
        for probe_table, probe_privilege, probe_command in (
            load_telemetry_verify_live.REVOKED_AGENT_DML_PROBES
        )
        if (probe_table, probe_privilege) == (table, privilege)
    )
    cursor = _DenyProbeCursor(
        RuntimeError("Insufficient privileges"), succeed_on=command
    )

    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^tasting_reviews UPDATE revoke not effective: no-op DML unexpectedly succeeded$",
    ):
        load_telemetry_verify_live.verify_agent_dml_revoked(cursor)


def test_agent_dml_revoke_probe_fails_closed_on_an_unrelated_sql_error() -> None:
    cursor = _DenyProbeCursor(RuntimeError("syntax error"))

    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^cloud_roasts INSERT deny-probe returned an unexpected SQL error$",
    ) as raised:
        load_telemetry_verify_live.verify_agent_dml_revoked(cursor)

    assert isinstance(raised.value.__cause__, RuntimeError)


def test_expect_sql_error_wraps_unexpected_sql_error() -> None:
    cursor = _RaisingCursor(RuntimeError("-99999 some other failure"))
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match="opt-out telemetry load returned an unexpected SQL error",
    ) as raised:
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
    assert isinstance(raised.value.__cause__, RuntimeError)


@pytest.mark.parametrize(
    ("contributing", "artifact_kinds"),
    [(True, ("jsonl",)), (False, ()), (True, ("jsonl", "png"))],
)
def test_payload_serializes_exact_compact_json(
    contributing: bool, artifact_kinds: tuple[str, ...]
) -> None:
    expected = json.dumps(
        {
            "public_slug": load_telemetry_verify_live.PUBLIC_SLUG,
            "visibility": "private",
            "bean_origin": load_telemetry_verify_live.BEAN_ORIGIN,
            "bean_varietal": "C3-S4 live verifier",
            "bean_weight_g": 250.0,
            "profile_name": "telemetry consent verification",
            "roast_level": load_telemetry_verify_live.ROAST_LEVEL,
            "operator_rating": 4,
            "operator_notes": None,
            "contributed_to_learning": contributing,
            "roasted_at_utc": "2026-09-02T12:00:00Z",
            "summary": load_telemetry_verify_live.SUMMARY,
            "artifact_kinds": list(artifact_kinds),
        },
        separators=(",", ":"),
    )
    assert load_telemetry_verify_live._payload(contributing, artifact_kinds) == expected


class _RecordingCursor:
    def __init__(self, row: object) -> None:
        self.row = row
        self.executed: list[tuple[str, tuple[object, ...] | None]] = []

    def execute(self, command: str, params=None):
        self.executed.append((command, tuple(params) if params is not None else None))

    def fetchone(self):
        return self.row


def test_summary_row_executes_exact_query_and_reads_row() -> None:
    row = {column.upper(): index for index, column in enumerate(
        load_telemetry_verify_live.SUMMARY_COLUMNS)}
    cursor = _RecordingCursor(row)
    result = load_telemetry_verify_live._summary_row(cursor)
    expected_sql = (
        f"SELECT {', '.join(load_telemetry_verify_live.SUMMARY_COLUMNS)} "
        "FROM app.reference_roast_summaries "
        "WHERE bean_origin = %s AND roast_level = %s"
    )
    assert cursor.executed == [
        (
            expected_sql,
            (
                load_telemetry_verify_live.BEAN_ORIGIN,
                load_telemetry_verify_live.ROAST_LEVEL,
            ),
        )
    ]
    assert result == tuple(range(len(load_telemetry_verify_live.SUMMARY_COLUMNS)))


def test_required_env_accepts_nonempty_and_rejects_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("TELEMETRY_VERIFY_TEST_ENV", "present")
    assert load_telemetry_verify_live._required_env("TELEMETRY_VERIFY_TEST_ENV") == "present"
    monkeypatch.delenv("TELEMETRY_VERIFY_TEST_ENV")
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match="^missing required environment variable: TELEMETRY_VERIFY_TEST_ENV$",
    ):
        load_telemetry_verify_live._required_env("TELEMETRY_VERIFY_TEST_ENV")


def test_happy_path_pins_put_call_select_and_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection()

    assert _verify_load(
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
    assert connection.seed_connection is not None
    seed_commands = _commands(connection.seed_connection)
    update_index = next(
        index for index, command in enumerate(seed_commands)
        if command.startswith("UPDATE app.cloud_roasts SET contributed_to_learning = ")
    )
    opt_out_call_index = connection.fake_cursor.executed.index(positive_call)
    positive_call_index = connection.fake_cursor.executed.index(
        positive_call, opt_out_call_index + 1
    )
    select_index = connection.fake_cursor.executed.index(
        telemetry_select, positive_call_index
    )
    assert put_index < positive_call_index < select_index
    assert update_index == 2
    load_roast_ids = [
        params[1]
        for command, params in connection.fake_cursor.executed
        if command.startswith("CALL app.load_roast_telemetry") and params is not None
    ]
    assert load_roast_ids == [
        load_telemetry_verify_live.MISSING_ROAST_ID,
        load_telemetry_verify_live.MIXED_CONSENT_ROAST_ID,
        load_telemetry_verify_live.OPTED_OUT_ROAST_ID,
        load_telemetry_verify_live.TEST_ROAST_ID,
        load_telemetry_verify_live.CONSENT_FLIP_ROAST_ID,
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
    assert connection.seed_connection.fake_cursor.executed[-4:] == [
        (
            "DELETE FROM app.roast_telemetry "
            "WHERE roast_id IN (%s, %s, %s, %s, %s, %s)",
            (
                load_telemetry_verify_live.TEST_ROAST_ID,
                load_telemetry_verify_live.SENTINEL_ROAST_ID,
                load_telemetry_verify_live.MISSING_ROAST_ID,
                load_telemetry_verify_live.MIXED_CONSENT_ROAST_ID,
                load_telemetry_verify_live.OPTED_OUT_ROAST_ID,
                load_telemetry_verify_live.CONSENT_FLIP_ROAST_ID,
            ),
        ),
        (
            "DELETE FROM app.roast_artifacts "
            "WHERE roast_id IN (%s, %s, %s, %s)",
            (
                load_telemetry_verify_live.TEST_ROAST_ID,
                load_telemetry_verify_live.MIXED_CONSENT_ROAST_ID,
                load_telemetry_verify_live.OPTED_OUT_ROAST_ID,
                load_telemetry_verify_live.CONSENT_FLIP_ROAST_ID,
            ),
        ),
        (
            "DELETE FROM app.cloud_roasts "
            "WHERE (id = %s AND idempotency_key = %s) OR id IN (%s, %s, %s)",
            (
                load_telemetry_verify_live.TEST_ROAST_ID,
                load_telemetry_verify_live.TEST_RUN_ID,
                load_telemetry_verify_live.MIXED_CONSENT_ROAST_ID,
                load_telemetry_verify_live.OPTED_OUT_ROAST_ID,
                load_telemetry_verify_live.CONSENT_FLIP_ROAST_ID,
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
    ]
    assert connection.fake_cursor.executed[-1] == (
        f"REMOVE @app.roast_artifacts/{load_telemetry_verify_live.TEST_RUN_ID}/",
        None,
    )


def test_happy_path_executes_exact_statement_sequence(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection()

    assert _verify_load(
        connection,
        load_telemetry_verify_live.FIXTURE_PATH,
        "ROASTPILOT_DEV",
    ) == 1

    assert connection.seed_connection is not None
    agent_statements = connection.fake_cursor.executed
    seed_statements = connection.seed_connection.fake_cursor.executed
    direct_dml = ("INSERT INTO app.", "UPDATE app.", "DELETE FROM app.")
    agent_only = ("SELECT ", "CALL ", "LIST ", "PUT ", "REMOVE ")
    probe_commands = [
        command
        for _, _, command in load_telemetry_verify_live.REVOKED_AGENT_DML_PROBES
    ]
    assert [
        command for command, _ in agent_statements if command.startswith(direct_dml)
    ] == probe_commands
    assert not any(command in probe_commands for command, _ in seed_statements)
    assert all(command.startswith(direct_dml) for command, _ in seed_statements)
    assert not any(command.startswith(agent_only) for command, _ in seed_statements)
    assert not any(
        re.search(r"\bSELECT\b[\s\S]*\bFROM\b", command, re.IGNORECASE)
        for command, _ in seed_statements
    )
    gate_a_ids = (
        load_telemetry_verify_live.MIXED_CONSENT_ROAST_ID,
        load_telemetry_verify_live.OPTED_OUT_ROAST_ID,
        load_telemetry_verify_live.CONSENT_FLIP_ROAST_ID,
    )
    cloud_params = (
        load_telemetry_verify_live.TEST_ROAST_ID,
        load_telemetry_verify_live.SENTINEL_ROAST_ID,
        load_telemetry_verify_live.MISSING_ROAST_ID,
        *gate_a_ids,
        load_telemetry_verify_live.TEST_RUN_ID,
        load_telemetry_verify_live.MIXED_CONSENT_TRUE_RUN_ID,
        load_telemetry_verify_live.MIXED_CONSENT_FALSE_RUN_ID,
        load_telemetry_verify_live.OPTED_OUT_RUN_ID,
        load_telemetry_verify_live.CONSENT_FLIP_RUN_ID,
        load_telemetry_verify_live.PUBLIC_SLUG,
        load_telemetry_verify_live.MIXED_CONSENT_TRUE_SLUG,
        load_telemetry_verify_live.MIXED_CONSENT_FALSE_SLUG,
        load_telemetry_verify_live.OPTED_OUT_SLUG,
        load_telemetry_verify_live.CONSENT_FLIP_SLUG,
    )
    cloud_owned_params = (
        load_telemetry_verify_live.TEST_ROAST_ID,
        load_telemetry_verify_live.TEST_RUN_ID,
        *gate_a_ids,
    )
    telemetry_statement = (
        "SELECT COUNT(*) FROM app.roast_telemetry "
        "WHERE roast_id IN (%s, %s, %s, %s, %s, %s)",
        (
            load_telemetry_verify_live.TEST_ROAST_ID,
            load_telemetry_verify_live.SENTINEL_ROAST_ID,
            load_telemetry_verify_live.MISSING_ROAST_ID,
            *gate_a_ids,
        ),
    )
    artifact_statement = (
        "SELECT COUNT(*) FROM app.roast_artifacts "
        "WHERE roast_id IN (%s, %s, %s, %s)",
        (load_telemetry_verify_live.TEST_ROAST_ID, *gate_a_ids),
    )
    cloud_statement = (
        "SELECT COUNT(*) FROM app.cloud_roasts "
        "WHERE id IN (%s, %s, %s, %s, %s, %s) "
        "OR idempotency_key IN (%s, %s, %s, %s, %s) "
        "OR public_slug IN (%s, %s, %s, %s, %s)",
        cloud_params,
    )
    cloud_owned_statement = (
        "SELECT COUNT(*) FROM app.cloud_roasts "
        "WHERE (id = %s AND idempotency_key = %s) OR id IN (%s, %s, %s)",
        cloud_owned_params,
    )
    cloud_unhealable_statement = (
        "SELECT COUNT(*) FROM app.cloud_roasts "
        "WHERE (id IN (%s, %s, %s, %s, %s, %s) "
        "OR idempotency_key IN (%s, %s, %s, %s, %s) "
        "OR public_slug IN (%s, %s, %s, %s, %s)) "
        "AND ((id = %s AND idempotency_key = %s) "
        "OR id IN (%s, %s, %s)) IS NOT TRUE",
        (*cloud_params, *cloud_owned_params),
    )
    summary_statement = (
        "SELECT COUNT(*) FROM app.reference_roast_summaries "
        "WHERE bean_origin = %s AND roast_level = %s",
        (
            load_telemetry_verify_live.BEAN_ORIGIN,
            load_telemetry_verify_live.ROAST_LEVEL,
        ),
    )
    list_statement = (
        f"LIST @app.roast_artifacts/{load_telemetry_verify_live.TEST_RUN_ID}/",
        None,
    )
    assert agent_statements[:26] == [
        ("USE SECONDARY ROLES NONE", None),
        ("SELECT CURRENT_DATABASE()", None),
        ("SELECT CURRENT_ROLE()", None),
        *((command, None) for command in probe_commands),
        cloud_unhealable_statement,
        cloud_owned_statement,
        telemetry_statement,
        artifact_statement,
        summary_statement,
        list_statement,
        cloud_statement,
        telemetry_statement,
        artifact_statement,
        summary_statement,
        list_statement,
    ]
    summary_json = json.dumps(
        load_telemetry_verify_live.SUMMARY, separators=(",", ":")
    )
    assert seed_statements == [
        (
            "INSERT INTO app.cloud_roasts "
            "(id, idempotency_key, owner_id, public_slug, visibility, bean_origin, "
            "bean_varietal, bean_weight_g, profile_name, roast_level, summary, "
            "operator_rating, operator_notes, contributed_to_learning, roasted_at_utc) "
            "SELECT %s, %s, NULL, %s, 'private', %s, 'C3-S4 live verifier', 250, "
            "'telemetry consent verification', %s, PARSE_JSON(%s), 4, NULL, FALSE, "
            "'2026-09-02T12:00:00Z'::timestamp_tz "
            "UNION ALL SELECT %s, %s, NULL, %s, 'private', NULL, "
            "'Gate-A mixed true', 250, 'telemetry consent verification', NULL, "
            "PARSE_JSON(%s), 4, NULL, TRUE, "
            "'2026-09-02T12:00:00Z'::timestamp_tz "
            "UNION ALL SELECT %s, %s, NULL, %s, 'private', NULL, "
            "'Gate-A mixed false', 250, 'telemetry consent verification', NULL, "
            "PARSE_JSON(%s), 4, NULL, FALSE, "
            "'2026-09-02T12:00:00Z'::timestamp_tz "
            "UNION ALL SELECT %s, %s, NULL, %s, 'private', NULL, "
            "'Gate-A opted out', 250, 'telemetry consent verification', NULL, "
            "PARSE_JSON(%s), 4, NULL, FALSE, "
            "'2026-09-02T12:00:00Z'::timestamp_tz "
            "UNION ALL SELECT %s, %s, NULL, %s, 'private', NULL, "
            "'Gate-A consent flip', 250, 'telemetry consent verification', NULL, "
            "PARSE_JSON(%s), 4, NULL, TRUE, "
            "'2026-09-02T12:00:00Z'::timestamp_tz",
            (
                load_telemetry_verify_live.TEST_ROAST_ID,
                load_telemetry_verify_live.TEST_RUN_ID,
                load_telemetry_verify_live.PUBLIC_SLUG,
                load_telemetry_verify_live.BEAN_ORIGIN,
                load_telemetry_verify_live.ROAST_LEVEL,
                summary_json,
                load_telemetry_verify_live.MIXED_CONSENT_ROAST_ID,
                load_telemetry_verify_live.MIXED_CONSENT_TRUE_RUN_ID,
                load_telemetry_verify_live.MIXED_CONSENT_TRUE_SLUG,
                summary_json,
                load_telemetry_verify_live.MIXED_CONSENT_ROAST_ID,
                load_telemetry_verify_live.MIXED_CONSENT_FALSE_RUN_ID,
                load_telemetry_verify_live.MIXED_CONSENT_FALSE_SLUG,
                summary_json,
                load_telemetry_verify_live.OPTED_OUT_ROAST_ID,
                load_telemetry_verify_live.OPTED_OUT_RUN_ID,
                load_telemetry_verify_live.OPTED_OUT_SLUG,
                summary_json,
                load_telemetry_verify_live.CONSENT_FLIP_ROAST_ID,
                load_telemetry_verify_live.CONSENT_FLIP_RUN_ID,
                load_telemetry_verify_live.CONSENT_FLIP_SLUG,
                summary_json,
            ),
        ),
        (
            "INSERT INTO app.roast_telemetry "
            "(roast_id, elapsed_s, bean_temp_c, env_temp_c, heat_percent, "
            "fan_percent, ror_c_per_min, raw) "
            "SELECT %s, 0, 20, 21, 80, 30, NULL, PARSE_JSON('{}')",
            (load_telemetry_verify_live.SENTINEL_ROAST_ID,),
        ),
        (
            "UPDATE app.cloud_roasts SET contributed_to_learning = "
            "CASE WHEN id = %s THEN TRUE ELSE FALSE END "
            "WHERE (id = %s AND idempotency_key = %s) "
            "OR (id = %s AND idempotency_key = %s)",
            (
                load_telemetry_verify_live.TEST_ROAST_ID,
                load_telemetry_verify_live.TEST_ROAST_ID,
                load_telemetry_verify_live.TEST_RUN_ID,
                load_telemetry_verify_live.CONSENT_FLIP_ROAST_ID,
                load_telemetry_verify_live.CONSENT_FLIP_RUN_ID,
            ),
        ),
        (
            "DELETE FROM app.roast_telemetry "
            "WHERE roast_id IN (%s, %s, %s, %s, %s, %s)",
            (
                load_telemetry_verify_live.TEST_ROAST_ID,
                load_telemetry_verify_live.SENTINEL_ROAST_ID,
                load_telemetry_verify_live.MISSING_ROAST_ID,
                *gate_a_ids,
            ),
        ),
        (
            "DELETE FROM app.roast_artifacts "
            "WHERE roast_id IN (%s, %s, %s, %s)",
            (load_telemetry_verify_live.TEST_ROAST_ID, *gate_a_ids),
        ),
        (
            "DELETE FROM app.cloud_roasts "
            "WHERE (id = %s AND idempotency_key = %s) "
            "OR id IN (%s, %s, %s)",
            (
                load_telemetry_verify_live.TEST_ROAST_ID,
                load_telemetry_verify_live.TEST_RUN_ID,
                *gate_a_ids,
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
    ]
    assert [
        statement
        for statement in agent_statements
        if statement[0].startswith("CALL app.upsert_roast")
    ] == [
        (
            "CALL app.upsert_roast(%s, %s)",
            (
                load_telemetry_verify_live.TEST_RUN_ID,
                load_telemetry_verify_live._payload(False, ("jsonl",)),
            ),
        ),
        (
            "CALL app.upsert_roast(%s, %s)",
            (
                load_telemetry_verify_live.TEST_RUN_ID,
                load_telemetry_verify_live._payload(False, ()),
            ),
        ),
        (
            "CALL app.upsert_roast(%s, %s)",
            (
                load_telemetry_verify_live.TEST_RUN_ID,
                load_telemetry_verify_live._payload(True, ()),
            ),
        ),
    ]
    assert [
        statement
        for statement in agent_statements
        if statement[0].startswith("SELECT COUNT(*) FROM app.roast_artifacts")
    ] == [
        artifact_statement,
        artifact_statement,
        (
            "SELECT COUNT(*) FROM app.roast_artifacts WHERE roast_id = %s",
            (load_telemetry_verify_live.TEST_ROAST_ID,),
        ),
        (
            "SELECT COUNT(*) FROM app.roast_artifacts WHERE roast_id = %s",
            (load_telemetry_verify_live.TEST_ROAST_ID,),
        ),
    ]
    assert [command.split(maxsplit=1)[0] for command, _ in agent_statements] == [
        "USE", "SELECT", "SELECT",
        *(privilege for _, privilege, _ in load_telemetry_verify_live.REVOKED_AGENT_DML_PROBES),
        "SELECT", "SELECT", "SELECT", "SELECT", "SELECT", "LIST",
        "SELECT", "SELECT", "SELECT", "SELECT", "LIST",
        "PUT", "CALL", "SELECT", "CALL", "SELECT", "CALL", "SELECT",
        "CALL", "SELECT", "SELECT", "CALL", "SELECT", "CALL", "SELECT",
        "SELECT", "CALL", "SELECT", "CALL", "SELECT", "SELECT", "CALL",
        "SELECT", "REMOVE",
    ]


def test_gate_a_probes_arrange_on_seed_and_reject_on_agent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = FakeConnection()
    assert connection.seed_connection is not None
    _patch_expected_helper(monkeypatch)

    assert _verify_load(
        connection,
        load_telemetry_verify_live.FIXTURE_PATH,
        "ROASTPILOT_DEV",
    ) == 1

    seed_insert = connection.seed_connection.fake_cursor.executed[0]
    assert seed_insert[0].startswith("INSERT INTO app.cloud_roasts")
    assert seed_insert[1] is not None
    assert seed_insert[1].count(load_telemetry_verify_live.MIXED_CONSENT_ROAST_ID) == 2
    assert load_telemetry_verify_live.OPTED_OUT_ROAST_ID in seed_insert[1]
    assert load_telemetry_verify_live.CONSENT_FLIP_ROAST_ID in seed_insert[1]
    assert connection.seed_connection.fake_cursor.executed[2][0].startswith(
        "UPDATE app.cloud_roasts SET contributed_to_learning = "
    )

    for roast_id in (
        load_telemetry_verify_live.MIXED_CONSENT_ROAST_ID,
        load_telemetry_verify_live.OPTED_OUT_ROAST_ID,
        load_telemetry_verify_live.CONSENT_FLIP_ROAST_ID,
    ):
        call = (
            "CALL app.load_roast_telemetry(%s, %s)",
            (load_telemetry_verify_live.TEST_RUN_ID, roast_id),
        )
        call_index = connection.fake_cursor.executed.index(call)
        assert connection.fake_cursor.executed[call_index + 1] == (
            "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
            (roast_id,),
        )


@pytest.mark.parametrize(
    ("roast_id", "label"),
    [
        (
            load_telemetry_verify_live.MIXED_CONSENT_ROAST_ID,
            "mixed-consent telemetry load",
        ),
        (
            load_telemetry_verify_live.OPTED_OUT_ROAST_ID,
            "single opt-out telemetry load",
        ),
        (
            load_telemetry_verify_live.CONSENT_FLIP_ROAST_ID,
            "committed consent-flip telemetry load",
        ),
    ],
)
def test_each_gate_a_probe_requires_20013(
    monkeypatch: pytest.MonkeyPatch,
    roast_id: str,
    label: str,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(gate_a_success_ids={roast_id})
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=rf"^{label} unexpectedly succeeded$",
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )


@pytest.mark.parametrize(
    ("roast_id", "message"),
    [
        (
            load_telemetry_verify_live.MIXED_CONSENT_ROAST_ID,
            "mixed-consent telemetry load inserted rows",
        ),
        (
            load_telemetry_verify_live.OPTED_OUT_ROAST_ID,
            "single opt-out telemetry load inserted rows",
        ),
        (
            load_telemetry_verify_live.CONSENT_FLIP_ROAST_ID,
            "committed consent-flip telemetry load inserted rows",
        ),
    ],
)
def test_each_gate_a_probe_requires_zero_landed_rows(
    monkeypatch: pytest.MonkeyPatch,
    roast_id: str,
    message: str,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(gate_a_telemetry_counts={roast_id: 1})
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=rf"^{message}$",
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )


def test_main_connects_verifies_and_closes(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection()
    monkeypatch.setattr(load_telemetry_verify_live, "_connect", lambda _target: connection)
    monkeypatch.setattr(
        load_telemetry_verify_live,
        "connect_seed",
        lambda _target: connection.seed_connection,
    )

    assert load_telemetry_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 0
    assert connection.closed is True
    assert connection.seed_connection is not None
    assert connection.seed_connection.closed is True
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


def test_main_seed_connect_failure_closes_agent_and_is_sanitised(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    connection = FakeConnection()
    monkeypatch.setattr(
        load_telemetry_verify_live, "_connect", lambda _target: connection
    )

    def fail_seed(_target: str) -> None:
        raise SystemExit("seed key at /secret/keys/seed.p8")

    monkeypatch.setattr(load_telemetry_verify_live, "connect_seed", fail_seed)
    assert load_telemetry_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    captured = capsys.readouterr()
    assert captured.err == (
        "telemetry verification failed: Snowflake seed connection failed\n"
    )
    assert "/secret/keys/seed.p8" not in captured.err
    assert connection.closed is True


def test_main_seed_connect_failure_swallows_agent_close_error(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    connection = FakeConnection(close_error_text="agent close boom /secret/keys/agent.p8")
    monkeypatch.setattr(
        load_telemetry_verify_live, "_connect", lambda _target: connection
    )

    def fail_seed(_target: str) -> None:
        raise SystemExit("seed key at /secret/keys/seed.p8")

    monkeypatch.setattr(load_telemetry_verify_live, "connect_seed", fail_seed)
    assert load_telemetry_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    captured = capsys.readouterr()
    assert captured.err == (
        "telemetry verification failed: Snowflake seed connection failed\n"
    )
    assert "/secret/keys/seed.p8" not in captured.err
    assert "/secret/keys/agent.p8" not in captured.err
    assert connection.closed is True


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

    def failing_verify(_connection, _seed_connection, _fixture_path, _target) -> int:
        raise RuntimeError(
            "account ab12345.eu-west-1.snowflakecomputing.com at /Users/op/key.p8"
        )

    monkeypatch.setattr(load_telemetry_verify_live, "_connect", lambda _target: connection)
    monkeypatch.setattr(
        load_telemetry_verify_live,
        "connect_seed",
        lambda _target: connection.seed_connection,
    )
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
    monkeypatch.setattr(
        load_telemetry_verify_live,
        "connect_seed",
        lambda _target: connection.seed_connection,
    )

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


def test_main_surfaces_sanitised_seed_close_failure(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection()
    assert connection.seed_connection is not None
    connection.seed_connection.close_error_text = "/secret/keys/seed.p8"
    monkeypatch.setattr(
        load_telemetry_verify_live, "_connect", lambda _target: connection
    )
    monkeypatch.setattr(
        load_telemetry_verify_live,
        "connect_seed",
        lambda _target: connection.seed_connection,
    )

    assert load_telemetry_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    captured = capsys.readouterr()
    assert "Snowflake seed connection close failed" in captured.err
    assert "/secret/keys/seed.p8" not in captured.err
    assert connection.closed is True
    assert connection.seed_connection.closed is True


def test_allowed_targets_are_dev_only_and_preview_is_rejected() -> None:
    assert load_telemetry_verify_live.ALLOWED_TARGETS == frozenset({"ROASTPILOT_DEV"})
    connection = FakeConnection()
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^rejected telemetry target: 'ROASTPILOT_PREVIEW'$",
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_PREVIEW",
        )
    assert connection.fake_cursor.executed == []


def test_database_mismatch_rejects_before_put_or_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(
        database="ROASTPILOT_PROD", cloud_preflight_counts=(0, 1, 0)
    )
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^connected database does not match target$",
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )
    assert _commands(connection) == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_DATABASE()",
    ]
    assert connection.seed_connection is not None
    assert connection.seed_connection.fake_cursor.executed == []


def test_role_mismatch_rejects_before_put_or_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(
        role="ACCOUNTADMIN", cloud_preflight_counts=(0, 1, 0)
    )
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^connected role is not ROASTPILOT_AGENT$",
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )
    assert _commands(connection) == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_DATABASE()",
        "SELECT CURRENT_ROLE()",
    ]
    assert connection.seed_connection is not None
    assert connection.seed_connection.fake_cursor.executed == []


def test_uuid_shape_guard_rejects_before_self_heal_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(load_telemetry_verify_live, "TEST_RUN_ID", "NOT-A-UUID")
    connection = FakeConnection(cloud_preflight_counts=(0, 1, 0))

    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^TEST_RUN_ID is not a lowercase UUID$",
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )

    assert connection.fake_cursor.executed == []
    assert connection.seed_connection is not None
    assert connection.seed_connection.fake_cursor.executed == []


def test_agent_dml_revoke_assertion_rejects_before_self_heal_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    allowed_probe = next(
        command
        for table, privilege, command in (
            load_telemetry_verify_live.REVOKED_AGENT_DML_PROBES
        )
        if (table, privilege) == ("cloud_roasts", "INSERT")
    )
    connection = FakeConnection(
        allowed_probe=allowed_probe, cloud_preflight_counts=(0, 1, 0)
    )

    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=(
            r"^cloud_roasts INSERT revoke not effective: "
            r"no-op DML unexpectedly succeeded$"
        ),
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )

    assert allowed_probe in _commands(connection)
    assert not any(
        command.startswith("SELECT COUNT(*) FROM app.cloud_roasts")
        for command in _commands(connection)
    )
    assert connection.seed_connection is not None
    assert connection.seed_connection.fake_cursor.executed == []


def _assert_no_verification_body(connection: FakeConnection) -> None:
    body_prefixes = ("PUT ", "CALL ")
    assert not any(
        command.startswith(body_prefixes) for command in _commands(connection)
    )


def _assert_no_agent_table_delete(connection: FakeConnection) -> None:
    deny_probes = {
        command
        for _, privilege, command in load_telemetry_verify_live.REVOKED_AGENT_DML_PROBES
        if privilege == "DELETE"
    }
    assert not any(
        command.startswith("DELETE FROM app.") and command not in deny_probes
        for command in _commands(connection)
    )


def _assert_table_self_heal_proceeds(
    monkeypatch: pytest.MonkeyPatch,
    detect_query: str,
    recovery_delete: tuple[str, tuple[object, ...]],
    detect_count: int = 2,
    **cursor_options: object,
) -> FakeConnection:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(**cursor_options)
    assert _verify_load(
        connection,
        load_telemetry_verify_live.FIXTURE_PATH,
        "ROASTPILOT_DEV",
    ) == 1
    assert connection.seed_connection is not None
    assert connection.seed_connection.fake_cursor.executed[0] == recovery_delete
    assert sum(command == detect_query for command in _commands(connection)) == detect_count
    _assert_no_agent_table_delete(connection)
    assert any(command.startswith("PUT ") for command in _commands(connection))
    assert (
        "CALL app.load_roast_telemetry(%s, %s)",
        (
            load_telemetry_verify_live.TEST_RUN_ID,
            load_telemetry_verify_live.TEST_ROAST_ID,
        ),
    ) in connection.fake_cursor.executed
    return connection


def _assert_table_collision_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    message: str,
    detect_query: str,
    recovery_delete: tuple[str, tuple[object, ...]],
    detect_count: int = 2,
    **cursor_options: object,
) -> FakeConnection:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(**cursor_options)
    with pytest.raises(load_telemetry_verify_live.TelemetryVerifyError, match=message):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )
    assert connection.seed_connection is not None
    assert connection.seed_connection.fake_cursor.executed == [recovery_delete]
    assert sum(command == detect_query for command in _commands(connection)) == detect_count
    _assert_no_agent_table_delete(connection)
    _assert_no_verification_body(connection)
    return connection


def test_cloud_roast_synthetic_orphan_is_self_healed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gate_a_ids = (
        load_telemetry_verify_live.MIXED_CONSENT_ROAST_ID,
        load_telemetry_verify_live.OPTED_OUT_ROAST_ID,
        load_telemetry_verify_live.CONSENT_FLIP_ROAST_ID,
    )
    _assert_table_self_heal_proceeds(
        monkeypatch,
        "SELECT COUNT(*) FROM app.cloud_roasts "
        "WHERE id IN (%s, %s, %s, %s, %s, %s) "
        "OR idempotency_key IN (%s, %s, %s, %s, %s) "
        "OR public_slug IN (%s, %s, %s, %s, %s)",
        (
            "DELETE FROM app.cloud_roasts "
            "WHERE (id = %s AND idempotency_key = %s) "
            "OR id IN (%s, %s, %s)",
            (
                load_telemetry_verify_live.TEST_ROAST_ID,
                load_telemetry_verify_live.TEST_RUN_ID,
                *gate_a_ids,
            ),
        ),
        detect_count=1,
        cloud_preflight_counts=(0, 1, 0),
    )


def test_telemetry_synthetic_orphan_is_self_healed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ids = (
        load_telemetry_verify_live.TEST_ROAST_ID,
        load_telemetry_verify_live.SENTINEL_ROAST_ID,
        load_telemetry_verify_live.MISSING_ROAST_ID,
        load_telemetry_verify_live.MIXED_CONSENT_ROAST_ID,
        load_telemetry_verify_live.OPTED_OUT_ROAST_ID,
        load_telemetry_verify_live.CONSENT_FLIP_ROAST_ID,
    )
    _assert_table_self_heal_proceeds(
        monkeypatch,
        "SELECT COUNT(*) FROM app.roast_telemetry "
        "WHERE roast_id IN (%s, %s, %s, %s, %s, %s)",
        (
            "DELETE FROM app.roast_telemetry "
            "WHERE roast_id IN (%s, %s, %s, %s, %s, %s)",
            ids,
        ),
        telemetry_preflight_counts=(1, 0),
    )


def test_artifact_synthetic_orphan_is_self_healed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ids = (
        load_telemetry_verify_live.TEST_ROAST_ID,
        load_telemetry_verify_live.MIXED_CONSENT_ROAST_ID,
        load_telemetry_verify_live.OPTED_OUT_ROAST_ID,
        load_telemetry_verify_live.CONSENT_FLIP_ROAST_ID,
    )
    _assert_table_self_heal_proceeds(
        monkeypatch,
        "SELECT COUNT(*) FROM app.roast_artifacts "
        "WHERE roast_id IN (%s, %s, %s, %s)",
        (
            "DELETE FROM app.roast_artifacts "
            "WHERE roast_id IN (%s, %s, %s, %s)",
            ids,
        ),
        artifact_preflight_counts=(1, 0),
    )


def test_reference_summary_synthetic_orphan_is_self_healed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    params = (
        load_telemetry_verify_live.BEAN_ORIGIN,
        load_telemetry_verify_live.ROAST_LEVEL,
    )
    _assert_table_self_heal_proceeds(
        monkeypatch,
        "SELECT COUNT(*) FROM app.reference_roast_summaries "
        "WHERE bean_origin = %s AND roast_level = %s",
        (
            "DELETE FROM app.reference_roast_summaries "
            "WHERE bean_origin = %s AND roast_level = %s",
            params,
        ),
        summary_preflight_counts=(1, 0),
    )


def test_preflight_self_heal_deletes_children_before_parent(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(
        telemetry_preflight_counts=(1, 0),
        artifact_preflight_counts=(1, 0),
        cloud_preflight_counts=(0, 1, 0),
        summary_preflight_counts=(1, 0),
    )

    assert _verify_load(
        connection, load_telemetry_verify_live.FIXTURE_PATH, "ROASTPILOT_DEV"
    ) == 1
    assert connection.seed_connection is not None
    assert [command.split()[2] for command in _commands(connection.seed_connection)[:4]] == [
        "app.roast_telemetry",
        "app.roast_artifacts",
        "app.cloud_roasts",
        "app.reference_roast_summaries",
    ]
    _assert_no_agent_table_delete(connection)


def test_stage_fixture_orphan_is_self_healed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    stage_prefix = (
        f"@app.roast_artifacts/{load_telemetry_verify_live.TEST_RUN_ID}/"
    )
    connection = FakeConnection(
        stage_preflight_reads=((f"{stage_prefix}roast.jsonl",), ())
    )

    assert _verify_load(
        connection,
        load_telemetry_verify_live.FIXTURE_PATH,
        "ROASTPILOT_DEV",
    ) == 1

    list_statement = (f"LIST {stage_prefix}", None)
    remove_statement = (f"REMOVE {stage_prefix}", None)
    assert connection.fake_cursor.executed.count(list_statement) == 2
    first_list = connection.fake_cursor.executed.index(list_statement)
    first_remove = connection.fake_cursor.executed.index(remove_statement)
    second_list = connection.fake_cursor.executed.index(list_statement, first_list + 1)
    assert first_list < first_remove < second_list
    assert any(command.startswith("PUT ") for command in _commands(connection))
    assert connection.seed_connection is not None
    assert not any(
        command.startswith(("LIST ", "REMOVE "))
        for command in _commands(connection.seed_connection)
    )
    _assert_no_agent_table_delete(connection)


def test_unhealable_cloud_collision_aborts_before_any_self_heal_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(
        cloud_preflight_counts=(1, 0),
        telemetry_preflight_counts=(1,),
        artifact_preflight_counts=(1,),
        summary_preflight_counts=(1,),
    )

    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^telemetry verifier roast keys are already owned$",
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )

    unhealable_probe = next(
        statement
        for statement in connection.fake_cursor.executed
        if "IS NOT TRUE" in statement[0]
    )
    assert unhealable_probe[1] is not None
    assert load_telemetry_verify_live.SENTINEL_ROAST_ID in unhealable_probe[1]
    assert any(command.startswith("LIST ") for command in _commands(connection))
    assert connection.seed_connection is not None
    assert connection.seed_connection.fake_cursor.executed == []
    _assert_no_agent_table_delete(connection)
    assert not any(command.startswith("REMOVE ") for command in _commands(connection))
    _assert_no_verification_body(connection)


def test_null_id_reserved_key_cloud_row_aborts_before_any_self_heal_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    malformed_cloud_rows = ((None, load_telemetry_verify_live.TEST_RUN_ID),)
    connection = FakeConnection(
        cloud_unhealable_rows=malformed_cloud_rows,
        telemetry_preflight_counts=(1, 0),
        artifact_preflight_counts=(1, 0),
        summary_preflight_counts=(1, 0),
    )

    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^telemetry verifier roast keys are already owned$",
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )

    unhealable_probe = next(
        statement
        for statement in connection.fake_cursor.executed
        if "IS NOT TRUE" in statement[0]
    )
    assert connection.fake_cursor.cloud_unhealable_rows == malformed_cloud_rows
    assert unhealable_probe[1] is not None
    assert load_telemetry_verify_live.TEST_RUN_ID in unhealable_probe[1]
    assert connection.seed_connection is not None
    assert connection.seed_connection.fake_cursor.executed == []
    _assert_no_agent_table_delete(connection)
    assert not any(command.startswith("REMOVE ") for command in _commands(connection))
    _assert_no_verification_body(connection)


def test_cloud_recheck_residue_still_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    gate_a_ids = (
        load_telemetry_verify_live.MIXED_CONSENT_ROAST_ID,
        load_telemetry_verify_live.OPTED_OUT_ROAST_ID,
        load_telemetry_verify_live.CONSENT_FLIP_ROAST_ID,
    )
    _assert_table_collision_fails_closed(
        monkeypatch,
        r"^telemetry verifier roast keys are already owned$",
        "SELECT COUNT(*) FROM app.cloud_roasts "
        "WHERE id IN (%s, %s, %s, %s, %s, %s) "
        "OR idempotency_key IN (%s, %s, %s, %s, %s) "
        "OR public_slug IN (%s, %s, %s, %s, %s)",
        (
            "DELETE FROM app.cloud_roasts "
            "WHERE (id = %s AND idempotency_key = %s) "
            "OR id IN (%s, %s, %s)",
            (
                load_telemetry_verify_live.TEST_ROAST_ID,
                load_telemetry_verify_live.TEST_RUN_ID,
                *gate_a_ids,
            ),
        ),
        detect_count=1,
        cloud_preflight_counts=(0, 1, 1),
    )


def test_non_synthetic_telemetry_collision_still_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ids = (
        load_telemetry_verify_live.TEST_ROAST_ID,
        load_telemetry_verify_live.SENTINEL_ROAST_ID,
        load_telemetry_verify_live.MISSING_ROAST_ID,
        load_telemetry_verify_live.MIXED_CONSENT_ROAST_ID,
        load_telemetry_verify_live.OPTED_OUT_ROAST_ID,
        load_telemetry_verify_live.CONSENT_FLIP_ROAST_ID,
    )
    _assert_table_collision_fails_closed(
        monkeypatch,
        r"^telemetry verifier row keys are already owned$",
        "SELECT COUNT(*) FROM app.roast_telemetry "
        "WHERE roast_id IN (%s, %s, %s, %s, %s, %s)",
        (
            "DELETE FROM app.roast_telemetry "
            "WHERE roast_id IN (%s, %s, %s, %s, %s, %s)",
            ids,
        ),
        telemetry_preflight_counts=(1, 1),
    )


def test_non_synthetic_artifact_collision_still_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    ids = (
        load_telemetry_verify_live.TEST_ROAST_ID,
        load_telemetry_verify_live.MIXED_CONSENT_ROAST_ID,
        load_telemetry_verify_live.OPTED_OUT_ROAST_ID,
        load_telemetry_verify_live.CONSENT_FLIP_ROAST_ID,
    )
    _assert_table_collision_fails_closed(
        monkeypatch,
        r"^telemetry verifier artifact key is already owned$",
        "SELECT COUNT(*) FROM app.roast_artifacts "
        "WHERE roast_id IN (%s, %s, %s, %s)",
        (
            "DELETE FROM app.roast_artifacts "
            "WHERE roast_id IN (%s, %s, %s, %s)",
            ids,
        ),
        artifact_preflight_counts=(1, 1),
    )


def test_non_synthetic_summary_collision_still_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    params = (
        load_telemetry_verify_live.BEAN_ORIGIN,
        load_telemetry_verify_live.ROAST_LEVEL,
    )
    _assert_table_collision_fails_closed(
        monkeypatch,
        r"^telemetry verifier summary key is already owned$",
        "SELECT COUNT(*) FROM app.reference_roast_summaries "
        "WHERE bean_origin = %s AND roast_level = %s",
        (
            "DELETE FROM app.reference_roast_summaries "
            "WHERE bean_origin = %s AND roast_level = %s",
            params,
        ),
        summary_preflight_counts=(1, 1),
    )


@pytest.mark.parametrize(
    "stage_suffix",
    ["foreign/roast.jsonl", "foreign.jsonl"],
    ids=["nested-fixture", "wrong-root-file"],
)
def test_unhealable_stage_collision_aborts_before_any_self_heal_write(
    monkeypatch: pytest.MonkeyPatch,
    stage_suffix: str,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(
        cloud_preflight_counts=(0, 1),
        telemetry_preflight_counts=(1,),
        artifact_preflight_counts=(1,),
        summary_preflight_counts=(1,),
        stage_preflight_rows=(
            f"owned-prefix/{load_telemetry_verify_live.TEST_RUN_ID}/{stage_suffix}",
        ),
    )
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^telemetry verifier stage prefix is already owned$",
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )
    assert not any(command.startswith("REMOVE ") for command in _commands(connection))
    _assert_no_agent_table_delete(connection)
    _assert_no_verification_body(connection)
    assert connection.seed_connection is not None
    assert connection.seed_connection.fake_cursor.executed == []


def test_repeated_stage_marker_aborts_without_remove_or_seed_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    marker = f"{load_telemetry_verify_live.TEST_RUN_ID}/"
    connection = FakeConnection(
        telemetry_preflight_counts=(1, 0),
        artifact_preflight_counts=(1, 0),
        summary_preflight_counts=(1, 0),
        stage_preflight_rows=(f"@app.roast_artifacts/{marker}{marker}roast.jsonl",),
    )

    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^telemetry verifier stage prefix is already owned$",
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )

    assert not any(command.startswith("REMOVE ") for command in _commands(connection))
    assert connection.seed_connection is not None
    assert connection.seed_connection.fake_cursor.executed == []
    _assert_no_verification_body(connection)


def test_multiple_fixture_stage_rows_fail_closed_without_remove(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(
        stage_preflight_rows=("first/roast.jsonl", "second/roast.jsonl")
    )
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^telemetry verifier stage prefix is already owned$",
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )
    assert not any(command.startswith("REMOVE ") for command in _commands(connection))
    _assert_no_verification_body(connection)


def test_stage_recheck_must_be_empty_after_remove(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    stage_prefix = f"owned-prefix/{load_telemetry_verify_live.TEST_RUN_ID}/"
    connection = FakeConnection(
        stage_preflight_reads=(
            (f"{stage_prefix}roast.jsonl",),
            (f"{stage_prefix}roast.jsonl",),
        )
    )
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^telemetry verifier stage prefix is already owned$",
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )
    assert sum(command.startswith("LIST ") for command in _commands(connection)) == 2
    assert sum(command.startswith("REMOVE ") for command in _commands(connection)) == 1
    _assert_no_verification_body(connection)


@pytest.mark.parametrize(
    ("count_option", "counts", "fail_on", "message", "expected_delete"),
    [
        (
            "cloud_preflight_counts",
            (0, 1),
            "DELETE FROM app.cloud_roasts",
            "telemetry verifier roast keys are already owned",
            "DELETE FROM app.cloud_roasts "
            "WHERE (id = %s AND idempotency_key = %s) OR id IN (%s, %s, %s)",
        ),
        (
            "telemetry_preflight_counts",
            (1,),
            "DELETE FROM app.roast_telemetry",
            "telemetry verifier row keys are already owned",
            "DELETE FROM app.roast_telemetry "
            "WHERE roast_id IN (%s, %s, %s, %s, %s, %s)",
        ),
        (
            "artifact_preflight_counts",
            (1,),
            "DELETE FROM app.roast_artifacts",
            "telemetry verifier artifact key is already owned",
            "DELETE FROM app.roast_artifacts "
            "WHERE roast_id IN (%s, %s, %s, %s)",
        ),
        (
            "summary_preflight_counts",
            (1,),
            "DELETE FROM app.reference_roast_summaries",
            "telemetry verifier summary key is already owned",
            "DELETE FROM app.reference_roast_summaries "
            "WHERE bean_origin = %s AND roast_level = %s",
        ),
    ],
)
def test_table_self_heal_delete_failure_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    count_option: str,
    counts: tuple[object, ...],
    fail_on: str,
    message: str,
    expected_delete: str,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(**{count_option: counts, "fail_on": fail_on})

    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=rf"^{message}$",
    ) as raised:
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )

    assert isinstance(raised.value.__cause__, RuntimeError)
    assert connection.seed_connection is not None
    assert _commands(connection.seed_connection) == [expected_delete]
    _assert_no_agent_table_delete(connection)
    _assert_no_verification_body(connection)


def test_stage_self_heal_remove_failure_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(
        stage_preflight_rows=(
            f"owned-prefix/{load_telemetry_verify_live.TEST_RUN_ID}/roast.jsonl",
        ),
        fail_on="REMOVE ",
    )

    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^telemetry verifier stage prefix is already owned$",
    ) as raised:
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )

    assert isinstance(raised.value.__cause__, RuntimeError)
    assert sum(command.startswith("LIST ") for command in _commands(connection)) == 1
    assert sum(command.startswith("REMOVE ") for command in _commands(connection)) == 1
    _assert_no_verification_body(connection)
    assert connection.seed_connection is not None
    assert connection.seed_connection.fake_cursor.executed == []


def test_row_count_mismatch_is_detected(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(loaded="2")
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^procedure row count does not match fixture expectation$",
    ):
        _verify_load(
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
        _verify_load(
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
        _verify_load(
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
        match=r"^live verification body failed$",
    ) as raised:
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )
    assert isinstance(raised.value.__cause__, RuntimeError)
    assert connection.seed_connection is not None
    assert _commands(connection.seed_connection)[-1:] == [
        "DELETE FROM app.reference_roast_summaries "
        "WHERE bean_origin = %s AND roast_level = %s"
    ]
    assert _commands(connection)[-1] == (
        f"REMOVE @app.roast_artifacts/{load_telemetry_verify_live.TEST_RUN_ID}/"
    )


def test_body_error_survives_delete_cleanup_failure(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _patch_expected_helper(monkeypatch)
    mismatched = list(EXPECTED_TUPLE)
    mismatched[2] = 99.0
    connection = FakeConnection(actual=[tuple(mismatched)], fail_on="DELETE")
    monkeypatch.setattr(load_telemetry_verify_live, "_connect", lambda _target: connection)
    monkeypatch.setattr(
        load_telemetry_verify_live,
        "connect_seed",
        lambda _target: connection.seed_connection,
    )

    assert load_telemetry_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1

    assert connection.seed_connection is not None
    assert _commands(connection.seed_connection)[-4:] == [
        "DELETE FROM app.roast_telemetry "
        "WHERE roast_id IN (%s, %s, %s, %s, %s, %s)",
        "DELETE FROM app.roast_artifacts WHERE roast_id IN (%s, %s, %s, %s)",
        "DELETE FROM app.cloud_roasts WHERE (id = %s AND idempotency_key = %s) "
        "OR id IN (%s, %s, %s)",
        "DELETE FROM app.reference_roast_summaries "
        "WHERE bean_origin = %s AND roast_level = %s",
    ]
    assert _commands(connection)[-1].startswith("REMOVE ")
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
    monkeypatch.setattr(
        load_telemetry_verify_live,
        "connect_seed",
        lambda _target: connection.seed_connection,
    )

    assert load_telemetry_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1

    assert connection.seed_connection is not None
    assert _commands(connection.seed_connection)[-4:] == [
        "DELETE FROM app.roast_telemetry "
        "WHERE roast_id IN (%s, %s, %s, %s, %s, %s)",
        "DELETE FROM app.roast_artifacts WHERE roast_id IN (%s, %s, %s, %s)",
        "DELETE FROM app.cloud_roasts WHERE (id = %s AND idempotency_key = %s) "
        "OR id IN (%s, %s, %s)",
        "DELETE FROM app.reference_roast_summaries "
        "WHERE bean_origin = %s AND roast_level = %s",
    ]
    assert _commands(connection)[-1].startswith("REMOVE ")
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
    monkeypatch.setattr(
        load_telemetry_verify_live,
        "connect_seed",
        lambda _target: connection.seed_connection,
    )

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
    monkeypatch.setattr(
        load_telemetry_verify_live,
        "connect_seed",
        lambda _target: connection.seed_connection,
    )

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
        _verify_load(
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
        match=r"^missing-roast telemetry load inserted rows$",
    ):
        _verify_load(
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
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )
    assert connection.seed_connection is not None
    assert not any(
        command.startswith("UPDATE app.cloud_roasts SET contributed_to_learning = ")
        for command in _commands(connection.seed_connection)
    )


def test_opt_out_recompute_must_leave_zero_contribution_summary(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    changed = (1, *SUMMARY_BEFORE[1:])
    connection = FakeConnection(summary_after_opt_out=changed)
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^opt-out roast contributed to the reference summary$",
    ):
        _verify_load(
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
        match=r"^opt-in roast did not move the reference summary$",
    ):
        _verify_load(
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
        _verify_load(
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
        match=r"^rejected opt-out manifest inserted artifact rows$",
    ):
        _verify_load(
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
        match=r"^empty opt-out manifest left artifact rows$",
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )


def test_opt_out_load_must_not_insert_target_rows(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(opt_out_telemetry_count=1)
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^opt-out telemetry load inserted rows$",
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )


def test_opt_out_load_must_not_change_sentinel_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(sentinel_counts=(0, 1))
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^opt-out telemetry load changed the sentinel row$",
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )


def test_opt_in_load_must_not_change_sentinel_row(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(sentinel_counts=(1, 0))
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^opt-in telemetry load changed the sentinel row$",
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )


def test_opt_in_recompute_must_populate_summary_averages(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(
        summary_after_opt_in=(1, 0, None, None, None, None, None, None, None, None)
    )
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^opt-in roast did not populate summary averages$",
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )


def test_opt_out_nonzero_review_count_is_flagged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # review_count set, every average NULL: pins the OR between the review-count
    # branch and the any(averages) branch in the opt-out contribution guard.
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(
        summary_after_opt_out=(0, 1, None, None, None, None, None, None, None, None)
    )
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^opt-out roast contributed to the reference summary$",
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )


def test_opt_out_nonzero_average_is_flagged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Only avg_rating (index 2) is set: pins the [2:] slice start in the opt-out
    # contribution guard (a [3:] mutation would skip avg_rating).
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(
        summary_after_opt_out=(0, 0, 4.5, None, None, None, None, None, None, None)
    )
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^opt-out roast contributed to the reference summary$",
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )


def test_opt_in_wrong_count_flags_move_even_when_distinct(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # roast_count != 1 while the summary DID change: pins the OR in the opt-in
    # move guard (an AND mutation would fall through to the averages check).
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(
        summary_after_opt_in=(2, 0, None, None, None, None, None, None, None, None)
    )
    with pytest.raises(
        load_telemetry_verify_live.TelemetryVerifyError,
        match=r"^opt-in roast did not move the reference summary$",
    ):
        _verify_load(
            connection,
            load_telemetry_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )


def test_opt_in_first_average_present_is_sufficient(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # Only the first average (index 3) is populated: pins the [3:] slice start in
    # the opt-in averages guard (a [4:] mutation would wrongly flag this).
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(
        summary_after_opt_in=(1, 0, None, 24.0, None, None, None, None, None, None)
    )
    assert _verify_load(
        connection,
        load_telemetry_verify_live.FIXTURE_PATH,
        "ROASTPILOT_DEV",
    ) == 1


def test_stage_remove_cleanup_failure_is_labelled_and_sanitised(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _patch_expected_helper(monkeypatch)
    connection = FakeConnection(
        fail_on="REMOVE",
        cleanup_error_text=(
            "connect failed for account "
            "ab12345.eu-west-1.snowflakecomputing.com at /Users/op/key.p8"
        ),
    )
    monkeypatch.setattr(load_telemetry_verify_live, "_connect", lambda _target: connection)
    monkeypatch.setattr(
        load_telemetry_verify_live,
        "connect_seed",
        lambda _target: connection.seed_connection,
    )

    assert load_telemetry_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.splitlines() == [
        "telemetry verification failed: telemetry verification cleanup failed",
        f"cleanup failed for run id {load_telemetry_verify_live.TEST_RUN_ID}: "
        "stage REMOVE cleanup failed",
    ]
    assert "snowflakecomputing.com" not in captured.err
    assert "/Users/op" not in captured.err
