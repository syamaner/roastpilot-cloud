/**
 * F1-S6 sacrificial pipeline dry-run artifact (issue #281, Refs #9).
 *
 * Deliberately trivial and unused — exists only to exercise the factory's
 * implement -> gates -> publish pipeline end-to-end for the first time.
 */
export function dryRunSmoke(label: string): string {
  const trimmed = label.trim();
  return trimmed === "" ? "[dry-run] (empty)" : `[dry-run] ${trimmed}`;
}
