import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { generate } from "../scripts/seed/generate";
import { runSeedLoad, SeedValidationError } from "../scripts/seed/load";
import { parseExportDir } from "../scripts/seed/parse-export";
import { ProdGuardError } from "../scripts/seed/prod-guard";
import type { SeedTable } from "../scripts/seed/rules";

const FIXTURE_ROOT = new URL("../snowflake/fixtures/m1-export/", import.meta.url);
const NOW = new Date("2026-08-24T12:00:00.000Z");
const OUTPUT = generate([
  parseExportDir(fileURLToPath(new URL("session-1/", FIXTURE_ROOT))),
  parseExportDir(fileURLToPath(new URL("session-2/", FIXTURE_ROOT))),
], { now: NOW });
const EXPECTED_ORDER: SeedTable[] = [
  "cloud_roasts",
  "roast_telemetry",
  "roast_artifacts",
  "tasting_reviews",
  "reference_roast_summaries",
];

describe("runSeedLoad", () => {
  it.each(["ROASTPILOT_PREVIEW", "ROASTPILOT_DEV"])(
    "dispatches all tables parents-first to allowed target %s",
    async (database) => {
    const execute = vi.fn();
    const result = await runSeedLoad({
      database,
      output: OUTPUT,
      now: NOW,
      execute,
    });

    expect(result.target).toBe(database);
    expect(execute.mock.calls.map(([statement]) => statement.table)).toEqual(
      EXPECTED_ORDER,
    );
    expect(execute.mock.calls.every(([statement]) => statement.target === database))
      .toBe(true);
    const cloudStatement = execute.mock.calls.find(
      ([statement]) => statement.table === "cloud_roasts",
    )?.[0];
    const artifactStatement = execute.mock.calls.find(
      ([statement]) => statement.table === "roast_artifacts",
    )?.[0];
    expect(cloudStatement?.rows[0]).toHaveProperty("id");
    expect(artifactStatement?.rows[0]).not.toHaveProperty("id");
    expect(result.rowCounts).toEqual({
      cloud_roasts: OUTPUT.cloudRoasts.length,
      roast_telemetry: OUTPUT.roastTelemetry.length,
      roast_artifacts: OUTPUT.roastArtifacts.length,
      tasting_reviews: OUTPUT.tastingReviews.length,
      reference_roast_summaries: OUTPUT.referenceRoastSummaries.length,
    });
    },
  );

  it("rejects invalid output before the first dispatch", async () => {
    const execute = vi.fn();
    const invalidOutput = {
      ...OUTPUT,
      roastTelemetry: OUTPUT.roastTelemetry.map((row, index) =>
        index === 0 ? { ...row, roast_id: "orphan-roast" } : row),
    };

    await expect(runSeedLoad({
      database: "ROASTPILOT_PREVIEW",
      output: invalidOutput,
      now: NOW,
      execute,
    })).rejects.toBeInstanceOf(SeedValidationError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects an invalid validation clock before the first dispatch", async () => {
    const execute = vi.fn();

    await expect(runSeedLoad({
      database: "ROASTPILOT_PREVIEW",
      output: OUTPUT,
      now: new Date("invalid"),
      execute,
    })).rejects.toThrow("runSeedLoad requires a valid now timestamp");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["ROASTPILOT_PROD", "ROASTPILOT", undefined])(
    "rejects target %s before the first dispatch",
    async (database) => {
      const execute = vi.fn();

      await expect(runSeedLoad({ database, output: OUTPUT, now: NOW, execute }))
        .rejects.toBeInstanceOf(ProdGuardError);
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
