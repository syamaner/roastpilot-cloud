#!/usr/bin/env python3
"""Offline exact-set enforcement for R__z_roles_grants.sql (issue #317).

The migration is rendered through schemachange's in-process Jinja engine before
parsing, matching deployed text; it is currently environment-independent.
The GRANT and REVOKE grammars and manifests are closed: an unrecognised
statement, grantee, object type, privilege set, missing row, or extra row is a
violation.
"""

from __future__ import annotations

import importlib.util
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType

from schemachange.JinjaTemplateProcessor import JinjaTemplateProcessor


def _load_sibling_module(module_name: str) -> ModuleType:
    """Load one sibling by resolved path without widening ``sys.path``."""
    module_path = Path(__file__).resolve().parent / f"{module_name}.py"
    spec = importlib.util.spec_from_file_location(module_name, module_path)
    if spec is None or spec.loader is None:  # pragma: no cover
        raise ImportError(f"cannot construct a loader for sibling module {module_name!r}")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
    except FileNotFoundError as exc:
        raise ImportError(f"cannot load sibling module {module_name!r} from {module_path}") from exc
    return module


_validate_migrations = _load_sibling_module("validate_migrations")
SNOWFLAKE_DIR = _validate_migrations.SNOWFLAKE_DIR
MIGRATION_PATH = SNOWFLAKE_DIR / "migrations" / "R__z_roles_grants.sql"

ALLOWED_ROLES = frozenset({"PUBLIC_WEB", "ROASTPILOT_AGENT"})
ALLOWED_OBJECT_TYPES = frozenset(
    {
        "DATABASE",
        "SCHEMA",
        "WAREHOUSE",
        "VIEW",
        "TABLE",
        "STAGE",
        "FILE FORMAT",
        "PROCEDURE",
    }
)


@dataclass(frozen=True, order=True)
class Grant:
    """One normalized-vocabulary, byte-exact-identifier manifest row."""

    privileges: frozenset[str]
    object_type: str
    object_name: str
    role_name: str


@dataclass(frozen=True, order=True)
class Revoke:
    """One normalized-vocabulary, byte-exact-identifier revoke row."""

    privileges: frozenset[str]
    object_type: str
    object_name: str
    role_name: str


def _grant(privileges: str, object_type: str, object_name: str, role_name: str) -> Grant:
    return Grant(frozenset(privileges.split(",")), object_type, object_name, role_name)


def _revoke(privileges: str, object_type: str, object_name: str, role_name: str) -> Revoke:
    return Revoke(frozenset(privileges.split(",")), object_type, object_name, role_name)


_SUBMIT_REVIEW_SIGNATURE = (
    "app.submit_review(string, string, int, smallint, smallint, smallint, "
    "smallint, smallint, string, string, string)"
)
_UPSERT_ROAST_SIGNATURE = "app.upsert_roast(string, string)"
_AGENT_SELECT_ONLY_TABLES = (
    "app.cloud_roasts",
    "app.roast_telemetry",
    "app.tasting_reviews",
    "app.reference_roast_summaries",
)

# The migration renders no database or warehouse identifier, so this owned-object
# manifest is fully environment-independent.
EXPECTED_MANIFEST = frozenset(
    {
        _grant("SELECT", "VIEW", "app.roast_by_slug", "PUBLIC_WEB"),
        _grant("SELECT", "VIEW", "app.reviews_by_roast", "PUBLIC_WEB"),
        _grant("USAGE", "PROCEDURE", _SUBMIT_REVIEW_SIGNATURE, "PUBLIC_WEB"),
        *(
            _grant("SELECT", "TABLE", table, "ROASTPILOT_AGENT")
            for table in _AGENT_SELECT_ONLY_TABLES
        ),
        _grant(
            "SELECT,INSERT,UPDATE,DELETE",
            "TABLE",
            "app.roast_artifacts",
            "ROASTPILOT_AGENT",
        ),
        _grant("READ,WRITE", "STAGE", "app.roast_artifacts", "ROASTPILOT_AGENT"),
        _grant("USAGE", "FILE FORMAT", "app.roast_jsonl_format", "ROASTPILOT_AGENT"),
        _grant(
            "USAGE",
            "PROCEDURE",
            "app.load_roast_telemetry(string, string)",
            "ROASTPILOT_AGENT",
        ),
        _grant("USAGE", "PROCEDURE", _UPSERT_ROAST_SIGNATURE, "ROASTPILOT_AGENT"),
    }
)

EXPECTED_REVOKES = frozenset(
    _revoke("INSERT,UPDATE,DELETE", "TABLE", table, "ROASTPILOT_AGENT")
    for table in _AGENT_SELECT_ONLY_TABLES
)

_COMMENT_PATTERN = re.compile(r"--[^\n]*(?:\n|$)|/\*.*?\*/", re.DOTALL)
_USE_SCHEMA_PATTERN = re.compile(r"USE\s+SCHEMA\s+app\Z", re.IGNORECASE)
_OBJECT_TYPE_PATTERN = "|".join(
    re.escape(object_type).replace(r"\ ", r"\s+")
    for object_type in sorted(
        ALLOWED_OBJECT_TYPES,
        key=lambda object_type: (-object_type.count(" "), object_type),
    )
)
_GRANT_PATTERN = re.compile(
    r"GRANT\s+"
    r"(?P<privileges>[A-Za-z]+(?:\s*,\s*[A-Za-z]+)*)\s+"
    rf"ON\s+(?P<object_type>{_OBJECT_TYPE_PATTERN})\b\s+"
    r"(?P<object_name>.+?)\s+"
    r"TO\s+ROLE\s+(?P<role_name>\S+)\Z",
    re.IGNORECASE | re.DOTALL,
)
_GRANT_SHAPE_PATTERN = re.compile(
    r"GRANT\s+"
    r"[A-Za-z]+(?:\s*,\s*[A-Za-z]+)*\s+"
    r"ON\s+(?P<object_type>[A-Za-z]+(?:\s+[A-Za-z]+)?)\s+"
    r".+?\s+TO\s+ROLE\s+\S+\Z",
    re.IGNORECASE | re.DOTALL,
)
_REVOKE_PATTERN = re.compile(
    r"REVOKE\s+"
    r"(?P<privileges>[A-Za-z]+(?:\s*,\s*[A-Za-z]+)*)\s+"
    r"ON\s+(?P<object_type>TABLE)\b\s+"
    r"(?P<object_name>.+?)\s+"
    r"FROM\s+ROLE\s+(?P<role_name>\S+)\Z",
    re.IGNORECASE | re.DOTALL,
)
_REVOKE_SHAPE_PATTERN = re.compile(
    r"REVOKE\s+"
    r"[A-Za-z]+(?:\s*,\s*[A-Za-z]+)*\s+"
    r"ON\s+(?P<object_type>[A-Za-z]+(?:\s+[A-Za-z]+)?)\s+"
    r".+?\s+FROM\s+ROLE\s+\S+\Z",
    re.IGNORECASE | re.DOTALL,
)
_BARE_OBJECT_NAME_PREFIX = re.compile(r"[A-Za-z]+\s+\S", re.DOTALL)


def format_grant(grant: Grant) -> str:
    """Return a stable human-readable representation for diagnostics."""
    privileges = ", ".join(sorted(grant.privileges))
    return (
        f"GRANT {privileges} ON {grant.object_type} {grant.object_name} "
        f"TO ROLE {grant.role_name}"
    )


def format_revoke(revoke: Revoke) -> str:
    """Return a stable human-readable representation for diagnostics."""
    privileges = ", ".join(sorted(revoke.privileges))
    return (
        f"REVOKE {privileges} ON {revoke.object_type} {revoke.object_name} "
        f"FROM ROLE {revoke.role_name}"
    )


def parse_rendered_sql(
    rendered_sql: str,
) -> tuple[frozenset[Grant], frozenset[Revoke], list[str]]:
    """Parse rendered SQL under the closed grant-and-revoke grammar."""
    uncommented = _COMMENT_PATTERN.sub("", rendered_sql)
    grants: set[Grant] = set()
    revokes: set[Revoke] = set()
    violations: list[str] = []

    for raw_statement in uncommented.split(";"):
        statement = raw_statement.strip()
        if not statement or _USE_SCHEMA_PATTERN.fullmatch(statement):
            continue

        match = _GRANT_PATTERN.fullmatch(statement)
        if match is not None:
            privileges = frozenset(
                token.strip().upper() for token in match.group("privileges").split(",")
            )
            object_type = re.sub(r"\s+", " ", match.group("object_type")).upper()
            object_name = match.group("object_name")
            if _BARE_OBJECT_NAME_PREFIX.match(object_name):
                violations.append(f"unrecognized object type in: {statement}")
                continue
            role_name = match.group("role_name")
            grant = Grant(privileges, object_type, object_name, role_name)
            grants.add(grant)

            if role_name not in ALLOWED_ROLES:
                violations.append(f"unauthorized grantee in: {statement}")
            if object_type == "PROCEDURE" and privileges != frozenset({"USAGE"}):
                violations.append(f"procedure privilege must be exactly USAGE in: {statement}")
            if object_type == "FILE FORMAT" and privileges != frozenset({"USAGE"}):
                violations.append(f"file format privilege must be exactly USAGE in: {statement}")
            if object_type == "STAGE" and privileges != frozenset({"READ", "WRITE"}):
                violations.append(f"stage privileges must be exactly READ, WRITE in: {statement}")
            continue

        if statement.upper().startswith("GRANT "):
            shape_match = _GRANT_SHAPE_PATTERN.fullmatch(statement)
            if shape_match is None:
                violations.append(f"unrecognized statement: {statement}")
            else:
                violations.append(f"unrecognized object type in: {statement}")
            continue

        match = _REVOKE_PATTERN.fullmatch(statement)
        if match is not None:
            privileges = frozenset(
                token.strip().upper() for token in match.group("privileges").split(",")
            )
            object_type = match.group("object_type").upper()
            object_name = match.group("object_name")
            if _BARE_OBJECT_NAME_PREFIX.match(object_name):
                violations.append(f"unrecognized object type in: {statement}")
                continue
            role_name = match.group("role_name")
            revoke = Revoke(privileges, object_type, object_name, role_name)
            revokes.add(revoke)

            if role_name not in ALLOWED_ROLES:
                violations.append(f"unauthorized grantee in: {statement}")
            if privileges != frozenset({"INSERT", "UPDATE", "DELETE"}):
                violations.append(
                    f"revoke privileges must be exactly INSERT, UPDATE, DELETE in: {statement}"
                )
            continue

        if re.match(r"REVOKE\b", statement, re.IGNORECASE):
            shape_match = _REVOKE_SHAPE_PATTERN.fullmatch(statement)
            if shape_match is None:
                violations.append(f"unrecognized revoke statement: {statement}")
            else:
                violations.append(f"unrecognized object type in: {statement}")
            continue

        violations.append(f"unrecognized statement: {statement}")

    return frozenset(grants), frozenset(revokes), violations


def manifest_violations(rendered_sql: str) -> list[str]:
    """Return parser, guard, missing-row, and extra-row violations."""
    parsed_grants, parsed_revokes, violations = parse_rendered_sql(rendered_sql)
    violations.extend(
        f"missing grant: {format_grant(grant)}"
        for grant in sorted(EXPECTED_MANIFEST - parsed_grants, key=format_grant)
    )
    violations.extend(
        f"extra grant: {format_grant(grant)}"
        for grant in sorted(parsed_grants - EXPECTED_MANIFEST, key=format_grant)
    )
    violations.extend(
        f"missing revoke: {format_revoke(revoke)}"
        for revoke in sorted(EXPECTED_REVOKES - parsed_revokes, key=format_revoke)
    )
    violations.extend(
        f"extra revoke: {format_revoke(revoke)}"
        for revoke in sorted(parsed_revokes - EXPECTED_REVOKES, key=format_revoke)
    )
    return violations


def render_migration() -> str:
    """Render the real migration with schemachange's in-process Jinja engine."""
    try:
        processor = JinjaTemplateProcessor(project_root=SNOWFLAKE_DIR / "migrations")
        return processor.render(MIGRATION_PATH.name, {})
    except Exception as exc:
        raise RuntimeError(f"schemachange render failed for {MIGRATION_PATH.name}: {exc}") from exc


def main() -> int:
    try:
        rendered_sql = render_migration()
    except (RuntimeError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    violations = manifest_violations(rendered_sql)
    for violation in violations:
        print(f"error: {violation}", file=sys.stderr)
    if violations:
        return 1

    print(
        "grant/revoke manifest matches exactly "
        f"({len(EXPECTED_MANIFEST)} grants, {len(EXPECTED_REVOKES)} revokes)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
