"""Contract tests for the operator-run live upsert verifier (issue #417)."""

from __future__ import annotations

import builtins
import json
import re
import sys
from decimal import Decimal
from pathlib import Path
from types import ModuleType

import pytest
from snowflake.connector.errors import Error as SnowflakeError

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


class FakeProgrammingError(SnowflakeError):
    def __init__(
        self, message: str, *, errno: object = 2003, sqlstate: object = "42S02"
    ) -> None:
        super().__init__(message, send_telemetry=False)
        self.errno = errno
        self.sqlstate = sqlstate


class ThrowingCauseAttributeError(SnowflakeError):
    def __init__(self, throwing_attribute: str) -> None:
        self._throwing_attribute: str | None = None
        super().__init__("SENTINEL-UPSERT-THROWING-DESCRIPTOR", send_telemetry=False)
        self._errno: object = None
        self._sqlstate: object = None
        self._throwing_attribute = throwing_attribute

    @property
    def errno(self) -> object:
        if self._throwing_attribute == "errno":
            raise KeyboardInterrupt("SENTINEL-UPSERT-ERRNO-DESCRIPTOR")
        return self._errno

    @errno.setter
    def errno(self, value: object) -> None:
        self._errno = value

    @property
    def sqlstate(self) -> object:
        if self._throwing_attribute == "sqlstate":
            raise SystemExit("SENTINEL-UPSERT-SQLSTATE-DESCRIPTOR")
        return self._sqlstate

    @sqlstate.setter
    def sqlstate(self, value: object) -> None:
        self._sqlstate = value


class SecretFormattingInt(int):
    def __str__(self) -> str:
        return "SENTINEL-UPSERT-INT-STR\nforged-int-line"

    def __format__(self, _format_spec: str) -> str:
        return "SENTINEL-UPSERT-INT-FORMAT\nforged-int-line"


class SecretFormattingStr(str):
    def __str__(self) -> str:
        return "SENTINEL-UPSERT-STR-STR\nforged-str-line"

    def __format__(self, _format_spec: str) -> str:
        return "SENTINEL-UPSERT-STR-FORMAT\nforged-str-line"


class RaisingClassPropertyError(Exception):
    @property
    def __class__(self) -> type:
        raise RuntimeError("SENTINEL-UPSERT-RAISING-CLASS")


class SpoofingClassPropertyError(Exception):
    def __init__(self) -> None:
        super().__init__("SENTINEL-UPSERT-SPOOFING-CLASS")
        self.attribute_reads: list[str] = []

    @property
    def __class__(self) -> type:
        return SnowflakeError

    @property
    def errno(self) -> SecretFormattingInt:
        self.attribute_reads.append("errno")
        return SecretFormattingInt(2003)

    @property
    def sqlstate(self) -> SecretFormattingStr:
        self.attribute_reads.append("sqlstate")
        return SecretFormattingStr("42S02")


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
        existing_run_recheck_count: object | None = None,
        roast_count: object = 1,
        slug_roast_count: object = 1,
        control_roast_count: object = 1,
        empty_manifest_roast_count: object = 1,
        final_roast_count: object = 1,
        sentinel_owner_count: object = 0,
        sentinel_telemetry_count: object = 0,
        sentinel_telemetry_recheck_count: object | None = None,
        owned_roast_id_count: object = 1,
        first_result: object = FIRST_RESULT,
        replay_result: object = FIRST_RESULT,
        slug_result: object = FIRST_RESULT,
        control_result: object = FIRST_RESULT,
        empty_manifest_result: object = FIRST_RESULT,
        opt_out_result: object = FIRST_RESULT,
        ambiguous_roast_ids: tuple[object, ...] = (ROAST_ID, "second-roast-id"),
        cleanup_roast_ids: tuple[object, ...] = (ROAST_ID,),
        cleanup_identity_query_fails: bool = False,
        artifact_count: object = 3,
        identical_artifact_count: object = 3,
        slug_artifact_count: object = 3,
        control_artifact_count: object = 3,
        empty_manifest_artifact_count: object = 0,
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
        empty_manifest_preserved_change: tuple[int, object] | None = None,
        final_preserved_change: tuple[int, object] | None = None,
        mapping_rows: bool = False,
        stored_visibility: object = "private",
        stored_notes: object = upsert_roast_verify_live.ORIGINAL_NOTES,
        stored_updated_at: object = 2,
        telemetry_setup_count: object = 2,
        telemetry_control_count: object = 2,
        telemetry_empty_manifest_count: object = 2,
        telemetry_survives: bool = False,
        sentinel_rows: int = 0,
        sentinel_survives: bool = True,
        visibility_raises: bool = True,
        visibility_error: str = "-20012 visibility_change_not_supported",
        invalid_payload_raises: bool = True,
        invalid_payload_error: str = "-20009 invalid_payload",
        identical_updated_at: object = 1,
        updated_after: object = 2,
        control_updated_at: object = 3,
        empty_manifest_updated_at: object = 4,
        final_updated_at: object = 4,
        fail_on: set[str] | None = None,
        failure_message: str = "scripted connector failure",
        shared_state: dict[str, bool] | None = None,
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
        self.existing_run_recheck_count = existing_run_recheck_count
        self.roast_count = roast_count
        self.slug_roast_count = slug_roast_count
        self.control_roast_count = control_roast_count
        self.empty_manifest_roast_count = empty_manifest_roast_count
        self.final_roast_count = final_roast_count
        self.sentinel_owner_count = sentinel_owner_count
        self.sentinel_telemetry_count = sentinel_telemetry_count
        self.sentinel_telemetry_recheck_count = sentinel_telemetry_recheck_count
        self.owned_roast_id_count = owned_roast_id_count
        self.first_result = first_result
        self.replay_result = replay_result
        self.slug_result = slug_result
        self.control_result = control_result
        self.empty_manifest_result = empty_manifest_result
        self.opt_out_result = opt_out_result
        self.ambiguous_roast_ids = ambiguous_roast_ids
        self.cleanup_roast_ids = cleanup_roast_ids
        self.cleanup_identity_query_fails = cleanup_identity_query_fails
        self.artifact_count = artifact_count
        self.identical_artifact_count = identical_artifact_count
        self.slug_artifact_count = slug_artifact_count
        self.control_artifact_count = control_artifact_count
        self.empty_manifest_artifact_count = empty_manifest_artifact_count
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
        self.empty_manifest_preserved_change = empty_manifest_preserved_change
        self.final_preserved_change = final_preserved_change
        self.mapping_rows = mapping_rows
        self.stored_visibility = stored_visibility
        self.stored_notes = stored_notes
        self.stored_updated_at = stored_updated_at
        self.telemetry_setup_count = telemetry_setup_count
        self.telemetry_control_count = telemetry_control_count
        self.telemetry_empty_manifest_count = telemetry_empty_manifest_count
        self.telemetry_survives = telemetry_survives
        self.sentinel_rows = sentinel_rows or 1
        self.sentinel_survives = sentinel_survives
        self.visibility_raises = visibility_raises
        self.visibility_error = visibility_error
        self.invalid_payload_raises = invalid_payload_raises
        self.invalid_payload_error = invalid_payload_error
        self.identical_updated_at = identical_updated_at
        self.updated_after = updated_after
        self.control_updated_at = control_updated_at
        self.empty_manifest_updated_at = empty_manifest_updated_at
        self.final_updated_at = final_updated_at
        self.fail_on = set() if fail_on is None else fail_on
        self.failure_message = failure_message
        self.shared_state = {} if shared_state is None else shared_state
        self.executed: list[tuple[str, tuple[object, ...] | None]] = []
        self.call_results: list[object] = []
        self.last_call_result: object = None
        self.roast_count_reads = 0
        self.preflight_run_count_reads = 0
        self.artifact_count_reads = 0
        self.sentinel_count_reads = 0
        self.preserved_reads = 0
        self.telemetry_seeded = False
        self.control_replayed = False
        self.empty_manifest_replayed = False
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
            self.removed = False
        elif command.startswith("CALL app.upsert_roast"):
            assert normalized is not None
            payload = json.loads(str(normalized[1]))
            if payload["operator_notes"] == upsert_roast_verify_live.ROLLBACK_NOTES:
                if self.visibility_raises:
                    raise RuntimeError(self.visibility_error)
                self.last_call_result = FIRST_RESULT
            elif payload["bean_origin"] in {
                "192.168.1.5",
                "230°F",
                "2001:db8::1",
                "110℉",
            }:
                if self.invalid_payload_raises:
                    raise RuntimeError(self.invalid_payload_error)
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
            elif payload["artifact_kinds"] == []:
                self.empty_manifest_replayed = True
                self.last_call_result = self.empty_manifest_result
            else:
                if self.shared_state.get("telemetry_seeded", False):
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
            self.shared_state["telemetry_seeded"] = True
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
            if self.existing_run_recheck_count is not None:
                self.preflight_run_count_reads += 1
                if self.preflight_run_count_reads == 1:
                    return (self.existing_run_count,)
                if self.preflight_run_count_reads == 2:
                    return (self.existing_run_recheck_count,)
                body_counts = (
                    self.roast_count,
                    self.slug_roast_count,
                    self.control_roast_count,
                    self.empty_manifest_roast_count,
                    self.final_roast_count,
                )
                body_index = min(
                    self.preflight_run_count_reads - 3,
                    len(body_counts) - 1,
                )
                return (body_counts[body_index],)
            self.roast_count_reads += 1
            if self.roast_count_reads == 1:
                return (self.existing_run_count,)
            if self.roast_count_reads == 2:
                return (self.roast_count,)
            if self.roast_count_reads == 3:
                return (self.slug_roast_count,)
            if self.roast_count_reads == 4:
                return (self.control_roast_count,)
            if self.roast_count_reads == 5:
                return (self.empty_manifest_roast_count,)
            return (self.final_roast_count,)
        if command.startswith("SELECT COUNT(*) FROM app.roast_artifacts"):
            self.artifact_count_reads += 1
            if self.artifact_count_reads == 1:
                return (self.identical_artifact_count,)
            if self.artifact_count_reads == 2:
                return (self.artifact_count,)
            if self.artifact_count_reads == 3:
                return (self.slug_artifact_count,)
            if self.artifact_count_reads == 4:
                return (self.control_artifact_count,)
            if self.artifact_count_reads == 5:
                return (self.empty_manifest_artifact_count,)
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
            elif self.opted_out:
                values[0], values[3] = self.stored_pair
                values[6] = self.final_updated_at
                if self.final_preserved_change is not None:
                    values[self.final_preserved_change[0]] = (
                        self.final_preserved_change[1]
                    )
            elif self.empty_manifest_replayed:
                values[0], values[3] = self.stored_pair
                values[6] = self.empty_manifest_updated_at
                if self.empty_manifest_preserved_change is not None:
                    values[self.empty_manifest_preserved_change[0]] = (
                        self.empty_manifest_preserved_change[1]
                    )
            else:
                values[0], values[3] = self.stored_pair
                values[6] = self.control_updated_at
                if self.control_preserved_change is not None:
                    values[self.control_preserved_change[0]] = (
                        self.control_preserved_change[1]
                    )
            return self._row(
                upsert_roast_verify_live.PRESERVED_COLUMNS,
                tuple(values),
            )
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
                if (
                    self.sentinel_count_reads == 2
                    and self.sentinel_telemetry_recheck_count is not None
                ):
                    return (self.sentinel_telemetry_recheck_count,)
                if self.opted_out and not self.sentinel_survives:
                    return (0,)
                return (self.sentinel_rows,)
            if self.opted_out:
                return (2 if self.telemetry_survives else 0,)
            if self.empty_manifest_replayed:
                return (self.telemetry_empty_manifest_count,)
            if self.control_replayed:
                return (self.telemetry_control_count,)
            return (self.telemetry_setup_count,)
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
        make_seed: bool = True,
        shared_state: dict[str, bool] | None = None,
        **cursor_options: object,
    ) -> None:
        state = {} if shared_state is None else shared_state
        self.fake_cursor = FakeCursor(shared_state=state, **cursor_options)
        self.closed = False
        self.close_error = close_error
        self.seed_connection = (
            FakeConnection(
                make_seed=False,
                shared_state=state,
                **cursor_options,
            )
            if make_seed
            else None
        )

    def cursor(self):
        return self.fake_cursor

    def close(self) -> None:
        self.closed = True
        if self.close_error is not None:
            raise self.close_error


def _commands(connection: FakeConnection) -> list[str]:
    return [command for command, _ in connection.fake_cursor.executed]


def _seed_commands(connection: FakeConnection) -> list[str]:
    assert connection.seed_connection is not None
    return _commands(connection.seed_connection)






def test_test_run_id_is_a_lowercase_uuid() -> None:
    assert re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}",
        upsert_roast_verify_live.TEST_RUN_ID,
    )






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






































def test_print_failure_emits_lowercase_connector_sqlstate(
    capsys: pytest.CaptureFixture[str],
) -> None:
    failure = upsert_roast_verify_live.UpsertRoastVerifyError("outer failure")
    failure.__cause__ = FakeProgrammingError(
        "SENTINEL-UPSERT-LOWERCASE", errno=None, sqlstate="42s02"
    )

    upsert_roast_verify_live._print_failure(failure)

    output = capsys.readouterr().err
    assert output == (
        "upsert verification failed: outer failure\n"
        "root cause: FakeProgrammingError sqlstate=42s02\n"
    )
    assert "SENTINEL" not in output


def test_sanitised_cause_fails_safe_when_connector_import_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real_import = builtins.__import__

    def fail_connector_import(name: str, *args: object, **kwargs: object) -> object:
        if name == "snowflake.connector.errors":
            raise SystemExit("SENTINEL-UPSERT-CONNECTOR-IMPORT")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fail_connector_import)
    cause = FakeProgrammingError("SENTINEL-UPSERT-IMPORT-CAUSE")

    assert upsert_roast_verify_live._sanitised_cause(cause) == (
        "FakeProgrammingError"
    )


@pytest.mark.parametrize(
    ("unsafe_name", "safe_name"),
    [
        ("Bad\nName\t", "BadName"),
        ("\n\t\x1b ", "UnknownError"),
        ("A" * 65, "A" * 64),
    ],
)
def test_print_failure_sanitises_and_bounds_cause_type_name(
    capsys: pytest.CaptureFixture[str],
    unsafe_name: str,
    safe_name: str,
) -> None:
    cause_type = type(unsafe_name, (Exception,), {})
    failure = upsert_roast_verify_live.UpsertRoastVerifyError("outer failure")
    failure.__cause__ = cause_type("SENTINEL-UPSERT-TYPE-MESSAGE")

    upsert_roast_verify_live._print_failure(failure)

    output = capsys.readouterr().err
    assert output == (
        "upsert verification failed: outer failure\n"
        f"root cause: {safe_name}\n"
    )
    assert "\nName" not in output
    assert "\t" not in output
    assert "\x1b" not in output
    assert "SENTINEL" not in output


def test_print_failure_handles_throwing_cause_type_name(
    capsys: pytest.CaptureFixture[str],
) -> None:
    class ThrowingNameMeta(type):
        def __getattribute__(self, attribute: str) -> object:
            if attribute == "__name__":
                raise SystemExit("SENTINEL-UPSERT-TYPE-NAME")
            return super().__getattribute__(attribute)

    cause_type = ThrowingNameMeta("InternalError", (Exception,), {})
    failure = upsert_roast_verify_live.UpsertRoastVerifyError("outer failure")
    failure.__cause__ = cause_type("SENTINEL-UPSERT-TYPE-MESSAGE")

    upsert_roast_verify_live._print_failure(failure)

    output = capsys.readouterr().err
    assert output == (
        "upsert verification failed: outer failure\n"
        "root cause: UnknownError\n"
    )
    assert "SENTINEL" not in output
    assert "Traceback" not in output


def test_print_failure_uses_outer_fallback_when_summary_operation_raises(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    failure = upsert_roast_verify_live.UpsertRoastVerifyError("outer failure")
    failure.__cause__ = FakeProgrammingError("SENTINEL-UPSERT-OUTER-FALLBACK")

    def fail_fullmatch(_pattern: str, _value: str) -> None:
        raise SystemExit("SENTINEL-UPSERT-FULLMATCH")

    monkeypatch.setattr(upsert_roast_verify_live.re, "fullmatch", fail_fullmatch)
    upsert_roast_verify_live._print_failure(failure)

    output = capsys.readouterr().err
    assert output == (
        "upsert verification failed: outer failure\n"
        "root cause: UnknownError\n"
    )
    assert "SENTINEL" not in output
    assert "Traceback" not in output






@pytest.mark.parametrize("throwing_attribute", ["errno", "sqlstate"])
def test_print_failure_omits_throwing_cause_attribute(
    capsys: pytest.CaptureFixture[str],
    throwing_attribute: str,
) -> None:
    failure = upsert_roast_verify_live.UpsertRoastVerifyError("outer failure")
    failure.__cause__ = ThrowingCauseAttributeError(throwing_attribute)

    upsert_roast_verify_live._print_failure(failure)

    output = capsys.readouterr().err
    assert output == (
        "upsert verification failed: outer failure\n"
        "root cause: ThrowingCauseAttributeError\n"
    )
    assert "SENTINEL" not in output
    assert "Traceback" not in output


































































































@pytest.mark.parametrize(
    "message",
    ["-20012", "visibility_change_not_supported"],
)
def test_visibility_error_accepts_each_contract_marker(message: str) -> None:
    assert upsert_roast_verify_live._is_visibility_error(RuntimeError(message))




@pytest.mark.parametrize(
    ("message", "expected"),
    [
        ("SQL compilation error -20009", True),
        ("invalid_payload", True),
        ("unrelated error", False),
    ],
)
def test_invalid_payload_error_matches_contract_markers(
    message: str,
    expected: bool,
) -> None:
    assert upsert_roast_verify_live._is_invalid_payload_error(
        RuntimeError(message)
    ) is expected






































def test_first_value_prefers_exact_mapping_key() -> None:
    row = {"id": "folded value", "ID": ROAST_ID}
    assert upsert_roast_verify_live._first_value(row, "ID") == ROAST_ID


@pytest.mark.parametrize("row", [42, (), [], "text", b"bytes"])
def test_first_value_returns_none_without_a_row_value(row: object) -> None:
    assert upsert_roast_verify_live._first_value(row, "ID") is None






def test_encoded_payload_wraps_unencodable_value() -> None:
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match=r"^payload encoding failed$",
    ) as raised:
        upsert_roast_verify_live._encoded_payload({"x": object()})
    assert isinstance(raised.value.__cause__, TypeError)










@pytest.mark.parametrize("value", [None, ""])
def test_required_env_rejects_unset_or_empty_value(
    monkeypatch: pytest.MonkeyPatch, value: str | None,
) -> None:
    name = "SNOWFLAKE_ACCOUNT"
    if value is None:
        monkeypatch.delenv(name, raising=False)
    else:
        monkeypatch.setenv(name, value)
    with pytest.raises(
        upsert_roast_verify_live.UpsertRoastVerifyError,
        match=r"^missing required environment variable: SNOWFLAKE_ACCOUNT$",
    ):
        upsert_roast_verify_live._required_env(name)


class _C2UntouchedArgument:
    def __init__(self):
        self.calls=[]
    def cursor(self):
        self.calls.append('cursor')
        return self


def test_uv_c2_verify_live_upsert_refuses_untouched_args():
    argument=_C2UntouchedArgument()
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError,match='^superseded by the C9-C2 coordinated write protocol; C9-C4 owns live qualification$'):
        upsert_roast_verify_live.verify_live_upsert(argument, unexpected=argument)
    assert argument.calls == []


@pytest.mark.parametrize('argv',[None,[],['--target','ROASTPILOT_DEV']])
def test_uv_c2_main_refuses_exit_1_stderr_only(argv,capsys):
    assert upsert_roast_verify_live.main(argv)==1
    captured=capsys.readouterr()
    assert captured.out==''
    assert captured.err=='superseded by the C9-C2 coordinated write protocol; C9-C4 owns live qualification\n'


def test_uv_c2_imported_refusal_zero_connector(monkeypatch):
    import snowflake.connector
    import verify_seed_connection
    calls=[]
    def forbidden(*args,**kwargs):
        calls.append((args,kwargs))
        raise AssertionError('unexpected connector')
    monkeypatch.setattr(snowflake.connector,'connect',forbidden)
    monkeypatch.setattr(verify_seed_connection,'connect_seed',forbidden)
    with pytest.raises(upsert_roast_verify_live.UpsertRoastVerifyError):
        upsert_roast_verify_live.verify_live_upsert(_C2UntouchedArgument())
    assert calls==[]


def test_uv_c2_retired_names_absent():
    for name in ['_assert_replay_state', '_call_expect_invalid_payload_error', '_call_expect_visibility_error', '_call_upsert', '_cleanup_all', '_cleanup_statement', '_connect', '_execute', '_fetchall', '_fetchone', '_preflight', '_stage_and_verify_fixtures', '_verify_artifact_manifest', '_verify_preserved_columns', '_verify_replay_idempotency', '_verify_telemetry_purge_scope', '_verify_visibility_rollback', 'connect_seed']:
        assert not hasattr(upsert_roast_verify_live,name)


def test_uv_c2_source_has_no_execution_surface():
    import ast
    tree=ast.parse(Path(upsert_roast_verify_live.__file__).read_text())
    forbidden={'execute','executemany','cursor','connect','connect_seed','fetchone','fetchall'}
    assert not [n for n in ast.walk(tree) if isinstance(n,ast.Call) and ((isinstance(n.func,ast.Attribute) and n.func.attr in forbidden) or (isinstance(n.func,ast.Name) and n.func.id in forbidden))]
    for name in ['verify_live_upsert']:
        function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name==name)
        operative=[n for n in function.body if not (isinstance(n,ast.Expr) and isinstance(n.value,ast.Constant) and isinstance(n.value.value,str))]
        assert len(operative)==1 and isinstance(operative[0],ast.Raise)
        assert not any(isinstance(n,ast.Name) and n.id in {'_args','_kwargs'} for n in ast.walk(operative[0]))
