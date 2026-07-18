#!/usr/bin/env python3
"""Asserts the DEV-scoped CI service role's grants never extend beyond
ROASTPILOT_DEV / DEV_CI_WH (F1-S8, issue #11, factory.md §8).

Connects to Snowflake with the SAME identity the live contract-check job
uses (SNOWFLAKE_DEV_* env vars, key-pair/JWT auth) and checks five
independent things, all of which must pass:

1. ``SHOW GRANTS TO ROLE <role>`` — every CURRENT object grant on the
   primary role stays within the DEV database/warehouse.
2. ``SHOW DATABASES`` / ``SHOW WAREHOUSES`` — the role can't even SEE
   another database/warehouse (Codex P1, PR #57: a future grant, or any
   other account-level visibility path, can hand this role access to an
   object with no corresponding row in #1's `SHOW GRANTS` output at all —
   visibility is the thing that's actually exploitable, so it's checked
   directly rather than trying to enumerate every possible grant
   mechanism that could produce it).
3. Secondary roles are disabled for this session via
   ``USE SECONDARY ROLES NONE`` — a real SQL STATEMENT, executed right
   after connecting and before any audit query (Codex P1, PR #57, round
   2). An earlier version of this fix tried
   ``session_parameters={"USE_SECONDARY_ROLES": "NONE"}`` on `connect()`;
   that is invalid — `USE SECONDARY ROLES` is not a settable Snowflake
   session parameter, it's a standalone command, and
   snowflake-connector-python's `session_parameters` kwarg only applies
   genuine parameter name/value pairs (verified against the installed
   connector's own source: zero references to `SECONDARY_ROLES` anywhere,
   and `session_parameters` is threaded straight into the connection
   bootstrap as parameter assignments, never as SQL). That version quietly
   left secondary roles ON. Without disabling them, the CI user having ANY
   other role granted to it (even one never intended for this job) could
   contribute additional, unaudited privileges to an effective session,
   independent of what the PRIMARY role's own grants say. This only
   protects THIS script's own connection — the schemachange deploy step's
   connection (see `dev-snowflake-contract.yml`) has no equivalent
   mid-session hook, so it's covered instead by an operator-run
   ``ALTER USER ROASTPILOT_DEV_CI SET DEFAULT_SECONDARY_ROLES = ()``,
   which stops secondary roles activating by default on ANY connection
   this user makes, this script's included.
4. ``SHOW GRANTS TO ROLE PUBLIC`` — PUBLIC is active for every Snowflake
   session regardless of secondary-roles settings, and its own grants
   never appear in `SHOW GRANTS TO ROLE <primary role>`'s output (Codex
   P1, PR #57, round 2). A PUBLIC grant reaching outside the DEV boundary
   would otherwise go completely unaudited by checks #1–#2 above.
5. ``SHOW GRANTS TO USER <user>`` — confirms the CI service user itself
   has no role granted to it beyond the primary role (+ PUBLIC, which
   Snowflake grants to every user implicitly). Disabling secondary roles
   for THIS session (#3) only protects this audit's own connection; an
   extra role granted to the user could still activate in some OTHER
   session (the deploy step's connection, or a future job) unless the
   user-level grant itself is clean (Codex P1, PR #57, round 2).

This is the F1-S8 acceptance bar: a compromised or misbehaving agent
holding this role must never be able to touch PROD, PREVIEW, or any other
account-level object, and this check runs on every dispatch of the gated
job — not just at provisioning time — so a grant drift (an operator
accidentally widening the role later) is caught automatically, not just
verified once by hand via `SHOW GRANTS` at setup time. It also runs
BEFORE the schemachange deploy step in the same job (Codex P1, PR #57):
checking the boundary AFTER migrations have already been applied would
let a drifted role's damage happen before this script ever reports it —
the whole point is to catch drift before it can be used, not just narrate
it afterward.

Before connecting at all, `main()` also asserts the
`SNOWFLAKE_DEV_DATABASE`/`SNOWFLAKE_DEV_WAREHOUSE` env vars still equal
the known-correct literals `ROASTPILOT_DEV`/`DEV_CI_WH` (Codex P2, PR #57,
round 2) — every check above trusts those vars AS the allowed boundary, so
if they were ever accidentally (or maliciously) repointed, the whole
script would silently "bless" the wrong object instead of catching the
drift. This assertion anchors the boundary to a value that can't move
just because an env var did.

Deliberately fails CLOSED: an unrecognized object type (a Snowflake
privilege/object kind this allowlist doesn't know about) is treated as a
VIOLATION, never silently permitted — see `is_allowed_grant`.

Identifier comparisons are CASE-SENSITIVE, not normalized to uppercase
(Codex P1, PR #57): Snowflake preserves the exact case of a QUOTED
identifier (`"roastpilot_dev"` is a genuinely different object from
`ROASTPILOT_DEV`), so uppercasing both sides before comparing would
conflate the two — a quoted, lowercase, out-of-bounds object would
incorrectly pass. Every identifier this repo's own tooling creates is
unquoted (Snowflake normalizes those to uppercase at creation time), so
comparing case-sensitively against the canonical uppercase name is both
correct and never a false rejection for anything this repo's own
migrations create. Only `granted_on` (Snowflake's own fixed, non-user-
influenceable vocabulary — "DATABASE", "TABLE", etc.) is still normalized
for robustness, since that field has no quoting/case ambiguity to begin
with.

This connects DIRECTLY via snowflake-connector-python (not through
schemachange, which has no equivalent of `SHOW GRANTS`), using the private
key CONTENT held in memory — never written to disk, unlike the schemachange
deploy step in the same job, which needs a temp file because schemachange's
own env-var layer only accepts a file path (see with_connection_env.py).

KNOWN RESIDUAL GAP (documented, not silently ignored): Snowflake's
`SHOW FUTURE GRANTS` command is scoped `IN DATABASE <db>` / `IN SCHEMA
<schema>` — there is no account-wide "every future grant this role has,
anywhere" query. The `SHOW DATABASES`/`SHOW WAREHOUSES` visibility checks
above are this script's actual defense against the future-grants class of
drift: a future grant can only ever matter if it makes some OTHER
database/warehouse visible or usable, and both are checked directly. A
future grant scoped entirely WITHIN the already-allowed
ROASTPILOT_DEV/DEV_CI_WH boundary is, definitionally, not a boundary
violation. If Snowflake ever exposes an account-wide future-grants
listing, tighten this further — tracked as a residual item, not built
speculatively against undocumented/unverified syntax.

NOTE (operator-supervised validation required): the connection/query
mechanics below follow Snowflake's documented key-pair (JWT) auth flow and
`SHOW GRANTS TO ROLE`/`SHOW GRANTS TO USER`/`SHOW DATABASES`/
`SHOW WAREHOUSES`'s documented output columns, and `USE SECONDARY ROLES
NONE`'s documented statement syntax, but this script has never run against
a real Snowflake session (no credentials available to the agent that
wrote it, per factory.md's own "agent jobs hold no Snowflake secrets"
invariant). The FIRST real dispatch of the gated job is this script's
actual validation — same "the operator's live dispatch doubles as the
audit" pattern already used elsewhere in this repo for code that can't be
verified without live infrastructure access. The operator is also
responsible for running
``ALTER USER ROASTPILOT_DEV_CI SET DEFAULT_SECONDARY_ROLES = ()`` (an
account-level, elevated-privilege action) before that first dispatch — see
point 3 above.
"""

from __future__ import annotations

import os
import sys

import snowflake.connector
from cryptography.hazmat.primitives import serialization

# Snowflake object types (SHOW GRANTS' own `granted_on` column values) this
# check knows how to evaluate against the DEV database. Anything NOT in this
# set (ACCOUNT, INTEGRATION, USER, or any future object type Snowflake
# introduces) is rejected outright by is_allowed_grant's fail-closed
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

# The known-correct DEV boundary (Codex P2, PR #57, round 2). Every check in
# this script trusts SNOWFLAKE_DEV_DATABASE/SNOWFLAKE_DEV_WAREHOUSE (env
# vars, sourced the same way the deploy step's connection is) AS the allowed
# boundary -- these literals exist purely to catch that trust being misplaced
# if either var ever drifts from the value it's actually supposed to have.
# See assert_boundary_vars_not_drifted.
_EXPECTED_DATABASE = "ROASTPILOT_DEV"
_EXPECTED_WAREHOUSE = "DEV_CI_WH"


def require_env(name: str) -> str:
    """Reads a required environment variable, failing loudly if missing."""
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"error: missing required environment variable: {name}")
    return value


def assert_boundary_vars_not_drifted(database: str, warehouse: str) -> None:
    """Fails loudly if the DEV boundary env vars have drifted from their
    known-correct literal values (Codex P2, PR #57, round 2).

    Every check in this script treats `database`/`warehouse` (sourced from
    `SNOWFLAKE_DEV_DATABASE`/`SNOWFLAKE_DEV_WAREHOUSE`) AS the allowed
    boundary. That's deliberate -- it's the same source the deploy step's
    own connection uses, so the check and the deploy can never silently
    audit a different object than what was actually deployed to (see
    `is_allowed_grant`'s docstring). But it also means an accidental (or
    malicious) repoint of either var would make this whole script "bless"
    the wrong database/warehouse instead of catching the drift. This
    assertion anchors the boundary to a value that can't move just because
    an env var did.

    @param database: The `SNOWFLAKE_DEV_DATABASE` value to verify.
    @param warehouse: The `SNOWFLAKE_DEV_WAREHOUSE` value to verify.
    @raises SystemExit: If either value doesn't match the expected literal.
    """
    if database != _EXPECTED_DATABASE:
        raise SystemExit(
            f"error: SNOWFLAKE_DEV_DATABASE is {database!r}, expected "
            f"{_EXPECTED_DATABASE!r} -- refusing to audit a boundary that "
            "may have silently drifted from the known-correct DEV database"
        )
    if warehouse != _EXPECTED_WAREHOUSE:
        raise SystemExit(
            f"error: SNOWFLAKE_DEV_WAREHOUSE is {warehouse!r}, expected "
            f"{_EXPECTED_WAREHOUSE!r} -- refusing to audit a boundary that "
            "may have silently drifted from the known-correct DEV warehouse"
        )


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
    actually deployed to. `main()` separately anchors those vars against
    silent drift -- see `assert_boundary_vars_not_drifted`.

    Comparisons are CASE-SENSITIVE for every user-influenceable identifier
    (`name`, `role_name`, `allowed_database`, `allowed_warehouse`) — see
    the module docstring for why uppercasing both sides would let a
    quoted, differently-cased object slip through. `granted_on` is still
    normalized to uppercase: it's Snowflake's own fixed vocabulary, not a
    quotable identifier.

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
    name_stripped = name.strip()

    if granted_on_upper == "WAREHOUSE":
        return name_stripped == allowed_warehouse.strip()

    if granted_on_upper == "ROLE":
        return name_stripped == role_name.strip()

    if granted_on_upper in _DATABASE_SCOPED_OBJECT_TYPES:
        allowed_database_stripped = allowed_database.strip()
        return name_stripped == allowed_database_stripped or name_stripped.startswith(
            f"{allowed_database_stripped}."
        )

    return False


def find_violations(
    grant_rows: list[dict[str, object]], role_name: str, allowed_database: str, allowed_warehouse: str
) -> list[str]:
    """Scans every `SHOW GRANTS TO ROLE` row and returns a human-readable
    description of each one that violates the DEV boundary — empty if none
    do.

    Also used to audit PUBLIC's own grants (Codex P1, PR #57, round 2): the
    caller passes `role_name="PUBLIC"` and PUBLIC's own `SHOW GRANTS TO
    ROLE PUBLIC` rows, reusing the exact same boundary logic rather than
    duplicating it for a second role.

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


def find_out_of_bounds_names(visible_names: list[str], allowed_name: str) -> list[str]:
    """Filters a list of visible object names (from `SHOW DATABASES` or
    `SHOW WAREHOUSES`) down to whichever ones are NOT the one allowed name
    — i.e. anything this role can see beyond its intended boundary.

    Catches what `SHOW GRANTS TO ROLE` alone can miss (Codex P1, PR #57):
    a future grant, an account-level visibility path, or any other
    mechanism that makes an object visible/usable to this role without a
    corresponding row in `SHOW GRANTS`'s own output. Comparison is
    case-sensitive, same reasoning as `is_allowed_grant`.

    @param visible_names: Object names as returned by `SHOW DATABASES`/
        `SHOW WAREHOUSES` (the `name` column).
    @param allowed_name: The one name this role should see.
    @returns: Every visible name that isn't the allowed one.
    """
    allowed_stripped = allowed_name.strip()
    return [name for name in visible_names if name.strip() != allowed_stripped]


def find_unexpected_user_role_grants(
    user_role_rows: list[dict[str, object]], expected_role: str
) -> list[str]:
    """Scans `SHOW GRANTS TO USER` rows and returns every granted role name
    other than the expected primary role and PUBLIC (Codex P1, PR #57,
    round 2).

    PUBLIC is implicitly granted to every Snowflake user and can't be
    revoked, so it's excluded here deliberately -- it's audited separately
    via `find_violations(..., role_name="PUBLIC", ...)` against PUBLIC's
    own `SHOW GRANTS TO ROLE PUBLIC` rows, not flagged as an unexpected
    user-role grant. Any OTHER role reaching this far means the CI service
    user itself carries a role beyond the one this whole audit was scoped
    to -- a role that could activate as a secondary role in some OTHER
    session (not just this script's own, which disables secondary roles
    for itself) unless the user-level grant is clean.

    @param user_role_rows: Rows as returned by a `DictCursor` running `SHOW
        GRANTS TO USER <user>` -- each row's `role` column names a granted
        role.
    @param expected_role: The one role this user should have, beyond
        PUBLIC.
    @returns: Names of every unexpected role granted to the user, empty if
        none.
    """
    expected_role_stripped = expected_role.strip()
    unexpected = []
    for row in user_role_rows:
        role_name = str(row.get("role", "")).strip()
        if not role_name:
            continue
        if role_name == expected_role_stripped:
            continue
        if role_name.upper() == "PUBLIC":
            continue
        unexpected.append(role_name)
    return unexpected


def main() -> int:
    account = require_env("SNOWFLAKE_ACCOUNT")
    user = require_env("SNOWFLAKE_DEV_USER")
    role = require_env("SNOWFLAKE_DEV_ROLE")
    warehouse = require_env("SNOWFLAKE_DEV_WAREHOUSE")
    database = require_env("SNOWFLAKE_DEV_DATABASE")
    private_key_pem = require_env("SNOWFLAKE_DEV_PRIVATE_KEY")
    passphrase = os.environ.get("SNOWFLAKE_DEV_PRIVATE_KEY_PASSPHRASE") or None

    assert_boundary_vars_not_drifted(database, warehouse)

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

        # Codex P1, PR #57, round 2 -- see the module docstring's point 3.
        # USE SECONDARY ROLES is a SQL STATEMENT, not a settable session
        # parameter; issuing it here, before any audit query below, is what
        # actually confines this session to the primary role alone.
        cursor.execute("USE SECONDARY ROLES NONE")

        cursor.execute(f"SHOW GRANTS TO ROLE {role}")
        grant_rows = cursor.fetchall()

        cursor.execute("SHOW DATABASES")
        visible_databases = [str(row["name"]) for row in cursor.fetchall()]

        cursor.execute("SHOW WAREHOUSES")
        visible_warehouses = [str(row["name"]) for row in cursor.fetchall()]

        # Codex P1, PR #57, round 2 -- see the module docstring's point 4.
        cursor.execute("SHOW GRANTS TO ROLE PUBLIC")
        public_grant_rows = cursor.fetchall()

        # Codex P1, PR #57, round 2 -- see the module docstring's point 5.
        cursor.execute(f"SHOW GRANTS TO USER {user}")
        user_role_rows = cursor.fetchall()
    finally:
        conn.close()

    violations = find_violations(grant_rows, role, database, warehouse)
    public_violations = find_violations(public_grant_rows, "PUBLIC", database, warehouse)
    out_of_bounds_databases = find_out_of_bounds_names(visible_databases, database)
    out_of_bounds_warehouses = find_out_of_bounds_names(visible_warehouses, warehouse)
    unexpected_user_roles = find_unexpected_user_role_grants(user_role_rows, role)

    if (
        violations
        or public_violations
        or out_of_bounds_databases
        or out_of_bounds_warehouses
        or unexpected_user_roles
    ):
        print(
            f"error: {role} reaches outside {database}/{warehouse}:",
            file=sys.stderr,
        )
        for violation in violations:
            print(f"  - grant: {violation}", file=sys.stderr)
        for violation in public_violations:
            print(f"  - PUBLIC grant: {violation}", file=sys.stderr)
        for extra_database in out_of_bounds_databases:
            print(f"  - visible database beyond the DEV boundary: {extra_database}", file=sys.stderr)
        for extra_warehouse in out_of_bounds_warehouses:
            print(f"  - visible warehouse beyond the DEV boundary: {extra_warehouse}", file=sys.stderr)
        for extra_role in unexpected_user_roles:
            print(f"  - unexpected role granted to {user}: {extra_role}", file=sys.stderr)
        return 1

    print(
        f"confirmed: all {len(grant_rows)} grant(s) on {role} and {len(public_grant_rows)} on PUBLIC "
        f"stay within {database}/{warehouse}, no other database/warehouse is visible, and {user} "
        "has no unexpected role grants"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
