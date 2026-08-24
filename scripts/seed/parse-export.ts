import { readFileSync } from "node:fs";
import { basename, join } from "node:path";

export class ExportParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportParseError";
  }
}

export interface ParsedTelemetryRow {
  session_id: string;
  monotonic_seconds: number;
  bean_temp_c: number;
  env_temp_c: number;
  heat_level_percent: number;
  fan_level_percent: number;
  cooling_on: boolean;
  recorded_at_utc: string;
}

export interface ParsedSummary {
  session_id: string;
  roaster_driver: string;
  development_time_percent: number;
  development_time_seconds: number;
  total_roast_seconds: number;
  started_at_utc: string;
  stopped_at_utc: string | null;
  first_crack_at_utc: string;
  beans_added_at_utc: string;
  beans_dropped_at_utc: string;
  metrics: {
    bean_ror_c_per_min: number;
    env_ror_c_per_min: number;
    bean_temp_delta_60s_c: number;
    env_temp_delta_60s_c: number;
    roast_elapsed_seconds: number;
  };
  first_crack_model: {
    confidence: number;
    confidence_threshold: number;
  };
}

export interface ParsedExport {
  session: string;
  summary: ParsedSummary;
  telemetry: ParsedTelemetryRow[];
}

type PlainObject = Record<string, unknown>;

const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function actualType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function fail(session: string, field: string, expected: string, value: unknown): never {
  throw new ExportParseError(
    `${session}: ${field}: expected ${expected}, got ${actualType(value)}`,
  );
}

function plainObject(
  value: unknown,
  session: string,
  field: string,
): PlainObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(session, field, "plain object", value);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(session, field, "plain object", value);
  }
  return value as PlainObject;
}

function finiteNumber(
  value: unknown,
  session: string,
  field: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(session, field, "finite number", value);
  }
  return value;
}

function boundedNumber(
  value: unknown,
  session: string,
  field: string,
  min: number,
  max: number,
): number {
  const parsed = finiteNumber(value, session, field);
  if (parsed < min || parsed > max) {
    fail(session, field, `number from ${min} to ${max}`, value);
  }
  return parsed;
}

function integerPercent(
  value: unknown,
  session: string,
  field: string,
): number {
  const parsed = finiteNumber(value, session, field);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    fail(session, field, "integer percentage from 0 to 100", value);
  }
  return parsed;
}

function boolean(value: unknown, session: string, field: string): boolean {
  if (typeof value !== "boolean") fail(session, field, "boolean", value);
  return value;
}

function nonEmptyString(
  value: unknown,
  session: string,
  field: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(session, field, "non-empty string", value);
  }
  return value;
}

function strictIso(value: unknown, session: string, field: string): string {
  if (typeof value !== "string") {
    fail(session, field, "ISO-8601 string with offset", value);
  }
  const match = ISO_WITH_OFFSET.exec(value);
  if (match === null || Number.isNaN(Date.parse(value))) {
    fail(session, field, "ISO-8601 string with offset", value);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth[month - 1] ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59 ||
    second < 0 ||
    second > 59
  ) {
    fail(session, field, "valid ISO-8601 calendar date with offset", value);
  }
  return value;
}

function strictIsoOrNull(
  value: unknown,
  session: string,
  field: string,
): string | null {
  if (value === null) return null;
  return strictIso(value, session, field);
}

export function parseTelemetryRow(
  raw: unknown,
  index: number,
  session: string,
): ParsedTelemetryRow | null {
  const prefix = `telemetry[${index}]`;
  const row = plainObject(raw, session, prefix);
  if (typeof row.type !== "string") {
    fail(session, `${prefix}.type`, "string", row.type);
  }
  if (row.type === "event") return null;
  if (row.type !== "telemetry") {
    throw new ExportParseError(
      `${session}: ${prefix}.type: unexpected discriminator`,
    );
  }

  return {
    session_id: nonEmptyString(row.session_id, session, `${prefix}.session_id`),
    monotonic_seconds: boundedNumber(
      row.monotonic_seconds,
      session,
      `${prefix}.monotonic_seconds`,
      0,
      Number.POSITIVE_INFINITY,
    ),
    bean_temp_c: finiteNumber(row.bean_temp_c, session, `${prefix}.bean_temp_c`),
    env_temp_c: finiteNumber(row.env_temp_c, session, `${prefix}.env_temp_c`),
    heat_level_percent: integerPercent(
      row.heat_level_percent,
      session,
      `${prefix}.heat_level_percent`,
    ),
    fan_level_percent: integerPercent(
      row.fan_level_percent,
      session,
      `${prefix}.fan_level_percent`,
    ),
    cooling_on: boolean(row.cooling_on, session, `${prefix}.cooling_on`),
    recorded_at_utc: strictIso(
      row.recorded_at_utc,
      session,
      `${prefix}.recorded_at_utc`,
    ),
  };
}

export function parseSummary(raw: unknown, session: string): ParsedSummary {
  const summary = plainObject(raw, session, "summary");
  const metrics = plainObject(summary.metrics, session, "metrics");
  const model = plainObject(
    summary.first_crack_model,
    session,
    "first_crack_model",
  );

  return {
    session_id: nonEmptyString(summary.session_id, session, "session_id"),
    roaster_driver: nonEmptyString(
      summary.roaster_driver,
      session,
      "roaster_driver",
    ),
    development_time_percent: boundedNumber(
      summary.development_time_percent,
      session,
      "development_time_percent",
      0,
      100,
    ),
    development_time_seconds: boundedNumber(
      summary.development_time_seconds,
      session,
      "development_time_seconds",
      0,
      Number.POSITIVE_INFINITY,
    ),
    total_roast_seconds: boundedNumber(
      summary.total_roast_seconds,
      session,
      "total_roast_seconds",
      0,
      Number.POSITIVE_INFINITY,
    ),
    started_at_utc: strictIso(summary.started_at_utc, session, "started_at_utc"),
    stopped_at_utc: strictIsoOrNull(
      summary.stopped_at_utc,
      session,
      "stopped_at_utc",
    ),
    first_crack_at_utc: strictIso(
      summary.first_crack_at_utc,
      session,
      "first_crack_at_utc",
    ),
    beans_added_at_utc: strictIso(
      summary.beans_added_at_utc,
      session,
      "beans_added_at_utc",
    ),
    beans_dropped_at_utc: strictIso(
      summary.beans_dropped_at_utc,
      session,
      "beans_dropped_at_utc",
    ),
    metrics: {
      bean_ror_c_per_min: finiteNumber(
        metrics.bean_ror_c_per_min,
        session,
        "metrics.bean_ror_c_per_min",
      ),
      env_ror_c_per_min: finiteNumber(
        metrics.env_ror_c_per_min,
        session,
        "metrics.env_ror_c_per_min",
      ),
      bean_temp_delta_60s_c: finiteNumber(
        metrics.bean_temp_delta_60s_c,
        session,
        "metrics.bean_temp_delta_60s_c",
      ),
      env_temp_delta_60s_c: finiteNumber(
        metrics.env_temp_delta_60s_c,
        session,
        "metrics.env_temp_delta_60s_c",
      ),
      roast_elapsed_seconds: boundedNumber(
        metrics.roast_elapsed_seconds,
        session,
        "metrics.roast_elapsed_seconds",
        0,
        Number.POSITIVE_INFINITY,
      ),
    },
    first_crack_model: {
      confidence: boundedNumber(
        model.confidence,
        session,
        "first_crack_model.confidence",
        0,
        1,
      ),
      confidence_threshold: boundedNumber(
        model.confidence_threshold,
        session,
        "first_crack_model.confidence_threshold",
        0,
        1,
      ),
    },
  };
}

function readRequired(path: string, filename: string, session: string): string {
  try {
    return readFileSync(join(path, filename), "utf8");
  } catch {
    throw new ExportParseError(`${session}: ${filename}: required file missing or unreadable`);
  }
}

export function parseExportDir(path: string): ParsedExport {
  const session = basename(path);
  const summaryText = readRequired(path, "summary.json", session);
  const roastText = readRequired(path, "roast.jsonl", session);

  let summaryRaw: unknown;
  try {
    summaryRaw = JSON.parse(summaryText) as unknown;
  } catch {
    throw new ExportParseError(`${session}: summary.json: malformed JSON`);
  }

  const telemetry: ParsedTelemetryRow[] = [];
  roastText.split(/\r?\n/).forEach((line, lineIndex) => {
    if (line.trim().length === 0) return;
    const lineNumber = lineIndex + 1;
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      throw new ExportParseError(
        `${session}: roast.jsonl line ${lineNumber}: malformed JSON`,
      );
    }
    const parsed = parseTelemetryRow(raw, lineNumber, session);
    if (parsed !== null) telemetry.push(parsed);
  });

  if (telemetry.length === 0) {
    throw new ExportParseError(`${session}: telemetry: expected at least one telemetry row`);
  }

  const summary = parseSummary(summaryRaw, session);
  if (telemetry.some((row) => row.session_id !== summary.session_id)) {
    throw new ExportParseError(
      `${session}: session_id: mismatch between summary and telemetry`,
    );
  }

  return { session, summary, telemetry };
}
