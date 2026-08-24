import { assertNonProdTarget } from "./prod-guard";
import {
  type SeedOutput,
  type SeedTable,
  type Violation,
  validateSeedOutput,
} from "./rules";

export type SeedExecute = (statement: {
  table: SeedTable;
  rows: readonly Record<string, unknown>[];
  target: string;
}) => Promise<void> | void;

export interface RunSeedLoadOptions {
  database: string | undefined;
  output: SeedOutput;
  now: Date;
  execute: SeedExecute;
}

export class SeedValidationError extends Error {
  readonly violations: readonly Violation[];

  constructor(violations: readonly Violation[]) {
    const examples = violations.slice(0, 3).map((violation) =>
      `${violation.table}.${violation.field}: ${violation.rule}`
    ).join("; ");
    super(
      `Seed output failed validation with ${violations.length} violation(s): ${examples}`,
    );
    this.name = "SeedValidationError";
    this.violations = violations;
  }
}

const TABLES = [
  ["cloud_roasts", "cloudRoasts"],
  ["roast_telemetry", "roastTelemetry"],
  ["roast_artifacts", "roastArtifacts"],
  ["tasting_reviews", "tastingReviews"],
  ["reference_roast_summaries", "referenceRoastSummaries"],
] as const satisfies readonly [SeedTable, keyof SeedOutput][];

function asRecords(rows: readonly object[]): Record<string, unknown>[] {
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).filter(([, value]) => value !== null),
  ));
}

export async function runSeedLoad(
  opts: RunSeedLoadOptions,
): Promise<{ target: string; rowCounts: Record<SeedTable, number> }> {
  // D-312-J: this is an offline seam whose execute adapter is currently only
  // the CLI no-op or a test spy; this slice has no live SQL client. A future
  // operator-run / #11-gated adapter must verify CURRENT_DATABASE() equals the
  // validated target before writing, because this string guard cannot bind a
  // physical connection. That live adapter also owns atomicity: it must wrap
  // all five dispatches in one transaction with rollback. Sequential dispatch
  // here is offline-only; no stateful adapter exists in this slice. After those
  // dispatches, the live adapter must also invoke recompute_reference_summary
  // for each bean-origin/roast-level group to populate proc-derived aggregates,
  // including temperature statistics; this offline seam does not invoke it.
  const target = assertNonProdTarget(opts.database);
  if (Number.isNaN(opts.now.getTime())) {
    throw new Error("runSeedLoad requires a valid now timestamp");
  }
  const violations = validateSeedOutput(opts.output, opts.now.getTime());
  if (violations.length > 0) {
    throw new SeedValidationError(violations);
  }
  const rowCounts = {} as Record<SeedTable, number>;

  for (const [table, outputKey] of TABLES) {
    const rows = asRecords(opts.output[outputKey]);
    rowCounts[table] = rows.length;
    await opts.execute({ table, rows, target });
  }

  return { target, rowCounts };
}
