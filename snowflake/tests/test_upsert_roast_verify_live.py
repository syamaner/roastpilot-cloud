"""Contract tests for the operator-run live upsert verifier (issue #417)."""

from __future__ import annotations

import json
import re
import sys
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import upsert_roast_verify_live  # noqa: E402


ROAST_ID = "c3c3c3c3-4170-4170-4170-c3c3c3c3c3c3"
FIRST_RESULT = {
    "cloud_roast_id": ROAST_ID,
    "public_slug": upsert_roast_verify_live.PUBLIC_SLUG,
}
BEFORE = (
    ROAST_ID,
    upsert_roast_verify_live.TEST_RUN_ID,
    None,
    upsert_roast_verify_live.PUBLIC_SLUG,
    "private",
    "created",
    1,
)


class FakeCursor:
    def __init__(
        self,
        *,
        database: str = "ROASTPILOT_DEV",
        role: str = "ROASTPILOT_AGENT",
        listed_names: set[str] | None = None,
        roast_count: object = 1,
        replay_result: dict[str, object] | None = None,
        artifact_count: object = 3,
        artifact_pairs: set[tuple[object, object]] | None = None,
        stored_pair: tuple[object, object] = (ROAST_ID, upsert_roast_verify_live.PUBLIC_SLUG),
        stored_visibility: object = "private",
        stored_notes: object = upsert_roast_verify_live.ORIGINAL_NOTES,
        telemetry_setup_count: object = 2,
        telemetry_survives: bool = False,
        sentinel_survives: bool = True,
        visibility_raises: bool = True,
        visibility_error: str = "-20012 visibility_change_not_supported",
        updated_after: object = 2,
        fail_on: set[str] | None = None,
    ) -> None:
        run_id = upsert_roast_verify_live.TEST_RUN_ID
        self.database, self.role = database, role
        self.listed_names = listed_names if listed_names is not None else {
            f"roast_artifacts/{run_id}/{path.name}"
            for path in upsert_roast_verify_live.FIXTURE_PATHS
        }
        self.roast_count = roast_count
        self.replay_result = FIRST_RESULT if replay_result is None else replay_result
        self.artifact_count = artifact_count
        self.artifact_pairs = artifact_pairs if artifact_pairs is not None else {
            (kind, f"@app.roast_artifacts/{run_id}/{basename}")
            for kind, basename in upsert_roast_verify_live.ARTIFACT_BASENAMES.items()
        }
        self.stored_pair = stored_pair
        self.stored_visibility, self.stored_notes = stored_visibility, stored_notes
        self.telemetry_setup_count = telemetry_setup_count
        self.telemetry_survives, self.sentinel_survives = (
            telemetry_survives, sentinel_survives
        )
        self.visibility_raises, self.visibility_error = visibility_raises, visibility_error
        self.updated_after = updated_after
        self.fail_on = set() if fail_on is None else fail_on
        self.executed: list[tuple[str, tuple[object, ...] | None]] = []
        self.call_results: list[dict[str, object]] = []
        self.last_call_result: dict[str, object] | None = None
        self.preserved_reads = 0
        self.opted_out = False
        self.telemetry_seeded = False

    def execute(self, command: str, params=None):
        normalized = tuple(params) if params is not None else None
        self.executed.append((command, normalized))
        if any(command.startswith(prefix) for prefix in self.fail_on):
            raise RuntimeError(f"scripted cleanup failure: {command.split()[0]}")
        if command.startswith("CALL app.upsert_roast"):
            assert normalized is not None
            payload = json.loads(str(normalized[1]))
            if payload["operator_notes"] == upsert_roast_verify_live.ROLLBACK_NOTES:
                if self.visibility_raises:
                    raise RuntimeError(self.visibility_error)
                self.last_call_result = FIRST_RESULT
            elif payload["contributed_to_learning"] is False:
                self.opted_out = True
                self.last_call_result = FIRST_RESULT
            elif len(self.call_results) == 1:
                self.last_call_result = self.replay_result
            else:
                self.last_call_result = FIRST_RESULT
            self.call_results.append(self.last_call_result)
        elif command.startswith("INSERT INTO app.roast_telemetry"):
            assert normalized == (
                ROAST_ID, ROAST_ID, upsert_roast_verify_live.OTHER_ROAST_ID
            )
            self.telemetry_seeded = True
        return self

    def fetchone(self):
        command, params = self.executed[-1]
        if command == "SELECT CURRENT_DATABASE()":
            return (self.database,)
        if command == "SELECT CURRENT_ROLE()":
            return (self.role,)
        if command.startswith("CALL app.upsert_roast"):
            return (self.last_call_result,)
        if command.startswith("SELECT COUNT(*) FROM app.cloud_roasts"):
            return (self.roast_count,)
        if command.startswith("SELECT COUNT(*) FROM app.roast_artifacts"):
            return (self.artifact_count,)
        if command.startswith("SELECT id, idempotency_key"):
            self.preserved_reads += 1
            if self.preserved_reads == 1:
                return BEFORE
            return (
                self.stored_pair[0], BEFORE[1], BEFORE[2], self.stored_pair[1],
                BEFORE[4], BEFORE[5], self.updated_after,
            )
        if command.startswith("SELECT visibility, operator_notes"):
            return self.stored_visibility, self.stored_notes
        if command.startswith("SELECT COUNT(*) FROM app.roast_telemetry"):
            assert params is not None
            if params[0] == upsert_roast_verify_live.OTHER_ROAST_ID:
                return (1 if self.telemetry_seeded and self.sentinel_survives else 0,)
            if self.opted_out:
                return (2 if self.telemetry_seeded and self.telemetry_survives else 0,)
            return (self.telemetry_setup_count if self.telemetry_seeded else 0,)
        raise AssertionError(f"unexpected fetchone after: {command}")

    def fetchall(self):
        command = self.executed[-1][0]
        if command.startswith("LIST "):
            return [(name,) for name in sorted(self.listed_names)]
        if command.startswith("SELECT kind, stage_path"):
            return sorted(self.artifact_pairs)
        raise AssertionError(f"unexpected fetchall after: {command}")


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


def _cleanup_commands(include_parent: bool = True) -> list[str]:
    commands = [
        "DELETE FROM app.roast_artifacts WHERE roast_id = %s",
        "DELETE FROM app.roast_telemetry WHERE roast_id = %s",
        "DELETE FROM app.roast_telemetry WHERE roast_id = %s",
    ]
    if include_parent:
        commands.append(
            "DELETE FROM app.cloud_roasts WHERE id = %s AND idempotency_key = %s"
        )
    commands.append(
        f"REMOVE @app.roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/"
    )
    return commands


def _verify(connection: FakeConnection) -> str:
    return upsert_roast_verify_live.verify_live_upsert(connection, "ROASTPILOT_DEV")


def test_test_run_id_is_a_lowercase_uuid() -> None:
    assert re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        upsert_roast_verify_live.TEST_RUN_ID,
    )


def test_payload_keeps_private_visibility_and_null_grouping_keys() -> None:
    payload = upsert_roast_verify_live._payload()
    assert payload["visibility"] == "private"
    assert payload["bean_origin"] is None
    assert payload["roast_level"] is None


def test_first_value_reads_mapping_by_label() -> None:
    assert upsert_roast_verify_live._first_value(
        {"CURRENT_DATABASE()": "ROASTPILOT_DEV"}, "CURRENT_DATABASE()"
    ) == "ROASTPILOT_DEV"


@pytest.mark.parametrize(
    "fixture_path",
    [Path("/tmp/outside.jsonl"), upsert_roast_verify_live.FIXTURES_DIR / "bad'name"],
)
def test_fixture_uri_rejects_outside_or_quote_bearing_path(fixture_path: Path) -> None:
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError,
                       match="rejected upsert fixture path"):
        upsert_roast_verify_live._validated_fixture_uri(fixture_path)


def test_variant_object_decodes_json_string() -> None:
    encoded = json.dumps(FIRST_RESULT)
    assert upsert_roast_verify_live._variant_object(encoded) == FIRST_RESULT


def test_variant_object_rejects_invalid_json() -> None:
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError,
                       match="returned invalid JSON"):
        upsert_roast_verify_live._variant_object("{")


def test_variant_object_rejects_non_mapping() -> None:
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError,
                       match="did not return an object"):
        upsert_roast_verify_live._variant_object([])


def test_variant_object_rejects_wrong_key_set() -> None:
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError,
                       match="returned an unexpected object"):
        upsert_roast_verify_live._variant_object({"cloud_roast_id": ROAST_ID})


def test_count_accepts_int_and_decimal() -> None:
    assert upsert_roast_verify_live._count((1,), "COUNT(*)") == 1
    assert upsert_roast_verify_live._count((Decimal("2"),), "COUNT(*)") == 2


@pytest.mark.parametrize("value", [True, "1", 1.0, None])
def test_count_rejects_bool_and_non_numeric_values(value: object) -> None:
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError,
                       match="did not return a numeric count"):
        upsert_roast_verify_live._count((value,), "COUNT(*)")


def test_stored_pair_reads_mapping() -> None:
    assert upsert_roast_verify_live._stored_pair(
        {"ID": ROAST_ID, "PUBLIC_SLUG": upsert_roast_verify_live.PUBLIC_SLUG}
    ) == (ROAST_ID, upsert_roast_verify_live.PUBLIC_SLUG)


def test_stored_pair_rejects_unexpected_row() -> None:
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError,
                       match="unexpected row"):
        upsert_roast_verify_live._stored_pair((ROAST_ID,))


def test_happy_path_pins_put_list_calls_binding_and_cleanup() -> None:
    connection = FakeConnection()
    assert _verify(connection) == ROAST_ID
    commands = _commands(connection)
    assert commands[:3] == [
        "USE SECONDARY ROLES NONE", "SELECT CURRENT_DATABASE()", "SELECT CURRENT_ROLE()"
    ]
    expected_puts = [
        f"PUT '{path.resolve().as_uri()}' "
        f"@app.roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/ "
        "AUTO_COMPRESS=FALSE OVERWRITE=TRUE"
        for path in upsert_roast_verify_live.FIXTURE_PATHS
    ]
    assert commands[3:5] == expected_puts
    assert commands[5] == (
        f"LIST @app.roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/"
    )
    calls = [entry for entry in connection.fake_cursor.executed
             if entry[0].startswith("CALL")]
    assert len(calls) == 5 and calls[0][1] == calls[1][1]
    assert all(command == "CALL app.upsert_roast(%s, %s)" for command, _ in calls)
    visibility_payload = json.loads(str(calls[3][1][1]))
    assert visibility_payload["visibility"] == "unlisted"
    assert visibility_payload["operator_notes"] == upsert_roast_verify_live.ROLLBACK_NOTES
    assert _commands(connection)[-5:] == _cleanup_commands()


@pytest.mark.parametrize(
    "listed_names",
    [
        {"roast_artifacts/run/roast.jsonl"},
        {"roast_artifacts/run/roast.jsonl.gz", "roast_artifacts/run/summary.json"},
    ],
)
def test_list_rejects_missing_or_gzipped_staged_fixture(listed_names: set[str]) -> None:
    connection = FakeConnection(listed_names=listed_names)
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError,
                       match="LIST is missing or compressed"):
        _verify(connection)


def test_main_prints_narrow_evidence_and_closes(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    connection = FakeConnection()
    monkeypatch.setattr(upsert_roast_verify_live, "_connect", lambda _target: connection)
    assert upsert_roast_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 0
    assert connection.closed is True
    output = capsys.readouterr().out
    assert "staged artifact paths for the jsonl and summary fixtures" in output
    assert "scoped opt-out telemetry purge" in output
    assert ROAST_ID in output


def test_connect_path_error_is_sanitized_before_main_prints(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    secret_path = "/Users/private-operator/keys/snowflake.p8"
    monkeypatch.setenv("SNOWFLAKE_PRIVATE_KEY_FILE", secret_path)

    def fail_read(_path: Path, **_kwargs: object) -> str:
        raise FileNotFoundError(secret_path)

    monkeypatch.setattr(Path, "read_text", fail_read)
    assert upsert_roast_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    output = capsys.readouterr()
    assert secret_path not in output.err
    assert "SNOWFLAKE_PRIVATE_KEY_FILE configuration failed" in output.err


def test_allowed_targets_are_dev_only_and_preview_is_rejected() -> None:
    connection = FakeConnection()
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError,
                       match="rejected upsert target"):
        upsert_roast_verify_live.verify_live_upsert(connection, "ROASTPILOT_PREVIEW")
    assert connection.fake_cursor.executed == []


def test_parser_rejects_non_dev_target_before_connect(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(upsert_roast_verify_live, "_connect",
                        lambda _target: pytest.fail("connect must not run"))
    with pytest.raises(SystemExit):
        upsert_roast_verify_live.main(["--target", "ROASTPILOT_PREVIEW"])


@pytest.mark.parametrize(
    ("options", "message", "commands"),
    [
        ({"database": "ROASTPILOT_PROD"}, "database does not match", 2),
        ({"role": "ACCOUNTADMIN"}, "role is not ROASTPILOT_AGENT", 3),
    ],
)
def test_database_and_role_reject_before_write(
    options: dict[str, object], message: str, commands: int
) -> None:
    connection = FakeConnection(**options)
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError, match=message):
        _verify(connection)
    assert _commands(connection) == [
        "USE SECONDARY ROLES NONE", "SELECT CURRENT_DATABASE()", "SELECT CURRENT_ROLE()"
    ][:commands]


@pytest.mark.parametrize(
    ("option", "message"),
    [
        ({"roast_count": 2}, "exactly one roast"),
        ({"artifact_count": 2}, "artifact count does not match"),
        ({"stored_pair": ("changed", upsert_roast_verify_live.PUBLIC_SLUG)},
         "slug replay changed a preserved column"),
        ({"stored_visibility": "unlisted"}, "changed stored value"),
        ({"telemetry_setup_count": 1}, "did not insert two roast rows"),
    ],
)
def test_injectable_live_guards_reject_independently(
    option: dict[str, object], message: str
) -> None:
    connection = FakeConnection(**option)
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError, match=message):
        _verify(connection)


def test_replay_equality_mismatch_is_detected() -> None:
    connection = FakeConnection(replay_result={
        "cloud_roast_id": ROAST_ID, "public_slug": upsert_roast_verify_live.REPLAY_SLUG
    })
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError,
                       match="identical replay returned a different object"):
        _verify(connection)


def test_artifact_pair_mismatch_is_detected() -> None:
    path = f"@app.roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/roast.jsonl"
    connection = FakeConnection(artifact_pairs={("summary", path)})
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError,
                       match="kind and stage_path pairs"):
        _verify(connection)


def test_updated_at_must_strictly_advance() -> None:
    connection = FakeConnection(updated_after=1)
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError,
                       match="did not advance updated_at"):
        _verify(connection)


def test_visibility_call_not_raising_is_a_failure() -> None:
    connection = FakeConnection(visibility_raises=False)
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError,
                       match="visibility replay unexpectedly succeeded"):
        _verify(connection)


def test_unexpected_visibility_error_is_not_swallowed() -> None:
    connection = FakeConnection(visibility_error="-20009 invalid payload")
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError,
                       match="failed with an unexpected error") as raised:
        _verify(connection)
    assert isinstance(raised.value.__cause__, RuntimeError)


def test_visibility_failure_must_roll_back_operator_notes() -> None:
    connection = FakeConnection(stored_notes=upsert_roast_verify_live.ROLLBACK_NOTES)
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError,
                       match="did not roll back update"):
        _verify(connection)


def test_telemetry_purge_fails_when_roast_rows_survive() -> None:
    connection = FakeConnection(telemetry_survives=True)
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError,
                       match="did not purge telemetry"):
        _verify(connection)


def test_telemetry_purge_must_not_delete_unrelated_row() -> None:
    connection = FakeConnection(sentinel_survives=False)
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError,
                       match="purged unrelated telemetry"):
        _verify(connection)


def test_successful_child_cleanup_runs_parent_delete_by_resolved_id() -> None:
    connection = FakeConnection()
    _verify(connection)
    assert _commands(connection)[-5:] == _cleanup_commands()
    assert connection.fake_cursor.executed[-2] == (
        "DELETE FROM app.cloud_roasts WHERE id = %s AND idempotency_key = %s",
        (ROAST_ID, upsert_roast_verify_live.TEST_RUN_ID),
    )


def test_failed_child_cleanup_skips_parent_and_names_run_id() -> None:
    connection = FakeConnection(fail_on={"DELETE FROM app.roast_artifacts"})
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError,
                       match=upsert_roast_verify_live.TEST_RUN_ID) as raised:
        _verify(connection)
    assert _commands(connection)[-4:] == _cleanup_commands(include_parent=False)
    assert not any(command.startswith("DELETE FROM app.cloud_roasts")
                   for command in _commands(connection))
    assert raised.value.__notes__ == [
        "additional cleanup failure: RuntimeError('scripted cleanup failure: DELETE')"
    ]


def test_cleanup_errors_are_notes_and_do_not_mask_body_error() -> None:
    connection = FakeConnection(
        roast_count=2,
        fail_on={"DELETE FROM app.roast_artifacts", "DELETE FROM app.roast_telemetry"},
    )
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError,
                       match="exactly one roast") as raised:
        _verify(connection)
    assert upsert_roast_verify_live.TEST_RUN_ID in raised.value.__notes__[0]
    assert all(note.startswith("cleanup failed:") for note in raised.value.__notes__)
