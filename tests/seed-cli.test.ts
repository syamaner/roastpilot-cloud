import { describe, expect, it, vi } from "vitest";
import { runSeedCli } from "../scripts/seed/cli";
import { ProdGuardError } from "../scripts/seed/prod-guard";
import {
  type SeedOutput,
  type SeedTable,
  validateSeedOutput,
} from "../scripts/seed/rules";
import type {
  CloudRoastRow,
  ReferenceRoastSummaryRow,
  RoastArtifactRow,
  RoastTelemetryRow,
  TastingReviewRow,
} from "../scripts/seed/types";

const FIXED_NOW = new Date("2026-08-24T12:00:00.000Z");
const FIXTURES_DIR = "snowflake/fixtures/m1-export";

function dispatchedOutput(
  captured: ReadonlyMap<SeedTable, readonly Record<string, unknown>[]>,
): SeedOutput {
  return {
    cloudRoasts: captured.get("cloud_roasts") as unknown as CloudRoastRow[],
    roastTelemetry: captured.get("roast_telemetry")?.map((row) => ({
      bean_temp_c: null,
      env_temp_c: null,
      heat_percent: null,
      fan_percent: null,
      ror_c_per_min: null,
      raw: null,
      ...row,
    })) as unknown as RoastTelemetryRow[],
    roastArtifacts: captured.get("roast_artifacts") as unknown as RoastArtifactRow[],
    tastingReviews: captured.get("tasting_reviews") as unknown as TastingReviewRow[],
    referenceRoastSummaries: captured.get(
      "reference_roast_summaries",
    ) as unknown as ReferenceRoastSummaryRow[],
  };
}

describe("runSeedCli", () => {
  it("uses the default fixtures and offline execute adapter", async () => {
    const result = await runSeedCli({
      database: "ROASTPILOT_PREVIEW",
      now: FIXED_NOW,
    });

    expect(result.target).toBe("ROASTPILOT_PREVIEW");
    expect(result.rowCounts.cloud_roasts).toBe(24);
    expect(result.rowCounts.reference_roast_summaries).toBe(12);
  });

  it("runs the real-fixture offline flow and dispatches valid seed output", async () => {
    const captured = new Map<SeedTable, readonly Record<string, unknown>[]>();
    const targets: string[] = [];
    const execute = vi.fn(({ table, rows, target }) => {
      captured.set(table, rows);
      targets.push(target);
    });

    const result = await runSeedCli({
      database: "ROASTPILOT_PREVIEW",
      now: FIXED_NOW,
      fixturesDir: FIXTURES_DIR,
      execute,
    });

    expect(execute).toHaveBeenCalledTimes(5);
    expect(targets).toEqual(Array(5).fill("ROASTPILOT_PREVIEW"));
    expect(result.rowCounts.cloud_roasts).toBe(24);
    expect(result.rowCounts.roast_telemetry).toBeGreaterThan(0);
    expect(result.rowCounts.roast_artifacts).toBeGreaterThan(0);
    expect(result.rowCounts.tasting_reviews).toBeGreaterThan(0);
    expect(result.rowCounts.reference_roast_summaries).toBe(12);
    expect(captured.get("cloud_roasts")?.[0]).toHaveProperty("id");
    expect(captured.get("roast_artifacts")?.[0]).not.toHaveProperty("id");
    expect(captured.get("tasting_reviews")?.[0]).not.toHaveProperty("id");
    expect(captured.get("reference_roast_summaries")?.[0]).not.toHaveProperty("id");
    expect(validateSeedOutput(dispatchedOutput(captured), FIXED_NOW.getTime()))
      .toEqual([]);
  });

  it("rejects a production target before dispatching any rows", async () => {
    const execute = vi.fn();

    await expect(runSeedCli({
      database: "ROASTPILOT_PROD",
      now: FIXED_NOW,
      fixturesDir: FIXTURES_DIR,
      execute,
    })).rejects.toBeInstanceOf(ProdGuardError);
    expect(execute).not.toHaveBeenCalled();
  });
});
