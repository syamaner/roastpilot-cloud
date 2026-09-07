#!/usr/bin/env python3
"""Fail-closed preflight for the gated ROASTPILOT_SEED_CI live verifiers.

The guard authenticates with the same in-memory key and fixed principal used
by the verifier job, disables secondary roles, then proves that the session is
the expected user. It also requires exactly one direct non-PUBLIC role grant,
ROASTPILOT_VERIFY_SEED, verifies DEFAULT_SECONDARY_ROLES is empty, and proves
that the seed role's direct object grants exactly match its minimal manifest
without inheriting another role, and rejects every visible future grant.

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
_grant_option_is_false = _assert_dev_ci_grants._grant_option_is_false
_role_grants_match = _assert_dev_ci_grants._role_grants_match


_EXPECTED_USER = "ROASTPILOT_SEED_CI"
_EXPECTED_ROLE = "ROASTPILOT_VERIFY_SEED"
_EXPECTED_DATABASE = "ROASTPILOT_DEV"
_EXPECTED_WAREHOUSE = "ROASTPILOT_WH"
ALLOWED_TARGETS = frozenset({_EXPECTED_DATABASE})
RoleGrant = tuple[str, str, str, str]

# This CI-infrastructure role deliberately stays outside
# check_grant_manifest.EXPECTED_MANIFEST, which defines application roles.
# Each privilege is expanded into the exact database-qualified uppercase shape
# returned by SHOW GRANTS.
#
# SELECT on the four seed tables is required, not optional: Snowflake needs
# SELECT on the target table to evaluate a DELETE/UPDATE WHERE predicate, so
# the seed verifier's filtered-DML teardown (its DELETEs) and arrange steps
# (the consent-flip UPDATE) cannot run without it. This was live-revealed on
# the first post-revoke agent-verify run (34165649434); the operator has since
# granted SELECT on DEV, so the expected manifest must include it or the G7
# exact-manifest audit would flag the now-"extra" live SELECT.
_EXPECTED_SEED_ROLE_GRANTS: frozenset[RoleGrant] = frozenset(
    {
        ("USAGE", "DATABASE", "ROASTPILOT_DEV", _EXPECTED_ROLE),
        ("USAGE", "SCHEMA", "ROASTPILOT_DEV.APP", _EXPECTED_ROLE),
        ("USAGE", "WAREHOUSE", "ROASTPILOT_WH", _EXPECTED_ROLE),
        (
            "INSERT",
            "TABLE",
            "ROASTPILOT_DEV.APP.CLOUD_ROASTS",
            _EXPECTED_ROLE,
        ),
        (
            "UPDATE",
            "TABLE",
            "ROASTPILOT_DEV.APP.CLOUD_ROASTS",
            _EXPECTED_ROLE,
        ),
        (
            "DELETE",
            "TABLE",
            "ROASTPILOT_DEV.APP.CLOUD_ROASTS",
            _EXPECTED_ROLE,
        ),
        (
            "INSERT",
            "TABLE",
            "ROASTPILOT_DEV.APP.ROAST_TELEMETRY",
            _EXPECTED_ROLE,
        ),
        (
            "DELETE",
            "TABLE",
            "ROASTPILOT_DEV.APP.ROAST_TELEMETRY",
            _EXPECTED_ROLE,
        ),
        (
            "DELETE",
            "TABLE",
            "ROASTPILOT_DEV.APP.ROAST_ARTIFACTS",
            _EXPECTED_ROLE,
        ),
        (
            "DELETE",
            "TABLE",
            "ROASTPILOT_DEV.APP.REFERENCE_ROAST_SUMMARIES",
            _EXPECTED_ROLE,
        ),
        (
            "SELECT",
            "TABLE",
            "ROASTPILOT_DEV.APP.CLOUD_ROASTS",
            _EXPECTED_ROLE,
        ),
        (
            "SELECT",
            "TABLE",
            "ROASTPILOT_DEV.APP.ROAST_TELEMETRY",
            _EXPECTED_ROLE,
        ),
        (
            "SELECT",
            "TABLE",
            "ROASTPILOT_DEV.APP.ROAST_ARTIFACTS",
            _EXPECTED_ROLE,
        ),
        (
            "SELECT",
            "TABLE",
            "ROASTPILOT_DEV.APP.REFERENCE_ROAST_SUMMARIES",
            _EXPECTED_ROLE,
        ),
    }
)


def find_user_role_grant_violations(
    rows: list[dict[str, object]], expected_role: str
) -> list[str]:
    """Require one expected non-PUBLIC role and reject every other shape."""
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


def find_seed_role_manifest_violations(
    rows: list[dict[str, object]],
) -> list[str]:
    """Require the exact seed object manifest and no inherited role.

    Privilege and object-type fields use Snowflake's fixed vocabulary and are
    normalized like the shared application-role audit. Object and role names
    use its byte-exact matcher. Unknown, blank, malformed, duplicated, or
    grant-option-bearing rows fail closed.

    COMPLETENESS LIMIT (#59-style): under this minimal seed role, ``SHOW GRANTS
    TO ROLE`` returns only grants visible to that role. This is a scoped
    detective control; the human-gated live agent-verify run is authoritative.
    """
    observed: list[tuple[RoleGrant, bool, str]] = []
    violations: list[str] = []
    for row in rows:
        # Alternate get() defaults all remain rejected by the malformed/extra
        # paths, so mutating them cannot change the security decision.
        privilege = str(row.get("privilege", "")).strip().upper()  # pragma: no mutate
        granted_on = str(row.get("granted_on", "")).strip().upper()  # pragma: no mutate
        name = str(row.get("name", ""))  # pragma: no mutate
        granted_to = str(row.get("granted_to", "")).strip().upper()  # pragma: no mutate
        grantee_name = str(row.get("grantee_name", ""))  # pragma: no mutate
        grant_option = row.get("grant_option", _assert_dev_ci_grants._GRANT_OPTION_ABSENT)
        grant_option_display = (
            "<absent>"
            if grant_option is _assert_dev_ci_grants._GRANT_OPTION_ABSENT
            else repr(grant_option)
        )
        grant_option_is_false = _grant_option_is_false(grant_option)

        if not privilege or not granted_on or not name or not grantee_name:
            violations.append(
                "G7: SHOW GRANTS TO ROLE returned a blank or malformed grant row"
            )
            continue
        if granted_to != "ROLE":
            violations.append(
                f"G7: unexpected grantee type {granted_to!r} for {privilege} on "
                f"{granted_on} {name}"
            )
            continue

        grant = (privilege, granted_on, name, grantee_name)
        if granted_on == "ROLE":
            if (
                privilege != "USAGE"
                or not identifiers_match(name, _EXPECTED_ROLE)
                or not identifiers_match(grantee_name, _EXPECTED_ROLE)
                or not grant_option_is_false
            ):
                violations.append(
                    f"G8: unexpected role inheritance edge: {privilege} on ROLE "
                    f"{name} to {grantee_name} (grant_option={grant_option_display})"
                )
            continue

        observed.append((grant, grant_option_is_false, grant_option_display))

    violations.extend(
        f"G7: extra seed-role grant: {grant[0]} on {grant[1]} {grant[2]} "
        f"to {grant[3]} (grant_option={grant_option_display})"
        for grant, grant_option_is_false, grant_option_display in observed
        if not grant_option_is_false
        or not any(
            _role_grants_match(grant, expected)
            for expected in _EXPECTED_SEED_ROLE_GRANTS
        )
    )
    for expected in sorted(_EXPECTED_SEED_ROLE_GRANTS):
        matching_grants = [
            grant
            for grant, grant_option_is_false, _ in observed
            if grant_option_is_false and _role_grants_match(grant, expected)
        ]
        if len(matching_grants) == 0:
            violations.append(
                f"G7: missing seed-role grant: {expected[0]} on {expected[1]} "
                f"{expected[2]} to {expected[3]}"
            )
        elif len(matching_grants) != 1:
            violations.append(
                f"G7: duplicate seed-role grant: {expected[0]} on {expected[1]} "
                f"{expected[2]} to {expected[3]}"
            )
    return violations


def find_seed_role_future_grant_violations(
    rows: list[dict[str, object]],
) -> list[str]:
    """Reject every visible future grant because the seed manifest has none.

    ``SHOW FUTURE GRANTS`` uses ``grant_on`` for the future object type and
    ``name`` for its containing database or schema. Missing or blank fields
    fail closed instead of producing an ambiguous grant description.

    COMPLETENESS LIMIT (#59-style): under this minimal seed role, ``SHOW FUTURE
    GRANTS TO ROLE`` returns only future grants visible to that role. This is a
    scoped detective control; the human-gated live agent-verify dispatch is
    authoritative.
    """
    violations: list[str] = []
    for row in rows:
        # These values only make the unconditional G9 violation diagnostic
        # useful. Alternate get() defaults cannot change the reject decision.
        privilege = str(row.get("privilege", ""))  # pragma: no mutate
        grant_on = str(row.get("grant_on", ""))  # pragma: no mutate
        name = str(row.get("name", ""))  # pragma: no mutate
        if privilege == "" or grant_on == "" or name == "":
            violations.append(
                "G9: SHOW FUTURE GRANTS TO ROLE returned a blank or malformed "
                "grant row"
            )
        else:
            violations.append(
                f"G9: forbidden seed-role future grant: {privilege} on future "
                f"{grant_on} in {name}"
            )
    return violations


def _assert_drift_anchor(value: str, expected: str, label: str) -> None:
    if not identifiers_match(value, expected):
        raise SystemExit(
            f"error: {label} is {value!r}, expected {expected!r} -- refusing to audit "
            "a repointed seed verifier principal"
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
    private_key_pem = require_env("SNOWFLAKE_SEED_PRIVATE_KEY")
    passphrase = os.environ.get("SNOWFLAKE_SEED_PRIVATE_KEY_PASSPHRASE") or None

    _assert_drift_anchor(user, _EXPECTED_USER, "SNOWFLAKE_USER")
    _assert_drift_anchor(role, _EXPECTED_ROLE, "SNOWFLAKE_ROLE")
    _assert_drift_anchor(warehouse, _EXPECTED_WAREHOUSE, "SNOWFLAKE_WAREHOUSE")
    _assert_drift_anchor(database, _EXPECTED_DATABASE, "SNOWFLAKE_DATABASE")
    _assert_drift_anchor(args.target, _EXPECTED_DATABASE, "--target")
    assert_sql_identifier_safe(user, "SNOWFLAKE_USER")

    try:
        private_key = load_private_key_der(private_key_pem, passphrase)
        connection = _connect(
            account=account,
            user=user,
            role=role,
            warehouse=warehouse,
            database=database,
            private_key=private_key,
        )
    except Exception:
        print(
            "error: Snowflake principal audit connection or query failed",
            file=sys.stderr,
        )
        return 1

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

            cursor.execute(f"SHOW GRANTS TO ROLE {role}")
            violations.extend(find_seed_role_manifest_violations(cursor.fetchall()))

            cursor.execute(f"SHOW FUTURE GRANTS TO ROLE {role}")
            violations.extend(
                find_seed_role_future_grant_violations(cursor.fetchall())
            )
    except Exception:
        try:
            connection.close()
        except Exception:
            pass
        print(
            "error: Snowflake principal audit connection or query failed",
            file=sys.stderr,
        )
        return 1

    try:
        connection.close()
    except Exception:
        if violations:
            for violation in violations:
                print(violation, file=sys.stderr)
        else:
            print(
                "error: Snowflake principal audit connection close failed",
                file=sys.stderr,
            )
        return 1

    if violations:
        for violation in violations:
            print(violation, file=sys.stderr)
        return 1

    print(
        "verified ROASTPILOT_SEED_CI has exactly one ROASTPILOT_VERIFY_SEED role "
        "grant, empty DEFAULT_SECONDARY_ROLES, and the exact minimal role "
        "manifest with zero future grants in ROASTPILOT_DEV"
    )
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
