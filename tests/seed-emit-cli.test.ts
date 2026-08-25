import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../scripts/seed/emit-cli";

const TEST_TMP = mkdtempSync(join(tmpdir(), "roastpilot-seed-cli-"));
const EXPECTED_TABLES = [
  "cloud_roasts",
  "roast_telemetry",
  "roast_artifacts",
  "tasting_reviews",
  "reference_roast_summaries",
];

let stdout: ReturnType<typeof vi.spyOn>;
let stderr: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
  stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());
afterAll(() => rmSync(TEST_TMP, { recursive: true }));

describe("seed emit CLI", () => {
  it("writes the validated artifact and prints a count-only summary", async () => {
    const outputPath = join(TEST_TMP, "happy.json");

    await expect(main([
      "--target", "ROASTPILOT_DEV",
      "--out", outputPath,
    ])).resolves.toBe(0);

    const artifact = JSON.parse(readFileSync(outputPath, "utf8")) as {
      target: string;
      tables: { table: string; rows: unknown[] }[];
    };
    expect(artifact.target).toBe("ROASTPILOT_DEV");
    expect(artifact.tables.map(({ table }) => table)).toEqual(EXPECTED_TABLES);
    const summary = JSON.parse(String(stdout.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(summary).toEqual({
      target: "ROASTPILOT_DEV",
      out: outputPath,
      tables: 5,
      rows: artifact.tables.reduce((total, table) => total + table.rows.length, 0),
    });
    expect(stderr).not.toHaveBeenCalled();
  });

  it("rejects a production target without writing a file", async () => {
    const outputPath = join(TEST_TMP, "prod.json");

    await expect(main([
      "--target", "ROASTPILOT",
      "--out", outputPath,
    ])).resolves.toBe(1);

    expect(existsSync(outputPath)).toBe(false);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("ROASTPILOT"));
  });

  it.each([
    ["target", ["--out", join(TEST_TMP, "missing-target.json")]],
    ["out", ["--target", "ROASTPILOT_DEV"]],
  ])("rejects a missing --%s flag without writing", async (flag, argv) => {
    const outputPath = join(TEST_TMP, `missing-${flag}.json`);

    await expect(main(argv)).resolves.toBe(1);

    expect(existsSync(outputPath)).toBe(false);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`--${flag}`));
  });

  it("rejects a space-form target flag with no following value", async () => {
    const outputPath = join(TEST_TMP, "missing-target-value.json");

    await expect(main(["--target"])).resolves.toBe(1);

    expect(existsSync(outputPath)).toBe(false);
    expect(stderr).toHaveBeenCalledWith("missing value for --target");
  });

  it("rejects a space-form target flag followed by another flag", async () => {
    const outputPath = join(TEST_TMP, "target-followed-by-flag.json");

    await expect(main(["--target", "--out", outputPath])).resolves.toBe(1);

    expect(existsSync(outputPath)).toBe(false);
    expect(stderr).toHaveBeenCalledWith("missing value for --target");
  });

  it("rejects an equals-form target flag with an empty value", async () => {
    const outputPath = join(TEST_TMP, "empty-equals-target.json");

    await expect(main(["--target=", "--out", outputPath])).resolves.toBe(1);

    expect(existsSync(outputPath)).toBe(false);
    expect(stderr).toHaveBeenCalledWith("missing value for --target");
  });

  it("accepts equals-form flags identically", async () => {
    const outputPath = join(TEST_TMP, "equals.json");

    await expect(main([
      "--target=ROASTPILOT_DEV",
      `--out=${outputPath}`,
    ])).resolves.toBe(0);

    const artifact = JSON.parse(readFileSync(outputPath, "utf8")) as {
      target: string;
      tables: unknown[];
    };
    expect(artifact).toMatchObject({ target: "ROASTPILOT_DEV" });
    expect(artifact.tables).toHaveLength(5);
    expect(stdout).toHaveBeenCalledOnce();
  });

  it("rejects an unknown flag without writing", async () => {
    const outputPath = join(TEST_TMP, "unknown.json");

    await expect(main([
      "--target", "ROASTPILOT_DEV",
      "--out", outputPath,
      "--live",
    ])).resolves.toBe(1);

    expect(existsSync(outputPath)).toBe(false);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("unknown argument: --live"));
  });
});
