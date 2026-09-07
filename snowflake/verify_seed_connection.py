#!/usr/bin/env python3
"""Create and preflight the fixed Snowflake seed-verifier connection."""

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
from types import ModuleType
from typing import Protocol

import snowflake.connector


_EXPECTED_USER = "ROASTPILOT_SEED_CI"
_EXPECTED_ROLE = "ROASTPILOT_VERIFY_SEED"
_EXPECTED_DATABASE = "ROASTPILOT_DEV"


class Cursor(Protocol):
    def execute(self, command: str) -> object: ...
    def fetchone(self) -> object: ...


class Connection(Protocol):
    def cursor(self) -> Cursor: ...
    def close(self) -> None: ...


class SeedConnectionError(RuntimeError):
    """Raised when the fixed seed connection cannot be safely established."""


def _load_sibling_module(module_name: str) -> ModuleType:
    """Load one fixed sibling by path without adding its directory to sys.path."""
    module_path = Path(__file__).resolve().parent / f"{module_name}.py"
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:  # pragma: no cover
        raise ImportError(f"cannot construct a loader for sibling module {module_name!r}")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except FileNotFoundError as exc:
        raise ImportError(
            f"cannot load sibling module {module_name!r} from {module_path}"
        ) from exc
    return module


_assert_dev_ci_grants = _load_sibling_module("assert_dev_ci_grants")
identifiers_match = _assert_dev_ci_grants.identifiers_match
load_private_key_der = _assert_dev_ci_grants.load_private_key_der
require_env = _assert_dev_ci_grants.require_env


def _connect(
    *,
    account: str,
    warehouse: str,
    database: str,
    private_key: bytes,
) -> Connection:  # pragma: no cover; pragma: no mutate block - real operator boundary
    return snowflake.connector.connect(
        account=account,
        user=_EXPECTED_USER,
        role=_EXPECTED_ROLE,
        warehouse=warehouse,
        database=database,
        private_key=private_key,
        autocommit=True,
    )


def _first_value(row: object) -> object:
    if isinstance(row, (tuple, list)) and row:
        return row[0]
    return None


def _close_after_preflight_failure(connection: Connection) -> None:
    """Best-effort cleanup without replacing the sanitised preflight error."""
    try:
        connection.close()
    except Exception:
        # Connector close diagnostics can contain account/host details. The
        # original sanitised preflight error is the authoritative evidence.
        pass


def connect_seed(target_database: str) -> Connection:
    """Return an open seed connection after fixed-role and DEV preflight."""
    account = require_env("SNOWFLAKE_ACCOUNT")
    warehouse = require_env("SNOWFLAKE_WAREHOUSE")
    private_key_path = Path(require_env("SNOWFLAKE_SEED_PRIVATE_KEY_FILE"))
    passphrase = os.environ.get("SNOWFLAKE_SEED_PRIVATE_KEY_PASSPHRASE") or None
    try:
        # PEM is ASCII; the platform default, UTF-8, and the UTF-8 alias are
        # behaviorally identical for every valid key file.
        pem_text = private_key_path.read_text(encoding="utf-8")  # pragma: no mutate
        private_key = load_private_key_der(pem_text, passphrase)
    except Exception:
        raise SeedConnectionError("Snowflake seed private-key configuration failed") from None

    try:
        connection = _connect(
            account=account,
            warehouse=warehouse,
            database=target_database,
            private_key=private_key,
        )
    except Exception:
        raise SeedConnectionError(
            "Snowflake seed connection or authentication failed"
        ) from None

    try:
        cursor = connection.cursor()
        cursor.execute("USE SECONDARY ROLES NONE")
        cursor.execute("SELECT CURRENT_ROLE()")
        current_role = _first_value(cursor.fetchone())
        if not isinstance(current_role, str) or not identifiers_match(
            current_role, _EXPECTED_ROLE
        ):
            raise SeedConnectionError(
                "Snowflake seed connection preflight returned an unexpected role"
            )

        cursor.execute("SELECT CURRENT_DATABASE()")
        current_database = _first_value(cursor.fetchone())
        if not isinstance(current_database, str) or not identifiers_match(
            current_database, _EXPECTED_DATABASE
        ):
            raise SeedConnectionError(
                "Snowflake seed connection preflight returned an unexpected database"
            )
    except SeedConnectionError:
        _close_after_preflight_failure(connection)
        raise
    except Exception:
        _close_after_preflight_failure(connection)
        raise SeedConnectionError("Snowflake seed connection preflight failed") from None

    return connection
