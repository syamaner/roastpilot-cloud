#!/usr/bin/env python3
"""Fail-closed preflight for the gated ROASTPILOT_AGENT_CI live verifiers.

The guard authenticates with the same in-memory key and fixed principal used
by the verifier job, disables secondary roles, then proves that the session is
the expected user. It also requires exactly one direct non-PUBLIC role grant,
ROASTPILOT_AGENT, and verifies DEFAULT_SECONDARY_ROLES is empty.

NOTE (operator-supervised validation required): the ``CURRENT_USER()`` label,
the ``role`` column from ``SHOW GRANTS TO USER``, and the ``name`` /
``default_secondary_roles`` columns from ``SHOW USERS LIKE`` follow the
Snowflake connector's documented DictCursor shapes. Their exact live shapes
must be confirmed on the first human-approved dispatch. Unknown, missing, or
blank identity/grant data fails closed rather than being ignored.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from collections.abc import Sequence
from pathlib import Path
from types import ModuleType

import snowflake.connector


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
assert_sql_identifier_safe = _assert_dev_ci_grants.assert_sql_identifier_safe
find_default_secondary_roles_violation = (
    _assert_dev_ci_grants.find_default_secondary_roles_violation
)
identifiers_match = _assert_dev_ci_grants.identifiers_match
load_private_key_der = _assert_dev_ci_grants.load_private_key_der
require_env = _assert_dev_ci_grants.require_env


_EXPECTED_USER = "ROASTPILOT_AGENT_CI"
_EXPECTED_ROLE = "ROASTPILOT_AGENT"
_EXPECTED_DATABASE = "ROASTPILOT_DEV"
_EXPECTED_WAREHOUSE = "ROASTPILOT_WH"
ALLOWED_TARGETS = frozenset({_EXPECTED_DATABASE})


def find_user_role_grant_violations(
    rows: list[dict[str, object]], expected_role: str
) -> list[str]:
    """Require one expected non-PUBLIC role and reject every other shape.

    Only the documented ``role`` column is read. PUBLIC is implicit and
    non-revocable, so it is excluded from the presence count. Unlike the
    exclusion-only ``find_unexpected_user_role_grants`` helper, a blank role
    cannot be skipped here: this check must also prove presence, so an
    unreadable row is itself a violation.
    """
    violations: list[str] = []
    present_non_public: list[str] = []
    for row in rows:
        role = str(row.get("role", ""))
        if role == "":
            violations.append(
                "G4: SHOW GRANTS TO USER returned a blank role; cannot verify the grant set"
            )
            continue
        if identifiers_match(role, "PUBLIC"):
            continue
        present_non_public.append(role)
        if not identifiers_match(role, expected_role):
            violations.append(
                f"G3: unexpected non-PUBLIC role {role!r}; expected only {expected_role!r}"
            )

    expected_roles = [
        role
        for role in present_non_public
        if identifiers_match(role, expected_role)
    ]
    if len(expected_roles) != 1:
        gate = "G5" if len(rows) == 0 else "G2"
        violations.append(
            f"{gate}: expected exactly one {expected_role!r} role grant; "
            f"found {len(expected_roles)}"
        )
    return violations


def _assert_drift_anchor(value: str, expected: str, label: str) -> None:
    if not identifiers_match(value, expected):
        raise SystemExit(
            f"error: {label} is {value!r}, expected {expected!r} -- refusing to audit "
            "a repointed agent verifier principal"
        )


def _connect(
    *,
    account: str,
    user: str,
    role: str,
    warehouse: str,
    database: str,
    private_key: bytes,
):  # pragma: no cover; pragma: no mutate block - real operator boundary
    return snowflake.connector.connect(
        account=account,
        user=user,
        role=role,
        warehouse=warehouse,
        database=database,
        private_key=private_key,
    )


def main(argv: Sequence[str] | None = None) -> int:
    # ``allow_abbrev=None`` is behaviorally identical to False inside
    # argparse, leaving an unkillable equivalent mutant on this constructor.
    # The tests still pin both the no-abbreviation behavior and help text.
    parser = argparse.ArgumentParser(  # pragma: no mutate
        description=__doc__, allow_abbrev=False  # pragma: no mutate
    )
    parser.add_argument("--target", required=True, choices=sorted(ALLOWED_TARGETS))
    args = parser.parse_args(argv)

    account = require_env("SNOWFLAKE_ACCOUNT")
    user = require_env("SNOWFLAKE_USER")
    role = require_env("SNOWFLAKE_ROLE")
    warehouse = require_env("SNOWFLAKE_WAREHOUSE")
    database = require_env("SNOWFLAKE_DATABASE")
    private_key_pem = require_env("SNOWFLAKE_AGENT_PRIVATE_KEY")
    passphrase = os.environ.get("SNOWFLAKE_AGENT_PRIVATE_KEY_PASSPHRASE") or None

    _assert_drift_anchor(user, _EXPECTED_USER, "SNOWFLAKE_USER")
    _assert_drift_anchor(role, _EXPECTED_ROLE, "SNOWFLAKE_ROLE")
    _assert_drift_anchor(warehouse, _EXPECTED_WAREHOUSE, "SNOWFLAKE_WAREHOUSE")
    _assert_drift_anchor(database, _EXPECTED_DATABASE, "SNOWFLAKE_DATABASE")
    _assert_drift_anchor(args.target, _EXPECTED_DATABASE, "--target")
    assert_sql_identifier_safe(user, "SNOWFLAKE_USER")

    private_key = load_private_key_der(private_key_pem, passphrase)
    connection = _connect(
        account=account,
        user=user,
        role=role,
        warehouse=warehouse,
        database=database,
        private_key=private_key,
    )
    violations: list[str] = []
    try:
        cursor = connection.cursor(snowflake.connector.DictCursor)
        cursor.execute("USE SECONDARY ROLES NONE")

        cursor.execute("SELECT CURRENT_USER()")
        current_user_row = cursor.fetchone()
        current_user = str((current_user_row or {}).get("CURRENT_USER()", ""))
        if not identifiers_match(current_user, _EXPECTED_USER):
            violations.append(
                f"G1: CURRENT_USER() is {current_user!r}; expected {_EXPECTED_USER!r}"
            )
        else:
            cursor.execute(f"SHOW GRANTS TO USER {user}")
            violations.extend(
                find_user_role_grant_violations(cursor.fetchall(), _EXPECTED_ROLE)
            )

            cursor.execute(f"SHOW USERS LIKE '{user}'")
            secondary_roles_violation = find_default_secondary_roles_violation(
                cursor.fetchall(), user
            )
            if secondary_roles_violation is not None:
                violations.append(f"G6: {secondary_roles_violation}")
    finally:
        connection.close()

    if violations:
        for violation in violations:
            print(violation, file=sys.stderr)
        return 1

    print(
        "verified ROASTPILOT_AGENT_CI has exactly one ROASTPILOT_AGENT role grant "
        "and empty DEFAULT_SECONDARY_ROLES in ROASTPILOT_DEV"
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
