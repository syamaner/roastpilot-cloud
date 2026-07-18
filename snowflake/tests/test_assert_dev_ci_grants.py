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

    def test_empty_list_of_visible_names_is_never_a_violation(self) -> None:
        assert assert_dev_ci_grants.find_out_of_bounds_names([], _DEV_DB) == []


class TestMain:
    """main()'s own connection/query wiring, with snowflake.connector.connect
    mocked -- there is no real Snowflake credential available to test
    against (see the module's own NOTE); this verifies main() calls the
    RIGHT things with the RIGHT arguments and interprets the result
    correctly, which is what's actually testable without live
    infrastructure access.

    main() now runs THREE sequential queries (SHOW GRANTS, SHOW DATABASES,
    SHOW WAREHOUSES) against the same cursor -- mock_cursor.fetchall's
    side_effect is a LIST of three return values, one per call, in that
    order, rather than a single static return_value.
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
    ) -> MagicMock:
        mock_cursor = MagicMock()
        mock_cursor.fetchall.side_effect = [
            grant_rows,
            visible_databases if visible_databases is not None else [{"name": _DEV_DB}],
            visible_warehouses if visible_warehouses is not None else [{"name": _DEV_WH}],
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

    def test_disables_secondary_roles_for_the_session_codex_p1(self, monkeypatch) -> None:
        # The exact bug this closes (Codex P1, PR #57): without this, other
        # roles granted to the CI user could contribute privileges this
        # check never sees.
        self._set_required_env(monkeypatch, _generate_test_pem())
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": _DEV_DB}]
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn) as mock_connect:
            assert_dev_ci_grants.main()

        _, connect_kwargs = mock_connect.call_args
        assert connect_kwargs["session_parameters"] == {"USE_SECONDARY_ROLES": "NONE"}

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

    def test_checks_against_the_real_snowflake_dev_database_env_var_not_a_hardcoded_literal(
        self, monkeypatch, capsys
    ) -> None:
        # Regression guard for the single-source-of-truth fix (claude-review
        # finding, PR #57): SNOWFLAKE_DEV_DATABASE set to something OTHER
        # than the "usual" ROASTPILOT_DEV must be what main() actually
        # checks grants against -- proves this isn't secretly still
        # checking a hardcoded "ROASTPILOT_DEV" constant regardless of env.
        self._set_required_env(monkeypatch, _generate_test_pem())
        monkeypatch.setenv("SNOWFLAKE_DEV_DATABASE", "SOME_OTHER_DEV_DB")
        mock_cursor = self._mock_cursor(
            [{"privilege": "USAGE", "granted_on": "DATABASE", "name": "SOME_OTHER_DEV_DB"}],
            visible_databases=[{"name": "SOME_OTHER_DEV_DB"}],
        )
        mock_conn = MagicMock()
        mock_conn.cursor.return_value = mock_cursor

        with patch.object(assert_dev_ci_grants.snowflake.connector, "connect", return_value=mock_conn):
            exit_code = assert_dev_ci_grants.main()

        assert exit_code == 0
        assert "confirmed" in capsys.readouterr().out

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
