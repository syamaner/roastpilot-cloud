#!/usr/bin/env python3
"""Offline exact-set enforcement for R__z_roles_grants.sql (issue #317).

The migration is rendered through schemachange's in-process Jinja engine before
parsing, matching deployed text; it is currently environment-independent.
The grammar and manifest are closed: an unrecognised statement, grantee,
object type, privilege set, missing grant, or extra grant is a violation.
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


def _grant(privileges: str, object_type: str, object_name: str, role_name: str) -> Grant:
    return Grant(frozenset(privileges.split(",")), object_type, object_name, role_name)


_SUBMIT_REVIEW_SIGNATURE = (
    "app.submit_review(string, string, int, smallint, smallint, smallint, "
    "smallint, smallint, string, string, string)"
)
_AGENT_TABLES = (
    "app.cloud_roasts",
    "app.roast_telemetry",
    "app.roast_artifacts",
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
            _grant("SELECT,INSERT,UPDATE,DELETE", "TABLE", table, "ROASTPILOT_AGENT")
            for table in _AGENT_TABLES
        ),
        _grant("READ,WRITE", "STAGE", "app.roast_artifacts", "ROASTPILOT_AGENT"),
        _grant("USAGE", "FILE FORMAT", "app.roast_jsonl_format", "ROASTPILOT_AGENT"),
        _grant(
            "USAGE",
            "PROCEDURE",
            "app.load_roast_telemetry(string, string)",
            "ROASTPILOT_AGENT",
        ),
    }
)

_COMMENT_PATTERN = re.compile(r"--[^\n]*(?:\n|$)|/\*.*?\*/", re.DOTALL)
_USE_SCHEMA_PATTERN = re.compile(r"USE\s+SCHEMA\s+app\Z", re.IGNORECASE)
_GRANT_PATTERN = re.compile(
    r"GRANT\s+"
    r"(?P<privileges>[A-Za-z]+(?:\s*,\s*[A-Za-z]+)*)\s+"
    r"ON\s+(?P<object_type>FILE\s+FORMAT|[A-Za-z]+)\s+"
    r"(?P<object_name>.+?)\s+"
    r"TO\s+ROLE\s+(?P<role_name>\S+)\Z",
    re.IGNORECASE | re.DOTALL,
)
def format_grant(grant: Grant) -> str:
    """Return a stable human-readable representation for diagnostics."""
    privileges = ", ".join(sorted(grant.privileges))
    return (
        f"GRANT {privileges} ON {grant.object_type} {grant.object_name} "
        f"TO ROLE {grant.role_name}"
    )


def parse_rendered_sql(rendered_sql: str) -> tuple[frozenset[Grant], list[str]]:
    """Parse rendered SQL under the closed grant-manifest grammar."""
    uncommented = _COMMENT_PATTERN.sub("", rendered_sql)
    grants: set[Grant] = set()
    violations: list[str] = []

    for raw_statement in uncommented.split(";"):
        statement = raw_statement.strip()
        if not statement or _USE_SCHEMA_PATTERN.fullmatch(statement):
            continue

        match = _GRANT_PATTERN.fullmatch(statement)
        if match is None:
            violations.append(f"unrecognized statement: {statement}")
            continue

        privileges = frozenset(
            token.strip().upper() for token in match.group("privileges").split(",")
        )
        object_type = re.sub(r"\s+", " ", match.group("object_type")).upper()
        object_name = match.group("object_name")
        role_name = match.group("role_name")
        grant = Grant(privileges, object_type, object_name, role_name)
        grants.add(grant)

        if object_type not in ALLOWED_OBJECT_TYPES:
            violations.append(f"unrecognized object type in: {statement}")
        if role_name not in ALLOWED_ROLES:
            violations.append(f"unauthorized grantee in: {statement}")
        if object_type == "PROCEDURE" and privileges != frozenset({"USAGE"}):
            violations.append(f"procedure privilege must be exactly USAGE in: {statement}")
        if object_type == "FILE FORMAT" and privileges != frozenset({"USAGE"}):
            violations.append(f"file format privilege must be exactly USAGE in: {statement}")
        if object_type == "STAGE" and privileges != frozenset({"READ", "WRITE"}):
            violations.append(f"stage privileges must be exactly READ, WRITE in: {statement}")

    return frozenset(grants), violations


def manifest_violations(rendered_sql: str) -> list[str]:
    """Return parser, guard, missing-row, and extra-row violations."""
    parsed, violations = parse_rendered_sql(rendered_sql)
    violations.extend(
        f"missing grant: {format_grant(grant)}"
        for grant in sorted(EXPECTED_MANIFEST - parsed, key=format_grant)
    )
    violations.extend(
        f"extra grant: {format_grant(grant)}"
        for grant in sorted(parsed - EXPECTED_MANIFEST, key=format_grant)
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

    print(f"grant manifest matches exactly ({len(EXPECTED_MANIFEST)} grants)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
