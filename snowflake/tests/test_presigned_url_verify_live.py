"""Contract tests for the operator-run presigned URL verifier (issue #418)."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import presigned_url_verify_live  # noqa: E402

CANNED_URL = "https://example.blob.core.windows.net/stage/object?sas=token"
TEST_RUN_ID = "41800000000000000000000000000000"


class FakeResponse:
    def __init__(self, body: bytes, status: int = 200) -> None:
        self.body = body
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc_value, _traceback) -> None:
        return None

    def read(self) -> bytes:
        return self.body


class FakeCursor:
    def __init__(
        self,
        *,
        database: str = "ROASTPILOT_DEV",
        role: str = "ROASTPILOT_AGENT",
        presigned_url: object = CANNED_URL,
        fail_on: str | None = None,
        cleanup_error_text: str = "scripted presigned URL verification failure",
        list_rows: list[tuple[object, ...]] | None = None,
    ) -> None:
        self.database = database
        self.role = role
        self.presigned_url = presigned_url
        self.fail_on = fail_on
        self.cleanup_error_text = cleanup_error_text
        self.list_rows = [] if list_rows is None else list_rows
        self.executed: list[tuple[str, tuple[object, ...] | None]] = []

    def execute(self, command: str, params=None):
        normalized = tuple(params) if params is not None else None
        self.executed.append((command, normalized))
        if self.fail_on is not None and command.startswith(self.fail_on):
            raise RuntimeError(self.cleanup_error_text)
        return self

    def fetchone(self):
        command = self.executed[-1][0]
        if command == "SELECT CURRENT_DATABASE()":
            return (self.database,)
        if command == "SELECT CURRENT_ROLE()":
            return (self.role,)
        if command.startswith("SELECT GET_PRESIGNED_URL"):
            return (self.presigned_url,)
        raise AssertionError(f"unexpected fetchone after: {command}")

    def fetchall(self):
        command = self.executed[-1][0]
        if command.startswith("LIST @app.roast_artifacts/"):
            return self.list_rows
        raise AssertionError(f"unexpected fetchall after: {command}")


class FakeConnection:
    def __init__(
        self,
        *,
        close_error_text: str | None = None,
        **cursor_options: object,
    ) -> None:
        self.fake_cursor = FakeCursor(**cursor_options)
        self.close_error_text = close_error_text
        self.closed = False

    def cursor(self):
        return self.fake_cursor

    def close(self) -> None:
        self.closed = True
        if self.close_error_text is not None:
            raise RuntimeError(self.close_error_text)


def _commands(connection: FakeConnection) -> list[str]:
    return [command for command, _ in connection.fake_cursor.executed]


@pytest.fixture(autouse=True)
def fixed_run_id(monkeypatch: pytest.MonkeyPatch) -> None:
    class FixedUuid:
        hex = TEST_RUN_ID

    monkeypatch.setattr(presigned_url_verify_live.uuid, "uuid4", FixedUuid)


def test_happy_path_full_round_trip(monkeypatch: pytest.MonkeyPatch) -> None:
    fixture_bytes = presigned_url_verify_live.FIXTURE_PATH.read_bytes()
    fetches: list[tuple[str, int]] = []

    def fake_urlopen(url: str, timeout: int) -> FakeResponse:
        fetches.append((url, timeout))
        return FakeResponse(fixture_bytes)

    monkeypatch.setattr(
        presigned_url_verify_live.urllib.request, "urlopen", fake_urlopen
    )
    connection = FakeConnection()

    assert presigned_url_verify_live.verify_live_presigned(
        connection,
        presigned_url_verify_live.FIXTURE_PATH,
        "ROASTPILOT_DEV",
    ) == len(fixture_bytes)

    commands = _commands(connection)
    expected_put = (
        f"PUT '{presigned_url_verify_live.FIXTURE_PATH.resolve().as_uri()}' "
        f"@app.roast_artifacts/{TEST_RUN_ID} "
        "AUTO_COMPRESS=FALSE OVERWRITE=TRUE"
    )
    assert commands == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_DATABASE()",
        "SELECT CURRENT_ROLE()",
        expected_put,
        "SELECT GET_PRESIGNED_URL(@app.roast_artifacts, %s, %s)",
        f"REMOVE @app.roast_artifacts/{TEST_RUN_ID}/",
        f"LIST @app.roast_artifacts/{TEST_RUN_ID}/",
    ]
    assert connection.fake_cursor.executed[4] == (
        "SELECT GET_PRESIGNED_URL(@app.roast_artifacts, %s, %s)",
        (
            f"{TEST_RUN_ID}/{presigned_url_verify_live.FIXTURE_PATH.name}",
            presigned_url_verify_live.URL_EXPIRY_SECONDS,
        ),
    )
    assert fetches == [(CANNED_URL, presigned_url_verify_live.FETCH_TIMEOUT_SECONDS)]


def test_target_rejected_before_any_cursor_call() -> None:
    connection = FakeConnection()

    with pytest.raises(
        presigned_url_verify_live.PresignedUrlVerifyError,
        match="rejected presigned URL target",
    ):
        presigned_url_verify_live.verify_live_presigned(
            connection,
            presigned_url_verify_live.FIXTURE_PATH,
            "ROASTPILOT_PREVIEW",
        )

    assert connection.fake_cursor.executed == []


@pytest.mark.parametrize(
    ("row", "expected"),
    [
        ({"VALUE": "mapping value"}, "mapping value"),
        ("not a row", None),
        ((), None),
        (None, None),
    ],
)
def test_first_value_handles_supported_and_rejected_row_shapes(
    row: object,
    expected: object,
) -> None:
    assert presigned_url_verify_live._first_value(row, "VALUE") == expected


@pytest.mark.parametrize(
    "fixture_path",
    [
        Path("/tmp/outside-fixtures.jsonl"),
        presigned_url_verify_live.FIXTURES_DIR / "bad'name.jsonl",
    ],
)
def test_fixture_path_must_be_under_fixtures_and_quote_free(
    fixture_path: Path,
) -> None:
    connection = FakeConnection()

    with pytest.raises(
        presigned_url_verify_live.PresignedUrlVerifyError,
        match="rejected presigned URL fixture path",
    ):
        presigned_url_verify_live.verify_live_presigned(
            connection,
            fixture_path,
            "ROASTPILOT_DEV",
        )

    assert connection.fake_cursor.executed == []


def test_database_mismatch_rejects_before_put_or_cleanup() -> None:
    connection = FakeConnection(database="ROASTPILOT_PROD")

    with pytest.raises(
        presigned_url_verify_live.PresignedUrlVerifyError,
        match="connected database does not match target",
    ):
        presigned_url_verify_live.verify_live_presigned(
            connection,
            presigned_url_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )

    assert _commands(connection) == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_DATABASE()",
    ]


def test_role_mismatch_rejects_before_put() -> None:
    connection = FakeConnection(role="ACCOUNTADMIN")

    with pytest.raises(
        presigned_url_verify_live.PresignedUrlVerifyError,
        match="connected role is not ROASTPILOT_AGENT",
    ):
        presigned_url_verify_live.verify_live_presigned(
            connection,
            presigned_url_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )

    assert _commands(connection) == [
        "USE SECONDARY ROLES NONE",
        "SELECT CURRENT_DATABASE()",
        "SELECT CURRENT_ROLE()",
    ]


def test_put_uses_auto_compress_false(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        presigned_url_verify_live.urllib.request,
        "urlopen",
        lambda _url, timeout: FakeResponse(
            presigned_url_verify_live.FIXTURE_PATH.read_bytes()
        ),
    )
    connection = FakeConnection()

    presigned_url_verify_live.verify_live_presigned(
        connection,
        presigned_url_verify_live.FIXTURE_PATH,
        "ROASTPILOT_DEV",
    )

    put = next(
        command for command in _commands(connection) if command.startswith("PUT ")
    )
    assert put == (
        f"PUT '{presigned_url_verify_live.FIXTURE_PATH.resolve().as_uri()}' "
        f"@app.roast_artifacts/{TEST_RUN_ID} "
        "AUTO_COMPRESS=FALSE OVERWRITE=TRUE"
    )


def test_non_https_presigned_url_rejected() -> None:
    connection = FakeConnection(presigned_url="http://example.test/object")

    with pytest.raises(
        presigned_url_verify_live.PresignedUrlVerifyError,
        match="did not use HTTPS",
    ):
        presigned_url_verify_live.verify_live_presigned(
            connection,
            presigned_url_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )

    assert _commands(connection)[-2:] == [
        f"REMOVE @app.roast_artifacts/{TEST_RUN_ID}/",
        f"LIST @app.roast_artifacts/{TEST_RUN_ID}/",
    ]


def test_missing_presigned_url_rejected() -> None:
    connection = FakeConnection(presigned_url=None)

    with pytest.raises(
        presigned_url_verify_live.PresignedUrlVerifyError,
        match="did not return a URL",
    ):
        presigned_url_verify_live.verify_live_presigned(
            connection,
            presigned_url_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )

    assert _commands(connection)[-2:] == [
        f"REMOVE @app.roast_artifacts/{TEST_RUN_ID}/",
        f"LIST @app.roast_artifacts/{TEST_RUN_ID}/",
    ]


def test_non_200_fetch_fails_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        presigned_url_verify_live.urllib.request,
        "urlopen",
        lambda _url, timeout: FakeResponse(b"unavailable", status=503),
    )
    connection = FakeConnection()

    with pytest.raises(
        presigned_url_verify_live.PresignedUrlVerifyError,
        match="HTTP status 503",
    ):
        presigned_url_verify_live.verify_live_presigned(
            connection,
            presigned_url_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )

    assert _commands(connection)[-2:] == [
        f"REMOVE @app.roast_artifacts/{TEST_RUN_ID}/",
        f"LIST @app.roast_artifacts/{TEST_RUN_ID}/",
    ]


def test_byte_mismatch_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        presigned_url_verify_live.urllib.request,
        "urlopen",
        lambda _url, timeout: FakeResponse(b"not the fixture"),
    )
    connection = FakeConnection()

    with pytest.raises(
        presigned_url_verify_live.PresignedUrlVerifyError,
        match="bytes do not match",
    ):
        presigned_url_verify_live.verify_live_presigned(
            connection,
            presigned_url_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )


def test_cleanup_runs_when_body_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    def failing_urlopen(_url: str, timeout: int) -> FakeResponse:
        raise RuntimeError("scripted fetch failure")

    monkeypatch.setattr(
        presigned_url_verify_live.urllib.request,
        "urlopen",
        failing_urlopen,
    )
    connection = FakeConnection()

    with pytest.raises(
        presigned_url_verify_live.PresignedUrlVerifyError,
        match="presigned URL fetch failed",
    ):
        presigned_url_verify_live.verify_live_presigned(
            connection,
            presigned_url_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )

    assert _commands(connection)[-2:] == [
        f"REMOVE @app.roast_artifacts/{TEST_RUN_ID}/",
        f"LIST @app.roast_artifacts/{TEST_RUN_ID}/",
    ]


@pytest.mark.parametrize(
    "fail_on",
    [
        "PUT ",
        "SELECT GET_PRESIGNED_URL",
    ],
)
def test_execute_failure_propagates_and_cleanup_is_verified(fail_on: str) -> None:
    connection = FakeConnection(fail_on=fail_on)

    with pytest.raises(
        presigned_url_verify_live.PresignedUrlVerifyError,
        match="live verification body failed",
    ):
        presigned_url_verify_live.verify_live_presigned(
            connection,
            presigned_url_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )

    commands = _commands(connection)
    failing_index = next(
        index for index, command in enumerate(commands) if command.startswith(fail_on)
    )
    assert commands[failing_index + 1 :] == [
        f"REMOVE @app.roast_artifacts/{TEST_RUN_ID}/",
        f"LIST @app.roast_artifacts/{TEST_RUN_ID}/",
    ]
    if fail_on == "PUT ":
        assert not any(
            command.startswith("SELECT GET_PRESIGNED_URL") for command in commands
        )


def test_body_error_survives_cleanup_failure(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(
        presigned_url_verify_live.urllib.request,
        "urlopen",
        lambda _url, timeout: FakeResponse(b"not the fixture"),
    )
    connection = FakeConnection(
        fail_on="REMOVE",
        cleanup_error_text=(
            "connect failed for account "
            "ab12345.eu-west-1.snowflakecomputing.com at /Users/op/.snowflake/key.p8"
        ),
    )
    monkeypatch.setattr(
        presigned_url_verify_live, "_connect", lambda _target: connection
    )

    assert presigned_url_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.splitlines() == [
        (
            "presigned URL verification failed: presigned URL bytes do not match the "
            "uploaded fixture"
        ),
        f"cleanup failed for run id {TEST_RUN_ID}: stage REMOVE cleanup failed",
    ]
    assert "snowflakecomputing.com" not in captured.err
    assert "/Users/op" not in captured.err
    assert connection.closed is True


def test_cleanup_error_surfaces_when_body_succeeds(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(
        presigned_url_verify_live.urllib.request,
        "urlopen",
        lambda _url, timeout: FakeResponse(
            presigned_url_verify_live.FIXTURE_PATH.read_bytes()
        ),
    )
    connection = FakeConnection(
        fail_on="REMOVE",
        cleanup_error_text=(
            "connect failed for account "
            "ab12345.eu-west-1.snowflakecomputing.com at /Users/op/.snowflake/key.p8"
        ),
    )
    monkeypatch.setattr(
        presigned_url_verify_live, "_connect", lambda _target: connection
    )

    assert presigned_url_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.splitlines() == [
        "presigned URL verification failed: presigned URL verification cleanup failed",
        f"cleanup failed for run id {TEST_RUN_ID}: stage REMOVE cleanup failed",
    ]
    assert "snowflakecomputing.com" not in captured.err
    assert "/Users/op" not in captured.err
    assert connection.closed is True


def test_main_surfaces_sanitised_close_failure_after_body_succeeds(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(
        presigned_url_verify_live.urllib.request,
        "urlopen",
        lambda _url, timeout: FakeResponse(
            presigned_url_verify_live.FIXTURE_PATH.read_bytes()
        ),
    )
    connection = FakeConnection(
        close_error_text=(
            "close failed at ab12345.eu-west-1.snowflakecomputing.com "
            "/Users/op/key.p8"
        )
    )
    monkeypatch.setattr(
        presigned_url_verify_live, "_connect", lambda _target: connection
    )

    assert presigned_url_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.splitlines() == [
        "presigned URL verification failed: presigned URL verification cleanup failed",
        "cleanup failed: Snowflake connection close failed",
    ]
    assert "snowflakecomputing.com" not in captured.err
    assert "/Users/op" not in captured.err
    assert connection.closed is True


def test_main_preserves_body_and_cleanup_evidence_when_close_fails(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(
        presigned_url_verify_live.urllib.request,
        "urlopen",
        lambda _url, timeout: FakeResponse(b"not the fixture"),
    )
    connection = FakeConnection(
        fail_on="REMOVE",
        cleanup_error_text="scripted cleanup failure",
        close_error_text=(
            "close failed at ab12345.eu-west-1.snowflakecomputing.com "
            "/Users/op/key.p8"
        ),
    )
    monkeypatch.setattr(
        presigned_url_verify_live, "_connect", lambda _target: connection
    )

    assert presigned_url_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.splitlines() == [
        (
            "presigned URL verification failed: presigned URL bytes do not match the "
            "uploaded fixture"
        ),
        f"cleanup failed for run id {TEST_RUN_ID}: stage REMOVE cleanup failed",
        "cleanup failed: Snowflake connection close failed",
    ]
    assert "snowflakecomputing.com" not in captured.err
    assert "/Users/op" not in captured.err
    assert connection.closed is True


def test_list_cleanup_failure_is_sanitised(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(
        presigned_url_verify_live.urllib.request,
        "urlopen",
        lambda _url, timeout: FakeResponse(
            presigned_url_verify_live.FIXTURE_PATH.read_bytes()
        ),
    )
    connection = FakeConnection(
        fail_on="LIST",
        cleanup_error_text="private host snowflakecomputing.com under /Users/op",
    )
    monkeypatch.setattr(
        presigned_url_verify_live, "_connect", lambda _target: connection
    )

    assert presigned_url_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.splitlines() == [
        "presigned URL verification failed: presigned URL verification cleanup failed",
        (
            f"cleanup failed for run id {TEST_RUN_ID}: "
            "post-REMOVE LIST cleanup failed"
        ),
    ]
    assert "snowflakecomputing.com" not in captured.err
    assert "/Users/op" not in captured.err


def test_residual_stage_rows_fail_closed_with_run_id(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(
        presigned_url_verify_live.urllib.request,
        "urlopen",
        lambda _url, timeout: FakeResponse(
            presigned_url_verify_live.FIXTURE_PATH.read_bytes()
        ),
    )
    connection = FakeConnection(list_rows=[(f"stage/{TEST_RUN_ID}/roast.jsonl",)])
    monkeypatch.setattr(
        presigned_url_verify_live, "_connect", lambda _target: connection
    )

    assert presigned_url_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1

    assert _commands(connection)[-2:] == [
        f"REMOVE @app.roast_artifacts/{TEST_RUN_ID}/",
        f"LIST @app.roast_artifacts/{TEST_RUN_ID}/",
    ]
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.splitlines() == [
        "presigned URL verification failed: presigned URL verification cleanup failed",
        (
            f"cleanup failed for run id {TEST_RUN_ID}: presigned URL cleanup "
            f"verification failed for run id {TEST_RUN_ID}: 1 residual object(s)"
        ),
    ]
    assert connection.closed is True


def test_body_error_survives_residual_cleanup_verification_failure(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr(
        presigned_url_verify_live.urllib.request,
        "urlopen",
        lambda _url, timeout: FakeResponse(b"not the fixture"),
    )
    connection = FakeConnection(list_rows=[(f"stage/{TEST_RUN_ID}/roast.jsonl",)])
    monkeypatch.setattr(
        presigned_url_verify_live, "_connect", lambda _target: connection
    )

    assert presigned_url_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1

    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err.splitlines() == [
        (
            "presigned URL verification failed: presigned URL bytes do not match the "
            "uploaded fixture"
        ),
        (
            f"cleanup failed for run id {TEST_RUN_ID}: presigned URL cleanup "
            f"verification failed for run id {TEST_RUN_ID}: 1 residual object(s)"
        ),
    ]
    assert connection.closed is True


def test_main_does_not_leak_chained_cause(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    connection = FakeConnection()

    def failing_verify(_connection, _fixture_path, _target) -> int:
        try:
            raise ValueError("private hostname snowflakecomputing.com")
        except ValueError as exc:
            raise presigned_url_verify_live.PresignedUrlVerifyError(
                "outer verification failure"
            ) from exc

    monkeypatch.setattr(
        presigned_url_verify_live, "_connect", lambda _target: connection
    )
    monkeypatch.setattr(
        presigned_url_verify_live,
        "verify_live_presigned",
        failing_verify,
    )

    assert presigned_url_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == (
        "presigned URL verification failed: outer verification failure\n"
    )
    assert "snowflakecomputing.com" not in captured.err
    assert connection.closed is True


def test_main_sanitises_an_unexpected_raw_failure(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    connection = FakeConnection()

    def failing_verify(_connection, _fixture_path, _target) -> int:
        raise OSError("underlying fetch cause at /Users/op/key.p8")

    monkeypatch.setattr(
        presigned_url_verify_live, "_connect", lambda _target: connection
    )
    monkeypatch.setattr(
        presigned_url_verify_live,
        "verify_live_presigned",
        failing_verify,
    )

    assert presigned_url_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert captured.err == (
        "presigned URL verification failed: presigned URL verification failed\n"
    )
    assert "underlying fetch cause" not in captured.err
    assert "/Users/op" not in captured.err
    assert connection.closed is True


def test_secondary_roles_disabled_before_presigned_call(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        presigned_url_verify_live.urllib.request,
        "urlopen",
        lambda _url, timeout: FakeResponse(
            presigned_url_verify_live.FIXTURE_PATH.read_bytes()
        ),
    )
    connection = FakeConnection()

    presigned_url_verify_live.verify_live_presigned(
        connection,
        presigned_url_verify_live.FIXTURE_PATH,
        "ROASTPILOT_DEV",
    )

    commands = _commands(connection)
    assert commands.index("USE SECONDARY ROLES NONE") < commands.index(
        "SELECT GET_PRESIGNED_URL(@app.roast_artifacts, %s, %s)"
    )


def test_main_connects_verifies_and_closes(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    connection = FakeConnection()
    calls: list[tuple[object, Path, str]] = []

    def fake_verify(connection_arg, fixture_path: Path, target: str) -> int:
        calls.append((connection_arg, fixture_path, target))
        return 123

    monkeypatch.setattr(
        presigned_url_verify_live, "_connect", lambda _target: connection
    )
    monkeypatch.setattr(
        presigned_url_verify_live,
        "verify_live_presigned",
        fake_verify,
    )

    assert presigned_url_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 0
    assert calls == [
        (
            connection,
            presigned_url_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )
    ]
    assert connection.closed is True
    captured = capsys.readouterr()
    assert captured.out == (
        "verified 123 presigned URL bytes in ROASTPILOT_DEV\n"
    )
    assert captured.err == ""


def test_main_connect_failure_is_sanitised_presigned(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def fail_connect(_target: str) -> None:
        raise RuntimeError(
            "account=SENTINELHOST.snowflakecomputing.com "
            "private_key=/secret/keys/agent.p8"
        )

    monkeypatch.setattr(presigned_url_verify_live, "_connect", fail_connect)

    assert presigned_url_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    captured = capsys.readouterr()
    assert "Snowflake connection or authentication failed" in captured.err
    assert "SENTINELHOST" not in captured.err
    assert "/secret/keys/agent.p8" not in captured.err


def test_main_key_read_failure_is_sanitised_presigned(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def fail_connect(_target: str) -> None:
        raise FileNotFoundError("/secret/keys/agent.p8")

    monkeypatch.setattr(presigned_url_verify_live, "_connect", fail_connect)

    assert presigned_url_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    captured = capsys.readouterr()
    assert "Snowflake connection or authentication failed" in captured.err
    assert "SENTINELHOST" not in captured.err
    assert "/secret/keys/agent.p8" not in captured.err


def test_main_connect_validation_error_keeps_detail_presigned(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    def fail_connect(_target: str) -> None:
        raise presigned_url_verify_live.PresignedUrlVerifyError(
            "missing required environment variable: SNOWFLAKE_ACCOUNT"
        )

    monkeypatch.setattr(presigned_url_verify_live, "_connect", fail_connect)

    assert presigned_url_verify_live.main(["--target", "ROASTPILOT_DEV"]) == 1
    captured = capsys.readouterr()
    assert captured.err == (
        "presigned URL verification failed: missing required environment variable: "
        "SNOWFLAKE_ACCOUNT\n"
    )
