export const FACTORY_EVAL_ENABLED_VARIABLE = "FACTORY_EVAL_ENABLED";

/** Enables recorded evaluation only for the byte-exact affirmative value. */
export function isEvalEnabled(value: unknown): boolean {
  return value === "true";
}
