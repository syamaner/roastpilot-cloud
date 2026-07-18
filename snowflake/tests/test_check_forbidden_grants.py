"""Tests for check_forbidden_grants.py (F1-S8, issue #11, Codex P1, PR #57,
round 4, :244).

Imported via a direct sys.path insert of snowflake/ itself, same reasoning
as the other snowflake/tests/*.py files.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import check_forbidden_grants  # noqa: E402


class TestFindForbiddenPublicGrants:
    def test_flags_grant_to_role_public(self) -> None:
        result = check_forbidden_grants.find_forbidden_public_grants(
            "GRANT SELECT ON TABLE foo TO ROLE PUBLIC;"
        )
        assert len(result) == 1
        assert "PUBLIC" in result[0]

    def test_flags_bare_grant_to_public_without_the_role_keyword(self) -> None:
        result = check_forbidden_grants.find_forbidden_public_grants(
            "grant select on table foo to public;"
        )
        assert len(result) == 1

    def test_is_case_insensitive(self) -> None:
        result = check_forbidden_grants.find_forbidden_public_grants(
            "Grant Select On Table Foo To Role Public;"
        )
        assert len(result) == 1

    def test_tolerates_whitespace_and_newlines_within_the_statement(self) -> None:
        result = check_forbidden_grants.find_forbidden_public_grants(
            "GRANT SELECT\n  ON TABLE foo\n  TO ROLE\n  PUBLIC;"
        )
        assert len(result) == 1

    def test_does_not_require_grant_to_be_the_first_token(self) -> None:
        # A real migration routinely has a comment block ahead of its first
        # SQL statement (see migrations/V1.0.0__bootstrap.sql) -- an
        # anchored ^GRANT check would miss this.
        result = check_forbidden_grants.find_forbidden_public_grants(
            "-- some comment\n-- more comment\nGRANT SELECT ON TABLE foo TO ROLE PUBLIC;"
        )
        assert len(result) == 1

    def test_empty_for_a_grant_to_a_real_role(self) -> None:
        result = check_forbidden_grants.find_forbidden_public_grants(
            "GRANT SELECT ON TABLE foo TO ROLE ROASTPILOT_AGENT;"
        )
        assert result == []

    def test_empty_for_content_with_no_grant_statement_at_all(self) -> None:
        result = check_forbidden_grants.find_forbidden_public_grants(
            "-- roles/grants section\ncreate schema if not exists app;"
        )
        assert result == []

    def test_empty_for_a_grant_statement_mentioning_public_only_in_a_privilege_name(self) -> None:
        # "PUBLIC" doesn't appear as a TO-target here at all -- must not
        # false-positive just because the word appears somewhere.
        result = check_forbidden_grants.find_forbidden_public_grants(
            "GRANT USAGE ON DATABASE PUBLIC_ARCHIVE TO ROLE ROASTPILOT_AGENT;"
        )
        assert result == []

    def test_flags_multiple_forbidden_statements_independently(self) -> None:
        result = check_forbidden_grants.find_forbidden_public_grants(
            "GRANT SELECT ON TABLE foo TO ROLE PUBLIC;\n"
            "create schema if not exists app;\n"
            "GRANT USAGE ON SCHEMA app TO ROLE PUBLIC;"
        )
        assert len(result) == 2

    def test_empty_sql_text_is_never_a_violation(self) -> None:
        assert check_forbidden_grants.find_forbidden_public_grants("") == []


class TestMain:
    def _run_main_against(self, monkeypatch, migrations_dir: Path) -> int:
        # Mirrors test_validate_migrations.py's TestMainEndToEnd pattern:
        # `from validate_migrations import MIGRATIONS_DIR, SNOWFLAKE_DIR`
        # binds new names in THIS module's own namespace, so the fixture
        # patches check_forbidden_grants's copies, not validate_migrations'.
        monkeypatch.setattr(check_forbidden_grants, "SNOWFLAKE_DIR", migrations_dir)
        monkeypatch.setattr(check_forbidden_grants, "MIGRATIONS_DIR", migrations_dir)
        return check_forbidden_grants.main()

    def test_returns_0_with_no_migrations_at_all(self, tmp_path: Path, monkeypatch, capsys) -> None:
        exit_code = self._run_main_against(monkeypatch, tmp_path)
        assert exit_code == 0
        assert "nothing to scan" in capsys.readouterr().out

    def test_returns_0_when_no_migration_contains_a_forbidden_grant(
        self, tmp_path: Path, monkeypatch, capsys
    ) -> None:
        (tmp_path / "V1.0.0__bootstrap.sql").write_text("create schema if not exists app;")
        exit_code = self._run_main_against(monkeypatch, tmp_path)
        assert exit_code == 0
        assert "scanned 1 migration(s)" in capsys.readouterr().out

    def test_returns_1_when_a_migration_contains_a_forbidden_grant(
        self, tmp_path: Path, monkeypatch, capsys
    ) -> None:
        (tmp_path / "V1.0.0__bad.sql").write_text(
            "create schema if not exists app;\nGRANT SELECT ON TABLE app.t TO ROLE PUBLIC;"
        )
        exit_code = self._run_main_against(monkeypatch, tmp_path)
        assert exit_code == 1
        stderr = capsys.readouterr().err
        assert "V1.0.0__bad.sql" in stderr
        assert "TO ROLE PUBLIC" in stderr
        assert "PREVENTIVE" in stderr

    def test_scans_a_migration_in_a_subdirectory(self, tmp_path: Path, monkeypatch, capsys) -> None:
        subdir = tmp_path / "app"
        subdir.mkdir()
        (subdir / "V1.0.0__bad.sql").write_text("GRANT SELECT ON TABLE t TO ROLE PUBLIC;")
        exit_code = self._run_main_against(monkeypatch, tmp_path)
        assert exit_code == 1

    def test_scans_a_jinja_templated_migration(self, tmp_path: Path, monkeypatch, capsys) -> None:
        (tmp_path / "V1.0.0__bad.sql.jinja").write_text("GRANT SELECT ON TABLE t TO ROLE PUBLIC;")
        exit_code = self._run_main_against(monkeypatch, tmp_path)
        assert exit_code == 1

    def test_flags_multiple_bad_migrations_independently(self, tmp_path: Path, monkeypatch, capsys) -> None:
        (tmp_path / "V1.0.0__bad_one.sql").write_text("GRANT SELECT ON TABLE t TO ROLE PUBLIC;")
        (tmp_path / "V1.0.1__bad_two.sql").write_text("GRANT USAGE ON SCHEMA s TO ROLE PUBLIC;")
        exit_code = self._run_main_against(monkeypatch, tmp_path)
        assert exit_code == 1
        stderr = capsys.readouterr().err
        assert "bad_one" in stderr
        assert "bad_two" in stderr
