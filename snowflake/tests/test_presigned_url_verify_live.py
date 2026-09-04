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
        list_rows: list[tuple[object, ...]] | None = None,
    ) -> None:
        self.database = database
        self.role = role
        self.presigned_url = presigned_url
        self.fail_on = fail_on
        self.list_rows = [] if list_rows is None else list_rows
        self.executed: list[tuple[str, tuple[object, ...] | None]] = []

    def execute(self, command: str, params=None):
        normalized = tuple(params) if params is not None else None
        self.executed.append((command, normalized))
        if self.fail_on is not None and command.startswith(self.fail_on):
            raise RuntimeError("scripted presigned URL verification failure")
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
    def __init__(self, **cursor_options: object) -> None:
        self.fake_cursor = FakeCursor(**cursor_options)
        self.closed = False

    def cursor(self):
        return self.fake_cursor

    def close(self) -> None:
        self.closed = True


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
        RuntimeError,
        match="scripted presigned URL verification failure",
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
) -> None:
    monkeypatch.setattr(
        presigned_url_verify_live.urllib.request,
        "urlopen",
        lambda _url, timeout: FakeResponse(b"not the fixture"),
    )
    connection = FakeConnection(fail_on="REMOVE")

    with pytest.raises(
        presigned_url_verify_live.PresignedUrlVerifyError,
        match="bytes do not match",
    ) as raised:
        presigned_url_verify_live.verify_live_presigned(
            connection,
            presigned_url_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )

    assert raised.value.__notes__ == [
        "cleanup failed: RuntimeError('scripted presigned URL verification failure')"
    ]


def test_cleanup_error_surfaces_when_body_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        presigned_url_verify_live.urllib.request,
        "urlopen",
        lambda _url, timeout: FakeResponse(
            presigned_url_verify_live.FIXTURE_PATH.read_bytes()
        ),
    )
    connection = FakeConnection(fail_on="REMOVE")

    with pytest.raises(
        RuntimeError,
        match="scripted presigned URL verification failure",
    ):
        presigned_url_verify_live.verify_live_presigned(
            connection,
            presigned_url_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )


def test_residual_stage_rows_fail_closed_with_run_id(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        presigned_url_verify_live.urllib.request,
        "urlopen",
        lambda _url, timeout: FakeResponse(
            presigned_url_verify_live.FIXTURE_PATH.read_bytes()
        ),
    )
    connection = FakeConnection(list_rows=[(f"stage/{TEST_RUN_ID}/roast.jsonl",)])

    with pytest.raises(
        presigned_url_verify_live.PresignedUrlVerifyError,
        match=rf"run id {TEST_RUN_ID}: 1 residual object",
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


def test_body_error_survives_residual_cleanup_verification_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        presigned_url_verify_live.urllib.request,
        "urlopen",
        lambda _url, timeout: FakeResponse(b"not the fixture"),
    )
    connection = FakeConnection(list_rows=[(f"stage/{TEST_RUN_ID}/roast.jsonl",)])

    with pytest.raises(
        presigned_url_verify_live.PresignedUrlVerifyError,
        match="bytes do not match",
    ) as raised:
        presigned_url_verify_live.verify_live_presigned(
            connection,
            presigned_url_verify_live.FIXTURE_PATH,
            "ROASTPILOT_DEV",
        )

    assert len(raised.value.__notes__) == 1
    assert f"run id {TEST_RUN_ID}: 1 residual object" in raised.value.__notes__[0]


def test_main_prints_chained_cause(
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    connection = FakeConnection()

    def failing_verify(_connection, _fixture_path, _target) -> int:
        try:
            raise OSError("underlying fetch cause")
        except OSError as exc:
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
    assert "outer verification failure" in captured.err
    assert "underlying fetch cause" in captured.err
    assert "direct cause" in captured.err
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
    assert capsys.readouterr().out == (
        "verified 123 presigned URL bytes in ROASTPILOT_DEV\n"
    )
