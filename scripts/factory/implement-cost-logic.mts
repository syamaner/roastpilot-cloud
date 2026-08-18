/**
 * Pure parsing and validation for Claude implement-run cost metadata.
 *
 * The execution file is agent-influenced. Callers receive either both
 * bounded, canonical scalars or neither, and never receive a rejected raw
 * candidate that could be echoed into an Actions output or posted body.
 */

export const MAX_COST_USD = 10_000;
export const MAX_TURNS_CAP = 100_000;
export const COST_DECIMAL_PLACES = 8;

export interface ImplementCost {
  readonly costUsd: string;
  readonly numTurns: string;
}

export const UNAVAILABLE_IMPLEMENT_COST: ImplementCost = Object.freeze({
  costUsd: "",
  numTurns: "",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Formats a validated cost without ever preserving its source token. */
function formatCostUsd(value: number): string {
  const fixed = value.toFixed(COST_DECIMAL_PLACES);
  return fixed.replace(/0+$/, "").replace(/\.$/, "");
}

function validateCostNumber(value: unknown): string | null {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_COST_USD
  ) {
    return null;
  }
  return formatCostUsd(value);
}

function validateTurnsNumber(value: unknown): string | null {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_TURNS_CAP
  ) {
    return null;
  }
  return String(value);
}

/**
 * Extracts cost metadata from parsed Claude execution-file content.
 * Exactly one `type: "result"` record is required; validation is
 * all-or-nothing.
 */
export function parseImplementCost(input: unknown): ImplementCost {
  if (!Array.isArray(input)) {
    return UNAVAILABLE_IMPLEMENT_COST;
  }
  const results = input.filter(
    (entry) => isRecord(entry) && entry.type === "result",
  );
  if (results.length !== 1) {
    return UNAVAILABLE_IMPLEMENT_COST;
  }

  const result = results[0];
  const costUsd = validateCostNumber(result.total_cost_usd);
  const numTurns = validateTurnsNumber(result.num_turns);
  return costUsd !== null && numTurns !== null
    ? { costUsd, numTurns }
    : UNAVAILABLE_IMPLEMENT_COST;
}

const COST_OUTPUT_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,8})?$/;
const TURNS_OUTPUT_PATTERN = /^(?:0|[1-9][0-9]*)$/;

/**
 * Authoritatively re-validates the two job outputs in the publisher.
 * The textual grammar is closed and canonical; either malformed field
 * rejects both.
 */
export function validateImplementCostOutputs(
  costCandidate: string | undefined,
  turnsCandidate: string | undefined,
): ImplementCost | null {
  if (
    costCandidate === undefined ||
    turnsCandidate === undefined ||
    !COST_OUTPUT_PATTERN.test(costCandidate) ||
    !TURNS_OUTPUT_PATTERN.test(turnsCandidate)
  ) {
    return null;
  }

  const cost = Number(costCandidate);
  const turns = Number(turnsCandidate);
  const validatedCost = validateCostNumber(cost);
  const validatedTurns = validateTurnsNumber(turns);
  if (
    validatedCost === null ||
    validatedTurns === null ||
    validatedCost !== costCandidate ||
    validatedTurns !== turnsCandidate
  ) {
    return null;
  }
  return { costUsd: validatedCost, numTurns: validatedTurns };
}
