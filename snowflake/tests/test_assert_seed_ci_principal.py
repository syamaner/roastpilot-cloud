"""Unit tests for the gated seed-verifier principal preflight."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import assert_seed_ci_principal  # noqa: E402


EXPECTED_USER = "ROASTPILOT_SEED_CI"
EXPECTED_ROLE = "ROASTPILOT_VERIFY_SEED"


def _role_grant_row(
    privilege: str,
    granted_on: str,
    name: str,
    *,
    grantee_name: str = EXPECTED_ROLE,
    grant_option: object = False,
) -> dict[str, object]:
    return {
        "privilege": privilege,
        "granted_on": granted_on,
        "name": name,
        "granted_to": "ROLE",
        "grantee_name": grantee_name,
        "grant_option": grant_option,
    }


def _expected_seed_role_rows() -> list[dict[str, object]]:
    return [
        _role_grant_row(privilege, granted_on, name)
        for privilege, granted_on, name, _ in sorted(
            assert_seed_ci_principal._EXPECTED_SEED_ROLE_GRANTS
        )
    ]


def test_expected_seed_role_manifest_is_pinned_per_privilege() -> None:
    assert assert_seed_ci_principal._EXPECTED_SEED_ROLE_GRANTS == frozenset(
        {
            ("USAGE", "DATABASE", "ROASTPILOT_DEV", EXPECTED_ROLE),
            ("USAGE", "SCHEMA", "ROASTPILOT_DEV.APP", EXPECTED_ROLE),
            ("USAGE", "WAREHOUSE", "ROASTPILOT_WH", EXPECTED_ROLE),
            (
                "INSERT",
                "TABLE",
                "ROASTPILOT_DEV.APP.CLOUD_ROASTS",
                EXPECTED_ROLE,
            ),
            (
                "UPDATE",
                "TABLE",
                "ROASTPILOT_DEV.APP.CLOUD_ROASTS",
                EXPECTED_ROLE,
            ),
            (
                "DELETE",
                "TABLE",
                "ROASTPILOT_DEV.APP.CLOUD_ROASTS",
                EXPECTED_ROLE,
            ),
            (
                "INSERT",
                "TABLE",
                "ROASTPILOT_DEV.APP.ROAST_TELEMETRY",
                EXPECTED_ROLE,
            ),
            (
                "DELETE",
                "TABLE",
                "ROASTPILOT_DEV.APP.ROAST_TELEMETRY",
                EXPECTED_ROLE,
            ),
            (
                "DELETE",
                "TABLE",
                "ROASTPILOT_DEV.APP.ROAST_ARTIFACTS",
                EXPECTED_ROLE,
            ),
            (
                "DELETE",
                "TABLE",
                "ROASTPILOT_DEV.APP.REFERENCE_ROAST_SUMMARIES",
                EXPECTED_ROLE,
            ),
        }
    )


def test_sibling_loader_resolves_the_real_grant_guard() -> None:
    module = assert_seed_ci_principal._load_sibling_module("assert_dev_ci_grants")

    assert module.identifiers_match(EXPECTED_ROLE, EXPECTED_ROLE) is True
    assert module.require_env.__name__ == "require_env"


def test_sibling_loader_wraps_a_missing_file_as_import_error() -> None:
    with pytest.raises(ImportError, match="cannot load sibling module"):
        assert_seed_ci_principal._load_sibling_module("this_module_does_not_exist")


@pytest.mark.parametrize("missing_spec", [None, SimpleNamespace(loader=None)])
def test_sibling_loader_fails_closed_without_a_loader(
    monkeypatch: pytest.MonkeyPatch,
    missing_spec: object,
) -> None:
    monkeypatch.setattr(
        assert_seed_ci_principal.importlib.util,
        "spec_from_file_location",
        lambda *_args: missing_spec,
    )

    with pytest.raises(ImportError, match="cannot construct a loader"):
        assert_seed_ci_principal._load_sibling_module("assert_dev_ci_grants")


class FakeCursor:
    def __init__(
        self,
        *,
        current_user: str | None = EXPECTED_USER,
        include_current_user_column: bool = True,
        grant_rows: list[dict[str, object]] | None = None,
        user_rows: list[dict[str, object]] | None = None,
        role_grant_rows: list[dict[str, object]] | None = None,
        future_grant_rows: list[dict[str, object]] | None = None,
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
        self.role_grant_rows = (
            _expected_seed_role_rows()
            if role_grant_rows is None
            else role_grant_rows
        )
        self.future_grant_rows = [] if future_grant_rows is None else future_grant_rows
        self.executed: list[str] = []

    def execute(self, command: str) -> FakeCursor:
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
        if command == f"SHOW GRANTS TO ROLE {EXPECTED_ROLE}":
            return self.role_grant_rows
        if command == f"SHOW FUTURE GRANTS TO ROLE {EXPECTED_ROLE}":
            return self.future_grant_rows
        raise AssertionError(f"unexpected fetchall after: {command}")


class FakeConnection:
    def __init__(
        self, cursor: FakeCursor | None = None, *, close_error: Exception | None = None
    ) -> None:
        self.fake_cursor = cursor or FakeCursor()
        self.cursor_argument: object | None = None
        self.closed = False
        self.close_error = close_error

    def cursor(self, cursor_class: object) -> FakeCursor:
        self.cursor_argument = cursor_class
        return self.fake_cursor

    def close(self) -> None:
        self.closed = True
        if self.close_error is not None:
            raise self.close_error


def _set_required_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("SNOWFLAKE_ACCOUNT", "ORG-ACCOUNT")
    monkeypatch.setenv("SNOWFLAKE_USER", EXPECTED_USER)
    monkeypatch.setenv("SNOWFLAKE_ROLE", EXPECTED_ROLE)
    monkeypatch.setenv("SNOWFLAKE_WAREHOUSE", "ROASTPILOT_WH")
    monkeypatch.setenv("SNOWFLAKE_DATABASE", "ROASTPILOT_DEV")
    monkeypatch.setenv("SNOWFLAKE_SEED_PRIVATE_KEY", "test-private-key")
    monkeypatch.setenv("SNOWFLAKE_SEED_PRIVATE_KEY_PASSPHRASE", "test-passphrase")


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
        assert_seed_ci_principal, "load_private_key_der", fake_load_private_key
    )
    monkeypatch.setattr(assert_seed_ci_principal, "_connect", fake_connect)
    return key_calls, connect_calls


def _run(
    monkeypatch: pytest.MonkeyPatch,
    cursor: FakeCursor | None = None,
) -> tuple[int, FakeConnection, list[tuple[str, str | None]], list[dict[str, object]]]:
    _set_required_env(monkeypatch)
    connection = FakeConnection(cursor)
    key_calls, connect_calls = _patch_boundaries(monkeypatch, connection)
    result = assert_seed_ci_principal.main(["--target", "ROASTPILOT_DEV"])
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
        f"SHOW GRANTS TO ROLE {EXPECTED_ROLE}",
        f"SHOW FUTURE GRANTS TO ROLE {EXPECTED_ROLE}",
    ]
    assert connection.cursor_argument is assert_seed_ci_principal.snowflake.connector.DictCursor
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
        "verified ROASTPILOT_SEED_CI has exactly one ROASTPILOT_VERIFY_SEED role "
        "grant, empty DEFAULT_SECONDARY_ROLES, and the exact minimal role "
        "manifest with zero future grants in ROASTPILOT_DEV\n"
    )


@pytest.mark.parametrize("failing_boundary", ["key_parse", "connect"])
def test_pre_connection_failure_is_static_and_sanitised(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    failing_boundary: str,
) -> None:
    _set_required_env(monkeypatch)
    raw_error = "secret.example ORG-ACCOUNT private-key /keys/seed.pem"

    def fake_load_private_key(_pem: str, _passphrase: str | None) -> bytes:
        if failing_boundary == "key_parse":
            raise RuntimeError(raw_error)
        return b"private-key-der"

    def fake_connect(**_kwargs: object) -> FakeConnection:
        if failing_boundary == "connect":
            raise RuntimeError(raw_error)
        pytest.fail("connect must not run after key parsing fails")

    monkeypatch.setattr(
        assert_seed_ci_principal, "load_private_key_der", fake_load_private_key
    )
    monkeypatch.setattr(assert_seed_ci_principal, "_connect", fake_connect)

    result = assert_seed_ci_principal.main(["--target", "ROASTPILOT_DEV"])

    assert result == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == (
        "error: Snowflake principal audit connection or query failed\n"
    )
    assert "secret.example" not in captured.err
    assert "private-key" not in captured.err
    assert "ORG-ACCOUNT" not in captured.err
    assert "Traceback" not in captured.err


def test_query_failure_is_static_sanitised_and_closes_connection(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _set_required_env(monkeypatch)
    raw_error = "query failed at secret.example for ORG-ACCOUNT using private-key"
    cursor = FakeCursor()
    original_execute = cursor.execute

    def failing_execute(command: str) -> FakeCursor:
        result = original_execute(command)
        if command == f"SHOW GRANTS TO USER {EXPECTED_USER}":
            raise RuntimeError(raw_error)
        return result

    monkeypatch.setattr(cursor, "execute", failing_execute)
    connection = FakeConnection(
        cursor,
        close_error=RuntimeError("close leaked /keys/seed.pem"),
    )
    _patch_boundaries(monkeypatch, connection)

    result = assert_seed_ci_principal.main(["--target", "ROASTPILOT_DEV"])

    assert result == 1
    assert connection.closed is True
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == (
        "error: Snowflake principal audit connection or query failed\n"
    )
    assert "secret.example" not in captured.err
    assert "private-key" not in captured.err
    assert "ORG-ACCOUNT" not in captured.err
    assert "/keys/seed.pem" not in captured.err
    assert "Traceback" not in captured.err


def test_seed_role_manifest_rejects_an_extra_grant() -> None:
    rows = _expected_seed_role_rows()
    rows.append(
        _role_grant_row(
            "SELECT", "TABLE", "ROASTPILOT_DEV.APP.CLOUD_ROASTS"
        )
    )

    violations = assert_seed_ci_principal.find_seed_role_manifest_violations(rows)

    assert violations == [
        "G7: extra seed-role grant: SELECT on TABLE "
        "ROASTPILOT_DEV.APP.CLOUD_ROASTS to ROASTPILOT_VERIFY_SEED "
        "(grant_option=False)"
    ]


def test_seed_role_manifest_rejects_a_missing_grant() -> None:
    rows = [
        row
        for row in _expected_seed_role_rows()
        if not (
            row["privilege"] == "UPDATE"
            and row["name"] == "ROASTPILOT_DEV.APP.CLOUD_ROASTS"
        )
    ]

    violations = assert_seed_ci_principal.find_seed_role_manifest_violations(rows)

    assert violations == [
        "G7: missing seed-role grant: UPDATE on TABLE "
        "ROASTPILOT_DEV.APP.CLOUD_ROASTS to ROASTPILOT_VERIFY_SEED"
    ]


@pytest.mark.parametrize(
    "role_row",
    [
        _role_grant_row("USAGE", "ROLE", "SYSADMIN"),
        _role_grant_row("OWNERSHIP", "ROLE", EXPECTED_ROLE),
        _role_grant_row(
            "USAGE", "ROLE", EXPECTED_ROLE, grantee_name="SYSADMIN"
        ),
        _role_grant_row(
            "USAGE", "ROLE", EXPECTED_ROLE, grant_option=True
        ),
    ],
)
def test_seed_role_manifest_rejects_role_inheritance(
    role_row: dict[str, object],
) -> None:
    rows = [role_row, *_expected_seed_role_rows()]

    violations = assert_seed_ci_principal.find_seed_role_manifest_violations(rows)

    assert len(violations) == 1
    assert violations[0].startswith("G8: unexpected role inheritance edge:")


def test_seed_role_manifest_accepts_only_its_inert_self_role_row() -> None:
    rows = _expected_seed_role_rows()
    rows.append(_role_grant_row("USAGE", "ROLE", EXPECTED_ROLE))

    assert assert_seed_ci_principal.find_seed_role_manifest_violations(rows) == []


def test_seed_role_manifest_rejects_grant_option_true() -> None:
    rows = _expected_seed_role_rows()
    rows[0] = {**rows[0], "grant_option": True}

    violations = assert_seed_ci_principal.find_seed_role_manifest_violations(rows)

    assert any("extra seed-role grant:" in violation for violation in violations)
    assert any("missing seed-role grant:" in violation for violation in violations)
    assert all("grant_option=True" in violation for violation in violations[:1])


def test_seed_role_manifest_rejects_an_absent_grant_option() -> None:
    rows = _expected_seed_role_rows()
    rows[0].pop("grant_option")

    violations = assert_seed_ci_principal.find_seed_role_manifest_violations(rows)

    assert any("grant_option=<absent>" in violation for violation in violations)
    assert any("missing seed-role grant:" in violation for violation in violations)


@pytest.mark.parametrize(
    "malformed_row",
    [
        {},
        _role_grant_row("", "TABLE", "ROASTPILOT_DEV.APP.CLOUD_ROASTS"),
        _role_grant_row("INSERT", "", "ROASTPILOT_DEV.APP.CLOUD_ROASTS"),
        _role_grant_row("INSERT", "TABLE", ""),
        _role_grant_row("INSERT", "TABLE", "ROASTPILOT_DEV.APP.CLOUD_ROASTS", grantee_name=""),
    ],
)
def test_seed_role_manifest_rejects_blank_or_malformed_rows(
    malformed_row: dict[str, object],
) -> None:
    rows = [malformed_row, *_expected_seed_role_rows()]

    violations = assert_seed_ci_principal.find_seed_role_manifest_violations(rows)

    assert violations == [
        "G7: SHOW GRANTS TO ROLE returned a blank or malformed grant row"
    ]


def test_seed_role_manifest_requires_role_grantee_shape() -> None:
    rows = [
        {
            **_role_grant_row("SELECT", "TABLE", "ROASTPILOT_DEV.APP.CLOUD_ROASTS"),
            "granted_to": "USER",
        },
        *_expected_seed_role_rows(),
    ]

    violations = assert_seed_ci_principal.find_seed_role_manifest_violations(rows)

    assert violations == [
        "G7: unexpected grantee type 'USER' for SELECT on TABLE "
        "ROASTPILOT_DEV.APP.CLOUD_ROASTS"
    ]


def test_seed_role_manifest_normalizes_only_fixed_vocabulary() -> None:
    rows = _expected_seed_role_rows()
    rows[0] = {
        **rows[0],
        "privilege": f"  {str(rows[0]['privilege']).lower()}  ",
        "granted_on": f"  {str(rows[0]['granted_on']).lower()}  ",
        "granted_to": "  role  ",
        "grant_option": "FALSE",
    }

    assert assert_seed_ci_principal.find_seed_role_manifest_violations(rows) == []


def test_seed_role_manifest_uses_byte_exact_object_and_grantee_names() -> None:
    rows = _expected_seed_role_rows()
    rows[0] = {**rows[0], "name": f"{rows[0]['name']} "}
    rows[1] = {**rows[1], "grantee_name": EXPECTED_ROLE.lower()}

    violations = assert_seed_ci_principal.find_seed_role_manifest_violations(rows)

    assert sum("extra seed-role grant:" in item for item in violations) == 2
    assert sum("missing seed-role grant:" in item for item in violations) == 2


def test_seed_role_manifest_rejects_duplicate_expected_row() -> None:
    rows = _expected_seed_role_rows()
    rows.append(dict(rows[0]))

    violations = assert_seed_ci_principal.find_seed_role_manifest_violations(rows)

    assert violations == [
        f"G7: duplicate seed-role grant: {rows[0]['privilege']} on "
        f"{rows[0]['granted_on']} {rows[0]['name']} to {EXPECTED_ROLE}"
    ]


def test_seed_role_manifest_violation_is_reported_by_main(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    role_rows = _expected_seed_role_rows()
    role_rows.append(_role_grant_row("SELECT", "TABLE", "ROASTPILOT_DEV.APP.CLOUD_ROASTS"))

    result, connection, _, _ = _run(
        monkeypatch, FakeCursor(role_grant_rows=role_rows)
    )

    assert result == 1
    assert connection.closed is True
    assert capsys.readouterr().err == (
        "G7: extra seed-role grant: SELECT on TABLE "
        "ROASTPILOT_DEV.APP.CLOUD_ROASTS to ROASTPILOT_VERIFY_SEED "
        "(grant_option=False)\n"
    )


def test_seed_role_future_grants_accepts_an_empty_result() -> None:
    assert assert_seed_ci_principal.find_seed_role_future_grant_violations([]) == []


def test_seed_role_future_grants_rejects_every_returned_row() -> None:
    rows = [
        {
            "privilege": "SELECT",
            "grant_on": "TABLE",
            "name": "ROASTPILOT_DEV.APP",
        }
    ]

    violations = assert_seed_ci_principal.find_seed_role_future_grant_violations(rows)

    assert violations == [
        "G9: forbidden seed-role future grant: SELECT on future TABLE in "
        "ROASTPILOT_DEV.APP"
    ]


@pytest.mark.parametrize(
    "malformed_row",
    [
        {},
        {"privilege": "", "grant_on": "TABLE", "name": "ROASTPILOT_DEV.APP"},
        {"privilege": "SELECT", "grant_on": "", "name": "ROASTPILOT_DEV.APP"},
        {"privilege": "SELECT", "grant_on": "TABLE", "name": ""},
    ],
)
def test_seed_role_future_grants_rejects_blank_or_malformed_rows(
    malformed_row: dict[str, object],
) -> None:
    violations = assert_seed_ci_principal.find_seed_role_future_grant_violations(
        [malformed_row]
    )

    assert violations == [
        "G9: SHOW FUTURE GRANTS TO ROLE returned a blank or malformed grant row"
    ]


def test_seed_role_future_grant_violation_is_reported_by_main(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    future_rows = [
        {
            "privilege": "INSERT",
            "grant_on": "TABLE",
            "name": "ROASTPILOT_DEV.APP",
        }
    ]

    result, connection, _, _ = _run(
        monkeypatch, FakeCursor(future_grant_rows=future_rows)
    )

    assert result == 1
    assert connection.closed is True
    assert capsys.readouterr().err == (
        "G9: forbidden seed-role future grant: INSERT on future TABLE in "
        "ROASTPILOT_DEV.APP\n"
    )


def test_close_failure_does_not_replace_audit_evidence_or_leak(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _set_required_env(monkeypatch)
    cursor = FakeCursor(current_user="WRONG_USER")
    connection = FakeConnection(
        cursor, close_error=RuntimeError("close leaked host secret.example")
    )
    _patch_boundaries(monkeypatch, connection)

    result = assert_seed_ci_principal.main(["--target", "ROASTPILOT_DEV"])

    assert result == 1
    assert connection.closed is True
    captured = capsys.readouterr()
    assert captured.err == (
        "G1: CURRENT_USER() is 'WRONG_USER'; expected 'ROASTPILOT_SEED_CI'\n"
    )
    assert "secret.example" not in captured.err


def test_close_failure_after_passing_audit_fails_without_leaking_diagnostics(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    _set_required_env(monkeypatch)
    raw_error = "raw connector failure at secret.example using /keys/seed.pem"
    connection = FakeConnection(close_error=RuntimeError(raw_error))
    _patch_boundaries(monkeypatch, connection)

    result = assert_seed_ci_principal.main(["--target", "ROASTPILOT_DEV"])

    assert result == 1
    assert connection.closed is True
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == "error: Snowflake principal audit connection close failed\n"
    assert "verified" not in captured.out
    assert raw_error not in captured.err
    assert "secret.example" not in captured.err
    assert "/keys/seed.pem" not in captured.err


def test_unset_passphrase_is_forwarded_as_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.delenv("SNOWFLAKE_SEED_PRIVATE_KEY_PASSPHRASE")
    connection = FakeConnection()
    key_calls, _ = _patch_boundaries(monkeypatch, connection)

    assert assert_seed_ci_principal.main(["--target", "ROASTPILOT_DEV"]) == 0
    assert key_calls == [("test-private-key", None)]


def test_target_is_dev_only_and_rejected_before_any_statement(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    connection = FakeConnection()
    key_calls, connect_calls = _patch_boundaries(monkeypatch, connection)

    with pytest.raises(SystemExit) as exc_info:
        assert_seed_ci_principal.main(["--target", "ROASTPILOT_PREVIEW"])

    assert exc_info.value.code == 2
    assert connection.fake_cursor.executed == []
    assert key_calls == []
    assert connect_calls == []


@pytest.mark.parametrize("argv", [[], ["--targ", "ROASTPILOT_DEV"]])
def test_target_is_required_and_does_not_accept_abbreviations(
    monkeypatch: pytest.MonkeyPatch,
    argv: list[str],
) -> None:
    _set_required_env(monkeypatch)
    connection = FakeConnection()
    key_calls, connect_calls = _patch_boundaries(monkeypatch, connection)

    with pytest.raises(SystemExit) as exc_info:
        assert_seed_ci_principal.main(argv)

    assert exc_info.value.code == 2
    assert connection.fake_cursor.executed == []
    assert key_calls == []
    assert connect_calls == []


def test_help_uses_the_guard_module_description(
    capsys: pytest.CaptureFixture[str],
) -> None:
    with pytest.raises(SystemExit) as exc_info:
        assert_seed_ci_principal.main(["--help"])

    assert exc_info.value.code == 0
    assert "Fail-closed preflight for the gated ROASTPILOT_SEED_CI live verifiers" in (
        capsys.readouterr().out
    )


def test_help_resolves_sibling_import_under_python_safe_path() -> None:
    snowflake_dir = Path(__file__).resolve().parent.parent

    result = subprocess.run(
        [sys.executable, "-P", "assert_seed_ci_principal.py", "--help"],
        cwd=snowflake_dir,
        capture_output=True,
        text=True,
        check=False,
    )

    assert result.returncode == 0
    assert result.stderr == ""
    assert "Fail-closed preflight for the gated ROASTPILOT_SEED_CI" in result.stdout


def test_parser_configuration_pins_false_not_an_equivalent_falsey_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    real_argument_parser = assert_seed_ci_principal.argparse.ArgumentParser
    constructor_calls: list[dict[str, object]] = []

    def recording_argument_parser(*args: object, **kwargs: object):
        constructor_calls.append(kwargs)
        return real_argument_parser(*args, **kwargs)

    monkeypatch.setattr(
        assert_seed_ci_principal,
        "argparse",
        SimpleNamespace(ArgumentParser=recording_argument_parser),
    )
    with pytest.raises(SystemExit) as exc_info:
        assert_seed_ci_principal.main(["--help"])

    assert exc_info.value.code == 0
    assert constructor_calls == [
        {"description": assert_seed_ci_principal.__doc__, "allow_abbrev": False}
    ]


def test_empty_grant_result_fails_non_vacuously(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    result, connection, _, _ = _run(monkeypatch, FakeCursor(grant_rows=[]))

    assert result == 1
    assert connection.closed is True
    assert capsys.readouterr().err == (
        "G5: expected exactly one 'ROASTPILOT_VERIFY_SEED' role grant; found 0\n"
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
        "G2: expected exactly one 'ROASTPILOT_VERIFY_SEED' role grant; found 0\n"
    )


def test_blank_role_does_not_hide_a_later_extra_role(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    rows = [{"role": ""}, {"role": EXPECTED_ROLE}, {"role": "SYSADMIN"}]
    result, _, _, _ = _run(monkeypatch, FakeCursor(grant_rows=rows))

    assert result == 1
    assert capsys.readouterr().err == (
        "G4: SHOW GRANTS TO USER returned a blank role; cannot verify the grant set\n"
        "G3: unexpected non-PUBLIC role 'SYSADMIN'; expected only "
        "'ROASTPILOT_VERIFY_SEED'\n"
    )


def test_extra_non_public_role_is_rejected(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    rows = [{"role": EXPECTED_ROLE}, {"role": "SYSADMIN"}]
    result, _, _, _ = _run(monkeypatch, FakeCursor(grant_rows=rows))

    assert result == 1
    assert capsys.readouterr().err == (
        "G3: unexpected non-PUBLIC role 'SYSADMIN'; expected only "
        "'ROASTPILOT_VERIFY_SEED'\n"
    )


def test_only_public_fails_expected_role_presence(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    result, _, _, _ = _run(
        monkeypatch, FakeCursor(grant_rows=[{"role": "PUBLIC"}])
    )

    assert result == 1
    assert capsys.readouterr().err == (
        "G2: expected exactly one 'ROASTPILOT_VERIFY_SEED' role grant; found 0\n"
    )


def test_duplicate_expected_role_fails(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    rows = [{"role": EXPECTED_ROLE}, {"role": EXPECTED_ROLE}]
    result, _, _, _ = _run(monkeypatch, FakeCursor(grant_rows=rows))

    assert result == 1
    assert capsys.readouterr().err == (
        "G2: expected exactly one 'ROASTPILOT_VERIFY_SEED' role grant; found 2\n"
    )


def test_wrong_current_user_fails_before_show_grants(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    result, connection, _, _ = _run(
        monkeypatch, FakeCursor(current_user="ROASTPILOT_SEED_CI_LOOKALIKE")
    )

    assert result == 1
    assert connection.fake_cursor.executed == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_USER()",
    ]
    assert connection.closed is True
    assert capsys.readouterr().err == (
        "G1: CURRENT_USER() is 'ROASTPILOT_SEED_CI_LOOKALIKE'; "
        "expected 'ROASTPILOT_SEED_CI'\n"
    )


@pytest.mark.parametrize("missing_shape", ["column", "row"])
def test_missing_current_user_column_or_row_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
    missing_shape: str,
) -> None:
    cursor = (
        FakeCursor(include_current_user_column=False)
        if missing_shape == "column"
        else FakeCursor(current_user=None)
    )
    result, connection, _, _ = _run(monkeypatch, cursor)

    assert result == 1
    assert connection.fake_cursor.executed == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_USER()",
    ]
    assert connection.closed is True
    assert capsys.readouterr().err == (
        "G1: CURRENT_USER() is ''; expected 'ROASTPILOT_SEED_CI'\n"
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
        "G6: ROASTPILOT_SEED_CI's DEFAULT_SECONDARY_ROLES is '[\"ALL\"]'"
    )


def test_only_a_wildcard_lookalike_user_fails(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    cursor = FakeCursor(
        user_rows=[
            {"name": "ROASTPILOT0SEED0CI", "default_secondary_roles": "[]"}
        ]
    )
    result, _, _, _ = _run(monkeypatch, cursor)

    assert result == 1
    stderr = capsys.readouterr().err
    assert stderr.startswith(
        "G6: SHOW USERS LIKE 'ROASTPILOT_SEED_CI' returned 1 row(s), of which 0"
    )
    assert "wildcard-lookalike" in stderr


def test_env_user_drift_exits_before_key_load_or_connect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("SNOWFLAKE_USER", "WRONG_SEED_CI")
    connection = FakeConnection()
    key_calls, connect_calls = _patch_boundaries(monkeypatch, connection)

    with pytest.raises(SystemExit) as exc_info:
        assert_seed_ci_principal.main(["--target", "ROASTPILOT_DEV"])

    assert str(exc_info.value) == (
        "error: SNOWFLAKE_USER is 'WRONG_SEED_CI', expected 'ROASTPILOT_SEED_CI' "
        "-- refusing to audit a repointed seed verifier principal"
    )
    assert key_calls == []
    assert connect_calls == []
    assert connection.fake_cursor.executed == []


def test_missing_required_env_keeps_its_specific_pre_connect_diagnostic(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.delenv("SNOWFLAKE_ACCOUNT")
    connection = FakeConnection()
    key_calls, connect_calls = _patch_boundaries(monkeypatch, connection)

    with pytest.raises(SystemExit) as exc_info:
        assert_seed_ci_principal.main(["--target", "ROASTPILOT_DEV"])

    assert str(exc_info.value) == (
        "error: missing required environment variable: SNOWFLAKE_ACCOUNT"
    )
    assert key_calls == []
    assert connect_calls == []
    assert connection.fake_cursor.executed == []


@pytest.mark.parametrize(
    ("variable", "value", "expected"),
    [
        ("SNOWFLAKE_ROLE", "WRONG_ROLE", EXPECTED_ROLE),
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
        assert_seed_ci_principal.main(["--target", "ROASTPILOT_DEV"])

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
        assert_seed_ci_principal,
        "ALLOWED_TARGETS",
        frozenset({"ROASTPILOT_DEV", "ROASTPILOT_PREVIEW"}),
    )
    connection = FakeConnection()
    key_calls, connect_calls = _patch_boundaries(monkeypatch, connection)

    with pytest.raises(SystemExit) as exc_info:
        assert_seed_ci_principal.main(["--target", "ROASTPILOT_PREVIEW"])

    assert str(exc_info.value) == (
        "error: --target is 'ROASTPILOT_PREVIEW', expected 'ROASTPILOT_DEV' -- "
        "refusing to audit a repointed seed verifier principal"
    )
    assert key_calls == []
    assert connect_calls == []


def test_unsafe_user_identifier_is_refused_before_connect(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    unsafe_user = "ROASTPILOT_SEED_CI; DROP"
    _set_required_env(monkeypatch)
    monkeypatch.setenv("SNOWFLAKE_USER", unsafe_user)
    monkeypatch.setattr(assert_seed_ci_principal, "_EXPECTED_USER", unsafe_user)
    connection = FakeConnection()
    key_calls, connect_calls = _patch_boundaries(monkeypatch, connection)

    with pytest.raises(SystemExit) as exc_info:
        assert_seed_ci_principal.main(["--target", "ROASTPILOT_DEV"])

    assert str(exc_info.value).startswith(
        "error: SNOWFLAKE_USER is 'ROASTPILOT_SEED_CI; DROP', which is not a bare "
    )
    assert key_calls == []
    assert connect_calls == []
    assert connection.fake_cursor.executed == []
