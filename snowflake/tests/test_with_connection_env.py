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


class TestShouldBypassConfigResolution:
    def test_true_when_account_and_user_are_both_already_set(self) -> None:
        assert with_connection_env.should_bypass_config_resolution(
            {"SNOWFLAKE_ACCOUNT": "acc", "SNOWFLAKE_USER": "user"}
        )

    def test_false_when_neither_is_set(self) -> None:
        assert not with_connection_env.should_bypass_config_resolution({})

    def test_false_when_only_account_is_set(self) -> None:
        assert not with_connection_env.should_bypass_config_resolution({"SNOWFLAKE_ACCOUNT": "acc"})

    def test_false_when_only_user_is_set(self) -> None:
        assert not with_connection_env.should_bypass_config_resolution({"SNOWFLAKE_USER": "user"})

    def test_false_when_a_required_var_is_set_but_empty(self) -> None:
        # An empty string is falsy for this check -- treated the same as
        # unset, not as "explicitly set to nothing".
        assert not with_connection_env.should_bypass_config_resolution(
            {"SNOWFLAKE_ACCOUNT": "", "SNOWFLAKE_USER": "user"}
        )


class TestBuildLaunchEnv:
    def test_bypasses_config_resolution_entirely_for_the_ci_env_only_shape_codex_finding_4(
        self, tmp_path: Path
    ) -> None:
        # The exact bug (issue #18, Codex finding 4): CI has SNOWFLAKE_* as
        # job secrets and NO config.toml on the runner at all. The
        # PRE-fix version always attempted config-file resolution first and
        # raised SystemExit on a missing file -- a hard blocker for this
        # exact shape. SNOWFLAKE_CONFIG_TOML deliberately points at a path
        # that does NOT exist, proving resolution is never even attempted.
        environ = {
            "SNOWFLAKE_ACCOUNT": "HVPXLEY-EX88650",
            "SNOWFLAKE_USER": "CI_SERVICE_USER",
            "SNOWFLAKE_PRIVATE_KEY_FILE": "/runner/tmp/key.p8",
            "SNOWFLAKE_CONFIG_TOML": str(tmp_path / "does-not-exist.toml"),
        }
        result = with_connection_env.build_launch_env(environ)
        assert result == environ  # unchanged -- passed straight through

    def test_resolves_from_config_toml_when_the_env_does_not_already_specify_a_connection(
        self, tmp_path: Path
    ) -> None:
        config_path = tmp_path / "config.toml"
        write_config_toml(config_path, {"roastpilot": {"account": "acc", "user": "usr"}})
        environ = {"SNOWFLAKE_CONFIG_TOML": str(config_path)}
        result = with_connection_env.build_launch_env(environ)
        assert result["SNOWFLAKE_ACCOUNT"] == "acc"
        assert result["SNOWFLAKE_USER"] == "usr"

    def test_explicit_env_wins_over_the_resolved_connection(self, tmp_path: Path) -> None:
        config_path = tmp_path / "config.toml"
        write_config_toml(config_path, {"roastpilot": {"account": "from-config", "warehouse": "wh1"}})
        # Only SNOWFLAKE_ACCOUNT is pre-set here, deliberately -- setting
        # SNOWFLAKE_USER too would trigger the bypass path (tested above)
        # and never exercise resolve_connection_env's own merge-precedence
        # at all. This proves precedence on WAREHOUSE, a field the bypass
        # check doesn't gate on either way.
        environ = {
            "SNOWFLAKE_CONFIG_TOML": str(config_path),
            "SNOWFLAKE_ACCOUNT": "from-shell",
            "SNOWFLAKE_WAREHOUSE": "from-shell-wh",
        }
        result = with_connection_env.build_launch_env(environ)
        assert result["SNOWFLAKE_ACCOUNT"] == "from-shell"  # shell wins, not "from-config"
        assert result["SNOWFLAKE_WAREHOUSE"] == "from-shell-wh"  # shell wins, not "wh1"

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

    def test_execs_the_given_command_with_the_built_launch_env(self, monkeypatch) -> None:
        calls = []
        monkeypatch.setattr(os, "execvpe", lambda *args: calls.append(args))
        monkeypatch.setenv("SNOWFLAKE_ACCOUNT", "acc-from-shell")
        monkeypatch.setenv("SNOWFLAKE_USER", "user-from-shell")  # triggers the env-only bypass

        with_connection_env.main(["schemachange", "deploy"])

        assert len(calls) == 1
        exec_argv0, exec_argv, exec_env = calls[0]
        assert exec_argv0 == "schemachange"
        assert exec_argv == ["schemachange", "deploy"]
        assert exec_env["SNOWFLAKE_ACCOUNT"] == "acc-from-shell"
        assert exec_env["SNOWFLAKE_USER"] == "user-from-shell"
