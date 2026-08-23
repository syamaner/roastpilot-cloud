"""Security proof for the exact rendered roles/grants manifest (issue #317)."""

from __future__ import annotations

import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import check_grant_manifest  # noqa: E402
import validate_migrations  # noqa: E402


@pytest.fixture(scope="module")
def rendered_sql() -> str:
    return check_grant_manifest.render_migration()


def test_t1_real_rendered_migration_equals_expected_manifest_and_main_passes(
    rendered_sql: str, capsys
) -> None:
    parsed, parse_violations = check_grant_manifest.parse_rendered_sql(rendered_sql)
    assert parse_violations == []
    assert parsed == check_grant_manifest.EXPECTED_MANIFEST
    assert check_grant_manifest.main() == 0
    assert capsys.readouterr().out == "grant manifest matches exactly (9 grants)\n"


def test_t2_rendered_manifest_is_environment_independent(rendered_sql: str) -> None:
    assert "{{" not in rendered_sql
    assert re.search(r"\bgrant\b.*\bon\s+database\b", rendered_sql, re.IGNORECASE) is None
    assert re.search(r"\bgrant\b.*\bon\s+schema\b", rendered_sql, re.IGNORECASE) is None
    assert re.search(r"\bgrant\b.*\bon\s+warehouse\b", rendered_sql, re.IGNORECASE) is None
    assert "use schema app;" in rendered_sql


def test_render_migration_ignores_database_environment_override(monkeypatch) -> None:
    monkeypatch.delenv("SNOWFLAKE_DATABASE", raising=False)
    monkeypatch.delenv("SNOWFLAKE_WAREHOUSE", raising=False)
    baseline_sql = check_grant_manifest.render_migration()
    monkeypatch.setenv("SNOWFLAKE_DATABASE", "ROASTPILOT_PREVIEW")
    monkeypatch.setenv("SNOWFLAKE_WAREHOUSE", "PREVIEW_WH")
    overridden_sql = check_grant_manifest.render_migration()
    assert overridden_sql == baseline_sql
    assert "ROASTPILOT_PREVIEW" not in overridden_sql


def test_render_migration_is_independent_of_working_directory(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    cwd_independent_sql = check_grant_manifest.render_migration()
    assert "use schema app;" in cwd_independent_sql
    assert "grant usage on schema app to role PUBLIC_WEB;" not in cwd_independent_sql
    assert "grant usage on schema app to role ROASTPILOT_AGENT;" not in cwd_independent_sql


def test_render_migration_calls_schemachange_with_exact_root_script_and_variables(monkeypatch) -> None:
    captured: dict[str, object] = {}

    class RecordingProcessor:
        def __init__(self, *, project_root: Path) -> None:
            captured["project_root"] = project_root

        def render(self, script_name: str, variables: dict[str, object]) -> str:
            captured["script_name"] = script_name
            captured["variables"] = variables
            return "rendered SQL"

    monkeypatch.setattr(check_grant_manifest, "JinjaTemplateProcessor", RecordingProcessor)
    assert check_grant_manifest.render_migration() == "rendered SQL"
    assert captured == {
        "project_root": check_grant_manifest.SNOWFLAKE_DIR / "migrations",
        "script_name": "R__z_roles_grants.sql",
        "variables": {},
    }


def test_render_migration_wraps_engine_failure_with_migration_name(monkeypatch) -> None:
    class FailingProcessor:
        def __init__(self, *, project_root: Path) -> None:
            pass

        def render(self, script_name: str, variables: dict[str, object]) -> str:
            raise ValueError("broken render")

    monkeypatch.setattr(check_grant_manifest, "JinjaTemplateProcessor", FailingProcessor)
    with pytest.raises(
        RuntimeError,
        match=r"schemachange render failed for R__z_roles_grants\.sql: broken render",
    ):
        check_grant_manifest.render_migration()


def test_t3_all_migrations_render_and_grant_migration_has_only_grants_after_use(rendered_sql: str) -> None:
    assert validate_migrations.main() == 0
    uncommented = check_grant_manifest._COMMENT_PATTERN.sub("", rendered_sql)
    assert re.search(r"\bcreate\s+", uncommented, re.IGNORECASE) is None
    use_match = re.search(r"\buse\s+schema\s+app\s*;", uncommented, re.IGNORECASE)
    grant_match = re.search(r"\bgrant\b", uncommented, re.IGNORECASE)
    assert use_match is not None and grant_match is not None
    assert use_match.start() < grant_match.start()


def test_t4_public_web_projection_is_closed(rendered_sql: str) -> None:
    parsed, _ = check_grant_manifest.parse_rendered_sql(rendered_sql)
    public_web = {grant for grant in parsed if grant.role_name == "PUBLIC_WEB"}
    assert len(public_web) == 3
    assert sum(grant.object_type == "VIEW" and grant.privileges == {"SELECT"} for grant in public_web) == 2
    assert sum(grant.object_type == "PROCEDURE" and grant.privileges == {"USAGE"} for grant in public_web) == 1
    assert not any(
        grant.object_type in {"DATABASE", "SCHEMA", "WAREHOUSE", "TABLE", "STAGE"}
        for grant in public_web
    )


def test_t5_agent_table_and_internal_stage_privileges_are_exact(rendered_sql: str) -> None:
    parsed, _ = check_grant_manifest.parse_rendered_sql(rendered_sql)
    table_grants = [
        grant
        for grant in parsed
        if grant.role_name == "ROASTPILOT_AGENT" and grant.object_type == "TABLE"
    ]
    stage_grants = [
        grant
        for grant in parsed
        if grant.role_name == "ROASTPILOT_AGENT" and grant.object_type == "STAGE"
    ]
    assert len(table_grants) == 5
    assert all(grant.privileges == {"SELECT", "INSERT", "UPDATE", "DELETE"} for grant in table_grants)
    assert len(stage_grants) == 1
    assert stage_grants[0].privileges == {"READ", "WRITE"}


def test_t6_extra_grant_is_a_named_violation(rendered_sql: str) -> None:
    violations = check_grant_manifest.manifest_violations(
        rendered_sql + ";\nGRANT SELECT ON TABLE app.tasting_reviews TO ROLE PUBLIC_WEB;"
    )
    assert any("extra grant" in item and "app.tasting_reviews" in item for item in violations)


def test_t7_missing_grant_is_a_named_violation(rendered_sql: str) -> None:
    required = "grant select on view app.roast_by_slug to role PUBLIC_WEB;"
    violations = check_grant_manifest.manifest_violations(rendered_sql.replace(required, ""))
    assert any("missing grant" in item and "app.roast_by_slug" in item for item in violations)


def test_t8_execute_on_procedure_is_rejected(rendered_sql: str) -> None:
    modified = rendered_sql.replace(
        "grant usage on procedure app.submit_review(", "grant execute on procedure app.submit_review("
    )
    violations = check_grant_manifest.manifest_violations(modified)
    assert any("procedure privilege must be exactly USAGE" in item for item in violations)


def test_t9_public_grantee_is_rejected() -> None:
    sql = "GRANT USAGE ON SCHEMA app TO ROLE PUBLIC;"
    _, violations = check_grant_manifest.parse_rendered_sql(sql)
    assert any("unauthorized grantee" in item and "PUBLIC" in item for item in violations)


def test_t10_foreign_role_grantee_is_rejected() -> None:
    sql = "GRANT USAGE ON SCHEMA app TO ROLE ROASTPILOT_ADMIN;"
    _, violations = check_grant_manifest.parse_rendered_sql(sql)
    assert any("unauthorized grantee" in item and "ROASTPILOT_ADMIN" in item for item in violations)


def test_t11_quoted_lowercase_lookalike_is_rejected() -> None:
    sql = 'GRANT USAGE ON SCHEMA app TO ROLE "public_web";'
    _, violations = check_grant_manifest.parse_rendered_sql(sql)
    assert any('unauthorized grantee' in item and '"public_web"' in item for item in violations)


def test_t12_unknown_object_type_names_its_diagnostic() -> None:
    sql = "GRANT USAGE ON INTEGRATION x TO ROLE ROASTPILOT_AGENT;"
    _, violations = check_grant_manifest.parse_rendered_sql(sql)
    assert any("unrecognized object type" in violation for violation in violations)


@pytest.mark.parametrize(
    "sql",
    [
        "GRANT USAGE ON SCHEMA app TO USER somebody;",
        "GRANT USAGE ON SCHEMA app TO ROASTPILOT_AGENT;",
    ],
)
def test_t12_unparseable_grant_shapes_name_their_diagnostic(sql: str) -> None:
    _, violations = check_grant_manifest.parse_rendered_sql(sql)
    assert any("unrecognized statement" in violation for violation in violations)


def test_t12_reports_every_unparseable_statement_in_the_input() -> None:
    _, violations = check_grant_manifest.parse_rendered_sql("FOO;\nBAR;")
    unrecognized = [
        violation for violation in violations if "unrecognized statement" in violation
    ]
    assert len(unrecognized) == 2
    assert any("FOO" in violation for violation in unrecognized)
    assert any("BAR" in violation for violation in unrecognized)


@pytest.mark.parametrize(
    "sql",
    [
        "GRANT USAGE ON SCHEMA app TO ROLE PUBLIC_WEB WITH GRANT OPTION;",
        "GRANT USAGE ON SCHEMA app TO ROLE PUBLIC_WEB, ROLE ROASTPILOT_AGENT;",
    ],
)
def test_t12_rejects_grant_option_and_multiple_grantees(sql: str) -> None:
    _, violations = check_grant_manifest.parse_rendered_sql(sql)
    assert any("unrecognized statement" in violation for violation in violations)


def test_t13_wrong_internal_stage_privilege_is_rejected() -> None:
    sql = "GRANT USAGE ON STAGE app.roast_artifacts TO ROLE ROASTPILOT_AGENT;"
    _, violations = check_grant_manifest.parse_rendered_sql(sql)
    assert any("stage privileges must be exactly READ, WRITE" in item for item in violations)


def test_t14_privilege_order_is_invariant() -> None:
    canonical = (
        "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE app.cloud_roasts "
        "TO ROLE ROASTPILOT_AGENT;"
    )
    reordered = (
        "GRANT INSERT, SELECT, DELETE, UPDATE ON TABLE app.cloud_roasts "
        "TO ROLE ROASTPILOT_AGENT;"
    )
    canonical_set, canonical_violations = check_grant_manifest.parse_rendered_sql(canonical)
    reordered_set, reordered_violations = check_grant_manifest.parse_rendered_sql(reordered)
    assert canonical_violations == reordered_violations == []
    assert canonical_set == reordered_set


def test_t15_missing_sibling_module_raises_import_error() -> None:
    with pytest.raises(ImportError, match="cannot load sibling module"):
        check_grant_manifest._load_sibling_module("this_module_does_not_exist")


def test_main_returns_1_and_reports_extra_grant(
    rendered_sql: str, monkeypatch, capsys
) -> None:
    extra_sql = (
        rendered_sql
        + "\nGRANT SELECT ON TABLE app.tasting_reviews TO ROLE PUBLIC_WEB;"
    )
    monkeypatch.setattr(check_grant_manifest, "render_migration", lambda: extra_sql)

    assert check_grant_manifest.main() == 1
    assert "error: extra grant" in capsys.readouterr().err


def test_main_returns_1_and_reports_render_failure(monkeypatch, capsys) -> None:
    def fail_render() -> str:
        raise RuntimeError("boom")

    monkeypatch.setattr(check_grant_manifest, "render_migration", fail_render)

    assert check_grant_manifest.main() == 1
    assert "error: boom" in capsys.readouterr().err
