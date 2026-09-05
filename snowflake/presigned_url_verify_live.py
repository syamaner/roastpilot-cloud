#!/usr/bin/env python3
"""Operator-run live verification for presigned artifact URLs (issue #418)."""

from __future__ import annotations

import argparse
import os
import sys
import urllib.request
import uuid
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, Protocol
from urllib.parse import urlparse

SNOWFLAKE_DIR = Path(__file__).resolve().parent
FIXTURES_DIR = (SNOWFLAKE_DIR / "fixtures").resolve()
FIXTURE_PATH = SNOWFLAKE_DIR / "fixtures" / "m1-export" / "session-1" / "roast.jsonl"
ALLOWED_TARGETS = frozenset({"ROASTPILOT_DEV"})
EXPECTED_ROLE = "ROASTPILOT_AGENT"
URL_EXPIRY_SECONDS = 60
FETCH_TIMEOUT_SECONDS = 15


class Cursor(Protocol):
    def execute(self, command: str, params: Sequence[object] | None = None) -> Any: ...
    def fetchone(self) -> object: ...
    def fetchall(self) -> Sequence[Sequence[object]]: ...


class Connection(Protocol):
    def cursor(self) -> Cursor: ...
    def close(self) -> None: ...


class PresignedUrlVerifyError(RuntimeError):
    """Raised when live presigned-URL behavior differs from the contract."""

    def __init__(self, message: str) -> None:
        super().__init__(message)
        self.cleanup_failures: list[str] = []


def _validated_fixture_uri(fixture_path: Path) -> str:
    """Return a closed, quote-safe URI for the repository fixture tree."""
    resolved = fixture_path.resolve()
    if not resolved.is_relative_to(FIXTURES_DIR) or "'" in str(resolved):
        raise PresignedUrlVerifyError(
            f"rejected presigned URL fixture path: {fixture_path}"
        )
    return resolved.as_uri()


def _first_value(row: object, label: str) -> object:
    if isinstance(row, Mapping):
        return row.get(label)
    if isinstance(row, Sequence) and not isinstance(row, (str, bytes)) and row:
        return row[0]
    return None


def verify_live_presigned(
    connection: Connection,
    fixture_path: Path,
    expected_target: str,
) -> int:
    """PUT one fixture, fetch its presigned URL, and byte-compare the body."""
    if expected_target not in ALLOWED_TARGETS:
        raise PresignedUrlVerifyError(
            f"rejected presigned URL target: {expected_target!r}"
        )
    fixture_uri = _validated_fixture_uri(fixture_path)
    fixture_bytes = fixture_path.resolve().read_bytes()
    test_run_id = uuid.uuid4().hex
    cursor = connection.cursor()
    cursor.execute("USE SECONDARY ROLES NONE")
    cursor.execute("SELECT CURRENT_DATABASE()")
    if _first_value(cursor.fetchone(), "CURRENT_DATABASE()") != expected_target:
        raise PresignedUrlVerifyError("connected database does not match target")
    cursor.execute("SELECT CURRENT_ROLE()")
    if _first_value(cursor.fetchone(), "CURRENT_ROLE()") != EXPECTED_ROLE:
        raise PresignedUrlVerifyError("connected role is not ROASTPILOT_AGENT")

    body_error: PresignedUrlVerifyError | None = None
    try:
        cursor.execute(
            f"PUT '{fixture_uri}' "
            f"@app.roast_artifacts/{test_run_id} "
            "AUTO_COMPRESS=FALSE OVERWRITE=TRUE"
        )
        # The stage uses encryption=(type='SNOWFLAKE_SSE'), so a plain HTTPS GET
        # of its presigned SAS URL returns decrypted plaintext equal to the PUT
        # bytes. The client-side SNOWFLAKE_FULL default would return ciphertext
        # and break this byte comparison; that negative is documented, not
        # demonstrated, because ROASTPILOT_AGENT cannot CREATE STAGE.
        #
        # A stage path is a prefix. GET_PRESIGNED_URL therefore receives the
        # exact stored object path beneath the stage, not only the run prefix.
        object_path = f"{test_run_id}/{fixture_path.name}"
        cursor.execute(
            "SELECT GET_PRESIGNED_URL(@app.roast_artifacts, %s, %s)",
            (object_path, URL_EXPIRY_SECONDS),
        )
        presigned_url = _first_value(cursor.fetchone(), "GET_PRESIGNED_URL")
        if not isinstance(presigned_url, str):
            raise PresignedUrlVerifyError("GET_PRESIGNED_URL did not return a URL")
        if urlparse(presigned_url).scheme != "https":
            raise PresignedUrlVerifyError("presigned URL did not use HTTPS")
        try:
            with urllib.request.urlopen(
                presigned_url,
                timeout=FETCH_TIMEOUT_SECONDS,
            ) as response:
                status = response.status
                if status != 200:
                    raise PresignedUrlVerifyError(
                        f"presigned URL fetch returned HTTP status {status}"
                    )
                fetched_bytes = response.read()
        except PresignedUrlVerifyError:
            raise
        except BaseException as exc:
            raise PresignedUrlVerifyError("presigned URL fetch failed") from exc
        if fetched_bytes != fixture_bytes:
            raise PresignedUrlVerifyError(
                "presigned URL bytes do not match the uploaded fixture"
            )
        return len(fetched_bytes)
    except BaseException as exc:
        if isinstance(exc, PresignedUrlVerifyError):
            body_error = exc
            raise
        body_error = PresignedUrlVerifyError("live verification body failed")
        raise body_error from exc
    finally:
        cleanup_errors: list[PresignedUrlVerifyError] = []
        try:
            cursor.execute(f"REMOVE @app.roast_artifacts/{test_run_id}/")
        except BaseException as exc:
            cleanup_error = PresignedUrlVerifyError("stage REMOVE cleanup failed")
            cleanup_error.__cause__ = exc
            cleanup_errors.append(cleanup_error)
        else:
            try:
                cursor.execute(f"LIST @app.roast_artifacts/{test_run_id}/")
                residual_rows = cursor.fetchall()
            except BaseException as exc:
                cleanup_error = PresignedUrlVerifyError(
                    "post-REMOVE LIST cleanup failed"
                )
                cleanup_error.__cause__ = exc
                cleanup_errors.append(cleanup_error)
            else:
                if residual_rows:
                    cleanup_errors.append(
                        PresignedUrlVerifyError(
                            "presigned URL cleanup verification failed for run id "
                            f"{test_run_id}: {len(residual_rows)} residual object(s)"
                        )
                    )

        if cleanup_errors:
            if body_error is not None:
                _attach_cleanup_failures(body_error, cleanup_errors, test_run_id)
            else:
                cleanup_failure = PresignedUrlVerifyError(
                    "presigned URL verification cleanup failed"
                )
                _attach_cleanup_failures(
                    cleanup_failure,
                    cleanup_errors,
                    test_run_id,
                )
                raise cleanup_failure


def _attach_cleanup_failures(
    failure: PresignedUrlVerifyError,
    cleanup_errors: Sequence[PresignedUrlVerifyError],
    test_run_id: str | None = None,
) -> None:
    for cleanup_error in cleanup_errors:
        if test_run_id is None:
            message = f"cleanup failed: {cleanup_error}"
        else:
            message = f"cleanup failed for run id {test_run_id}: {cleanup_error}"
        failure.cleanup_failures.append(message)
        failure.add_note(message)


def _required_env(name: str) -> str:  # pragma: no cover - real operator boundary
    value = os.environ.get(name)
    if not value:
        raise PresignedUrlVerifyError(f"missing required environment variable: {name}")
    return value


def _connect(target: str) -> Connection:  # pragma: no cover - real operator boundary
    import snowflake.connector
    from assert_dev_ci_grants import load_private_key_der

    private_key_path = Path(_required_env("SNOWFLAKE_PRIVATE_KEY_FILE"))
    private_key = load_private_key_der(
        private_key_path.read_text(encoding="utf-8"),
        os.environ.get("SNOWFLAKE_PRIVATE_KEY_PASSPHRASE") or None,
    )
    return snowflake.connector.connect(
        account=_required_env("SNOWFLAKE_ACCOUNT"),
        user=_required_env("SNOWFLAKE_USER"),
        role=_required_env("SNOWFLAKE_ROLE"),
        warehouse=_required_env("SNOWFLAKE_WAREHOUSE"),
        database=target,
        private_key=private_key,
    )


def _print_failure(failure: PresignedUrlVerifyError) -> None:
    print(f"presigned URL verification failed: {failure}", file=sys.stderr)
    for cleanup_failure in failure.cleanup_failures:
        print(cleanup_failure, file=sys.stderr)


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target", required=True, choices=sorted(ALLOWED_TARGETS))
    args = parser.parse_args(argv)
    try:
        connection = _connect(args.target)
    except PresignedUrlVerifyError as exc:
        _print_failure(exc)
        return 1
    except Exception as exc:
        failure = PresignedUrlVerifyError(
            "Snowflake connection or authentication failed"
        )
        failure.__cause__ = exc
        _print_failure(failure)
        return 1
    failure: PresignedUrlVerifyError | None = None
    count = 0
    try:
        count = verify_live_presigned(connection, FIXTURE_PATH, args.target)
    except PresignedUrlVerifyError as exc:
        failure = exc
    except Exception as exc:
        failure = PresignedUrlVerifyError("presigned URL verification failed")
        failure.__cause__ = exc
    try:
        connection.close()
    except BaseException as exc:
        close_error = PresignedUrlVerifyError("Snowflake connection close failed")
        close_error.__cause__ = exc
        if failure is None:
            failure = PresignedUrlVerifyError(
                "presigned URL verification cleanup failed"
            )
        _attach_cleanup_failures(failure, (close_error,))
    if failure is not None:
        _print_failure(failure)
        return 1
    print(f"verified {count} presigned URL bytes in {args.target}")
    return 0


if __name__ == "__main__":  # pragma: no cover - script entry point
    raise SystemExit(main())
