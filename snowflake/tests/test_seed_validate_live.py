"""Contract tests for the operator-run read-only live seed validator."""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import seed_validate_live  # noqa: E402


WRITE_RE = re.compile(
    r"\b(?:INSERT|MERGE|DELETE|UPDATE|TRUNCATE|CREATE|ALTER|DROP|BEGIN|COMMIT|ROLLBACK|CALL)\b",
    re.IGNORECASE,
)
NOW = datetime(2026, 8, 25, 12, 0, 0, tzinfo=timezone.utc)
AGGREGATES = (192.0, 2.8284271247461903, 212.0, 2.8284271247461903)


def artifact(target: str = "ROASTPILOT_DEV") -> dict[str, object]:
    groups = [{"bean_origin": f"Origin {index}", "roast_level": "medium"}
              for index in range(12)]
    roasts: list[dict[str, object]] = []
    telemetry: list[dict[str, object]] = []
    for index, (fc_bean, fc_env, drop_bean) in enumerate(
        ((190.0, 150.0, 210.0), (194.0, 154.0, 214.0)), start=1
    ):
        roast_id = f"00000000-0000-0000-0000-{index:012d}"
        roasts.append({
            "id": roast_id, "bean_origin": "Origin 0", "roast_level": "medium",
            "contributed_to_learning": True,
            "summary": {
                "started_at_utc": "2026-08-24T10:00:00.000900Z",
                # DATEDIFF millisecond truncates these to offsets 10.001 / 20.001.
                "first_crack_at_utc": "2026-08-24T10:00:10.001900Z",
                "beans_dropped_at_utc": "2026-08-24T10:00:20.001900Z",
            },
        })
        telemetry.extend([
            {"roast_id": roast_id, "elapsed_s": 10.001,
             "bean_temp_c": fc_bean, "env_temp_c": fc_env},
            {"roast_id": roast_id, "elapsed_s": 20.001,
             "bean_temp_c": drop_bean, "env_temp_c": fc_env + 20.0},
        ])
    return {
        "target": target,
        "tables": [
            {"table": "cloud_roasts", "rows": roasts},
            {"table": "roast_telemetry", "rows": telemetry},
            {"table": "roast_artifacts", "rows": []},
            {"table": "tasting_reviews", "rows": []},
            {"table": "reference_roast_summaries", "rows": groups},
        ],
    }


class FakeCursor:
    def __init__(self, violation_count: object = 0, group_zero=AGGREGATES,
                 live_keys=None, database: object = "ROASTPILOT_DEV"):
        self.violation_count = violation_count
        self.group_zero = group_zero
        self.database = database
        self.live_keys = ([(f"Origin {index}", "medium") for index in range(12)]
                          if live_keys is None else live_keys)
        self.executed: list[tuple[str, tuple[object, ...] | None]] = []
        self._result: object = None

    def execute(self, command: str, params=None):
        normalized = tuple(params) if params is not None else None
        self.executed.append((command, normalized))
        if command == "SELECT CURRENT_DATABASE()":
            self._result = (self.database,)
        elif "data_quality_violations" in command:
            self._result = (self.violation_count,)
        elif command == "SELECT bean_origin, roast_level FROM APP.reference_roast_summaries":
            self._result = self.live_keys
        elif "reference_roast_summaries" in command:
            self._result = self.group_zero if normalized == ("Origin 0", "medium") else (None,) * 4
        return self

    def fetchone(self):
        return self._result

    def fetchall(self):
        return self._result


class FakeConnection:
    def __init__(self, cursor: FakeCursor):
        self.fake_cursor = cursor
        self.closed = False

    def cursor(self):
        return self.fake_cursor

    def close(self):
        self.closed = True


class MappingCursor(FakeCursor):
    def execute(self, command: str, params=None):
        super().execute(command, params)
        if command == "SELECT CURRENT_DATABASE()":
            self._result = {"CURRENT_DATABASE()": self.database}
        elif "data_quality_violations" in command:
            self._result = {"COUNT(*)": self.violation_count}
        elif command == "SELECT bean_origin, roast_level FROM APP.reference_roast_summaries":
            self._result = [{"BEAN_ORIGIN": origin, "ROAST_LEVEL": level}
                            for origin, level in self.live_keys]
        elif "reference_roast_summaries" in command:
            values = self.group_zero if params == ("Origin 0", "medium") else (None,) * 4
            self._result = dict(zip(seed_validate_live.AGGREGATE_COLUMNS, values))
        return self


def validate(cursor: FakeCursor, payload: object | None = None) -> dict[str, object]:
    return seed_validate_live.validate_live(
        cursor, artifact() if payload is None else payload, "ROASTPILOT_DEV", NOW)


def test_row_values_supports_case_insensitive_mappings_and_exact_sequences():
    assert seed_validate_live._row_values(
        {"BEAN_ORIGIN": "Kenya", "roast_LEVEL": "medium"},
        ("bean_origin", "ROAST_LEVEL"),
    ) == ("Kenya", "medium")
    assert seed_validate_live._row_values((1, 2), ("a", "b")) == (1, 2)


def test_row_values_rejects_incomplete_mapping_with_exact_error():
    with pytest.raises(seed_validate_live.SeedValidateError,
                       match="^live query returned an incomplete row$"):
        seed_validate_live._row_values({"ONLY": 1}, ("only", "missing"))


@pytest.mark.parametrize("row", [(1,), "ab", b"ab", object()])
def test_row_values_rejects_wrong_sequence_or_shape_with_exact_error(row: object):
    with pytest.raises(seed_validate_live.SeedValidateError,
                       match="^live query returned an unexpected row shape$"):
        seed_validate_live._row_values(row, ("a", "b"))


@pytest.mark.parametrize("value, expected", [(1, 1.0), (1.25, 1.25), (Decimal("2.5"), 2.5)])
def test_number_accepts_only_supported_finite_numbers(value: object, expected: float):
    assert seed_validate_live._number(value, "field") == expected


@pytest.mark.parametrize("value", [True, "1", None, float("inf"), float("-inf"), float("nan")])
def test_number_rejects_bool_non_numeric_and_non_finite_with_exact_error(value: object):
    with pytest.raises(seed_validate_live.SeedValidateError,
                       match="^field must be a finite number$"):
        seed_validate_live._number(value, "field")


def test_timestamp_parses_z_and_normalizes_offsets_to_utc():
    zulu = seed_validate_live._timestamp("2026-08-24T11:00:00Z", "stamp")
    offset = seed_validate_live._timestamp("2026-08-24T12:00:00+01:00", "stamp")
    assert zulu == datetime(2026, 8, 24, 11, tzinfo=timezone.utc)
    assert offset == datetime(2026, 8, 24, 11, tzinfo=timezone.utc)
    assert zulu.tzinfo is timezone.utc and offset.tzinfo is timezone.utc


@pytest.mark.parametrize("value", [None, 123, "not-a-time"])
def test_timestamp_rejects_non_string_or_invalid_with_exact_error(value: object):
    with pytest.raises(seed_validate_live.SeedValidateError,
                       match="^stamp must be an ISO timestamp$"):
        seed_validate_live._timestamp(value, "stamp")


def test_timestamp_rejects_naive_value_with_exact_error():
    with pytest.raises(seed_validate_live.SeedValidateError,
                       match="^stamp must include a timezone$"):
        seed_validate_live._timestamp("2026-08-24T11:00:00", "stamp")


def test_epoch_milliseconds_pins_day_second_and_submillisecond_flooring():
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    assert seed_validate_live._epoch_milliseconds(epoch) == 0
    assert seed_validate_live._epoch_milliseconds(
        epoch + timedelta(days=1, seconds=2, microseconds=345_999)) == 86_402_345
    assert seed_validate_live._epoch_milliseconds(
        epoch - timedelta(microseconds=1)) == -1


def test_offset_seconds_handles_null_and_uses_started_at_millisecond_boundaries():
    assert seed_validate_live._offset_seconds({}, "first_crack_at_utc") is None
    summary = {
        "started_at_utc": "2026-08-24T10:00:00.999900Z",
        "first_crack_at_utc": "2026-08-24T10:00:02.001100Z",
    }
    assert seed_validate_live._offset_seconds(summary, "first_crack_at_utc") == 1.002


def test_offset_seconds_preserves_exact_start_and_anchor_error_labels():
    with pytest.raises(seed_validate_live.SeedValidateError,
                       match="^summary.started_at_utc must be an ISO timestamp$"):
        seed_validate_live._offset_seconds(
            {"started_at_utc": "bad", "first_crack_at_utc": "2026-08-24T10:00:02Z"},
            "first_crack_at_utc")
    with pytest.raises(seed_validate_live.SeedValidateError,
                       match="^summary.first_crack_at_utc must be an ISO timestamp$"):
        seed_validate_live._offset_seconds(
            {"started_at_utc": "2026-08-24T10:00:00Z", "first_crack_at_utc": "bad"},
            "first_crack_at_utc")


def test_sample_short_circuits_null_offset_and_handles_no_candidates():
    assert seed_validate_live._sample("r1", [{"elapsed_s": "bad"}], None,
                                      "bean_temp_c") is None
    assert seed_validate_live._sample("r1", [{"roast_id": "other"}], 1.0,
                                      "bean_temp_c") is None


def test_sample_pins_distance_elapsed_and_bean_nulls_last_tie_breaks():
    rows = [
        {"roast_id": "r1", "elapsed_s": 11.0, "bean_temp_c": 300.0, "env_temp_c": 30.0},
        {"roast_id": "r1", "elapsed_s": 9.0, "bean_temp_c": None, "env_temp_c": 90.0},
        {"roast_id": "r1", "elapsed_s": 9.0, "bean_temp_c": 200.0, "env_temp_c": 20.0},
        {"roast_id": "r1", "elapsed_s": 9.0, "bean_temp_c": 190.0, "env_temp_c": 19.0},
    ]
    assert seed_validate_live._sample("r1", rows, 10.0, "env_temp_c") == 19.0
    rows[3]["env_temp_c"] = None
    assert seed_validate_live._sample("r1", rows, 10.0, "env_temp_c") is None


def test_sample_rejects_each_invalid_numeric_field_with_exact_label():
    with pytest.raises(seed_validate_live.SeedValidateError,
                       match="^roast_telemetry.elapsed_s must be a finite number$"):
        seed_validate_live._sample(
            "r1", [{"roast_id": "r1", "elapsed_s": "bad", "bean_temp_c": 1.0}],
            1.0, "bean_temp_c")
    with pytest.raises(seed_validate_live.SeedValidateError,
                       match="^roast_telemetry.bean_temp_c must be a finite number$"):
        seed_validate_live._sample(
            "r1", [{"roast_id": "r1", "elapsed_s": 1.0, "bean_temp_c": "bad"}],
            1.0, "bean_temp_c")
    with pytest.raises(seed_validate_live.SeedValidateError,
                       match="^roast_telemetry.env_temp_c must be a finite number$"):
        seed_validate_live._sample(
            "r1", [{"roast_id": "r1", "elapsed_s": 1.0,
                    "bean_temp_c": 1.0, "env_temp_c": "bad"}],
            1.0, "env_temp_c")


def test_sample_rank_key_ignores_unorderable_raw_row_payload():
    rows = [
        {"roast_id": "r1", "elapsed_s": 1.0, "bean_temp_c": 2.0, "env_temp_c": 20.0},
        {"roast_id": "r1", "elapsed_s": 1.0, "bean_temp_c": 2.0, "env_temp_c": 21.0},
    ]
    assert seed_validate_live._sample("r1", rows, 1.0, "env_temp_c") == 20.0


def test_derive_group_filters_exact_contributors_and_supports_swaps():
    payload = artifact()
    roasts = payload["tables"][0]["rows"]  # type: ignore[index]
    telemetry = payload["tables"][1]["rows"]  # type: ignore[index]
    roasts[1]["contributed_to_learning"] = 1
    assert seed_validate_live._derive_group(
        roasts, telemetry, "Origin 0", "medium") == (190.0, None, 210.0, None)
    assert seed_validate_live._derive_group(
        roasts, telemetry, "Origin 0", "medium", fc_column="env_temp_c")[:2] == (150.0, None)
    assert seed_validate_live._derive_group(
        roasts, telemetry, "Origin 0", "medium", fc_column="env_temp_c",
        drop_column="env_temp_c") == (150.0, None, 170.0, None)
    assert seed_validate_live._derive_group(
        roasts, telemetry, "Origin 0", "medium",
        fc_anchor="beans_dropped_at_utc")[:2] == (210.0, None)
    assert seed_validate_live._derive_group(
        roasts, telemetry, "other", "medium") == (None, None, None, None)

    roasts.insert(0, {"bean_origin": "other", "roast_level": "medium",
                      "contributed_to_learning": True})
    assert seed_validate_live._derive_group(
        roasts, telemetry, "Origin 0", "medium") == (190.0, None, 210.0, None)


def test_derive_group_rejects_non_mapping_summary():
    payload = artifact()
    payload["tables"][0]["rows"][0]["summary"] = []  # type: ignore[index]
    with pytest.raises(seed_validate_live.SeedValidateError,
                       match="^cloud_roasts.summary must be an object$"):
        seed_validate_live._derive_group(
            payload["tables"][0]["rows"], payload["tables"][1]["rows"],  # type: ignore[index]
            "Origin 0", "medium")


def test_matches_pins_null_and_tolerance_boundaries():
    assert seed_validate_live._matches(None, None)
    assert not seed_validate_live._matches(None, 0.0)
    assert not seed_validate_live._matches(0.0, None)
    assert seed_validate_live._matches(0.0, 1e-6)
    assert not seed_validate_live._matches(0.0, 1.000001e-6)
    assert not seed_validate_live._matches("bad", 0.0)


def test_required_env_accepts_nonempty_and_rejects_missing(monkeypatch):
    monkeypatch.setenv("SEED_VALIDATE_TEST_ENV", "value")
    assert seed_validate_live._required_env("SEED_VALIDATE_TEST_ENV") == "value"
    monkeypatch.delenv("SEED_VALIDATE_TEST_ENV")
    with pytest.raises(seed_validate_live.SeedValidateError,
                       match="^missing required environment variable: SEED_VALIDATE_TEST_ENV$"):
        seed_validate_live._required_env("SEED_VALIDATE_TEST_ENV")


def test_t13_zero_data_quality_violations_passes():
    assert validate(FakeCursor())["data_quality_violations"] == 0


def test_validate_live_accepts_connector_mapping_rows():
    assert validate(MappingCursor()) == {
        "target": "ROASTPILOT_DEV", "groups_validated": 12,
        "data_quality_violations": 0,
        "swap_discriminators": {"env_column": 2, "drop_offset": 1},
    }


def test_t13_positive_data_quality_count_fails():
    # M13: inverting/removing the exact-zero predicate makes this test fail.
    with pytest.raises(seed_validate_live.SeedValidateError, match="data-quality violations: 1"):
        validate(FakeCursor(violation_count=1))


@pytest.mark.parametrize("count", [True, 0.0, Decimal("0"), "0", None])
def test_t13_non_integer_data_quality_count_fails_with_exact_error(count: object):
    with pytest.raises(seed_validate_live.SeedValidateError,
                       match="^data-quality count must be an integer$"):
        validate(FakeCursor(violation_count=count))


def test_connected_database_mismatch_fails_with_exact_error():
    with pytest.raises(seed_validate_live.SeedValidateError,
                       match="^connected database does not match target$"):
        validate(FakeCursor(database="ROASTPILOT_PREVIEW"))


def test_t14_hand_computed_aggregates_match_within_tolerance():
    within_tolerance = tuple(value + 0.5e-6 for value in AGGREGATES)
    result = validate(FakeCursor(group_zero=within_tolerance))
    assert result["groups_validated"] == 12


def test_t14_aggregate_mismatch_fails_closed():
    # M14: dropping/short-circuiting the live comparison makes this test fail.
    wrong = (AGGREGATES[0] + 2e-6, *AGGREGATES[1:])
    with pytest.raises(seed_validate_live.SeedValidateError, match="first_crack_temp_avg_c mismatch"):
        validate(FakeCursor(group_zero=wrong))


def test_t16_stale_live_reference_group_fails_closed():
    # M16: dropping/short-circuiting the Counter equality makes this test fail.
    keys = [(f"Origin {index}", "medium") for index in range(12)]
    keys.append(("Stale Origin", "dark"))
    with pytest.raises(
        seed_validate_live.SeedValidateError,
        match="^live reference summary keys do not exactly match artifact groups$",
    ):
        validate(FakeCursor(live_keys=keys))


def test_t16_duplicate_live_reference_group_fails_closed():
    # M16: a set comparison would miss this duplicate; Counter equality rejects it.
    keys = [(f"Origin {index}", "medium") for index in range(12)]
    keys.append(("Origin 0", "medium"))
    with pytest.raises(seed_validate_live.SeedValidateError, match="keys do not exactly match"):
        validate(FakeCursor(live_keys=keys))


def test_t16_missing_live_reference_group_fails_closed():
    keys = [(f"Origin {index}", "medium") for index in range(11)]
    with pytest.raises(seed_validate_live.SeedValidateError, match="keys do not exactly match"):
        validate(FakeCursor(live_keys=keys))


def test_t15_env_and_drop_swaps_are_distinct_discriminators():
    # Correct FC values are 190/194, env-swap 150/154, drop-offset 210/214.
    # M15: fixing the source/anchor to either wrong input collapses these
    # discriminators (or mismatches live), so this paired assertion fails.
    result = validate(FakeCursor())
    assert result["swap_discriminators"] == {"env_column": 2, "drop_offset": 1}


def test_t15_numerically_coincident_swap_metric_is_skipped():
    # FC and drop sample stddevs are both sqrt(8), so drop stddev is not a
    # discriminator. The distinct drop mean still proves the anchor asymmetry.
    result = validate(FakeCursor())
    assert result["swap_discriminators"]["drop_offset"] == 1


def test_m17_drop_env_column_is_an_independent_discriminator():
    # M17: restricting env_column to FC-only metrics makes this test fail because
    # FC bean/env coincide and only the distinct DROP bean/env source proves it.
    payload = artifact()
    telemetry = payload["tables"][1]["rows"]  # type: ignore[index]
    telemetry[0]["env_temp_c"], telemetry[2]["env_temp_c"] = 190.0, 194.0
    result = validate(FakeCursor(), payload)
    assert result["swap_discriminators"] == {"env_column": 1, "drop_offset": 1}


def test_t15_counts_each_distinct_mean_and_stddev_discriminator():
    payload = artifact()
    telemetry = payload["tables"][1]["rows"]  # type: ignore[index]
    telemetry[0]["env_temp_c"], telemetry[2]["env_temp_c"] = 150.0, 160.0
    telemetry[1]["bean_temp_c"], telemetry[3]["bean_temp_c"] = 210.0, 220.0
    live = (192.0, 2.8284271247461903, 215.0, 7.0710678118654755)
    result = validate(FakeCursor(group_zero=live), payload)
    assert result["swap_discriminators"] == {"env_column": 4, "drop_offset": 2}


def test_t15_continues_past_coincident_mean_to_distinct_stddev():
    payload = artifact()
    telemetry = payload["tables"][1]["rows"]  # type: ignore[index]
    telemetry[0]["env_temp_c"], telemetry[2]["env_temp_c"] = 188.0, 196.0
    result = validate(FakeCursor(), payload)
    assert result["swap_discriminators"] == {"env_column": 2, "drop_offset": 1}


def test_t15_live_value_matching_distinct_swap_fails_with_exact_error():
    payload = artifact()
    telemetry = payload["tables"][1]["rows"]  # type: ignore[index]
    telemetry[0]["env_temp_c"] = 190.0000015
    telemetry[2]["env_temp_c"] = 194.0000015
    live = (192.00000075, AGGREGATES[1], AGGREGATES[2], AGGREGATES[3])
    with pytest.raises(seed_validate_live.SeedValidateError,
                       match="^Origin 0/medium env_column swap matched live$"):
        validate(FakeCursor(group_zero=live), payload)


def test_sample_stddev_is_null_for_one_value_and_null_matches_null():
    payload = artifact()
    payload["tables"][0]["rows"] = payload["tables"][0]["rows"][:1]  # type: ignore[index]
    payload["tables"][1]["rows"] = payload["tables"][1]["rows"][:2]  # type: ignore[index]
    live = (190.0, None, 210.0, None)
    assert validate(FakeCursor(group_zero=live), payload)["groups_validated"] == 12


def test_null_aggregates_match_for_groups_without_contributing_roasts():
    assert seed_validate_live._matches(None, None)
    assert not seed_validate_live._matches(None, 190.0)
    payload = artifact()
    for roast in payload["tables"][0]["rows"]:  # type: ignore[index]
        roast["contributed_to_learning"] = False
    # No swap can discriminate an all-NULL corpus, which must fail closed only
    # after all live NULL-to-NULL aggregate comparisons have succeeded.
    with pytest.raises(seed_validate_live.SeedValidateError,
                       match="^artifact provides no distinct swap discriminator$"):
        validate(FakeCursor(group_zero=(None,) * 4), payload)


def test_malformed_artifact_fails_before_any_statement():
    payload = artifact()
    del payload["tables"]
    cursor = FakeCursor()
    with pytest.raises(seed_validate_live.SeedValidateError, match="exactly the keys"):
        validate(cursor, payload)
    assert cursor.executed == []


def test_exactly_twelve_groups_are_required_before_any_statement():
    payload = artifact()
    payload["tables"][4]["rows"].pop()  # type: ignore[index]
    cursor = FakeCursor()
    with pytest.raises(seed_validate_live.SeedValidateError,
                       match="^artifact must contain exactly 12 reference groups$"):
        validate(cursor, payload)
    assert cursor.executed == []


def test_all_twelve_groups_are_queried_once():
    cursor = FakeCursor()
    validate(cursor)
    queries = [(command, params) for command, params in cursor.executed
               if "reference_roast_summaries" in command and params is not None]
    assert len(queries) == 12
    assert [params for _, params in queries] == [
        (f"Origin {index}", "medium") for index in range(12)
    ]


def test_secondary_roles_is_first_and_every_statement_is_read_only():
    cursor = FakeCursor()
    validate(cursor)
    commands = [command for command, _ in cursor.executed]
    assert commands[0] == "USE SECONDARY ROLES NONE"
    assert all(command == "USE SECONDARY ROLES NONE" or command.lstrip().upper().startswith("SELECT")
               for command in commands)
    assert not any(WRITE_RE.search(command) for command in commands)
    aggregate_select = (
        "SELECT first_crack_temp_avg_c, first_crack_temp_stddev_c, "
        "drop_temp_avg_c, drop_temp_stddev_c FROM APP.reference_roast_summaries "
        "WHERE bean_origin = %s AND roast_level = %s"
    )
    assert commands[:4] == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_DATABASE()",
        "SELECT count(*) FROM APP.data_quality_violations",
        "SELECT bean_origin, roast_level FROM APP.reference_roast_summaries",
    ]
    assert commands[4:] == [aggregate_select] * 12


@pytest.mark.parametrize("target", ["ROASTPILOT_PROD", "", "roastpilot_dev"])
def test_target_allowlist_rejected_before_connect(tmp_path: Path, target: str):
    path = tmp_path / "seed.json"
    path.write_text(json.dumps(artifact(target)), encoding="utf-8")
    calls: list[str] = []
    with pytest.raises(seed_validate_live.SeedValidateError, match="target"):
        seed_validate_live.run_operator_validation(path, target, calls.append, NOW)
    assert calls == []


def test_operator_wrapper_closes_connection(tmp_path: Path):
    path = tmp_path / "seed.json"
    path.write_text(json.dumps(artifact()), encoding="utf-8")
    connection = FakeConnection(FakeCursor())
    targets: list[str] = []
    result = seed_validate_live.run_operator_validation(
        path, "ROASTPILOT_DEV", lambda target: (targets.append(target), connection)[1], NOW)
    assert result == {
        "target": "ROASTPILOT_DEV", "groups_validated": 12,
        "data_quality_violations": 0,
        "swap_discriminators": {"env_column": 2, "drop_offset": 1},
    }
    assert targets == ["ROASTPILOT_DEV"]
    assert connection.closed is True


def test_operator_wrapper_rejects_artifact_before_connect(tmp_path: Path):
    payload = artifact()
    del payload["tables"]
    path = tmp_path / "seed.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    calls: list[str] = []
    with pytest.raises(seed_validate_live.SeedValidateError,
                       match="artifact must contain exactly the keys"):
        seed_validate_live.run_operator_validation(
            path, "ROASTPILOT_DEV", calls.append, NOW)
    assert calls == []


def test_operator_wrapper_closes_connection_when_validation_raises(tmp_path: Path):
    path = tmp_path / "seed.json"
    path.write_text(json.dumps(artifact()), encoding="utf-8")
    connection = FakeConnection(FakeCursor(violation_count=1))
    with pytest.raises(seed_validate_live.SeedValidateError, match="data-quality violations"):
        seed_validate_live.run_operator_validation(
            path, "ROASTPILOT_DEV", lambda _target: connection, NOW)
    assert connection.closed is True


def test_now_is_load_bearing_in_validator_and_operator_wrapper(tmp_path: Path):
    payload = artifact()
    roast_id = payload["tables"][0]["rows"][0]["id"]  # type: ignore[index]
    payload["tables"][3]["rows"] = [{  # type: ignore[index]
        "roast_id": roast_id, "submitted_ip_hash": "a" * 64,
        "created_at": "2026-08-24T12:00:00Z",
    }]
    assert validate(FakeCursor(), payload)["groups_validated"] == 12
    path = tmp_path / "seed.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    connection = FakeConnection(FakeCursor())
    assert seed_validate_live.run_operator_validation(
        path, "ROASTPILOT_DEV", lambda _target: connection, NOW)["groups_validated"] == 12


def test_cli_returns_nonzero_on_validation_failure(monkeypatch, tmp_path: Path):
    monkeypatch.setattr(seed_validate_live, "run_operator_validation",
                        lambda *_args: (_ for _ in ()).throw(RuntimeError("failure")))
    assert seed_validate_live.main(
        [str(tmp_path / "seed.json"), "--target", "ROASTPILOT_DEV"]) == 1
