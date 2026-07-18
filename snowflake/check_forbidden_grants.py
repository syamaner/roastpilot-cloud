#!/usr/bin/env python3
"""PREVENTIVE static scan for an obvious `GRANT ... TO PUBLIC` in the
migrations tree (F1-S8, issue #11, Codex P1, PR #57, round 4, :244).

This is a cheap, best-effort guard, NOT a full SQL parser, and NOT the
authoritative control:

- `assert_dev_ci_grants.py`'s post-deploy audit is the AUTHORITATIVE,
  DETECTIVE control. A migration's `GRANT ... TO PUBLIC` is valid SQL;
  schemachange applies it and the DDL auto-commits (no rollback), so it
  persists in `ROASTPILOT_DEV` even though CI goes red. This script exists
  to catch the OBVIOUS case before that ever happens, cheaply and with no
  Snowflake connection at all — not to replace the real audit, which
  remains authoritative for anything this naive text scan misses (a
  Jinja-templated or dynamically-constructed grant, a `.cli.yml` action
  script phrasing this scan doesn't anticipate, or any other non-obvious
  construction).
- If this scan is ever bypassed or wrong, the blast radius is still
  contained to `ROASTPILOT_DEV` (F1-S8's core guarantee) and the grant is
  operator-revocable — a residual bad grant caught late is a contained,
  recoverable incident, not a PROD exposure.

Splits each migration file's raw text on `;` (Snowflake's statement
terminator) and flags any resulting statement containing BOTH a `GRANT`
keyword and a `TO PUBLIC` / `TO ROLE PUBLIC` target, case-insensitively,
tolerating whitespace/newlines within the statement. Deliberately does NOT
require `GRANT` to be the first token of the statement (a real migration
routinely has a multi-line comment block ahead of its first SQL statement
— see `migrations/V1.0.0__bootstrap.sql` — which a naive `^\\s*GRANT`
anchor would miss), and deliberately does NOT strip SQL comments before
matching (a comment mentioning both words is a rare, acceptable false
positive for a preventive guard whose job is to over-flag rather than
under-flag — the cost of a false positive is a human glancing at one
migration file, not a missed grant).

Scans every file `validate_migrations.py`'s own recursive collector would
consider a migration candidate (`.sql`, `.sql.jinja`, `.cli.yml`,
`.cli.yml.jinja`, at any depth) — reused directly, not re-implemented, so
the two scripts can never silently drift into scanning a different file
set.
"""

from __future__ import annotations

import re
import sys

from validate_migrations import MIGRATIONS_DIR, SNOWFLAKE_DIR, find_candidate_migration_files

# Matches a GRANT statement fragment naming PUBLIC (or ROLE PUBLIC) as its
# target, anywhere in a `;`-delimited statement -- see the module docstring
# for why this is a co-occurrence check, not an anchored one.
_GRANT_KEYWORD_PATTERN = re.compile(r"\bGRANT\b", re.IGNORECASE)
_TO_PUBLIC_PATTERN = re.compile(r"\bTO\s+(?:ROLE\s+)?PUBLIC\b", re.IGNORECASE | re.DOTALL)


def find_forbidden_public_grants(sql_text: str) -> list[str]:
    """Scans raw migration text for an obvious `GRANT ... TO PUBLIC` (or
    `TO ROLE PUBLIC`) statement.

    @param sql_text: The raw contents of one migration file (SQL or the
        raw text of a `.cli.yml` action script -- scanned the same way
        regardless of file type, since this is a text pattern match, not a
        structural parse).
    @returns: Each forbidden statement found (trimmed), empty if none.
    """
    matches = []
    for statement in sql_text.split(";"):
        if _GRANT_KEYWORD_PATTERN.search(statement) and _TO_PUBLIC_PATTERN.search(statement):
            matches.append(statement.strip())
    return matches


def main() -> int:
    candidates = find_candidate_migration_files(MIGRATIONS_DIR)
    if not candidates:
        print("no migrations found under migrations/ -- nothing to scan")
        return 0

    failed = False
    for path in candidates:
        rel_path = path.relative_to(SNOWFLAKE_DIR)
        text = path.read_text(encoding="utf-8")
        forbidden = find_forbidden_public_grants(text)
        for statement in forbidden:
            print(
                f"error: {rel_path} appears to GRANT ... TO PUBLIC -- forbidden per AGENTS.md's "
                f"'No grants to PUBLIC, anywhere' invariant:",
                file=sys.stderr,
            )
            print(f"  {statement}", file=sys.stderr)
            failed = True

    if failed:
        print(
            "error: this is a best-effort PREVENTIVE scan, not the authoritative control -- "
            "fix the migration; do not rely on the post-deploy grants audit to catch what this "
            "already caught",
            file=sys.stderr,
        )
        return 1

    print(f"scanned {len(candidates)} migration(s) for an obvious GRANT ... TO PUBLIC -- none found")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
