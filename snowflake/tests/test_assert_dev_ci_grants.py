"""Tests for assert_dev_ci_grants.py (F1-S8, issue #11, factory.md §8).

Imported via a direct sys.path insert of snowflake/ itself, same reasoning
as the other snowflake/tests/*.py files.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import assert_dev_ci_grants  # noqa: E402


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


class TestFindPublicGrants:
    """Codex P1, PR #57, round 3: PUBLIC is held to an UNCONDITIONAL
    zero-grants standard (AGENTS.md's "No grants to PUBLIC, anywhere"),
    not the boundary-aware check `find_violations`/`is_allowed_grant` give
    the primary role -- deliberately NOT reused for PUBLIC's own audit.
    """

    def test_empty_when_public_has_no_grants(self) -> None:
        assert assert_dev_ci_grants.find_public_grants([]) == []

    def test_flags_a_grant_outside_the_dev_boundary(self) -> None:
        rows = [{"privilege": "USAGE", "granted_on": "DATABASE", "name": "ROASTPILOT_PREVIEW"}]
        violations = assert_dev_ci_grants.find_public_grants(rows)
        assert len(violations) == 1
        assert "ROASTPILOT_PREVIEW" in violations[0]

    def test_flags_a_grant_even_INSIDE_the_dev_boundary_codex_p1_round3(self) -> None:
        # The exact regression this round closes: reusing the
        # boundary-aware find_violations here would wrongly ALLOW a PUBLIC
        # grant that happens to sit inside ROASTPILOT_DEV/DEV_CI_WH --
        # AGENTS.md's invariant is "no grants to PUBLIC, anywhere", full
        # stop, regardless of what's granted or where.
        rows = [{"privilege": "SELECT", "granted_on": "TABLE", "name": f"{_DEV_DB}.APP.SOME_TABLE"}]
        violations = assert_dev_ci_grants.find_public_grants(rows)
        assert len(violations) == 1
        assert "SOME_TABLE" in violations[0]

    def test_flags_multiple_grants_independently(self) -> None:
        rows = [
            {"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB},
            {"privilege": "USAGE", "granted_on": "WAREHOUSE", "name": _DEV_WH},
        ]
        assert len(assert_dev_ci_grants.find_public_grants(rows)) == 2


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


class TestMain:
    """main()'s own connection/query wiring, with snowflake.connector.connect
    mocked -- there is no real Snowflake credential available to test
    against (see the module's own NOTE); this verifies main() calls the
    RIGHT things with the RIGHT arguments and interprets the result
    correctly, which is what's actually testable without live
    infrastructure access.

    main() now issues SIX sequential statements on the same cursor: `USE
    SECONDARY ROLES NONE` (no fetchall), then SHOW GRANTS TO ROLE, SHOW
    DATABASES, SHOW WAREHOUSES, SHOW GRANTS TO ROLE PUBLIC, and SHOW GRANTS
    TO USER (each followed by a fetchall) -- mock_cursor.fetchall's
    side_effect is a LIST of five return values, one per query, in that
    order.
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
    ) -> MagicMock:
        mock_cursor = MagicMock()
        mock_cursor.fetchall.side_effect = [
            grant_rows,
            visible_databases if visible_databases is not None else [{"name": _DEV_DB}],
            visible_warehouses if visible_warehouses is not None else [{"name": _DEV_WH}],
            public_grant_rows if public_grant_rows is not None else [],
            user_role_rows if user_role_rows is not None else [{"role": _DEV_ROLE}],
        ]
        return mock_cursor

    def test_returns_0_and_prints_confirmation_when_all_grants_are_compliant(self, monkeypatch, capsys) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}]
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn) as mock_connect:
            exit_code = assert_dev_ci_grants.main()

        assert exit_code == 0
        assert "confirmed" in capsys.readouterr().out
        # Connected with the DEV-scoped identity, not some other role/warehouse.
        _, connect_kwargs = mock_connect.call_args
        assert connect_kwargs["account"] == "HVPXLEY-EX88650"
        assert connect_kwargs["user"] == "ROASTPILOT_DEV_CI"
        assert connect_kwargs["role"] == "ROASTPILOT_DEV_CI_ROLE"
        assert connect_kwargs["warehouse"] == "DEV_CI_WH"
        mock_conn.close.assert_called_once()

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
            assert_dev_ci_grants.main()

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
            assert_dev_ci_grants.main()

        executed_statements = [call_args.args[0] for call_args in mock_cursor.execute.call_args_list]
        assert "SHOW GRANTS TO ROLE PUBLIC" in executed_statements
        assert "SHOW GRANTS TO USER ROASTPILOT_DEV_CI" in executed_statements

    def test_returns_1_when_a_grant_violation_is_found(self, monkeypatch, capsys) -> None:
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": "ROASTPILOT_PREVIEW"}]
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main()

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
            exit_code = assert_dev_ci_grants.main()

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
            exit_code = assert_dev_ci_grants.main()

        assert exit_code == 1
        assert "PREVIEW_WH" in capsys.readouterr().err

    def test_returns_1_when_public_has_a_grant_outside_dev_codex_p1_round2(self, monkeypatch, capsys) -> None:
        # PUBLIC's own grants never show up in SHOW GRANTS TO ROLE
        # <primary role> -- this is the audit that closes that gap.
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}],
            public_grant_rows=[{"privilege": "USAGE", "granted_on": "DATABASE", "name": "ROASTPILOT_PREVIEW"}],
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main()

        assert exit_code == 1
        stderr = capsys.readouterr().err
        assert "ROASTPILOT_PREVIEW" in stderr
        assert "PUBLIC grant" in stderr

    def test_returns_1_when_public_has_a_grant_INSIDE_dev_codex_p1_round3(self, monkeypatch, capsys) -> None:
        # The exact regression Codex P1, PR #57, round 3 closes: a PUBLIC
        # grant on a table INSIDE ROASTPILOT_DEV must still FAIL --
        # AGENTS.md's invariant is "no grants to PUBLIC, anywhere", not
        # merely "PUBLIC stays inside the DEV boundary". An earlier version
        # of this audit reused the boundary-aware find_violations for
        # PUBLIC and would have wrongly ALLOWED this.
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
            exit_code = assert_dev_ci_grants.main()

        assert exit_code == 1
        stderr = capsys.readouterr().err
        assert "SOME_TABLE" in stderr
        assert "PUBLIC grant" in stderr

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
            exit_code = assert_dev_ci_grants.main()

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
            exit_code = assert_dev_ci_grants.main()

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
                assert_dev_ci_grants.main()
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
                assert_dev_ci_grants.main()
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
                assert_dev_ci_grants.main()
                raise AssertionError("expected the query error to propagate")
            except RuntimeError:
                pass

        mock_conn.close.assert_called_once()

    def test_raises_systemexit_for_a_missing_required_env_var(self, monkeypatch) -> None:
        monkeypatch.delenv("SNOWFLAKE_ACCOUNT", raising=False)
        try:
            assert_dev_ci_grants.main()
            raise AssertionError("expected SystemExit")
        except SystemExit as exc:
            assert "SNOWFLAKE_ACCOUNT" in str(exc)
