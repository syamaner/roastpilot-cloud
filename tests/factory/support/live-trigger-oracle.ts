import { expect } from "vitest";

/**
 * Shared, FOLD-AWARE Codex-trigger oracle for the factory test suites (#168).
 *
 * A live `@…codex` surviving into a body the privileged publisher POSTs can
 * start a Codex review whose clean verdict the merge policy trusts, so every
 * sanitiser test asserts its output can no longer read as a trigger. Before
 * #168 each suite kept its OWN ASCII-only oracle (`/[@＠]\s*codex/iu`), which
 * would green-light a homoglyph trigger such as `@ｃodex` (U+FF43) the module's
 * old ASCII matcher also missed — an oracle blind to the exact bug under test.
 *
 * This oracle folds the OUTPUT per code point with its OWN NFKC before checking,
 * so a homoglyph variant reads as the ASCII trigger it collapses to. It shares
 * NO code with `untrusted-text.mts` — it never imports `CODEX_TRIGGER_PATTERN`
 * or the module's fold helper, and defines its own regexes and fold — so a
 * mutation that weakens the module cannot also weaken the check that catches it
 * (the independence rule the module's own docstring names). Both the RAW and the
 * FOLDED view are tested, so an ASCII trigger is caught even if a future NFKC
 * quirk ever altered a folded form.
 */

/** ASCII `@` or fullwidth `＠`, any whitespace/backtick run, then `codex` — no
 * `\b`, so the oracle stays deliberately conservative (it flags any
 * `@…codex` run), including the proven Markdown backtick-split exploit. */
const LIVE_TRIGGER = /[@＠][\s`]*codex/iu;

/** Contiguous `@codex` (no whitespace) — used after invisibles are stripped, so
 * a truncation that RESYNTHESISES a trigger at a cut boundary is caught. */
const CONTIGUOUS_TRIGGER = /[@＠]codex/iu;

/** Every invisible / default-ignorable code point, stripped before the
 * contiguity check so a zero-width split cannot hide a resynthesised trigger. */
const INVISIBLES = /[\p{C}\p{Default_Ignorable_Code_Point}]/gu;

/**
 * Independent per-code-point NFKC fold. Deliberately NOT the module's
 * `buildTriggerDetectionFold` — the oracle must not share code with the code
 * under test. `for..of` iterates by code point, so an astral homoglyph
 * (`@\u{1D41C}odex`) folds correctly.
 */
function fold(text: string): string {
  let folded = "";
  for (const codePoint of text) {
    folded += codePoint.normalize("NFKC");
  }
  return folded;
}

/** True if `output` still reads as a live `@…codex` trigger in either the raw or
 * the per-code-point-NFKC-folded view. */
export function hasLiveTrigger(output: string): boolean {
  return LIVE_TRIGGER.test(output) || LIVE_TRIGGER.test(fold(output));
}

/** True if `output`, with invisibles stripped, still contains a contiguous
 * `@codex` in either the raw or the folded view (a truncation-resynthesised
 * trigger). */
export function hasResynthesizedTrigger(output: string): boolean {
  const rawBare = output.replace(INVISIBLES, "");
  const foldedBare = fold(output).replace(INVISIBLES, "");
  return CONTIGUOUS_TRIGGER.test(rawBare) || CONTIGUOUS_TRIGGER.test(foldedBare);
}

/** Asserts `output` carries no live trigger (fold-aware). */
export function expectNoLiveTrigger(output: string): void {
  expect(hasLiveTrigger(output)).toBe(false);
}

/** Asserts `output` carries no truncation-resynthesised trigger (fold-aware). */
export function expectNoResynthesizedTrigger(output: string): void {
  expect(hasResynthesizedTrigger(output)).toBe(false);
}
