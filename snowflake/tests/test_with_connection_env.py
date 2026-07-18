"""Tests for with_connection_env.py (issue #18 hardening).

with_connection_env.py is a standalone script, not a package (this repo's
Python surface is deliberately this one file + validate_migrations.py, never
added to a package layout) -- imported here via a direct sys.path insert of
snowflake/ itself, the simplest correct way to unit-test a script this small
without restructuring it into a package just for testability.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import with_connection_env  # noqa: E402


def write_config_toml(path: Path, connections: dict[str, dict[str, str]]) -> None:
    """Writes a minimal snow-CLI-style config.toml with [connections.<name>]
    tables, for a test to point SNOWFLAKE_CONFIG_TOML at."""
    lines = []
    for name, params in connections.items():
        lines.append(f"[connections.{name}]")
        for key, value in params.items():
            lines.append(f'{key} = "{value}"')
        lines.append("")
    path.write_text("\n".join(lines))


class TestResolveConnectionEnv:
    def test_maps_the_baseline_fields(self, tmp_path: Path) -> None:
        config_path = tmp_path / "config.toml"
        write_config_toml(
            config_path,
            {
                "roastpilot": {
                    "account": "HVPXLEY-EX88650",
                    "user": "ROASTPILOT_ADMIN_USER",
                    "role": "ROASTPILOT_ADMIN",
                    "warehouse": "ROASTPILOT_WH",
                    "authenticator": "SNOWFLAKE_JWT",
                }
            },
        )
        resolved = with_connection_env.resolve_connection_env(config_path, "roastpilot")
        assert resolved == {
            "SNOWFLAKE_ACCOUNT": "HVPXLEY-EX88650",
            "SNOWFLAKE_USER": "ROASTPILOT_ADMIN_USER",
            "SNOWFLAKE_ROLE": "ROASTPILOT_ADMIN",
            "SNOWFLAKE_WAREHOUSE": "ROASTPILOT_WH",
            "SNOWFLAKE_AUTHENTICATOR": "SNOWFLAKE_JWT",
        }

    def test_maps_database_and_schema_codex_finding_1(self, tmp_path: Path) -> None:
        # Previously dropped entirely -- a profile setting these (or a
        # caller omitting SNOWFLAKE_DATABASE) left schemachange with no
        # current database, so an unqualified `create schema app` ran
        # against nothing (issue #18, Codex finding 1).
        config_path = tmp_path / "config.toml"
        write_config_toml(
            config_path,
            {"roastpilot": {"account": "acc", "database": "ROASTPILOT_DEV", "schema": "APP"}},
        )
        resolved = with_connection_env.resolve_connection_env(config_path, "roastpilot")
        assert resolved["SNOWFLAKE_DATABASE"] == "ROASTPILOT_DEV"
        assert resolved["SNOWFLAKE_SCHEMA"] == "APP"

    def test_maps_private_key_file_spelling(self, tmp_path: Path) -> None:
        config_path = tmp_path / "config.toml"
        write_config_toml(
            config_path,
            {"roastpilot": {"account": "acc", "private_key_file": "/home/me/key.p8"}},
        )
        resolved = with_connection_env.resolve_connection_env(config_path, "roastpilot")
        assert resolved["SNOWFLAKE_PRIVATE_KEY_FILE"] == "/home/me/key.p8"

    def test_maps_private_key_path_spelling_codex_finding_2(self, tmp_path: Path) -> None:
        # The `snow` CLI accepts EITHER private_key_file or private_key_path
        # in a connection profile -- previously only private_key_file was
        # recognized, so a private_key_path profile silently exported no
        # key path at all and authentication failed (issue #18, Codex
        # finding 2). Both spellings must normalize to the SAME env var.
        config_path = tmp_path / "config.toml"
        write_config_toml(
            config_path,
            {"roastpilot": {"account": "acc", "private_key_path": "/home/me/key.p8"}},
        )
        resolved = with_connection_env.resolve_connection_env(config_path, "roastpilot")
        assert resolved["SNOWFLAKE_PRIVATE_KEY_FILE"] == "/home/me/key.p8"

    def test_prefers_private_key_file_when_a_profile_somehow_sets_both(self, tmp_path: Path) -> None:
        config_path = tmp_path / "config.toml"
        write_config_toml(
            config_path,
            {
                "roastpilot": {
                    "account": "acc",
                    "private_key_file": "/from/file/key.p8",
                    "private_key_path": "/from/path/key.p8",
                }
            },
        )
        resolved = with_connection_env.resolve_connection_env(config_path, "roastpilot")
        assert resolved["SNOWFLAKE_PRIVATE_KEY_FILE"] == "/from/file/key.p8"

    def test_raises_systemexit_for_a_missing_config_file(self, tmp_path: Path) -> None:
        missing = tmp_path / "does-not-exist.toml"
        try:
            with_connection_env.resolve_connection_env(missing, "roastpilot")
            raise AssertionError("expected SystemExit")
        except SystemExit as exc:
            assert "not found" in str(exc)

    def test_raises_systemexit_for_an_unknown_connection_name(self, tmp_path: Path) -> None:
        config_path = tmp_path / "config.toml"
        write_config_toml(config_path, {"roastpilot": {"account": "acc"}})
        try:
            with_connection_env.resolve_connection_env(config_path, "some-other-name")
            raise AssertionError("expected SystemExit")
        except SystemExit as exc:
            assert "not found" in str(exc)
            assert "roastpilot" in str(exc)  # lists what IS available


class TestBuildLaunchEnv:
    def test_tolerates_a_missing_config_toml_for_the_ci_env_only_shape(self, tmp_path: Path) -> None:
        # The CI/F1-S8 shape (issue #18, Codex finding 4): every SNOWFLAKE_*
        # field arrives as a job secret and there is NO config.toml on the
        # runner at all. The PRE-fix version always attempted config-file
        # resolution first and raised SystemExit on a missing file -- a hard
        # blocker for this exact shape. SNOWFLAKE_CONFIG_TOML deliberately
        # points at a path that does NOT exist, proving a missing file is
        # tolerated (returns unchanged), not fatal.
        environ = {
            "SNOWFLAKE_ACCOUNT": "HVPXLEY-EX88650",
            "SNOWFLAKE_USER": "CI_SERVICE_USER",
            "SNOWFLAKE_PRIVATE_KEY_FILE": "/runner/tmp/key.p8",
            "SNOWFLAKE_CONFIG_TOML": str(tmp_path / "does-not-exist.toml"),
        }
        result = with_connection_env.build_launch_env(environ)
        assert result == environ  # unchanged -- no profile to merge in

    def test_resolves_from_config_toml_when_the_env_does_not_already_specify_a_connection(
        self, tmp_path: Path
    ) -> None:
        config_path = tmp_path / "config.toml"
        write_config_toml(config_path, {"roastpilot": {"account": "acc", "user": "usr"}})
        environ = {"SNOWFLAKE_CONFIG_TOML": str(config_path)}
        result = with_connection_env.build_launch_env(environ)
        assert result["SNOWFLAKE_ACCOUNT"] == "acc"
        assert result["SNOWFLAKE_USER"] == "usr"

    def test_merges_per_field_when_the_env_partially_specifies_a_connection_codex_p2_round3(
        self, tmp_path: Path
    ) -> None:
        # The exact bug this round's fold fixes: an EARLIER version of
        # build_launch_env skipped config.toml resolution ENTIRELY whenever
        # SNOWFLAKE_ACCOUNT/SNOWFLAKE_USER were both already in the
        # environment -- correct for CI (every field is already present) but
        # wrong for a caller with only ACCOUNT+USER in the shell (e.g.
        # testing with a temporary override) who still relies on the
        # profile for private_key/role/warehouse/database. Those fields
        # must NOT be silently dropped just because ACCOUNT+USER happened
        # to already be set.
        config_path = tmp_path / "config.toml"
        write_config_toml(
            config_path,
            {
                "roastpilot": {
                    "account": "from-config",  # overridden by env below -- must NOT win
                    "user": "from-config-user",  # overridden by env below -- must NOT win
                    "private_key_file": "/from/profile/key.p8",
                    "role": "ROASTPILOT_ADMIN",
                    "warehouse": "ROASTPILOT_WH",
                    "database": "ROASTPILOT_DEV",
                }
            },
        )
        environ = {
            "SNOWFLAKE_CONFIG_TOML": str(config_path),
            "SNOWFLAKE_ACCOUNT": "from-shell",
            "SNOWFLAKE_USER": "from-shell-user",
        }
        result = with_connection_env.build_launch_env(environ)
        # Env wins for the fields it set...
        assert result["SNOWFLAKE_ACCOUNT"] == "from-shell"
        assert result["SNOWFLAKE_USER"] == "from-shell-user"
        # ...and the profile fills in every field the env DIDN'T set --
        # the exact fields the old all-or-nothing bypass would have lost.
        assert result["SNOWFLAKE_PRIVATE_KEY_FILE"] == "/from/profile/key.p8"
        assert result["SNOWFLAKE_ROLE"] == "ROASTPILOT_ADMIN"
        assert result["SNOWFLAKE_WAREHOUSE"] == "ROASTPILOT_WH"
        assert result["SNOWFLAKE_DATABASE"] == "ROASTPILOT_DEV"

    def test_explicit_env_wins_over_the_resolved_connection(self, tmp_path: Path) -> None:
        config_path = tmp_path / "config.toml"
        write_config_toml(config_path, {"roastpilot": {"account": "from-config", "warehouse": "wh1"}})
        environ = {
            "SNOWFLAKE_CONFIG_TOML": str(config_path),
            "SNOWFLAKE_ACCOUNT": "from-shell",
            "SNOWFLAKE_WAREHOUSE": "from-shell-wh",
        }
        result = with_connection_env.build_launch_env(environ)
        assert result["SNOWFLAKE_ACCOUNT"] == "from-shell"  # shell wins, not "from-config"
        assert result["SNOWFLAKE_WAREHOUSE"] == "from-shell-wh"  # shell wins, not "wh1"

    def test_a_config_toml_that_exists_but_lacks_the_requested_connection_still_raises(
        self, tmp_path: Path
    ) -> None:
        # Distinguishes "no file at all" (tolerated) from "a file that
        # exists but doesn't have the profile we asked for" (still a real
        # misconfiguration -- must still fail loudly, not silently proceed
        # with nothing).
        config_path = tmp_path / "config.toml"
        write_config_toml(config_path, {"some-other-connection": {"account": "acc"}})
        environ = {"SNOWFLAKE_CONFIG_TOML": str(config_path)}
        try:
            with_connection_env.build_launch_env(environ)
            raise AssertionError("expected SystemExit")
        except SystemExit as exc:
            assert "not found" in str(exc)

    def test_never_mutates_the_input_environ(self, tmp_path: Path) -> None:
        config_path = tmp_path / "config.toml"
        write_config_toml(config_path, {"roastpilot": {"account": "acc"}})
        environ = {"SNOWFLAKE_CONFIG_TOML": str(config_path)}
        original = dict(environ)
        with_connection_env.build_launch_env(environ)
        assert environ == original


class TestMain:
    """main() itself calls os.execvpe, which REPLACES the current process --
    genuinely untestable by calling it for real (it would kill the test
    runner). Mocked here to verify main()'s own wiring (argv/env
    construction, the empty-argv guard) without needing a real process
    replacement -- os.environ itself is left untouched either way, since
    build_launch_env (tested directly above) never mutates its input.
    """

    def test_raises_systemexit_with_a_usage_message_for_empty_argv(self) -> None:
        try:
            with_connection_env.main([])
            raise AssertionError("expected SystemExit")
        except SystemExit as exc:
            assert "usage:" in str(exc)

    def test_execs_the_given_command_with_the_built_launch_env(self, monkeypatch, tmp_path: Path) -> None:
        calls = []
        monkeypatch.setattr(os, "execvpe", lambda *args: calls.append(args))
        monkeypatch.setenv("SNOWFLAKE_ACCOUNT", "acc-from-shell")
        monkeypatch.setenv("SNOWFLAKE_USER", "user-from-shell")
        # Deliberately isolated from whatever real config.toml the machine
        # running this test might have (build_launch_env now always checks
        # config_path.is_file() -- without this, a developer's own real
        # ~/.snowflake/config.toml would get read here, making this test's
        # outcome depend on that machine's local state).
        monkeypatch.setenv("SNOWFLAKE_CONFIG_TOML", str(tmp_path / "does-not-exist.toml"))

        with_connection_env.main(["schemachange", "deploy"])

        assert len(calls) == 1
        exec_argv0, exec_argv, exec_env = calls[0]
        assert exec_argv0 == "schemachange"
        assert exec_argv == ["schemachange", "deploy"]
        assert exec_env["SNOWFLAKE_ACCOUNT"] == "acc-from-shell"
        assert exec_env["SNOWFLAKE_USER"] == "user-from-shell"
