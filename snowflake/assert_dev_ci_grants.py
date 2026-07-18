#!/usr/bin/env python3
"""Asserts the DEV-scoped CI service role's grants never extend beyond
ROASTPILOT_DEV / DEV_CI_WH (F1-S8, issue #11, factory.md §8).

Connects to Snowflake with the SAME identity the live contract-check job
uses (SNOWFLAKE_DEV_* env vars, key-pair/JWT auth) and runs ``SHOW GRANTS TO
ROLE <role>``, then fails if any returned grant's target reaches outside the
DEV database/warehouse this role is provisioned to be confined to. This is
the F1-S8 acceptance bar: a compromised or misbehaving agent holding this
role must never be able to touch PROD, PREVIEW, or any other account-level
object, and this check runs on every dispatch of the gated job — not just at
provisioning time — so a grant drift (an operator accidentally widening the
role later) is caught automatically, not just verified once by hand via
`SHOW GRANTS` at setup time.

Deliberately fails CLOSED: an unrecognized object type (a Snowflake
privilege/object kind this allowlist doesn't know about) is treated as a
VIOLATION, never silently permitted — see `_is_allowed_grant`.

This connects DIRECTLY via snowflake-connector-python (not through
schemachange, which has no equivalent of `SHOW GRANTS`), using the private
key CONTENT held in memory — never written to disk, unlike the schemachange
deploy step in the same job, which needs a temp file because schemachange's
own env-var layer only accepts a file path (see with_connection_env.py).

NOTE (operator-supervised validation required): the connection/query
mechanics below follow Snowflake's documented key-pair (JWT) auth flow and
`SHOW GRANTS TO ROLE`'s documented output columns, but this script has never
run against a real Snowflake session (no credentials available to the agent
that wrote it, per factory.md's own "agent jobs hold no Snowflake secrets"
invariant). The FIRST real dispatch of the gated job is this script's actual
validation — same "the operator's live dispatch doubles as the audit"
pattern already used elsewhere in this repo for code that can't be verified
without live infrastructure access.
"""

from __future__ import annotations

import os
import sys

import snowflake.connector
from cryptography.hazmat.primitives import serialization

# Snowflake object types (SHOW GRANTS' own `granted_on` column values) this
# check knows how to evaluate against the DEV database. Anything NOT in this
# set (ACCOUNT, INTEGRATION, USER, or any future object type Snowflake
# introduces) is rejected outright by _is_allowed_grant's fail-closed
# default -- never silently permitted just because it wasn't anticipated.
_DATABASE_SCOPED_OBJECT_TYPES = frozenset(
    {
        "DATABASE",
        "SCHEMA",
        "TABLE",
        "VIEW",
        "MATERIALIZED VIEW",
        "STAGE",
        "FILE FORMAT",
        "SEQUENCE",
        "PROCEDURE",
        "FUNCTION",
        "STREAM",
        "TASK",
        "PIPE",
    }
)


def require_env(name: str) -> str:
    """Reads a required environment variable, failing loudly if missing."""
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"error: missing required environment variable: {name}")
    return value


def load_private_key_der(pem_text: str, passphrase: str | None) -> bytes:
    """Parses a PEM-encoded private key into the DER/PKCS8 bytes
    snowflake-connector-python's `private_key` connect() parameter expects.

    Never touches disk -- the PEM text stays in memory for the lifetime of
    this process only, unlike the schemachange deploy step in the same job
    (which must write a temp file, since schemachange's own env-var layer
    only accepts a file path).

    @param pem_text: The PEM-encoded private key content (the
        SNOWFLAKE_DEV_PRIVATE_KEY secret's raw value).
    @param passphrase: The key's passphrase, or None if unencrypted.
    @returns: DER-encoded PKCS8 private key bytes.
    """
    key = serialization.load_pem_private_key(
        pem_text.encode("utf-8"),
        password=passphrase.encode("utf-8") if passphrase else None,
    )
    return key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )


def is_allowed_grant(
    granted_on: str, name: str, role_name: str, allowed_database: str, allowed_warehouse: str
) -> bool:
    """True when a single `SHOW GRANTS TO ROLE` row's target object is
    within the DEV role's intended boundary.

    `allowed_database`/`allowed_warehouse` are passed in by the caller
    (sourced from `SNOWFLAKE_DEV_DATABASE`/`SNOWFLAKE_DEV_WAREHOUSE` in
    `main()`) rather than hardcoded as module constants (claude-review
    finding, PR #57): those are the SAME repo variables the deploy step's
    own connection already uses, so if either is ever repointed (e.g. a
    future DEV database rename), this check and the deploy step can never
    silently drift apart into checking a different boundary than what was
    actually deployed to.

    Fails CLOSED for anything not explicitly recognized: an object type
    outside `_DATABASE_SCOPED_OBJECT_TYPES` (and not a warehouse/role
    self-grant) is never allowed, regardless of its name -- a future
    Snowflake object kind this allowlist doesn't yet know about must be
    treated as a violation until a human explicitly adds it here, not
    silently passed through.

    @param granted_on: The row's `granted_on` column (e.g. "DATABASE",
        "WAREHOUSE", "TABLE") -- the target object's TYPE.
    @param name: The row's `name` column -- the target object's name,
        possibly fully-qualified (e.g. "ROASTPILOT_DEV.APP.SOME_TABLE").
    @param role_name: The role being checked, for the self-grant case (a
        role's grant ON itself, e.g. an inherited USAGE privilege).
    @param allowed_database: The one database this role may touch.
    @param allowed_warehouse: The one warehouse this role may touch.
    @returns: Whether this grant stays within the DEV boundary.
    """
    granted_on_upper = granted_on.strip().upper()
    name_upper = name.strip().upper()

    if granted_on_upper == "WAREHOUSE":
        return name_upper == allowed_warehouse.strip().upper()

    if granted_on_upper == "ROLE":
        return name_upper == role_name.strip().upper()

    if granted_on_upper in _DATABASE_SCOPED_OBJECT_TYPES:
        allowed_database_upper = allowed_database.strip().upper()
        return name_upper == allowed_database_upper or name_upper.startswith(f"{allowed_database_upper}.")

    return False


def find_violations(
    grant_rows: list[dict[str, object]], role_name: str, allowed_database: str, allowed_warehouse: str
) -> list[str]:
    """Scans every `SHOW GRANTS TO ROLE` row and returns a human-readable
    description of each one that violates the DEV boundary — empty if none
    do.

    @param grant_rows: Rows as returned by a `DictCursor` running `SHOW
        GRANTS TO ROLE <role_name>`.
    @param role_name: The role being checked.
    @param allowed_database: The one database this role may touch.
    @param allowed_warehouse: The one warehouse this role may touch.
    @returns: Descriptions of every violating grant, empty if none.
    """
    violations = []
    for row in grant_rows:
        granted_on = str(row.get("granted_on", ""))
        name = str(row.get("name", ""))
        privilege = str(row.get("privilege", ""))
        if not is_allowed_grant(granted_on, name, role_name, allowed_database, allowed_warehouse):
            violations.append(f"{privilege} on {granted_on} {name}")
    return violations


def main() -> int:
    account = require_env("SNOWFLAKE_ACCOUNT")
    user = require_env("SNOWFLAKE_DEV_USER")
    role = require_env("SNOWFLAKE_DEV_ROLE")
    warehouse = require_env("SNOWFLAKE_DEV_WAREHOUSE")
    database = require_env("SNOWFLAKE_DEV_DATABASE")
    private_key_pem = require_env("SNOWFLAKE_DEV_PRIVATE_KEY")
    passphrase = os.environ.get("SNOWFLAKE_DEV_PRIVATE_KEY_PASSPHRASE") or None

    private_key_der = load_private_key_der(private_key_pem, passphrase)

    conn = snowflake.connector.connect(
        account=account,
        user=user,
        role=role,
        warehouse=warehouse,
        private_key=private_key_der,
    )
    try:
        cursor = conn.cursor(snowflake.connector.DictCursor)
        cursor.execute(f"SHOW GRANTS TO ROLE {role}")
        rows = cursor.fetchall()
    finally:
        conn.close()

    violations = find_violations(rows, role, database, warehouse)
    if violations:
        print(
            f"error: {role} has {len(violations)} grant(s) reaching outside "
            f"{database}/{warehouse}:",
            file=sys.stderr,
        )
        for violation in violations:
            print(f"  - {violation}", file=sys.stderr)
        return 1

    print(f"confirmed: all {len(rows)} grant(s) on {role} stay within {database}/{warehouse}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
