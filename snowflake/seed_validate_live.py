#!/usr/bin/env python3
"""Read-only live validator for an offline seed JSON artifact."""
from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import sys
from collections import Counter
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Protocol

from seed_load_live import ALLOWED_TARGETS, SeedLoadError, validate_artifact


TOLERANCE = 1e-6
AGGREGATE_COLUMNS = (
    "first_crack_temp_avg_c", "first_crack_temp_stddev_c",
    "drop_temp_avg_c", "drop_temp_stddev_c",
)


class Cursor(Protocol):
    def execute(self, command: str, params: Sequence[object] | None = None) -> Any: ...
    def fetchone(self) -> object: ...
    def fetchall(self) -> Sequence[object]: ...


class Connection(Protocol):
    def cursor(self) -> Cursor: ...
    def close(self) -> None: ...


class SeedValidateError(RuntimeError):
    """Raised when live seed state violates the ratified contract."""


def _row_values(row: object, columns: Sequence[str]) -> tuple[object, ...]:
    if isinstance(row, Mapping):
        lowered = {str(key).lower(): value for key, value in row.items()}
        if any(column.lower() not in lowered for column in columns):
            raise SeedValidateError("live query returned an incomplete row")
        return tuple(lowered[column.lower()] for column in columns)
    if isinstance(row, Sequence) and not isinstance(row, (str, bytes)):
        if len(row) == len(columns):
            return tuple(row)
    raise SeedValidateError("live query returned an unexpected row shape")


def _number(value: object, label: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float, Decimal)):
        raise SeedValidateError(f"{label} must be a finite number")
    result = float(value)
    if not math.isfinite(result):
        raise SeedValidateError(f"{label} must be a finite number")
    return result


def _timestamp(value: object, label: str) -> datetime:
    if not isinstance(value, str):
        raise SeedValidateError(f"{label} must be an ISO timestamp")
    try:
        # Python 3.11 accepts Z directly; explicit normalization documents the artifact grammar.
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))  # pragma: no mutate
    except ValueError:
        raise SeedValidateError(f"{label} must be an ISO timestamp") from None
    if parsed.tzinfo is None:
        raise SeedValidateError(f"{label} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _epoch_milliseconds(value: datetime) -> int:
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    delta = value - epoch
    return ((delta.days * 86_400 + delta.seconds) * 1_000
            + delta.microseconds // 1_000)


def _offset_seconds(summary: Mapping[str, object], anchor: str) -> float | None:
    value = summary.get(anchor)
    if value is None:
        return None
    start = _timestamp(summary.get("started_at_utc"), "summary.started_at_utc")
    end = _timestamp(value, f"summary.{anchor}")
    return (_epoch_milliseconds(end) - _epoch_milliseconds(start)) / 1_000.0


def _sample(
    roast_id: object,
    telemetry: Sequence[Mapping[str, object]],
    offset_s: float | None,
    value_column: str,
) -> float | None:
    if offset_s is None:
        return None
    candidates: list[tuple[float, float, bool, float, Mapping[str, object]]] = []
    for row in telemetry:
        if row.get("roast_id") != roast_id:
            continue
        elapsed = _number(row.get("elapsed_s"), "roast_telemetry.elapsed_s")
        bean_value = row.get("bean_temp_c")
        if bean_value is None:
            # The preceding null-rank key dominates this placeholder, so its numeric value is immaterial.
            bean = 0.0  # pragma: no mutate
        else:
            bean = _number(bean_value, "roast_telemetry.bean_temp_c")
        candidates.append((abs(elapsed - offset_s), elapsed, bean_value is None, bean, row))
    if not candidates:
        return None
    selected = min(candidates, key=lambda item: item[:4])[4]
    value = selected.get(value_column)
    return None if value is None else _number(value, f"roast_telemetry.{value_column}")


def _mean_stddev(values: Sequence[float | None]) -> tuple[float | None, float | None]:
    present = [value for value in values if value is not None]
    return (
        statistics.fmean(present) if present else None,
        statistics.stdev(present) if len(present) >= 2 else None,
    )


def _derive_group(
    roasts: Sequence[Mapping[str, object]],
    telemetry: Sequence[Mapping[str, object]],
    origin: str,
    level: str,
    fc_column: str = "bean_temp_c",
    drop_column: str = "bean_temp_c",
    fc_anchor: str = "first_crack_at_utc",
) -> tuple[float | None, float | None, float | None, float | None]:
    fc_values: list[float | None] = []
    drop_values: list[float | None] = []
    for roast in roasts:
        if (roast.get("bean_origin") != origin or roast.get("roast_level") != level
                or roast.get("contributed_to_learning") is not True):
            continue
        summary = roast.get("summary")
        if not isinstance(summary, Mapping):
            raise SeedValidateError("cloud_roasts.summary must be an object")
        fc_values.append(_sample(roast.get("id"), telemetry,
                                 _offset_seconds(summary, fc_anchor), fc_column))
        drop_values.append(_sample(roast.get("id"), telemetry,
                                   _offset_seconds(summary, "beans_dropped_at_utc"),
                                   drop_column))
    return (*_mean_stddev(fc_values), *_mean_stddev(drop_values))


def _matches(actual: object, expected: float | None) -> bool:
    if actual is None or expected is None:
        return actual is None and expected is None
    try:
        # _matches intentionally collapses every numeric-validation error, making its label unobservable.
        label = "live aggregate"  # pragma: no mutate
        actual_number = _number(actual, label)  # pragma: no mutate - label-only mutations are swallowed
        return abs(actual_number - expected) <= TOLERANCE
    except SeedValidateError:
        return False


def validate_live(
    cursor: Cursor,
    artifact: object,
    expected_target: str,
    now: datetime,
) -> dict[str, object]:
    """Validate one live target using only SELECTs after session hardening."""
    try:
        tables = validate_artifact(artifact, expected_target, now)
    except SeedLoadError as exc:
        raise SeedValidateError(str(exc)) from exc
    groups = tables["reference_roast_summaries"]
    if len(groups) != 12:
        raise SeedValidateError("artifact must contain exactly 12 reference groups")

    cursor.execute("USE SECONDARY ROLES NONE")
    cursor.execute("SELECT CURRENT_DATABASE()")
    # Mapping keys are deliberately case-normalized by _row_values; case-only label mutants are equivalent.
    database = _row_values(cursor.fetchone(), ("CURRENT_DATABASE()",))[0]  # pragma: no mutate
    if database != expected_target:
        raise SeedValidateError("connected database does not match target")

    cursor.execute("SELECT count(*) FROM APP.data_quality_violations")
    # Mapping keys are deliberately case-normalized by _row_values; case-only label mutants are equivalent.
    violation_count = _row_values(cursor.fetchone(), ("COUNT(*)",))[0]  # pragma: no mutate
    if isinstance(violation_count, bool) or not isinstance(violation_count, int):
        raise SeedValidateError("data-quality count must be an integer")
    if violation_count != 0:
        raise SeedValidateError(f"data-quality violations: {violation_count}")

    artifact_keys = Counter((group["bean_origin"], group["roast_level"])
                            for group in groups)
    cursor.execute("SELECT bean_origin, roast_level FROM APP.reference_roast_summaries")
    # Mapping keys are deliberately case-normalized by _row_values; case-only label mutants are equivalent.
    live_key_columns = ("BEAN_ORIGIN", "ROAST_LEVEL")  # pragma: no mutate
    live_keys = Counter(_row_values(row, live_key_columns)
                        for row in cursor.fetchall())
    if live_keys != artifact_keys:
        raise SeedValidateError(
            "live reference summary keys do not exactly match artifact groups")

    roasts = tables["cloud_roasts"]
    telemetry = tables["roast_telemetry"]
    discriminators = {"env_column": 0, "drop_offset": 0}
    select = ("SELECT first_crack_temp_avg_c, first_crack_temp_stddev_c, "
              "drop_temp_avg_c, drop_temp_stddev_c "
              "FROM APP.reference_roast_summaries "
              "WHERE bean_origin = %s AND roast_level = %s")
    for group in groups:
        origin, level = group["bean_origin"], group["roast_level"]
        correct = _derive_group(roasts, telemetry, origin, level)
        cursor.execute(select, (origin, level))
        live = _row_values(cursor.fetchone(), AGGREGATE_COLUMNS)
        for column, actual, expected in zip(AGGREGATE_COLUMNS, live, correct):
            if not _matches(actual, expected):
                raise SeedValidateError(f"{origin}/{level} {column} mismatch")

        # The swaps are controls, not alternate expectations. A metric is a
        # discriminator only when its swapped derivation is numerically distinct
        # from the correct derivation; numerical coincidences are skipped.
        env_swap = _derive_group(roasts, telemetry, origin, level,
                                 fc_column="env_temp_c", drop_column="env_temp_c")
        drop_swap = _derive_group(roasts, telemetry, origin, level,
                                  fc_anchor="beans_dropped_at_utc")
        # These fixed two-item tuples keep the drop-offset control FC-only; wider
        # slices would be equivalent because zip stops at its shortest input.
        drop_live = live[:2]  # pragma: no mutate
        drop_correct = correct[:2]  # pragma: no mutate
        drop_fc_swap = drop_swap[:2]  # pragma: no mutate
        controls = {
            "env_column": (live, correct, env_swap),
            "drop_offset": (drop_live, drop_correct, drop_fc_swap),
        }
        for name, (actuals, expecteds, swapped) in controls.items():
            for actual, expected, wrong in zip(actuals, expecteds, swapped):
                if _matches(wrong, expected):
                    continue
                discriminators[name] += 1
                if _matches(actual, wrong):
                    raise SeedValidateError(f"{origin}/{level} {name} swap matched live")
    if any(count == 0 for count in discriminators.values()):
        raise SeedValidateError("artifact provides no distinct swap discriminator")
    return {"target": expected_target, "groups_validated": len(groups),
            "data_quality_violations": violation_count,
            "swap_discriminators": discriminators}


def run_operator_validation(
    artifact_path: Path,
    expected_target: str,
    connect: Callable[[str], Connection],
    now: datetime,
) -> dict[str, object]:
    # UTF-8 spelling/case/default mutations are equivalent for the required JSON artifact encoding.
    with artifact_path.open(encoding="utf-8") as artifact_file:  # pragma: no mutate
        artifact = json.load(artifact_file)
    try:
        validate_artifact(artifact, expected_target, now)
    except SeedLoadError as exc:
        raise SeedValidateError(str(exc)) from exc
    connection = connect(expected_target)
    try:
        return validate_live(connection.cursor(), artifact, expected_target, now)
    finally:
        connection.close()


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SeedValidateError(f"missing required environment variable: {name}")
    return value


def _connect(target: str) -> Connection:  # pragma: no cover; pragma: no mutate block - real operator boundary
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


def main(argv: Sequence[str] | None = None) -> int:  # pragma: no mutate block - CLI wrapper
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--target", required=True)
    args = parser.parse_args(argv)
    if args.target not in ALLOWED_TARGETS:
        print(f"seed validation failed: rejected seed target: {args.target!r}", file=sys.stderr)
        return 1
    try:
        result = run_operator_validation(
            args.artifact, args.target, _connect, datetime.now(timezone.utc))
    except Exception as exc:
        print(f"seed validation failed: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
