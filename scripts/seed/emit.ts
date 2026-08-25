import type { SeedExecute } from "./load.ts";
import type { SeedTarget } from "./prod-guard.ts";
import type { SeedTable } from "./rules.ts";

export interface SeedJsonArtifact {
  target: SeedTarget;
  tables: { table: SeedTable; rows: Record<string, unknown>[] }[];
}

export function createSeedJsonSink(): {
  execute: SeedExecute;
  finalize: (target: SeedTarget) => SeedJsonArtifact;
} {
  const tables: SeedJsonArtifact["tables"] = [];

  return {
    execute: ({ table, rows }) => {
      tables.push({ table, rows: [...rows] });
    },
    finalize: (target) => ({ target, tables }),
  };
}
