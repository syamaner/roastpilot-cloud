#!/usr/bin/env python3
"""Asserts the DEV-scoped CI service role's grants never extend beyond
ROASTPILOT_DEV / DEV_CI_WH (F1-S8, issue #11, factory.md §8).

Connects to Snowflake with the SAME identity the live contract-check job
uses (SNOWFLAKE_DEV_* env vars, key-pair/JWT auth) and checks seven
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
4. ``SHOW GRANTS TO ROLE PUBLIC`` — EVERY grant PUBLIC holds, anywhere, is
   a violation, not merely one that reaches outside the DEV boundary
   (Codex P1, PR #57, round 3). `AGENTS.md`'s own Architecture Invariant
   is "No grants to `PUBLIC`, anywhere" — a PUBLIC grant scoped entirely
   inside `ROASTPILOT_DEV`/`DEV_CI_WH` is still a violation of that
   invariant, so this check (`find_public_grants`) does NOT reuse the
   boundary-aware `is_allowed_grant`/`find_violations` logic checks #1 and
   #5 use — PUBLIC is held to a stricter, unconditional standard: zero
   grants, full stop. PUBLIC is also active for every Snowflake session
   regardless of secondary-roles settings, and its own grants never appear
   in `SHOW GRANTS TO ROLE <primary role>`'s output, so this audit is the
   only thing that catches a PUBLIC grant at all.
5. ``SHOW GRANTS TO USER <user>`` — confirms the CI service user itself
   has no role granted to it beyond the primary role (+ PUBLIC, which
   Snowflake grants to every user implicitly). Disabling secondary roles
   for THIS session (#3) only protects this audit's own connection; an
   extra role granted to the user could still activate in some OTHER
   session (the deploy step's connection, or a future job) unless the
   user-level grant itself is clean (Codex P1, PR #57, round 2).
6. ``SHOW FUTURE GRANTS TO ROLE <role>`` — every future grant defined for
   the primary role, across the WHOLE ACCOUNT, stays within the DEV
   boundary (Codex P1, PR #57, round 4 — corrects an earlier, WRONG claim
   in this module that no such query existed; `SHOW FUTURE GRANTS TO ROLE`
   is real, documented Snowflake syntax and does exactly this). A future
   grant (`GRANT ... ON FUTURE TABLES IN SCHEMA ...`) produces no row in
   check #1's `SHOW GRANTS TO ROLE` output and may target an object that
   doesn't exist yet, so without this it would be invisible to every other
   check here. Reuses `is_allowed_grant`'s boundary logic (`find_
   future_grant_violations`), since a future grant is fundamentally the
   same "stays within DEV" question as a current one — only the row shape
   differs (`grant_on`/`name` instead of `granted_on`/`name`, and `name`
   here is the CONTAINER the future grant is scoped to, not a specific
   object, since the object doesn't exist yet).
7. ``SHOW FUTURE GRANTS TO ROLE PUBLIC`` — same unconditional,
   zero-tolerance standard as check #4, applied to PUBLIC's future grants
   (Codex P1, PR #57, round 4): `AGENTS.md`'s "No grants to `PUBLIC`,
   anywhere" invariant doesn't carve out an exception for grants that
   haven't materialized yet.

This is the F1-S8 acceptance bar: a compromised or misbehaving agent
holding this role must never be able to touch PROD, PREVIEW, or any other
account-level object, and this check runs on every dispatch of the gated
job — not just at provisioning time — so a grant drift (an operator
accidentally widening the role later) is caught automatically, not just
verified once by hand via `SHOW GRANTS` at setup time.

`dev-snowflake-contract.yml` invokes this script TWICE, not once (Codex
P1, PR #57, round 3): once BEFORE the schemachange deploy step (the drift
gate — catches a grant that was already wrong going in, before writing
anything), and once AFTER it (the migration-output gate — catches a
migration that ITSELF introduces a forbidden grant, e.g. a bad `GRANT ...
TO PUBLIC` migration, which the pre-deploy run can never see since it
hasn't been applied yet). Checking only before deploy would let exactly
that class of bad migration pass, since deploy's own job is running the
migration's SQL, not judging whether that SQL was safe. This script itself
has no notion of "which invocation" it is — both runs are the identical,
stateless, full five-check audit; see the workflow file for the two call
sites and how a post-deploy failure fails the job.

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

Every identifier comparison (database, warehouse, role, and object name)
routes through ONE function, `identifiers_match` — a categorical fix
(Codex P1, PR #57, round 3), replacing three independently-patched bugs
that all stemmed from the same root cause: Snowflake quoted identifiers
preserve EXACT case and EXACT whitespace (a quoted `"roastpilot_dev"`, or
a quoted `"ROASTPILOT_DEV "` with a trailing space, is a genuinely
DIFFERENT object from unquoted `ROASTPILOT_DEV`), while unquoted
identifiers fold to uppercase at creation time.
- Case-folding a comparison (e.g. `.upper()` on a user-supplied
  identifier) would conflate a quoted, differently-cased lookalike with
  the real object.
- Stripping whitespace would conflate a quoted, whitespace-padded
  lookalike with the real object.
- Case-folding the system-PUBLIC-role check specifically
  (`role_name.upper() == "PUBLIC"`) would mistake a quoted, genuinely
  different role literally named `"public"` for the real system PUBLIC
  role and wrongly skip auditing it.
`identifiers_match` does none of that: it compares two strings BYTE FOR
BYTE, no `.strip()`, no `.upper()`/`.lower()`. Every identifier this
repo's own tooling creates is unquoted (normalized to uppercase at
creation time), so an exact match against the canonical uppercase name is
both correct and never a false rejection for anything this repo's own
migrations create — while a quoted, differently-cased OR
whitespace-padded lookalike, or the real Snowflake system `PUBLIC` role
being confused with a same-named-but-different quoted role, is now
correctly treated as NOT a match. A qualified object name (e.g.
`"ROASTPILOT_DEV.APP.SOME_TABLE"`) is compared by splitting on the first
`.` and matching that first component exactly, not `str.startswith`,
which is the same exact-match discipline applied to the qualifying
prefix rather than the whole string. Only `granted_on` (Snowflake's own
fixed, non-user-influenceable vocabulary — "DATABASE", "TABLE", etc.) is
still normalized (stripped + uppercased) for robustness, since that field
has no quoting/case ambiguity to begin with and isn't a comparison this
fix is scoped to.

This connects DIRECTLY via snowflake-connector-python (not through
schemachange, which has no equivalent of `SHOW GRANTS`), using the private
key CONTENT held in memory — never written to disk, unlike the schemachange
deploy step in the same job, which needs a temp file because schemachange's
own env-var layer only accepts a file path (see with_connection_env.py).

CORRECTED CLAIM (Codex P1, PR #57, round 4): an earlier version of this
module claimed, wrongly, that "there is no account-wide 'every future
grant this role has, anywhere' query" and treated the `SHOW DATABASES`/
`SHOW WAREHOUSES` visibility checks as the sole defense against the
future-grants class of drift. That claim was WRONG — `SHOW FUTURE GRANTS
TO ROLE <role>` is real, documented Snowflake syntax and IS exactly that
account-wide, role-filtered query; checks #6 and #7 above now use it
directly rather than relying on visibility as an indirect proxy. The
`SHOW DATABASES`/`SHOW WAREHOUSES` checks (#2) remain, as defense in
depth against OTHER visibility paths a future grant isn't the only
possible cause of (e.g. imported privileges, replication) — but they are
no longer this script's primary defense against future grants
specifically, checks #6/#7 are.

NOTE (operator-supervised validation required): the connection/query
mechanics below follow Snowflake's documented key-pair (JWT) auth flow and
`SHOW GRANTS TO ROLE`/`SHOW FUTURE GRANTS TO ROLE`/`SHOW GRANTS TO USER`/
`SHOW DATABASES`/`SHOW WAREHOUSES`'s documented output columns, and `USE
SECONDARY ROLES NONE`'s documented statement syntax, but this script has
never run against a real Snowflake session (no credentials available to
the agent that wrote it, per factory.md's own "agent jobs hold no
Snowflake secrets" invariant) — including the `SHOW FUTURE GRANTS`
column shapes (`grant_on`/`name`/`grantee_name` rather than `SHOW GRANTS
TO ROLE`'s `granted_on`/`name`/`granted_to`), which are taken from
Snowflake's own SQL command reference, not verified against a live
response. The FIRST real dispatch of the gated job is this script's
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
    if not identifiers_match(database, _EXPECTED_DATABASE):
        raise SystemExit(
            f"error: SNOWFLAKE_DEV_DATABASE is {database!r}, expected "
            f"{_EXPECTED_DATABASE!r} -- refusing to audit a boundary that "
            "may have silently drifted from the known-correct DEV database"
        )
    if not identifiers_match(warehouse, _EXPECTED_WAREHOUSE):
        raise SystemExit(
            f"error: SNOWFLAKE_DEV_WAREHOUSE is {warehouse!r}, expected "
            f"{_EXPECTED_WAREHOUSE!r} -- refusing to audit a boundary that "
            "may have silently drifted from the known-correct DEV warehouse"
        )


def identifiers_match(candidate: str, expected: str) -> bool:
    """True when two Snowflake identifiers are the EXACT same string
    (Codex P1, PR #57, round 3 — the categorical fix for :276/:376 and
    #58's L1, replacing three independently-patched symptoms of the same
    root cause).

    Snowflake quoted identifiers preserve exact case AND exact whitespace;
    unquoted identifiers fold to uppercase at creation time. This repo's
    own tooling only ever creates unquoted (canonical uppercase)
    identifiers, so comparing candidate/expected byte-for-byte -- no
    `.strip()`, no `.upper()`/`.lower()` -- is both correct for everything
    this repo creates and safe against a quoted, differently-cased or
    whitespace-padded lookalike slipping through as a false match. Every
    name/role/database/warehouse comparison in this module routes through
    this one function rather than each doing its own ad hoc normalization.

    @param candidate: The identifier as Snowflake actually returned it (or
        as an env var actually holds it).
    @param expected: The identifier this repo expects/allows.
    @returns: Whether they are exactly the same string.
    """
    return candidate == expected


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

    Comparisons for every user-influenceable identifier (`name`,
    `role_name`, `allowed_database`, `allowed_warehouse`) route through
    `identifiers_match` — an EXACT, byte-for-byte comparison; see the
    module docstring for why. `granted_on` is still stripped/uppercased:
    it's Snowflake's own fixed vocabulary, not a quotable identifier.

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

    if granted_on_upper == "WAREHOUSE":
        return identifiers_match(name, allowed_warehouse)

    if granted_on_upper == "ROLE":
        return identifiers_match(name, role_name)

    if granted_on_upper in _DATABASE_SCOPED_OBJECT_TYPES:
        # Compare the first dot-delimited component EXACTLY (Codex P1, PR
        # #57, round 3), not `str.startswith(f"{allowed_database}.")` --
        # splitting first and matching the resulting component with the
        # same exact-match discipline as every other identifier here,
        # rather than a substring-prefix check, is what closes #58's L1.
        first_component = name.split(".", 1)[0]
        return identifiers_match(first_component, allowed_database)

    return False


def find_violations(
    grant_rows: list[dict[str, object]], role_name: str, allowed_database: str, allowed_warehouse: str
) -> list[str]:
    """Scans every `SHOW GRANTS TO ROLE` row and returns a human-readable
    description of each one that violates the DEV boundary — empty if none
    do.

    Boundary-aware: a grant is fine as long as it stays within
    `allowed_database`/`allowed_warehouse`. Used for the primary role (#1)
    and the CI user's own role grants (#5, indirectly via
    `find_unexpected_user_role_grants`) — NOT for PUBLIC, which is held to
    an unconditional zero-grants standard regardless of boundary; see
    `find_public_grants`.

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


def find_public_grants(grant_rows: list[dict[str, object]]) -> list[str]:
    """Returns a human-readable description of EVERY grant PUBLIC holds —
    empty only if PUBLIC has none at all (Codex P1, PR #57, round 3).

    Deliberately does NOT reuse `find_violations`'s boundary-aware logic:
    `AGENTS.md`'s Architecture Invariant is "No grants to `PUBLIC`,
    anywhere" -- a PUBLIC grant scoped entirely inside
    `ROASTPILOT_DEV`/`DEV_CI_WH` is still a violation of that invariant, so
    checking PUBLIC against the DEV boundary (as an earlier version of
    this audit did) would wrongly ALLOW it. PUBLIC should have zero
    grants, full stop -- every row here is unconditionally a violation.

    @param grant_rows: Rows as returned by a `DictCursor` running `SHOW
        GRANTS TO ROLE PUBLIC`.
    @returns: Descriptions of every grant PUBLIC holds, empty if none.
    """
    return [
        f"{row.get('privilege', '')} on {row.get('granted_on', '')} {row.get('name', '')}"
        for row in grant_rows
    ]


def find_future_grant_violations(
    future_grant_rows: list[dict[str, object]],
    role_name: str,
    allowed_database: str,
    allowed_warehouse: str,
) -> list[str]:
    """Scans every `SHOW FUTURE GRANTS TO ROLE` row and returns a
    human-readable description of each one that violates the DEV boundary
    — empty if none do (Codex P1, PR #57, round 4).

    `SHOW FUTURE GRANTS` rows use a DIFFERENT column name for the object
    type than `SHOW GRANTS` does -- `grant_on`, not `granted_on` -- and
    `name` holds the CONTAINER (a database or schema) the future grant is
    scoped to, not a specific object name, since the object doesn't exist
    yet. Reuses `is_allowed_grant` regardless: a future grant's `grant_on`
    value is one of the same `_DATABASE_SCOPED_OBJECT_TYPES` (TABLE, VIEW,
    SCHEMA, ...) `is_allowed_grant` already knows how to evaluate, and its
    container `name` is checked with the exact same first-dot-component
    boundary logic as a current grant's fully-qualified object name.

    @param future_grant_rows: Rows as returned by a `DictCursor` running
        `SHOW FUTURE GRANTS TO ROLE <role_name>`.
    @param role_name: The role being checked.
    @param allowed_database: The one database this role may touch.
    @param allowed_warehouse: The one warehouse this role may touch.
    @returns: Descriptions of every violating future grant, empty if none.
    """
    violations = []
    for row in future_grant_rows:
        grant_on = str(row.get("grant_on", ""))
        name = str(row.get("name", ""))
        privilege = str(row.get("privilege", ""))
        if not is_allowed_grant(grant_on, name, role_name, allowed_database, allowed_warehouse):
            violations.append(f"{privilege} on future {grant_on} in {name}")
    return violations


def find_public_future_grants(future_grant_rows: list[dict[str, object]]) -> list[str]:
    """Returns a human-readable description of EVERY future grant PUBLIC
    holds — empty only if PUBLIC has none at all (Codex P1, PR #57, round
    4).

    Same unconditional standard as `find_public_grants`, applied to `SHOW
    FUTURE GRANTS TO ROLE PUBLIC` rows (which use `grant_on`, not
    `granted_on` -- see `find_future_grant_violations`): `AGENTS.md`'s "No
    grants to PUBLIC, anywhere" invariant doesn't carve out an exception
    for grants that haven't materialized yet.

    @param future_grant_rows: Rows as returned by a `DictCursor` running
        `SHOW FUTURE GRANTS TO ROLE PUBLIC`.
    @returns: Descriptions of every future grant PUBLIC holds, empty if
        none.
    """
    return [
        f"{row.get('privilege', '')} on future {row.get('grant_on', '')} in {row.get('name', '')}"
        for row in future_grant_rows
    ]


def find_out_of_bounds_names(visible_names: list[str], allowed_name: str) -> list[str]:
    """Filters a list of visible object names (from `SHOW DATABASES` or
    `SHOW WAREHOUSES`) down to whichever ones are NOT the one allowed name
    — i.e. anything this role can see beyond its intended boundary.

    Catches what `SHOW GRANTS TO ROLE` alone can miss (Codex P1, PR #57):
    a future grant, an account-level visibility path, or any other
    mechanism that makes an object visible/usable to this role without a
    corresponding row in `SHOW GRANTS`'s own output. Comparison is an
    EXACT match via `identifiers_match`, same reasoning as
    `is_allowed_grant`.

    @param visible_names: Object names as returned by `SHOW DATABASES`/
        `SHOW WAREHOUSES` (the `name` column).
    @param allowed_name: The one name this role should see.
    @returns: Every visible name that isn't the allowed one.
    """
    return [name for name in visible_names if not identifiers_match(name, allowed_name)]


def find_unexpected_user_role_grants(
    user_role_rows: list[dict[str, object]], expected_role: str
) -> list[str]:
    """Scans `SHOW GRANTS TO USER` rows and returns every granted role name
    other than the expected primary role and PUBLIC (Codex P1, PR #57,
    round 2).

    PUBLIC is implicitly granted to every Snowflake user and can't be
    revoked, so it's excluded here deliberately -- it's audited separately
    via `find_public_grants` against PUBLIC's own `SHOW GRANTS TO ROLE
    PUBLIC` rows, not flagged as an unexpected user-role grant. Any OTHER
    role reaching this far means the CI service user itself carries a role
    beyond the one this whole audit was scoped to -- a role that could
    activate as a secondary role in some OTHER session (not just this
    script's own, which disables secondary roles for itself) unless the
    user-level grant is clean.

    The system PUBLIC role is matched via `identifiers_match(role_name,
    "PUBLIC")` -- an EXACT comparison, not `role_name.upper() == "PUBLIC"`
    (Codex P1, PR #57, round 3): the real system PUBLIC role is always the
    literal, unquoted, uppercase string `PUBLIC`, so case-folding the
    comparison would incorrectly treat a QUOTED, genuinely different role
    literally named `"public"` as if it were the real system role and
    wrongly skip auditing it -- exactly the kind of role that could later
    activate as a secondary role and contribute unaudited privileges.

    @param user_role_rows: Rows as returned by a `DictCursor` running `SHOW
        GRANTS TO USER <user>` -- each row's `role` column names a granted
        role.
    @param expected_role: The one role this user should have, beyond
        PUBLIC.
    @returns: Names of every unexpected role granted to the user, empty if
        none.
    """
    unexpected = []
    for row in user_role_rows:
        role_name = str(row.get("role", ""))
        if not role_name:
            continue
        if identifiers_match(role_name, expected_role):
            continue
        if identifiers_match(role_name, "PUBLIC"):
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

        # Codex P1, PR #57, round 4 -- see the module docstring's points 6
        # and 7. Corrects an earlier, WRONG claim that no account-wide
        # future-grants query existed for a role.
        cursor.execute(f"SHOW FUTURE GRANTS TO ROLE {role}")
        future_grant_rows = cursor.fetchall()

        cursor.execute("SHOW FUTURE GRANTS TO ROLE PUBLIC")
        public_future_grant_rows = cursor.fetchall()
    finally:
        conn.close()

    violations = find_violations(grant_rows, role, database, warehouse)
    # Codex P1, PR #57, round 3: PUBLIC is held to an unconditional
    # zero-grants standard (AGENTS.md's "No grants to PUBLIC, anywhere"),
    # not the boundary-aware check the primary role gets -- see
    # find_public_grants's own docstring.
    public_violations = find_public_grants(public_grant_rows)
    out_of_bounds_databases = find_out_of_bounds_names(visible_databases, database)
    out_of_bounds_warehouses = find_out_of_bounds_names(visible_warehouses, warehouse)
    unexpected_user_roles = find_unexpected_user_role_grants(user_role_rows, role)
    future_violations = find_future_grant_violations(future_grant_rows, role, database, warehouse)
    public_future_violations = find_public_future_grants(public_future_grant_rows)

    if (
        violations
        or public_violations
        or out_of_bounds_databases
        or out_of_bounds_warehouses
        or unexpected_user_roles
        or future_violations
        or public_future_violations
    ):
        print(
            f"error: {role}/PUBLIC/{user} fail the DEV boundary or PUBLIC-grants audit:",
            file=sys.stderr,
        )
        for violation in violations:
            print(f"  - grant on {role} outside {database}/{warehouse}: {violation}", file=sys.stderr)
        for violation in public_violations:
            print(f"  - PUBLIC grant (PUBLIC must have none, anywhere): {violation}", file=sys.stderr)
        for extra_database in out_of_bounds_databases:
            print(f"  - visible database beyond the DEV boundary: {extra_database}", file=sys.stderr)
        for extra_warehouse in out_of_bounds_warehouses:
            print(f"  - visible warehouse beyond the DEV boundary: {extra_warehouse}", file=sys.stderr)
        for extra_role in unexpected_user_roles:
            print(f"  - unexpected role granted to {user}: {extra_role}", file=sys.stderr)
        for violation in future_violations:
            print(f"  - future grant on {role} outside {database}/{warehouse}: {violation}", file=sys.stderr)
        for violation in public_future_violations:
            print(f"  - PUBLIC future grant (PUBLIC must have none, anywhere): {violation}", file=sys.stderr)
        return 1

    print(
        f"confirmed: all {len(grant_rows)} grant(s) (+ {len(future_grant_rows)} future grant(s)) on "
        f"{role} stay within {database}/{warehouse}, PUBLIC holds zero current or future grants, "
        f"no other database/warehouse is visible, and {user} has no unexpected role grants"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
