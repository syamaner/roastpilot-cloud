import { writeFile } from "node:fs/promises";
import { runSeedCli } from "./cli.ts";
import { createSeedJsonSink, type SeedJsonArtifact } from "./emit.ts";

export interface EmitSeedJsonOptions {
  database: string | undefined;
  now: Date;
  fixturesDir?: string;
  outputPath?: string;
}

export async function emitSeedJson(
  opts: EmitSeedJsonOptions,
): Promise<SeedJsonArtifact> {
  const sink = createSeedJsonSink();
  const result = await runSeedCli({
    database: opts.database,
    now: opts.now,
    fixturesDir: opts.fixturesDir,
    execute: sink.execute,
  });
  const artifact = sink.finalize(result.target);

  if (opts.outputPath !== undefined) {
    await writeFile(opts.outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  }
  return artifact;
}
