#!/usr/bin/env python3
"""Bridge a named Snowflake connection into schemachange's env-var input.

Reads a connection profile from ``~/.snowflake/config.toml`` (the file the
`snow` CLI writes: connections nested as ``[connections.<name>]``) and execs
the given command with the matching ``SNOWFLAKE_*`` environment variables
set, so ``schemachange`` (and ``snowflake-connector-python`` generally) pick
them up at their standard ENV layer.

Why this exists: schemachange 4.3.3's own connections.toml reader
(``schemachange.config.utils.get_connections_toml_parameters``) expects the
classic flat ``connections.toml`` layout — top-level ``[connection_name]``
tables — not the nested ``[connections.<name>]`` layout ``snow`` writes to
``config.toml``. Verified empirically: pointed directly at this repo's real
``~/.snowflake/config.toml``, that reader returns an empty parameter set for
the ``roastpilot`` connection. Env vars are schemachange's other
fully-supported input layer, so this script is the bridge, read once from
the single source of truth (``config.toml``), nothing duplicated into the
repo, and never a secret value on disk here — only a private key *path*.

Usage::

    python3 with_connection_env.py schemachange deploy --schemachange-create-change-history-table
    python3 with_connection_env.py snow connection test -c roastpilot

Env vars:
    SCHEMACHANGE_CONNECTION_NAME  connection profile to read (default: roastpilot)
    SNOWFLAKE_CONFIG_TOML         path to the config file (default: ~/.snowflake/config.toml)

Any SNOWFLAKE_* variable already set in the calling shell is left alone
(explicit env always wins over the resolved connection, PER FIELD — see
``build_launch_env``), and a missing ``config.toml`` is tolerated rather
than fatal (the CI shape: no such file exists on a GitHub Actions runner
at all).

Hardened per issue #18 (Codex findings on #17's review, all fast-followed
before F1-S8/C2 need this script under real load):

1. ``database``/``schema`` are now mapped from the connection profile —
   previously dropped entirely, so a profile that set them (or a caller that
   omitted ``SNOWFLAKE_DATABASE``) would leave schemachange/the connector
   with no current database, and an unqualified ``create schema app`` would
   run against nothing.
2. ``private_key_path`` (the `snow` CLI also accepts this spelling,
   alongside ``private_key_file``) is now normalized to the same
   ``SNOWFLAKE_PRIVATE_KEY_FILE`` env var schemachange/the connector read
   natively — previously only ``private_key_file`` was recognized, so a
   ``private_key_path`` profile failed authentication silently (no key
   path ever exported).
3. A missing ``config.toml`` is tolerated, not fatal (see
   ``build_launch_env``) — needed for the CI/F1-S8 shape, where
   SNOWFLAKE_* arrives as job secrets and there is no ``config.toml`` on
   the runner at all. Previously this script always attempted to read
   ``config.toml`` first and raised ``SystemExit`` when it was missing — a
   hard blocker for any env-only invocation.

   An EARLIER version of this fix skipped config-file resolution ENTIRELY
   whenever SNOWFLAKE_ACCOUNT/SNOWFLAKE_USER were both already set in the
   environment (Codex round-2 P2, #56) — too coarse: a caller with only
   those two fields in the shell, relying on the profile for
   private_key/role/warehouse/database, silently lost every one of those
   fields. The correct semantics, and what's implemented now, is a
   per-field merge: read the profile IF the file exists, and for each
   individual field prefer the environment but fall back to the profile —
   never an all-or-nothing choice keyed on which two fields happen to be
   set.
"""

from __future__ import annotations

import os
import sys
import tomllib
from pathlib import Path

# TOML key (under [connections.<name>]) -> env var schemachange/the Snowflake
# connector read natively.
_ENV_MAP = {
    "account": "SNOWFLAKE_ACCOUNT",
    "user": "SNOWFLAKE_USER",
    "role": "SNOWFLAKE_ROLE",
    "warehouse": "SNOWFLAKE_WAREHOUSE",
    "authenticator": "SNOWFLAKE_AUTHENTICATOR",
    "database": "SNOWFLAKE_DATABASE",
    "schema": "SNOWFLAKE_SCHEMA",
}

# Both TOML key spellings a `snow`-CLI connection profile may use for a
# key-pair auth key's file path (issue #18, Codex finding 2) — normalized to
# the SAME target env var, not two separate dict entries, so which spelling
# a profile happens to use never silently loses the value. `private_key_file`
# is preferred if a profile somehow sets both.
_PRIVATE_KEY_TOML_KEYS = ("private_key_file", "private_key_path")
_PRIVATE_KEY_ENV_VAR = "SNOWFLAKE_PRIVATE_KEY_FILE"


def resolve_connection_env(config_path: Path, connection_name: str) -> dict[str, str]:
    """Read one connection profile and map it to SNOWFLAKE_* env var values.

    Assumes ``config_path`` exists — callers that need to tolerate a missing
    file (see ``build_launch_env``) must check ``config_path.is_file()``
    themselves before calling this; a missing file here is still always a
    hard error, since a caller that DID call this expects the file to be
    readable.

    Args:
        config_path: Path to the ``snow``-CLI-style ``config.toml``.
        connection_name: Name of the ``[connections.<name>]`` profile to read.

    Returns:
        Mapping of env var name to value for every recognized field present
        in the profile.

    Raises:
        SystemExit: If the config file or the named connection is missing.
    """
    if not config_path.is_file():
        raise SystemExit(f"error: Snowflake config file not found: {config_path}")

    with config_path.open("rb") as config_file:
        data = tomllib.load(config_file)

    connections = data.get("connections", {})
    if connection_name not in connections:
        available = sorted(connections) or ["(none)"]
        raise SystemExit(
            f"error: connection '{connection_name}' not found in {config_path} "
            f"(available: {', '.join(available)})"
        )

    params = connections[connection_name]
    resolved = {env_var: str(params[toml_key]) for toml_key, env_var in _ENV_MAP.items() if toml_key in params}
    for toml_key in _PRIVATE_KEY_TOML_KEYS:
        if toml_key in params:
            resolved[_PRIVATE_KEY_ENV_VAR] = str(params[toml_key])
            break
    return resolved


def build_launch_env(environ: dict[str, str]) -> dict[str, str]:
    """Pure orchestration: merges a connection profile's fields into a COPY
    of ``environ``, per field — explicit shell env always wins for any
    single field, the profile fills in whatever the shell didn't already
    set, and the profile is skipped entirely (never an error) when
    ``config.toml`` doesn't exist at all.

    This is a PER-FIELD merge (Codex P2, #56 round 3), not an all-or-nothing
    choice: an earlier version of this function skipped config-file
    resolution ENTIRELY whenever ``SNOWFLAKE_ACCOUNT``/``SNOWFLAKE_USER``
    were both already in ``environ`` — correct for the CI/F1-S8 shape (every
    field arrives as a job secret, so the profile is genuinely never needed
    there), but wrong for a caller with only SOME fields in the shell (e.g.
    testing with a temporary ``SNOWFLAKE_ACCOUNT`` override) who still
    relies on the profile for the rest (``private_key``/``role``/
    ``warehouse``/``database``) — that caller would have silently lost
    every one of those fields. Reading the profile whenever the file exists,
    and merging per field, supports both shapes correctly: CI's case still
    works exactly as before (every field is already in ``environ``, so the
    profile's values are never actually used even though the file — if one
    happened to exist — would now be read), and a partial local override no
    longer loses the rest of the profile.

    A ``config.toml`` that EXISTS but doesn't contain the requested
    connection profile is still a hard failure (``resolve_connection_env``'s
    own ``SystemExit``) — that's a genuine misconfiguration, not "no local
    file at all".

    Never touches the real process environment or execs anything — takes and
    returns plain dicts, so this is directly unit-testable (a fake
    ``environ`` in, an expected merged dict out) without mocking
    ``os.execvpe`` or touching a real shell environment.

    @param environ: The calling environment (a real or fake mapping — never
        mutated; a copy is always returned).
    @returns: The environment the target command should be exec'd with.
    """
    connection_name = environ.get("SCHEMACHANGE_CONNECTION_NAME", "roastpilot")
    config_path = Path(environ.get("SNOWFLAKE_CONFIG_TOML", "~/.snowflake/config.toml")).expanduser()

    resolved: dict[str, str] = {}
    if config_path.is_file():
        resolved = resolve_connection_env(config_path=config_path, connection_name=connection_name)
    # A missing config.toml is NOT an error here — proceed with whatever
    # environ already provides (the CI/F1-S8 shape). resolve_connection_env
    # itself still raises SystemExit for a genuine misconfiguration: the
    # file EXISTS but doesn't contain the requested connection profile.

    env = dict(environ)
    for env_var, value in resolved.items():
        env.setdefault(env_var, value)  # explicit shell env always wins, per field; the profile fills gaps
    return env


def main(argv: list[str]) -> None:
    if not argv:
        raise SystemExit(f"usage: {Path(__file__).name} <command> [args...]")

    env = build_launch_env(dict(os.environ))
    os.execvpe(argv[0], argv, env)


if __name__ == "__main__":
    main(sys.argv[1:])
