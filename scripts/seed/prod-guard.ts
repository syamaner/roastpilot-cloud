export class ProdGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProdGuardError";
  }
}

export const ALLOWED_SEED_DATABASES = [
  "ROASTPILOT_PREVIEW",
  "ROASTPILOT_DEV",
] as const;

export type SeedTarget = typeof ALLOWED_SEED_DATABASES[number];

export function assertNonProdTarget(database: string | undefined): SeedTarget {
  const target = database?.trim().toUpperCase() ?? "UNDEFINED";
  if (!(ALLOWED_SEED_DATABASES as readonly string[]).includes(target)) {
    throw new ProdGuardError(`Rejected seed database target: ${target}`);
  }
  return target as SeedTarget;
}
