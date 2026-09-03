"""Unit tests for the gated agent-verifier principal preflight (issue #433)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import assert_agent_ci_principal  # noqa: E402


EXPECTED_USER = "ROASTPILOT_AGENT_CI"
EXPECTED_ROLE = "ROASTPILOT_AGENT"


def test_sibling_loader_resolves_the_real_grant_guard() -> None:
    module = assert_agent_ci_principal._load_sibling_module("assert_dev_ci_grants")

    assert module.identifiers_match("ROASTPILOT_AGENT", EXPECTED_ROLE) is True
    assert module.require_env.__name__ == "require_env"


def test_sibling_loader_wraps_a_missing_file_as_import_error() -> None:
    with pytest.raises(ImportError, match="cannot load sibling module"):
        assert_agent_ci_principal._load_sibling_module("this_module_does_not_exist")


@pytest.mark.parametrize("missing_spec", [None, SimpleNamespace(loader=None)])
def test_sibling_loader_fails_closed_without_a_loader(
    monkeypatch: pytest.MonkeyPatch,
    missing_spec: object,
) -> None:
    monkeypatch.setattr(
        assert_agent_ci_principal.importlib.util,
        "spec_from_file_location",
        lambda *_args: missing_spec,
    )

    with pytest.raises(ImportError, match="cannot construct a loader"):
        assert_agent_ci_principal._load_sibling_module("assert_dev_ci_grants")


class FakeCursor:
    def __init__(
        self,
        *,
        current_user: str | None = EXPECTED_USER,
        include_current_user_column: bool = True,
        grant_rows: list[dict[str, object]] | None = None,
        user_rows: list[dict[str, object]] | None = None,
    ) -> None:
        self.current_user = current_user
        self.include_current_user_column = include_current_user_column
        self.grant_rows = (
            [{"role": "PUBLIC"}, {"role": EXPECTED_ROLE}]
            if grant_rows is None
            else grant_rows
        )
        self.user_rows = (
            [{"name": EXPECTED_USER, "default_secondary_roles": "[]"}]
            if user_rows is None
            else user_rows
        )
        self.executed: list[str] = []

    def execute(self, command: str):
        self.executed.append(command)
        return self

    def fetchone(self) -> dict[str, object] | None:
        assert self.executed[-1] == "SELECT CURRENT_USER()"
        if self.current_user is None:
            return None
        if self.include_current_user_column:
            return {"CURRENT_USER()": self.current_user}
        return {}

    def fetchall(self) -> list[dict[str, object]]:
        command = self.executed[-1]
        if command == f"SHOW GRANTS TO USER {EXPECTED_USER}":
            return self.grant_rows
        if command == f"SHOW USERS LIKE '{EXPECTED_USER}'":
            return self.user_rows
        raise AssertionError(f"unexpected fetchall after: {command}")


class FakeConnection:
    def __init__(self, cursor: FakeCursor | None = None) -> None:
        self.fake_cursor = cursor or FakeCursor()
        self.cursor_argument: object | None = None
        self.closed = False

    def cursor(self, cursor_class: object) -> FakeCursor:
        self.cursor_argument = cursor_class
        return self.fake_cursor

    def close(self) -> None:
        self.closed = True


def _set_required_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SNOWFLAKE_ACCOUNT", "ORG-ACCOUNT")
    monkeypatch.setenv("SNOWFLAKE_USER", EXPECTED_USER)
    monkeypatch.setenv("SNOWFLAKE_ROLE", EXPECTED_ROLE)
    monkeypatch.setenv("SNOWFLAKE_WAREHOUSE", "ROASTPILOT_WH")
    monkeypatch.setenv("SNOWFLAKE_DATABASE", "ROASTPILOT_DEV")
    monkeypatch.setenv("SNOWFLAKE_AGENT_PRIVATE_KEY", "test-private-key")
    monkeypatch.setenv("SNOWFLAKE_AGENT_PRIVATE_KEY_PASSPHRASE", "test-passphrase")


def _patch_boundaries(
    monkeypatch: pytest.MonkeyPatch, connection: FakeConnection
) -> tuple[list[tuple[str, str | None]], list[dict[str, object]]]:
    key_calls: list[tuple[str, str | None]] = []
    connect_calls: list[dict[str, object]] = []

    def fake_load_private_key(pem: str, passphrase: str | None) -> bytes:
        key_calls.append((pem, passphrase))
        return b"private-key-der"

    def fake_connect(**kwargs: object) -> FakeConnection:
        connect_calls.append(kwargs)
        return connection

    monkeypatch.setattr(
        assert_agent_ci_principal, "load_private_key_der", fake_load_private_key
    )
    monkeypatch.setattr(assert_agent_ci_principal, "_connect", fake_connect)
    return key_calls, connect_calls


def _run(
    monkeypatch: pytest.MonkeyPatch,
    cursor: FakeCursor | None = None,
) -> tuple[int, FakeConnection, list[tuple[str, str | None]], list[dict[str, object]]]:
    _set_required_env(monkeypatch)
    connection = FakeConnection(cursor)
    key_calls, connect_calls = _patch_boundaries(monkeypatch, connection)
    result = assert_agent_ci_principal.main(["--target", "ROASTPILOT_DEV"])
    return result, connection, key_calls, connect_calls


def test_happy_path_pins_connection_and_command_order(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    result, connection, key_calls, connect_calls = _run(monkeypatch)

    assert result == 0
    assert connection.fake_cursor.executed == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_USER()",
        f"SHOW GRANTS TO USER {EXPECTED_USER}",
        f"SHOW USERS LIKE '{EXPECTED_USER}'",
    ]
    assert connection.cursor_argument is assert_agent_ci_principal.snowflake.connector.DictCursor
    assert connection.closed is True
    assert key_calls == [("test-private-key", "test-passphrase")]
    assert connect_calls == [
        {
            "account": "ORG-ACCOUNT",
            "user": EXPECTED_USER,
            "role": EXPECTED_ROLE,
            "warehouse": "ROASTPILOT_WH",
            "database": "ROASTPILOT_DEV",
            "private_key": b"private-key-der",
        }
    ]
    captured = capsys.readouterr()
    assert captured.err == ""
    assert captured.out == (
        "verified ROASTPILOT_AGENT_CI has exactly one ROASTPILOT_AGENT role grant "
        "and empty DEFAULT_SECONDARY_ROLES in ROASTPILOT_DEV\n"
    )


def test_target_is_dev_only_and_rejected_before_any_statement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    connection = FakeConnection()
    key_calls, connect_calls = _patch_boundaries(monkeypatch, connection)

    with pytest.raises(SystemExit) as exc_info:
        assert_agent_ci_principal.main(["--target", "ROASTPILOT_PREVIEW"])

    assert exc_info.value.code == 2
    assert connection.fake_cursor.executed == []
    assert key_calls == []
    assert connect_calls == []


def test_target_option_is_required(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    connection = FakeConnection()
    key_calls, connect_calls = _patch_boundaries(monkeypatch, connection)

    with pytest.raises(SystemExit) as exc_info:
        assert_agent_ci_principal.main([])

    assert exc_info.value.code == 2
    assert connection.fake_cursor.executed == []
    assert key_calls == []
    assert connect_calls == []


def test_target_option_does_not_accept_abbreviations(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    connection = FakeConnection()
    key_calls, connect_calls = _patch_boundaries(monkeypatch, connection)

    with pytest.raises(SystemExit) as exc_info:
        assert_agent_ci_principal.main(["--targ", "ROASTPILOT_DEV"])

    assert exc_info.value.code == 2
    assert connection.fake_cursor.executed == []
    assert key_calls == []
    assert connect_calls == []


def test_help_uses_the_guard_module_description(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exc_info:
        assert_agent_ci_principal.main(["--help"])

    assert exc_info.value.code == 0
    assert "Fail-closed preflight for the gated ROASTPILOT_AGENT_CI live verifiers" in (
        capsys.readouterr().out
    )


def test_help_resolves_sibling_import_under_python_safe_path() -> None:
    snowflake_dir = Path(__file__).resolve().parent.parent

    result = subprocess.run(
        [sys.executable, "-P", "assert_agent_ci_principal.py", "--help"],
        cwd=snowflake_dir,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0
    assert result.stderr == ""
    assert "Fail-closed preflight for the gated ROASTPILOT_AGENT_CI" in result.stdout


def test_parser_configuration_pins_false_not_an_equivalent_falsey_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real_argument_parser = assert_agent_ci_principal.argparse.ArgumentParser
    constructor_calls: list[dict[str, object]] = []

    def recording_argument_parser(*args: object, **kwargs: object):
        constructor_calls.append(kwargs)
        return real_argument_parser(*args, **kwargs)

    monkeypatch.setattr(
        assert_agent_ci_principal,
        "argparse",
        SimpleNamespace(ArgumentParser=recording_argument_parser),
    )
    with pytest.raises(SystemExit) as exc_info:
        assert_agent_ci_principal.main(["--help"])

    assert exc_info.value.code == 0
    assert constructor_calls == [
        {"description": assert_agent_ci_principal.__doc__, "allow_abbrev": False}
    ]


def test_empty_grant_result_fails_non_vacuously(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    result, connection, _, _ = _run(monkeypatch, FakeCursor(grant_rows=[]))

    assert result == 1
    assert connection.closed is True
    assert capsys.readouterr().err == (
        "G5: expected exactly one 'ROASTPILOT_AGENT' role grant; found 0\n"
    )


@pytest.mark.parametrize("blank_row", [{"role": ""}, {}])
def test_blank_or_missing_role_row_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    blank_row: dict[str, object],
) -> None:
    result, _, _, _ = _run(monkeypatch, FakeCursor(grant_rows=[blank_row]))

    assert result == 1
    assert capsys.readouterr().err == (
        "G4: SHOW GRANTS TO USER returned a blank role; cannot verify the grant set\n"
        "G2: expected exactly one 'ROASTPILOT_AGENT' role grant; found 0\n"
    )


def test_blank_role_does_not_hide_a_later_extra_role(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    rows = [
        {"role": ""},
        {"role": EXPECTED_ROLE},
        {"role": "SYSADMIN"},
    ]
    result, _, _, _ = _run(monkeypatch, FakeCursor(grant_rows=rows))

    assert result == 1
    assert capsys.readouterr().err == (
        "G4: SHOW GRANTS TO USER returned a blank role; cannot verify the grant set\n"
        "G3: unexpected non-PUBLIC role 'SYSADMIN'; expected only 'ROASTPILOT_AGENT'\n"
    )


def test_extra_role_fails_and_names_the_role(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    rows = [{"role": EXPECTED_ROLE}, {"role": "SYSADMIN"}]
    result, _, _, _ = _run(monkeypatch, FakeCursor(grant_rows=rows))

    assert result == 1
    assert capsys.readouterr().err == (
        "G3: unexpected non-PUBLIC role 'SYSADMIN'; expected only 'ROASTPILOT_AGENT'\n"
    )


def test_missing_expected_role_fails_when_only_public_is_present(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    result, _, _, _ = _run(
        monkeypatch, FakeCursor(grant_rows=[{"role": "PUBLIC"}])
    )

    assert result == 1
    assert capsys.readouterr().err == (
        "G2: expected exactly one 'ROASTPILOT_AGENT' role grant; found 0\n"
    )


def test_duplicate_expected_role_fails(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    rows = [{"role": EXPECTED_ROLE}, {"role": EXPECTED_ROLE}]
    result, _, _, _ = _run(monkeypatch, FakeCursor(grant_rows=rows))

    assert result == 1
    assert capsys.readouterr().err == (
        "G2: expected exactly one 'ROASTPILOT_AGENT' role grant; found 2\n"
    )


def test_wrong_current_user_fails_before_show_grants(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    result, connection, _, _ = _run(
        monkeypatch, FakeCursor(current_user="ROASTPILOT_AGENT_CI_LOOKALIKE")
    )

    assert result == 1
    assert connection.fake_cursor.executed == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_USER()",
    ]
    assert connection.closed is True
    assert capsys.readouterr().err == (
        "G1: CURRENT_USER() is 'ROASTPILOT_AGENT_CI_LOOKALIKE'; "
        "expected 'ROASTPILOT_AGENT_CI'\n"
    )


def test_missing_current_user_column_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    cursor = FakeCursor(include_current_user_column=False)
    result, connection, _, _ = _run(monkeypatch, cursor)

    assert result == 1
    assert connection.fake_cursor.executed == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_USER()",
    ]
    assert connection.closed is True
    assert capsys.readouterr().err == (
        "G1: CURRENT_USER() is ''; expected 'ROASTPILOT_AGENT_CI'\n"
    )


def test_missing_current_user_row_fails_closed_without_traceback(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    cursor = FakeCursor(current_user=None)
    result, connection, _, _ = _run(monkeypatch, cursor)

    assert result == 1
    assert connection.fake_cursor.executed == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_USER()",
    ]
    assert connection.closed is True
    assert capsys.readouterr().err == (
        "G1: CURRENT_USER() is ''; expected 'ROASTPILOT_AGENT_CI'\n"
    )


def test_nonempty_default_secondary_roles_fails(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    cursor = FakeCursor(
        user_rows=[{"name": EXPECTED_USER, "default_secondary_roles": '["ALL"]'}]
    )
    result, _, _, _ = _run(monkeypatch, cursor)

    assert result == 1
    assert capsys.readouterr().err.startswith(
        "G6: ROASTPILOT_AGENT_CI's DEFAULT_SECONDARY_ROLES is '[\"ALL\"]'"
    )


def test_only_a_wildcard_lookalike_user_fails(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    cursor = FakeCursor(
        user_rows=[
            {"name": "ROASTPILOT0AGENT0CI", "default_secondary_roles": "[]"}
        ]
    )
    result, _, _, _ = _run(monkeypatch, cursor)

    assert result == 1
    stderr = capsys.readouterr().err
    assert stderr.startswith(
        "G6: SHOW USERS LIKE 'ROASTPILOT_AGENT_CI' returned 1 row(s), of which 0"
    )
    assert "wildcard-lookalike" in stderr


def test_env_user_drift_exits_before_key_load_or_connect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("SNOWFLAKE_USER", "WRONG_AGENT_CI")
    connection = FakeConnection()
    key_calls, connect_calls = _patch_boundaries(monkeypatch, connection)

    with pytest.raises(SystemExit) as exc_info:
        assert_agent_ci_principal.main(["--target", "ROASTPILOT_DEV"])

    assert str(exc_info.value) == (
        "error: SNOWFLAKE_USER is 'WRONG_AGENT_CI', expected 'ROASTPILOT_AGENT_CI' "
        "-- refusing to audit a repointed agent verifier principal"
    )
    assert key_calls == []
    assert connect_calls == []
    assert connection.fake_cursor.executed == []


@pytest.mark.parametrize(
    ("variable", "value", "expected"),
    [
        ("SNOWFLAKE_ROLE", "WRONG_ROLE", "ROASTPILOT_AGENT"),
        ("SNOWFLAKE_WAREHOUSE", "WRONG_WH", "ROASTPILOT_WH"),
        ("SNOWFLAKE_DATABASE", "ROASTPILOT_PREVIEW", "ROASTPILOT_DEV"),
    ],
)
def test_each_connection_boundary_is_drift_anchored(
    monkeypatch: pytest.MonkeyPatch,
    variable: str,
    value: str,
    expected: str,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv(variable, value)
    connection = FakeConnection()
    key_calls, connect_calls = _patch_boundaries(monkeypatch, connection)

    with pytest.raises(SystemExit) as exc_info:
        assert_agent_ci_principal.main(["--target", "ROASTPILOT_DEV"])

    assert str(exc_info.value).startswith(
        f"error: {variable} is {value!r}, expected {expected!r} -- refusing"
    )
    assert key_calls == []
    assert connect_calls == []


def test_target_drift_anchor_has_a_stable_diagnostic(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setattr(
        assert_agent_ci_principal,
        "ALLOWED_TARGETS",
        frozenset({"ROASTPILOT_DEV", "ROASTPILOT_PREVIEW"}),
    )
    connection = FakeConnection()
    key_calls, connect_calls = _patch_boundaries(monkeypatch, connection)

    with pytest.raises(SystemExit) as exc_info:
        assert_agent_ci_principal.main(["--target", "ROASTPILOT_PREVIEW"])

    assert str(exc_info.value) == (
        "error: --target is 'ROASTPILOT_PREVIEW', expected 'ROASTPILOT_DEV' -- "
        "refusing to audit a repointed agent verifier principal"
    )
    assert key_calls == []
    assert connect_calls == []


def test_unsafe_user_identifier_is_refused_before_connect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    unsafe_user = "ROASTPILOT_AGENT_CI; DROP"
    _set_required_env(monkeypatch)
    monkeypatch.setenv("SNOWFLAKE_USER", unsafe_user)
    # The drift anchor deliberately runs first. Pin the expected value here
    # so this test independently proves the subsequent SQL-grammar guard.
    monkeypatch.setattr(assert_agent_ci_principal, "_EXPECTED_USER", unsafe_user)
    connection = FakeConnection()
    key_calls, connect_calls = _patch_boundaries(monkeypatch, connection)

    with pytest.raises(SystemExit) as exc_info:
        assert_agent_ci_principal.main(["--target", "ROASTPILOT_DEV"])

    assert str(exc_info.value).startswith(
        "error: SNOWFLAKE_USER is 'ROASTPILOT_AGENT_CI; DROP', which is not a bare "
    )
    assert key_calls == []
    assert connect_calls == []
    assert connection.fake_cursor.executed == []
