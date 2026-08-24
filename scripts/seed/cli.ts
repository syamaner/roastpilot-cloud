// This module exposes runSeedCli, the offline/dry-run seed flow exercised by
// tests. A runnable CLI wrapper and live Snowflake execute adapter are deferred
// to the future operator-run / #11-gated live-adapter slice (D-312-H/D-312-J).
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate } from "./generate";
import { runSeedLoad, type SeedExecute } from "./load";
import { parseExportDir } from "./parse-export";
import type { SeedTable } from "./rules";

export interface RunSeedCliOptions {
  database: string | undefined;
  now: Date;
  execute?: SeedExecute;
  fixturesDir?: string;
}

const DEFAULT_FIXTURES_DIR = fileURLToPath(
  new URL("../../snowflake/fixtures/m1-export/", import.meta.url),
);

export async function runSeedCli(
  opts: RunSeedCliOptions,
): Promise<{ target: string; rowCounts: Record<SeedTable, number> }> {
  const fixturesDir = resolve(opts.fixturesDir ?? DEFAULT_FIXTURES_DIR);
  const parsedExports = ["session-1", "session-2"].map((session) =>
    parseExportDir(join(fixturesDir, session)),
  );
  const output = generate(parsedExports, { now: opts.now });

  return runSeedLoad({
    database: opts.database,
    output,
    now: opts.now,
    execute: opts.execute ?? (() => undefined),
  });
}
