import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ExportParseError,
  parseExportDir,
  parseSummary,
  parseTelemetryRow,
  type ParsedSummary,
  type ParsedTelemetryRow,
} from "../scripts/seed/parse-export";

const fixtureDir = join(
  process.cwd(),
  "snowflake/fixtures/m1-export/session-1",
);
const secondFixtureDir = join(
  process.cwd(),
  "snowflake/fixtures/m1-export/session-2",
);

function fixtureLines(): unknown[] {
  return readFileSync(join(fixtureDir, "roast.jsonl"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function fixtureSummary(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(fixtureDir, "summary.json"), "utf8"),
  ) as Record<string, unknown>;
}

function telemetryFixture(): Record<string, unknown> {
  const row = fixtureLines().find(
    (value): value is Record<string, unknown> =>
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      (value as Record<string, unknown>).type === "telemetry",
  );
  if (row === undefined) throw new Error("real fixture has no telemetry row");
  return row;
}

describe("parseTelemetryRow", () => {
  it("returns a fully typed row from real telemetry", () => {
    const source = telemetryFixture();
    const parsed: ParsedTelemetryRow | null = parseTelemetryRow(
      source,
      1,
      "session-1",
    );

    expect(parsed).toEqual({
      session_id: source.session_id,
      monotonic_seconds: source.monotonic_seconds,
      bean_temp_c: source.bean_temp_c,
      env_temp_c: source.env_temp_c,
      heat_level_percent: source.heat_level_percent,
      fan_level_percent: source.fan_level_percent,
      cooling_on: source.cooling_on,
      recorded_at_utc: source.recorded_at_utc,
    });
  });

  it("filters a real event line", () => {
    const event = fixtureLines().find(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        (value as Record<string, unknown>).type === "event",
    );
    expect(parseTelemetryRow(event, 127, "session-1")).toBeNull();
  });

  it("rejects an unknown discriminator", () => {
    const injectedType = "sabotage-value";
    const parse = () =>
      parseTelemetryRow({ type: injectedType }, 3, "session-1");
    expect(parse).toThrow(ExportParseError);
    expect(parse).toThrow(/session-1: .*type/);
    let thrown: unknown;
    try {
      parse();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExportParseError);
    expect((thrown as Error).message).not.toContain(injectedType);
  });

  it("rejects a non-string or missing discriminator", () => {
    for (const row of [{ type: 123 }, {}]) {
      const parse = () => parseTelemetryRow(row, 3, "session-1");
      expect(parse).toThrow(ExportParseError);
      expect(parse).toThrow(/session-1: .*type/);
    }
  });

  it("rejects a string bean temperature and identifies its source", () => {
    expect(() =>
      parseTelemetryRow(
        { ...telemetryFixture(), bean_temp_c: "24" },
        42,
        "session-1",
      ),
    ).toThrow(/session-1: .*bean_temp_c/);
  });

  it("rejects non-finite bean temperatures", () => {
    for (const bean_temp_c of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const parse = () =>
        parseTelemetryRow(
          { ...telemetryFixture(), bean_temp_c },
          4,
          "session-1",
        );
      expect(parse).toThrow(ExportParseError);
      expect(parse).toThrow(/session-1: .*bean_temp_c/);
    }
  });

  it("rejects a missing required telemetry key", () => {
    const missingCooling = telemetryFixture();
    delete missingCooling.cooling_on;
    const parse = () => parseTelemetryRow(missingCooling, 5, "session-1");
    expect(parse).toThrow(ExportParseError);
    expect(parse).toThrow(/session-1: .*cooling_on/);
  });

  it("rejects non-plain telemetry payloads", () => {
    for (const raw of [[], 123, null, new Date()]) {
      expect(() => parseTelemetryRow(raw, 6, "session-1")).toThrow(
        ExportParseError,
      );
    }
  });

  it("rejects empty and non-string telemetry session ids", () => {
    for (const session_id of ["", 123]) {
      const parse = () =>
        parseTelemetryRow(
          { ...telemetryFixture(), session_id },
          7,
          "session-1",
        );
      expect(parse).toThrow(ExportParseError);
      expect(parse).toThrow(/session-1: .*session_id/);
    }
  });

  it.each([101, -1, 50.5])(
    "rejects invalid heat percentage %s",
    (heat_level_percent) => {
      const parse = () =>
        parseTelemetryRow(
          { ...telemetryFixture(), heat_level_percent },
          8,
          "session-1",
        );
      expect(parse).toThrow(ExportParseError);
      expect(parse).toThrow(/session-1: .*heat_level_percent/);
    },
  );

  it("accepts heat percentage boundaries", () => {
    for (const heat_level_percent of [0, 100]) {
      expect(
        parseTelemetryRow(
          { ...telemetryFixture(), heat_level_percent },
          9,
          "session-1",
        )?.heat_level_percent,
      ).toBe(heat_level_percent);
    }
  });

  it.each([101, -1, 50.5])(
    "rejects invalid fan percentage %s",
    (fan_level_percent) => {
      const parse = () =>
        parseTelemetryRow(
          { ...telemetryFixture(), fan_level_percent },
          10,
          "session-1",
        );
      expect(parse).toThrow(ExportParseError);
      expect(parse).toThrow(/session-1: .*fan_level_percent/);
    },
  );

  it("accepts fan percentage boundaries", () => {
    for (const fan_level_percent of [0, 100]) {
      expect(
        parseTelemetryRow(
          { ...telemetryFixture(), fan_level_percent },
          11,
          "session-1",
        )?.fan_level_percent,
      ).toBe(fan_level_percent);
    }
  });
});

describe("parseSummary", () => {
  it("down-projects the real summary to the closed ParsedSummary", () => {
    const parsed: ParsedSummary = parseSummary(fixtureSummary(), "session-1");

    expect(parsed.metrics).toEqual({
      bean_ror_c_per_min: -10.899,
      env_ror_c_per_min: -14.169,
      bean_temp_delta_60s_c: -10,
      env_temp_delta_60s_c: -13,
      roast_elapsed_seconds: 637.106,
    });
    expect(parsed.first_crack_model).toEqual({
      confidence: 0.906640559832312,
      confidence_threshold: 0.9,
    });
    expect(parsed.first_crack_model).not.toHaveProperty("repo_id");
    expect(parsed.first_crack_model).not.toHaveProperty("revision");
    expect(parsed.first_crack_model).not.toHaveProperty("precision");
    expect(parsed.beans_added_at_utc).toBe(
      "2026-06-07T12:09:10.189739+00:00",
    );
    expect(parsed.roaster_driver).toBe("hottop_kn8828b_2k_plus");
  });

  it("rejects a non-ISO first-crack timestamp and identifies the field", () => {
    expect(() =>
      parseSummary(
        { ...fixtureSummary(), first_crack_at_utc: "2026" },
        "session-1",
      ),
    ).toThrow(/first_crack_at_utc/);
  });

  it.each([
    ["first_crack_at_utc", "2026-02-30T12:00:00+00:00"],
    ["stopped_at_utc", "2026-04-31T00:00:00Z"],
    ["started_at_utc", "2026-06-07T25:00:00Z"],
  ])("rejects impossible calendar value in %s", (field, timestamp) => {
    const parse = () =>
      parseSummary({ ...fixtureSummary(), [field]: timestamp }, "session-1");
    expect(parse).toThrow(ExportParseError);
    expect(parse).toThrow(new RegExp(`session-1: ${field}`));
  });

  it("accepts a valid leap-day timestamp", () => {
    const parsed = parseSummary(
      { ...fixtureSummary(), started_at_utc: "2024-02-29T23:59:59Z" },
      "session-1",
    );
    expect(parsed.started_at_utc).toBe("2024-02-29T23:59:59Z");
  });

  it("accepts only null or strict ISO for the optional stop timestamp", () => {
    expect(
      parseSummary(
        { ...fixtureSummary(), stopped_at_utc: null },
        "session-2",
      ).stopped_at_utc,
    ).toBeNull();
    expect(() =>
      parseSummary(
        { ...fixtureSummary(), stopped_at_utc: 123 },
        "session-2",
      ),
    ).toThrow(/session-2: stopped_at_utc/);
  });

  it("rejects a missing or wrong-typed development percentage", () => {
    const missing = fixtureSummary();
    delete missing.development_time_percent;
    const parseMissing = () => parseSummary(missing, "session-1");
    expect(parseMissing).toThrow(ExportParseError);
    expect(parseMissing).toThrow(/session-1: development_time_percent/);
    const parseWrongType = () =>
      parseSummary(
        { ...fixtureSummary(), development_time_percent: "15.003" },
        "session-1",
      );
    expect(parseWrongType).toThrow(ExportParseError);
    expect(parseWrongType).toThrow(/session-1: development_time_percent/);
  });

  it.each([150, -0.5])(
    "rejects out-of-range development percentage %s",
    (development_time_percent) => {
      const parse = () =>
        parseSummary(
          { ...fixtureSummary(), development_time_percent },
          "session-1",
        );
      expect(parse).toThrow(ExportParseError);
      expect(parse).toThrow(/session-1: development_time_percent/);
    },
  );

  it("rejects a negative summary duration", () => {
    const parse = () =>
      parseSummary(
        { ...fixtureSummary(), total_roast_seconds: -1 },
        "session-1",
      );
    expect(parse).toThrow(ExportParseError);
    expect(parse).toThrow(/session-1: total_roast_seconds/);
  });

  it("rejects an out-of-range model confidence", () => {
    const summary = fixtureSummary();
    const model = summary.first_crack_model as Record<string, unknown>;
    const parse = () =>
      parseSummary(
        { ...summary, first_crack_model: { ...model, confidence: 1.5 } },
        "session-1",
      );
    expect(parse).toThrow(ExportParseError);
    expect(parse).toThrow(/session-1: first_crack_model\.confidence/);
  });

  it("rejects a missing or invalid beans-added timestamp", () => {
    const missing = fixtureSummary();
    delete missing.beans_added_at_utc;
    const parseMissing = () => parseSummary(missing, "session-1");
    expect(parseMissing).toThrow(ExportParseError);
    expect(parseMissing).toThrow(/session-1: beans_added_at_utc/);

    const parseInvalid = () =>
      parseSummary(
        { ...fixtureSummary(), beans_added_at_utc: "not-a-date" },
        "session-1",
      );
    expect(parseInvalid).toThrow(ExportParseError);
    expect(parseInvalid).toThrow(/session-1: beans_added_at_utc/);
  });

  it("rejects a missing or non-string roaster driver", () => {
    const missing = fixtureSummary();
    delete missing.roaster_driver;
    const parseMissing = () => parseSummary(missing, "session-1");
    expect(parseMissing).toThrow(ExportParseError);
    expect(parseMissing).toThrow(/session-1: roaster_driver/);

    const parseWrongType = () =>
      parseSummary(
        { ...fixtureSummary(), roaster_driver: 123 },
        "session-1",
      );
    expect(parseWrongType).toThrow(ExportParseError);
    expect(parseWrongType).toThrow(/session-1: roaster_driver/);
  });

  it("rejects a summary payload with a non-plain prototype", () => {
    expect(() => parseSummary(new Date(), "session-1")).toThrow(
      ExportParseError,
    );
  });

  it("tolerates an extra top-level key without returning it", () => {
    const parsed = parseSummary(
      { ...fixtureSummary(), unrelated_future_field: { arbitrary: true } },
      "session-1",
    );
    expect(parsed).not.toHaveProperty("unrelated_future_field");
    expect(Object.keys(parsed)).toEqual([
      "session_id",
      "roaster_driver",
      "development_time_percent",
      "development_time_seconds",
      "total_roast_seconds",
      "started_at_utc",
      "stopped_at_utc",
      "first_crack_at_utc",
      "beans_added_at_utc",
      "beans_dropped_at_utc",
      "metrics",
      "first_crack_model",
    ]);
  });
});

describe("parseExportDir", () => {
  it("rejects malformed JSONL with its physical line number and session", () => {
    const directory = mkdtempSync(join(tmpdir(), "malformed-session-"));
    try {
      writeFileSync(join(directory, "summary.json"), JSON.stringify(fixtureSummary()));
      writeFileSync(
        join(directory, "roast.jsonl"),
        `${JSON.stringify(telemetryFixture())}\n\nnot-json\n`,
      );
      expect(() => parseExportDir(directory)).toThrow(
        new RegExp(`${directory.split("/").at(-1)}: roast\\.jsonl line 3`),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a directory missing summary.json", () => {
    const directory = mkdtempSync(join(tmpdir(), "missing-summary-session-"));
    try {
      writeFileSync(join(directory, "roast.jsonl"), `${JSON.stringify(telemetryFixture())}\n`);
      expect(() => parseExportDir(directory)).toThrow(ExportParseError);
      expect(() => parseExportDir(directory)).toThrow(/summary\.json/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a session containing only event lines as empty telemetry", () => {
    const directory = mkdtempSync(join(tmpdir(), "empty-telemetry-session-"));
    try {
      const event = { type: "event", kind: "beans_dropped" };
      writeFileSync(join(directory, "summary.json"), JSON.stringify(fixtureSummary()));
      writeFileSync(join(directory, "roast.jsonl"), `${JSON.stringify(event)}\n`);
      const parse = () => parseExportDir(directory);
      expect(parse).toThrow(ExportParseError);
      expect(parse).toThrow(/telemetry/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed summary JSON and identifies the file", () => {
    const directory = mkdtempSync(join(tmpdir(), "malformed-summary-session-"));
    try {
      writeFileSync(join(directory, "summary.json"), "not-json");
      writeFileSync(
        join(directory, "roast.jsonl"),
        `${JSON.stringify(telemetryFixture())}\n`,
      );
      const parse = () => parseExportDir(directory);
      expect(parse).toThrow(ExportParseError);
      expect(parse).toThrow(/summary\.json/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects a summary and telemetry session_id mismatch", () => {
    const directory = mkdtempSync(join(tmpdir(), "mismatched-session-"));
    try {
      writeFileSync(join(directory, "summary.json"), JSON.stringify(fixtureSummary()));
      writeFileSync(
        join(directory, "roast.jsonl"),
        `${JSON.stringify({ ...telemetryFixture(), session_id: "different" })}\n`,
      );
      const parse = () => parseExportDir(directory);
      expect(parse).toThrow(ExportParseError);
      expect(parse).toThrow(/session_id: mismatch/);
      let thrown: unknown;
      try {
        parse();
      } catch (error) {
        thrown = error;
      }
      expect((thrown as Error).message).not.toContain("different");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("parses the real committed session end to end", () => {
    const parsed = parseExportDir(fixtureDir);
    expect(parsed.session).toBe("session-1");
    expect(parsed.telemetry.length).toBeGreaterThan(0);
    expect(parsed.summary.session_id).toBe("5eed0000000000000000000000000001");
    expect(parsed.summary.total_roast_seconds).toBe(637.106);
    expect(parsed.summary.stopped_at_utc).toBe(
      "2026-06-07T12:25:50.249395+00:00",
    );
  });

  it("parses the second real session with its null stop timestamp", () => {
    const parsed = parseExportDir(secondFixtureDir);
    expect(parsed.session).toBe("session-2");
    expect(parsed.telemetry.length).toBeGreaterThan(0);
    expect(parsed.summary.stopped_at_utc).toBeNull();
  });
});
