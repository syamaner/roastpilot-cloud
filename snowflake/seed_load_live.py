#!/usr/bin/env python3
"""Operator-run, transactional loader for the offline seed JSON artifact."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Protocol


ALLOWED_TARGETS = frozenset({"ROASTPILOT_PREVIEW", "ROASTPILOT_DEV"})
IP_RETENTION_DAYS = 30
TABLE_ORDER = (
    "cloud_roasts",
    "roast_telemetry",
    "roast_artifacts",
    "tasting_reviews",
    "reference_roast_summaries",
)

COLUMNS = {
    "cloud_roasts": (
        "id", "idempotency_key", "owner_id", "public_slug", "visibility",
        "bean_origin", "bean_varietal", "bean_weight_g", "profile_name",
        "roast_level", "summary", "operator_rating", "operator_notes",
        "contributed_to_learning", "roasted_at_utc", "created_at", "updated_at",
    ),
    "roast_telemetry": (
        "roast_id", "elapsed_s", "bean_temp_c", "env_temp_c", "heat_percent",
        "fan_percent", "ror_c_per_min", "raw",
    ),
    "roast_artifacts": (
        "id", "roast_id", "kind", "stage_path", "byte_size", "created_at",
    ),
    "tasting_reviews": (
        "id", "roast_id", "reviewer_name", "score", "aroma", "acidity",
        "sweetness", "body", "aftertaste", "brew_method", "notes",
        "submitted_ip_hash", "created_at",
    ),
    "reference_roast_summaries": (
        "id", "bean_origin", "roast_level", "roast_count", "review_count",
        "avg_rating", "first_crack_temp_avg_c", "first_crack_temp_stddev_c",
        "drop_temp_avg_c", "drop_temp_stddev_c", "development_percent_avg",
        "first_crack_time_avg_s", "total_time_avg_s", "key_patterns", "updated_at",
    ),
}


class Cursor(Protocol):
    def execute(self, command: str, params: Sequence[object] | None = None) -> Any: ...
    def fetchone(self) -> object: ...
    def fetchall(self) -> Sequence[Sequence[object]]: ...


class Connection(Protocol):
    def cursor(self) -> Cursor: ...
    def close(self) -> None: ...


class SeedLoadError(RuntimeError):
    """Raised when the closed seed-loader contract is violated."""


def validate_artifact(
    artifact: object,
    expected_target: str,
    now: datetime,
) -> dict[str, list[dict[str, object]]]:
    """Validate the closed artifact grammar without normalizing any identifier."""
    if not isinstance(expected_target, str) or expected_target not in ALLOWED_TARGETS:
        raise SeedLoadError(f"rejected seed target: {expected_target!r}")  # pragma: no mutate
    if not isinstance(artifact, dict) or set(artifact) != {"target", "tables"}:
        raise SeedLoadError("artifact must contain exactly the keys: target, tables")  # pragma: no mutate
    if artifact["target"] != expected_target:
        raise SeedLoadError("artifact target is not byte-equal to the requested target")  # pragma: no mutate
    tables = artifact["tables"]
    if not isinstance(tables, list) or len(tables) != len(TABLE_ORDER):
        raise SeedLoadError("artifact must contain exactly five ordered tables")  # pragma: no mutate

    validated: dict[str, list[dict[str, object]]] = {}
    for expected_table, entry in zip(TABLE_ORDER, tables):
        if not isinstance(entry, dict) or set(entry) != {"table", "rows"}:
            raise SeedLoadError("table entry must contain exactly table and rows")  # pragma: no mutate
        if entry["table"] != expected_table:
            raise SeedLoadError(f"expected {expected_table!r}, got {entry['table']!r}")  # pragma: no mutate
        rows = entry["rows"]
        if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
            raise SeedLoadError(f"{expected_table}.rows must be an array of objects")  # pragma: no mutate
        validated[expected_table] = rows

    roast_ids = [row.get("id") for row in validated["cloud_roasts"]]
    if not roast_ids or any(not isinstance(roast_id, str) or not roast_id for roast_id in roast_ids):
        raise SeedLoadError("cloud_roasts require non-empty explicit ids")  # pragma: no mutate
    if len(set(roast_ids)) != len(roast_ids):
        raise SeedLoadError("seeded cloud_roast ids must be distinct")  # pragma: no mutate
    seeded_roast_ids = set(roast_ids)
    for child_table in ("roast_telemetry", "roast_artifacts", "tasting_reviews"):
        if any(row.get("roast_id") not in seeded_roast_ids for row in validated[child_table]):
            raise SeedLoadError(f"{child_table} must reference seeded ids")  # pragma: no mutate

    # Per #312, hand-edited raw-IP/Fahrenheit values nested in free text or VARIANT
    # remain accepted under the producer's by-construction posture.
    for review in validated["tasting_reviews"]:
        submitted_ip_hash = review.get("submitted_ip_hash")
        if submitted_ip_hash is not None and (
            not isinstance(submitted_ip_hash, str)
            or re.fullmatch(r"[0-9a-f]{64}", submitted_ip_hash) is None
        ):
            raise SeedLoadError("submitted_ip_hash must be null or lowercase 64-hex")  # pragma: no mutate
        if submitted_ip_hash is not None:
            created_at_value = review.get("created_at")
            try:
                if not isinstance(created_at_value, str):
                    raise ValueError
                created_at = datetime.fromisoformat(created_at_value)
                if created_at.tzinfo is None:
                    raise ValueError
                created_at = created_at.astimezone(timezone.utc)  # pragma: no mutate
            except (TypeError, ValueError):
                raise SeedLoadError("an IP-hash row requires a valid parseable created_at within retention") from None  # pragma: no mutate
            if created_at > now:
                raise SeedLoadError("an IP-hash row requires created_at to be no later than now")  # pragma: no mutate
            if now - created_at >= timedelta(days=IP_RETENTION_DAYS):
                raise SeedLoadError("unpurged IP hash past the 30-day retention window must be null")  # pragma: no mutate

    summary_rows = validated["reference_roast_summaries"]
    groups = [(row.get("bean_origin"), row.get("roast_level")) for row in summary_rows]
    if any(not isinstance(origin, str) or not isinstance(level, str) or not origin or not level
           for origin, level in groups):
        raise SeedLoadError("reference groups require non-empty strings")  # pragma: no mutate
    if len(set(groups)) != len(summary_rows):
        raise SeedLoadError("reference summary groups must be unique")  # pragma: no mutate
    return validated


def _variant(value: object) -> str | None:
    return None if value is None else json.dumps(value, separators=(",", ":"))


def _params(row: Mapping[str, object], columns: Sequence[str]) -> tuple[object, ...]:
    return tuple(_variant(row.get(column)) if column in {"summary", "raw", "key_patterns"}
                 else row.get(column) for column in columns)


CLOUD_ROAST_MERGE = """MERGE INTO APP.cloud_roasts AS target
USING (SELECT %s AS id, %s AS idempotency_key, %s AS owner_id, %s AS public_slug,
              %s AS visibility, %s AS bean_origin, %s AS bean_varietal,
              %s AS bean_weight_g, %s AS profile_name, %s AS roast_level,
              PARSE_JSON(%s) AS summary, %s AS operator_rating, %s AS operator_notes,
              %s AS contributed_to_learning, %s AS roasted_at_utc, %s AS created_at,
              %s AS updated_at) AS source
ON target.idempotency_key = source.idempotency_key
WHEN MATCHED THEN UPDATE SET owner_id = source.owner_id, public_slug = source.public_slug,
  visibility = source.visibility, bean_origin = source.bean_origin,
  bean_varietal = source.bean_varietal, bean_weight_g = source.bean_weight_g,
  profile_name = source.profile_name, roast_level = source.roast_level,
  summary = source.summary, operator_rating = source.operator_rating,
  operator_notes = source.operator_notes,
  contributed_to_learning = source.contributed_to_learning,
  roasted_at_utc = source.roasted_at_utc, created_at = source.created_at,
  updated_at = source.updated_at
WHEN NOT MATCHED THEN INSERT
  (id, idempotency_key, owner_id, public_slug, visibility, bean_origin, bean_varietal,
   bean_weight_g, profile_name, roast_level, summary, operator_rating, operator_notes,
   contributed_to_learning, roasted_at_utc, created_at, updated_at)
VALUES
  (source.id, source.idempotency_key, source.owner_id, source.public_slug,
   source.visibility, source.bean_origin, source.bean_varietal, source.bean_weight_g,
   source.profile_name, source.roast_level, source.summary, source.operator_rating,
   source.operator_notes, source.contributed_to_learning, source.roasted_at_utc,
   source.created_at, source.updated_at)"""

ROAST_TELEMETRY_INSERT = """INSERT INTO APP.roast_telemetry
  (roast_id, elapsed_s, bean_temp_c, env_temp_c, heat_percent, fan_percent,
   ror_c_per_min, raw)
SELECT %s, %s, %s, %s, %s, %s, %s, PARSE_JSON(%s)"""

ROAST_ARTIFACTS_INSERT = """INSERT INTO APP.roast_artifacts
  (id, roast_id, kind, stage_path, byte_size, created_at)
SELECT COALESCE(%s, UUID_STRING()), %s, %s, %s, %s, %s"""

TASTING_REVIEWS_INSERT = """INSERT INTO APP.tasting_reviews
  (id, roast_id, reviewer_name, score, aroma, acidity, sweetness, body, aftertaste,
   brew_method, notes, submitted_ip_hash, created_at)
SELECT COALESCE(%s, UUID_STRING()), %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s"""

REFERENCE_SUMMARY_MERGE = """MERGE INTO APP.reference_roast_summaries AS target
USING (SELECT COALESCE(%s, UUID_STRING()) AS id, %s AS bean_origin, %s AS roast_level,
              %s AS roast_count, %s AS review_count, %s AS avg_rating,
              %s AS first_crack_temp_avg_c, %s AS first_crack_temp_stddev_c,
              %s AS drop_temp_avg_c, %s AS drop_temp_stddev_c,
              %s AS development_percent_avg, %s AS first_crack_time_avg_s,
              %s AS total_time_avg_s, PARSE_JSON(%s) AS key_patterns,
              %s AS updated_at) AS source
ON target.bean_origin = source.bean_origin AND target.roast_level = source.roast_level
WHEN MATCHED THEN UPDATE SET roast_count = source.roast_count,
  review_count = source.review_count, avg_rating = source.avg_rating,
  first_crack_temp_avg_c = source.first_crack_temp_avg_c,
  first_crack_temp_stddev_c = source.first_crack_temp_stddev_c,
  drop_temp_avg_c = source.drop_temp_avg_c,
  drop_temp_stddev_c = source.drop_temp_stddev_c,
  development_percent_avg = source.development_percent_avg,
  first_crack_time_avg_s = source.first_crack_time_avg_s,
  total_time_avg_s = source.total_time_avg_s, key_patterns = source.key_patterns,
  updated_at = source.updated_at
WHEN NOT MATCHED THEN INSERT
  (id, bean_origin, roast_level, roast_count, review_count, avg_rating,
   first_crack_temp_avg_c, first_crack_temp_stddev_c, drop_temp_avg_c,
   drop_temp_stddev_c, development_percent_avg, first_crack_time_avg_s,
   total_time_avg_s, key_patterns, updated_at)
VALUES
  (source.id, source.bean_origin, source.roast_level, source.roast_count,
   source.review_count, source.avg_rating, source.first_crack_temp_avg_c,
   source.first_crack_temp_stddev_c, source.drop_temp_avg_c,
   source.drop_temp_stddev_c, source.development_percent_avg,
   source.first_crack_time_avg_s, source.total_time_avg_s, source.key_patterns,
   source.updated_at)"""

CHILD_INSERTS = {
    "roast_telemetry": ROAST_TELEMETRY_INSERT,
    "roast_artifacts": ROAST_ARTIFACTS_INSERT,
    "tasting_reviews": TASTING_REVIEWS_INSERT,
}


def _current_database(cursor: Cursor) -> object:
    row = cursor.fetchone()
    if isinstance(row, Mapping):
        return row.get("CURRENT_DATABASE()")
    if isinstance(row, Sequence) and not isinstance(row, (str, bytes)) and row:
        return row[0]
    return None


def load_seed(
    connection: Connection,
    artifact: object,
    expected_target: str,
    now: datetime,
) -> dict[str, int]:
    """Load a validated artifact using one injectable connection transaction."""
    tables = validate_artifact(artifact, expected_target, now)
    cursor = connection.cursor()
    try:
        cursor.execute("USE SECONDARY ROLES NONE")
        cursor.execute("SELECT CURRENT_DATABASE()")
        if _current_database(cursor) != expected_target:
            raise SeedLoadError("connected database does not match target")  # pragma: no mutate

        cursor.execute("BEGIN")
        for row in tables["cloud_roasts"]:
            cursor.execute(CLOUD_ROAST_MERGE, _params(row, COLUMNS["cloud_roasts"]))

        idempotency_keys = tuple(row.get("idempotency_key") for row in tables["cloud_roasts"])
        key_placeholders = ", ".join(["%s"] * len(idempotency_keys))
        cursor.execute(
            f"SELECT idempotency_key, id FROM APP.cloud_roasts "
            f"WHERE idempotency_key IN ({key_placeholders})",
            idempotency_keys,
        )
        persisted_ids = {key: roast_id for key, roast_id in cursor.fetchall()}
        if any(persisted_ids.get(row.get("idempotency_key")) != row["id"]
               for row in tables["cloud_roasts"]):
            raise SeedLoadError("persisted cloud_roast id does not match artifact")  # pragma: no mutate

        roast_ids = tuple(row["id"] for row in tables["cloud_roasts"])
        delete_placeholders = ", ".join(["%s"] * len(roast_ids))
        for table in ("roast_telemetry", "roast_artifacts", "tasting_reviews"):
            cursor.execute(
                f"DELETE FROM APP.{table} WHERE roast_id IN ({delete_placeholders})",
                roast_ids,
            )
            for row in tables[table]:
                cursor.execute(CHILD_INSERTS[table], _params(row, COLUMNS[table]))

        loaded_groups: list[tuple[object, object]] = []
        for row in tables["reference_roast_summaries"]:
            cursor.execute(
                REFERENCE_SUMMARY_MERGE,
                _params(row, COLUMNS["reference_roast_summaries"]),
            )
            loaded_groups.append((row["bean_origin"], row["roast_level"]))

        groups = [(row["bean_origin"], row["roast_level"])
                  for row in tables["reference_roast_summaries"]]
        if set(groups) != set(loaded_groups):
            raise SeedLoadError("recompute groups do not match loaded rows")  # pragma: no mutate
        for bean_origin, roast_level in groups:
            cursor.execute(
                "CALL APP.recompute_reference_summary(%s, %s)",
                (bean_origin, roast_level),
            )
        cursor.execute("COMMIT")
    except BaseException:
        cursor.execute("ROLLBACK")
        raise
    return {table: len(rows) for table, rows in tables.items()}


def run_operator_load(
    artifact_path: Path,
    expected_target: str,
    connect: Callable[[str], Connection],
    now: datetime,
) -> dict[str, int]:
    """Read and validate the artifact before invoking the connection factory."""
    with artifact_path.open(encoding="utf-8") as artifact_file:  # pragma: no mutate
        artifact = json.load(artifact_file)
    validate_artifact(artifact, expected_target, now)
    connection = connect(expected_target)
    try:
        return load_seed(connection, artifact, expected_target, now)
    finally:
        connection.close()


def _required_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise SeedLoadError(f"missing required environment variable: {name}")  # pragma: no mutate
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
    try:
        counts = run_operator_load(
            args.artifact,
            args.target,
            _connect,
            datetime.now(timezone.utc),
        )
    except SeedLoadError as exc:
        print(f"seed load failed: {exc}", file=sys.stderr)
        return 1
    except Exception:
        print(
            "seed load failed: an unexpected error occurred "
            "(details withheld from public output)",
            file=sys.stderr,
        )
        return 1
    print(json.dumps({"target": args.target, "row_counts": counts}, sort_keys=True))
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
