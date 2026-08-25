import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runSeedCli } from "../scripts/seed/cli";
import { emitSeedJson } from "../scripts/seed/emit-json";
import { ProdGuardError } from "../scripts/seed/prod-guard";
import type { SeedTable } from "../scripts/seed/rules";

const FIXED_NOW = new Date("2026-08-24T12:00:00.000Z");
const FIXTURES_DIR = "snowflake/fixtures/m1-export";
const TEST_TMP = mkdtempSync(join(tmpdir(), "roastpilot-seed-"));
const EXPECTED_ORDER: SeedTable[] = [
  "cloud_roasts",
  "roast_telemetry",
  "roast_artifacts",
  "tasting_reviews",
  "reference_roast_summaries",
];

afterAll(() => rmSync(TEST_TMP, { recursive: true }));

describe("emitSeedJson", () => {
  it("emits the seam's ordered dispatch and writes the same JSON artifact", async () => {
    const dispatched: { table: SeedTable; rows: readonly Record<string, unknown>[] }[] = [];
    await runSeedCli({
      database: " roastpilot_dev ",
      now: FIXED_NOW,
      fixturesDir: FIXTURES_DIR,
      execute: ({ table, rows }) => {
        dispatched.push({ table, rows });
      },
    });
    const outputPath = join(TEST_TMP, "seed.json");

    const artifact = await emitSeedJson({
      database: " roastpilot_dev ",
      now: FIXED_NOW,
      fixturesDir: FIXTURES_DIR,
      outputPath,
    });

    expect(artifact.target).toBe("ROASTPILOT_DEV");
    expect(artifact.tables.map(({ table }) => table)).toEqual(EXPECTED_ORDER);
    expect(artifact.tables).toEqual(dispatched);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(artifact);
  });

  it("round-trips the seam's null-stripped row shapes", async () => {
    const artifact = await emitSeedJson({
      database: "ROASTPILOT_PREVIEW",
      now: FIXED_NOW,
      fixturesDir: FIXTURES_DIR,
    });
    const roundTripped = JSON.parse(JSON.stringify(artifact)) as typeof artifact;
    const rows = new Map(roundTripped.tables.map(({ table, rows }) => [table, rows]));

    expect(rows.get("cloud_roasts")?.[0]).toHaveProperty("id");
    expect(rows.get("roast_artifacts")?.[0]).not.toHaveProperty("id");
    expect(rows.get("tasting_reviews")?.[0]).not.toHaveProperty("id");
  });

  it.each([undefined, "ROASTPILOT", "ROASTPILOT_PROD"])(
    "rejects target %s without writing an artifact",
    async (database) => {
      const outputPath = join(TEST_TMP, `rejected-${database ?? "undefined"}.json`);

      await expect(emitSeedJson({
        database,
        now: FIXED_NOW,
        fixturesDir: FIXTURES_DIR,
        outputPath,
      })).rejects.toBeInstanceOf(ProdGuardError);
      expect(existsSync(outputPath)).toBe(false);
    },
  );
});
