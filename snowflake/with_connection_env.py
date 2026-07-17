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
(explicit env always wins over the resolved connection).
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
    "private_key_file": "SNOWFLAKE_PRIVATE_KEY_FILE",
}


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
    return {env_var: str(params[toml_key]) for toml_key, env_var in _ENV_MAP.items() if toml_key in params}


def main(argv: list[str]) -> None:
    if not argv:
        raise SystemExit(f"usage: {Path(__file__).name} <command> [args...]")

    connection_name = os.environ.get("SCHEMACHANGE_CONNECTION_NAME", "roastpilot")
    config_path = Path(os.environ.get("SNOWFLAKE_CONFIG_TOML", "~/.snowflake/config.toml")).expanduser()

    resolved = resolve_connection_env(config_path=config_path, connection_name=connection_name)

    env = os.environ.copy()
    for env_var, value in resolved.items():
        env.setdefault(env_var, value)  # explicit shell env always wins

    os.execvpe(argv[0], argv, env)


if __name__ == "__main__":
    main(sys.argv[1:])
