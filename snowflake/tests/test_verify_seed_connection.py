"""Unit tests for the fixed seed-verifier connection factory."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import verify_seed_connection  # noqa: E402


EXPECTED_ROLE = "ROASTPILOT_VERIFY_SEED"
EXPECTED_DATABASE = "ROASTPILOT_DEV"


class FakeCursor:
    def __init__(
        self,
        *,
        current_role: object = (EXPECTED_ROLE,),
        current_database: object = (EXPECTED_DATABASE,),
    ) -> None:
        self.current_role = current_role
        self.current_database = current_database
        self.executed: list[str] = []

    def execute(self, command: str) -> FakeCursor:
        self.executed.append(command)
        return self

    def fetchone(self) -> object:
        if self.executed[-1] == "SELECT CURRENT_ROLE()":
            return self.current_role
        if self.executed[-1] == "SELECT CURRENT_DATABASE()":
            return self.current_database
        raise AssertionError(f"unexpected fetchone after {self.executed[-1]}")


class FakeConnection:
    def __init__(
        self, cursor: FakeCursor | None = None, *, close_error: Exception | None = None
    ) -> None:
        self.fake_cursor = cursor or FakeCursor()
        self.cursor_calls = 0
        self.closed = False
        self.close_error = close_error

    def cursor(self) -> FakeCursor:
        self.cursor_calls += 1
        return self.fake_cursor

    def close(self) -> None:
        self.closed = True
        if self.close_error is not None:
            raise self.close_error


def _set_required_env(monkeypatch: pytest.MonkeyPatch, key_path: Path) -> None:
    monkeypatch.setenv("SNOWFLAKE_ACCOUNT", "ORG-ACCOUNT")
    monkeypatch.setenv("SNOWFLAKE_WAREHOUSE", "ROASTPILOT_WH")
    monkeypatch.setenv("SNOWFLAKE_SEED_PRIVATE_KEY_FILE", str(key_path))


def _connect(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    connection: FakeConnection | None = None,
) -> tuple[
    FakeConnection,
    list[tuple[str, str | None]],
    list[dict[str, object]],
]:
    key_path = tmp_path / "seed-key.p8"
    key_path.write_text("seed-private-key", encoding="utf-8")
    _set_required_env(monkeypatch, key_path)
    fake_connection = connection or FakeConnection()
    key_calls: list[tuple[str, str | None]] = []
    connect_calls: list[dict[str, object]] = []

    def fake_load_private_key(pem: str, passphrase: str | None) -> bytes:
        key_calls.append((pem, passphrase))
        return b"seed-private-key-der"

    def fake_connect(**kwargs: object) -> FakeConnection:
        connect_calls.append(kwargs)
        return fake_connection

    monkeypatch.setattr(
        verify_seed_connection, "load_private_key_der", fake_load_private_key
    )
    monkeypatch.setattr(verify_seed_connection, "_connect", fake_connect)
    result = verify_seed_connection.connect_seed(EXPECTED_DATABASE)
    assert result is fake_connection
    return fake_connection, key_calls, connect_calls


def test_sibling_loader_resolves_the_real_grant_guard() -> None:
    module = verify_seed_connection._load_sibling_module("assert_dev_ci_grants")

    assert module.identifiers_match(EXPECTED_ROLE, EXPECTED_ROLE) is True
    assert module.load_private_key_der.__name__ == "load_private_key_der"


def test_sibling_loader_wraps_a_missing_file_as_import_error() -> None:
    with pytest.raises(ImportError, match="cannot load sibling module"):
        verify_seed_connection._load_sibling_module("this_module_does_not_exist")


@pytest.mark.parametrize("missing_spec", [None, SimpleNamespace(loader=None)])
def test_sibling_loader_fails_closed_without_a_loader(
    monkeypatch: pytest.MonkeyPatch,
    missing_spec: object,
) -> None:
    monkeypatch.setattr(
        verify_seed_connection.importlib.util,
        "spec_from_file_location",
        lambda *_args: missing_spec,
    )

    with pytest.raises(ImportError, match="cannot construct a loader"):
        verify_seed_connection._load_sibling_module("assert_dev_ci_grants")


def test_happy_path_pins_connection_and_preflight_order(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    connection, key_calls, connect_calls = _connect(monkeypatch, tmp_path)

    assert connection.cursor_calls == 1
    assert connection.fake_cursor.executed == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_ROLE()",
        "SELECT CURRENT_DATABASE()",
    ]
    assert connection.closed is False
    assert key_calls == [("seed-private-key", None)]
    assert connect_calls == [
        {
            "account": "ORG-ACCOUNT",
            "warehouse": "ROASTPILOT_WH",
            "database": EXPECTED_DATABASE,
            "private_key": b"seed-private-key-der",
        }
    ]


def test_real_connect_boundary_pins_seed_identity_and_autocommit(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[dict[str, object]] = []
    sentinel = FakeConnection()

    def fake_connector_connect(**kwargs: object) -> FakeConnection:
        calls.append(kwargs)
        return sentinel

    monkeypatch.setattr(
        verify_seed_connection.snowflake.connector, "connect", fake_connector_connect
    )

    result = verify_seed_connection._connect(
        account="ORG-ACCOUNT",
        warehouse="ROASTPILOT_WH",
        database=EXPECTED_DATABASE,
        private_key=b"seed-private-key-der",
    )

    assert result is sentinel
    assert calls == [
        {
            "account": "ORG-ACCOUNT",
            "user": "ROASTPILOT_SEED_CI",
            "role": EXPECTED_ROLE,
            "warehouse": "ROASTPILOT_WH",
            "database": EXPECTED_DATABASE,
            "private_key": b"seed-private-key-der",
            "autocommit": True,
        }
    ]


def test_unset_passphrase_is_loaded_as_none(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.delenv("SNOWFLAKE_SEED_PRIVATE_KEY_PASSPHRASE", raising=False)

    _, key_calls, _ = _connect(monkeypatch, tmp_path)

    assert key_calls == [("seed-private-key", None)]


def test_nonempty_passphrase_is_forwarded(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("SNOWFLAKE_SEED_PRIVATE_KEY_PASSPHRASE", "passphrase")

    _, key_calls, _ = _connect(monkeypatch, tmp_path)

    assert key_calls == [("seed-private-key", "passphrase")]


@pytest.mark.parametrize(
    "current_role",
    [
        ("ACCOUNTADMIN",),
        ("",),
        (None,),
        None,
        (),
    ],
)
def test_role_mismatch_or_unreadable_role_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    current_role: object,
) -> None:
    connection = FakeConnection(FakeCursor(current_role=current_role))
    with pytest.raises(
        verify_seed_connection.SeedConnectionError,
        match=(
            "^Snowflake seed connection preflight returned an unexpected role$"
        ),
    ):
        _connect(monkeypatch, tmp_path, connection)

    assert connection.fake_cursor.executed == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_ROLE()",
    ]
    assert connection.closed is True


@pytest.mark.parametrize(
    "current_database",
    [
        ("ROASTPILOT_PROD",),
        ("",),
        (None,),
        None,
        (),
    ],
)
def test_database_mismatch_or_unreadable_database_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    current_database: object,
) -> None:
    connection = FakeConnection(FakeCursor(current_database=current_database))
    with pytest.raises(
        verify_seed_connection.SeedConnectionError,
        match=(
            "^Snowflake seed connection preflight returned an unexpected database$"
        ),
    ):
        _connect(monkeypatch, tmp_path, connection)

    assert connection.fake_cursor.executed == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_ROLE()",
        "SELECT CURRENT_DATABASE()",
    ]
    assert connection.closed is True


def test_list_shaped_preflight_rows_are_accepted(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    connection = FakeConnection(
        FakeCursor(
            current_role=[EXPECTED_ROLE], current_database=[EXPECTED_DATABASE]
        )
    )

    result, _, _ = _connect(monkeypatch, tmp_path, connection)

    assert result is connection


def test_connect_failure_is_sanitised(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    key_path = tmp_path / "secret-seed-key.p8"
    key_path.write_text("seed-private-key", encoding="utf-8")
    _set_required_env(monkeypatch, key_path)
    monkeypatch.setattr(
        verify_seed_connection,
        "load_private_key_der",
        lambda _pem, _passphrase: b"seed-private-key-der",
    )

    def fail_connect(**_kwargs: object) -> None:
        raise RuntimeError(
            f"connect failed for host secret.example and key {key_path}"
        )

    monkeypatch.setattr(verify_seed_connection, "_connect", fail_connect)

    with pytest.raises(verify_seed_connection.SeedConnectionError) as exc_info:
        verify_seed_connection.connect_seed(EXPECTED_DATABASE)

    assert str(exc_info.value) == "Snowflake seed connection or authentication failed"
    assert "secret.example" not in str(exc_info.value)
    assert str(key_path) not in str(exc_info.value)
    assert exc_info.value.__cause__ is None


def test_private_key_failure_is_sanitised(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    key_path = tmp_path / "secret-seed-key.p8"
    key_path.write_text("seed-private-key", encoding="utf-8")
    _set_required_env(monkeypatch, key_path)

    def fail_key_load(_pem: str, _passphrase: str | None) -> None:
        raise RuntimeError(f"cannot load {key_path}")

    monkeypatch.setattr(
        verify_seed_connection, "load_private_key_der", fail_key_load
    )

    with pytest.raises(verify_seed_connection.SeedConnectionError) as exc_info:
        verify_seed_connection.connect_seed(EXPECTED_DATABASE)

    assert str(exc_info.value) == "Snowflake seed private-key configuration failed"
    assert str(key_path) not in str(exc_info.value)
    assert exc_info.value.__cause__ is None


def test_unexpected_preflight_failure_is_sanitised_and_closes(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    connection = FakeConnection()

    def fail_execute(_command: str) -> None:
        raise RuntimeError("host secret.example leaked")

    connection.fake_cursor.execute = fail_execute  # type: ignore[method-assign]
    with pytest.raises(verify_seed_connection.SeedConnectionError) as exc_info:
        _connect(monkeypatch, tmp_path, connection)

    assert str(exc_info.value) == "Snowflake seed connection preflight failed"
    assert "secret.example" not in str(exc_info.value)
    assert exc_info.value.__cause__ is None
    assert connection.closed is True


@pytest.mark.parametrize(
    ("cursor", "expected_message"),
    [
        (
            FakeCursor(current_role=("ACCOUNTADMIN",)),
            "Snowflake seed connection preflight returned an unexpected role",
        ),
        (
            FakeCursor(),
            "Snowflake seed connection preflight failed",
        ),
    ],
)
def test_close_failure_preserves_original_sanitised_preflight_error(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    cursor: FakeCursor,
    expected_message: str,
) -> None:
    key_path = tmp_path / "secret-seed-key.p8"
    connection = FakeConnection(
        cursor, close_error=RuntimeError(f"close leaked secret.example {key_path}")
    )
    if expected_message == "Snowflake seed connection preflight failed":
        def fail_execute(_command: str) -> None:
            raise RuntimeError(f"preflight leaked other.example {key_path}")

        connection.fake_cursor.execute = fail_execute  # type: ignore[method-assign]

    with pytest.raises(verify_seed_connection.SeedConnectionError) as exc_info:
        _connect(monkeypatch, tmp_path, connection)

    assert str(exc_info.value) == expected_message
    assert "secret.example" not in str(exc_info.value)
    assert "other.example" not in str(exc_info.value)
    assert str(key_path) not in str(exc_info.value)
    assert exc_info.value.__cause__ is None
    assert connection.closed is True
