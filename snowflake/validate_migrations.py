#!/usr/bin/env python3
"""Offline validation for snowflake/migrations/.

Checks every migration file matches schemachange's own V/R/A naming
convention (reusing schemachange's real classifier, not a hand-rolled
regex) and renders cleanly via ``schemachange render``. Never opens a
Snowflake connection or reads any credential — safe to run in CI with no
secrets, and this is exactly what the CI job runs.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

from schemachange.session.Script import AlwaysScript, RepeatableScript, VersionedScript

SNOWFLAKE_DIR = Path(__file__).resolve().parent
MIGRATIONS_DIR = SNOWFLAKE_DIR / "migrations"
SCRIPT_CLASSES = (VersionedScript, RepeatableScript, AlwaysScript)


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


def classify(path: Path) -> str | None:
    """Return the schemachange script kind for a migration file, or None if
    its filename doesn't match any recognized convention.
    """
    for script_cls in SCRIPT_CLASSES:
        if script_cls.pattern.search(path.name):
            try:
                script_cls.from_path(file_path=path)
            except ValueError as error:
                print(f"error: {path.name}: {error}", file=sys.stderr)
                return None
            return script_cls.__name__
    return None


def main() -> int:
    sql_files = sorted(MIGRATIONS_DIR.glob("*.sql"))
    if not sql_files:
        print("no migrations found under migrations/ -- nothing to validate")
        return 0

    schemachange_bin = _schemachange_executable()

    failed = False
    for path in sql_files:
        kind = classify(path)
        if kind is None:
            print(
                f"error: {path.name} does not match schemachange's "
                "V<version>__description.sql / R__description.sql / "
                "A__description.sql naming convention",
                file=sys.stderr,
            )
            failed = True
            continue

        print(f"{path.name}: {kind}, rendering...")
        result = subprocess.run(
            [schemachange_bin, "render", str(path.relative_to(SNOWFLAKE_DIR))],
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

    print(f"validated {len(sql_files)} migration(s) offline (no Snowflake connection)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
