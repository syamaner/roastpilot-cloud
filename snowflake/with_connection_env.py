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
(explicit env always wins over the resolved connection) — and, per
``should_bypass_config_resolution`` below, when the shell already provides
enough to authenticate on its own, config-file resolution isn't attempted
at all.

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
3. See ``should_bypass_config_resolution`` — config-file resolution is now
   skipped entirely when the calling environment already fully specifies a
   connection (the CI/F1-S8 shape: ``SNOWFLAKE_*`` injected as job secrets,
   no ``config.toml`` on the runner at all). Previously this script always
   attempted to read ``config.toml`` first and raised ``SystemExit`` when it
   was missing — a hard blocker for any env-only invocation, which is
   exactly what F1-S8's CI job needs.
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

# The minimal set of already-set env vars that mean "this environment fully
# specifies a connection on its own" (issue #18, Codex finding 4) — see
# should_bypass_config_resolution.
_ENV_ONLY_REQUIRED_VARS = ("SNOWFLAKE_ACCOUNT", "SNOWFLAKE_USER")


def resolve_connection_env(config_path: Path, connection_name: str) -> dict[str, str]:
    """Read one connection profile and map it to SNOWFLAKE_* env var values.

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


def should_bypass_config_resolution(environ: dict[str, str]) -> bool:
    """True when the calling environment already fully specifies a Snowflake
    connection on its own, so ``config.toml`` resolution should be skipped
    entirely rather than attempted (and then ``SystemExit``-ing on a missing
    file, the exact blocker issue #18's Codex finding 4 flagged).

    This is deliberately the CI/F1-S8 shape: a GitHub Actions job with
    ``SNOWFLAKE_ACCOUNT``/``SNOWFLAKE_USER`` (and, for key-pair auth,
    ``SNOWFLAKE_PRIVATE_KEY_FILE`` pointing at a runner-local temp file the
    job itself wrote from a secret) injected as job env — never a
    ``config.toml`` on the runner at all. Checking only ACCOUNT+USER (not
    every possible auth field) is deliberate: this script's job is to decide
    "is config-file resolution even relevant here", not to validate a full
    auth configuration — an incomplete env-only setup still fails the same
    way it always would, at the connector/schemachange layer, just without
    this bridge script getting in the way first.

    @param environ: The environment to check (a real or fake mapping — never
        mutated).
    @returns: Whether config-file resolution should be skipped.
    """
    return all(environ.get(var) for var in _ENV_ONLY_REQUIRED_VARS)


def build_launch_env(environ: dict[str, str]) -> dict[str, str]:
    """Pure orchestration: decides whether to bypass config-file resolution
    (see ``should_bypass_config_resolution``), and if not, resolves and
    merges the named connection profile into a COPY of ``environ``.

    Never touches the real process environment or execs anything — takes and
    returns plain dicts, so this is directly unit-testable (a fake
    ``environ`` in, an expected merged dict out) without mocking
    ``os.execvpe`` or touching a real shell environment.

    @param environ: The calling environment (a real or fake mapping — never
        mutated; a copy is always returned).
    @returns: The environment the target command should be exec'd with.
    """
    if should_bypass_config_resolution(environ):
        return dict(environ)

    connection_name = environ.get("SCHEMACHANGE_CONNECTION_NAME", "roastpilot")
    config_path = Path(environ.get("SNOWFLAKE_CONFIG_TOML", "~/.snowflake/config.toml")).expanduser()

    resolved = resolve_connection_env(config_path=config_path, connection_name=connection_name)

    env = dict(environ)
    for env_var, value in resolved.items():
        env.setdefault(env_var, value)  # explicit shell env always wins
    return env


def main(argv: list[str]) -> None:
    if not argv:
        raise SystemExit(f"usage: {Path(__file__).name} <command> [args...]")

    env = build_launch_env(dict(os.environ))
    os.execvpe(argv[0], argv, env)


if __name__ == "__main__":
    main(sys.argv[1:])
