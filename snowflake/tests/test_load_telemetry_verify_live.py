"""Contract tests for the operator-run live telemetry verifier (issue #416)."""

from __future__ import annotations

import builtins
import json
import re
import sys
from decimal import Decimal
from pathlib import Path

import pytest
from snowflake.connector.errors import Error as SnowflakeError

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
SUMMARY_AFTER_LOAD = (1, 0, None, 24.0, None, 147.0, None, None, None, None)
SUMMARY_AFTER_OPT_IN = (1, 0, None, 24.0, None, 147.0, None, 25.0, 590.0, 1190.0)


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
        super().__init__(
            "SENTINEL-TELEMETRY-THROWING-DESCRIPTOR", send_telemetry=False
        )
        self._errno: object = None
        self._sqlstate: object = None
        self._throwing_attribute = throwing_attribute

    @property
    def errno(self) -> object:
        if self._throwing_attribute == "errno":
            raise KeyboardInterrupt("SENTINEL-TELEMETRY-ERRNO-DESCRIPTOR")
        return self._errno

    @errno.setter
    def errno(self, value: object) -> None:
        self._errno = value

    @property
    def sqlstate(self) -> object:
        if self._throwing_attribute == "sqlstate":
            raise SystemExit("SENTINEL-TELEMETRY-SQLSTATE-DESCRIPTOR")
        return self._sqlstate

    @sqlstate.setter
    def sqlstate(self, value: object) -> None:
        self._sqlstate = value


class SecretFormattingInt(int):
    def __str__(self) -> str:
        return "SENTINEL-TELEMETRY-INT-STR\nforged-int-line"

    def __format__(self, _format_spec: str) -> str:
        return "SENTINEL-TELEMETRY-INT-FORMAT\nforged-int-line"


class SecretFormattingStr(str):
    def __str__(self) -> str:
        return "SENTINEL-TELEMETRY-STR-STR\nforged-str-line"

    def __format__(self, _format_spec: str) -> str:
        return "SENTINEL-TELEMETRY-STR-FORMAT\nforged-str-line"


class RaisingClassPropertyError(Exception):
    @property
    def __class__(self) -> type:
        raise RuntimeError("SENTINEL-TELEMETRY-RAISING-CLASS")


class SpoofingClassPropertyError(Exception):
    def __init__(self) -> None:
        super().__init__("SENTINEL-TELEMETRY-SPOOFING-CLASS")
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






































def test_print_failure_emits_lowercase_connector_sqlstate(
    capsys: pytest.CaptureFixture[str],
) -> None:
    failure = load_telemetry_verify_live.TelemetryVerifyError("outer failure")
    failure.__cause__ = FakeProgrammingError(
        "SENTINEL-TELEMETRY-LOWERCASE", errno=None, sqlstate="42s02"
    )

    load_telemetry_verify_live._print_failure(failure)

    output = capsys.readouterr().err
    assert output == (
        "telemetry verification failed: outer failure\n"
        "root cause: FakeProgrammingError sqlstate=42s02\n"
    )
    assert "SENTINEL" not in output


def test_sanitised_cause_fails_safe_when_connector_import_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real_import = builtins.__import__

    def fail_connector_import(name: str, *args: object, **kwargs: object) -> object:
        if name == "snowflake.connector.errors":
            raise SystemExit("SENTINEL-TELEMETRY-CONNECTOR-IMPORT")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fail_connector_import)
    cause = FakeProgrammingError("SENTINEL-TELEMETRY-IMPORT-CAUSE")

    assert load_telemetry_verify_live._sanitised_cause(cause) == (
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
    failure = load_telemetry_verify_live.TelemetryVerifyError("outer failure")
    failure.__cause__ = cause_type("SENTINEL-TELEMETRY-TYPE-MESSAGE")

    load_telemetry_verify_live._print_failure(failure)

    output = capsys.readouterr().err
    assert output == (
        "telemetry verification failed: outer failure\n"
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
                raise SystemExit("SENTINEL-TELEMETRY-TYPE-NAME")
            return super().__getattribute__(attribute)

    cause_type = ThrowingNameMeta("InternalError", (Exception,), {})
    failure = load_telemetry_verify_live.TelemetryVerifyError("outer failure")
    failure.__cause__ = cause_type("SENTINEL-TELEMETRY-TYPE-MESSAGE")

    load_telemetry_verify_live._print_failure(failure)

    output = capsys.readouterr().err
    assert output == (
        "telemetry verification failed: outer failure\n"
        "root cause: UnknownError\n"
    )
    assert "SENTINEL" not in output
    assert "Traceback" not in output


def test_print_failure_uses_outer_fallback_when_summary_operation_raises(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    failure = load_telemetry_verify_live.TelemetryVerifyError("outer failure")
    failure.__cause__ = FakeProgrammingError("SENTINEL-TELEMETRY-OUTER-FALLBACK")

    def fail_fullmatch(_pattern: str, _value: str) -> None:
        raise SystemExit("SENTINEL-TELEMETRY-FULLMATCH")

    monkeypatch.setattr(load_telemetry_verify_live.re, "fullmatch", fail_fullmatch)
    load_telemetry_verify_live._print_failure(failure)

    output = capsys.readouterr().err
    assert output == (
        "telemetry verification failed: outer failure\n"
        "root cause: UnknownError\n"
    )
    assert "SENTINEL" not in output
    assert "Traceback" not in output






@pytest.mark.parametrize("throwing_attribute", ["errno", "sqlstate"])
def test_print_failure_omits_throwing_cause_attribute(
    capsys: pytest.CaptureFixture[str],
    throwing_attribute: str,
) -> None:
    failure = load_telemetry_verify_live.TelemetryVerifyError("outer failure")
    failure.__cause__ = ThrowingCauseAttributeError(throwing_attribute)

    load_telemetry_verify_live._print_failure(failure)

    output = capsys.readouterr().err
    assert output == (
        "telemetry verification failed: outer failure\n"
        "root cause: ThrowingCauseAttributeError\n"
    )
    assert "SENTINEL" not in output
    assert "Traceback" not in output

































































































































class _C2UntouchedArgument:
    def __init__(self):
        self.calls=[]
    def cursor(self):
        self.calls.append('cursor')
        return self


def test_lt_c2_verify_live_load_refuses_untouched_args():
    argument=_C2UntouchedArgument()
    with pytest.raises(load_telemetry_verify_live.TelemetryVerifyError,match='^superseded by the C9-C2 coordinated write protocol; C9-C4 owns live qualification$'):
        load_telemetry_verify_live.verify_live_load(argument, unexpected=argument)
    assert argument.calls == []


@pytest.mark.parametrize('argv',[None,[],['--target','ROASTPILOT_DEV']])
def test_lt_c2_main_refuses_exit_1_stderr_only(argv,capsys):
    assert load_telemetry_verify_live.main(argv)==1
    captured=capsys.readouterr()
    assert captured.out==''
    assert captured.err=='superseded by the C9-C2 coordinated write protocol; C9-C4 owns live qualification\n'


def test_lt_c2_imported_refusal_zero_connector(monkeypatch):
    import snowflake.connector
    import verify_seed_connection
    calls=[]
    def forbidden(*args,**kwargs):
        calls.append((args,kwargs))
        raise AssertionError('unexpected connector')
    monkeypatch.setattr(snowflake.connector,'connect',forbidden)
    monkeypatch.setattr(verify_seed_connection,'connect_seed',forbidden)
    with pytest.raises(load_telemetry_verify_live.TelemetryVerifyError):
        load_telemetry_verify_live.verify_live_load(_C2UntouchedArgument())
    assert calls==[]


def test_lt_c2_retired_names_absent():
    for name in ['REVOKED_AGENT_DML_PROBES', '_REVOKED_AGENT_DML_COLUMNS', '_connect', '_expect_sql_error', '_summary_row', 'connect_seed']:
        assert not hasattr(load_telemetry_verify_live,name)


def test_lt_c2_source_has_no_execution_surface():
    import ast
    tree=ast.parse(Path(load_telemetry_verify_live.__file__).read_text())
    forbidden={'execute','executemany','cursor','connect','connect_seed','fetchone','fetchall'}
    assert not [n for n in ast.walk(tree) if isinstance(n,ast.Call) and ((isinstance(n.func,ast.Attribute) and n.func.attr in forbidden) or (isinstance(n.func,ast.Name) and n.func.id in forbidden))]
    for name in ['verify_live_load', 'verify_agent_dml_revoked']:
        function=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name==name)
        operative=[n for n in function.body if not (isinstance(n,ast.Expr) and isinstance(n.value,ast.Constant) and isinstance(n.value.value,str))]
        assert len(operative)==1 and isinstance(operative[0],ast.Raise)
        assert not any(isinstance(n,ast.Name) and n.id in {'_args','_kwargs'} for n in ast.walk(operative[0]))


def test_lt_c2_dml_probe_refuses_untouched_cursor():
    argument=_C2UntouchedArgument()
    with pytest.raises(load_telemetry_verify_live.TelemetryVerifyError,match='superseded by the C9-C2'):
        load_telemetry_verify_live.verify_agent_dml_revoked(argument)
    assert argument.calls==[]
