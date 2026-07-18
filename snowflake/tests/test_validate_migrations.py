"""Tests for validate_migrations.py (issue #18, Codex finding 3: recursive +
jinja/CLI coverage).

Imported via a direct sys.path insert of snowflake/ itself, same reasoning
as test_with_connection_env.py.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import validate_migrations  # noqa: E402


class TestSchemachangeExecutable:
    def test_prefers_the_path_resolved_executable_when_found(self, monkeypatch) -> None:
        monkeypatch.setattr(validate_migrations.shutil, "which", lambda name: "/usr/bin/schemachange")
        assert validate_migrations._schemachange_executable() == "/usr/bin/schemachange"

    def test_falls_back_to_the_interpreters_sibling_bin_when_not_on_path(
        self, monkeypatch, tmp_path: Path
    ) -> None:
        fake_interpreter = tmp_path / "python3"
        fake_interpreter.touch()
        fake_sibling = tmp_path / "schemachange"
        fake_sibling.touch()
        monkeypatch.setattr(validate_migrations.shutil, "which", lambda name: None)
        monkeypatch.setattr(validate_migrations.sys, "executable", str(fake_interpreter))
        assert validate_migrations._schemachange_executable() == str(fake_sibling)

    def test_raises_systemexit_when_found_neither_on_path_nor_as_a_sibling(
        self, monkeypatch, tmp_path: Path
    ) -> None:
        fake_interpreter = tmp_path / "python3"
        fake_interpreter.touch()  # no sibling "schemachange" file created
        monkeypatch.setattr(validate_migrations.shutil, "which", lambda name: None)
        monkeypatch.setattr(validate_migrations.sys, "executable", str(fake_interpreter))
        try:
            validate_migrations._schemachange_executable()
            raise AssertionError("expected SystemExit")
        except SystemExit as exc:
            assert "not found" in str(exc)


class TestFindCandidateMigrationFiles:
    def test_finds_a_top_level_sql_file(self, tmp_path: Path) -> None:
        (tmp_path / "V1.0.0__bootstrap.sql").write_text("select 1;")
        found = validate_migrations.find_candidate_migration_files(tmp_path)
        assert found == [tmp_path / "V1.0.0__bootstrap.sql"]

    def test_finds_a_migration_in_a_subdirectory_the_original_top_level_only_glob_missed(
        self, tmp_path: Path
    ) -> None:
        # The exact gap (issue #18, Codex finding 3): the pre-fix validator
        # used MIGRATIONS_DIR.glob("*.sql") -- top-level only. A migration
        # organized under a subdirectory would deploy completely
        # unvalidated by CI.
        subdir = tmp_path / "app"
        subdir.mkdir()
        (subdir / "V1.1.0__add_table.sql").write_text("select 1;")
        found = validate_migrations.find_candidate_migration_files(tmp_path)
        assert found == [subdir / "V1.1.0__add_table.sql"]

    def test_finds_a_jinja_templated_sql_migration(self, tmp_path: Path) -> None:
        (tmp_path / "V1.2.0__jinja.sql.jinja").write_text("select {{ env_var('X') }};")
        found = validate_migrations.find_candidate_migration_files(tmp_path)
        assert found == [tmp_path / "V1.2.0__jinja.sql.jinja"]

    def test_finds_a_cli_yaml_migration_and_its_jinja_variant(self, tmp_path: Path) -> None:
        (tmp_path / "V1.3.0__cli_action.cli.yml").write_text("commands: []")
        (tmp_path / "V1.4.0__cli_action_jinja.cli.yml.jinja").write_text("commands: []")
        found = validate_migrations.find_candidate_migration_files(tmp_path)
        assert found == sorted(
            [
                tmp_path / "V1.3.0__cli_action.cli.yml",
                tmp_path / "V1.4.0__cli_action_jinja.cli.yml.jinja",
            ]
        )

    def test_ignores_a_non_migration_file(self, tmp_path: Path) -> None:
        (tmp_path / "README.md").write_text("# notes")
        (tmp_path / "V1.0.0__bootstrap.sql").write_text("select 1;")
        found = validate_migrations.find_candidate_migration_files(tmp_path)
        assert found == [tmp_path / "V1.0.0__bootstrap.sql"]

    def test_is_case_insensitive_on_the_extension_matching_schemachanges_own_regex(
        self, tmp_path: Path
    ) -> None:
        (tmp_path / "V1.0.0__bootstrap.SQL").write_text("select 1;")
        found = validate_migrations.find_candidate_migration_files(tmp_path)
        assert found == [tmp_path / "V1.0.0__bootstrap.SQL"]

    def test_empty_directory_finds_nothing(self, tmp_path: Path) -> None:
        assert validate_migrations.find_candidate_migration_files(tmp_path) == []


class TestClassify:
    def test_classifies_a_versioned_sql_script(self, tmp_path: Path) -> None:
        path = tmp_path / "V1.0.0__bootstrap.sql"
        path.write_text("select 1;")
        assert validate_migrations.classify(path) == "VersionedScript"

    def test_classifies_a_repeatable_sql_script(self, tmp_path: Path) -> None:
        path = tmp_path / "R__a_view.sql"
        path.write_text("create or replace view v as select 1;")
        assert validate_migrations.classify(path) == "RepeatableScript"

    def test_classifies_an_always_sql_script(self, tmp_path: Path) -> None:
        path = tmp_path / "A__seed.sql"
        path.write_text("select 1;")
        assert validate_migrations.classify(path) == "AlwaysScript"

    def test_classifies_a_versioned_cli_script_using_the_cli_classes_not_sql_ones(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "V2.0.0__cli_action.cli.yml"
        path.write_text("commands: []")
        assert validate_migrations.classify(path) == "VersionedCLIScript"

    def test_returns_none_for_a_filename_matching_no_v_r_a_prefix(self, tmp_path: Path) -> None:
        path = tmp_path / "whoops.sql"
        path.write_text("select 1;")
        assert validate_migrations.classify(path) is None

    def test_returns_none_and_reports_a_single_underscore_separator_violation(
        self, tmp_path: Path, capsys
    ) -> None:
        # schemachange requires TWO underscores between the version/prefix
        # and the description -- a real formatting mistake VersionedScript's
        # own from_path() rejects, not just an unrecognized-pattern case.
        path = tmp_path / "V1.1_only_one_underscore.sql"
        path.write_text("select 1;")
        assert validate_migrations.classify(path) is None
        assert "two underscores are required" in capsys.readouterr().err


class TestMainEndToEnd:
    """Drives main() against a real MIGRATIONS_DIR override, through the
    REAL installed schemachange render command -- not mocked -- same
    "prove it against the real tool" discipline this module's own docstring
    describes for find_candidate_migration_files.
    """

    def _run_main_against(self, monkeypatch, migrations_dir: Path) -> int:
        # main() uses SNOWFLAKE_DIR (not just MIGRATIONS_DIR) for both the
        # schemachange subprocess's cwd= and every path.relative_to() call
        # -- SNOWFLAKE_DIR must be monkeypatched to an ancestor of
        # migrations_dir too, or relative_to() raises ValueError for any
        # tmp_path-rooted fixture (caught empirically: the first draft of
        # these tests only patched MIGRATIONS_DIR and failed exactly this
        # way). Using migrations_dir itself as SNOWFLAKE_DIR is always a
        # valid ancestor of every file under it, regardless of whether the
        # test nests files in a subdirectory.
        monkeypatch.setattr(validate_migrations, "SNOWFLAKE_DIR", migrations_dir)
        monkeypatch.setattr(validate_migrations, "MIGRATIONS_DIR", migrations_dir)
        return validate_migrations.main()

    def test_validates_a_migration_in_a_subdirectory_end_to_end(
        self, tmp_path: Path, monkeypatch, capsys
    ) -> None:
        subdir = tmp_path / "app"
        subdir.mkdir()
        (subdir / "V1.0.0__bootstrap.sql").write_text("create schema if not exists app;")
        exit_code = self._run_main_against(monkeypatch, tmp_path)
        assert exit_code == 0
        assert "validated 1 migration(s)" in capsys.readouterr().out

    def test_validates_a_jinja_migration_end_to_end(self, tmp_path: Path, monkeypatch, capsys) -> None:
        (tmp_path / "V1.0.0__jinja.sql.jinja").write_text(
            "create schema if not exists {{ env_var('APP_SCHEMA', 'app') }};"
        )
        exit_code = self._run_main_against(monkeypatch, tmp_path)
        assert exit_code == 0

    def test_fails_on_a_badly_named_migration_that_would_be_silently_ignored_at_deploy_time(
        self, tmp_path: Path, monkeypatch, capsys
    ) -> None:
        (tmp_path / "whoops.sql").write_text("select 1;")
        exit_code = self._run_main_against(monkeypatch, tmp_path)
        assert exit_code == 1
        assert "would be silently ignored at deploy time" in capsys.readouterr().err

    def test_fails_on_a_single_underscore_separator_violation_end_to_end(
        self, tmp_path: Path, monkeypatch, capsys
    ) -> None:
        (tmp_path / "V1.1_bad.sql").write_text("select 1;")
        exit_code = self._run_main_against(monkeypatch, tmp_path)
        assert exit_code == 1

    def test_fails_when_a_correctly_named_migration_has_invalid_jinja_content(
        self, tmp_path: Path, monkeypatch, capsys
    ) -> None:
        # Distinguishes "bad NAME" (caught by classify()) from "bad
        # CONTENT" (caught only by actually running schemachange render) --
        # this file passes naming validation but its Jinja is malformed.
        (tmp_path / "V1.0.0__broken_jinja.sql").write_text("select {{ unclosed;")
        exit_code = self._run_main_against(monkeypatch, tmp_path)
        assert exit_code == 1

    def test_fails_on_a_duplicate_version(self, tmp_path: Path, monkeypatch, capsys) -> None:
        (tmp_path / "V1.0.0__first.sql").write_text("select 1;")
        (tmp_path / "V1.0.0__second.sql").write_text("select 1;")
        exit_code = self._run_main_against(monkeypatch, tmp_path)
        assert exit_code == 1
        assert "exists more than once" in capsys.readouterr().err

    def test_empty_migrations_dir_passes_with_nothing_to_validate(
        self, tmp_path: Path, monkeypatch, capsys
    ) -> None:
        exit_code = self._run_main_against(monkeypatch, tmp_path)
        assert exit_code == 0
        assert "nothing to validate" in capsys.readouterr().out

    def test_the_real_repo_migrations_directory_still_validates_cleanly(self) -> None:
        # Regression guard: this rewrite must not break the REAL, currently
        # committed migrations/ directory (V1.0.0__bootstrap.sql).
        assert validate_migrations.main() == 0
