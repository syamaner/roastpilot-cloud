#!/usr/bin/env python3
"""Asserts the DEV-scoped CI service role's grants never extend beyond
ROASTPILOT_DEV / DEV_CI_WH (F1-S8, issue #11, factory.md §8).

Connects to Snowflake with the SAME identity the live contract-check job
uses (SNOWFLAKE_DEV_* env vars, key-pair/JWT auth) and checks ten
independent things, all of which must pass:

1. ``SHOW GRANTS TO ROLE <role>`` — every CURRENT object grant on the
   primary role stays within the DEV database/warehouse.
2. ``SHOW DATABASES`` / ``SHOW WAREHOUSES`` — apart from an exact
   allowlist of Snowflake-owned, non-writable account defaults (D-11-A),
   the role can't even SEE another database/warehouse (Codex P1, PR #57:
   a future grant, or any
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
4. ``SHOW GRANTS TO ROLE PUBLIC`` — a visible PUBLIC grant is flagged iff
   it targets our DEV database container, our DEV warehouse, or any role
   other than an enumerated Snowflake-owned account default. A role granted
   to PUBLIC hands every principal that role's access, so a non-default
   role-to-PUBLIC grant is never legitimate for us. Account-level privileges
   are also flagged except for an enumerated set of Snowflake-owned defaults,
   because PUBLIC hands every other account capability to every principal.
   Other Snowflake-owned and account-default grants are structurally out of
   scope because they can never reach our data. Each allowlisted default role
   granted to PUBLIC is queried one level deeper: any of that role's own grants
   reaching the DEV database or warehouse is flagged as a transitive exposure.
   Deeper role-to-role/account-privilege reachability remains a documented #59
   residual. The property is deliberately independent from both the visibility
   allowlist and `is_allowed_grant`'s known-type gate: every known or unknown
   object type whose exact container is `ROASTPILOT_DEV` fails closed.
   COMPLETENESS LIMIT (Codex P1, PR #57, round 5, :596 — tracked #59,
   don't over-fix here): `SHOW GRANTS TO ROLE PUBLIC`, run BY this
   DEV-scoped role, is only guaranteed to show grants within this role's
   OWN visibility -- true account-wide completeness would need `MANAGE
   GRANTS`, a broad, account-level privilege this role deliberately does
   NOT hold (granting it would contradict the whole minimal-role premise
   this audit exists to enforce). So this check is a DEV-visibility-scoped,
   best-effort DETECTIVE control, not an account-wide guarantee that
   PUBLIC truly has zero grants everywhere. The actual account-wide "no
   grants to PUBLIC" enforcement is layered elsewhere, not in this one
   query: `check_forbidden_grants.py`'s pre-deploy migration scan
   (preventive), the `AGENTS.md` invariant itself (policy), and account
   provisioning discipline (nothing should ever grant to PUBLIC in the
   first place). A residual PUBLIC grant this check can't see is still
   contained to whatever this role can't see either -- not a PROD
   exposure, since F1-S8's blast-radius guarantee doesn't depend on this
   specific check being complete.
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
   haven't materialized yet. Same COMPLETENESS LIMIT as check #4 applies
   here too — DEV-visibility-scoped, not an account-wide guarantee; see
   check #4's note.
8. ``SHOW USERS LIKE '<user>'`` — verifies the CI service user's
   `DEFAULT_SECONDARY_ROLES` property is actually empty (Codex P1, PR #57,
   round 5, :270). The operator-run `ALTER USER ROASTPILOT_DEV_CI SET
   DEFAULT_SECONDARY_ROLES = ()` (see point 3) is what's SUPPOSED to keep
   secondary roles off the deploy connection, but it's a manual,
   account-level action this script has no way to enforce or re-run —
   only to VERIFY. If that command is ever missed (e.g. the user gets
   re-created without it), the deploy connection's secondary-roles
   protection silently disappears with no code-visible signal. This check
   turns that silent operator dependency into a verified precondition,
   checked on every dispatch, in both the pre- and post-deploy audits
   (`find_default_secondary_roles_violation`). `LIKE` treats each
   underscore as a wildcard, so the query can over-match a lookalike user
   name -- `find_default_secondary_roles_violation` never trusts row
   order or assumes the first row is the real one; it filters to the
   row(s) whose own `name` exactly matches the configured user
   (uppercase-compared) and fails closed unless exactly one such row
   exists (Codex P1, PR #57, round 6, :709/:710 -- a real bug in the
   round-5 version, where `user_rows[0]` was trusted unconditionally).
9. ``SHOW GRANTS TO ROLE PUBLIC_WEB`` and ``... ROASTPILOT_AGENT`` — the
   grants in the DEV database container must exactly equal the per-privilege
   #317 manifest plus pinned database/schema USAGE prerequisites. The shared
   account-level roles may also use the explicitly allowlisted warehouse.
   ROASTPILOT_AGENT's PREVIEW/prod objects remain owned by future per-environment
   audits; PUBLIC_WEB is restricted within the operator-confirmed
   DEV/PREVIEW/prod database family to byte-exact, environment-invariant #317
   objects plus database/schema prerequisites, all without grant option. Other
   database families, warehouses, and any role/account/unknown-shape
   grants fail closed. DEV extra, missing, and byte-lookalike rows also fail
   closed, as does a true, absent, or unrecognized `grant_option`. The object
   core is derived from
   `check_grant_manifest.py` and canonicalized to the database-qualified,
   uppercase form returned by live `SHOW GRANTS`, not independently retyped.
10. ``SHOW FUTURE GRANTS TO ROLE`` for both application roles — the exact
    manifest defines no future grants, so every visible row is a violation.

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
stateless, full ten-check audit; see the workflow file for the two call
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

The role and CI user are interpolated into four `SHOW` statements below
(Snowflake takes an identifier there, in a position that accepts no bind
parameter). `main()` refuses either value up front unless it is a bare
unquoted identifier — see `assert_sql_identifier_safe` for why that check
exists even though a hostile value already fails closed without it (#58's
L3).

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
`SHOW USERS`/`SHOW DATABASES`/`SHOW WAREHOUSES`'s documented output
columns, and `USE SECONDARY ROLES NONE`'s documented statement syntax, but
this script has never run against a real Snowflake session (no
credentials available to the agent that wrote it, per factory.md's own
"agent jobs hold no Snowflake secrets" invariant) — including the `SHOW
FUTURE GRANTS` column shapes (`grant_on`/`name`/`grantee_name` rather than
`SHOW GRANTS TO ROLE`'s `granted_on`/`name`/`granted_to`), which are taken
from Snowflake's own SQL command reference, not verified against a live
response. The `SHOW USERS`/`default_secondary_roles` column's EXACT
returned representation for an empty set is the least certain of these —
`find_default_secondary_roles_violation` deliberately recognizes only the
specific empty-set forms documented/expected (`"[]"` or an already-parsed
empty list) and fails CLOSED on anything else, including a representation
this check doesn't recognize, rather than guessing at an unfamiliar shape
and risking a false pass. The FIRST real dispatch of the gated job is this
script's actual validation — same "the operator's live dispatch doubles as
the audit" pattern already used elsewhere in this repo for code that can't
be verified without live infrastructure access. The operator is also
responsible for running
``ALTER USER ROASTPILOT_DEV_CI SET DEFAULT_SECONDARY_ROLES = ()`` (an
account-level, elevated-privilege action) before that first dispatch — see
point 3 above; check #8 verifies that action actually took effect, rather
than trusting it happened.
"""

from __future__ import annotations

import importlib.util
import os
import re
import sys
from pathlib import Path
from types import ModuleType

import snowflake.connector
from cryptography.hazmat.primitives import serialization


def _load_sibling_module(module_name: str) -> ModuleType:  # pragma: no mutate block
    """Load a sibling by resolved path under ``python -P``."""
    module_path = Path(__file__).resolve().parent / f"{module_name}.py"
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:  # pragma: no cover
        raise ImportError(f"cannot construct a loader for sibling module {module_name!r}")
    module = importlib.util.module_from_spec(spec)
    # dataclasses resolves postponed annotations through sys.modules while
    # the sibling executes, so register this path-anchored module first.
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except FileNotFoundError as exc:
        sys.modules.pop(module_name, None)
        raise ImportError(f"cannot load sibling module {module_name!r} from {module_path}") from exc
    except BaseException:
        sys.modules.pop(module_name, None)
        raise
    return module


check_grant_manifest = _load_sibling_module("check_grant_manifest")

# Snowflake object types (SHOW GRANTS' own `granted_on` column values) this
# check knows how to evaluate against the DEV database. Anything NOT in this
# set (ACCOUNT, INTEGRATION, USER, or any future object type Snowflake
# introduces) is rejected outright by is_allowed_grant's fail-closed
# default -- never silently permitted just because it wasn't anticipated.
#
# CONFIRMED byte-for-byte against the operator's 2026-09-01 live capture
# against ROASTPILOT_DEV under ROASTPILOT_ADMIN: a throwaway file format
# returned `USAGE | FILE_FORMAT | ROASTPILOT_DEV.APP.TMP_GRANTED_ON_PROBE`.
# Its grant was revoked and the probe object was dropped after the capture;
# cleanup was confirmed.
# INFERRED, not probed: MATERIALIZED_VIEW follows Snowflake's consistently
# underscore-delimited multi-word SHOW GRANTS vocabulary. Creating the probe
# object would require Enterprise edition, so do not treat it as observed.
# The other eleven entries are single-word, where this space/underscore
# ambiguity cannot arise.
_DATABASE_SCOPED_OBJECT_TYPES = frozenset(
    {
        "DATABASE",
        "SCHEMA",
        "TABLE",
        "VIEW",
        "MATERIALIZED_VIEW",
        "STAGE",
        "FILE_FORMAT",
        "SEQUENCE",
        "PROCEDURE",
        "FUNCTION",
        "STREAM",
        "TASK",
        "PIPE",
    }
)

_SNOWFLAKE_DEFAULT_DATABASES = frozenset({"SNOWFLAKE", "SNOWFLAKE_SAMPLE_DATA", "SNOWFLAKE_LEARNING_DB"})
_SNOWFLAKE_DEFAULT_WAREHOUSES = frozenset({"SNOWFLAKE_LEARNING_WH", "SYSTEM$STREAMLIT_NOTEBOOK_WH"})
_SNOWFLAKE_DEFAULT_ROLES = frozenset({"SNOWFLAKE_LEARNING_ROLE"})
_SNOWFLAKE_DEFAULT_ACCOUNT_PRIVILEGES = frozenset(
    {
        "BIND SERVICE ENDPOINT",
        "EXECUTE AGENT TASK",
        "MANAGE ARTIFACT PUBLICATION",
        "USE AI FUNCTIONS",
        "VIEW LINEAGE",
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

# The two application roles are fixed, byte-literal audit subjects rather
# than operator-controlled SQL inputs. Their object-level manifest is derived
# from check_grant_manifest's #317 source of truth and canonicalized below to
# live SHOW GRANTS' database-qualified, uppercase names. Only the live-only
# prerequisite USAGE rows depend on the pinned DEV boundary arguments.
PUBLIC_WEB_ROLE = "PUBLIC_WEB"
ROASTPILOT_AGENT_ROLE = "ROASTPILOT_AGENT"
# D106: application roles use the shared application warehouse. DEV_CI_WH
# belongs to the CI role and is never an application-role prerequisite.
_ALLOWED_APP_ROLE_WAREHOUSES = frozenset({"ROASTPILOT_WH"})
# Operator-confirmed D-345-G / D106 database family: DEV rows normally enter
# the step-1 exact match, but all three environments are listed for completeness.
_APP_ROLE_ENVIRONMENT_DATABASES = frozenset(
    {"ROASTPILOT_DEV", "ROASTPILOT_PREVIEW", "ROASTPILOT"}
)


def _live_procedure_signature(database: str, offline_signature: str) -> str:
    """Derive the live SHOW name from #317's offline procedure signature.

    The offline ``_SUBMIT_REVIEW_SIGNATURE`` remains the single source of
    truth. This transform's output was confirmed byte-for-byte against the
    operator's 2026-08-23 ACCOUNTADMIN ``SHOW GRANTS`` capture.
    """
    qualified_name, arguments_with_close = offline_signature.split("(", 1)
    schema, procedure_name = qualified_name.split(".", 1)
    if schema != "app" or not arguments_with_close.endswith(")"):
        raise ValueError(f"unrecognized offline procedure signature: {offline_signature!r}")
    type_aliases = {"string": "VARCHAR", "int": "NUMBER", "smallint": "NUMBER"}
    argument_types = arguments_with_close[:-1].split(", ")
    live_arguments = ", ".join(type_aliases[argument_type] for argument_type in argument_types)
    return f"{database}.APP.{procedure_name.upper()}({live_arguments})"


# CONFIRMED byte-for-byte against the operator's 2026-08-23 ACCOUNTADMIN
# SHOW GRANTS TO ROLE PUBLIC_WEB capture.
_SUBMIT_REVIEW_LIVE_SIGNATURE = _live_procedure_signature(
    _EXPECTED_DATABASE, check_grant_manifest._SUBMIT_REVIEW_SIGNATURE
)

RoleGrant = tuple[str, str, str, str]
_GRANT_OPTION_ABSENT = object()

# Snowflake's own unquoted-identifier grammar: a letter or underscore, then
# any number of letters, digits, underscores, or dollar signs. The only two
# values this script interpolates into SQL text (the role and the CI user)
# must match it exactly -- see assert_sql_identifier_safe.
_UNQUOTED_IDENTIFIER = re.compile(r"[A-Za-z_][A-Za-z0-9_$]*")


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


def assert_sql_identifier_safe(value: str, var_name: str) -> None:
    """Fails CLOSED unless `value` is a bare Snowflake unquoted identifier,
    before it is ever interpolated into a SQL statement (#58's L3).

    Four statements in `main()` are built by string interpolation -- `SHOW
    GRANTS TO ROLE <role>`, `SHOW GRANTS TO USER <user>`, `SHOW FUTURE
    GRANTS TO ROLE <role>`, and `SHOW USERS LIKE '<user>'`. That is not a
    missed parameterization: Snowflake's `SHOW` commands take an identifier
    in a position that accepts no bind parameter, so there is no
    parameterized form to use instead.

    Both values come from operator-controlled repository variables
    (`vars.SNOWFLAKE_DEV_ROLE`/`vars.SNOWFLAKE_DEV_USER`, see
    `dev-snowflake-contract.yml`), which no agent-authored patch can reach.
    A hostile value ALREADY fails closed today -- but only EMERGENTLY, via
    three mechanisms this repo does not itself assert:

    (i) Only one statement per `execute()` runs. Note this is NOT the
        connector pinning it, which an earlier version of this docstring
        claimed (factory-security review, #58): `cursor.execute`'s
        `num_statements` defaults to `None`, so snowflake-connector-python
        sends NO `MULTI_STATEMENT_COUNT` at all. The restriction is
        Snowflake's own SERVER-side session-parameter default of 1, which
        an account-, user-, or session-level `ALTER ... SET
        MULTI_STATEMENT_COUNT = 0` moves. So this leg is mutable Snowflake
        account state -- the same category as `DEFAULT_SECONDARY_ROLES`,
        which check #8 verifies rather than assumes, and which nothing
        verifies here.
    (ii) Snowflake's own syntax errors on a malformed statement.
    (iii) `find_default_secondary_roles_violation`'s exact-name post-filter.

    Leg (i) being account state rather than a pinned dependency is the
    strongest argument FOR this guard, not against it. The check turns an
    emergent property into an asserted one, the same "anchor the assumption
    rather than trust the environment to hold the right value" discipline
    `assert_boundary_vars_not_drifted` already applies to the
    database/warehouse boundary.

    Deliberately NOT a general Snowflake identifier parser or a quoting
    helper (explicitly out of scope on #58): this repo's own tooling only
    ever creates unquoted identifiers, so anything outside that grammar --
    a quote, semicolon, whitespace, comment marker, trailing newline, or
    empty value -- is REFUSED rather than escaped. The failure direction is
    availability only: a legitimate but exotic (quoted) identifier would be
    rejected loudly, never silently admitted.

    NOT an exhaustive model of Snowflake's identifier rules, and does not
    claim to be: it does not encode Snowflake's 255-character limit, and it
    admits reserved words (including `PUBLIC` as a role name). Both fail
    closed downstream rather than here -- an over-long name is a Snowflake
    error, and `PUBLIC` still meets the unconditional zero-grants standard
    `find_public_grants`/`find_public_future_grants` apply. This guard's one
    job is that the interpolated text cannot carry a quote, backslash,
    semicolon, whitespace, or comment marker.

    Only `role` and `user` are checked, because they are the only two values
    that reach SQL text this module composes. This is NOT an exhaustive
    account of the module's inputs (factory-security review, #58):
    - `database`/`warehouse` reach `connect()` as parameters, never
      statement text, and are separately pinned to exact literals by
      `assert_boundary_vars_not_drifted` -- strictly stronger than a
      grammar check.
    - `SNOWFLAKE_ACCOUNT` reaches `connect(account=...)` and is neither
      pinned nor grammar-checked, despite deciding WHERE the private key's
      JWT is sent. It is bounded operationally rather than in this module,
      by the workflow's `egress-policy: block` allowlist
      (`*.snowflakecomputing.com:443`) and by repository-variable writes
      needing admin. Out of #58's scope; tracked separately rather than
      widened into here.

    Deliberately does NOT use `re.IGNORECASE`: that flag would admit the
    Kelvin sign (U+212A), dotless i (U+0131), long s (U+017F), and U+0130
    into an otherwise pure-ASCII grammar.

    @param value: The identifier as the environment actually holds it.
    @param var_name: The environment variable's name, for the error message.
    @raises SystemExit: If `value` is not a bare unquoted identifier.
    """
    # `fullmatch`, not `match`/`search` -- and deliberately not an `^...$`
    # pattern, since `$` also matches just before a TRAILING NEWLINE, which
    # would admit `"ROASTPILOT_DEV_CI_ROLE\n"` as if it were clean.
    if not _UNQUOTED_IDENTIFIER.fullmatch(value):
        raise SystemExit(
            f"error: {var_name} is {value!r}, which is not a bare Snowflake unquoted "
            "identifier ([A-Za-z_][A-Za-z0-9_$]*) -- refusing to interpolate it into a "
            "SHOW statement"
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


def _object_container(name: str) -> str:
    return name.split(".", 1)[0]


def _environment_invariant_name(name: str) -> str:
    """Remove one database prefix, or return empty for a bare name."""
    _, separator, suffix = name.partition(".")
    return suffix if separator else ""


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
        return identifiers_match(_object_container(name), allowed_database)

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


def expected_role_grants(database: str) -> dict[str, frozenset[RoleGrant]]:
    """Build the exact live grant manifest for both application roles.

    The object-level core is a per-privilege expansion of the offline #317
    manifest, including each grant's authoritative privilege set. Object
    names are derived and canonicalized to live SHOW GRANTS' database-qualified
    uppercase form; procedure signatures use the confirmed live transform.
    Database and schema USAGE rows are live-only operator-provisioned
    prerequisites. Shared warehouses are classified separately by
    ``find_role_manifest_violations`` because these account-level roles span
    environments.
    """
    prerequisites = {
        ("USAGE", "DATABASE", database),
        ("USAGE", "SCHEMA", f"{database}.APP"),
    }
    expected: dict[str, set[RoleGrant]] = {
        PUBLIC_WEB_ROLE: {
            (privilege, granted_on, name, PUBLIC_WEB_ROLE)
            for privilege, granted_on, name in prerequisites
        },
        ROASTPILOT_AGENT_ROLE: {
            (privilege, granted_on, name, ROASTPILOT_AGENT_ROLE)
            for privilege, granted_on, name in prerequisites
        },
    }
    for grant in check_grant_manifest.EXPECTED_MANIFEST:
        live_object_type, live_name = _live_manifest_object(database, grant)
        expected[grant.role_name].update(
            (privilege, live_object_type, live_name, grant.role_name)
            for privilege in grant.privileges
        )
    return {role_name: frozenset(grants) for role_name, grants in expected.items()}


def _live_object_type(offline_object_type: str) -> str:
    """Map one offline manifest object type to SHOW GRANTS' vocabulary.

    SQL DDL spells a multi-word object type with a space (``GRANT USAGE ON
    FILE FORMAT ...``), which is what check_grant_manifest.py parses from
    migration text and stores in its manifest. Live SHOW GRANTS reports the
    same type with an underscore. Fail closed on an unknown multi-word
    offline type: emitting it unchanged would create an expected row that no
    live row could ever match.
    """
    offline_to_live = {
        "FILE FORMAT": "FILE_FORMAT",
        "MATERIALIZED VIEW": "MATERIALIZED_VIEW",
    }
    if offline_object_type in offline_to_live:
        return offline_to_live[offline_object_type]
    if " " in offline_object_type:
        raise ValueError(
            f"unmapped multi-word offline object type: {offline_object_type!r}"
        )
    return offline_object_type


def _canonical_live_object_name(database: str, offline_name: str) -> str:
    """Transform one trusted ``app.<object>`` manifest name to SHOW form."""
    schema, object_name = offline_name.split(".", 1)
    if schema != "app" or "." in object_name:
        raise ValueError(f"unrecognized offline manifest object name: {offline_name!r}")
    return f"{database}.APP.{object_name.upper()}"


def _live_manifest_object(
    database: str, grant: check_grant_manifest.Grant
) -> tuple[str, str]:
    """Transform one offline #317 manifest row into its live type and name.

    This is the single crossing point from the manifest's SQL-DDL vocabulary
    to live SHOW GRANTS' vocabulary, keeping ``expected_role_grants`` and
    ``_PUBLIC_WEB_CROSS_ENV_ALLOWED`` aligned. ``object_type`` is compared
    against its offline spelling before it is mapped.
    """
    live_name = (
        _live_procedure_signature(database, grant.object_name)
        if grant.object_type == "PROCEDURE"
        else _canonical_live_object_name(database, grant.object_name)
    )
    return _live_object_type(grant.object_type), live_name


# PUBLIC_WEB's cross-environment qualified surface is environment-invariant:
# derive object rows from #317's manifest and add only the operator-provisioned
# APP schema prerequisite. Bare database USAGE is handled separately because
# the database identifier itself necessarily varies by environment.
_PUBLIC_WEB_CROSS_ENV_ALLOWED = frozenset(
    {
        (
            privilege,
            live_object_type,
            _environment_invariant_name(live_name),
        )
        for grant in check_grant_manifest.EXPECTED_MANIFEST
        if grant.role_name == PUBLIC_WEB_ROLE
        for live_object_type, live_name in (
            _live_manifest_object(_EXPECTED_DATABASE, grant),
        )
        for privilege in grant.privileges
    }
    | {
        (
            "USAGE",
            "SCHEMA",
            _environment_invariant_name(f"{_EXPECTED_DATABASE}.APP"),
        )
    }
)


def _role_grants_match(candidate: RoleGrant, expected: RoleGrant) -> bool:
    """Compare normalized vocabulary and byte-exact Snowflake identifiers."""
    return (
        candidate[0] == expected[0]
        and candidate[1] == expected[1]
        and identifiers_match(candidate[2], expected[2])
        and identifiers_match(candidate[3], expected[3])
    )


def _grant_option_is_false(value: object) -> bool:
    """Recognize only Snowflake's known false/empty grant-option forms."""
    if value is _GRANT_OPTION_ABSENT:
        return False
    if value is False or value is None:
        return True
    if isinstance(value, str):
        return value == "" or value.lower() == "false"
    return False


def find_role_manifest_violations(
    role_name: str,
    grant_rows: list[dict[str, object]],
    expected_set: frozenset[RoleGrant],
    database: str,
    allowed_warehouses: frozenset[str],
) -> list[str]:
    """Audit DEV exactly while permitting owned cross-environment grants.

    Container classification is deliberately first: every object whose first
    dot-delimited component byte-matches ``database`` enters the exact-set
    comparison regardless of its reported object type. Allowlisted warehouses
    require explicit USAGE without grant option. ROASTPILOT_AGENT's well-formed
    database-scoped objects in other environments are ignored; PUBLIC_WEB's
    must belong to the byte-exact owned database family, exactly match its
    environment-invariant secure surface, and have no grant option. Other
    warehouses, role/account grants, malformed names, and unknown object types
    fail closed.
    """
    in_scope: list[tuple[RoleGrant, str, bool]] = []
    violations: list[str] = []
    for row in grant_rows:
        grant = (
            str(row.get("privilege", "")).strip().upper(),
            str(row.get("granted_on", "")).strip().upper(),
            str(row.get("name", "")),
            str(row.get("grantee_name", "")),
        )
        grant_option = row.get("grant_option", _GRANT_OPTION_ABSENT)
        grant_option_display = (
            "<absent>" if grant_option is _GRANT_OPTION_ABSENT else repr(grant_option)
        )
        grant_option_is_false = _grant_option_is_false(grant_option)

        # Load-bearing order: a DEV-container name is always exact-matched,
        # even when Snowflake reports WAREHOUSE or an unknown object type.
        if identifiers_match(_object_container(grant[2]), database):
            in_scope.append((grant, grant_option_display, grant_option_is_false))
        elif (
            grant[1] == "WAREHOUSE"
            and grant[0] == "USAGE"
            and grant_option_is_false
            and any(
                identifiers_match(grant[2], warehouse)
                for warehouse in allowed_warehouses
            )
        ):
            continue
        elif grant[1] == "WAREHOUSE":
            violations.append(
                f"unexpected warehouse grant: {grant[0]} on {grant[1]} {grant[2]} "
                f"to {grant[3]} (grant_option={grant_option_display})"
            )
        # A bare, non-empty DATABASE name is the well-formed other-environment
        # prerequisite shape. Dotted DATABASE names are malformed.
        elif grant[1] == "DATABASE" and grant[2] and "." not in grant[2]:
            if (
                role_name == PUBLIC_WEB_ROLE
                and (
                    not any(
                        identifiers_match(grant[2], environment_database)
                        for environment_database in _APP_ROLE_ENVIRONMENT_DATABASES
                    )
                    or grant[0] != "USAGE"
                    or not grant_option_is_false
                )
            ):
                violations.append(
                    f"unexpected PUBLIC_WEB grant: {grant[0]} on {grant[1]} "
                    f"{grant[2]} to {grant[3]}"
                )
            continue
        # Every other database-scoped type must be qualified. Empty or
        # unqualified names fall through to the fail-closed default below.
        elif (
            grant[1] in _DATABASE_SCOPED_OBJECT_TYPES
            and grant[1] != "DATABASE"
            and "." in grant[2]
        ):
            container = _object_container(grant[2])
            environment_invariant_name = _environment_invariant_name(grant[2])
            if (
                role_name == PUBLIC_WEB_ROLE
                and (
                    not any(
                        identifiers_match(container, environment_database)
                        for environment_database in _APP_ROLE_ENVIRONMENT_DATABASES
                    )
                    or (
                        grant[0],
                        grant[1],
                        environment_invariant_name,
                    )
                    not in _PUBLIC_WEB_CROSS_ENV_ALLOWED
                    or not grant_option_is_false
                )
            ):
                violations.append(
                    f"unexpected PUBLIC_WEB grant: {grant[0]} on {grant[1]} "
                    f"{grant[2]} to {grant[3]}"
                )
            continue
        else:
            violations.append(
                f"unexpected grant: {grant[0]} on {grant[1]} {grant[2]} "
                f"to {grant[3]} (grant_option={grant_option_display})"
            )

    violations.extend(
        f"extra grant: {grant[0]} on {grant[1]} {grant[2]} to {grant[3]} "
        f"(grant_option={grant_option_display})"
        for grant, grant_option_display, grant_option_is_false in in_scope
        if not grant_option_is_false
        or not any(_role_grants_match(grant, item) for item in expected_set)
    )
    violations.extend(
        f"missing manifest grant: {privilege} on {granted_on} {name} to {grantee}"
        for privilege, granted_on, name, grantee in sorted(expected_set)
        if not any(
            grant_option_is_false
            and _role_grants_match(grant, (privilege, granted_on, name, grantee))
            for grant, _, grant_option_is_false in in_scope
        )
    )
    return violations


def find_role_future_grant_violations(
    role_name: str, future_rows: list[dict[str, object]]
) -> list[str]:
    """Return a violation for every visible future grant; the manifest has none."""
    return [
        f"future grant on {role_name}: {str(row.get('privilege', ''))} on "
        f"{str(row.get('grant_on', ''))} {str(row.get('name', ''))}"
        for row in future_rows
    ]


def _public_grant_targets_owned_object(
    privilege: str,
    granted_on: str,
    name: str,
    role_name: str,
    allowed_database: str,
    allowed_warehouse: str,
) -> bool:
    """True when a PUBLIC grant violates the D-11-D DEV/account boundary.

    This property deliberately does not reuse `is_allowed_grant`: that
    predicate type-gates database-scoped objects and returns False for an
    unknown type, while here True means "flag". Reusing or mirroring that
    gate would therefore fail open for a new object type inside our DEV
    database. Every non-warehouse/non-role kind is judged by its exact
    container instead, so unknown types fail closed. Every ROLE grant is
    flagged except the byte-exact enumerated Snowflake-owned account
    defaults, because a role granted to PUBLIC hands its access to every
    principal. Every ACCOUNT privilege is likewise flagged except the
    normalized enumerated Snowflake-owned defaults.
    """
    kind = granted_on.strip().upper()
    if kind == "WAREHOUSE":
        # SHOW GRANTS emits bare identifiers, not db-qualified names, for account warehouses.
        return identifiers_match(name, allowed_warehouse)
    if kind == "ROLE":
        # SHOW GRANTS emits bare identifiers for account roles; database roles use DATABASE_ROLE.
        # A role granted to PUBLIC hands every principal that role's access,
        # so it is never legitimate for us — flag every ROLE-to-PUBLIC grant
        # EXCEPT the enumerated Snowflake-owned account defaults (which every
        # account carries and which cannot reach our data). Byte-exact, so a
        # lookalike of a default role still flags. role_name is intentionally
        # no longer special-cased: our own CI role granted to PUBLIC is itself
        # a violation and must flag.
        return not any(identifiers_match(name, r) for r in _SNOWFLAKE_DEFAULT_ROLES)
    if kind == "ACCOUNT":
        # An account-level privilege granted to PUBLIC is inherited by every
        # principal incl. this DEV role. Dangerous privileges (MANAGE GRANTS,
        # CREATE DATABASE, ...) confer account-wide capability reaching our
        # data, so flag every ACCOUNT-to-PUBLIC grant EXCEPT enumerated
        # Snowflake-owned defaults. Privilege is Snowflake's fixed vocabulary.
        return privilege.strip().upper() not in _SNOWFLAKE_DEFAULT_ACCOUNT_PRIVILEGES
    return identifiers_match(_object_container(name), allowed_database)


def find_public_grants(
    grant_rows: list[dict[str, object]], role_name: str, allowed_database: str, allowed_warehouse: str
) -> list[str]:
    """Returns visible PUBLIC grants targeting our DEV boundary or non-default roles.

    A grant is flagged iff it targets our DEV database container, our DEV
    warehouse, any role other than an enumerated Snowflake-owned account
    default, or any account privilege other than an enumerated Snowflake-owned
    default. Role/account grants to PUBLIC hand their access or capability to
    every principal. Other Snowflake-owned and account-default PUBLIC grants
    are structurally out of scope because they can never reach our data.

    COMPLETENESS LIMIT (Codex P1, PR #57, round 5, :596 -- tracked #59):
    the caller's `SHOW GRANTS TO ROLE PUBLIC` rows are only what's visible
    to THIS role's own session -- true account-wide completeness would
    need `MANAGE GRANTS`, which this minimal role deliberately doesn't
    hold. This function (and the audit built on it) is a DEV-visibility-
    scoped, best-effort detective control, not an account-wide guarantee.
    See the module docstring's point 4 for the full reasoning and what
    provides the actual account-wide enforcement instead.

    @param grant_rows: Rows as returned by a `DictCursor` running `SHOW
        GRANTS TO ROLE PUBLIC`.
    @param role_name: The DEV role, retained for signature symmetry with the
        other boundary predicates; ROLE grants use the default-role allowlist.
    @param allowed_database: The DEV database whose exact container is owned.
    @param allowed_warehouse: The DEV warehouse whose exact identifier is owned.
    @returns: Descriptions of every grant flagged by the D-11-D property.
    """
    violations = []
    for row in grant_rows:
        privilege = str(row.get("privilege", ""))
        granted_on = str(row.get("granted_on", ""))
        name = str(row.get("name", ""))
        # DictCursor does not return NULL for these columns; catch empty strings after str() coercion.
        if not granted_on or not name or _public_grant_targets_owned_object(
            privilege, granted_on, name, role_name, allowed_database, allowed_warehouse
        ):
            violations.append(f"{privilege} on {granted_on} {name}")
    return violations


def _grant_reaches_owned_boundary(
    granted_on: str, name: str, allowed_database: str, allowed_warehouse: str
) -> bool:
    """True when a grant directly reaches the DEV database or warehouse."""
    kind = granted_on.strip().upper()
    if kind == "WAREHOUSE":
        return identifiers_match(name, allowed_warehouse)
    return identifiers_match(_object_container(name), allowed_database)


def find_default_role_boundary_reaches(
    default_role_grants: dict[str, list[dict[str, object]]],
    allowed_database: str,
    allowed_warehouse: str,
) -> list[str]:
    """Finds DEV grants inherited by PUBLIC through allowlisted default roles.

    `default_role_grants` maps each PUBLIC-granted default role to its own
    `SHOW GRANTS` rows. For each role, any direct grant reaching our DEV
    database container or warehouse is flagged because PUBLIC inherits it
    transitively. This intentionally checks one level only; deeper role-to-role
    and account-privilege hops remain a documented #59 residual.
    """
    violations = []
    for role in sorted(default_role_grants):
        for row in default_role_grants[role]:
            granted_on = str(row.get("granted_on", ""))
            name = str(row.get("name", ""))
            privilege = str(row.get("privilege", ""))
            # Mirror find_public_grants's malformed-row fail-closed guard.
            if not granted_on or not name or _grant_reaches_owned_boundary(
                granted_on, name, allowed_database, allowed_warehouse
            ):
                violations.append(
                    f"{privilege} on {granted_on} {name} "
                    f"(reachable by PUBLIC via default role {role})"
                )
    return violations


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
    holds that's VISIBLE TO THIS DEV-SCOPED ROLE — empty only if none are
    visible (Codex P1, PR #57, round 4).

    Same unconditional standard as `find_public_grants`, applied to `SHOW
    FUTURE GRANTS TO ROLE PUBLIC` rows (which use `grant_on`, not
    `granted_on` -- see `find_future_grant_violations`): `AGENTS.md`'s "No
    grants to PUBLIC, anywhere" invariant doesn't carve out an exception
    for grants that haven't materialized yet. Same COMPLETENESS LIMIT as
    `find_public_grants` (tracked #59) -- DEV-visibility-scoped, not an
    account-wide guarantee.

    @param future_grant_rows: Rows as returned by a `DictCursor` running
        `SHOW FUTURE GRANTS TO ROLE PUBLIC`.
    @returns: Descriptions of every future grant PUBLIC holds, empty if
        none.
    """
    return [
        f"{row.get('privilege', '')} on future {row.get('grant_on', '')} in {row.get('name', '')}"
        for row in future_grant_rows
    ]


def find_out_of_bounds_names(
    visible_names: list[str], allowed_name: str, default_allowlist: frozenset[str] = frozenset()
) -> list[str]:
    """Filters a list of visible object names (from `SHOW DATABASES` or
    `SHOW WAREHOUSES`) down to whichever ones are neither the one allowed
    name nor a D-11-A Snowflake-owned, non-writable account default.

    Catches what `SHOW GRANTS TO ROLE` alone can miss (Codex P1, PR #57):
    a future grant, an account-level visibility path, or any other
    mechanism that makes an object visible/usable to this role without a
    corresponding row in `SHOW GRANTS`'s own output. Comparison is an
    EXACT match via `identifiers_match`, same reasoning as
    `is_allowed_grant`.

    @param visible_names: Object names as returned by `SHOW DATABASES`/
        `SHOW WAREHOUSES` (the `name` column).
    @param allowed_name: The one name this role should see.
    @param default_allowlist: Exact built-in names this role may also see;
        empty by default so existing callers retain the strict behavior.
    @returns: Every visible name that isn't allowed.
    """
    return [name for name in visible_names
            if not identifiers_match(name, allowed_name)
            and not any(identifiers_match(name, d) for d in default_allowlist)]


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


def find_default_secondary_roles_violation(user_rows: list[dict[str, object]], user: str) -> str | None:
    """Returns a violation description if the CI user's
    `DEFAULT_SECONDARY_ROLES` property isn't verifiably empty, else `None`
    (Codex P1, PR #57, round 5, :270).

    The operator-run `ALTER USER ROASTPILOT_DEV_CI SET DEFAULT_SECONDARY_
    ROLES = ()` (module docstring point 3) is what's SUPPOSED to keep
    secondary roles off the schemachange deploy connection -- a manual,
    account-level action this script has no way to run or enforce, only
    to verify. This turns that silent operator dependency into a checked
    precondition: if the property is ever missing (e.g. the user gets
    re-created without it, or was never set), the deploy connection's
    secondary-roles protection would silently disappear with no other
    signal anywhere in this job.

    Never trusts `user_rows[0]` (Codex P1, PR #57, round 6, :709/:710 -- a
    real bug in the round-5 version): `SHOW USERS LIKE` treats each
    underscore in the pattern as a single-character wildcard, so a
    lookalike user name (e.g. `ROASTPILOT0DEV0CI` for `ROASTPILOT_DEV_CI`)
    can ALSO match and could sort ahead of the real one -- trusting row
    order would let a lookalike's (possibly compliant) setting silently
    stand in for the real CI user's, verifying nothing. LIKE-matching is
    never treated as identity: this filters `user_rows` down to the row(s)
    whose OWN `name` column equals `user` EXACTLY, uppercase-compared on
    both sides (Snowflake folds unquoted identifiers to uppercase at
    creation, so this is the correct equivalence for an operator-supplied
    env var naming the same account object regardless of how it happened
    to be typed -- a DIFFERENT comparison from `identifiers_match`'s
    deliberately no-fold policy elsewhere in this module, which exists to
    reject a quoted, differently-cased LOOKALIKE object as a security
    boundary; here there's no boundary being enforced by case, only an
    identity lookup against this single user's own name), and fails CLOSED
    unless EXACTLY ONE such row is found -- zero exact matches (only
    wildcard lookalikes, if any), or more than one (which should never
    legitimately happen for a single username but is not assumed away),
    are both violations. `LIKE` itself is intentionally NOT hardened with
    an `ESCAPE` clause here: the exact-name post-filter is what makes this
    sound regardless of how permissively `LIKE` over-matches, and adding
    unverified escape syntax without a live session to test it against
    would risk a different failure mode (a malformed query) for no
    correctness gain over the post-filter alone.

    Accepts ONLY the specific empty-set representations expected for
    `DEFAULT_SECONDARY_ROLES = ()` -- the JSON array string `"[]"`, or an
    already-parsed empty Python list (in case the connector parses this
    particular column) -- and fails CLOSED on anything else, including a
    missing column, `None`, or an unrecognized representation (e.g. an
    `["ALL"]`-shaped value, which is exactly the misconfiguration this
    check exists to catch). This column's exact returned format has not
    been verified against a live session -- see the module NOTE -- so
    recognizing only the specific forms expected, and treating everything
    else as a failure, is the fail-closed choice consistent with the rest
    of this module rather than guessing at an unfamiliar shape.

    @param user_rows: Rows as returned by a `DictCursor` running `SHOW
        USERS LIKE '<user>'`.
    @param user: The CI service user being checked.
    @returns: A violation description, or `None` if verifiably empty.
    """
    expected_name = user.upper()
    exact_matches = [row for row in user_rows if str(row.get("name", "")).upper() == expected_name]
    if len(exact_matches) != 1:
        return (
            f"SHOW USERS LIKE '{user}' returned {len(user_rows)} row(s), of which "
            f"{len(exact_matches)} had a name exactly matching {user!r} -- cannot verify "
            "DEFAULT_SECONDARY_ROLES (LIKE-matching is not identity; a wildcard-lookalike "
            "user name could match instead of, or alongside, the real one)"
        )
    value = exact_matches[0].get("default_secondary_roles", "<column missing>")
    if value == "[]" or value == []:
        return None
    return (
        f"{user}'s DEFAULT_SECONDARY_ROLES is {value!r}, expected an empty set ([]) -- the "
        "operator-run ALTER USER ... SET DEFAULT_SECONDARY_ROLES = () may be missing or have "
        "been reset (e.g. after a user re-creation), leaving the deploy connection's "
        "secondary-roles protection unverified"
    )


def main() -> int:
    account = require_env("SNOWFLAKE_ACCOUNT")
    user = require_env("SNOWFLAKE_DEV_USER")
    role = require_env("SNOWFLAKE_DEV_ROLE")
    warehouse = require_env("SNOWFLAKE_DEV_WAREHOUSE")
    database = require_env("SNOWFLAKE_DEV_DATABASE")
    private_key_pem = require_env("SNOWFLAKE_DEV_PRIVATE_KEY")
    passphrase = os.environ.get("SNOWFLAKE_DEV_PRIVATE_KEY_PASSPHRASE") or None

    assert_boundary_vars_not_drifted(database, warehouse)
    # #58 L3 -- the role and the CI user are the only two values this script
    # interpolates into SQL text; refuse anything outside Snowflake's
    # unquoted-identifier grammar before building a statement from it, and
    # before the private key is even loaded. See assert_sql_identifier_safe.
    assert_sql_identifier_safe(role, "SNOWFLAKE_DEV_ROLE")
    assert_sql_identifier_safe(user, "SNOWFLAKE_DEV_USER")

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

        # Codex P1, PR #57, round 5 -- see the module docstring's point 8.
        # Turns the operator's manual ALTER USER ... DEFAULT_SECONDARY_
        # ROLES = () dependency into a verified precondition instead of a
        # silent assumption.
        cursor.execute(f"SHOW USERS LIKE '{user}'")
        show_user_rows = cursor.fetchall()

        cursor.execute(f"SHOW GRANTS TO ROLE {PUBLIC_WEB_ROLE}")
        public_web_grant_rows = cursor.fetchall()

        cursor.execute(f"SHOW GRANTS TO ROLE {ROASTPILOT_AGENT_ROLE}")
        roastpilot_agent_grant_rows = cursor.fetchall()

        cursor.execute(f"SHOW FUTURE GRANTS TO ROLE {PUBLIC_WEB_ROLE}")
        public_web_future_grant_rows = cursor.fetchall()

        cursor.execute(f"SHOW FUTURE GRANTS TO ROLE {ROASTPILOT_AGENT_ROLE}")
        roastpilot_agent_future_grant_rows = cursor.fetchall()

        public_granted_default_roles = sorted(
            {
                str(row.get("name", ""))
                for row in public_grant_rows
                if str(row.get("granted_on", "")).strip().upper() == "ROLE"
                and any(
                    identifiers_match(str(row.get("name", "")), default_role)
                    for default_role in _SNOWFLAKE_DEFAULT_ROLES
                )
            }
        )
        default_role_grants = {}
        for default_role in public_granted_default_roles:
            assert_sql_identifier_safe(default_role, "default role")
            cursor.execute(f"SHOW GRANTS TO ROLE {default_role}")
            default_role_grants[default_role] = cursor.fetchall()
    finally:
        conn.close()

    violations = find_violations(grant_rows, role, database, warehouse)
    # PUBLIC grants are flagged for the exact DEV database container or
    # warehouse, every non-default role, and every non-default account
    # privilege. Allowlisted PUBLIC-granted roles are checked one level deeper.
    # The COMPLETENESS LIMIT in find_public_grants still applies: this is a
    # DEV-visibility-scoped detective control, not an account-wide guarantee.
    public_violations = find_public_grants(public_grant_rows, role, database, warehouse)
    out_of_bounds_databases = find_out_of_bounds_names(
        visible_databases, database, _SNOWFLAKE_DEFAULT_DATABASES
    )
    out_of_bounds_warehouses = find_out_of_bounds_names(
        visible_warehouses, warehouse, _SNOWFLAKE_DEFAULT_WAREHOUSES
    )
    unexpected_user_roles = find_unexpected_user_role_grants(user_role_rows, role)
    future_violations = find_future_grant_violations(future_grant_rows, role, database, warehouse)
    public_future_violations = find_public_future_grants(public_future_grant_rows)
    default_secondary_roles_violation = find_default_secondary_roles_violation(show_user_rows, user)
    default_role_reaches = find_default_role_boundary_reaches(default_role_grants, database, warehouse)
    expected_app_role_grants = expected_role_grants(database)
    public_web_violations = find_role_manifest_violations(
        PUBLIC_WEB_ROLE,
        public_web_grant_rows,
        expected_app_role_grants[PUBLIC_WEB_ROLE],
        database,
        _ALLOWED_APP_ROLE_WAREHOUSES,
    )
    roastpilot_agent_violations = find_role_manifest_violations(
        ROASTPILOT_AGENT_ROLE,
        roastpilot_agent_grant_rows,
        expected_app_role_grants[ROASTPILOT_AGENT_ROLE],
        database,
        _ALLOWED_APP_ROLE_WAREHOUSES,
    )
    public_web_future_violations = find_role_future_grant_violations(
        PUBLIC_WEB_ROLE, public_web_future_grant_rows
    )
    roastpilot_agent_future_violations = find_role_future_grant_violations(
        ROASTPILOT_AGENT_ROLE, roastpilot_agent_future_grant_rows
    )

    if (
        violations
        or public_violations
        or out_of_bounds_databases
        or out_of_bounds_warehouses
        or unexpected_user_roles
        or future_violations
        or public_future_violations
        or default_secondary_roles_violation
        or default_role_reaches
        or public_web_violations
        or roastpilot_agent_violations
        or public_web_future_violations
        or roastpilot_agent_future_violations
    ):
        print(
            f"error: {role}/PUBLIC/{user} fail the DEV boundary or PUBLIC-grants audit:",
            file=sys.stderr,
        )
        for violation in violations:
            print(f"  - grant on {role} outside {database}/{warehouse}: {violation}", file=sys.stderr)
        for violation in public_violations:
            print(
                f"  - PUBLIC grant violating the DEV/account boundary: {violation}",
                file=sys.stderr,
            )
        for extra_database in out_of_bounds_databases:
            print(f"  - visible database beyond the DEV boundary: {extra_database}", file=sys.stderr)
        for extra_warehouse in out_of_bounds_warehouses:
            print(f"  - visible warehouse beyond the DEV boundary: {extra_warehouse}", file=sys.stderr)
        for extra_role in unexpected_user_roles:
            print(f"  - unexpected role granted to {user}: {extra_role}", file=sys.stderr)
        for violation in future_violations:
            print(f"  - future grant on {role} outside {database}/{warehouse}: {violation}", file=sys.stderr)
        for violation in public_future_violations:
            print(
                f"  - PUBLIC future grant visible to {role} (PUBLIC must have none visible): {violation}",
                file=sys.stderr,
            )
        if default_secondary_roles_violation:
            print(f"  - {default_secondary_roles_violation}", file=sys.stderr)
        for violation in default_role_reaches:
            print(
                f"  - PUBLIC transitively reaches a DEV object via a default role: {violation}",
                file=sys.stderr,
            )
        for violation in public_web_violations:
            print(f"  - {PUBLIC_WEB_ROLE} manifest violation: {violation}", file=sys.stderr)
        for violation in roastpilot_agent_violations:
            print(f"  - {ROASTPILOT_AGENT_ROLE} manifest violation: {violation}", file=sys.stderr)
        for violation in public_web_future_violations:
            print(f"  - {PUBLIC_WEB_ROLE} future-grant violation: {violation}", file=sys.stderr)
        for violation in roastpilot_agent_future_violations:
            print(f"  - {ROASTPILOT_AGENT_ROLE} future-grant violation: {violation}", file=sys.stderr)
        return 1

    print(
        f"confirmed: all {len(grant_rows)} grant(s) (+ {len(future_grant_rows)} future grant(s)) on "
        f"{role} stay within {database}/{warehouse}, no PUBLIC current grant violates the "
        f"DEV/account boundary, no PUBLIC-granted default role directly reaches DEV, PUBLIC holds "
        f"zero future grants visible to this role, no other database/warehouse is visible, {user} "
        f"has no unexpected role grants, {user}'s DEFAULT_SECONDARY_ROLES is verified empty, and "
        f"{PUBLIC_WEB_ROLE}/{ROASTPILOT_AGENT_ROLE} exactly match their manifests with zero future "
        "grants visible"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
