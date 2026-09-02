"""Tests for assert_dev_ci_grants.py (F1-S8, issue #11, factory.md §8).

Imported via a direct sys.path insert of snowflake/ itself, same reasoning
as the other snowflake/tests/*.py files.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import assert_dev_ci_grants  # noqa: E402
import check_grant_manifest  # noqa: E402


class TestLoadSiblingModule:
    def test_raises_import_error_for_a_module_that_does_not_exist(self) -> None:
        with pytest.raises(ImportError, match="cannot load sibling module"):
            assert_dev_ci_grants._load_sibling_module("this_module_does_not_exist")


def _generate_test_pem(passphrase: str | None = None) -> str:
    """Generates a real (throwaway, test-only) RSA key pair and returns its
    PEM-encoded private key -- proves load_private_key_der against actual
    cryptography primitives, not a hand-waved fixture."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    encryption = (
        serialization.BestAvailableEncryption(passphrase.encode("utf-8"))
        if passphrase
        else serialization.NoEncryption()
    )
    pem_bytes = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=encryption,
    )
    return pem_bytes.decode("utf-8")


class TestLoadPrivateKeyDer:
    def test_round_trips_an_unencrypted_key(self) -> None:
        pem = _generate_test_pem()
        der = assert_dev_ci_grants.load_private_key_der(pem, passphrase=None)
        # Re-parse the DER output to prove it's a valid, loadable private key
        # -- not just "some bytes came out".
        reloaded = serialization.load_der_private_key(der, password=None)
        assert reloaded.key_size == 2048

    def test_round_trips_a_passphrase_encrypted_key(self) -> None:
        pem = _generate_test_pem(passphrase="s3cr3t")
        der = assert_dev_ci_grants.load_private_key_der(pem, passphrase="s3cr3t")
        reloaded = serialization.load_der_private_key(der, password=None)  # DER output is always unencrypted
        assert reloaded.key_size == 2048

    def test_wrong_passphrase_raises(self) -> None:
        pem = _generate_test_pem(passphrase="s3cr3t")
        try:
            assert_dev_ci_grants.load_private_key_der(pem, passphrase="wrong")
            raise AssertionError("expected a decryption error")
        except (ValueError, TypeError):
            pass  # cryptography raises one of these for a bad passphrase -- either is correct.


_DEV_DB = "ROASTPILOT_DEV"
_DEV_WH = "DEV_CI_WH"
_DEV_ROLE = "ROASTPILOT_DEV_CI_ROLE"
# Hoisted here from further down the file (it used to sit just above
# TestFindDefaultSecondaryRolesViolation) so it reads alongside the other
# three identity constants, now that TestAssertSqlIdentifierSafe above also
# needs it.
_CI_USER = "ROASTPILOT_DEV_CI"

_LIVE_SUBMIT_REVIEW_SIGNATURE = (
    "ROASTPILOT_DEV.APP.SUBMIT_REVIEW(VARCHAR, VARCHAR, NUMBER, NUMBER, NUMBER, "
    "NUMBER, NUMBER, NUMBER, VARCHAR, VARCHAR, VARCHAR)"
)
_LIVE_LOAD_TELEMETRY_SIGNATURE = (
    "ROASTPILOT_DEV.APP.LOAD_ROAST_TELEMETRY(VARCHAR, VARCHAR)"
)
_LIVE_AGENT_TABLES = (
    "ROASTPILOT_DEV.APP.CLOUD_ROASTS",
    "ROASTPILOT_DEV.APP.ROAST_TELEMETRY",
    "ROASTPILOT_DEV.APP.ROAST_ARTIFACTS",
    "ROASTPILOT_DEV.APP.TASTING_REVIEWS",
    "ROASTPILOT_DEV.APP.REFERENCE_ROAST_SUMMARIES",
)


def _app_role_rows(role_name: str) -> list[dict[str, object]]:
    """D-345-F compliant state for the shared account-level application roles."""
    prerequisites = [
        ("USAGE", "DATABASE", "ROASTPILOT_DEV"),
        ("USAGE", "SCHEMA", "ROASTPILOT_DEV.APP"),
        ("USAGE", "WAREHOUSE", "ROASTPILOT_WH"),
    ]
    if role_name == "PUBLIC_WEB":
        grants = [
            *prerequisites,
            ("SELECT", "VIEW", "ROASTPILOT_DEV.APP.ROAST_BY_SLUG"),
            ("SELECT", "VIEW", "ROASTPILOT_DEV.APP.REVIEWS_BY_ROAST"),
            ("USAGE", "PROCEDURE", _LIVE_SUBMIT_REVIEW_SIGNATURE),
        ]
    elif role_name == "ROASTPILOT_AGENT":
        grants = [
            *prerequisites,
            *(
                (privilege, "TABLE", table_name)
                for table_name in _LIVE_AGENT_TABLES
                for privilege in ("SELECT", "INSERT", "UPDATE", "DELETE")
            ),
            ("READ", "STAGE", "ROASTPILOT_DEV.APP.ROAST_ARTIFACTS"),
            ("WRITE", "STAGE", "ROASTPILOT_DEV.APP.ROAST_ARTIFACTS"),
            ("USAGE", "FILE_FORMAT", "ROASTPILOT_DEV.APP.ROAST_JSONL_FORMAT"),
            ("USAGE", "PROCEDURE", _LIVE_LOAD_TELEMETRY_SIGNATURE),
        ]
    else:
        raise ValueError(f"unknown application role fixture: {role_name!r}")
    return [
        {
            "privilege": privilege,
            "granted_on": granted_on,
            "name": name,
            "grantee_name": role_name,
            "grant_option": "false",
        }
        for privilege, granted_on, name in grants
    ]


def _app_role_rows_missing(
    role: str, *object_name_suffixes: str
) -> list[dict[str, object]]:
    """Return a compliant application-role corpus minus named objects."""
    return [
        row
        for row in _app_role_rows(role)
        if not any(
            str(row["name"]).endswith(suffix)
            for suffix in object_name_suffixes
        )
    ]


class TestAssertBoundaryVarsNotDrifted:
    """Codex P2, PR #57, round 2: every check in this script trusts
    SNOWFLAKE_DEV_DATABASE/SNOWFLAKE_DEV_WAREHOUSE AS the allowed boundary
    -- these tests cover the anchor that catches those vars drifting from
    their known-correct literal values.
    """

    def test_passes_for_the_expected_literals(self) -> None:
        # Must not raise.
        assert_dev_ci_grants.assert_boundary_vars_not_drifted(_DEV_DB, _DEV_WH)

    def test_raises_systemexit_for_a_drifted_database(self) -> None:
        try:
            assert_dev_ci_grants.assert_boundary_vars_not_drifted("SOME_OTHER_DB", _DEV_WH)
            raise AssertionError("expected SystemExit")
        except SystemExit as exc:
            assert "SNOWFLAKE_DEV_DATABASE" in str(exc)
            assert "SOME_OTHER_DB" in str(exc)

    def test_raises_systemexit_for_a_drifted_warehouse(self) -> None:
        try:
            assert_dev_ci_grants.assert_boundary_vars_not_drifted(_DEV_DB, "SOME_OTHER_WH")
            raise AssertionError("expected SystemExit")
        except SystemExit as exc:
            assert "SNOWFLAKE_DEV_WAREHOUSE" in str(exc)
            assert "SOME_OTHER_WH" in str(exc)


class TestAssertSqlIdentifierSafe:
    """#58's L3: the role and the CI user are interpolated into four `SHOW`
    statements (Snowflake accepts no bind parameter in that position), so
    both are refused up front unless they're bare unquoted identifiers.

    A hostile value already failed closed WITHOUT this check, via the
    connector's num_statements default, Snowflake syntax errors, and the
    exact-name post-filter -- these tests cover the check that makes that
    property asserted rather than emergent. See the function's docstring.
    """

    def test_accepts_the_real_dev_role_and_ci_user(self) -> None:
        # The values actually held by vars.SNOWFLAKE_DEV_ROLE/_USER -- this
        # check must never reject the live configuration.
        assert_dev_ci_grants.assert_sql_identifier_safe(_DEV_ROLE, "SNOWFLAKE_DEV_ROLE")
        assert_dev_ci_grants.assert_sql_identifier_safe(_CI_USER, "SNOWFLAKE_DEV_USER")

    def test_accepts_a_leading_underscore_and_dollar_sign(self) -> None:
        # Both are legal in Snowflake's unquoted-identifier grammar; the
        # check enforces that grammar, not a narrower house style.
        assert_dev_ci_grants.assert_sql_identifier_safe("_ROLE$1", "SNOWFLAKE_DEV_ROLE")

    def test_accepts_a_lowercase_identifier(self) -> None:
        # Case is NOT this check's job: a lowercase unquoted identifier is
        # grammatically fine (Snowflake folds it), and it still fails the
        # downstream identifiers_match boundary compares if it's wrong.
        assert_dev_ci_grants.assert_sql_identifier_safe("roastpilot_dev_ci_role", "SNOWFLAKE_DEV_ROLE")

    def _assert_refused(self, value: str) -> None:
        try:
            assert_dev_ci_grants.assert_sql_identifier_safe(value, "SNOWFLAKE_DEV_ROLE")
            raise AssertionError(f"expected SystemExit for {value!r}")
        except SystemExit as exc:
            # Anchored prefix rather than two `in` checks: a substring
            # assertion passes against a corrupted variable name or a
            # corrupted value echo that merely CONTAINS the expected text.
            assert str(exc).startswith(f"error: SNOWFLAKE_DEV_ROLE is {value!r}, ")

    def test_refuses_a_statement_separator(self) -> None:
        self._assert_refused(f"{_DEV_ROLE}; DROP TABLE T")

    def test_refuses_a_single_quote(self) -> None:
        # The `SHOW USERS LIKE '<user>'` site is the one quoted-string
        # context, so a quote is the escape that matters there.
        self._assert_refused("ROASTPILOT_DEV_CI' --")

    def test_refuses_a_comment_marker(self) -> None:
        self._assert_refused(f"{_DEV_ROLE} -- ")

    def test_refuses_embedded_whitespace(self) -> None:
        self._assert_refused("ROASTPILOT DEV CI ROLE")

    def test_refuses_a_trailing_newline(self) -> None:
        # Specifically covers `fullmatch` over an `^...$` pattern: `$` also
        # matches just before a trailing newline, so an `^...$` version of
        # this check would ADMIT this value.
        self._assert_refused(f"{_DEV_ROLE}\n")

    def test_refuses_a_leading_newline(self) -> None:
        self._assert_refused(f"\n{_DEV_ROLE}")

    def test_refuses_an_empty_value(self) -> None:
        self._assert_refused("")

    def test_refuses_a_leading_digit(self) -> None:
        self._assert_refused("1ROLE")

    def test_refuses_a_quoted_identifier(self) -> None:
        # Deliberately refused rather than escaped: this repo's tooling only
        # ever creates unquoted identifiers (see the function's docstring).
        self._assert_refused('"ROASTPILOT_DEV_CI_ROLE"')

    def test_refuses_a_qualified_name(self) -> None:
        self._assert_refused("ROASTPILOT_DEV.PUBLIC")

    def test_reports_the_whole_operator_facing_diagnostic(self) -> None:
        # Asserted in FULL, not by substring. This message is the entire
        # operator-facing output of a fail-closed check on a credentialed
        # job: it has to name WHICH of the two variables was rejected (both
        # call sites share this one function), echo the offending value, and
        # state the grammar that was actually applied -- otherwise the
        # operator sees a refusal with no way to tell what to fix.
        # A substring assertion is specifically NOT enough here: it still
        # passes against a message whose tail has been corrupted around an
        # intact fragment.
        try:
            assert_dev_ci_grants.assert_sql_identifier_safe("bad value", "SNOWFLAKE_DEV_USER")
            raise AssertionError("expected SystemExit")
        except SystemExit as exc:
            assert str(exc) == (
                "error: SNOWFLAKE_DEV_USER is 'bad value', which is not a bare Snowflake "
                "unquoted identifier ([A-Za-z_][A-Za-z0-9_$]*) -- refusing to interpolate "
                "it into a SHOW statement"
            )


class TestIdentifiersMatch:
    """Codex P1, PR #57, round 3: the ONE categorical exact-match function
    every name/role/db/warehouse comparison in this module routes through
    -- replaces three independently-patched symptoms of the same root
    cause (case-folding, whitespace-stripping, and the system-PUBLIC
    special case).
    """

    def test_matches_the_identical_string(self) -> None:
        assert assert_dev_ci_grants.identifiers_match(_DEV_DB, _DEV_DB)

    def test_rejects_a_differently_cased_variant(self) -> None:
        assert not assert_dev_ci_grants.identifiers_match("roastpilot_dev", _DEV_DB)

    def test_rejects_a_whitespace_padded_variant_codex_p1_276(self) -> None:
        # The exact bug this closes (Codex P1, PR #57, round 3, :276): a
        # QUOTED identifier with trailing whitespace ("ROASTPILOT_DEV ") is
        # a genuinely different object from ROASTPILOT_DEV -- stripping
        # before comparing would incorrectly treat them as the same.
        assert not assert_dev_ci_grants.identifiers_match(f"{_DEV_DB} ", _DEV_DB)
        assert not assert_dev_ci_grants.identifiers_match(f" {_DEV_DB}", _DEV_DB)

    def test_rejects_an_empty_string_against_a_real_name(self) -> None:
        assert not assert_dev_ci_grants.identifiers_match("", _DEV_DB)


class TestIsAllowedGrant:
    def test_allows_the_exact_dev_database(self) -> None:
        assert assert_dev_ci_grants.is_allowed_grant("DATABASE", _DEV_DB, _DEV_ROLE, _DEV_DB, _DEV_WH)

    def test_allows_a_qualified_object_inside_the_dev_database(self) -> None:
        assert assert_dev_ci_grants.is_allowed_grant(
            "TABLE", "ROASTPILOT_DEV.APP.SOME_TABLE", _DEV_ROLE, _DEV_DB, _DEV_WH
        )
        assert assert_dev_ci_grants.is_allowed_grant(
            "SCHEMA", "ROASTPILOT_DEV.APP", _DEV_ROLE, _DEV_DB, _DEV_WH
        )

    def test_allows_live_file_format_vocabulary_inside_dev(self) -> None:
        assert assert_dev_ci_grants.is_allowed_grant(
            "FILE_FORMAT",
            "ROASTPILOT_DEV.APP.ROAST_JSONL_FORMAT",
            _DEV_ROLE,
            _DEV_DB,
            _DEV_WH,
        )
        assert (
            assert_dev_ci_grants.find_violations(
                [
                    {
                        "privilege": "OWNERSHIP",
                        "granted_on": "FILE_FORMAT",
                        "name": "ROASTPILOT_DEV.APP.ROAST_JSONL_FORMAT",
                    }
                ],
                _DEV_ROLE,
                _DEV_DB,
                _DEV_WH,
            )
            == []
        )

    def test_rejects_live_file_format_outside_dev(self) -> None:
        assert not assert_dev_ci_grants.is_allowed_grant(
            "FILE_FORMAT",
            "ROASTPILOT_PREVIEW.APP.X",
            _DEV_ROLE,
            _DEV_DB,
            _DEV_WH,
        )

    def test_rejects_offline_file_format_spelling_on_live_side(self) -> None:
        assert not assert_dev_ci_grants.is_allowed_grant(
            "FILE FORMAT",
            "ROASTPILOT_DEV.APP.ROAST_JSONL_FORMAT",
            _DEV_ROLE,
            _DEV_DB,
            _DEV_WH,
        )

    def test_materialized_view_uses_live_underscore_vocabulary_only(self) -> None:
        assert assert_dev_ci_grants.is_allowed_grant(
            "MATERIALIZED_VIEW",
            "ROASTPILOT_DEV.APP.MV",
            _DEV_ROLE,
            _DEV_DB,
            _DEV_WH,
        )
        assert not assert_dev_ci_grants.is_allowed_grant(
            "MATERIALIZED VIEW",
            "ROASTPILOT_DEV.APP.MV",
            _DEV_ROLE,
            _DEV_DB,
            _DEV_WH,
        )

    def test_database_scoped_object_types_pin_live_vocabulary(self) -> None:
        assert assert_dev_ci_grants._DATABASE_SCOPED_OBJECT_TYPES == frozenset(
            {
                "DATABASE",
                "SCHEMA",
                "TABLE",
                "VIEW",
                "MATERIALIZED_VIEW",
                "STAGE",
                "FILE_FORMAT",
                "SEQUENCE",
                "PROCEDURE",
                "FUNCTION",
                "STREAM",
                "TASK",
                "PIPE",
            }
        )

    def test_database_scoped_object_types_have_no_spaces(self) -> None:
        assert all(
            " " not in object_type
            for object_type in assert_dev_ci_grants._DATABASE_SCOPED_OBJECT_TYPES
        )

    def test_allows_the_dev_ci_warehouse(self) -> None:
        assert assert_dev_ci_grants.is_allowed_grant("WAREHOUSE", _DEV_WH, _DEV_ROLE, _DEV_DB, _DEV_WH)

    def test_allows_a_self_grant_on_the_role_itself(self) -> None:
        assert assert_dev_ci_grants.is_allowed_grant("ROLE", _DEV_ROLE, _DEV_ROLE, _DEV_DB, _DEV_WH)

    def test_the_granted_on_type_column_is_case_insensitive(self) -> None:
        # granted_on is Snowflake's own fixed vocabulary (never a quotable
        # user identifier), so normalizing ITS case is safe and expected.
        assert assert_dev_ci_grants.is_allowed_grant("database", _DEV_DB, _DEV_ROLE, _DEV_DB, _DEV_WH)

    def test_rejects_a_quoted_lowercase_variant_of_the_allowed_database_codex_p1(self) -> None:
        # The exact bug this closes (Codex P1, PR #57): Snowflake preserves
        # the case of a QUOTED identifier, so "roastpilot_dev" (quoted,
        # lowercase) is a GENUINELY DIFFERENT object from ROASTPILOT_DEV
        # (unquoted, normalized to uppercase at creation). Uppercasing both
        # sides before comparing would incorrectly treat them as the same
        # database -- identifier comparisons must be case-SENSITIVE.
        assert not assert_dev_ci_grants.is_allowed_grant(
            "DATABASE", "roastpilot_dev", _DEV_ROLE, _DEV_DB, _DEV_WH
        )
        assert not assert_dev_ci_grants.is_allowed_grant(
            "WAREHOUSE", "dev_ci_wh", _DEV_ROLE, _DEV_DB, _DEV_WH
        )
        assert not assert_dev_ci_grants.is_allowed_grant(
            "ROLE", "roastpilot_dev_ci_role", _DEV_ROLE, _DEV_DB, _DEV_WH
        )

    def test_rejects_a_whitespace_padded_variant_of_the_allowed_database_codex_p1_276(self) -> None:
        # Codex P1, PR #57, round 3, :276: a quoted "ROASTPILOT_DEV " (with
        # a trailing space) is a genuinely different object -- a naive
        # .strip() before comparing would incorrectly allow it.
        assert not assert_dev_ci_grants.is_allowed_grant(
            "DATABASE", f"{_DEV_DB} ", _DEV_ROLE, _DEV_DB, _DEV_WH
        )
        assert not assert_dev_ci_grants.is_allowed_grant(
            "WAREHOUSE", f"{_DEV_WH} ", _DEV_ROLE, _DEV_DB, _DEV_WH
        )

    def test_rejects_a_different_database(self) -> None:
        assert not assert_dev_ci_grants.is_allowed_grant(
            "DATABASE", "ROASTPILOT_PREVIEW", _DEV_ROLE, _DEV_DB, _DEV_WH
        )

    def test_rejects_a_database_whose_name_merely_shares_a_prefix(self) -> None:
        # ROASTPILOT_DEV_EXTRA is NOT ROASTPILOT_DEV and does not start with
        # "ROASTPILOT_DEV." (the dot matters) -- a naive prefix check
        # without the dot would wrongly allow this.
        assert not assert_dev_ci_grants.is_allowed_grant(
            "DATABASE", "ROASTPILOT_DEV_EXTRA", _DEV_ROLE, _DEV_DB, _DEV_WH
        )

    def test_rejects_a_different_warehouse(self) -> None:
        assert not assert_dev_ci_grants.is_allowed_grant("WAREHOUSE", "PREVIEW_WH", _DEV_ROLE, _DEV_DB, _DEV_WH)

    def test_rejects_a_different_role(self) -> None:
        assert not assert_dev_ci_grants.is_allowed_grant("ROLE", "ACCOUNTADMIN", _DEV_ROLE, _DEV_DB, _DEV_WH)

    def test_fails_closed_on_an_account_level_object(self) -> None:
        assert not assert_dev_ci_grants.is_allowed_grant(
            "ACCOUNT", "HVPXLEY-EX88650", _DEV_ROLE, _DEV_DB, _DEV_WH
        )

    def test_fails_closed_on_an_unrecognized_object_type(self) -> None:
        # A hypothetical future Snowflake object type this allowlist has
        # never seen -- must be rejected, not silently allowed just because
        # it wasn't anticipated.
        assert not assert_dev_ci_grants.is_allowed_grant(
            "SOME_FUTURE_OBJECT_TYPE", _DEV_DB, _DEV_ROLE, _DEV_DB, _DEV_WH
        )

    def test_fails_closed_on_an_integration_or_user_object(self) -> None:
        assert not assert_dev_ci_grants.is_allowed_grant(
            "INTEGRATION", "SOME_INTEGRATION", _DEV_ROLE, _DEV_DB, _DEV_WH
        )
        assert not assert_dev_ci_grants.is_allowed_grant("USER", "ROASTPILOT_DEV_CI", _DEV_ROLE, _DEV_DB, _DEV_WH)

    def test_uses_the_passed_in_database_and_warehouse_not_a_hardcoded_literal(self) -> None:
        # Regression guard (claude-review finding, PR #57): a caller passing
        # a DIFFERENT allowed database/warehouse than the "usual" DEV ones
        # must be honored -- proves this isn't secretly still checking
        # against a module-level constant.
        assert assert_dev_ci_grants.is_allowed_grant(
            "DATABASE", "SOME_OTHER_DB", _DEV_ROLE, "SOME_OTHER_DB", "SOME_OTHER_WH"
        )
        assert not assert_dev_ci_grants.is_allowed_grant(
            "DATABASE", _DEV_DB, _DEV_ROLE, "SOME_OTHER_DB", "SOME_OTHER_WH"
        )


class TestFindViolations:
    def test_no_violations_for_an_all_compliant_grant_set(self) -> None:
        rows = [
            {"privilege": "USAGE", "granted_on": "DATABASE", "name": "ROASTPILOT_DEV"},
            {"privilege": "USAGE", "granted_on": "SCHEMA", "name": "ROASTPILOT_DEV.APP"},
            {"privilege": "USAGE", "granted_on": "WAREHOUSE", "name": "DEV_CI_WH"},
        ]
        assert assert_dev_ci_grants.find_violations(rows, _DEV_ROLE, _DEV_DB, _DEV_WH) == []

    def test_flags_a_grant_outside_dev(self) -> None:
        rows = [
            {"privilege": "USAGE", "granted_on": "DATABASE", "name": "ROASTPILOT_DEV"},
            {"privilege": "USAGE", "granted_on": "DATABASE", "name": "ROASTPILOT_PREVIEW"},
        ]
        violations = assert_dev_ci_grants.find_violations(rows, _DEV_ROLE, _DEV_DB, _DEV_WH)
        assert len(violations) == 1
        assert "ROASTPILOT_PREVIEW" in violations[0]

    def test_flags_multiple_violations_independently(self) -> None:
        rows = [
            {"privilege": "USAGE", "granted_on": "DATABASE", "name": "ROASTPILOT_PREVIEW"},
            {"privilege": "USAGE", "granted_on": "WAREHOUSE", "name": "PREVIEW_WH"},
            {"privilege": "USAGE", "granted_on": "ACCOUNT", "name": "HVPXLEY-EX88650"},
        ]
        violations = assert_dev_ci_grants.find_violations(rows, _DEV_ROLE, _DEV_DB, _DEV_WH)
        assert len(violations) == 3

    def test_handles_a_missing_field_gracefully_as_a_violation(self) -> None:
        # A row missing an expected field is treated as a violation (fails
        # closed) rather than crashing or being silently skipped.
        rows = [{"privilege": "USAGE"}]  # no granted_on/name at all
        violations = assert_dev_ci_grants.find_violations(rows, _DEV_ROLE, _DEV_DB, _DEV_WH)
        assert len(violations) == 1


def _find_public_grants(rows: list[dict[str, object]]) -> list[str]:
    return assert_dev_ci_grants.find_public_grants(rows, _DEV_ROLE, _DEV_DB, _DEV_WH)


def _public_grant_corpus() -> list[dict[str, object]]:
    """Representative hand-authored defaults across 9 granted_on kinds; not an MCP capture."""
    return [
        {
            "privilege": "SELECT",
            "granted_on": "TABLE",
            "name": "SNOWFLAKE_SAMPLE_DATA.TPCH_SF1000.PARTSUPP",
        },
        {
            "privilege": "SELECT",
            "granted_on": "TABLE",
            "name": "SNOWFLAKE_SAMPLE_DATA.TPCH_SF1000.REGION",
        },
        {
            "privilege": "SELECT",
            "granted_on": "TABLE",
            "name": "SNOWFLAKE_SAMPLE_DATA.TPCH_SF1000.SUPPLIER",
        },
        {
            "privilege": "SELECT",
            "granted_on": "TABLE",
            "name": "SNOWFLAKE_SAMPLE_DATA.TPCDS_SF10TCL.CUSTOMER",
        },
        {"privilege": "USAGE", "granted_on": "DATABASE", "name": "SNOWFLAKE_SAMPLE_DATA"},
        {
            "privilege": "USAGE",
            "granted_on": "SCHEMA",
            "name": "SNOWFLAKE_SAMPLE_DATA.TPCH_SF1",
        },
        {
            "privilege": "USAGE",
            "granted_on": "SCHEMA",
            "name": "SNOWFLAKE_SAMPLE_DATA.TPCDS_SF10TCL",
        },
        {"privilege": "USAGE", "granted_on": "DATABASE_ROLE", "name": "SNOWFLAKE.CORTEX_USER"},
        {"privilege": "USAGE", "granted_on": "DATABASE_ROLE", "name": "SNOWFLAKE.ML_USER"},
        {"privilege": "USAGE", "granted_on": "DATABASE_ROLE", "name": "SNOWFLAKE.CORE_VIEWER"},
        {
            "privilege": "USAGE",
            "granted_on": "APPLICATION_ROLE",
            "name": 'SNOWFLAKE."CORTEX-MODEL-ROLE-ALL"',
        },
        {"privilege": "USAGE", "granted_on": "APPLICATION_ROLE", "name": "SNOWFLAKE.PUBLIC"},
        {"privilege": "USAGE", "granted_on": "ROLE", "name": "SNOWFLAKE_LEARNING_ROLE"},
        {"privilege": "USAGE", "granted_on": "COMPUTE_POOL", "name": "SYSTEM_COMPUTE_POOL_CPU"},
        {"privilege": "USAGE", "granted_on": "COMPUTE_POOL", "name": "SYSTEM_COMPUTE_POOL_GPU"},
        {"privilege": "USAGE", "granted_on": "WAREHOUSE", "name": "SNOWFLAKE_LEARNING_WH"},
        {"privilege": "BIND SERVICE ENDPOINT", "granted_on": "ACCOUNT", "name": "IO03393"},
        {"privilege": "EXECUTE AGENT TASK", "granted_on": "ACCOUNT", "name": "IO03393"},
        {"privilege": "MANAGE ARTIFACT PUBLICATION", "granted_on": "ACCOUNT", "name": "IO03393"},
        {"privilege": "USE AI FUNCTIONS", "granted_on": "ACCOUNT", "name": "IO03393"},
        {"privilege": "VIEW LINEAGE", "granted_on": "ACCOUNT", "name": "IO03393"},
    ]


class TestFindPublicGrants:
    """D-11-D flags PUBLIC grants by DEV/account reach, minus exact defaults."""

    @pytest.mark.parametrize("privilege", ["SELECT", "INSERT", "UPDATE", "DELETE", "OWNERSHIP"])
    def test_flags_every_privilege_on_a_dev_table(self, privilege: str) -> None:
        rows = [{"privilege": privilege, "granted_on": "TABLE", "name": f"{_DEV_DB}.APP.T"}]
        assert _find_public_grants(rows) == [f"{privilege} on TABLE {_DEV_DB}.APP.T"]

    def test_flags_unknown_object_type_inside_dev_without_type_gate(self) -> None:
        rows = [
            {
                "privilege": "SELECT",
                "granted_on": "SOME_FUTURE_OBJECT_TYPE",
                "name": f"{_DEV_DB}.APP.T",
            }
        ]
        assert _find_public_grants(rows) == [f"SELECT on SOME_FUTURE_OBJECT_TYPE {_DEV_DB}.APP.T"]

    def test_file_format_still_flags_at_public_owned_object_predicate(self) -> None:
        assert assert_dev_ci_grants._public_grant_targets_owned_object(
            "USAGE",
            "FILE_FORMAT",
            "ROASTPILOT_DEV.APP.ROAST_JSONL_FORMAT",
            _DEV_ROLE,
            _DEV_DB,
            _DEV_WH,
        )

    def test_flags_the_dev_warehouse(self) -> None:
        rows = [{"privilege": "USAGE", "granted_on": "WAREHOUSE", "name": _DEV_WH}]
        assert _find_public_grants(rows) == [f"USAGE on WAREHOUSE {_DEV_WH}"]

    @pytest.mark.parametrize(
        "role",
        ["ROASTPILOT_AGENT", "PUBLIC_WEB", _DEV_ROLE, "SOME_CUSTOM_ROLE"],
    )
    def test_flags_every_non_default_role(self, role: str) -> None:
        # The CI role is not special: like every non-default role, granting it
        # to PUBLIC hands that role's access to every principal.
        rows = [{"privilege": "USAGE", "granted_on": "ROLE", "name": role}]
        assert _find_public_grants(rows) == [f"USAGE on ROLE {role}"]

    def test_ignores_the_exact_snowflake_default_role(self) -> None:
        rows = [{"privilege": "USAGE", "granted_on": "ROLE", "name": "SNOWFLAKE_LEARNING_ROLE"}]
        assert _find_public_grants(rows) == []

    @pytest.mark.parametrize(
        "role",
        ["snowflake_learning_role", "SNOWFLAKE_LEARNING_ROLE ", "SNOWFLAKE_LEARNING_ROLE_EVIL"],
    )
    def test_flags_snowflake_default_role_lookalikes_byte_exact(self, role: str) -> None:
        rows = [{"privilege": "USAGE", "granted_on": "ROLE", "name": role}]
        assert _find_public_grants(rows) == [f"USAGE on ROLE {role}"]

    @pytest.mark.parametrize(
        ("granted_on", "name"),
        [("  role  ", "ROASTPILOT_AGENT"), ("warehouse", _DEV_WH)],
    )
    def test_normalizes_object_kind_before_routing(self, granted_on: str, name: str) -> None:
        rows = [{"privilege": "USAGE", "granted_on": granted_on, "name": name}]
        assert _find_public_grants(rows) == [f"USAGE on {granted_on} {name}"]

    def test_flags_the_bare_dev_database(self) -> None:
        rows = [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}]
        assert _find_public_grants(rows) == [f"USAGE on DATABASE {_DEV_DB}"]

    @pytest.mark.parametrize(
        "privilege",
        ["MANAGE GRANTS", "CREATE DATABASE", "CREATE ROLE", "APPLY MASKING POLICY"],
    )
    def test_flags_dangerous_account_privileges(self, privilege: str) -> None:
        rows = [{"privilege": privilege, "granted_on": "ACCOUNT", "name": "IO03393"}]
        assert _find_public_grants(rows) == [f"{privilege} on ACCOUNT IO03393"]

    def test_flags_unknown_account_privilege_fail_closed(self) -> None:
        rows = [
            {
                "privilege": "SOME_FUTURE_ACCOUNT_PRIVILEGE",
                "granted_on": "ACCOUNT",
                "name": "IO03393",
            }
        ]
        assert _find_public_grants(rows) == ["SOME_FUTURE_ACCOUNT_PRIVILEGE on ACCOUNT IO03393"]

    def test_account_privilege_allowlist_polarity_direct(self) -> None:
        args = ("ACCOUNT", "IO03393", _DEV_ROLE, _DEV_DB, _DEV_WH)
        assert not assert_dev_ci_grants._public_grant_targets_owned_object(" view lineage ", *args)
        assert assert_dev_ci_grants._public_grant_targets_owned_object("MANAGE GRANTS", *args)

    @pytest.mark.parametrize(
        ("row", "expected"),
        [
            ({"privilege": "USAGE", "granted_on": "", "name": _DEV_DB}, f"USAGE on  {_DEV_DB}"),
            (
                {"privilege": "USAGE", "granted_on": "", "name": "SNOWFLAKE_SAMPLE_DATA.FOO"},
                "USAGE on  SNOWFLAKE_SAMPLE_DATA.FOO",
            ),
            ({"privilege": "USAGE", "granted_on": "DATABASE", "name": ""}, "USAGE on DATABASE "),
        ],
    )
    def test_flags_malformed_rows(self, row: dict[str, object], expected: str) -> None:
        assert _find_public_grants([row]) == [expected]

    def test_mixed_corpus_and_dev_row_returns_only_the_dev_violation(self) -> None:
        dev_row = {"privilege": "SELECT", "granted_on": "TABLE", "name": f"{_DEV_DB}.APP.T"}
        assert _find_public_grants([_public_grant_corpus()[0], dev_row]) == [
            f"SELECT on TABLE {_DEV_DB}.APP.T"
        ]

    @pytest.mark.parametrize("row", _public_grant_corpus())
    def test_ignores_each_account_default_corpus_row(self, row: dict[str, object]) -> None:
        assert _find_public_grants([row]) == []

    def test_full_representative_account_default_corpus_passes(self) -> None:
        corpus = _public_grant_corpus()
        assert _find_public_grants(corpus) == []

    @pytest.mark.parametrize(
        "row",
        [
            {"privilege": "SELECT", "granted_on": "TABLE", "name": "ROASTPILOT_DEV_EVIL.APP.T"},
            {"privilege": "SELECT", "granted_on": "TABLE", "name": "roastpilot_dev.app.t"},
            {"privilege": "SELECT", "granted_on": "TABLE", "name": f"{_DEV_DB} .APP.T"},
            {"privilege": "USAGE", "granted_on": "WAREHOUSE", "name": f"{_DEV_WH}_EVIL"},
            {"privilege": "USAGE", "granted_on": "DATABASE", "name": "ROASTPILOT_PREVIEW"},
        ],
    )
    def test_ignores_non_owned_lookalikes_and_preview(self, row: dict[str, object]) -> None:
        assert _find_public_grants([row]) == []

    def test_empty_rows_are_ignored(self) -> None:
        assert _find_public_grants([]) == []


class TestFindDefaultRoleBoundaryReaches:
    def test_flags_dev_table_reachable_via_default_role(self) -> None:
        grants = {
            "SNOWFLAKE_LEARNING_ROLE": [
                {"privilege": "SELECT", "granted_on": "TABLE", "name": f"{_DEV_DB}.APP.T"}
            ]
        }
        assert assert_dev_ci_grants.find_default_role_boundary_reaches(grants, _DEV_DB, _DEV_WH) == [
            f"SELECT on TABLE {_DEV_DB}.APP.T "
            "(reachable by PUBLIC via default role SNOWFLAKE_LEARNING_ROLE)"
        ]

    def test_ignores_snowflake_internal_database_and_role_grants(self) -> None:
        grants = {
            "SNOWFLAKE_LEARNING_ROLE": [
                {
                    "privilege": "USAGE",
                    "granted_on": "DATABASE",
                    "name": "SNOWFLAKE_LEARNING_DB",
                },
                {"privilege": "USAGE", "granted_on": "ROLE", "name": "X"},
            ]
        }
        assert assert_dev_ci_grants.find_default_role_boundary_reaches(grants, _DEV_DB, _DEV_WH) == []

    def test_flags_dev_warehouse_reachable_via_default_role(self) -> None:
        grants = {
            "SNOWFLAKE_LEARNING_ROLE": [
                {"privilege": "USAGE", "granted_on": "WAREHOUSE", "name": _DEV_WH}
            ]
        }
        violations = assert_dev_ci_grants.find_default_role_boundary_reaches(grants, _DEV_DB, _DEV_WH)
        assert violations == [
            f"USAGE on WAREHOUSE {_DEV_WH} "
            "(reachable by PUBLIC via default role SNOWFLAKE_LEARNING_ROLE)"
        ]

    def test_flags_unknown_object_type_on_dev_container_fail_closed(self) -> None:
        grants = {
            "SNOWFLAKE_LEARNING_ROLE": [
                {
                    "privilege": "USAGE",
                    "granted_on": "SOME_FUTURE_OBJECT_TYPE",
                    "name": f"{_DEV_DB}.APP.T",
                }
            ]
        }
        violations = assert_dev_ci_grants.find_default_role_boundary_reaches(grants, _DEV_DB, _DEV_WH)
        assert violations == [
            f"USAGE on SOME_FUTURE_OBJECT_TYPE {_DEV_DB}.APP.T "
            "(reachable by PUBLIC via default role SNOWFLAKE_LEARNING_ROLE)"
        ]

    @pytest.mark.parametrize(
        "row",
        [
            {
                "privilege": "USAGE",
                "granted_on": "",
                "name": "SNOWFLAKE_LEARNING_DB.PUBLIC.T",
            },
            {"privilege": "USAGE", "granted_on": "DATABASE", "name": ""},
        ],
    )
    def test_flags_malformed_rows_on_non_owned_targets(self, row: dict[str, object]) -> None:
        grants = {"SNOWFLAKE_LEARNING_ROLE": [row]}
        violations = assert_dev_ci_grants.find_default_role_boundary_reaches(grants, _DEV_DB, _DEV_WH)
        assert violations == [
            f"USAGE on {row['granted_on']} {row['name']} "
            "(reachable by PUBLIC via default role SNOWFLAKE_LEARNING_ROLE)"
        ]

    def test_empty_mapping_has_no_reaches(self) -> None:
        assert assert_dev_ci_grants.find_default_role_boundary_reaches({}, _DEV_DB, _DEV_WH) == []


class TestFindFutureGrantViolations:
    """Codex P1, PR #57, round 4: `SHOW FUTURE GRANTS TO ROLE` rows use
    `grant_on` (not `granted_on`) and `name` holds the CONTAINER the future
    grant is scoped to (the object doesn't exist yet) -- reuses
    `is_allowed_grant`'s boundary logic regardless.
    """

    def test_no_violations_for_a_compliant_future_grant(self) -> None:
        rows = [{"privilege": "SELECT", "grant_on": "TABLE", "name": f"{_DEV_DB}.APP"}]
        assert assert_dev_ci_grants.find_future_grant_violations(rows, _DEV_ROLE, _DEV_DB, _DEV_WH) == []

    def test_file_format_future_grant_uses_live_vocabulary_and_boundary(self) -> None:
        dev_rows = [
            {
                "privilege": "USAGE",
                "grant_on": "FILE_FORMAT",
                "name": "ROASTPILOT_DEV.APP",
            }
        ]
        assert (
            assert_dev_ci_grants.find_future_grant_violations(
                dev_rows, _DEV_ROLE, _DEV_DB, _DEV_WH
            )
            == []
        )

        preview_rows = [
            {
                "privilege": "USAGE",
                "grant_on": "FILE_FORMAT",
                "name": "ROASTPILOT_PREVIEW.APP",
            }
        ]
        violations = assert_dev_ci_grants.find_future_grant_violations(
            preview_rows, _DEV_ROLE, _DEV_DB, _DEV_WH
        )
        assert len(violations) == 1

    def test_flags_a_future_grant_outside_dev(self) -> None:
        rows = [{"privilege": "SELECT", "grant_on": "TABLE", "name": "ROASTPILOT_PREVIEW.APP"}]
        violations = assert_dev_ci_grants.find_future_grant_violations(rows, _DEV_ROLE, _DEV_DB, _DEV_WH)
        assert len(violations) == 1
        assert "ROASTPILOT_PREVIEW" in violations[0]

    def test_flags_multiple_future_grant_violations_independently(self) -> None:
        rows = [
            {"privilege": "SELECT", "grant_on": "TABLE", "name": "ROASTPILOT_PREVIEW.APP"},
            {"privilege": "USAGE", "grant_on": "SCHEMA", "name": "SNOWFLAKE.SOME_SCHEMA"},
        ]
        violations = assert_dev_ci_grants.find_future_grant_violations(rows, _DEV_ROLE, _DEV_DB, _DEV_WH)
        assert len(violations) == 2

    def test_handles_a_missing_field_gracefully_as_a_violation(self) -> None:
        rows = [{"privilege": "SELECT"}]  # no grant_on/name at all
        violations = assert_dev_ci_grants.find_future_grant_violations(rows, _DEV_ROLE, _DEV_DB, _DEV_WH)
        assert len(violations) == 1

    def test_empty_rows_is_never_a_violation(self) -> None:
        assert assert_dev_ci_grants.find_future_grant_violations([], _DEV_ROLE, _DEV_DB, _DEV_WH) == []


class TestFindPublicFutureGrants:
    """Codex P1, PR #57, round 4: same unconditional zero-tolerance
    standard as `find_public_grants`, applied to PUBLIC's future grants --
    AGENTS.md's invariant doesn't carve out an exception for grants that
    haven't materialized yet.
    """

    def test_empty_when_public_has_no_future_grants(self) -> None:
        assert assert_dev_ci_grants.find_public_future_grants([]) == []

    def test_flags_a_future_grant_even_inside_the_dev_boundary(self) -> None:
        rows = [{"privilege": "SELECT", "grant_on": "TABLE", "name": f"{_DEV_DB}.APP"}]
        violations = assert_dev_ci_grants.find_public_future_grants(rows)
        assert len(violations) == 1
        assert "APP" in violations[0]

    def test_flags_multiple_future_grants_independently(self) -> None:
        rows = [
            {"privilege": "SELECT", "grant_on": "TABLE", "name": f"{_DEV_DB}.APP"},
            {"privilege": "USAGE", "grant_on": "SCHEMA", "name": _DEV_DB},
        ]
        assert len(assert_dev_ci_grants.find_public_future_grants(rows)) == 2


class TestApplicationRoleManifest:
    def _violations(self, role_name: str, rows: list[dict[str, object]]) -> list[str]:
        expected = assert_dev_ci_grants.expected_role_grants(_DEV_DB)[role_name]
        return assert_dev_ci_grants.find_role_manifest_violations(
            role_name,
            rows,
            expected,
            _DEV_DB,
            assert_dev_ci_grants._ALLOWED_APP_ROLE_WAREHOUSES,
        )

    def test_confirmed_live_procedure_signature_is_pinned(self) -> None:
        assert (
            assert_dev_ci_grants._SUBMIT_REVIEW_LIVE_SIGNATURE
            == "ROASTPILOT_DEV.APP.SUBMIT_REVIEW(VARCHAR, VARCHAR, NUMBER, NUMBER, "
            "NUMBER, NUMBER, NUMBER, NUMBER, VARCHAR, VARCHAR, VARCHAR)"
        )

    def test_agent_expected_manifest_contains_only_live_file_format_spelling(
        self,
    ) -> None:
        expected = assert_dev_ci_grants.expected_role_grants(_DEV_DB)[
            assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE
        ]
        live_row = (
            "USAGE",
            "FILE_FORMAT",
            "ROASTPILOT_DEV.APP.ROAST_JSONL_FORMAT",
            "ROASTPILOT_AGENT",
        )
        assert live_row in expected
        assert (live_row[0], "FILE FORMAT", live_row[2], live_row[3]) not in expected

    def test_offline_file_format_live_row_reports_extra_and_missing(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE)
        target = next(
            row
            for row in rows
            if row["name"] == "ROASTPILOT_DEV.APP.ROAST_JSONL_FORMAT"
        )
        target["granted_on"] = "FILE FORMAT"

        violations = self._violations(
            assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE, rows
        )
        assert any(
            "extra grant" in violation and "FILE FORMAT" in violation
            for violation in violations
        )
        assert any(
            "missing manifest grant" in violation and "FILE_FORMAT" in violation
            for violation in violations
        )

    def test_every_offline_multi_word_type_maps_to_known_live_vocabulary(
        self,
    ) -> None:
        for object_type in check_grant_manifest.ALLOWED_OBJECT_TYPES:
            if " " in object_type:
                live_object_type = assert_dev_ci_grants._live_object_type(
                    object_type
                )
                assert " " not in live_object_type
                assert (
                    live_object_type
                    in assert_dev_ci_grants._DATABASE_SCOPED_OBJECT_TYPES
                )

    def test_live_object_type_maps_known_types_and_rejects_unknown_multi_word_types(
        self,
    ) -> None:
        assert (
            assert_dev_ci_grants._live_object_type("FILE FORMAT")
            == "FILE_FORMAT"
        )
        assert (
            assert_dev_ci_grants._live_object_type("MATERIALIZED VIEW")
            == "MATERIALIZED_VIEW"
        )
        assert assert_dev_ci_grants._live_object_type("TABLE") == "TABLE"
        for object_type in ("EXTERNAL TABLE", "DATABASE ROLE"):
            with pytest.raises(
                ValueError, match="unmapped multi-word offline object type"
            ):
                assert_dev_ci_grants._live_object_type(object_type)

    def test_manifest_types_cross_to_known_live_vocabulary(self) -> None:
        for grant in check_grant_manifest.EXPECTED_MANIFEST:
            live_object_type, _ = assert_dev_ci_grants._live_manifest_object(
                _DEV_DB, grant
            )
            if " " not in grant.object_type:
                assert live_object_type == grant.object_type
            if grant.object_type != "WAREHOUSE":
                assert (
                    live_object_type
                    in assert_dev_ci_grants._DATABASE_SCOPED_OBJECT_TYPES
                )

    def test_object_manifest_grants_are_dev_qualified_without_prerequisites(
        self,
    ) -> None:
        grants = assert_dev_ci_grants.object_manifest_role_grants(_DEV_DB)

        assert (
            "SELECT",
            "VIEW",
            "ROASTPILOT_DEV.APP.ROAST_BY_SLUG",
            assert_dev_ci_grants.PUBLIC_WEB_ROLE,
        ) in grants[assert_dev_ci_grants.PUBLIC_WEB_ROLE]
        assert all(
            grant[1] not in {"DATABASE", "SCHEMA"}
            for role_grants in grants.values()
            for grant in role_grants
        )

    @pytest.mark.parametrize(
        ("role_name", "row_count"),
        [(assert_dev_ci_grants.PUBLIC_WEB_ROLE, 6), (assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE, 27)],
    )
    def test_d345f_capture_with_shared_app_warehouse_is_compliant(
        self, role_name: str, row_count: int
    ) -> None:
        rows = _app_role_rows(role_name)
        assert len(rows) == row_count
        assert all(row["grant_option"] == "false" for row in rows)
        assert self._violations(role_name, rows) == []

    def test_canonical_live_object_name_has_exact_confirmed_shape(self) -> None:
        assert (
            assert_dev_ci_grants._canonical_live_object_name(
                "ROASTPILOT_DEV", "app.roast_by_slug"
            )
            == "ROASTPILOT_DEV.APP.ROAST_BY_SLUG"
        )

    def test_canonical_live_object_name_rejects_non_app_schema(self) -> None:
        with pytest.raises(ValueError, match="unrecognized offline manifest object name"):
            assert_dev_ci_grants._canonical_live_object_name(
                "ROASTPILOT_DEV", "other.roast_by_slug"
            )

    @pytest.mark.parametrize(
        ("name", "expected"),
        [
            ("ROASTPILOT.APP.ROAST_BY_SLUG", "APP.ROAST_BY_SLUG"),
            ("ROASTPILOT_PREVIEW.APP", "APP"),
            ("ROASTPILOT", ""),
        ],
    )
    def test_environment_invariant_name_strips_exactly_one_prefix(
        self, name: str, expected: str
    ) -> None:
        assert assert_dev_ci_grants._environment_invariant_name(name) == expected

    def test_public_web_cross_environment_allowed_set_is_manifest_derived(self) -> None:
        assert assert_dev_ci_grants._PUBLIC_WEB_CROSS_ENV_ALLOWED == frozenset(
            {
                ("SELECT", "VIEW", "APP.ROAST_BY_SLUG"),
                ("SELECT", "VIEW", "APP.REVIEWS_BY_ROAST"),
                (
                    "USAGE",
                    "PROCEDURE",
                    assert_dev_ci_grants._environment_invariant_name(
                        _LIVE_SUBMIT_REVIEW_SIGNATURE
                    ),
                ),
                ("USAGE", "SCHEMA", "APP"),
            }
        )

    def test_app_role_environment_database_family_is_pinned(self) -> None:
        assert assert_dev_ci_grants._APP_ROLE_ENVIRONMENT_DATABASES == frozenset(
            {"ROASTPILOT_DEV", "ROASTPILOT_PREVIEW", "ROASTPILOT"}
        )

    def test_live_procedure_signature_rejects_unrecognized_signature(self) -> None:
        with pytest.raises(ValueError, match="unrecognized offline procedure signature"):
            assert_dev_ci_grants._live_procedure_signature(
                "ROASTPILOT_DEV", "other.submit_review(string)"
            )

    def test_public_web_exact_manifest_passes(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        assert all(row["grant_option"] == "false" for row in rows)
        assert self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows) == []

    def test_public_web_rejects_cross_environment_file_format(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows.append(
            {
                "privilege": "USAGE",
                "granted_on": "FILE_FORMAT",
                "name": "ROASTPILOT_PREVIEW.APP.ROAST_JSONL_FORMAT",
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": "false",
            }
        )
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any("unexpected PUBLIC_WEB grant" in item for item in violations)

    def test_public_web_rejects_out_of_family_file_format(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows.append(
            {
                "privilege": "USAGE",
                "granted_on": "FILE_FORMAT",
                "name": "NOT_OURS.APP.X",
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": "false",
            }
        )
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any("unexpected PUBLIC_WEB grant" in item for item in violations)

    def test_roastpilot_agent_exact_manifest_passes(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE)
        assert all(row["grant_option"] == "false" for row in rows)
        assert self._violations(assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE, rows) == []

    def test_agent_allows_cross_environment_file_format(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE)
        rows.append(
            {
                "privilege": "USAGE",
                "granted_on": "FILE_FORMAT",
                "name": "ROASTPILOT_PREVIEW.APP.ROAST_JSONL_FORMAT",
                "grantee_name": assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE,
                "grant_option": "false",
            }
        )
        # find_role_manifest_violations's docstring records the ratified
        # D-345-G/D106 agent cross-environment database-scoped leniency.
        violations = self._violations(assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE, rows)
        assert violations == []

    def test_agent_allows_out_of_family_file_format(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE)
        rows.append(
            {
                "privilege": "USAGE",
                "granted_on": "FILE_FORMAT",
                "name": "NOT_OURS.APP.X",
                "grantee_name": assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE,
                "grant_option": "false",
            }
        )
        # This is the pre-existing D-345-G/D106 agent leniency recorded by
        # find_role_manifest_violations's docstring. It applies uniformly to
        # every database-scoped type: verified TABLE, VIEW, and STAGE rows in
        # the same foreign database behave identically. The family check
        # applies only to PUBLIC_WEB; correcting the vocabulary makes
        # FILE_FORMAT consistent with the other eleven types rather than
        # opening a new path.
        violations = self._violations(assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE, rows)
        assert violations == []

    def test_live_object_core_is_faithful_transform_of_offline_manifest(self) -> None:
        live = assert_dev_ci_grants.expected_role_grants(_DEV_DB)
        object_rows = [
            row
            for role_rows in live.values()
            for row in role_rows
            if row[1] in {"VIEW", "TABLE", "STAGE"}
        ]
        assert all(
            re.fullmatch(r"ROASTPILOT_DEV\.APP\.[A-Z0-9_]+", row[2])
            for row in object_rows
        )
        live_core = {(privilege, kind, name.rsplit(".", 1)[-1], role) for privilege, kind, name, role in object_rows}
        offline_core = {
            (
                privilege,
                grant.object_type,
                grant.object_name.split(".", 1)[1].upper(),
                grant.role_name,
            )
            for grant in check_grant_manifest.EXPECTED_MANIFEST
            if grant.object_type in {"VIEW", "TABLE", "STAGE"}
            for privilege in grant.privileges
        }
        assert live_core == offline_core

    def test_agent_table_privileges_follow_narrowed_manifest_exactly(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        manifest_module = assert_dev_ci_grants.check_grant_manifest
        original_manifest = manifest_module.EXPECTED_MANIFEST
        target = next(
            grant
            for grant in original_manifest
            if grant.role_name == assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE
            and grant.object_type == "TABLE"
            and grant.object_name == "app.cloud_roasts"
        )
        narrowed = type(target)(
            frozenset({"SELECT", "INSERT", "UPDATE"}),
            target.object_type,
            target.object_name,
            target.role_name,
        )
        monkeypatch.setattr(
            manifest_module,
            "EXPECTED_MANIFEST",
            frozenset((original_manifest - {target}) | {narrowed}),
        )

        expected = assert_dev_ci_grants.expected_role_grants(_DEV_DB)[
            assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE
        ]
        deleted_privilege = (
            "DELETE",
            "TABLE",
            "ROASTPILOT_DEV.APP.CLOUD_ROASTS",
            assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE,
        )
        assert deleted_privilege not in expected

        captured_rows = _app_role_rows(assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE)
        violations = assert_dev_ci_grants.find_role_manifest_violations(
            assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE,
            captured_rows,
            expected,
            _DEV_DB,
            assert_dev_ci_grants._ALLOWED_APP_ROLE_WAREHOUSES,
        )
        assert violations == [
            "extra grant: DELETE on TABLE ROASTPILOT_DEV.APP.CLOUD_ROASTS to "
            "ROASTPILOT_AGENT (grant_option='false')"
        ]

        narrowed_rows = [
            row
            for row in captured_rows
            if not (
                row["privilege"] == "DELETE"
                and row["name"] == "ROASTPILOT_DEV.APP.CLOUD_ROASTS"
            )
        ]
        assert (
            assert_dev_ci_grants.find_role_manifest_violations(
                assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE,
                narrowed_rows,
                expected,
                _DEV_DB,
                assert_dev_ci_grants._ALLOWED_APP_ROLE_WAREHOUSES,
            )
            == []
        )

    def test_old_lowercase_unqualified_object_shape_is_still_missing(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        target = next(row for row in rows if row["granted_on"] == "VIEW")
        target["name"] = "app.roast_by_slug"
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any(
            "missing manifest grant" in violation
            and "ROASTPILOT_DEV.APP.ROAST_BY_SLUG" in violation
            for violation in violations
        )

    def test_ac2_extra_dev_base_table_grant_fails(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows.append(
            {
                "privilege": "SELECT",
                "granted_on": "TABLE",
                "name": "ROASTPILOT_DEV.APP.CLOUD_ROASTS",
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": "false",
            }
        )
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any("extra grant" in violation and "CLOUD_ROASTS" in violation for violation in violations)

    def test_extra_procedure_grant_fails(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows.append(
            {
                "privilege": "USAGE",
                "granted_on": "PROCEDURE",
                "name": "ROASTPILOT_DEV.APP.DELETE_ROAST(VARCHAR)",
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": "false",
            }
        )
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any("extra grant" in violation and "DELETE_ROAST" in violation for violation in violations)

    def test_extra_agent_privilege_fails(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE)
        rows.append(
            {
                "privilege": "OWNERSHIP",
                "granted_on": "TABLE",
                "name": "ROASTPILOT_DEV.APP.CLOUD_ROASTS",
                "grantee_name": assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE,
                "grant_option": "false",
            }
        )
        assert any(
            "extra grant" in violation and "OWNERSHIP" in violation
            for violation in self._violations(assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE, rows)
        )

    def test_missing_procedure_grant_fails(self) -> None:
        rows = [
            row
            for row in _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
            if row["granted_on"] != "PROCEDURE"
        ]
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any("missing manifest grant" in violation and "SUBMIT_REVIEW" in violation for violation in violations)

    def test_empty_visible_result_fails_closed_as_missing(self) -> None:
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, [])
        assert len(violations) == len(
            assert_dev_ci_grants.expected_role_grants(_DEV_DB)[
                assert_dev_ci_grants.PUBLIC_WEB_ROLE
            ]
        )
        assert all("missing manifest grant" in violation for violation in violations)

    def test_missing_live_columns_fail_closed_with_stable_empty_defaults(self) -> None:
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, [{}])
        assert violations[0] == "unexpected grant:  on   to  (grant_option=<absent>)"

    @pytest.mark.parametrize(
        "lookalike",
        ["ROASTPILOT_DEV.APP.roast_by_slug", "ROASTPILOT_DEV.APP.ROAST_BY_SLUG "],
    )
    def test_identifier_lookalikes_fail_byte_exact_match(self, lookalike: str) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        target = next(
            row for row in rows if row["name"] == "ROASTPILOT_DEV.APP.ROAST_BY_SLUG"
        )
        target["name"] = lookalike
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any("extra grant" in violation and lookalike in violation for violation in violations)
        assert any(
            "missing manifest grant" in violation
            and "ROASTPILOT_DEV.APP.ROAST_BY_SLUG" in violation
            for violation in violations
        )

    @pytest.mark.parametrize(
        ("granted_on", "name"),
        [
            ("PROCEDURE", "ROASTPILOT_DEV.APP.SUBMIT_REVIEW(VARCHAR)"),
            ("FUNCTION", "ROASTPILOT_DEV.APP.ROAST_BY_SLUG"),
        ],
    )
    def test_unrecognised_live_shape_fails_closed(self, granted_on: str, name: str) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows.append(
            {
                "privilege": "USAGE",
                "granted_on": granted_on,
                "name": name,
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": "false",
            }
        )
        assert any(
            "extra grant" in violation
            for violation in self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        )

    def test_ac4_roastpilot_warehouse_is_allowlisted(self) -> None:
        row = {
            "privilege": "USAGE",
            "granted_on": "WAREHOUSE",
            "name": "ROASTPILOT_WH",
            "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
            "grant_option": "false",
        }
        assert (
            assert_dev_ci_grants.find_role_manifest_violations(
                assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                [row],
                frozenset(),
                _DEV_DB,
                assert_dev_ci_grants._ALLOWED_APP_ROLE_WAREHOUSES,
            )
            == []
        )

    def test_allowlisted_warehouse_rejects_non_usage_privilege(self) -> None:
        # Mutation guard: removing the USAGE privilege check would silently
        # admit this warehouse escalation through the allowlist branch.
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        target = next(row for row in rows if row["name"] == "ROASTPILOT_WH")
        target["privilege"] = "OPERATE"
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any(
            "unexpected warehouse grant" in violation
            and "OPERATE" in violation
            and "ROASTPILOT_WH" in violation
            for violation in violations
        )

    @pytest.mark.parametrize(
        "role_name",
        [assert_dev_ci_grants.PUBLIC_WEB_ROLE, assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE],
    )
    def test_dev_ci_warehouse_is_unexpected_for_application_role(
        self, role_name: str
    ) -> None:
        # Mutation guard: adding DEV_CI_WH back to the allowlist makes this
        # CI-warehouse grant disappear from the violation list.
        rows = _app_role_rows(role_name)
        rows.append(
            {
                "privilege": "USAGE",
                "granted_on": "WAREHOUSE",
                "name": "DEV_CI_WH",
                "grantee_name": role_name,
                "grant_option": "false",
            }
        )
        violations = self._violations(role_name, rows)
        assert any(
            "unexpected warehouse grant" in violation and "DEV_CI_WH" in violation
            for violation in violations
        )

    def test_ac5_non_allowlisted_prod_warehouse_fails(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows.append(
            {
                "privilege": "USAGE",
                "granted_on": "WAREHOUSE",
                "name": "PROD_WH",
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": "false",
            }
        )
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any(
            "unexpected warehouse grant" in violation and "PROD_WH" in violation
            for violation in violations
        )

    def test_allowlisted_warehouse_requires_false_grant_option(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        target = next(row for row in rows if row["name"] == "ROASTPILOT_WH")
        target["grant_option"] = "true"
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any(
            "unexpected warehouse grant" in violation
            and "ROASTPILOT_WH" in violation
            and "grant_option='true'" in violation
            for violation in violations
        )

        target.pop("grant_option")
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any(
            "unexpected warehouse grant" in violation
            and "ROASTPILOT_WH" in violation
            and "grant_option=<absent>" in violation
            for violation in violations
        )

    def test_ac6_preview_and_prod_database_objects_are_ignored(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows.extend(
            {
                "privilege": "SELECT",
                "granted_on": "VIEW",
                "name": name,
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": "false",
            }
            for name in (
                "ROASTPILOT_PREVIEW.APP.ROAST_BY_SLUG",
                "ROASTPILOT.APP.ROAST_BY_SLUG",
            )
        )
        assert self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows) == []

    def test_other_environment_database_and_schema_prerequisites_are_ignored(
        self,
    ) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows.extend(
            [
                {
                    "privilege": "USAGE",
                    "granted_on": "DATABASE",
                    "name": "ROASTPILOT_PREVIEW",
                    "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                    "grant_option": "false",
                },
                {
                    "privilege": "USAGE",
                    "granted_on": "SCHEMA",
                    "name": "ROASTPILOT_PREVIEW.APP",
                    "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                    "grant_option": "false",
                },
            ]
        )
        assert self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows) == []

    def test_public_web_cross_environment_secure_view_and_procedure_are_allowed(
        self,
    ) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows.extend(
            [
                {
                    "privilege": "SELECT",
                    "granted_on": "VIEW",
                    "name": "ROASTPILOT_PREVIEW.APP.ROAST_BY_SLUG",
                    "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                    "grant_option": "false",
                },
                {
                    "privilege": "SELECT",
                    "granted_on": "VIEW",
                    "name": "ROASTPILOT.APP.REVIEWS_BY_ROAST",
                    "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                    "grant_option": "false",
                },
                {
                    "privilege": "USAGE",
                    "granted_on": "PROCEDURE",
                    "name": _LIVE_SUBMIT_REVIEW_SIGNATURE.replace(
                        "ROASTPILOT_DEV", "ROASTPILOT"
                    ),
                    "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                    "grant_option": "false",
                },
                {
                    "privilege": "USAGE",
                    "granted_on": "SCHEMA",
                    "name": "ROASTPILOT_PREVIEW.APP",
                    "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                    "grant_option": "false",
                },
                {
                    "privilege": "USAGE",
                    "granted_on": "DATABASE",
                    "name": "ROASTPILOT_PREVIEW",
                    "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                    "grant_option": "false",
                },
                {
                    "privilege": "USAGE",
                    "granted_on": "DATABASE",
                    "name": "ROASTPILOT",
                    "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                    "grant_option": "false",
                },
            ]
        )
        assert self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows) == []

    @pytest.mark.parametrize(
        ("privilege", "granted_on", "name"),
        [
            ("SELECT", "VIEW", "ATTACKER_DB.APP.ROAST_BY_SLUG"),
            ("USAGE", "DATABASE", "ATTACKER_DB"),
            ("USAGE", "SCHEMA", "ATTACKER_DB.APP"),
            (
                "USAGE",
                "PROCEDURE",
                _LIVE_SUBMIT_REVIEW_SIGNATURE.replace(
                    "ROASTPILOT_DEV", "ATTACKER_DB"
                ),
            ),
            ("SELECT", "VIEW", ".APP.ROAST_BY_SLUG"),
        ],
    )
    def test_public_web_rejects_non_family_cross_environment_database(
        self, privilege: str, granted_on: str, name: str
    ) -> None:
        # Mutation guard: removing either family-membership check silently
        # admits an attacker-owned database with an otherwise allowed suffix.
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows.append(
            {
                "privilege": privilege,
                "granted_on": granted_on,
                "name": name,
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": "false",
            }
        )
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any(
            "unexpected PUBLIC_WEB grant" in violation and name in violation
            for violation in violations
        )

    @pytest.mark.parametrize(
        ("privilege", "granted_on", "name", "grant_option"),
        [
            (
                "USAGE",
                "PROCEDURE",
                "ROASTPILOT.APP.DELETE_ROAST(VARCHAR)",
                "false",
            ),
            ("SELECT", "VIEW", "ROASTPILOT.APP.SECRET_ALL_ROWS", "false"),
            ("USAGE", "SCHEMA", "ROASTPILOT.SECRET", "false"),
            ("UPDATE", "VIEW", "ROASTPILOT.APP.ROAST_BY_SLUG", "false"),
            (
                "EXECUTE",
                "PROCEDURE",
                _LIVE_SUBMIT_REVIEW_SIGNATURE.replace("ROASTPILOT_DEV", "ROASTPILOT"),
                "false",
            ),
            ("SELECT", "VIEW", "ROASTPILOT.APP.ROAST_BY_SLUG", "true"),
        ],
    )
    def test_public_web_cross_environment_surface_fails_closed(
        self,
        privilege: str,
        granted_on: str,
        name: str,
        grant_option: str,
    ) -> None:
        # Mutation guards: name, privilege, object type, and false grant-option
        # must all participate in the cross-environment allow decision.
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows.append(
            {
                "privilege": privilege,
                "granted_on": granted_on,
                "name": name,
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": grant_option,
            }
        )
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any(
            "unexpected PUBLIC_WEB grant" in violation and name in violation
            for violation in violations
        )

    def test_public_web_cross_environment_database_grant_option_fails_closed(
        self,
    ) -> None:
        # Mutation guard for the bare-DATABASE branch's grant-option half.
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows.append(
            {
                "privilege": "USAGE",
                "granted_on": "DATABASE",
                "name": "ROASTPILOT",
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": "true",
            }
        )
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any(
            "unexpected PUBLIC_WEB grant" in violation
            and "USAGE on DATABASE ROASTPILOT" in violation
            for violation in violations
        )

    @pytest.mark.parametrize(
        "name",
        [
            "ROASTPILOT.APP.CLOUD_ROASTS",
            "ROASTPILOT_PREVIEW.APP.CLOUD_ROASTS",
        ],
    )
    def test_public_web_cross_environment_base_table_fails(self, name: str) -> None:
        # Mutation guard: removing the PUBLIC_WEB cross-environment shape
        # check would silently ignore this base-table escalation.
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows.append(
            {
                "privilege": "SELECT",
                "granted_on": "TABLE",
                "name": name,
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": "false",
            }
        )
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any(
            "unexpected PUBLIC_WEB grant" in violation and name in violation
            for violation in violations
        )

    def test_public_web_cross_environment_stage_fails(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows.append(
            {
                "privilege": "READ",
                "granted_on": "STAGE",
                "name": "ROASTPILOT.APP.ROAST_ARTIFACTS",
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": "false",
            }
        )
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any(
            "unexpected PUBLIC_WEB grant" in violation
            and "ROASTPILOT.APP.ROAST_ARTIFACTS" in violation
            for violation in violations
        )

    def test_public_web_cross_environment_database_wrong_privilege_fails(
        self,
    ) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows.append(
            {
                "privilege": "SELECT",
                "granted_on": "DATABASE",
                "name": "ROASTPILOT",
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": "false",
            }
        )
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any(
            "unexpected PUBLIC_WEB grant" in violation
            and "SELECT on DATABASE ROASTPILOT" in violation
            for violation in violations
        )

    def test_agent_cross_environment_base_table_remains_out_of_scope(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE)
        rows.append(
            {
                "privilege": "SELECT",
                "granted_on": "TABLE",
                "name": "ATTACKER_DB.APP.X",
                "grantee_name": assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE,
                "grant_option": "false",
            }
        )
        assert self._violations(assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE, rows) == []

    @pytest.mark.parametrize("name", ["", "CLOUD_ROASTS"])
    def test_malformed_database_scoped_object_name_fails_closed(self, name: str) -> None:
        # Mutation guard: removing the qualification check would silently
        # ignore the empty-name case as an other-environment object.
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows.append(
            {
                "granted_on": "TABLE",
                "name": name,
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": "false",
            }
        )
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any(
            "unexpected grant" in violation and f"TABLE {name}" in violation
            for violation in violations
        )

    def test_dotted_database_name_fails_closed(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows.append(
            {
                "privilege": "USAGE",
                "granted_on": "DATABASE",
                "name": "ROASTPILOT_PREVIEW.X",
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": "false",
            }
        )
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any(
            "unexpected grant" in violation
            and "DATABASE ROASTPILOT_PREVIEW.X" in violation
            for violation in violations
        )

    def test_ac7_role_and_account_grants_fail_closed(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows.extend(
            [
                {
                    "privilege": "USAGE",
                    "granted_on": "ROLE",
                    "name": "ACCOUNTADMIN",
                    "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                    "grant_option": "false",
                },
                {
                    "privilege": "CREATE USER",
                    "granted_on": "ACCOUNT",
                    "name": "ACCOUNT",
                    "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                    "grant_option": "false",
                },
            ]
        )
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert len(violations) == 2
        assert all("unexpected grant" in violation for violation in violations)
        assert any("ROLE ACCOUNTADMIN" in violation for violation in violations)
        assert any("ACCOUNT ACCOUNT" in violation for violation in violations)

    def test_dev_container_check_precedes_warehouse_allowlist(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows.append(
            {
                "privilege": "USAGE",
                "granted_on": "WAREHOUSE",
                "name": "ROASTPILOT_DEV.APP.SECRET",
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": "false",
            }
        )
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any(
            "extra grant" in violation and "ROASTPILOT_DEV.APP.SECRET" in violation
            for violation in violations
        )
        assert not any("unexpected warehouse grant" in violation for violation in violations)

    def test_wrong_agent_privilege_produces_extra_and_missing(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE)
        target = next(
            row
            for row in rows
            if row["name"] == "ROASTPILOT_DEV.APP.CLOUD_ROASTS"
            and row["privilege"] == "DELETE"
        )
        target["privilege"] = "TRUNCATE"
        violations = self._violations(assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE, rows)
        assert any("extra grant" in violation and "TRUNCATE" in violation for violation in violations)
        assert any("missing manifest grant" in violation and "DELETE" in violation for violation in violations)

    @pytest.mark.parametrize("grant_option", ["true", True])
    def test_grant_option_elevation_fails_closed(self, grant_option: object) -> None:
        # Mutation guard: removing the grant_option eligibility check makes
        # this elevated row match the expected tuple and this test fail.
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        target = next(row for row in rows if row["granted_on"] == "VIEW")
        target["grant_option"] = grant_option
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any(
            "extra grant" in violation and f"grant_option={grant_option!r}" in violation
            for violation in violations
        )
        assert any(
            "missing manifest grant" in violation
            and "ROASTPILOT_DEV.APP.ROAST_BY_SLUG" in violation
            for violation in violations
        )

    def test_unrecognized_grant_option_representation_fails_closed(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows[0]["grant_option"] = "disabled"
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any("grant_option='disabled'" in violation for violation in violations)

    @pytest.mark.parametrize("grant_option", [False, "false", "FALSE", "", None])
    def test_known_false_or_empty_grant_option_representations_pass(
        self, grant_option: object
    ) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        rows[0]["grant_option"] = grant_option
        assert self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows) == []

    def test_absent_grant_option_fails_closed(self) -> None:
        rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        target = next(row for row in rows if row["granted_on"] == "VIEW")
        target.pop("grant_option")
        violations = self._violations(assert_dev_ci_grants.PUBLIC_WEB_ROLE, rows)
        assert any(
            "extra grant" in violation and "grant_option=<absent>" in violation
            for violation in violations
        )
        assert any(
            "missing manifest grant" in violation
            and "ROASTPILOT_DEV.APP.ROAST_BY_SLUG" in violation
            for violation in violations
        )

    def test_empty_future_grant_results_pass(self) -> None:
        assert assert_dev_ci_grants.find_role_future_grant_violations(
            assert_dev_ci_grants.PUBLIC_WEB_ROLE, []
        ) == []
        assert assert_dev_ci_grants.find_role_future_grant_violations(
            assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE, []
        ) == []

    def test_any_agent_future_grant_fails(self) -> None:
        rows = [{"privilege": "SELECT", "grant_on": "TABLE", "name": f"{_DEV_DB}.APP"}]
        violations = assert_dev_ci_grants.find_role_future_grant_violations(
            assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE, rows
        )
        assert violations == [
            f"future grant on ROASTPILOT_AGENT: SELECT on TABLE {_DEV_DB}.APP"
        ]

    def test_missing_future_columns_still_produce_a_stable_violation(self) -> None:
        violations = assert_dev_ci_grants.find_role_future_grant_violations(
            assert_dev_ci_grants.PUBLIC_WEB_ROLE, [{}]
        )
        assert violations == ["future grant on PUBLIC_WEB:  on  "]


class TestFindOutOfBoundsNames:
    """Codex P1, PR #57: SHOW GRANTS TO ROLE alone can miss a future grant
    or other visibility path -- these tests cover the SHOW DATABASES/SHOW
    WAREHOUSES visibility check that closes that gap.
    """

    def test_empty_when_only_the_allowed_name_is_visible(self) -> None:
        assert assert_dev_ci_grants.find_out_of_bounds_names([_DEV_DB], _DEV_DB) == []

    def test_flags_any_additional_visible_name(self) -> None:
        result = assert_dev_ci_grants.find_out_of_bounds_names([_DEV_DB, "ROASTPILOT_PREVIEW"], _DEV_DB)
        assert result == ["ROASTPILOT_PREVIEW"]

    def test_flags_every_extra_name_independently(self) -> None:
        result = assert_dev_ci_grants.find_out_of_bounds_names(
            [_DEV_DB, "ROASTPILOT_PREVIEW", "SNOWFLAKE"], _DEV_DB
        )
        assert result == ["ROASTPILOT_PREVIEW", "SNOWFLAKE"]

    def test_is_case_sensitive_a_quoted_lowercase_variant_still_flags(self) -> None:
        # Same case-sensitivity reasoning as is_allowed_grant -- a quoted
        # "roastpilot_dev" is a different, out-of-bounds object even though
        # it looks identical once uppercased.
        result = assert_dev_ci_grants.find_out_of_bounds_names(["roastpilot_dev"], _DEV_DB)
        assert result == ["roastpilot_dev"]

    def test_is_whitespace_sensitive_a_padded_variant_still_flags_codex_p1_276(self) -> None:
        # Codex P1, PR #57, round 3, :276: a quoted "ROASTPILOT_DEV " (with
        # a trailing space) is a genuinely different, out-of-bounds object.
        result = assert_dev_ci_grants.find_out_of_bounds_names([f"{_DEV_DB} "], _DEV_DB)
        assert result == [f"{_DEV_DB} "]

    def test_empty_list_of_visible_names_is_never_a_violation(self) -> None:
        assert assert_dev_ci_grants.find_out_of_bounds_names([], _DEV_DB) == []

    def test_admits_the_five_snowflake_defaults_when_the_matching_sets_are_passed(self) -> None:
        databases = [_DEV_DB, "SNOWFLAKE", "SNOWFLAKE_SAMPLE_DATA", "SNOWFLAKE_LEARNING_DB"]
        warehouses = [_DEV_WH, "SNOWFLAKE_LEARNING_WH", "SYSTEM$STREAMLIT_NOTEBOOK_WH"]
        assert (
            assert_dev_ci_grants.find_out_of_bounds_names(
                databases, _DEV_DB, assert_dev_ci_grants._SNOWFLAKE_DEFAULT_DATABASES
            )
            == []
        )
        assert (
            assert_dev_ci_grants.find_out_of_bounds_names(
                warehouses, _DEV_WH, assert_dev_ci_grants._SNOWFLAKE_DEFAULT_WAREHOUSES
            )
            == []
        )

    def test_flags_non_default_databases_alongside_real_defaults(self) -> None:
        names = [
            _DEV_DB,
            "SNOWFLAKE",
            "SNOWFLAKE_SAMPLE_DATA",
            "SNOWFLAKE_LEARNING_DB",
            "ROASTPILOT_PREVIEW",
            "FOO_DB",
        ]
        result = assert_dev_ci_grants.find_out_of_bounds_names(
            names, _DEV_DB, assert_dev_ci_grants._SNOWFLAKE_DEFAULT_DATABASES
        )
        assert result == ["ROASTPILOT_PREVIEW", "FOO_DB"]

    def test_empty_default_set_preserves_the_old_behavior(self) -> None:
        defaults = ["SNOWFLAKE", "SNOWFLAKE_SAMPLE_DATA", "SNOWFLAKE_LEARNING_DB"]
        assert assert_dev_ci_grants.find_out_of_bounds_names(defaults, _DEV_DB, frozenset()) == defaults

    def test_default_allowlist_identifier_matching_is_byte_exact(self) -> None:
        lookalikes = ["SNOWFLAKE_EVIL", "snowflake", "SNOWFLAKE "]
        assert (
            assert_dev_ci_grants.find_out_of_bounds_names(
                lookalikes, _DEV_DB, assert_dev_ci_grants._SNOWFLAKE_DEFAULT_DATABASES
            )
            == lookalikes
        )


class TestFindUnexpectedUserRoleGrants:
    """Codex P1, PR #57, round 2: SHOW GRANTS TO USER audit -- the CI
    service user itself must carry no role beyond the primary role (and
    PUBLIC, which every Snowflake user has implicitly and can't shed).
    """

    def test_empty_when_the_user_has_only_the_expected_role(self) -> None:
        rows = [{"role": _DEV_ROLE}]
        assert assert_dev_ci_grants.find_unexpected_user_role_grants(rows, _DEV_ROLE) == []

    def test_public_is_never_flagged(self) -> None:
        # The real system PUBLIC role is always the literal, unquoted,
        # uppercase string "PUBLIC".
        rows = [{"role": _DEV_ROLE}, {"role": "PUBLIC"}]
        assert assert_dev_ci_grants.find_unexpected_user_role_grants(rows, _DEV_ROLE) == []

    def test_a_quoted_lowercase_public_role_IS_flagged_as_unexpected_codex_p1_376(self) -> None:
        # The exact bug this closes (Codex P1, PR #57, round 3, :376): an
        # earlier version case-folded this comparison
        # (role_name.upper() == "PUBLIC"), which would mistake a QUOTED,
        # genuinely DIFFERENT role literally named "public" for the real
        # system PUBLIC role and wrongly skip auditing it. The real system
        # PUBLIC role is always uppercase and unquoted -- a lowercase
        # "public" is a different, disallowed role and must be flagged.
        rows = [{"role": _DEV_ROLE}, {"role": "public"}]
        result = assert_dev_ci_grants.find_unexpected_user_role_grants(rows, _DEV_ROLE)
        assert result == ["public"]

    def test_flags_an_unexpected_extra_role(self) -> None:
        rows = [{"role": _DEV_ROLE}, {"role": "ACCOUNTADMIN"}]
        result = assert_dev_ci_grants.find_unexpected_user_role_grants(rows, _DEV_ROLE)
        assert result == ["ACCOUNTADMIN"]

    def test_flags_multiple_unexpected_roles_independently(self) -> None:
        rows = [{"role": _DEV_ROLE}, {"role": "ACCOUNTADMIN"}, {"role": "SYSADMIN"}]
        result = assert_dev_ci_grants.find_unexpected_user_role_grants(rows, _DEV_ROLE)
        assert result == ["ACCOUNTADMIN", "SYSADMIN"]

    def test_empty_rows_is_never_a_violation(self) -> None:
        assert assert_dev_ci_grants.find_unexpected_user_role_grants([], _DEV_ROLE) == []

    def test_a_whitespace_padded_variant_of_the_expected_role_is_flagged_codex_p1_276(self) -> None:
        # Codex P1, PR #57, round 3, :276: a quoted role with a trailing
        # space is a genuinely different role from the expected one --
        # stripping before comparing would incorrectly treat them as the
        # same and skip auditing the (different) role that was actually
        # granted.
        rows = [{"role": f"{_DEV_ROLE} "}]
        result = assert_dev_ci_grants.find_unexpected_user_role_grants(rows, _DEV_ROLE)
        assert result == [f"{_DEV_ROLE} "]

    def test_ignores_a_row_with_a_missing_role_field(self) -> None:
        rows = [{"role": _DEV_ROLE}, {}]
        assert assert_dev_ci_grants.find_unexpected_user_role_grants(rows, _DEV_ROLE) == []

    def test_a_row_with_a_missing_role_field_does_not_stop_the_scan_of_LATER_rows(self) -> None:
        """F1-S9 slice 2 (issue #12) mutation-testing survivor triage found
        this: a `continue` -> `break` mutation on the empty-role-field
        branch survived the existing suite. `test_ignores_a_row_with_a_
        missing_role_field` above only ever puts the empty-role row LAST,
        so `continue` and `break` produce the identical result there (the
        loop ends either way). This test puts the empty-role row FIRST,
        followed by a row naming a genuinely unexpected role -- `continue`
        correctly keeps scanning and finds the violation; `break` would
        stop the scan entirely on the empty-role row and silently miss it.
        A row-ordering-dependent gap on the grant-boundary audit itself,
        not a hypothetical one: `SHOW GRANTS TO USER` row order is never
        something this script controls or can assume.
        """
        rows = [{}, {"role": "ACCOUNTADMIN"}]
        result = assert_dev_ci_grants.find_unexpected_user_role_grants(rows, _DEV_ROLE)
        assert result == ["ACCOUNTADMIN"]

    def test_a_public_role_row_does_not_stop_the_scan_of_LATER_rows(self) -> None:
        """The SAME mutation class as the test above, on the OTHER `continue`
        in this function (the PUBLIC-role branch, not the empty-role-field
        one) -- mutation testing found this as a second, independent
        surviving mutant at the same `continue` -> `break` shape.
        `test_public_is_never_flagged` only ever puts PUBLIC last, so it
        can't distinguish `continue` from `break` there either. This test
        puts a PUBLIC row FIRST, followed by a row naming a genuinely
        unexpected role, proving the scan continues past PUBLIC instead of
        stopping on it.
        """
        rows = [{"role": "PUBLIC"}, {"role": "ACCOUNTADMIN"}]
        result = assert_dev_ci_grants.find_unexpected_user_role_grants(rows, _DEV_ROLE)
        assert result == ["ACCOUNTADMIN"]


_LOOKALIKE_USER = "ROASTPILOT0DEV0CI"  # matches ROASTPILOT_DEV_CI under LIKE's `_` wildcard


class TestFindDefaultSecondaryRolesViolation:
    """Codex P1, PR #57, round 5, :270 + round 6, :709/:710: turns the
    operator-run `ALTER USER ... SET DEFAULT_SECONDARY_ROLES = ()`
    dependency into a VERIFIED precondition instead of a silently-trusted
    one -- and never trusts row order or `SHOW USERS LIKE`'s own
    wildcard over-matching as identity (round 6 closed a real bug where
    `user_rows[0]` was trusted unconditionally).
    """

    def test_none_when_the_json_array_string_is_empty(self) -> None:
        rows = [{"name": _CI_USER, "default_secondary_roles": "[]"}]
        assert assert_dev_ci_grants.find_default_secondary_roles_violation(rows, _CI_USER) is None

    def test_none_when_the_connector_already_parsed_an_empty_list(self) -> None:
        # In case the connector parses this particular column into a
        # Python object rather than leaving it as a raw JSON string.
        rows = [{"name": _CI_USER, "default_secondary_roles": []}]
        assert assert_dev_ci_grants.find_default_secondary_roles_violation(rows, _CI_USER) is None

    def test_name_comparison_is_uppercase_folded_deliberately_unlike_identifiers_match(self) -> None:
        # A DIFFERENT comparison policy from identifiers_match's no-fold
        # rule elsewhere in this module: this is an identity lookup for a
        # single operator-supplied env var against Snowflake's own
        # canonical (unquoted-creation) uppercase name, not a security
        # boundary being enforced by case.
        rows = [{"name": _CI_USER.lower(), "default_secondary_roles": "[]"}]
        assert assert_dev_ci_grants.find_default_secondary_roles_violation(rows, _CI_USER) is None

    def test_flags_all_as_a_violation(self) -> None:
        # The exact misconfiguration this check exists to catch: the
        # operator-run ALTER USER ... DEFAULT_SECONDARY_ROLES = () was
        # never run, or was reset, leaving ALL secondary roles active.
        rows = [{"name": _CI_USER, "default_secondary_roles": '["ALL"]'}]
        violation = assert_dev_ci_grants.find_default_secondary_roles_violation(rows, _CI_USER)
        assert violation is not None
        assert "DEFAULT_SECONDARY_ROLES" in violation

    def test_flags_a_missing_column_as_a_violation_fails_closed(self) -> None:
        # Fails CLOSED on a shape this check doesn't recognize, rather than
        # silently treating "column absent" as "safe".
        rows = [{"name": _CI_USER}]  # no default_secondary_roles key at all
        violation = assert_dev_ci_grants.find_default_secondary_roles_violation(rows, _CI_USER)
        assert violation is not None

    def test_flags_none_value_as_a_violation_fails_closed(self) -> None:
        rows = [{"name": _CI_USER, "default_secondary_roles": None}]
        violation = assert_dev_ci_grants.find_default_secondary_roles_violation(rows, _CI_USER)
        assert violation is not None

    def test_flags_no_rows_at_all_as_a_violation(self) -> None:
        violation = assert_dev_ci_grants.find_default_secondary_roles_violation([], _CI_USER)
        assert violation is not None
        assert "DEFAULT_SECONDARY_ROLES" in violation

    def test_a_wildcard_lookalike_alongside_the_real_user_is_ignored_codex_p1_709(self) -> None:
        # The exact bug this closes: SHOW USERS LIKE treats each
        # underscore as a single-char wildcard, so a lookalike name
        # (ROASTPILOT0DEV0CI for ROASTPILOT_DEV_CI) can match too and
        # could sort ahead of the real one -- trusting row order/row[0]
        # would let the lookalike's (here, compliant) setting silently
        # stand in for the real CI user's.
        rows = [
            {"name": _LOOKALIKE_USER, "default_secondary_roles": "[]"},
            {"name": _CI_USER, "default_secondary_roles": "[]"},
        ]
        assert assert_dev_ci_grants.find_default_secondary_roles_violation(rows, _CI_USER) is None

    def test_a_wildcard_lookalikes_compliant_row_never_masks_the_real_users_violation(self) -> None:
        # Even with the lookalike's row compliant AND sorted first, the
        # REAL user's own violating row must still be what's evaluated --
        # this is the unsound direction the round-5 bug actually enabled.
        rows = [
            {"name": _LOOKALIKE_USER, "default_secondary_roles": "[]"},
            {"name": _CI_USER, "default_secondary_roles": '["ALL"]'},
        ]
        violation = assert_dev_ci_grants.find_default_secondary_roles_violation(rows, _CI_USER)
        assert violation is not None

    def test_only_a_wildcard_lookalike_with_no_exact_match_is_a_violation_codex_p1_710(self) -> None:
        # No row for the real user at all -- fails closed rather than
        # silently accepting the lookalike's row as a stand-in.
        rows = [{"name": _LOOKALIKE_USER, "default_secondary_roles": "[]"}]
        violation = assert_dev_ci_grants.find_default_secondary_roles_violation(rows, _CI_USER)
        assert violation is not None

    def test_more_than_one_exact_match_is_a_violation_fails_closed(self) -> None:
        # Should never legitimately happen for a single username, but not
        # assumed away -- ambiguity fails closed rather than picking one.
        rows = [
            {"name": _CI_USER, "default_secondary_roles": "[]"},
            {"name": _CI_USER, "default_secondary_roles": "[]"},
        ]
        violation = assert_dev_ci_grants.find_default_secondary_roles_violation(rows, _CI_USER)
        assert violation is not None


class TestMain:
    """main()'s own connection/query wiring, with snowflake.connector.connect
    mocked -- there is no real Snowflake credential available to test
    against (see the module's own NOTE); this verifies main() calls the
    RIGHT things with the RIGHT arguments and interprets the result
    correctly, which is what's actually testable without live
    infrastructure access.

    main() issues THIRTEEN fixed sequential statements on the same cursor: `USE
    SECONDARY ROLES NONE` (no fetchall), then SHOW GRANTS TO ROLE, SHOW
    DATABASES, SHOW WAREHOUSES, SHOW GRANTS TO ROLE PUBLIC, SHOW GRANTS TO
    USER, SHOW FUTURE GRANTS TO ROLE, SHOW FUTURE GRANTS TO ROLE PUBLIC, and
    SHOW USERS LIKE, and current/future SHOW GRANTS for both application roles
    (each except USE followed by a fetchall). It then issues a variable
    sorted trailing `SHOW GRANTS TO ROLE <default_role>` query for each
    allowlisted default role granted to PUBLIC. `mock_cursor.fetchall` keeps
    the twelve fixed return values as a prefix, followed by those
    per-default-role results in sorted role order.
    """

    def _set_required_env(self, monkeypatch, pem: str) -> None:
        monkeypatch.setenv("SNOWFLAKE_ACCOUNT", "HVPXLEY-EX88650")
        monkeypatch.setenv("SNOWFLAKE_DEV_USER", "ROASTPILOT_DEV_CI")
        monkeypatch.setenv("SNOWFLAKE_DEV_ROLE", _DEV_ROLE)
        monkeypatch.setenv("SNOWFLAKE_DEV_WAREHOUSE", _DEV_WH)
        monkeypatch.setenv("SNOWFLAKE_DEV_DATABASE", _DEV_DB)
        monkeypatch.setenv("SNOWFLAKE_DEV_PRIVATE_KEY", pem)

    def _mock_cursor(
        self,
        grant_rows: list[dict[str, object]],
        visible_databases: list[dict[str, object]] | None = None,
        visible_warehouses: list[dict[str, object]] | None = None,
        public_grant_rows: list[dict[str, object]] | None = None,
        user_role_rows: list[dict[str, object]] | None = None,
        future_grant_rows: list[dict[str, object]] | None = None,
        public_future_grant_rows: list[dict[str, object]] | None = None,
        show_user_rows: list[dict[str, object]] | None = None,
        public_web_grant_rows: list[dict[str, object]] | None = None,
        roastpilot_agent_grant_rows: list[dict[str, object]] | None = None,
        public_web_future_grant_rows: list[dict[str, object]] | None = None,
        roastpilot_agent_future_grant_rows: list[dict[str, object]] | None = None,
        default_role_grant_results: dict[str, list[dict[str, object]]] | None = None,
    ) -> MagicMock:
        mock_cursor = MagicMock()
        mock_cursor.fetchall.side_effect = [
            grant_rows,
            visible_databases if visible_databases is not None else [{"name": _DEV_DB}],
            visible_warehouses if visible_warehouses is not None else [{"name": _DEV_WH}],
            public_grant_rows if public_grant_rows is not None else [],
            user_role_rows if user_role_rows is not None else [{"role": _DEV_ROLE}],
            future_grant_rows if future_grant_rows is not None else [],
            public_future_grant_rows if public_future_grant_rows is not None else [],
            show_user_rows
            if show_user_rows is not None
            else [{"name": _CI_USER, "default_secondary_roles": "[]"}],
            public_web_grant_rows
            if public_web_grant_rows is not None
            else _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE),
            roastpilot_agent_grant_rows
            if roastpilot_agent_grant_rows is not None
            else _app_role_rows(assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE),
            public_web_future_grant_rows if public_web_future_grant_rows is not None else [],
            roastpilot_agent_future_grant_rows if roastpilot_agent_future_grant_rows is not None else [],
            *[grants for _, grants in sorted((default_role_grant_results or {}).items())],
        ]
        return mock_cursor

    def _run_main(
        self,
        monkeypatch,
        argv: list[str],
        *,
        grant_rows: list[dict[str, object]] | None = None,
        **cursor_options,
    ) -> int:
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            grant_rows
            if grant_rows is not None
            else [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            **cursor_options,
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor
        with patch.object(
            assert_dev_ci_grants.snowflake.connector,
            "connect",
            return_value=mock_conn,
        ):
            return assert_dev_ci_grants.main(argv)

    @staticmethod
    def _bootstrap_agent_rows() -> list[dict[str, object]]:
        return _app_role_rows_missing(
            assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE,
            ".ROAST_JSONL_FORMAT",
            ".LOAD_ROAST_TELEMETRY(VARCHAR, VARCHAR)",
        )

    def test_b1_relaxed_mode_allows_agent_bootstrap_missing_grants(
        self, monkeypatch, capsys
    ) -> None:
        exit_code = self._run_main(
            monkeypatch,
            ["--allow-missing-manifest-grants"],
            roastpilot_agent_grant_rows=self._bootstrap_agent_rows(),
        )

        assert exit_code == 0
        assert "missing manifest grant" not in capsys.readouterr().err

    def test_b1b_relaxed_mode_allows_public_web_bootstrap_missing_grant(
        self, monkeypatch, capsys
    ) -> None:
        public_web_rows = _app_role_rows_missing(
            assert_dev_ci_grants.PUBLIC_WEB_ROLE, ".REVIEWS_BY_ROAST"
        )
        exit_code = self._run_main(
            monkeypatch,
            ["--allow-missing-manifest-grants"],
            public_web_grant_rows=public_web_rows,
        )

        assert exit_code == 0
        assert "missing manifest grant" not in capsys.readouterr().err

    @pytest.mark.parametrize(
        ("role_name", "cursor_option"),
        [
            (assert_dev_ci_grants.PUBLIC_WEB_ROLE, "public_web_grant_rows"),
            (
                assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE,
                "roastpilot_agent_grant_rows",
            ),
        ],
        ids=["public-web", "roastpilot-agent"],
    )
    def test_b1c_relaxed_mode_reports_missing_operator_prerequisite(
        self, monkeypatch, capsys, role_name: str, cursor_option: str
    ) -> None:
        rows = _app_role_rows_missing(role_name, _DEV_DB)
        exit_code = self._run_main(
            monkeypatch,
            ["--allow-missing-manifest-grants"],
            **{cursor_option: rows},
        )

        assert exit_code == 1
        assert (
            f"missing manifest grant: USAGE on DATABASE {_DEV_DB} to {role_name}"
        ) in capsys.readouterr().err

    @pytest.mark.parametrize(
        ("role_name", "cursor_option"),
        [
            (assert_dev_ci_grants.PUBLIC_WEB_ROLE, "public_web_grant_rows"),
            (
                assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE,
                "roastpilot_agent_grant_rows",
            ),
        ],
        ids=["public-web", "roastpilot-agent"],
    )
    def test_b1d_relaxed_mode_fails_closed_for_empty_role_grants(
        self, monkeypatch, capsys, role_name: str, cursor_option: str
    ) -> None:
        exit_code = self._run_main(
            monkeypatch,
            ["--allow-missing-manifest-grants"],
            **{cursor_option: []},
        )

        assert exit_code == 1
        assert (
            f"missing manifest grant: USAGE on DATABASE {_DEV_DB} to {role_name}"
        ) in capsys.readouterr().err

    def test_b2b_strict_mode_reports_public_web_bootstrap_missing_grant(
        self, monkeypatch, capsys
    ) -> None:
        public_web_rows = _app_role_rows_missing(
            assert_dev_ci_grants.PUBLIC_WEB_ROLE, ".REVIEWS_BY_ROAST"
        )
        exit_code = self._run_main(
            monkeypatch,
            [],
            public_web_grant_rows=public_web_rows,
        )

        assert exit_code == 1
        assert (
            "missing manifest grant: SELECT on VIEW "
            "ROASTPILOT_DEV.APP.REVIEWS_BY_ROAST to PUBLIC_WEB"
        ) in capsys.readouterr().err

    def test_b2_strict_mode_reports_both_agent_bootstrap_missing_grants(
        self, monkeypatch, capsys
    ) -> None:
        exit_code = self._run_main(
            monkeypatch,
            [],
            roastpilot_agent_grant_rows=self._bootstrap_agent_rows(),
        )

        assert exit_code == 1
        stderr = capsys.readouterr().err
        assert (
            "missing manifest grant: USAGE on FILE_FORMAT "
            "ROASTPILOT_DEV.APP.ROAST_JSONL_FORMAT to ROASTPILOT_AGENT"
        ) in stderr
        assert (
            "missing manifest grant: USAGE on PROCEDURE "
            "ROASTPILOT_DEV.APP.LOAD_ROAST_TELEMETRY(VARCHAR, VARCHAR) "
            "to ROASTPILOT_AGENT"
        ) in stderr

    def test_b3_relaxed_mode_confirms_a_fully_compliant_corpus(
        self, monkeypatch, capsys
    ) -> None:
        exit_code = self._run_main(
            monkeypatch, ["--allow-missing-manifest-grants"]
        )

        assert exit_code == 0
        stdout = capsys.readouterr().out
        assert (
            "PUBLIC_WEB/ROASTPILOT_AGENT have no disallowed visible grants under the DEV-scoped "
            "manifest ceiling and zero future grants visible; manifest completeness was deferred "
            "to the post-deploy audit and was not verified by this run"
        ) in stdout
        assert "exactly match their manifests" not in stdout

    def test_b3b_strict_mode_confirms_exact_manifest_match(
        self, monkeypatch, capsys
    ) -> None:
        exit_code = self._run_main(monkeypatch, [])

        assert exit_code == 0
        assert (
            "PUBLIC_WEB/ROASTPILOT_AGENT exactly match their manifests with zero future grants "
            "visible"
        ) in capsys.readouterr().out

    def test_b4_no_argv_argument_remains_strict(
        self, monkeypatch, capsys
    ) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        monkeypatch.setattr(sys, "argv", ["assert_dev_ci_grants.py"])
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            roastpilot_agent_grant_rows=self._bootstrap_agent_rows(),
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(
            assert_dev_ci_grants.snowflake.connector,
            "connect",
            return_value=mock_conn,
        ):
            exit_code = assert_dev_ci_grants.main()

        assert exit_code == 1
        assert "missing manifest grant" in capsys.readouterr().err

    @pytest.mark.parametrize(
        "argv",
        [
            ["--skip-manifest"],
            ["positional"],
            ["--allow-missing-manifest-grants=1"],
            ["--allow"],
            ["--allow-missing"],
        ],
        ids=[
            "a1-old-broad-name",
            "a2-positional",
            "a3-flag-value",
            "a4-short-prefix",
            "a5-long-prefix",
        ],
    )
    def test_argument_grammar_rejects_every_non_flag_form_before_connecting(
        self, argv: list[str]
    ) -> None:
        with patch.object(
            assert_dev_ci_grants.snowflake.connector, "connect"
        ) as mock_connect:
            with pytest.raises(SystemExit) as exc_info:
                assert_dev_ci_grants.main(argv)

        assert exc_info.value.code == 2
        mock_connect.assert_not_called()

    def test_help_uses_the_module_contract_description_before_connecting(
        self, capsys
    ) -> None:
        with patch.object(
            assert_dev_ci_grants.snowflake.connector, "connect"
        ) as mock_connect:
            with pytest.raises(SystemExit) as exc_info:
                assert_dev_ci_grants.main(["--help"])

        assert exc_info.value.code == 0
        assert (
            "Asserts the DEV-scoped CI service role's grants never extend beyond"
            in capsys.readouterr().out
        )
        mock_connect.assert_not_called()

    def test_d1_incomplete_direct_audit_keeps_extra_and_suppresses_missing(
        self,
    ) -> None:
        rows = _app_role_rows_missing(
            assert_dev_ci_grants.PUBLIC_WEB_ROLE, ".REVIEWS_BY_ROAST"
        )
        rows.append(
            {
                "privilege": "SELECT",
                "granted_on": "TABLE",
                "name": "ROASTPILOT_DEV.APP.CLOUD_ROASTS",
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": "false",
            }
        )
        expected = assert_dev_ci_grants.expected_role_grants(_DEV_DB)[
            assert_dev_ci_grants.PUBLIC_WEB_ROLE
        ]
        deferred = assert_dev_ci_grants.object_manifest_role_grants(_DEV_DB)[
            assert_dev_ci_grants.PUBLIC_WEB_ROLE
        ]

        violations = assert_dev_ci_grants.find_role_manifest_violations(
            assert_dev_ci_grants.PUBLIC_WEB_ROLE,
            rows,
            expected,
            _DEV_DB,
            assert_dev_ci_grants._ALLOWED_APP_ROLE_WAREHOUSES,
            deferred_missing_grants=deferred,
        )

        assert len(violations) == 1
        assert violations[0].startswith("extra grant:")

    def test_d2_direct_audit_defaults_to_extra_and_missing(self) -> None:
        rows = _app_role_rows_missing(
            assert_dev_ci_grants.PUBLIC_WEB_ROLE, ".REVIEWS_BY_ROAST"
        )
        rows.append(
            {
                "privilege": "SELECT",
                "granted_on": "TABLE",
                "name": "ROASTPILOT_DEV.APP.CLOUD_ROASTS",
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": "false",
            }
        )
        expected = assert_dev_ci_grants.expected_role_grants(_DEV_DB)[
            assert_dev_ci_grants.PUBLIC_WEB_ROLE
        ]

        violations = assert_dev_ci_grants.find_role_manifest_violations(
            assert_dev_ci_grants.PUBLIC_WEB_ROLE,
            rows,
            expected,
            _DEV_DB,
            assert_dev_ci_grants._ALLOWED_APP_ROLE_WAREHOUSES,
        )

        assert len(violations) == 2
        assert sum(item.startswith("extra grant:") for item in violations) == 1
        assert sum(item.startswith("missing manifest grant:") for item in violations) == 1

    def test_n1_relaxed_mode_still_rejects_ci_role_boundary_violation(
        self, monkeypatch, capsys
    ) -> None:
        exit_code = self._run_main(
            monkeypatch,
            ["--allow-missing-manifest-grants"],
            grant_rows=[
                {
                    "privilege": "USAGE",
                    "granted_on": "DATABASE",
                    "name": "ROASTPILOT_PREVIEW",
                }
            ],
            roastpilot_agent_grant_rows=self._bootstrap_agent_rows(),
        )

        assert exit_code == 1
        assert "grant on ROASTPILOT_DEV_CI_ROLE outside" in capsys.readouterr().err

    def test_n2_relaxed_mode_still_rejects_public_current_grant(
        self, monkeypatch, capsys
    ) -> None:
        exit_code = self._run_main(
            monkeypatch,
            ["--allow-missing-manifest-grants"],
            public_grant_rows=[
                {
                    "privilege": "SELECT",
                    "granted_on": "TABLE",
                    "name": "ROASTPILOT_DEV.APP.CLOUD_ROASTS",
                }
            ],
            roastpilot_agent_grant_rows=self._bootstrap_agent_rows(),
        )

        assert exit_code == 1
        assert (
            "PUBLIC grant violating the DEV/account boundary"
            in capsys.readouterr().err
        )

    def test_n3_relaxed_mode_still_rejects_public_future_grant(
        self, monkeypatch, capsys
    ) -> None:
        exit_code = self._run_main(
            monkeypatch,
            ["--allow-missing-manifest-grants"],
            public_future_grant_rows=[
                {
                    "privilege": "SELECT",
                    "grant_on": "TABLE",
                    "name": "ROASTPILOT_DEV.APP",
                }
            ],
            roastpilot_agent_grant_rows=self._bootstrap_agent_rows(),
        )

        assert exit_code == 1
        assert "PUBLIC future grant visible to" in capsys.readouterr().err

    def test_n4_relaxed_mode_still_rejects_secondary_roles(
        self, monkeypatch, capsys
    ) -> None:
        exit_code = self._run_main(
            monkeypatch,
            ["--allow-missing-manifest-grants"],
            show_user_rows=[
                {"name": _CI_USER, "default_secondary_roles": '["ALL"]'}
            ],
            roastpilot_agent_grant_rows=self._bootstrap_agent_rows(),
        )

        assert exit_code == 1
        assert "DEFAULT_SECONDARY_ROLES is" in capsys.readouterr().err

    def test_n5_relaxed_mode_still_rejects_visible_database(
        self, monkeypatch, capsys
    ) -> None:
        exit_code = self._run_main(
            monkeypatch,
            ["--allow-missing-manifest-grants"],
            visible_databases=[{"name": _DEV_DB}, {"name": "ROASTPILOT_PREVIEW"}],
            roastpilot_agent_grant_rows=self._bootstrap_agent_rows(),
        )

        assert exit_code == 1
        assert "visible database beyond the DEV boundary" in capsys.readouterr().err

    def test_n5b_relaxed_mode_still_rejects_visible_warehouse(
        self, monkeypatch, capsys
    ) -> None:
        exit_code = self._run_main(
            monkeypatch,
            ["--allow-missing-manifest-grants"],
            visible_warehouses=[{"name": _DEV_WH}, {"name": "SOME_OTHER_WH"}],
            roastpilot_agent_grant_rows=self._bootstrap_agent_rows(),
        )

        assert exit_code == 1
        assert "visible warehouse beyond the DEV boundary" in capsys.readouterr().err

    def test_n6_relaxed_mode_still_rejects_malformed_public_row(
        self, monkeypatch, capsys
    ) -> None:
        exit_code = self._run_main(
            monkeypatch,
            ["--allow-missing-manifest-grants"],
            public_grant_rows=[
                {"privilege": "USAGE", "granted_on": "", "name": "ROASTPILOT_DEV"}
            ],
            roastpilot_agent_grant_rows=self._bootstrap_agent_rows(),
        )

        assert exit_code == 1
        assert (
            "PUBLIC grant violating the DEV/account boundary"
            in capsys.readouterr().err
        )

    def test_n7_relaxed_mode_still_rejects_extra_public_web_grant(
        self, monkeypatch, capsys
    ) -> None:
        public_web_rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        public_web_rows.append(
            {
                "privilege": "SELECT",
                "granted_on": "TABLE",
                "name": "ROASTPILOT_DEV.APP.CLOUD_ROASTS",
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": "false",
            }
        )
        exit_code = self._run_main(
            monkeypatch,
            ["--allow-missing-manifest-grants"],
            public_web_grant_rows=public_web_rows,
            roastpilot_agent_grant_rows=self._bootstrap_agent_rows(),
        )

        assert exit_code == 1
        assert "extra grant:" in capsys.readouterr().err

    def test_n8_relaxed_mode_rejects_byte_lookalike_without_reporting_missing(
        self, monkeypatch, capsys
    ) -> None:
        agent_rows = self._bootstrap_agent_rows()
        lookalike = next(
            row
            for row in _app_role_rows(assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE)
            if str(row["name"]).endswith(".ROAST_JSONL_FORMAT")
        )
        lookalike["name"] = "ROASTPILOT_DEV.APP.roast_jsonl_format"
        agent_rows.append(lookalike)
        exit_code = self._run_main(
            monkeypatch,
            ["--allow-missing-manifest-grants"],
            roastpilot_agent_grant_rows=agent_rows,
        )

        assert exit_code == 1
        stderr = capsys.readouterr().err
        assert "extra grant:" in stderr
        assert "missing manifest grant" not in stderr

    def test_n9_relaxed_mode_rejects_manifest_grant_with_grant_option(
        self, monkeypatch, capsys
    ) -> None:
        public_web_rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        public_web_rows[0]["grant_option"] = "true"
        exit_code = self._run_main(
            monkeypatch,
            ["--allow-missing-manifest-grants"],
            public_web_grant_rows=public_web_rows,
            roastpilot_agent_grant_rows=self._bootstrap_agent_rows(),
        )

        assert exit_code == 1
        assert "extra grant:" in capsys.readouterr().err

    def test_n10_relaxed_mode_still_rejects_app_role_future_grant(
        self, monkeypatch, capsys
    ) -> None:
        exit_code = self._run_main(
            monkeypatch,
            ["--allow-missing-manifest-grants"],
            roastpilot_agent_grant_rows=self._bootstrap_agent_rows(),
            roastpilot_agent_future_grant_rows=[
                {
                    "privilege": "SELECT",
                    "grant_on": "TABLE",
                    "name": "ROASTPILOT_DEV.APP",
                }
            ],
        )

        assert exit_code == 1
        assert "ROASTPILOT_AGENT future-grant violation" in capsys.readouterr().err

    def test_n11_relaxed_mode_still_rejects_unexpected_warehouse_grant(
        self, monkeypatch, capsys
    ) -> None:
        agent_rows = self._bootstrap_agent_rows()
        agent_rows.append(
            {
                "privilege": "USAGE",
                "granted_on": "WAREHOUSE",
                "name": "SOME_OTHER_WH",
                "grantee_name": assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE,
                "grant_option": "false",
            }
        )
        exit_code = self._run_main(
            monkeypatch,
            ["--allow-missing-manifest-grants"],
            roastpilot_agent_grant_rows=agent_rows,
        )

        assert exit_code == 1
        assert "unexpected warehouse grant" in capsys.readouterr().err

    def test_n12_relaxed_mode_still_rejects_extra_role_on_ci_user(
        self, monkeypatch, capsys
    ) -> None:
        exit_code = self._run_main(
            monkeypatch,
            ["--allow-missing-manifest-grants"],
            user_role_rows=[{"role": _DEV_ROLE}, {"role": "ACCOUNTADMIN"}],
            roastpilot_agent_grant_rows=self._bootstrap_agent_rows(),
        )

        assert exit_code == 1
        assert "unexpected role granted to" in capsys.readouterr().err

    def test_s2_strict_mode_rejects_extra_public_web_grant(
        self, monkeypatch, capsys
    ) -> None:
        public_web_rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        public_web_rows.append(
            {
                "privilege": "SELECT",
                "granted_on": "TABLE",
                "name": "ROASTPILOT_DEV.APP.CLOUD_ROASTS",
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": "false",
            }
        )
        exit_code = self._run_main(
            monkeypatch,
            [],
            public_web_grant_rows=public_web_rows,
            roastpilot_agent_grant_rows=self._bootstrap_agent_rows(),
        )

        assert exit_code == 1
        assert "extra grant:" in capsys.readouterr().err

    def test_returns_0_and_prints_confirmation_when_all_grants_are_compliant(self, monkeypatch, capsys) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}]
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn) as mock_connect:
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 0
        assert "confirmed" in capsys.readouterr().out
        # Connected with the DEV-scoped identity, not some other role/warehouse.
        _, connect_kwargs = mock_connect.call_args
        assert connect_kwargs["account"] == "HVPXLEY-EX88650"
        assert connect_kwargs["user"] == "ROASTPILOT_DEV_CI"
        assert connect_kwargs["role"] == "ROASTPILOT_DEV_CI_ROLE"
        assert connect_kwargs["warehouse"] == "DEV_CI_WH"
        mock_conn.close.assert_called_once()

    def test_returns_0_when_both_application_role_manifests_are_exact(self, monkeypatch, capsys) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}]
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 0
        stdout = capsys.readouterr().out
        assert "PUBLIC_WEB/ROASTPILOT_AGENT exactly match their manifests" in stdout

    def test_returns_1_and_prints_application_role_violation(self, monkeypatch, capsys) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        public_web_rows = _app_role_rows(assert_dev_ci_grants.PUBLIC_WEB_ROLE)
        public_web_rows.append(
            {
                "privilege": "SELECT",
                "granted_on": "TABLE",
                "name": "ROASTPILOT_DEV.APP.CLOUD_ROASTS",
                "grantee_name": assert_dev_ci_grants.PUBLIC_WEB_ROLE,
                "grant_option": "false",
            }
        )
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            public_web_grant_rows=public_web_rows,
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 1
        stderr = capsys.readouterr().err
        assert "PUBLIC_WEB manifest violation" in stderr
        assert "extra grant: SELECT on TABLE ROASTPILOT_DEV.APP.CLOUD_ROASTS" in stderr

    def test_returns_1_and_prints_roastpilot_agent_manifest_violation(
        self, monkeypatch, capsys
    ) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        agent_rows = _app_role_rows(assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE)
        agent_rows.append(
            {
                "privilege": "OWNERSHIP",
                "granted_on": "TABLE",
                "name": "ROASTPILOT_DEV.APP.CLOUD_ROASTS",
                "grantee_name": assert_dev_ci_grants.ROASTPILOT_AGENT_ROLE,
                "grant_option": "false",
            }
        )
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            roastpilot_agent_grant_rows=agent_rows,
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 1
        stderr = capsys.readouterr().err
        assert "ROASTPILOT_AGENT manifest violation" in stderr
        assert "extra grant: OWNERSHIP on TABLE ROASTPILOT_DEV.APP.CLOUD_ROASTS" in stderr

    def test_returns_1_and_prints_public_web_future_grant_violation(
        self, monkeypatch, capsys
    ) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        future_rows = [
            {"privilege": "SELECT", "grant_on": "TABLE", "name": "ROASTPILOT_DEV.APP"}
        ]
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            public_web_future_grant_rows=future_rows,
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 1
        stderr = capsys.readouterr().err
        assert "PUBLIC_WEB future-grant violation" in stderr
        assert "future grant on PUBLIC_WEB: SELECT on TABLE ROASTPILOT_DEV.APP" in stderr

    def test_returns_1_and_prints_roastpilot_agent_future_grant_violation(
        self, monkeypatch, capsys
    ) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        future_rows = [
            {"privilege": "SELECT", "grant_on": "TABLE", "name": "ROASTPILOT_DEV.APP"}
        ]
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            roastpilot_agent_future_grant_rows=future_rows,
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 1
        stderr = capsys.readouterr().err
        assert "ROASTPILOT_AGENT future-grant violation" in stderr
        assert "future grant on ROASTPILOT_AGENT: SELECT on TABLE ROASTPILOT_DEV.APP" in stderr

    def test_returns_0_for_account_default_public_grant_corpus(self, monkeypatch, capsys) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            visible_databases=[
                {"name": _DEV_DB},
                {"name": "SNOWFLAKE"},
                {"name": "SNOWFLAKE_SAMPLE_DATA"},
                {"name": "SNOWFLAKE_LEARNING_DB"},
            ],
            visible_warehouses=[
                {"name": _DEV_WH},
                {"name": "SNOWFLAKE_LEARNING_WH"},
                {"name": "SYSTEM$STREAMLIT_NOTEBOOK_WH"},
            ],
            public_grant_rows=_public_grant_corpus(),
            default_role_grant_results={"SNOWFLAKE_LEARNING_ROLE": []},
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 0
        stdout = capsys.readouterr().out
        assert "no PUBLIC current grant violates the DEV/account boundary" in stdout
        assert "no PUBLIC-granted default role directly reaches DEV" in stdout
        assert "PUBLIC holds zero future grants visible" in stdout
        mock_cursor.execute.assert_any_call("SHOW GRANTS TO ROLE SNOWFLAKE_LEARNING_ROLE")

    def test_returns_1_when_default_role_granted_to_public_reaches_dev(self, monkeypatch, capsys) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            public_grant_rows=_public_grant_corpus(),
            default_role_grant_results={
                "SNOWFLAKE_LEARNING_ROLE": [
                    {"privilege": "SELECT", "granted_on": "TABLE", "name": f"{_DEV_DB}.APP.T"}
                ]
            },
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 1
        stderr = capsys.readouterr().err
        assert "PUBLIC transitively reaches a DEV object via a default role" in stderr
        assert f"SELECT on TABLE {_DEV_DB}.APP.T" in stderr
        assert "reachable by PUBLIC via default role SNOWFLAKE_LEARNING_ROLE" in stderr

    def test_returns_1_for_dangerous_account_privilege_granted_to_public(self, monkeypatch, capsys) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            public_grant_rows=[
                {"privilege": "MANAGE GRANTS", "granted_on": "ACCOUNT", "name": "IO03393"}
            ],
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 1
        stderr = capsys.readouterr().err
        assert "MANAGE GRANTS on ACCOUNT IO03393" in stderr
        assert "PUBLIC grant violating the DEV/account boundary" in stderr

    def test_snowflake_defaults_do_not_mask_a_non_default_visible_database(self, monkeypatch, capsys) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            visible_databases=[
                {"name": _DEV_DB},
                {"name": "SNOWFLAKE"},
                {"name": "SNOWFLAKE_SAMPLE_DATA"},
                {"name": "SNOWFLAKE_LEARNING_DB"},
                {"name": "FOO_DB"},
            ],
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 1
        assert "FOO_DB" in capsys.readouterr().err

    def test_account_defaults_do_not_mask_a_public_grant_on_a_dev_owned_object(
        self, monkeypatch, capsys
    ) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            visible_databases=[
                {"name": _DEV_DB},
                {"name": "SNOWFLAKE"},
                {"name": "SNOWFLAKE_SAMPLE_DATA"},
                {"name": "SNOWFLAKE_LEARNING_DB"},
            ],
            public_grant_rows=[
                *_public_grant_corpus(),
                {
                    "privilege": "SELECT",
                    "granted_on": "TABLE",
                    "name": f"{_DEV_DB}.APP.T",
                }
            ],
            default_role_grant_results={"SNOWFLAKE_LEARNING_ROLE": []},
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 1
        stderr = capsys.readouterr().err
        assert f"SELECT on TABLE {_DEV_DB}.APP.T" in stderr
        assert "PUBLIC grant violating the DEV/account boundary" in stderr

    def test_refuses_a_role_that_is_not_a_bare_identifier_before_connecting(self, monkeypatch) -> None:
        # #58's L3. Position matters as much as the check: it must run
        # BEFORE connect(), so a hostile value never reaches a statement and
        # never opens a credentialed session in the first place.
        self._set_required_env(monkeypatch, _generate_test_pem())
        monkeypatch.setenv("SNOWFLAKE_DEV_ROLE", f"{_DEV_ROLE}; DROP TABLE T")

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect") as mock_connect:
            try:
                assert_dev_ci_grants.main([])
                raise AssertionError("expected SystemExit")
            except SystemExit as exc:
                # `startswith`, not `in`: a substring assertion still passes
                # against a CORRUPTED variable name that merely CONTAINS the
                # real one (e.g. "XXSNOWFLAKE_DEV_ROLEXX"), so it would not
                # actually pin which variable main() passed at this call
                # site. The message's full text is pinned once, in
                # TestAssertSqlIdentifierSafe -- here we only need the name.
                assert str(exc).startswith("error: SNOWFLAKE_DEV_ROLE is ")

        mock_connect.assert_not_called()

    def test_refuses_a_user_that_is_not_a_bare_identifier_before_connecting(self, monkeypatch) -> None:
        # The user is checked as well as the role -- it reaches both `SHOW
        # GRANTS TO USER <user>` and the quoted `SHOW USERS LIKE '<user>'`.
        self._set_required_env(monkeypatch, _generate_test_pem())
        monkeypatch.setenv("SNOWFLAKE_DEV_USER", "ROASTPILOT_DEV_CI' --")

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect") as mock_connect:
            try:
                assert_dev_ci_grants.main([])
                raise AssertionError("expected SystemExit")
            except SystemExit as exc:
                # Exact prefix, same reasoning as the role test above.
                assert str(exc).startswith("error: SNOWFLAKE_DEV_USER is ")

        mock_connect.assert_not_called()

    def test_disables_secondary_roles_via_a_real_sql_statement_codex_p1_round2(self, monkeypatch) -> None:
        # The exact bug this closes (Codex P1, PR #57, round 2): an earlier
        # fix passed session_parameters={"USE_SECONDARY_ROLES": "NONE"} to
        # connect() -- invalid, since USE SECONDARY ROLES is a SQL
        # statement, not a settable session parameter, so that kwarg never
        # actually disabled anything. The correct fix issues the real
        # statement via cursor.execute, before any audit query.
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}]
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn) as mock_connect:
            assert_dev_ci_grants.main([])

        # No such kwarg exists anymore -- it never worked.
        _, connect_kwargs = mock_connect.call_args
        assert "session_parameters" not in connect_kwargs

        executed_statements = [call_args.args[0] for call_args in mock_cursor.execute.call_args_list]
        assert executed_statements[0] == "USE SECONDARY ROLES NONE"
        # Issued before every audit query, not after.
        assert executed_statements[1] == f"SHOW GRANTS TO ROLE {_DEV_ROLE}"

    def test_audits_show_grants_to_role_public_and_show_grants_to_user_codex_p1_round2(
        self, monkeypatch
    ) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}]
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            assert_dev_ci_grants.main([])

        executed_statements = [call_args.args[0] for call_args in mock_cursor.execute.call_args_list]
        assert "SHOW GRANTS TO ROLE PUBLIC" in executed_statements
        assert "SHOW GRANTS TO USER ROASTPILOT_DEV_CI" in executed_statements

    def test_audits_show_future_grants_for_the_role_and_public_codex_p1_round4(
        self, monkeypatch
    ) -> None:
        # Corrects an earlier, WRONG claim that no account-wide
        # future-grants query existed for a role (Codex P1, PR #57, round
        # 4) -- SHOW FUTURE GRANTS TO ROLE is real, documented syntax.
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}]
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            assert_dev_ci_grants.main([])

        executed_statements = [call_args.args[0] for call_args in mock_cursor.execute.call_args_list]
        assert f"SHOW FUTURE GRANTS TO ROLE {_DEV_ROLE}" in executed_statements
        assert "SHOW FUTURE GRANTS TO ROLE PUBLIC" in executed_statements

    def test_audits_current_and_future_grants_for_both_application_roles(self, monkeypatch) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}]
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            assert_dev_ci_grants.main([])

        executed_statements = [call_args.args[0] for call_args in mock_cursor.execute.call_args_list]
        assert "SHOW GRANTS TO ROLE PUBLIC_WEB" in executed_statements
        assert "SHOW GRANTS TO ROLE ROASTPILOT_AGENT" in executed_statements
        assert "SHOW FUTURE GRANTS TO ROLE PUBLIC_WEB" in executed_statements
        assert "SHOW FUTURE GRANTS TO ROLE ROASTPILOT_AGENT" in executed_statements

    def test_audits_show_users_like_the_ci_user_codex_p1_round5(self, monkeypatch) -> None:
        # Codex P1, PR #57, round 5, :270 -- turns the operator's manual
        # ALTER USER ... DEFAULT_SECONDARY_ROLES = () dependency into a
        # verified precondition.
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}]
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 0
        executed_statements = [call_args.args[0] for call_args in mock_cursor.execute.call_args_list]
        assert "SHOW USERS LIKE 'ROASTPILOT_DEV_CI'" in executed_statements

    def test_returns_1_when_default_secondary_roles_is_not_verifiably_empty_codex_p1_round5(
        self, monkeypatch, capsys
    ) -> None:
        # The exact misconfiguration this check exists to catch: the
        # operator-run ALTER USER ... DEFAULT_SECONDARY_ROLES = () was
        # missing or reset (e.g. after a user re-creation).
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            show_user_rows=[{"name": _CI_USER, "default_secondary_roles": '["ALL"]'}],
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 1
        stderr = capsys.readouterr().err
        assert "DEFAULT_SECONDARY_ROLES" in stderr

    def test_returns_1_when_only_a_wildcard_lookalike_user_matches_codex_p1_round6(
        self, monkeypatch, capsys
    ) -> None:
        # The exact bug round 6 closed: SHOW USERS LIKE 'ROASTPILOT_DEV_CI'
        # can ALSO match a lookalike like ROASTPILOT0DEV0CI (LIKE's `_`
        # wildcard). If the real user's own row is absent (or the
        # lookalike's row were trusted as row[0]), this must fail closed,
        # not pass on the lookalike's compliant-looking setting.
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            show_user_rows=[{"name": "ROASTPILOT0DEV0CI", "default_secondary_roles": "[]"}],
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 1
        stderr = capsys.readouterr().err
        assert "DEFAULT_SECONDARY_ROLES" in stderr

    def test_returns_1_when_the_role_has_a_future_grant_outside_dev_codex_p1_round4(
        self, monkeypatch, capsys
    ) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            future_grant_rows=[{"privilege": "SELECT", "grant_on": "TABLE", "name": "ROASTPILOT_PREVIEW.APP"}],
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 1
        stderr = capsys.readouterr().err
        assert "ROASTPILOT_PREVIEW" in stderr
        assert "future grant" in stderr

    def test_returns_1_when_public_has_a_future_grant_inside_dev_codex_p1_round4(
        self, monkeypatch, capsys
    ) -> None:
        # The future-grant analogue of the round-3 PUBLIC-inside-boundary
        # regression: PUBLIC must hold zero future grants too, regardless
        # of boundary.
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            public_future_grant_rows=[{"privilege": "SELECT", "grant_on": "TABLE", "name": f"{_DEV_DB}.APP"}],
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 1
        stderr = capsys.readouterr().err
        assert "PUBLIC future grant" in stderr

    def test_returns_1_when_a_grant_violation_is_found(self, monkeypatch, capsys) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": "ROASTPILOT_PREVIEW"}]
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 1
        assert "ROASTPILOT_PREVIEW" in capsys.readouterr().err
        mock_conn.close.assert_called_once()

    def test_returns_1_when_an_out_of_bounds_database_is_visible_codex_p1(self, monkeypatch, capsys) -> None:
        # No SHOW GRANTS violation at all -- the boundary breach is only
        # visible via SHOW DATABASES (e.g. a future grant SHOW GRANTS TO
        # ROLE can't see). Must still fail.
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            visible_databases=[{"name": _DEV_DB}, {"name": "ROASTPILOT_PREVIEW"}],
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 1
        stderr = capsys.readouterr().err
        assert "ROASTPILOT_PREVIEW" in stderr
        assert "visible database" in stderr

    def test_returns_1_when_an_out_of_bounds_warehouse_is_visible_codex_p1(self, monkeypatch, capsys) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            visible_warehouses=[{"name": _DEV_WH}, {"name": "PREVIEW_WH"}],
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 1
        assert "PREVIEW_WH" in capsys.readouterr().err

    def test_returns_0_when_public_grant_does_not_target_a_dev_owned_object(self, monkeypatch, capsys) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            public_grant_rows=[{"privilege": "USAGE", "granted_on": "DATABASE", "name": "ROASTPILOT_PREVIEW"}],
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 0
        assert "no PUBLIC current grant violates the DEV/account boundary" in capsys.readouterr().out

    def test_returns_1_when_public_grant_targets_a_dev_owned_object(self, monkeypatch, capsys) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            public_grant_rows=[
                {"privilege": "SELECT", "granted_on": "TABLE", "name": f"{_DEV_DB}.APP.SOME_TABLE"}
            ],
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 1
        stderr = capsys.readouterr().err
        assert "SOME_TABLE" in stderr
        assert "PUBLIC grant violating the DEV/account boundary" in stderr

    def test_returns_1_when_the_user_has_an_unexpected_role_codex_p1_round2(self, monkeypatch, capsys) -> None:
        # Even with secondary roles disabled for THIS session, an extra
        # role granted to the user could activate in some OTHER session
        # (e.g. the deploy step's) unless the user-level grant is clean.
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            user_role_rows=[{"role": _DEV_ROLE}, {"role": "ACCOUNTADMIN"}],
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 1
        stderr = capsys.readouterr().err
        assert "ACCOUNTADMIN" in stderr
        assert "unexpected role" in stderr

    def test_a_public_role_grant_on_the_user_is_never_flagged_as_unexpected(self, monkeypatch, capsys) -> None:
        # PUBLIC is implicitly granted to every user and can't be revoked --
        # SHOW GRANTS TO USER legitimately lists it alongside the primary
        # role, and that must not be treated as a violation.
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            user_role_rows=[{"role": _DEV_ROLE}, {"role": "PUBLIC"}],
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main([])

        assert exit_code == 0
        assert "confirmed" in capsys.readouterr().out

    def test_raises_systemexit_before_connecting_when_the_database_var_has_drifted_codex_p2_round2(
        self, monkeypatch
    ) -> None:
        # Codex P2, PR #57, round 2: SNOWFLAKE_DEV_DATABASE drifting away
        # from the known-correct literal must fail LOUDLY and BEFORE any
        # connection attempt -- not silently audit whatever the drifted
        # value happens to point at.
        self._set_required_env(monkeypatch, _generate_test_pem())
        monkeypatch.setenv("SNOWFLAKE_DEV_DATABASE", "SOME_OTHER_DEV_DB")

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect") as mock_connect:
            try:
                assert_dev_ci_grants.main([])
                raise AssertionError("expected SystemExit")
            except SystemExit as exc:
                assert "SNOWFLAKE_DEV_DATABASE" in str(exc)

        mock_connect.assert_not_called()

    def test_raises_systemexit_before_connecting_when_the_warehouse_var_has_drifted_codex_p2_round2(
        self, monkeypatch
    ) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        monkeypatch.setenv("SNOWFLAKE_DEV_WAREHOUSE", "SOME_OTHER_WH")

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect") as mock_connect:
            try:
                assert_dev_ci_grants.main([])
                raise AssertionError("expected SystemExit")
            except SystemExit as exc:
                assert "SNOWFLAKE_DEV_WAREHOUSE" in str(exc)

        mock_connect.assert_not_called()

    def test_closes_the_connection_even_when_the_query_raises(self, monkeypatch) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = MagicMock()
        mock_cursor.execute.side_effect = RuntimeError("boom")
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            try:
                assert_dev_ci_grants.main([])
                raise AssertionError("expected the query error to propagate")
            except RuntimeError:
                pass

        mock_conn.close.assert_called_once()

    def test_raises_systemexit_for_a_missing_required_env_var(self, monkeypatch) -> None:
        monkeypatch.delenv("SNOWFLAKE_ACCOUNT", raising=False)
        try:
            assert_dev_ci_grants.main([])
            raise AssertionError("expected SystemExit")
        except SystemExit as exc:
            assert "SNOWFLAKE_ACCOUNT" in str(exc)
