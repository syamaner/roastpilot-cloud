"""Contract tests for the operator-run live seed loader (issue #356 U2)."""
from __future__ import annotations

from test_sync_coordination import position

import copy
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import seed_load_live  # noqa: E402


WRITE_RE = re.compile(r"\b(?:INSERT|MERGE|DELETE|UPDATE|TRUNCATE)\b", re.IGNORECASE)
NOW = datetime(2026, 8, 25, 12, 0, 0, tzinfo=timezone.utc)


def artifact(target: str = "ROASTPILOT_DEV") -> dict[str, object]:
    roast_id = "00000000-0000-0000-0000-000000000001"
    groups = [
        {
            "bean_origin": f"Origin {index}", "roast_level": "medium",
            "roast_count": 1, "review_count": 1, "avg_rating": 4.0,
            "first_crack_temp_avg_c": None, "first_crack_temp_stddev_c": None,
            "drop_temp_avg_c": None, "drop_temp_stddev_c": None,
            "development_percent_avg": 20.0, "first_crack_time_avg_s": 400.0,
            "total_time_avg_s": 600.0, "key_patterns": [],
            "updated_at": "2026-08-24T12:00:00Z",
        }
        for index in range(12)
    ]
    return {
        "target": target,
        "tables": [
            {"table": "cloud_roasts", "rows": [{
                "id": roast_id, "idempotency_key": "seed-1", "owner_id": None,
                "public_slug": "123456789ABCDEFGHJKLMNP", "visibility": "unlisted",
                "bean_origin": "Origin 0", "bean_varietal": "Bourbon",
                "bean_weight_g": 250.0, "profile_name": "Seed",
                "roast_level": "medium", "summary": {"total_roast_seconds": 600},
                "operator_rating": 4, "operator_notes": None,
                "contributed_to_learning": True,
                "roasted_at_utc": "2026-08-24T11:00:00Z",
                "created_at": "2026-08-24T12:00:00Z",
                "updated_at": "2026-08-24T12:00:00Z",
            }]},
            {"table": "roast_telemetry", "rows": [{
                "roast_id": roast_id, "elapsed_s": 0.0, "bean_temp_c": 25.0,
                "env_temp_c": 30.0, "heat_percent": 50, "fan_percent": 20,
                "ror_c_per_min": 0.0, "raw": {"source": "seed"},
            }]},
            {"table": "roast_artifacts", "rows": [{
                "roast_id": roast_id, "kind": "summary", "stage_path": "seed/a.json",
                "byte_size": 100, "created_at": "2026-08-24T12:00:00Z",
            }]},
            {"table": "tasting_reviews", "rows": [{
                "roast_id": roast_id, "reviewer_name": "Taster", "score": 4,
                "aroma": 70, "acidity": 60, "sweetness": 75, "body": 65,
                "aftertaste": 70, "brew_method": "pour-over", "notes": None,
                "submitted_ip_hash": None, "created_at": "2026-08-24T12:00:00Z",
            }]},
            {"table": "reference_roast_summaries", "rows": groups},
        ],
    }


class FakeCursor:
    def __init__(self, database: str = "ROASTPILOT_DEV", fail_on=None, persisted_rows=None):
        self.database = database
        self.fail_on = fail_on
        self.persisted_rows = persisted_rows
        self.cloud_by_key: dict[object, object] = {}
        self.executed: list[tuple[str, tuple[object, ...] | None]] = []

    def execute(self, command: str, params=None):
        normalized = tuple(params) if params is not None else None
        self.executed.append((command, normalized))
        if self.fail_on is not None and self.fail_on(command):
            raise RuntimeError("scripted write failure")
        if command.startswith("INSERT INTO APP.cloud_roasts"):
            self.cloud_by_key.setdefault(normalized[1], normalized[0])
        return self

    def fetchone(self):
        command = self.executed[-1][0]
        if command == "SELECT CURRENT_TRANSACTION()":
            return (None,)
        if command == "SELECT CURRENT_DATABASE()":
            return (self.database,)
        if command == "CALL APP.cloud_sync_enter()":
            return (1,)
        if command.startswith("SELECT COUNT(*) FROM APP.cloud_roasts "):
            return (len(self.cloud_by_key),)
        return (0,)

    def fetchall(self):
        if self.persisted_rows is not None:
            return self.persisted_rows
        return list(self.cloud_by_key.items())


class FakeConnection:
    def __init__(self, database: str = "ROASTPILOT_DEV", fail_on=None, persisted_rows=None):
        self.fake_cursor = FakeCursor(database, fail_on, persisted_rows)
        self.closed = False

    def cursor(self):
        return self.fake_cursor

    def close(self):
        self.closed = True


def commands(connection: FakeConnection) -> list[str]:
    return [command for command, _ in connection.fake_cursor.executed]


def test_t4_idle_probe_then_secondary_roles_before_every_write():
    connection = FakeConnection()
    seed_load_live.load_seed(connection, artifact(), "ROASTPILOT_DEV", NOW)
    assert commands(connection)[:2] == ['SELECT CURRENT_TRANSACTION()', 'USE SECONDARY ROLES NONE']
    first_write = next(index for index, command in enumerate(commands(connection)) if WRITE_RE.search(command))
    assert position(commands(connection), 'USE SECONDARY ROLES NONE') < first_write


def test_t5_physical_database_mismatch_aborts_before_every_write():
    connection = FakeConnection(database="ROASTPILOT_PROD")
    with pytest.raises(seed_load_live.SeedLoadError, match="connected database"):
        seed_load_live.load_seed(connection, artifact(), "ROASTPILOT_DEV", NOW)
    assert not any(WRITE_RE.search(command) for command in commands(connection))
    assert commands(connection) == [
        "SELECT CURRENT_TRANSACTION()", "USE SECONDARY ROLES NONE", "SELECT CURRENT_DATABASE()",
    ]


@pytest.mark.parametrize("target", ["ROASTPILOT_PROD", "", "roastpilot_dev"])
def test_t6_disallowed_target_is_rejected_before_connect(tmp_path: Path, target: str):
    path = tmp_path / "seed.json"
    path.write_text(json.dumps(artifact(target)), encoding="utf-8")
    calls: list[str] = []
    with pytest.raises(seed_load_live.SeedLoadError, match="target"):
        seed_load_live.run_operator_load(path, target, lambda value: calls.append(value), NOW)
    assert calls == []


def test_t6_artifact_target_must_be_byte_equal_before_connect(tmp_path: Path):
    path = tmp_path / "seed.json"
    path.write_text(json.dumps(artifact("ROASTPILOT_PREVIEW")), encoding="utf-8")
    called = False

    def connect(_target: str):
        nonlocal called
        called = True
        return FakeConnection()

    with pytest.raises(seed_load_live.SeedLoadError, match="byte-equal"):
        seed_load_live.run_operator_load(path, "ROASTPILOT_DEV", connect, NOW)
    assert called is False


def test_t6_successful_operator_wrapper_passes_target_and_closes(tmp_path: Path):
    path = tmp_path / "seed.json"
    payload = artifact()
    payload["tables"][3]["rows"][0]["submitted_ip_hash"] = "a" * 64  # type: ignore[index]
    path.write_text(json.dumps(payload), encoding="utf-8")
    connection = FakeConnection()
    targets: list[str] = []

    def connect(target: str):
        targets.append(target)
        return connection

    counts = seed_load_live.run_operator_load(path, "ROASTPILOT_DEV", connect, NOW)
    assert targets == ["ROASTPILOT_DEV"]
    assert counts == {table: len(entry["rows"])
                      for table, entry in zip(seed_load_live.TABLE_ORDER, artifact()["tables"])}
    assert connection.closed is True


@pytest.mark.parametrize("marker", [
    "INSERT INTO APP.cloud_roasts",
    "INSERT INTO APP.roast_telemetry",
    "INSERT INTO APP.roast_artifacts",
    "INSERT INTO APP.tasting_reviews",
    "MERGE INTO APP.reference_roast_summaries",
    "CALL APP.recompute_reference_summary",
])
def test_t7_every_load_or_recompute_exception_rolls_back_without_commit(marker: str):
    connection = FakeConnection(fail_on=lambda command: command.startswith(marker))
    with pytest.raises(RuntimeError, match="scripted write failure"):
        seed_load_live.load_seed(connection, artifact(), "ROASTPILOT_DEV", NOW)
    recorded = commands(connection)
    assert recorded.count("BEGIN") == 1
    assert recorded[-1] == "ROLLBACK"
    assert "COMMIT" not in recorded


def test_t7_cli_returns_nonzero_when_the_load_fails(monkeypatch, tmp_path: Path):
    path = tmp_path / "seed.json"

    def fail(*_args):
        raise RuntimeError("scripted operator failure")

    monkeypatch.setattr(seed_load_live, "run_operator_load", fail)
    assert seed_load_live.main([str(path), "--target", "ROASTPILOT_DEV"]) == 1


def test_main_connect_failure_is_sanitised_seed_load(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    path = tmp_path / "seed.json"
    path.write_text(json.dumps(artifact()), encoding="utf-8")

    def fail_connect(_target: str) -> None:
        raise RuntimeError(
            "account=SENTINELHOST.snowflakecomputing.com "
            "private_key=/secret/keys/agent.p8"
        )

    monkeypatch.setattr(seed_load_live, "_connect", fail_connect)

    assert seed_load_live.main([str(path), "--target", "ROASTPILOT_DEV"]) == 1
    captured = capsys.readouterr()
    assert "an unexpected error occurred" in captured.err
    assert "SENTINELHOST" not in captured.err
    assert "/secret/keys/agent.p8" not in captured.err


def test_main_key_read_failure_is_sanitised_seed_load(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    path = tmp_path / "seed.json"
    path.write_text(json.dumps(artifact()), encoding="utf-8")

    def fail_connect(_target: str) -> None:
        raise FileNotFoundError("/secret/keys/agent.p8")

    monkeypatch.setattr(seed_load_live, "_connect", fail_connect)

    assert seed_load_live.main([str(path), "--target", "ROASTPILOT_DEV"]) == 1
    captured = capsys.readouterr()
    assert "an unexpected error occurred" in captured.err
    assert "SENTINELHOST" not in captured.err
    assert "/secret/keys/agent.p8" not in captured.err


def test_main_body_failure_is_sanitised_seed_load(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def fail_load(*_args: object) -> None:
        raise RuntimeError(
            "cursor.execute failed at SENTINELHOST.snowflakecomputing.com "
            "/secret/keys/agent.p8"
        )

    monkeypatch.setattr(seed_load_live, "run_operator_load", fail_load)

    assert seed_load_live.main(
        [str(tmp_path / "seed.json"), "--target", "ROASTPILOT_DEV"]
    ) == 1
    captured = capsys.readouterr()
    assert "an unexpected error occurred" in captured.err
    assert "SENTINELHOST" not in captured.err
    assert "/secret/keys/agent.p8" not in captured.err


def test_main_validation_error_keeps_detail_seed_load(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    path = tmp_path / "seed.json"
    path.write_text(json.dumps(artifact("ROASTPILOT_PREVIEW")), encoding="utf-8")

    assert seed_load_live.main([str(path), "--target", "ROASTPILOT_DEV"]) == 1
    captured = capsys.readouterr()
    assert "artifact target is not byte-equal to the requested target" in captured.err


def _insert_columns(statement: str) -> tuple[str, ...]:
    match = re.search(r"INSERT INTO APP\.tasting_reviews\s*\((.*?)\)\s*SELECT", statement, re.DOTALL)
    assert match is not None
    return tuple(column.strip() for column in match.group(1).split(","))


def test_t8_unknown_raw_ip_and_fahrenheit_keys_never_enter_fixed_insert():
    payload = artifact()
    review = payload["tables"][3]["rows"][0]  # type: ignore[index]
    review["ip"] = "1.2.3.4"
    review["bean_temp_f"] = 451
    connection = FakeConnection()
    seed_load_live.load_seed(connection, payload, "ROASTPILOT_DEV", NOW)
    statement, params = next(
        item for item in connection.fake_cursor.executed
        if item[0].startswith("INSERT INTO APP.tasting_reviews")
    )
    inserted_columns = _insert_columns(statement)
    assert inserted_columns == seed_load_live.COLUMNS["tasting_reviews"]
    assert "ip" not in inserted_columns and "bean_temp_f" not in inserted_columns
    assert "1.2.3.4" not in params and 451 not in params


@pytest.mark.parametrize("bad_hash", ["1.2.3.4", "A" * 64, "a" * 63, 123])
def test_t8_submitted_ip_hash_rejects_non_lowercase_sha256_before_write(bad_hash):
    # Mutation guard: removing or inverting the closed hash-format check fails here.
    payload = artifact()
    payload["tables"][3]["rows"][0]["submitted_ip_hash"] = bad_hash  # type: ignore[index]
    connection = FakeConnection()
    with pytest.raises(seed_load_live.SeedLoadError, match="submitted_ip_hash"):
        seed_load_live.load_seed(connection, payload, "ROASTPILOT_DEV", NOW)
    assert commands(connection) == []


@pytest.mark.parametrize("valid_hash", [None, "a" * 64, "0123456789abcdef" * 4])
def test_t8_submitted_ip_hash_accepts_null_or_lowercase_sha256(valid_hash):
    payload = artifact()
    payload["tables"][3]["rows"][0]["submitted_ip_hash"] = valid_hash  # type: ignore[index]
    connection = FakeConnection()
    seed_load_live.load_seed(connection, payload, "ROASTPILOT_DEV", NOW)
    assert "COMMIT" in commands(connection)


@pytest.mark.parametrize("created_at", [
    "2026-07-26T12:00:01Z",
    "2026-08-25T12:00:00Z",
])
def test_t8_ip_hash_created_within_retention_passes(created_at: str):
    payload = artifact()
    review = payload["tables"][3]["rows"][0]  # type: ignore[index]
    review["submitted_ip_hash"] = "a" * 64
    review["created_at"] = created_at
    connection = FakeConnection()
    seed_load_live.load_seed(connection, payload, "ROASTPILOT_DEV", NOW)
    assert commands(connection)[-1] == "COMMIT"


@pytest.mark.parametrize("created_at", [
    "2026-07-26T12:00:00Z",
    "2026-07-26T11:59:59Z",
])
def test_t8_ip_hash_at_or_past_retention_is_rejected_before_connect(
    tmp_path: Path,
    created_at: str,
):
    # Mutation guard: removing/inverting retention or changing >= to > fails here.
    payload = artifact()
    review = payload["tables"][3]["rows"][0]  # type: ignore[index]
    review["submitted_ip_hash"] = "a" * 64
    review["created_at"] = created_at
    path = tmp_path / "seed.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    calls: list[str] = []
    with pytest.raises(seed_load_live.SeedLoadError, match="30-day retention"):
        seed_load_live.run_operator_load(path, "ROASTPILOT_DEV", calls.append, NOW)
    assert calls == []


def test_t8_ip_hash_created_in_future_is_rejected_before_connect(tmp_path: Path):
    payload = artifact()
    review = payload["tables"][3]["rows"][0]  # type: ignore[index]
    review["submitted_ip_hash"] = "a" * 64
    review["created_at"] = "2026-08-25T12:00:01Z"
    path = tmp_path / "seed.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    calls: list[str] = []
    with pytest.raises(seed_load_live.SeedLoadError, match="no later than now"):
        seed_load_live.run_operator_load(path, "ROASTPILOT_DEV", calls.append, NOW)
    assert calls == []


@pytest.mark.parametrize("created_at", ["not-a-timestamp", 123])
def test_t8_ip_hash_with_unparseable_created_at_is_rejected_before_connect(
    tmp_path: Path,
    created_at: object,
):
    payload = artifact()
    review = payload["tables"][3]["rows"][0]  # type: ignore[index]
    review["submitted_ip_hash"] = "a" * 64
    review["created_at"] = created_at
    path = tmp_path / "seed.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    calls: list[str] = []
    with pytest.raises(seed_load_live.SeedLoadError, match="valid parseable created_at"):
        seed_load_live.run_operator_load(path, "ROASTPILOT_DEV", calls.append, NOW)
    assert calls == []


def test_t8_null_ip_hash_has_no_retention_obligation():
    payload = artifact()
    review = payload["tables"][3]["rows"][0]  # type: ignore[index]
    review["submitted_ip_hash"] = None
    review["created_at"] = "2020-01-01T00:00:00Z"
    connection = FakeConnection()
    seed_load_live.load_seed(connection, payload, "ROASTPILOT_DEV", NOW)
    assert commands(connection)[-1] == "COMMIT"


def test_t8_variant_values_are_compact_json_and_null_stays_sql_null():
    assert seed_load_live._variant(None) is None
    assert seed_load_live._variant({"a": [1, 2]}) == '{"a":[1,2]}'
    row = {"summary": {"c": 1}, "raw": [2], "key_patterns": [], "plain": "value"}
    assert seed_load_live._params(row, ("summary", "raw", "key_patterns", "plain")) == (
        '{"c":1}', "[2]", "[]", "value",
    )


@pytest.mark.parametrize("row, expected", [
    ({"CURRENT_DATABASE()": "ROASTPILOT_DEV"}, "ROASTPILOT_DEV"),
    ([], None),
    ("ROASTPILOT_DEV", None),
    (None, None),
])
def test_t5_current_database_result_shapes(row, expected):
    cursor = FakeCursor()
    cursor.fetchone = lambda: row
    assert seed_load_live._current_database(cursor) == expected


class StatefulConnection(FakeConnection):
    def __init__(self):
        super().__init__()
        self.cloud_by_key: dict[object, object] = {}
        self.children = {table: [] for table in (
            "roast_telemetry", "roast_artifacts", "tasting_reviews",
        )}
        self.summaries: dict[tuple[object, object], tuple[object, ...]] = {}
        self.fake_cursor = StatefulCursor(self)


class StatefulCursor(FakeCursor):
    def __init__(self, connection: StatefulConnection):
        super().__init__()
        self.connection = connection

    def execute(self, command: str, params=None):
        super().execute(command, params)
        values = tuple(params) if params is not None else ()
        if command.startswith("INSERT INTO APP.cloud_roasts"):
            self.connection.cloud_by_key.setdefault(values[1], values[0])
        for table in self.connection.children:
            if command.startswith(f"DELETE FROM APP.{table}"):
                seeded = set(values)
                roast_id_index = 0 if table == "roast_telemetry" else 1
                self.connection.children[table] = [row for row in self.connection.children[table]
                                                   if row[roast_id_index] not in seeded]
            elif command.startswith(f"INSERT INTO APP.{table}"):
                self.connection.children[table].append(values)
        if command.startswith("MERGE INTO APP.reference_roast_summaries"):
            self.connection.summaries[(values[1], values[2])] = values
        return self


def test_t9_insert_only_seed_refuses_second_load_without_changing_identity_or_children():
    connection = StatefulConnection()
    payload = artifact()
    seed_load_live.load_seed(connection, payload, "ROASTPILOT_DEV", NOW)
    first = dict(connection.cloud_by_key)
    first_children = copy.deepcopy(connection.children)
    with pytest.raises(seed_load_live.SeedLoadError, match="seed target state"):
        seed_load_live.load_seed(connection, payload, "ROASTPILOT_DEV", NOW)
    assert connection.cloud_by_key == first
    assert len([x for x in commands(connection) if x.startswith('INSERT INTO APP.cloud_roasts')]) == 1
    identity_and_child_writes = [x for x in commands(connection) if re.search(r"(?:INSERT INTO|MERGE INTO|UPDATE|DELETE FROM) APP\.(?:cloud_roasts|roast_telemetry|roast_artifacts|tasting_reviews|cloud_roast_field_revisions)\b", x, re.I)]
    assert not any(re.search(r"\bMERGE\b|\bUPDATE\b|\bDELETE\b", x, re.I) for x in identity_and_child_writes)
    assert connection.children == first_children
    summary_merges = [i for i, x in enumerate(commands(connection)) if x.startswith("MERGE INTO APP.reference_roast_summaries")]
    assert summary_merges and position(commands(connection), 'CALL APP.cloud_sync_enter()') < min(summary_merges)
    assert commands(connection)[-1] == 'ROLLBACK'


def test_t9_persisted_id_mismatch_rolls_back_before_child_writes():
    # Mutation guard: removing or inverting persisted-id byte equality fails here.
    connection = FakeConnection(persisted_rows=[
        ("seed-1", "ffffffff-ffff-ffff-ffff-ffffffffffff"),
    ])
    with pytest.raises(seed_load_live.SeedLoadError, match="persisted cloud_roast id"):
        seed_load_live.load_seed(connection, artifact(), "ROASTPILOT_DEV", NOW)
    recorded = commands(connection)
    assert not any(command.startswith("DELETE FROM APP.") for command in recorded)
    assert not any(command.startswith("INSERT INTO APP." + table) for command in recorded for table in ("roast_telemetry", "roast_artifacts", "tasting_reviews", "cloud_roast_field_revisions"))
    assert recorded[-1] == "ROLLBACK"
    assert "COMMIT" not in recorded


def test_t9_matching_persisted_id_allows_child_writes():
    roast_id = "00000000-0000-0000-0000-000000000001"
    connection = FakeConnection(persisted_rows=[("seed-1", roast_id)])
    seed_load_live.load_seed(connection, artifact(), "ROASTPILOT_DEV", NOW)
    recorded = commands(connection)
    identity_select, identity_params = next(
        (command, params) for command, params in connection.fake_cursor.executed
        if command.startswith("SELECT idempotency_key, id")
    )
    assert identity_select.endswith("WHERE idempotency_key IN (%s)")
    assert identity_params == ("seed-1",)
    assert any(command.startswith("INSERT INTO APP.roast_telemetry") for command in recorded)
    assert not any(command.startswith("DELETE FROM APP.") for command in recorded)
    assert recorded[-1] == "COMMIT"


def test_t10_children_are_scoped_delete_then_insert_and_reload_counts_match():
    connection = StatefulConnection()
    payload = artifact()
    seed_load_live.load_seed(connection, payload, "ROASTPILOT_DEV", NOW)
    first_counts = {table: len(rows) for table, rows in connection.children.items()}
    with pytest.raises(seed_load_live.SeedLoadError):
        seed_load_live.load_seed(connection, payload, "ROASTPILOT_DEV", NOW)
    assert {table: len(rows) for table, rows in connection.children.items()} == first_counts
    roast_id = payload['tables'][0]['rows'][0]['id']
    for table in connection.children:
        selected = [(command, params) for command, params in connection.fake_cursor.executed if f'APP.{table}' in command]
        assert selected[0] == (f'SELECT COUNT(*) FROM APP.{table} WHERE roast_id IN (%s)', (roast_id,))
        assert selected[1][0].startswith(f'INSERT INTO APP.{table}')
        assert not any(re.search(r'\bDELETE\b|\bTRUNCATE\b', command) for command, _ in selected)


def test_t10_child_delete_binds_every_seeded_roast_id():
    payload = artifact()
    second_roast = copy.deepcopy(payload["tables"][0]["rows"][0])  # type: ignore[index]
    second_roast["id"] = "00000000-0000-0000-0000-000000000002"
    second_roast["idempotency_key"] = "seed-2"
    second_roast["public_slug"] = "223456789ABCDEFGHJKLMNP"
    payload["tables"][0]["rows"].append(second_roast)  # type: ignore[index]
    connection = FakeConnection()
    seed_load_live.load_seed(connection, payload, "ROASTPILOT_DEV", NOW)
    expected_ids = (
        "00000000-0000-0000-0000-000000000001",
        "00000000-0000-0000-0000-000000000002",
    )
    deletes = [(command, params) for command, params in connection.fake_cursor.executed
               if command.startswith("SELECT COUNT(*) FROM APP.") and any("APP." + table + " " in command for table in ("roast_telemetry", "roast_artifacts", "tasting_reviews"))]
    identity_select, identity_params = next(
        (command, params) for command, params in connection.fake_cursor.executed
        if command.startswith("SELECT idempotency_key, id")
    )
    assert identity_select.endswith("WHERE idempotency_key IN (%s, %s)")
    assert identity_params == ("seed-1", "seed-2")
    assert len(deletes) == 3
    assert all(command.endswith("WHERE roast_id IN (%s, %s)") and params == expected_ids
               for command, params in deletes)


def test_t11_recomputes_each_of_twelve_loaded_groups_after_all_five_loads():
    connection = FakeConnection()
    payload = artifact()
    seed_load_live.load_seed(connection, payload, "ROASTPILOT_DEV", NOW)
    recorded = connection.fake_cursor.executed
    calls = [(index, params) for index, (command, params) in enumerate(recorded)
             if command == "CALL APP.recompute_reference_summary(%s, %s)"]
    assert len(calls) == 12
    expected = {(row["bean_origin"], row["roast_level"])
                for row in payload["tables"][4]["rows"]}  # type: ignore[index]
    assert {params for _, params in calls} == expected
    last_load = max(index for index, (command, _) in enumerate(recorded)
                    if WRITE_RE.search(command))
    assert min(index for index, _ in calls) > last_load
    assert max(index for index, _ in calls) < position(commands(connection), 'COMMIT')


def _unknown_top(payload):
    payload["unknown"] = True


def _missing_table(payload):
    payload["tables"].pop()


def _extra_table(payload):
    payload["tables"].append({"table": "cloud_roasts", "rows": []})


def _misordered_table(payload):
    payload["tables"][0], payload["tables"][1] = payload["tables"][1], payload["tables"][0]


def _unknown_table(payload):
    payload["tables"][0]["table"] = "unknown_table"


def _non_array_rows(payload):
    payload["tables"][2]["rows"] = {}


def _unknown_table_entry_key(payload):
    payload["tables"][0]["unknown"] = True


@pytest.mark.parametrize("mutate", [
    _unknown_top, _missing_table, _extra_table, _misordered_table, _unknown_table,
    _non_array_rows, _unknown_table_entry_key,
])
def test_t12_closed_json_grammar_aborts_before_any_statement(mutate):
    payload = copy.deepcopy(artifact())
    mutate(payload)
    connection = FakeConnection()
    with pytest.raises(seed_load_live.SeedLoadError):
        seed_load_live.load_seed(connection, payload, "ROASTPILOT_DEV", NOW)
    assert commands(connection) == []


@pytest.mark.parametrize("bad_id", [None, 123, ""])
def test_t12_invalid_cloud_ids_abort_before_any_statement(bad_id):
    payload = artifact()
    payload["tables"][0]["rows"][0]["id"] = bad_id  # type: ignore[index]
    for table_entry in payload["tables"][1:4]:  # type: ignore[index]
        table_entry["rows"][0]["roast_id"] = bad_id
    connection = FakeConnection()
    with pytest.raises(seed_load_live.SeedLoadError):
        seed_load_live.load_seed(connection, payload, "ROASTPILOT_DEV", NOW)
    assert commands(connection) == []


@pytest.mark.parametrize("origin, level", [
    (123, "medium"), ("Origin", 123), ("", "medium"), ("Origin", ""),
])
def test_t12_invalid_reference_group_keys_abort_before_any_statement(origin, level):
    payload = artifact()
    payload["tables"][4]["rows"][0]["bean_origin"] = origin  # type: ignore[index]
    payload["tables"][4]["rows"][0]["roast_level"] = level  # type: ignore[index]
    connection = FakeConnection()
    with pytest.raises(seed_load_live.SeedLoadError):
        seed_load_live.load_seed(connection, payload, "ROASTPILOT_DEV", NOW)
    assert commands(connection) == []


def test_operator_env_helper_requires_a_nonempty_value(monkeypatch):
    monkeypatch.setenv("SEED_TEST_ENV", "present")
    assert seed_load_live._required_env("SEED_TEST_ENV") == "present"
    monkeypatch.delenv("SEED_TEST_ENV")
    with pytest.raises(seed_load_live.SeedLoadError):
        seed_load_live._required_env("SEED_TEST_ENV")


class C2Cursor(FakeCursor):
    def __init__(self, *, entry=1, invalid_table=None, count=1):
        super().__init__()
        self.entry = entry
        self.invalid_table = invalid_table
        self.count = count

    def fetchone(self):
        command = self.executed[-1][0]
        if command == 'CALL APP.cloud_sync_enter()':
            return (self.entry,)
        if self.invalid_table and command.startswith('SELECT COUNT(*) FROM APP.' + self.invalid_table + ' '):
            return (self.count,)
        return super().fetchone()


def c2_connection(**kwargs):
    connection = FakeConnection()
    connection.fake_cursor = C2Cursor(**kwargs)
    return connection


@pytest.mark.parametrize('field', ['id','idempotency_key','public_slug'])
def test_seed_c2_duplicate_input_refused_before_sql(field):
    source = Path(seed_load_live.__file__).read_text()
    assert re.search(r'for field in \("id", "idempotency_key", "public_slug"\):\s+values = \[row.get\(field\).*?if any\(value in values\[:index\] for index, value in enumerate\(values\)\):\s+raise SeedLoadError\("seeded identities must be distinct"\)', source, re.S)
    data = artifact()
    row = copy.deepcopy(data['tables'][0]['rows'][0])
    row.update(id='00000000-0000-0000-0000-000000000002', idempotency_key='second', public_slug='223456789ABCDEFGHJKLMNP')
    row[field] = data['tables'][0]['rows'][0][field]
    data['tables'][0]['rows'].append(row)
    connection = FakeConnection()
    with pytest.raises(seed_load_live.SeedLoadError):
        seed_load_live.load_seed(connection,data,'ROASTPILOT_DEV',NOW)
    assert commands(connection) == []


def test_seed_c2_enter_first_after_begin():
    # Structural assertion catches omission before a fake result can become a runtime error.
    text=Path(seed_load_live.__file__).read_text()
    assert re.search(r'cursor.execute\("BEGIN"\)\s+try:\s+cursor.execute\("CALL APP.cloud_sync_enter\(\)"\)',text)
    connection=FakeConnection()
    seed_load_live.load_seed(connection,artifact(),'ROASTPILOT_DEV',NOW)
    assert commands(connection)[3:5] == ['BEGIN','CALL APP.cloud_sync_enter()']


@pytest.mark.parametrize('value',[None,True,-1,'1'])
def test_seed_c2_enter_invalid_result_refused(value):
    connection=c2_connection(entry=value)
    with pytest.raises(seed_load_live.SeedLoadError,match='invalid coordinated write sequence'):
        seed_load_live.load_seed(connection,artifact(),'ROASTPILOT_DEV',NOW)
    assert commands(connection)[-1] == 'ROLLBACK' and 'COMMIT' not in commands(connection)
    assert not any(WRITE_RE.search(x) for x in commands(connection))


def _assert_existing_refused(table):
    connection=c2_connection(invalid_table=table)
    with pytest.raises(seed_load_live.SeedLoadError,match='seed target state'):
        seed_load_live.load_seed(connection,artifact(),'ROASTPILOT_DEV',NOW)
    assert commands(connection)[-1] == 'ROLLBACK' and 'COMMIT' not in commands(connection)
    assert not any(WRITE_RE.search(x) for x in commands(connection))


def test_seed_c2_existing_cloud_identity_refused():
    _assert_existing_refused('cloud_roasts')


def test_seed_c2_tombstone_identity_refused():
    _assert_existing_refused('cloud_roast_tombstones')


def test_seed_c2_existing_field_state_refused():
    _assert_existing_refused('cloud_roast_field_revisions')


@pytest.mark.parametrize('table',['roast_telemetry','roast_artifacts','tasting_reviews'])
def test_seed_c2_existing_child_rows_refused(table):
    _assert_existing_refused(table)


def test_seed_c2_insert_only_no_merge_no_delete():
    assert seed_load_live.CLOUD_ROAST_INSERT.startswith('INSERT INTO APP.cloud_roasts')
    assert not re.search(r'\bMERGE\b|WHEN MATCHED|\bDELETE\b',seed_load_live.CLOUD_ROAST_INSERT,re.I)
    connection=FakeConnection()
    seed_load_live.load_seed(connection,artifact(),'ROASTPILOT_DEV',NOW)
    assert not any(re.search(r'\bDELETE\b|\bTRUNCATE\b',x,re.I) for x in commands(connection))


def test_seed_c2_three_baseline_revisions_per_roast():
    connection=FakeConnection()
    seed_load_live.load_seed(connection,artifact(),'ROASTPILOT_DEV',NOW)
    inserts=[(command,params) for command,params in connection.fake_cursor.executed if command.startswith('INSERT INTO APP.cloud_roast_field_revisions')]
    assert len(inserts)==3
    assert [p for _,p in inserts]==[(artifact()['tables'][0]['rows'][0]['id'],name,1) for name in ['operator_rating','operator_notes','contributed_to_learning']]
    assert all('accepted_revision, accepted_write_seq) SELECT %s, %s, 0, %s' in c for c,_ in inserts)


@pytest.mark.parametrize('table',['cloud_roasts','cloud_roast_tombstones','cloud_roast_field_revisions','roast_telemetry','roast_artifacts','tasting_reviews'])
@pytest.mark.parametrize('count',[None,True,-1,1,'0',0.0])
def test_seed_c2_refusal_rolls_back_no_commit(table,count):
    connection=c2_connection(invalid_table=table,count=count)
    with pytest.raises(seed_load_live.SeedLoadError):
        seed_load_live.load_seed(connection,artifact(),'ROASTPILOT_DEV',NOW)
    assert commands(connection)[-1]=='ROLLBACK' and 'COMMIT' not in commands(connection)


def test_seed_c2_exact_statement_sequence():
    connection=FakeConnection()
    seed_load_live.load_seed(connection,artifact(),'ROASTPILOT_DEV',NOW)
    recorded=commands(connection)
    expected=['SELECT CURRENT_TRANSACTION()','USE SECONDARY ROLES NONE','SELECT CURRENT_DATABASE()','BEGIN','CALL APP.cloud_sync_enter()']
    expected += ['SELECT COUNT(*) FROM APP.'+table+' '+suffix for table,suffix in [
        ('cloud_roasts','WHERE id IN (%s) OR idempotency_key IN (%s) OR public_slug IN (%s)'),
        ('cloud_roast_tombstones','WHERE cloud_roast_id IN (%s) OR idempotency_key IN (%s) OR public_slug IN (%s)'),
        ('cloud_roast_field_revisions','WHERE cloud_roast_id IN (%s)'),
        ('roast_telemetry','WHERE roast_id IN (%s)'),('roast_artifacts','WHERE roast_id IN (%s)'),('tasting_reviews','WHERE roast_id IN (%s)')]]
    assert recorded[:11]==expected
    assert recorded[11].startswith('INSERT INTO APP.cloud_roasts')
    assert recorded[12]=='SELECT idempotency_key, id FROM APP.cloud_roasts WHERE idempotency_key IN (%s)'
    assert [c.splitlines()[0] for c in recorded[13:16]]==['INSERT INTO APP.roast_telemetry','INSERT INTO APP.roast_artifacts','INSERT INTO APP.tasting_reviews']
    assert all(c.startswith('INSERT INTO APP.cloud_roast_field_revisions') for c in recorded[16:19])
    assert all(c.startswith('MERGE INTO APP.reference_roast_summaries') for c in recorded[19:31])
    assert recorded[31:43]==['CALL APP.recompute_reference_summary(%s, %s)']*12
    assert recorded[43:]==['COMMIT']
    ids=(artifact()['tables'][0]['rows'][0]['id'],)
    assert connection.fake_cursor.executed[5][1]==ids+('seed-1',)+('123456789ABCDEFGHJKLMNP',)


class RetainedSeedInt(int):
    pass


class RetainedSeedResponseCursor(FakeCursor):
    def __init__(self, *, entry_row=(0,), count_row=(0,), invalid_table=None, expected_preconditions=None):
        super().__init__()
        self.entry_row = entry_row
        self.count_row = count_row
        self.invalid_table = invalid_table
        self.expected_preconditions = expected_preconditions
        self.precondition_index = 0

    def execute(self, command, params=None):
        if self.expected_preconditions is not None and command.startswith('SELECT COUNT(*) FROM APP.'):
            observed = (command, tuple(params) if params is not None else None)
            assert self.precondition_index < len(self.expected_preconditions)
            assert observed == self.expected_preconditions[self.precondition_index]
            self.precondition_index += 1
        return super().execute(command, params)

    def fetchone(self):
        command = self.executed[-1][0]
        if command == 'CALL APP.cloud_sync_enter()':
            return self.entry_row
        if self.invalid_table and command.startswith('SELECT COUNT(*) FROM APP.' + self.invalid_table + ' '):
            return self.count_row
        return super().fetchone()


class RetainedSeedResponseConnection(FakeConnection):
    def __init__(self, **kwargs):
        super().__init__()
        self.fake_cursor = RetainedSeedResponseCursor(**kwargs)
        self.cursor_calls = 0

    def cursor(self):
        self.cursor_calls += 1
        return self.fake_cursor


class RetainedCountRow:
    def __init__(self, row):
        self.row = row

    def fetchone(self):
        return self.row


@pytest.mark.parametrize('row', [(0,), [0], range(1)])
def test_c2_retained_zero_count_accepts_only_valid_single_cell_zero(row):
    assert seed_load_live._require_zero_count(RetainedCountRow(row)) is None


@pytest.mark.parametrize('row', [None, 0, (), [], (0, 0), {}, {'COUNT(*)': 0}, '0', b'0', (True,), (False,), (-1,), (1,), ('0',), (0.0,), (RetainedSeedInt(0),)])
def test_c2_retained_zero_count_malformed_or_nonzero_has_exact_error(row):
    with pytest.raises(seed_load_live.SeedLoadError) as raised:
        seed_load_live._require_zero_count(RetainedCountRow(row))
    assert str(raised.value) == 'seed target state is not empty for these identities'


@pytest.mark.parametrize('table', ['cloud_roasts', 'cloud_roast_tombstones', 'cloud_roast_field_revisions', 'roast_telemetry', 'roast_artifacts', 'tasting_reviews'])
@pytest.mark.parametrize('row', [(), (0, 0), {}, {'COUNT(*)': 0}, '0', b'0', (True,), (-1,), ('0',), (RetainedSeedInt(0),)])
def test_c2_retained_count_shape_refusal_rolls_back_without_write(table, row):
    connection = RetainedSeedResponseConnection(invalid_table=table, count_row=row)
    with pytest.raises(seed_load_live.SeedLoadError) as raised:
        seed_load_live.load_seed(connection, artifact(), 'ROASTPILOT_DEV', NOW)
    assert str(raised.value) == 'seed target state is not empty for these identities'
    assert commands(connection)[-1] == 'ROLLBACK'
    assert 'COMMIT' not in commands(connection)
    assert not any(WRITE_RE.search(command) for command in commands(connection))


@pytest.mark.parametrize(('row', 'sequence'), [((0,), 0), ([0], 0), ((1,), 1), ([7], 7)])
def test_c2_retained_entry_zero_and_positive_have_exact_revision_sequence(row, sequence):
    connection = RetainedSeedResponseConnection(entry_row=row)
    seed_load_live.load_seed(connection, artifact(), 'ROASTPILOT_DEV', NOW)
    statement = 'INSERT INTO APP.cloud_roast_field_revisions (cloud_roast_id, field_name, accepted_revision, accepted_write_seq) SELECT %s, %s, 0, %s'
    revision_writes = [(query, params) for query, params in connection.fake_cursor.executed if query.startswith('INSERT INTO APP.cloud_roast_field_revisions')]
    assert revision_writes == [(statement, ('00000000-0000-0000-0000-000000000001', name, sequence)) for name in ['operator_rating', 'operator_notes', 'contributed_to_learning']]
    assert commands(connection)[-1] == 'COMMIT'
    assert 'ROLLBACK' not in commands(connection)


@pytest.mark.parametrize('row', [None, 0, (), [], (0, 0), {}, {'WRITE_SEQ': 0}, '0', b'0', (True,), (False,), (-1,), ('0',), (0.0,), (RetainedSeedInt(0),)])
def test_c2_retained_entry_malformed_shape_or_type_exact_error_no_write(row):
    connection = RetainedSeedResponseConnection(entry_row=row)
    with pytest.raises(seed_load_live.SeedLoadError) as raised:
        seed_load_live.load_seed(connection, artifact(), 'ROASTPILOT_DEV', NOW)
    assert str(raised.value) == 'invalid coordinated write sequence'
    assert commands(connection) == ['SELECT CURRENT_TRANSACTION()', 'USE SECONDARY ROLES NONE', 'SELECT CURRENT_DATABASE()', 'BEGIN', 'CALL APP.cloud_sync_enter()', 'ROLLBACK']
    assert not any(WRITE_RE.search(command) for command in commands(connection))


@pytest.mark.parametrize('field', ['id', 'idempotency_key', 'public_slug'])
def test_c2_retained_duplicate_identity_exact_message_before_cursor(field):
    data = artifact()
    duplicate = copy.deepcopy(data['tables'][0]['rows'][0])
    duplicate.update(id='00000000-0000-0000-0000-000000000002', idempotency_key='seed-2', public_slug='223456789ABCDEFGHJKLMNP')
    duplicate[field] = data['tables'][0]['rows'][0][field]
    data['tables'][0]['rows'].append(duplicate)
    connection = RetainedSeedResponseConnection()
    with pytest.raises(seed_load_live.SeedLoadError) as raised:
        seed_load_live.load_seed(connection, data, 'ROASTPILOT_DEV', NOW)
    expected = 'seeded cloud_roast ids must be distinct' if field == 'id' else 'seeded identities must be distinct'
    assert str(raised.value) == expected
    assert connection.cursor_calls == 0
    assert commands(connection) == []


def test_c2_retained_every_maintenance_precondition_has_exact_sql_and_bindings():
    ids = ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002')
    keys = ('seed-1', 'seed-2')
    slugs = ('123456789ABCDEFGHJKLMNP', '223456789ABCDEFGHJKLMNP')
    expected = [
        ('SELECT COUNT(*) FROM APP.cloud_roasts WHERE id IN (%s, %s) OR idempotency_key IN (%s, %s) OR public_slug IN (%s, %s)', ids + keys + slugs),
        ('SELECT COUNT(*) FROM APP.cloud_roast_tombstones WHERE cloud_roast_id IN (%s, %s) OR idempotency_key IN (%s, %s) OR public_slug IN (%s, %s)', ids + keys + slugs),
        ('SELECT COUNT(*) FROM APP.cloud_roast_field_revisions WHERE cloud_roast_id IN (%s, %s)', ids),
        ('SELECT COUNT(*) FROM APP.roast_telemetry WHERE roast_id IN (%s, %s)', ids),
        ('SELECT COUNT(*) FROM APP.roast_artifacts WHERE roast_id IN (%s, %s)', ids),
        ('SELECT COUNT(*) FROM APP.tasting_reviews WHERE roast_id IN (%s, %s)', ids),
    ]
    data = artifact()
    second = copy.deepcopy(data['tables'][0]['rows'][0])
    second.update(id=ids[1], idempotency_key=keys[1], public_slug=slugs[1])
    data['tables'][0]['rows'].append(second)
    connection = RetainedSeedResponseConnection(expected_preconditions=expected)
    seed_load_live.load_seed(connection, data, 'ROASTPILOT_DEV', NOW)
    assert connection.fake_cursor.precondition_index == 6
    assert connection.fake_cursor.executed[5:11] == expected
    assert commands(connection)[3:5] == ['BEGIN', 'CALL APP.cloud_sync_enter()']
    assert commands(connection)[-1] == 'COMMIT'


class IdleProbeCursor(FakeCursor):
    def __init__(self, row=(None,), error=None):
        super().__init__()
        self.probe_row = row
        self.probe_error = error

    def fetchone(self):
        if self.executed[-1][0] == 'SELECT CURRENT_TRANSACTION()':
            if self.probe_error is not None:
                raise self.probe_error
            return self.probe_row
        return super().fetchone()


def idle_probe_connection(row=(None,), error=None):
    connection = FakeConnection()
    connection.fake_cursor = IdleProbeCursor(row, error)
    # Sentinel for pre-existing caller work; load_seed has no authority over it.
    connection.caller_work = ['uncommitted caller insert']
    return connection


def assert_caller_transaction_untouched(connection):
    assert commands(connection) == ['SELECT CURRENT_TRANSACTION()']
    assert connection.caller_work == ['uncommitted caller insert']
    assert connection.closed is False
    assert 'BEGIN' not in commands(connection)
    assert 'COMMIT' not in commands(connection) and 'ROLLBACK' not in commands(connection)
    assert not any(WRITE_RE.search(command) for command in commands(connection))


@pytest.mark.parametrize('row', [(73,), ['caller-txn'], (False,), (0,)])
def test_seed_c2_existing_transaction_refused_without_rollback_commit_write_or_close(row):
    connection = idle_probe_connection(row)
    with pytest.raises(seed_load_live.SeedLoadError, match='already has a caller transaction'):
        seed_load_live.load_seed(connection, artifact(), 'ROASTPILOT_DEV', NOW)
    assert_caller_transaction_untouched(connection)


@pytest.mark.parametrize('row', [None, (), [], (None, None), [None, 73], {'CURRENT_TRANSACTION()': None}, 'NULL', b'NULL', 0])
def test_seed_c2_unknown_transaction_probe_shape_refused_without_ownership(row):
    connection = idle_probe_connection(row)
    with pytest.raises(seed_load_live.SeedLoadError, match='transaction state is unknown'):
        seed_load_live.load_seed(connection, artifact(), 'ROASTPILOT_DEV', NOW)
    assert_caller_transaction_untouched(connection)


def test_seed_c2_two_cell_transaction_probe_refused_without_ownership():
    connection = idle_probe_connection((None, 73))
    with pytest.raises(seed_load_live.SeedLoadError, match='transaction state is unknown'):
        seed_load_live.load_seed(connection, artifact(), 'ROASTPILOT_DEV', NOW)
    assert_caller_transaction_untouched(connection)


@pytest.mark.parametrize('failure_site', ['execute', 'fetchone'])
def test_seed_c2_failed_transaction_probe_refused_without_ownership(failure_site):
    connection = idle_probe_connection(error=RuntimeError('probe unavailable') if failure_site == 'fetchone' else None)
    if failure_site == 'execute':
        connection.fake_cursor.fail_on = lambda command: command == 'SELECT CURRENT_TRANSACTION()'
    with pytest.raises(seed_load_live.SeedLoadError, match='transaction state is unknown'):
        seed_load_live.load_seed(connection, artifact(), 'ROASTPILOT_DEV', NOW)
    assert_caller_transaction_untouched(connection)


@pytest.mark.parametrize('row', [(None,), [None]])
def test_seed_c2_idle_exact_single_cell_null_then_owns_transaction(row):
    connection = idle_probe_connection(row)
    seed_load_live.load_seed(connection, artifact(), 'ROASTPILOT_DEV', NOW)
    assert commands(connection)[:5] == ['SELECT CURRENT_TRANSACTION()', 'USE SECONDARY ROLES NONE', 'SELECT CURRENT_DATABASE()', 'BEGIN', 'CALL APP.cloud_sync_enter()']
    assert commands(connection)[-1] == 'COMMIT'
    assert 'ROLLBACK' not in commands(connection)
    assert connection.caller_work == ['uncommitted caller insert']


def test_seed_c2_begin_failure_does_not_claim_or_rollback_transaction():
    connection = FakeConnection(fail_on=lambda command: command == 'BEGIN')
    with pytest.raises(RuntimeError, match='scripted write failure'):
        seed_load_live.load_seed(connection, artifact(), 'ROASTPILOT_DEV', NOW)
    assert commands(connection) == ['SELECT CURRENT_TRANSACTION()', 'USE SECONDARY ROLES NONE', 'SELECT CURRENT_DATABASE()', 'BEGIN']
    assert 'COMMIT' not in commands(connection) and 'ROLLBACK' not in commands(connection)
    assert connection.closed is False


def test_seed_c2_factory_pins_existing_autocommit_default():
    import ast
    module = ast.parse(Path(seed_load_live.__file__).read_text())
    connect = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == '_connect')
    calls = [node for node in ast.walk(connect) if isinstance(node, ast.Call) and ast.unparse(node.func) == 'snowflake.connector.connect']
    assert len(calls) == 1
    flags = [keyword.value for keyword in calls[0].keywords if keyword.arg == 'autocommit']
    assert len(flags) == 1 and isinstance(flags[0], ast.Constant) and flags[0].value is True
