"""Contract tests for the operator-run live upsert verifier (issue #417)."""

from __future__ import annotations

import json
import re
import sys
from decimal import Decimal
from pathlib import Path
from types import ModuleType

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
RAW_PRIVATE_PATH = "/Users/private-operator/keys/snowflake.p8"


class FakeCursor:
    def __init__(
        self,
        *,
        database: str = "ROASTPILOT_DEV",
        role: str = "ROASTPILOT_AGENT",
        listed_names: set[str] | None = None,
        preexisting_stage_names: set[str] | None = None,
        remove_leaves_files: bool = False,
        existing_run_count: object = 0,
        roast_count: object = 1,
        control_roast_count: object = 1,
        final_roast_count: object = 1,
        sentinel_owner_count: object = 0,
        sentinel_telemetry_count: object = 0,
        owned_roast_id: object = ROAST_ID,
        owned_roast_id_count: object = 1,
        first_result: object = FIRST_RESULT,
        replay_result: object = FIRST_RESULT,
        slug_result: object = FIRST_RESULT,
        control_result: object = FIRST_RESULT,
        opt_out_result: object = FIRST_RESULT,
        ambiguous_roast_ids: tuple[object, ...] = (ROAST_ID, "second-roast-id"),
        cleanup_roast_ids: tuple[object, ...] = (ROAST_ID,),
        cleanup_identity_query_fails: bool = False,
        artifact_count: object = 3,
        final_artifact_count: object = 0,
        artifact_pairs: set[tuple[object, object]] | None = None,
        before_pair: tuple[object, object] = (
            ROAST_ID,
            upsert_roast_verify_live.PUBLIC_SLUG,
        ),
        stored_pair: tuple[object, object] = (
            ROAST_ID,
            upsert_roast_verify_live.PUBLIC_SLUG,
        ),
        identical_preserved_change: tuple[int, object] | None = None,
        preserved_change: tuple[int, object] | None = None,
        control_preserved_change: tuple[int, object] | None = None,
        final_preserved_change: tuple[int, object] | None = None,
        mapping_rows: bool = False,
        stored_visibility: object = "private",
        stored_notes: object = upsert_roast_verify_live.ORIGINAL_NOTES,
        stored_updated_at: object = 2,
        telemetry_setup_count: object = 2,
        telemetry_control_count: object = 2,
        telemetry_survives: bool = False,
        sentinel_rows: int = 0,
        sentinel_survives: bool = True,
        visibility_raises: bool = True,
        visibility_error: str = "-20012 visibility_change_not_supported",
        identical_updated_at: object = 1,
        updated_after: object = 2,
        control_updated_at: object = 3,
        final_updated_at: object = 4,
        fail_on: set[str] | None = None,
        failure_message: str = "scripted connector failure",
    ) -> None:
        run_id = upsert_roast_verify_live.TEST_RUN_ID
        self.database = database
        self.role = role
        self.listed_names = listed_names if listed_names is not None else {
            f"roast_artifacts/{run_id}/{path.name}"
            for path in upsert_roast_verify_live.FIXTURE_PATHS
        }
        self.preexisting_stage_names = (
            set() if preexisting_stage_names is None else preexisting_stage_names
        )
        self.remove_leaves_files = remove_leaves_files
        self.existing_run_count = existing_run_count
        self.roast_count = roast_count
        self.control_roast_count = control_roast_count
        self.final_roast_count = final_roast_count
        self.sentinel_owner_count = sentinel_owner_count
        self.sentinel_telemetry_count = sentinel_telemetry_count
        self.owned_roast_id = owned_roast_id
        self.owned_roast_id_count = owned_roast_id_count
        self.first_result = first_result
        self.replay_result = replay_result
        self.slug_result = slug_result
        self.control_result = control_result
        self.opt_out_result = opt_out_result
        self.ambiguous_roast_ids = ambiguous_roast_ids
        self.cleanup_roast_ids = cleanup_roast_ids
        self.cleanup_identity_query_fails = cleanup_identity_query_fails
        self.artifact_count = artifact_count
        self.final_artifact_count = final_artifact_count
        self.artifact_pairs = artifact_pairs if artifact_pairs is not None else {
            (kind, f"@app.roast_artifacts/{run_id}/{basename}")
            for kind, basename in upsert_roast_verify_live.ARTIFACT_BASENAMES.items()
        }
        self.before_pair = before_pair
        self.stored_pair = stored_pair
        self.identical_preserved_change = identical_preserved_change
        self.preserved_change = preserved_change
        self.control_preserved_change = control_preserved_change
        self.final_preserved_change = final_preserved_change
        self.mapping_rows = mapping_rows
        self.stored_visibility = stored_visibility
        self.stored_notes = stored_notes
        self.stored_updated_at = stored_updated_at
        self.telemetry_setup_count = telemetry_setup_count
        self.telemetry_control_count = telemetry_control_count
        self.telemetry_survives = telemetry_survives
        self.sentinel_rows = sentinel_rows
        self.sentinel_survives = sentinel_survives
        self.visibility_raises = visibility_raises
        self.visibility_error = visibility_error
        self.identical_updated_at = identical_updated_at
        self.updated_after = updated_after
        self.control_updated_at = control_updated_at
        self.final_updated_at = final_updated_at
        self.fail_on = set() if fail_on is None else fail_on
        self.failure_message = failure_message
        self.executed: list[tuple[str, tuple[object, ...] | None]] = []
        self.call_results: list[object] = []
        self.last_call_result: object = None
        self.roast_count_reads = 0
        self.artifact_count_reads = 0
        self.sentinel_count_reads = 0
        self.preserved_reads = 0
        self.telemetry_seeded = False
        self.control_replayed = False
        self.opted_out = False
        self.removed = False
        self.put_started = False

    def _row(self, labels: tuple[str, ...], values: tuple[object, ...]):
        return dict(zip(labels, values)) if self.mapping_rows else values

    def execute(self, command: str, params=None):
        normalized = tuple(params) if params is not None else None
        self.executed.append((command, normalized))
        if (
            self.cleanup_identity_query_fails
            and self.opted_out
            and command
            == "SELECT id FROM app.cloud_roasts WHERE idempotency_key = %s"
        ):
            raise RuntimeError(self.failure_message)
        if any(command.startswith(prefix) for prefix in self.fail_on):
            raise RuntimeError(self.failure_message)
        if command.startswith("PUT "):
            self.put_started = True
        elif command.startswith("CALL app.upsert_roast"):
            assert normalized is not None
            payload = json.loads(str(normalized[1]))
            if payload["operator_notes"] == upsert_roast_verify_live.ROLLBACK_NOTES:
                if self.visibility_raises:
                    raise RuntimeError(self.visibility_error)
                self.last_call_result = FIRST_RESULT
            elif payload["contributed_to_learning"] is False:
                self.opted_out = True
                self.last_call_result = self.opt_out_result
            elif not self.call_results:
                self.last_call_result = self.first_result
            elif len(self.call_results) == 1:
                self.last_call_result = self.replay_result
            elif len(self.call_results) == 2:
                self.last_call_result = self.slug_result
            else:
                if self.telemetry_seeded:
                    self.control_replayed = True
                self.last_call_result = self.control_result
            self.call_results.append(self.last_call_result)
        elif command.startswith("DELETE FROM app.roast_telemetry"):
            if normalized == (upsert_roast_verify_live.OTHER_ROAST_ID,):
                self.sentinel_rows = 0
        elif command.startswith("INSERT INTO app.roast_telemetry"):
            assert normalized == (
                ROAST_ID,
                ROAST_ID,
                upsert_roast_verify_live.OTHER_ROAST_ID,
            )
            self.telemetry_seeded = True
            self.sentinel_rows += 1
        elif command.startswith("REMOVE "):
            self.removed = True
        return self

    def fetchone(self):
        command, params = self.executed[-1]
        if command == "SELECT CURRENT_DATABASE()":
            return (self.database,)
        if command == "SELECT CURRENT_ROLE()":
            return (self.role,)
        if command.startswith("CALL app.upsert_roast"):
            return (self.last_call_result,)
        if command == "SELECT COUNT(*) FROM app.cloud_roasts WHERE id = %s":
            if params == (upsert_roast_verify_live.OTHER_ROAST_ID,):
                return (self.sentinel_owner_count,)
            return (self.owned_roast_id_count,)
        if command.startswith("SELECT COUNT(*) FROM app.cloud_roasts"):
            self.roast_count_reads += 1
            if self.roast_count_reads == 1:
                return (self.existing_run_count,)
            if self.roast_count_reads == 2:
                return (self.roast_count,)
            if self.roast_count_reads == 3:
                return (self.control_roast_count,)
            return (self.final_roast_count,)
        if command.startswith("SELECT COUNT(*) FROM app.roast_artifacts"):
            self.artifact_count_reads += 1
            if self.artifact_count_reads == 1:
                return (self.artifact_count,)
            return (self.final_artifact_count,)
        if command.startswith("SELECT id, idempotency_key"):
            self.preserved_reads += 1
            values = list(BEFORE)
            if self.preserved_reads == 1:
                values[0], values[3] = self.before_pair
            elif self.preserved_reads == 2:
                values[0], values[3] = self.before_pair
                values[6] = self.identical_updated_at
                if self.identical_preserved_change is not None:
                    values[self.identical_preserved_change[0]] = (
                        self.identical_preserved_change[1]
                    )
            elif self.preserved_reads == 3:
                values[0], values[3] = self.stored_pair
                values[6] = self.updated_after
                if self.preserved_change is not None:
                    values[self.preserved_change[0]] = self.preserved_change[1]
            elif not self.opted_out:
                values[0], values[3] = self.stored_pair
                values[6] = self.control_updated_at
                if self.control_preserved_change is not None:
                    values[self.control_preserved_change[0]] = (
                        self.control_preserved_change[1]
                    )
            else:
                values[0], values[3] = self.stored_pair
                values[6] = self.final_updated_at
                if self.final_preserved_change is not None:
                    values[self.final_preserved_change[0]] = (
                        self.final_preserved_change[1]
                    )
            return self._row(
                upsert_roast_verify_live.PRESERVED_COLUMNS,
                tuple(values),
            )
        if command == "SELECT id FROM app.cloud_roasts WHERE idempotency_key = %s":
            return self._row(("id",), (self.owned_roast_id,))
        if command.startswith("SELECT visibility, operator_notes"):
            return self._row(
                ("VISIBILITY", "OPERATOR_NOTES", "UPDATED_AT"),
                (self.stored_visibility, self.stored_notes, self.stored_updated_at),
            )
        if command.startswith("SELECT COUNT(*) FROM app.roast_telemetry"):
            assert params is not None
            if params[0] == upsert_roast_verify_live.OTHER_ROAST_ID:
                self.sentinel_count_reads += 1
                if self.sentinel_count_reads == 1:
                    return (self.sentinel_telemetry_count,)
                if self.opted_out and not self.sentinel_survives:
                    return (0,)
                return (self.sentinel_rows,)
            if self.opted_out:
                return (2 if self.telemetry_survives else 0,)
            if self.control_replayed:
                return (self.telemetry_control_count,)
            return (self.telemetry_setup_count if self.telemetry_seeded else 0,)
        raise AssertionError(f"unexpected fetchone after: {command}")

    def fetchall(self):
        command = self.executed[-1][0]
        if command.startswith("LIST "):
            if self.removed and not self.remove_leaves_files:
                names = set()
            elif not self.put_started:
                names = self.preexisting_stage_names
            else:
                names = self.listed_names
            return [(name,) for name in sorted(names)]
        if command.startswith("SELECT id FROM app.cloud_roasts"):
            roast_ids = self.cleanup_roast_ids
            if self.roast_count_reads == 2 and self.roast_count != 1:
                roast_ids = self.ambiguous_roast_ids
            if self.mapping_rows:
                return [{"id": roast_id} for roast_id in roast_ids]
            return [(roast_id,) for roast_id in roast_ids]
        if command.startswith("SELECT kind, stage_path"):
            rows = sorted(self.artifact_pairs)
            if self.mapping_rows:
                return [dict(zip(("KIND", "STAGE_PATH"), row)) for row in rows]
            return rows
        raise AssertionError(f"unexpected fetchall after: {command}")


class FakeConnection:
    def __init__(
        self,
        *,
        close_error: BaseException | None = None,
        **cursor_options: object,
    ) -> None:
        self.fake_cursor = FakeCursor(**cursor_options)
        self.closed = False
        self.close_error = close_error

    def cursor(self):
        return self.fake_cursor

    def close(self) -> None:
        self.closed = True
        if self.close_error is not None:
            raise self.close_error


def _commands(connection: FakeConnection) -> list[str]:
    return [command for command, _ in connection.fake_cursor.executed]


def _verify(connection: FakeConnection) -> str:
    return upsert_roast_verify_live.verify_live_upsert(connection, "ROASTPILOT_DEV")


def test_test_run_id_is_a_lowercase_uuid() -> None:
    assert re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        upsert_roast_verify_live.TEST_RUN_ID,
    )


def test_invalid_test_run_id_rejects_before_any_statement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(upsert_roast_verify_live, "TEST_RUN_ID", "c3_s2_live_verify")
    connection = FakeConnection()
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="not a lowercase UUID",
    ):
        _verify(connection)
    assert connection.fake_cursor.executed == []


def test_cursor_setup_error_is_sanitized() -> None:
    class BrokenConnection:
        def cursor(self):
            raise RuntimeError(RAW_PRIVATE_PATH)

    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="^Snowflake cursor setup failed$",
    ) as caught:
        upsert_roast_verify_live.verify_live_upsert(
            BrokenConnection(),  # type: ignore[arg-type]
            "ROASTPILOT_DEV",
        )
    assert RAW_PRIVATE_PATH not in str(caught.value)


def test_payload_pins_closed_keys_private_visibility_and_null_groups() -> None:
    payload = upsert_roast_verify_live._payload()
    expected_keys = {
        "public_slug",
        "visibility",
        "bean_origin",
        "bean_varietal",
        "bean_weight_g",
        "profile_name",
        "roast_level",
        "operator_rating",
        "operator_notes",
        "contributed_to_learning",
        "roasted_at_utc",
        "summary",
        "artifact_kinds",
    }
    assert set(payload) == expected_keys
    assert payload["visibility"] == "private"
    assert payload["bean_origin"] is None
    assert payload["roast_level"] is None
    opt_out = dict(payload)
    opt_out["contributed_to_learning"] = False
    opt_out["artifact_kinds"] = []
    assert set(opt_out) == expected_keys


def test_first_value_and_row_values_accept_mappings() -> None:
    row = {"current_database()": "ROASTPILOT_DEV", "owner_id": None}
    assert upsert_roast_verify_live._first_value(row, "CURRENT_DATABASE()") == (
        "ROASTPILOT_DEV"
    )
    assert upsert_roast_verify_live._row_values(row, ("CURRENT_DATABASE()",)) == (
        "ROASTPILOT_DEV",
    )
    assert upsert_roast_verify_live._row_values(row, ("OWNER_ID",)) == (None,)


def test_row_values_rejects_incomplete_mapping() -> None:
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="incomplete row",
    ):
        upsert_roast_verify_live._row_values({"ID": ROAST_ID}, ("ID", "OWNER_ID"))


@pytest.mark.parametrize(
    "fixture_path",
    [Path("/tmp/outside.jsonl"), upsert_roast_verify_live.FIXTURES_DIR / "bad'name"],
)
def test_fixture_uri_rejects_outside_or_quote_bearing_path(fixture_path: Path) -> None:
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="rejected upsert fixture path",
    ) as caught:
        upsert_roast_verify_live._validated_fixture_uri(fixture_path)
    assert str(fixture_path) not in str(caught.value)


def test_fixture_basename_guard_rejects_disallowed_name(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        upsert_roast_verify_live,
        "FIXTURE_PATHS",
        (upsert_roast_verify_live.FIXTURES_DIR / "unexpected.txt",),
    )
    connection = FakeConnection()
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="outside artifact grammar",
    ):
        _verify(connection)
    assert not any(command.startswith("PUT ") for command in _commands(connection))


@pytest.mark.parametrize(
    ("value", "message"),
    [
        ("{", "returned invalid JSON"),
        ([], "did not return an object"),
        ({"cloud_roast_id": ROAST_ID}, "returned an unexpected object"),
    ],
)
def test_variant_object_rejects_malformed_results(value: object, message: str) -> None:
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError, match=message):
        upsert_roast_verify_live._variant_object(value)


def test_variant_object_decodes_json_string() -> None:
    assert upsert_roast_verify_live._variant_object(json.dumps(FIRST_RESULT)) == (
        FIRST_RESULT
    )


def test_count_accepts_int_and_decimal() -> None:
    assert upsert_roast_verify_live._count((1,), "COUNT(*)") == 1
    assert upsert_roast_verify_live._count((Decimal("2"),), "COUNT(*)") == 2


@pytest.mark.parametrize("value", [True, "1", 1.0, None])
def test_count_rejects_bool_and_non_numeric_values(value: object) -> None:
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="did not return a numeric count",
    ):
        upsert_roast_verify_live._count((value,), "COUNT(*)")


def test_stored_pair_mapping_and_unexpected_row() -> None:
    assert upsert_roast_verify_live._stored_pair(
        {"ID": ROAST_ID, "PUBLIC_SLUG": upsert_roast_verify_live.PUBLIC_SLUG}
    ) == (ROAST_ID, upsert_roast_verify_live.PUBLIC_SLUG)
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="unexpected row shape",
    ):
        upsert_roast_verify_live._stored_pair((ROAST_ID,))


def test_happy_path_pins_put_calls_control_and_verified_cleanup() -> None:
    connection = FakeConnection()
    assert _verify(connection) == ROAST_ID
    commands = _commands(connection)
    assert commands[:3] == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_DATABASE()",
        "SELECT CURRENT_ROLE()",
    ]
    assert commands[3:6] == [
        "SELECT COUNT(*) FROM app.cloud_roasts WHERE idempotency_key = %s",
        "SELECT COUNT(*) FROM app.cloud_roasts WHERE id = %s",
        "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
    ]
    assert commands[6] == (
        f"LIST @app.roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/"
    )
    expected_puts = [
        f"PUT '{path.resolve().as_uri()}' "
        f"@app.roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/ "
        "AUTO_COMPRESS=FALSE OVERWRITE=TRUE"
        for path in upsert_roast_verify_live.FIXTURE_PATHS
    ]
    assert commands[7:9] == expected_puts
    calls = [
        entry
        for entry in connection.fake_cursor.executed
        if entry[0].startswith("CALL")
    ]
    assert len(calls) == 6
    assert calls[0][1] == calls[1][1] == calls[4][1]
    visibility_payload = json.loads(str(calls[3][1][1]))
    assert (
        visibility_payload["operator_notes"]
        == upsert_roast_verify_live.ROLLBACK_NOTES
    )
    assert commands[-2:] == [
        f"REMOVE @app.roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/",
        f"LIST @app.roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/",
    ]


@pytest.mark.parametrize(
    "listed_names",
    [
        {
            f"roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/roast.jsonl"
        },
        {
            f"roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/roast.jsonl",
            f"roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/summary.json",
            f"roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/stale.csv",
        },
    ],
)
def test_initial_list_requires_exact_uncompressed_fixture_set(
    listed_names: set[str],
) -> None:
    connection = FakeConnection(listed_names=listed_names)
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="LIST is not exact",
    ):
        _verify(connection)


def test_initial_list_reports_compression_before_set_mismatch() -> None:
    run_id = upsert_roast_verify_live.TEST_RUN_ID
    connection = FakeConnection(
        listed_names={
            f"roast_artifacts/{run_id}/roast.jsonl.gz",
            f"roast_artifacts/{run_id}/summary.json",
        }
    )
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="LIST contains a compressed file",
    ):
        _verify(connection)


def test_initial_list_accepts_unknown_case_insensitive_stage_prefix() -> None:
    run_id = upsert_roast_verify_live.TEST_RUN_ID.upper()
    connection = FakeConnection(
        listed_names={
            f"DATABASE.SCHEMA.ROAST_ARTIFACTS/{run_id}/roast.jsonl",
            f"DATABASE.SCHEMA.ROAST_ARTIFACTS/{run_id}/summary.json",
        }
    )
    assert _verify(connection) == ROAST_ID


def test_initial_list_rejects_nested_fixture_name() -> None:
    run_id = upsert_roast_verify_live.TEST_RUN_ID
    connection = FakeConnection(
        listed_names={
            f"roast_artifacts/{run_id}/nested/roast.jsonl",
            f"roast_artifacts/{run_id}/summary.json",
        }
    )
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="contains a nested path",
    ):
        _verify(connection)


def test_initial_list_rejects_name_without_run_segment() -> None:
    connection = FakeConnection(
        listed_names={"unknown-prefix/roast.jsonl", "unknown-prefix/summary.json"}
    )
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="LIST has an invalid prefix",
    ):
        _verify(connection)


def test_post_remove_list_must_be_empty() -> None:
    connection = FakeConnection(remove_leaves_files=True)
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="live verification cleanup failed",
    ) as caught:
        _verify(connection)
    assert caught.value.cleanup_failures == [
        "cleanup failed for run id "
        f"{upsert_roast_verify_live.TEST_RUN_ID}: stage REMOVE verification "
        "failed [stage_prefix="
        f"@app.roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/]; "
        f"diagnostic cloud_roast_id={ROAST_ID}"
    ]
    assert _commands(connection)[-2:] == [
        f"REMOVE @app.roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/",
        f"LIST @app.roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/",
    ]


def test_main_prints_narrow_evidence_and_closes(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    connection = FakeConnection()
    monkeypatch.setattr(
        upsert_roast_verify_live,
        "_connect",
        lambda _target: connection,
    )
    assert upsert_roast_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 0
    assert connection.closed is True
    output = capsys.readouterr().out
    assert "staged artifact PUT/REMOVE paths" in output
    assert "conditional and scoped opt-out telemetry purge" in output
    assert "visibility change rejection with no net change" in output
    assert ROAST_ID in output


@pytest.mark.parametrize(
    ("fail_on", "static_message"),
    [
        ({"PUT "}, "staging fixture PUT failed"),
        (
            {"DELETE FROM app.cloud_roasts"},
            "parent cleanup [idempotency_key="
            f"{upsert_roast_verify_live.TEST_RUN_ID}] failed",
        ),
    ],
)
def test_main_sanitizes_body_and_cleanup_connector_paths(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    fail_on: set[str],
    static_message: str,
) -> None:
    connection = FakeConnection(fail_on=fail_on, failure_message=RAW_PRIVATE_PATH)
    monkeypatch.setattr(
        upsert_roast_verify_live,
        "_connect",
        lambda _target: connection,
    )
    assert upsert_roast_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    output = capsys.readouterr().err
    assert RAW_PRIVATE_PATH not in output
    assert static_message in output


@pytest.mark.parametrize("body_fails", [False, True])
def test_main_reports_sanitized_connection_close_failure(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    body_fails: bool,
) -> None:
    options = {"roast_count": 2} if body_fails else {}
    connection = FakeConnection(
        close_error=RuntimeError(RAW_PRIVATE_PATH),
        **options,
    )
    monkeypatch.setattr(
        upsert_roast_verify_live,
        "_connect",
        lambda _target: connection,
    )
    assert upsert_roast_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    output = capsys.readouterr().err
    assert RAW_PRIVATE_PATH not in output
    assert "Snowflake connection close failed" in output
    assert upsert_roast_verify_live.TEST_RUN_ID in output
    assert ROAST_ID in output
    assert output.count(f"diagnostic cloud_roast_id={ROAST_ID}") == 1
    if body_fails:
        assert "replay did not leave exactly one roast" in output
    else:
        assert "live verification cleanup failed" in output


def test_main_sanitizes_generic_base_exception_fallback(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    connection = FakeConnection()
    monkeypatch.setattr(
        upsert_roast_verify_live,
        "_connect",
        lambda _target: connection,
    )

    def fail_verify(_connection: object, _target: str) -> str:
        raise KeyboardInterrupt(RAW_PRIVATE_PATH)

    monkeypatch.setattr(upsert_roast_verify_live, "verify_live_upsert", fail_verify)
    assert upsert_roast_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    output = capsys.readouterr().err
    assert output == "upsert verification failed: live verification failed\n"
    assert connection.closed is True


def test_connect_path_error_is_sanitized_before_main_prints(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setenv("SNOWFLAKE_PRIVATE_KEY_FILE", RAW_PRIVATE_PATH)

    def fail_read(_path: Path, **_kwargs: object) -> str:
        raise FileNotFoundError(RAW_PRIVATE_PATH)

    monkeypatch.setattr(Path, "read_text", fail_read)
    assert upsert_roast_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    output = capsys.readouterr().err
    assert RAW_PRIVATE_PATH not in output
    assert "SNOWFLAKE_PRIVATE_KEY_FILE configuration failed" in output


def test_connect_pins_autocommit_true(monkeypatch: pytest.MonkeyPatch) -> None:
    connect_calls: list[dict[str, object]] = []
    expected_connection = object()

    connector_module = ModuleType("snowflake.connector")

    def connect(**kwargs: object) -> object:
        connect_calls.append(kwargs)
        return expected_connection

    connector_module.connect = connect  # type: ignore[attr-defined]
    snowflake_module = ModuleType("snowflake")
    snowflake_module.connector = connector_module  # type: ignore[attr-defined]

    key_loader_module = ModuleType("assert_dev_ci_grants")
    key_loader_module.load_private_key_der = (  # type: ignore[attr-defined]
        lambda _pem, _passphrase: b"private-key-der"
    )

    monkeypatch.setitem(sys.modules, "snowflake", snowflake_module)
    monkeypatch.setitem(sys.modules, "snowflake.connector", connector_module)
    monkeypatch.setitem(sys.modules, "assert_dev_ci_grants", key_loader_module)
    monkeypatch.setattr(Path, "read_text", lambda _path, **_kwargs: "private key")
    environment = {
        "SNOWFLAKE_PRIVATE_KEY_FILE": "/private/key.p8",
        "SNOWFLAKE_ACCOUNT": "test-account",
        "SNOWFLAKE_USER": "test-user",
        "SNOWFLAKE_ROLE": "ROASTPILOT_AGENT",
        "SNOWFLAKE_WAREHOUSE": "TEST_WAREHOUSE",
    }
    for name, value in environment.items():
        monkeypatch.setenv(name, value)

    assert (
        upsert_roast_verify_live._connect("ROASTPILOT_DEV")
        is expected_connection
    )
    assert connect_calls == [
        {
            "account": "test-account",
            "user": "test-user",
            "role": "ROASTPILOT_AGENT",
            "warehouse": "TEST_WAREHOUSE",
            "database": "ROASTPILOT_DEV",
            "private_key": b"private-key-der",
            "autocommit": True,
        }
    ]


def test_allowed_targets_are_dev_only_and_preview_is_rejected() -> None:
    connection = FakeConnection()
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="rejected upsert target",
    ):
        upsert_roast_verify_live.verify_live_upsert(connection, "ROASTPILOT_PREVIEW")
    assert connection.fake_cursor.executed == []


@pytest.mark.parametrize(
    ("options", "message", "statement_count"),
    [
        ({"database": "ROASTPILOT_PROD"}, "database does not match", 2),
        ({"role": "ACCOUNTADMIN"}, "role is not ROASTPILOT_AGENT", 3),
    ],
)
def test_database_and_role_reject_before_write(
    options: dict[str, object],
    message: str,
    statement_count: int,
) -> None:
    connection = FakeConnection(**options)
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError, match=message):
        _verify(connection)
    assert _commands(connection) == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_DATABASE()",
        "SELECT CURRENT_ROLE()",
    ][:statement_count]


@pytest.mark.parametrize(
    ("option", "message"),
    [
        ({"roast_count": 2}, "exactly one roast"),
        ({"control_roast_count": 2}, "contributing replay changed the roast count"),
        (
            {
                "control_result": {
                    "cloud_roast_id": "different-roast",
                    "public_slug": upsert_roast_verify_live.PUBLIC_SLUG,
                }
            },
            "contributing replay returned a different object",
        ),
        ({"artifact_count": 2}, "artifact count does not match"),
        ({"stored_visibility": "unlisted"}, "changed stored value"),
        ({"telemetry_setup_count": 1}, "did not insert two roast rows"),
        ({"telemetry_control_count": 0}, "contributing replay unexpectedly purged"),
    ],
)
def test_injectable_live_guards_reject_independently(
    option: dict[str, object],
    message: str,
) -> None:
    connection = FakeConnection(**option)
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError, match=message):
        _verify(connection)


def test_replay_count_mismatch_reports_every_id_and_skips_cleanup(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    matching_ids = (ROAST_ID, "d4d4d4d4-4170-4170-4170-d4d4d4d4d4d4")
    connection = FakeConnection(
        roast_count=2,
        ambiguous_roast_ids=matching_ids,
        mapping_rows=True,
    )
    monkeypatch.setattr(
        upsert_roast_verify_live,
        "_connect",
        lambda _target: connection,
    )
    assert upsert_roast_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    output = capsys.readouterr().err
    assert "replay did not leave exactly one roast" in output
    for roast_id in matching_ids:
        assert roast_id in output
    commands = _commands(connection)
    assert not any(
        command.startswith("DELETE FROM app.roast_artifacts")
        or command.startswith("DELETE FROM app.roast_telemetry")
        for command in commands
    )
    assert not any(
        command.startswith("DELETE FROM app.cloud_roasts") for command in commands
    )
    assert not any(command.startswith("REMOVE ") for command in commands)


def test_replay_count_diagnostic_failure_still_skips_cleanup() -> None:
    connection = FakeConnection(
        roast_count=2,
        fail_on={"SELECT id FROM app.cloud_roasts"},
    )
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="ambiguous replay id query failed",
    ):
        _verify(connection)
    commands = _commands(connection)
    assert not any(
        command.startswith("DELETE FROM app.roast_artifacts")
        or command.startswith("DELETE FROM app.roast_telemetry")
        for command in commands
    )
    assert not any(
        command.startswith("DELETE FROM app.cloud_roasts") for command in commands
    )
    assert not any(command.startswith("REMOVE ") for command in commands)


def test_control_replay_count_mismatch_skips_cleanup() -> None:
    connection = FakeConnection(control_roast_count=2)
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="contributing replay changed the roast count",
    ):
        _verify(connection)
    commands = _commands(connection)
    assert not any(
        command.startswith("DELETE FROM app.roast_artifacts")
        or command.startswith("DELETE FROM app.roast_telemetry")
        for command in commands
    )
    assert not any(
        command.startswith("DELETE FROM app.cloud_roasts") for command in commands
    )
    assert not any(command.startswith("REMOVE ") for command in commands)


def test_final_opt_out_count_mismatch_skips_cleanup() -> None:
    connection = FakeConnection(final_roast_count=2)
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="opt-out replay changed the roast count",
    ):
        _verify(connection)
    commands = _commands(connection)
    assert not any(
        command.startswith("DELETE FROM app.roast_artifacts")
        or command.startswith("DELETE FROM app.roast_telemetry")
        for command in commands
    )
    assert not any(
        command.startswith("DELETE FROM app.cloud_roasts") for command in commands
    )
    assert not any(command.startswith("REMOVE ") for command in commands)


def test_existing_test_run_guard_fails_before_any_write() -> None:
    connection = FakeConnection(existing_run_count=1)
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="test run id is already owned",
    ):
        _verify(connection)
    assert _commands(connection) == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_DATABASE()",
        "SELECT CURRENT_ROLE()",
        "SELECT COUNT(*) FROM app.cloud_roasts WHERE idempotency_key = %s",
    ]
    assert all(
        command == "USE SECONDARY ROLES NONE" or command.startswith("SELECT ")
        for command in _commands(connection)
    )


def test_sentinel_owner_guard_fails_before_any_write() -> None:
    connection = FakeConnection(sentinel_owner_count=1)
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="sentinel roast id is already owned",
    ):
        _verify(connection)
    assert _commands(connection) == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_DATABASE()",
        "SELECT CURRENT_ROLE()",
        "SELECT COUNT(*) FROM app.cloud_roasts WHERE idempotency_key = %s",
        "SELECT COUNT(*) FROM app.cloud_roasts WHERE id = %s",
    ]


def test_sentinel_telemetry_guard_prints_id_before_any_write(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    connection = FakeConnection(sentinel_telemetry_count=1)
    monkeypatch.setattr(
        upsert_roast_verify_live,
        "_connect",
        lambda _target: connection,
    )
    assert upsert_roast_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    output = capsys.readouterr().err
    assert "sentinel telemetry id is already owned" in output
    assert upsert_roast_verify_live.OTHER_ROAST_ID in output
    assert _commands(connection) == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_DATABASE()",
        "SELECT CURRENT_ROLE()",
        "SELECT COUNT(*) FROM app.cloud_roasts WHERE idempotency_key = %s",
        "SELECT COUNT(*) FROM app.cloud_roasts WHERE id = %s",
        "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
    ]
    assert all(
        command == "USE SECONDARY ROLES NONE" or command.startswith("SELECT ")
        for command in _commands(connection)
    )


def test_preexisting_stage_prefix_guard_fails_before_any_write() -> None:
    run_id = upsert_roast_verify_live.TEST_RUN_ID
    stage_prefix = f"@app.roast_artifacts/{run_id}/"
    connection = FakeConnection(
        preexisting_stage_names={f"roast_artifacts/{run_id}/operator-file.json"}
    )
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match=re.escape(stage_prefix),
    ) as caught:
        _verify(connection)
    assert "contains 1 existing file(s)" in str(caught.value)
    assert _commands(connection)[-1] == f"LIST {stage_prefix}"
    assert all(
        command == "USE SECONDARY ROLES NONE"
        or command.startswith("SELECT ")
        or command.startswith("LIST ")
        for command in _commands(connection)
    )


def test_first_stored_pair_must_match_return() -> None:
    connection = FakeConnection(
        before_pair=("different", upsert_roast_verify_live.PUBLIC_SLUG)
    )
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="stored id and slug do not match first return",
    ):
        _verify(connection)


def test_first_call_rejects_returned_and_stored_slug_substitution() -> None:
    substituted_slug = "ABCDEFGH123456789"
    substituted_result = {
        "cloud_roast_id": ROAST_ID,
        "public_slug": substituted_slug,
    }
    connection = FakeConnection(
        first_result=substituted_result,
        replay_result=substituted_result,
        before_pair=(ROAST_ID, substituted_slug),
    )
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="first call substituted the requested slug",
    ):
        _verify(connection)


@pytest.mark.parametrize(
    "option",
    [
        {"stored_pair": ("changed", upsert_roast_verify_live.PUBLIC_SLUG)},
        {"stored_pair": (ROAST_ID, upsert_roast_verify_live.REPLAY_SLUG)},
        {"preserved_change": (1, "changed-run-id")},
        {"preserved_change": (2, "changed-owner")},
        {"preserved_change": (4, "public")},
        {"preserved_change": (5, "changed-created-at")},
    ],
)
def test_each_preserved_column_is_checked(option: dict[str, object]) -> None:
    connection = FakeConnection(**option)
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="slug replay changed a preserved column",
    ):
        _verify(connection)


def test_mapping_rows_do_not_bypass_preserved_guard() -> None:
    connection = FakeConnection(
        mapping_rows=True,
        stored_pair=(ROAST_ID, upsert_roast_verify_live.REPLAY_SLUG),
    )
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="slug replay changed a preserved column",
    ):
        _verify(connection)


def test_slug_replay_must_return_original_public_slug() -> None:
    connection = FakeConnection(
        slug_result={
            "cloud_roast_id": ROAST_ID,
            "public_slug": upsert_roast_verify_live.REPLAY_SLUG,
        }
    )
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="divergent-slug replay returned a different object",
    ):
        _verify(connection)


@pytest.mark.parametrize(
    ("option", "message"),
    [
        (
            {
                "slug_result": {
                    "cloud_roast_id": "wrong-slug-replay-id",
                    "public_slug": upsert_roast_verify_live.PUBLIC_SLUG,
                }
            },
            "divergent-slug replay returned a different object",
        ),
        (
            {
                "control_result": {
                    "cloud_roast_id": ROAST_ID,
                    "public_slug": upsert_roast_verify_live.REPLAY_SLUG,
                }
            },
            "contributing replay returned a different object",
        ),
        (
            {
                "opt_out_result": {
                    "cloud_roast_id": "wrong-opt-out-replay-id",
                    "public_slug": upsert_roast_verify_live.PUBLIC_SLUG,
                }
            },
            "opt-out replay returned a different object",
        ),
    ],
)
def test_every_successful_replay_must_return_the_complete_first_result(
    option: dict[str, object],
    message: str,
) -> None:
    connection = FakeConnection(**option)
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError, match=message):
        _verify(connection)


def test_owned_id_collision_reports_ids_and_skips_child_cleanup(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    colliding_roast_id = "aaaaaaaa-4170-4170-4170-aaaaaaaaaaaa"
    connection = FakeConnection(
        owned_roast_id=colliding_roast_id,
        owned_roast_id_count=2,
    )
    monkeypatch.setattr(
        upsert_roast_verify_live,
        "_connect",
        lambda _target: connection,
    )
    assert upsert_roast_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    output = capsys.readouterr().err
    assert "is not unique" in output
    assert colliding_roast_id in output
    assert upsert_roast_verify_live.TEST_RUN_ID in output
    commands = _commands(connection)
    assert (
        "SELECT COUNT(*) FROM app.cloud_roasts WHERE id = %s",
        (colliding_roast_id,),
    ) in connection.fake_cursor.executed
    assert not any(
        command.startswith("DELETE FROM app.roast_artifacts")
        or command.startswith("DELETE FROM app.roast_telemetry")
        for command in commands
    )
    assert not any(
        command.startswith("DELETE FROM app.cloud_roasts") for command in commands
    )
    assert not any(command.startswith("REMOVE ") for command in commands)


def test_replay_equality_and_artifact_pair_mismatches_are_detected() -> None:
    connection = FakeConnection(replay_result={
        "cloud_roast_id": ROAST_ID,
        "public_slug": upsert_roast_verify_live.REPLAY_SLUG,
    })
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="identical replay returned a different object",
    ):
        _verify(connection)

    path = f"@app.roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/roast.jsonl"
    connection = FakeConnection(artifact_pairs={("summary", path)})
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="kind and stage_path pairs",
    ):
        _verify(connection)


def test_different_identical_result_carries_verified_id_to_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = FakeConnection(replay_result={
        "cloud_roast_id": ROAST_ID,
        "public_slug": upsert_roast_verify_live.REPLAY_SLUG,
    })
    cleanup_ids: list[object | None] = []
    cleanup_all = upsert_roast_verify_live._cleanup_all

    def recording_cleanup(cursor, resolved_roast_id):
        cleanup_ids.append(resolved_roast_id)
        return cleanup_all(cursor, resolved_roast_id)

    monkeypatch.setattr(upsert_roast_verify_live, "_cleanup_all", recording_cleanup)
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="identical replay returned a different object",
    ):
        _verify(connection)

    assert cleanup_ids == [ROAST_ID]
    commands = _commands(connection)
    assert any(command.startswith("DELETE FROM app.roast_artifacts") for command in commands)
    assert any(
        command.startswith("DELETE FROM app.roast_telemetry WHERE (")
        for command in commands
    )
    assert any(command.startswith("DELETE FROM app.cloud_roasts") for command in commands)
    assert any(command.startswith("REMOVE ") for command in commands)


def test_identical_replay_rejects_preserved_column_mutation() -> None:
    cursor = FakeCursor(
        existing_run_count=1,
        identical_preserved_change=(2, "changed-owner"),
    )
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="identical replay changed a preserved column",
    ):
        upsert_roast_verify_live._verify_replay_idempotency(cursor)


def test_identical_replay_failure_carries_verified_id_to_cleanup(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    connection = FakeConnection(
        identical_preserved_change=(2, "changed-owner"),
    )
    cleanup_ids: list[object | None] = []
    cleanup_all = upsert_roast_verify_live._cleanup_all

    def recording_cleanup(cursor, resolved_roast_id):
        cleanup_ids.append(resolved_roast_id)
        return cleanup_all(cursor, resolved_roast_id)

    monkeypatch.setattr(upsert_roast_verify_live, "_cleanup_all", recording_cleanup)
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="identical replay changed a preserved column",
    ):
        _verify(connection)

    assert cleanup_ids == [ROAST_ID]
    commands = _commands(connection)
    assert any(command.startswith("DELETE FROM app.roast_artifacts") for command in commands)
    assert any(
        command.startswith("DELETE FROM app.roast_telemetry WHERE (")
        for command in commands
    )
    assert any(command.startswith("DELETE FROM app.cloud_roasts") for command in commands)
    assert any(command.startswith("REMOVE ") for command in commands)


def test_identical_replay_preserves_first_call_baseline() -> None:
    cursor = FakeCursor(existing_run_count=1)

    payload, first, owned_roast_id, baseline, previous_updated_at = (
        upsert_roast_verify_live._verify_replay_idempotency(cursor)
    )

    assert payload == upsert_roast_verify_live._payload()
    assert first == FIRST_RESULT
    assert owned_roast_id == ROAST_ID
    assert baseline == BEFORE
    assert previous_updated_at == 1


def test_wrong_returned_id_never_reaches_destructive_cleanup_predicates() -> None:
    wrong_returned_id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    wrong_result = {
        "cloud_roast_id": wrong_returned_id,
        "public_slug": upsert_roast_verify_live.PUBLIC_SLUG,
    }
    connection = FakeConnection(
        first_result=wrong_result,
        replay_result=wrong_result,
    )
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="stored id and slug do not match first return",
    ) as caught:
        _verify(connection)
    assert caught.value.resolved_roast_id == wrong_returned_id
    child_deletes = [
        entry
        for entry in connection.fake_cursor.executed
        if entry[0].startswith("DELETE FROM app.roast_artifacts")
        or entry[0].startswith("DELETE FROM app.roast_telemetry WHERE (")
    ]
    assert [params for _command, params in child_deletes] == [
        (ROAST_ID, upsert_roast_verify_live.TEST_RUN_ID),
        (ROAST_ID, upsert_roast_verify_live.TEST_RUN_ID),
    ]
    assert all(
        wrong_returned_id not in params
        for _command, params in child_deletes
        if params is not None
    )


def test_raw_replay_exception_preserves_returned_id_for_diagnostics() -> None:
    class NoneAmbiguousRowsCursor(FakeCursor):
        def fetchall(self):
            command = self.executed[-1][0]
            if command.startswith("SELECT id FROM app.cloud_roasts"):
                return None
            return super().fetchall()

    connection = FakeConnection(roast_count=2)
    connection.fake_cursor = NoneAmbiguousRowsCursor(roast_count=2)
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="live verification body failed",
    ) as caught:
        _verify(connection)
    assert caught.value.resolved_roast_id == ROAST_ID


@pytest.mark.parametrize("updated_after", [2, object()])
def test_divergent_replay_updated_at_uses_immediate_predecessor(
    updated_after: object,
) -> None:
    connection = FakeConnection(
        identical_updated_at=3,
        updated_after=updated_after,
    )
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="slug replay did not preserve non-decreasing updated_at",
    ):
        _verify(connection)


def test_monotonic_replay_updated_at_sequence_passes() -> None:
    connection = FakeConnection(
        identical_updated_at=2,
        updated_after=3,
        stored_updated_at=3,
        control_updated_at=4,
        final_updated_at=5,
    )
    assert _verify(connection) == ROAST_ID


def test_final_replay_must_advance_beyond_first_call() -> None:
    connection = FakeConnection(
        identical_updated_at=1,
        updated_after=1,
        stored_updated_at=1,
        control_updated_at=1,
        final_updated_at=1,
    )
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="final replay did not advance updated_at beyond the first call",
    ):
        _verify(connection)


@pytest.mark.parametrize(
    ("option", "message"),
    [
        ({"visibility_raises": False}, "visibility replay unexpectedly succeeded"),
        ({"visibility_error": "-20009 invalid payload"}, "unexpected error"),
        (
            {"stored_notes": upsert_roast_verify_live.ROLLBACK_NOTES},
            "changed operator_notes",
        ),
        ({"stored_updated_at": 3}, "changed updated_at"),
    ],
)
def test_visibility_replay_requires_expected_error_and_no_net_change(
    option: dict[str, object],
    message: str,
) -> None:
    connection = FakeConnection(**option)
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError, match=message):
        _verify(connection)


@pytest.mark.parametrize(
    "message",
    ["-20012", "visibility_change_not_supported"],
)
def test_visibility_error_accepts_each_contract_marker(message: str) -> None:
    assert upsert_roast_verify_live._is_visibility_error(RuntimeError(message))


@pytest.mark.parametrize(
    ("option", "message"),
    [
        ({"telemetry_survives": True}, "did not purge telemetry"),
        (
            {"sentinel_survives": False},
            "did not preserve one unrelated telemetry row",
        ),
    ],
)
def test_opt_out_purge_is_complete_and_scoped(
    option: dict[str, object],
    message: str,
) -> None:
    connection = FakeConnection(**option)
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError, match=message):
        _verify(connection)


def test_control_replay_preservation_is_checked_before_opt_out_restore() -> None:
    connection = FakeConnection(
        control_preserved_change=(2, "changed-owner"),
    )
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="contributing replay changed a preserved column",
    ):
        _verify(connection)
    assert connection.fake_cursor.opted_out is False


def test_final_opt_out_replay_must_leave_exactly_one_roast() -> None:
    connection = FakeConnection(final_roast_count=2)
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="opt-out replay changed the roast count",
    ):
        _verify(connection)
    assert connection.fake_cursor.preserved_reads == 4
    assert connection.fake_cursor.artifact_count_reads == 1


def test_final_opt_out_replay_must_preserve_columns() -> None:
    connection = FakeConnection(final_preserved_change=(2, "changed-owner"))
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="opt-out replay changed a preserved column",
    ):
        _verify(connection)


@pytest.mark.parametrize("final_updated_at", [2, object()])
def test_final_opt_out_replay_requires_non_decreasing_comparable_updated_at(
    final_updated_at: object,
) -> None:
    connection = FakeConnection(final_updated_at=final_updated_at)
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="opt-out replay did not preserve non-decreasing updated_at",
    ):
        _verify(connection)


def test_final_opt_out_replay_must_clear_artifact_manifest() -> None:
    connection = FakeConnection(final_artifact_count=1)
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="opt-out replay did not clear the artifact manifest",
    ):
        _verify(connection)


def test_sentinel_result_asserts_one_absolute_row() -> None:
    connection = FakeConnection()
    assert _verify(connection) == ROAST_ID
    sentinel_reads = [
        entry
        for entry in connection.fake_cursor.executed
        if entry
        == (
            "SELECT COUNT(*) FROM app.roast_telemetry WHERE roast_id = %s",
            (upsert_roast_verify_live.OTHER_ROAST_ID,),
        )
    ]
    assert len(sentinel_reads) == 2
    assert not any(
        "sentinel baseline" in command for command in _commands(connection)
    )


def test_early_abort_without_verified_id_skips_cleanup() -> None:
    connection = FakeConnection(listed_names=set(), cleanup_roast_ids=())
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="LIST is not exact",
    ) as raised:
        _verify(connection)
    assert raised.value.cleanup_failures
    commands = _commands(connection)
    assert not any(
        command.startswith("DELETE FROM app.roast_artifacts")
        or command.startswith("DELETE FROM app.roast_telemetry")
        or command.startswith("DELETE FROM app.cloud_roasts")
        or command.startswith("REMOVE ")
        for command in commands
    )


def test_malformed_first_return_without_verified_id_skips_cleanup() -> None:
    connection = FakeConnection(first_result="{")
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="returned invalid JSON",
    ) as raised:
        _verify(connection)
    assert raised.value.cleanup_failures
    commands = _commands(connection)
    assert not any(
        command.startswith("DELETE FROM app.roast_artifacts")
        or command.startswith("DELETE FROM app.roast_telemetry")
        or command.startswith("DELETE FROM app.cloud_roasts")
        or command.startswith("REMOVE ")
        for command in commands
    )


def test_cleanup_identity_ambiguity_skips_every_destructive_statement() -> None:
    other_id = "dddddddd-4170-4170-4170-dddddddddddd"
    connection = FakeConnection(cleanup_roast_ids=(ROAST_ID, other_id))
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="live verification cleanup failed",
    ) as raised:
        _verify(connection)
    cleanup_report = "\n".join(raised.value.cleanup_failures)
    assert upsert_roast_verify_live.TEST_RUN_ID in cleanup_report
    assert ROAST_ID in cleanup_report
    assert other_id in cleanup_report
    commands = _commands(connection)
    assert not any(
        command.startswith("DELETE FROM app.roast_artifacts")
        or command.startswith("DELETE FROM app.roast_telemetry")
        or command.startswith("DELETE FROM app.cloud_roasts")
        or command.startswith("REMOVE ")
        for command in commands
    )


def test_cleanup_identity_query_failure_skips_every_destructive_statement() -> None:
    connection = FakeConnection(cleanup_identity_query_fails=True)
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="live verification cleanup failed",
    ) as raised:
        _verify(connection)
    cleanup_report = "\n".join(raised.value.cleanup_failures)
    assert "cleanup identity revalidation failed" in cleanup_report
    assert upsert_roast_verify_live.TEST_RUN_ID in cleanup_report
    commands = _commands(connection)
    assert not any(
        command.startswith("DELETE FROM app.roast_artifacts")
        or command.startswith("DELETE FROM app.roast_telemetry")
        or command.startswith("DELETE FROM app.cloud_roasts")
        or command.startswith("REMOVE ")
        for command in commands
    )


def test_cleanup_global_id_collision_skips_every_destructive_statement() -> None:
    cursor = FakeCursor(owned_roast_id_count=2)
    cleanup_errors = upsert_roast_verify_live._cleanup_all(cursor, ROAST_ID)

    assert len(cleanup_errors) == 1
    assert cleanup_errors[0].cleanup_unsafe is True
    assert upsert_roast_verify_live.TEST_RUN_ID in str(cleanup_errors[0])
    assert ROAST_ID in str(cleanup_errors[0])
    assert (
        "SELECT COUNT(*) FROM app.cloud_roasts WHERE id = %s",
        (ROAST_ID,),
    ) in cursor.executed
    assert not any(
        command.startswith("DELETE ") or command.startswith("REMOVE ")
        for command, _params in cursor.executed
    )


def test_cleanup_revalidates_identity_then_runs_full_sequence_in_order() -> None:
    connection = FakeConnection()
    _verify(connection)
    assert connection.fake_cursor.executed[-8] == (
        "SELECT id FROM app.cloud_roasts WHERE idempotency_key = %s",
        (upsert_roast_verify_live.TEST_RUN_ID,),
    )
    assert connection.fake_cursor.executed[-7] == (
        "SELECT COUNT(*) FROM app.cloud_roasts WHERE id = %s",
        (ROAST_ID,),
    )
    cleanup = connection.fake_cursor.executed[-6:]
    assert [command.split(maxsplit=2)[:2] for command, _params in cleanup] == [
        ["DELETE", "FROM"],
        ["DELETE", "FROM"],
        ["DELETE", "FROM"],
        ["DELETE", "FROM"],
        ["REMOVE", f"@app.roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/"],
        ["LIST", f"@app.roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/"],
    ]
    assert cleanup[0][0].startswith("DELETE FROM app.roast_artifacts")
    assert cleanup[0][1] == (ROAST_ID, upsert_roast_verify_live.TEST_RUN_ID)
    assert cleanup[1][0].startswith("DELETE FROM app.roast_telemetry WHERE (")
    assert cleanup[1][1] == (ROAST_ID, upsert_roast_verify_live.TEST_RUN_ID)
    assert cleanup[2] == (
        "DELETE FROM app.roast_telemetry WHERE roast_id = %s",
        (upsert_roast_verify_live.OTHER_ROAST_ID,),
    )
    assert cleanup[3] == (
        "DELETE FROM app.cloud_roasts WHERE idempotency_key = %s",
        (upsert_roast_verify_live.TEST_RUN_ID,),
    )


def test_cleanup_failure_does_not_gate_later_cleanup_actions() -> None:
    connection = FakeConnection(fail_on={"DELETE FROM app.roast_artifacts"})
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match="live verification cleanup failed",
    ) as raised:
        _verify(connection)
    commands = _commands(connection)
    assert any(
        command.startswith("DELETE FROM app.roast_telemetry") for command in commands
    )
    assert any(
        command.startswith("DELETE FROM app.cloud_roasts") for command in commands
    )
    assert any(command.startswith("REMOVE ") for command in commands)
    assert sum(command.startswith("LIST ") for command in commands) == 3
    assert raised.value.cleanup_failures == [
        "cleanup failed for run id "
        f"{upsert_roast_verify_live.TEST_RUN_ID}: artifact cleanup "
        f"[roast_id={ROAST_ID} OR "
        f"idempotency_key={upsert_roast_verify_live.TEST_RUN_ID}] failed; "
        f"diagnostic cloud_roast_id={ROAST_ID}"
    ]


def test_main_prints_every_cleanup_failure_without_masking_body_error(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    connection = FakeConnection(
        artifact_count=2,
        fail_on={
            "DELETE FROM app.roast_artifacts",
            "DELETE FROM app.roast_telemetry",
            "DELETE FROM app.cloud_roasts",
            "REMOVE ",
        },
        failure_message=RAW_PRIVATE_PATH,
    )
    monkeypatch.setattr(
        upsert_roast_verify_live,
        "_connect",
        lambda _target: connection,
    )
    assert upsert_roast_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    output = capsys.readouterr().err
    assert "artifact count does not match manifest" in output
    assert output.count(
        f"cleanup failed for run id {upsert_roast_verify_live.TEST_RUN_ID}:"
    ) == 5
    assert upsert_roast_verify_live.TEST_RUN_ID in output
    assert ROAST_ID in output
    for step in (
        "artifact cleanup",
        "roast telemetry cleanup",
        "sentinel telemetry cleanup",
        "parent cleanup",
        "stage REMOVE cleanup",
    ):
        assert step in output
    assert f"roast_id={upsert_roast_verify_live.OTHER_ROAST_ID}" in output
    assert f"idempotency_key={upsert_roast_verify_live.TEST_RUN_ID}" in output
    assert " OR idempotency_key=" in output
    assert f"diagnostic cloud_roast_id={ROAST_ID}" in output
    assert (
        "parent cleanup [idempotency_key="
        f"{upsert_roast_verify_live.TEST_RUN_ID}] failed"
        in output
    )
    assert (
        f"stage_prefix=@app.roast_artifacts/{upsert_roast_verify_live.TEST_RUN_ID}/"
        in output
    )
    assert RAW_PRIVATE_PATH not in output
    artifact_cleanup = next(
        entry
        for entry in connection.fake_cursor.executed
        if entry[0].startswith("DELETE FROM app.roast_artifacts")
    )
    assert artifact_cleanup[1] == (
        ROAST_ID,
        upsert_roast_verify_live.TEST_RUN_ID,
    )
