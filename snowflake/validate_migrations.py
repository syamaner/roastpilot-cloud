#!/usr/bin/env python3
"""Offline validation for snowflake/migrations/.

Checks every migration file matches schemachange's own V/R/A naming
convention (reusing schemachange's real classifier, not a hand-rolled
regex) and renders cleanly via ``schemachange render``. Never opens a
Snowflake connection or reads any credential — safe to run in CI with no
secrets, and this is exactly what the CI job runs.

Recursive + jinja/CLI coverage (issue #18, Codex finding 3, fast-followed
from #17's review): the ORIGINAL version of this validator only scanned
``migrations/*.sql`` — top-level, SQL-only. schemachange's own deploy-time
collector (``schemachange.session.Script.get_all_scripts_recursively``)
walks the ENTIRE migrations tree recursively and additionally recognizes
``.sql.jinja`` (jinja-templated SQL) and ``.cli.yml``/``.cli.yml.jinja``
(Snowflake CLI action scripts) — a migration in a subdirectory, or using
either of those formats, would deploy completely unvalidated by CI. Fixed
by mirroring schemachange 4.3.3's own recursive walk and file-extension
regexes exactly (``_candidate_migration_files`` below — verified against
the installed ``schemachange.session.Script`` module's source, not
guessed), so this validator sees every file schemachange itself would ever
try to classify at deploy time.
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

from schemachange.session.Script import (
    AlwaysCLIScript,
    AlwaysScript,
    RepeatableCLIScript,
    RepeatableScript,
    VersionedCLIScript,
    VersionedScript,
    get_all_scripts_recursively,
)

SNOWFLAKE_DIR = Path(__file__).resolve().parent
MIGRATIONS_DIR = SNOWFLAKE_DIR / "migrations"
SCRIPT_CLASSES = (VersionedScript, RepeatableScript, AlwaysScript)
CLI_SCRIPT_CLASSES = (VersionedCLIScript, RepeatableCLIScript, AlwaysCLIScript)

# Mirrors schemachange 4.3.3's own get_all_scripts_recursively (installed
# package, snowflake/.venv/lib/*/site-packages/schemachange/session/Script.py)
# EXACTLY — same two extension regexes, same case-insensitivity. Duplicated
# here (not importable as module constants; they're locals inside that
# function) rather than re-derived from first principles, so this validator
# sees precisely what schemachange's deploy-time collector would. A future
# schemachange version bump should re-diff these two lines against the new
# installed source before trusting them again.
_SQL_EXTENSION_PATTERN = re.compile(r"\.sql(\.jinja)?$", re.IGNORECASE)
_CLI_EXTENSION_PATTERN = re.compile(r"\.cli\.yml(\.jinja)?$", re.IGNORECASE)


def _schemachange_executable() -> str:
    """Locate the schemachange console script.

    Prefers PATH, then falls back to the same bin/ directory as the running
    interpreter (covers a venv where the script isn't PATH-exported).
    """
    found = shutil.which("schemachange")
    if found is not None:
        return found
    sibling = Path(sys.executable).parent / "schemachange"
    if sibling.is_file():
        return str(sibling)
    raise SystemExit("error: schemachange executable not found on PATH or next to the interpreter")


def find_candidate_migration_files(migrations_dir: Path) -> list[Path]:
    """Every file schemachange's own deploy-time collector would consider a
    migration CANDIDATE — matches its ``.sql``/``.sql.jinja``/``.cli.yml``/
    ``.cli.yml.jinja`` extension pattern, recursively, at any depth (see the
    module docstring for why this replaced a top-level-only ``*.sql`` glob).

    A file matching neither extension pattern is not a migration candidate
    at all (README.md, requirements.txt, a stray ``.venv/`` if one somehow
    existed under ``migrations/``) and is silently excluded, same as
    schemachange's own collector would exclude it.

    @param migrations_dir: The migrations root directory to walk.
    @returns: Every matching file path, sorted for deterministic output.
    """
    return sorted(
        path
        for path in migrations_dir.glob("**/*")
        if path.is_file()
        and (_SQL_EXTENSION_PATTERN.search(path.name) or _CLI_EXTENSION_PATTERN.search(path.name))
    )


def classify(path: Path) -> str | None:
    """Return the schemachange script kind for a migration file, or None if
    its filename doesn't match any recognized V/R/A (or CLI-equivalent)
    naming convention — schemachange's own collector would silently SKIP
    such a file at deploy time (never validated, never deployed); this
    function's caller treats that as a hard validation failure instead, so
    a naming mistake is caught here rather than becoming a silently-never-
    applied migration.
    """
    classes = CLI_SCRIPT_CLASSES if _CLI_EXTENSION_PATTERN.search(path.name) else SCRIPT_CLASSES
    for script_cls in classes:
        if script_cls.pattern.search(path.name):
            try:
                script_cls.from_path(file_path=path)
            except ValueError as error:
                print(f"error: {path.name}: {error}", file=sys.stderr)
                return None
            return script_cls.__name__
    return None


def main() -> int:
    candidates = find_candidate_migration_files(MIGRATIONS_DIR)
    if not candidates:
        print("no migrations found under migrations/ -- nothing to validate")
        return 0

    # Catches what schemachange's own get_all_scripts_recursively raises
    # for (never silently skips): a filename that DOES match a V/R/A prefix
    # but violates a real formatting rule (e.g. one underscore instead of
    # two), or two scripts sharing the same name/version. Run BEFORE the
    # per-file render loop below so a hard structural violation is reported
    # even if it would otherwise be masked by a later per-file failure.
    try:
        get_all_scripts_recursively(MIGRATIONS_DIR)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1

    schemachange_bin = _schemachange_executable()

    failed = False
    for path in candidates:
        rel_path = path.relative_to(SNOWFLAKE_DIR)
        kind = classify(path)
        if kind is None:
            print(
                f"error: {rel_path} does not match schemachange's "
                "V<version>__description / R__description / A__description "
                "naming convention (would be silently ignored at deploy time)",
                file=sys.stderr,
            )
            failed = True
            continue

        print(f"{rel_path}: {kind}, rendering...")
        result = subprocess.run(
            [schemachange_bin, "render", str(rel_path)],
            cwd=SNOWFLAKE_DIR,
            capture_output=True,
            text=True,
            check=False,
        )
        if result.returncode != 0:
            print(result.stdout)
            print(result.stderr, file=sys.stderr)
            failed = True

    if failed:
        return 1

    print(f"validated {len(candidates)} migration(s) offline (no Snowflake connection)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
