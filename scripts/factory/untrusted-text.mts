/**
 * Dependency-free primitives for neutralising untrusted text before the
 * privileged publisher POSTs or PATCHes it into a GitHub body (issue
 * comment, PR body, review comment, or `$GITHUB_STEP_SUMMARY`).
 *
 * ZERO imports by construction (issue #158): `implement-patch-logic.mts` —
 * which `node-import-closure-verifier.mts` pulls into its OWN static import
 * closure via `isProtectedPath` — needs the posted-body sanitiser, but must
 * not acquire the `markdown-it` transitive closure that reaching for the
 * escaper in `spec-grounding-*.mts` would drag into the verifier's closure.
 * Inverting the dependency (this leaf owns the primitives; both the
 * implement-patch glue and the spec-grounding modules import DOWN into it)
 * keeps the verifier's closure small and makes this the single home for
 * "text an attacker can reach must not stay live once posted". A test
 * asserts this file contains no `import` statement (#158 G14) — adding one
 * is what re-opens the closure the design closes.
 */

/**
 * Matches the Codex review trigger phrase in any casing, with any run of
 * whitespace between the `@` and `codex` (issue #158). The connector starts
 * a review when this phrase appears in a posted comment body (backticks
 * included, observed on roastpilot-agent#682), so a body the publisher
 * posts that interpolates an attacker-influenced field could otherwise
 * steer a review into a bot-authored clean verdict the merge-policy
 * bot-authorship control cannot then distinguish from a real one.
 *
 * `[@＠]` covers the ASCII `@` AND the fullwidth `＠` (U+FF20, operator
 * decision 4 on #158). This is the RAW-view matcher — pass 1 of
 * {@link neutralizeCodexTriggerPhrases}. A fullwidth-LETTER homoglyph inside
 * the word itself (e.g. `@ｃodex`, U+FF43), once a documented residual, is now
 * closed by that function's SECOND pass over a per-code-point-NFKC DETECTION
 * fold (#168), NOT by widening this enumeration — the `[@＠]` set already
 * missed U+FE6B ﹫ (NFKC → `@`), proof that enumerating homoglyphs per class is
 * the wrong mechanism. The NFKC fold exists ONLY in that throwaway detection
 * buffer: no emitted text is ever normalised, so a homoglyph is never silently
 * rewritten to a different glyph before a human sees it, and the diff escaper
 * {@link escapeInvisibleCharactersVisibly} still never folds at all (its
 * no-NFKC contract stands). `\s*` tolerates a space/tab/newline split (the
 * connector's tokeniser plausibly collapses it); an INVISIBLE split (a
 * zero-width character JS `\s` misses) is handled upstream by
 * {@link escapeInvisibleCharactersVisibly}, which renders it a visible
 * `[U+XXXX]` marker that no longer reads as `@…codex`. `\b` keeps a
 * different mention such as `@codexfoo` from being rewritten while still
 * catching bare `@codex` and `@codex-review`.
 *
 * GLOBAL (`g`) so {@link neutralizeCodexTriggerPhrases} rewrites EVERY
 * occurrence, not just the first — a body may quote the phrase more than
 * once. Because the `g` flag makes `.test()`/`.exec()` stateful through
 * `lastIndex`, a caller that only needs a boolean must use a FRESH,
 * non-global regex, never this shared instance.
 */
export const CODEX_TRIGGER_PATTERN = /[@＠]\s*codex\b/giu;

/**
 * The inert replacement for a neutralised trigger phrase. Deliberately
 * chosen NOT to itself match {@link CODEX_TRIGGER_PATTERN} (a test asserts
 * it) — a marker that re-triggered would reintroduce the very bug it exists
 * to close.
 */
export const CODEX_TRIGGER_REMOVED_MARKER = "[codex trigger removed]";

/**
 * Builds a per-code-point NFKC fold of `text` for DETECTION ONLY, plus an index
 * map back to the original. Each folded code UNIT records the `[start, end)`
 * code-unit span of the SOURCE code point it came from, so a match `[a, b)` on
 * `folded` maps back to `[originStart[a], originEnd[b - 1])` — rounding OUTWARD
 * to whole source code points. A match that lands inside a multi-unit compat
 * expansion (e.g. U+2100 ℀ → `a/c`) or a folded astral char therefore covers
 * the ENTIRE source code point (fail closed, never a short splice that could
 * leave a lone surrogate).
 *
 * This is how a homoglyph trigger (`@ｃodex`, U+FF43) is caught while EMITTED
 * text is never itself normalised (#168): the fold lives only in this throwaway
 * buffer, and callers splice the inert marker over the ORIGINAL span. Per-code-
 * point (not full-string) NFKC keeps the map exact; full-string NFKC's only
 * extra power is cross-code-point composition, which cannot synthesise ASCII
 * `codex` and is a symmetric miss for the connector too. An unassigned code
 * point folds to itself, so a future Unicode assignment is picked up by
 * construction without re-enumerating anything.
 */
function buildTriggerDetectionFold(text: string): {
  folded: string;
  originStart: number[];
  originEnd: number[];
} {
  let folded = "";
  const originStart: number[] = [];
  const originEnd: number[] = [];
  let index = 0;
  for (const codePoint of text) {
    const start = index;
    const end = index + codePoint.length;
    const foldedCodePoint = codePoint.normalize("NFKC");
    folded += foldedCodePoint;
    for (let unit = 0; unit < foldedCodePoint.length; unit++) {
      originStart.push(start);
      originEnd.push(end);
    }
    index = end;
  }
  return { folded, originStart, originEnd };
}

/**
 * Replaces every Codex trigger phrase in `text` with
 * {@link CODEX_TRIGGER_REMOVED_MARKER}, so posting `text` onto a PR/issue
 * cannot itself start a review. Called by {@link sanitizeUntrustedInlineText}
 * as the LAST defang step — AFTER the removal transforms (invisibles-escape,
 * newline-collapse, backtick-strip), so it sees any `@…codex` those steps
 * rejoin. It handles INTERIOR triggers (`@codex` followed by a word
 * boundary); a trigger MANUFACTURED at the tail by a later length truncation
 * is handled separately by {@link safeClamp}.
 *
 * TWO passes, unioned — both leave the emitted text otherwise byte-identical:
 *  - Pass 1 (RAW view): the original {@link CODEX_TRIGGER_PATTERN} `.replace`.
 *    Retained so nothing neutralised today can regress — the raw `\b` sits on a
 *    homoglyph a fold view would fold away (e.g. `@codexｘ`, U+FF58: the raw `\b`
 *    catches it; the folded view would not).
 *  - Pass 2 (FOLDED view, #168): build the per-code-point-NFKC fold of pass-1
 *    output and scan it with a FRESH LOCAL global pattern — never
 *    {@link CODEX_TRIGGER_PATTERN}, whose `g` flag is stateful. `@` alone
 *    suffices on the folded view (NFKC folds `＠`/`﹫` to `@`), and `\b`
 *    preserves the different-mention guard (`@ｃodexfoo` is left alone). Each
 *    match is mapped back to the ORIGINAL span and the marker spliced over it,
 *    so a homoglyph trigger (`@ｃodex`) is neutralised without normalising the
 *    text. Every folded match is a whole `@…codex`, never zero-width, so the
 *    `exec` cursor always advances (no infinite loop).
 *
 * @param text - Untrusted text about to be interpolated into a posted body.
 * @returns `text` with every trigger occurrence rendered inert.
 */
export function neutralizeCodexTriggerPhrases(text: string): string {
  const rawNeutralized = text.replace(CODEX_TRIGGER_PATTERN, CODEX_TRIGGER_REMOVED_MARKER);
  const { folded, originStart, originEnd } = buildTriggerDetectionFold(rawNeutralized);
  const foldedTriggerPattern = /@\s*codex\b/giu;
  const originalSpans: Array<{ start: number; end: number }> = [];
  for (
    let match = foldedTriggerPattern.exec(folded);
    match !== null;
    match = foldedTriggerPattern.exec(folded)
  ) {
    originalSpans.push({
      start: originStart[match.index],
      end: originEnd[match.index + match[0].length - 1],
    });
  }
  let result = rawNeutralized;
  // Splice the marker over each ORIGINAL span right-to-left, so an earlier
  // splice never shifts a later match's mapped indices.
  for (let i = originalSpans.length - 1; i >= 0; i--) {
    const span = originalSpans[i];
    result = result.slice(0, span.start) + CODEX_TRIGGER_REMOVED_MARKER + result.slice(span.end);
  }
  return result;
}

// The CI-skip control tokens GitHub Actions honours in a commit message
// (issue #171). Verified against GitHub's own docs on 2026-07-29:
// <https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/skipping-workflow-runs>.
// The AUTHORITATIVE bracketed set is exactly five tokens — `[skip ci]`,
// `[ci skip]`, `[no ci]`, `[skip actions]`, `[actions skip]` — plus the
// directive `skip-checks:true`. `***NO_CI***` is an Azure Pipelines token,
// NOT a GitHub one, so it is deliberately checked-and-EXCLUDED.
//
// DETECTION MODEL (factory-security-reviewer BLOCKER, #171 fold): GitHub does
// a LITERAL SUBSTRING search for each token anywhere in the message. So each
// token is matched here as a literal regex anchored on its OWN brackets — the
// engine may begin a match at an INNER `[`, so a NESTED `[oops [skip ci]` is
// caught because `[skip ci]` is a genuine substring GitHub still honours. The
// earlier design extracted the outer bracket GROUP (`/\[([^\]]*)\]/` → `oops
// [skip ci`) and normalised it to a non-member, missing exactly that case
// while GitHub honoured it. Case-insensitive (`i`) and a `[\s._-]*` internal
// separator make each pattern a deliberately over-inclusive, fail-closed
// SUPERSET of GitHub's honoured spellings (GitHub is case-sensitive and
// single-space): it neutralises strictly MORE spellings than GitHub honours,
// never fewer. GLOBAL (`g`) so a single message can carry more than one, and
// so the SAME instances drive both the `.replace` in
// {@link neutralizeCiSkipDirectives} and the `.matchAll` in
// {@link findCiSkipDirectives} — never a private copy that could drift (the
// lesson at {@link UNTRUSTED_DATA_BREAKOUT_PATTERN}). Because the `g` flag
// makes `.exec()`/`.test()` stateful through `lastIndex`, callers use only
// `.replace`/`.matchAll` (neither corrupts the shared instance's `lastIndex`),
// never a bare `.test()`.
export const CI_SKIP_BRACKET_PATTERNS: readonly RegExp[] = [
  /\[\s*skip[\s._-]*ci\s*\]/gi,
  /\[\s*ci[\s._-]*skip\s*\]/gi,
  /\[\s*no[\s._-]*ci\s*\]/gi,
  /\[\s*skip[\s._-]*actions\s*\]/gi,
  /\[\s*actions[\s._-]*skip\s*\]/gi,
];

/**
 * The DIRECTIVE-form CI-skip control GitHub honours in a commit trailer
 * (issue #171): `skip-checks:true` / `skip-checks: true`. Already a literal
 * substring match, so it was never affected by the bracket-group flaw. Same
 * `gi`/`u` over-inclusiveness and shared-instance discipline as
 * {@link CI_SKIP_BRACKET_PATTERNS}.
 */
export const CI_SKIP_DIRECTIVE_PATTERN = /skip-checks\s*:\s*true/giu;

/**
 * The single shared detector — every bracket pattern plus the directive — that
 * BOTH {@link neutralizeCiSkipDirectives} (transform) and
 * {@link findCiSkipDirectives} (assertion) consume, so "the transform and the
 * assertion detect the same tokens" is a fact by construction, not a comment
 * (mutation G10: giving the assertion a private narrowed list fails a test).
 */
export const CI_SKIP_PATTERNS: readonly RegExp[] = [
  ...CI_SKIP_BRACKET_PATTERNS,
  CI_SKIP_DIRECTIVE_PATTERN,
];

/**
 * The inert, VISIBLE replacement for a neutralised CI-skip token — never a
 * silent removal (the AGENTS.md evidence floor: attacker text a guard removes
 * is surfaced, not vanished). Deliberately parenthesised, not bracketed, and
 * containing no `skip-checks…true`, so it matches NONE of
 * {@link CI_SKIP_PATTERNS} — a marker that re-matched would reintroduce the
 * very token it exists to remove (test L9). A nested `[oops [skip ci]`
 * neutralises to `[oops (ci-skip token removed)`: the leftover unclosed
 * `[oops` is harmless prose that is no honoured token.
 */
export const CI_SKIP_TOKEN_REMOVED_MARKER = "(ci-skip token removed)";

/**
 * Replaces every honoured CI-skip control token in `text` — each
 * {@link CI_SKIP_PATTERNS} match — with the visible
 * {@link CI_SKIP_TOKEN_REMOVED_MARKER} (issue #171). A message a factory
 * publisher would otherwise commit with a live `[skip ci]` or
 * `skip-checks:true` in it must not silently suppress the required workflow
 * runs a human relies on to see a factory PR as reviewed.
 *
 * **Composed as the LAST step of {@link sanitizeUntrustedTextForCommitMessage},
 * AFTER {@link sanitizeUntrustedInlineText}'s backtick-strip.** The order is
 * load-bearing: a backtick is NOT in the `[\s._-]*` separator class, so a
 * split token like `` [skip`ci] `` slips this neutralise UNTIL the prior
 * backtick-strip rejoins it into `[skipci]` (test L4; mutation G7 —
 * neutralise-before — reconstitutes it). Every pattern is applied, so a
 * message carrying several distinct tokens is fully neutralised.
 *
 * @param text - Text about to be interpolated into a commit message.
 * @returns `text` with every honoured CI-skip token rendered inert.
 */
export function neutralizeCiSkipDirectives(text: string): string {
  let result = text;
  for (const pattern of CI_SKIP_PATTERNS) {
    result = result.replace(pattern, CI_SKIP_TOKEN_REMOVED_MARKER);
  }
  return result;
}

/**
 * Defangs an untrusted field for interpolation into a git COMMIT MESSAGE the
 * privileged publisher pushes (issue #171 — the commit surface #158's
 * posted-body sanitiser never covered). Runs the full inline defang
 * ({@link sanitizeUntrustedInlineText}: invisibles → `[U+XXXX]`, `[\r\n]+` →
 * single space so an attacker title cannot forge a second trailer line,
 * backticks stripped, `@codex` neutralised), THEN
 * {@link neutralizeCiSkipDirectives} LAST — the CI-skip neutralise must see
 * the value after the backtick-strip that can rejoin a split token (see
 * {@link neutralizeCiSkipDirectives} for why the order is load-bearing).
 *
 * Unlike {@link sanitizeUntrustedTextForPostedBody} this applies NO code-span
 * wrap and NO clamp: a commit subject is plain text with its own length
 * budget the caller clamps with {@link safeClamp}.
 *
 * @param value - The untrusted field value (e.g. an attacker-authored issue title).
 * @returns The value as inert plain text, safe to place in a commit message.
 */
export function sanitizeUntrustedTextForCommitMessage(value: string): string {
  return neutralizeCiSkipDirectives(sanitizeUntrustedInlineText(value));
}

/**
 * Scans an ASSEMBLED commit message for any honoured CI-skip control token,
 * for the publisher's fail-closed PRE-PUSH assertion (issue #171). This is
 * the SECOND, independent guard: {@link sanitizeUntrustedTextForCommitMessage}
 * defangs each per-field value, but the assembled message also concatenates
 * trailer fields that are NOT per-field transformed (the dispatch actor,
 * prompt version, agent-action ref), so a token reaching the message through
 * any of them is still caught here and the push refused.
 *
 * Consumes the SAME {@link CI_SKIP_PATTERNS} the transform does — never a
 * private narrowed copy (mutation G10). Uses `.matchAll` (which clones the
 * global regex internally, leaving its `lastIndex` untouched), never a
 * stateful `.test()` on the shared instance. Because it matches each token as
 * a literal substring, it catches a nested `[oops [skip ci]` the transform
 * catches too — so this assertion and the transform never disagree.
 *
 * @param message - The fully assembled commit message (all `-m` parts joined).
 * @returns The matched token strings; a non-empty result means the caller must
 *   refuse to push.
 */
export function findCiSkipDirectives(message: string): string[] {
  const found: string[] = [];
  for (const pattern of CI_SKIP_PATTERNS) {
    for (const match of message.matchAll(pattern)) {
      found.push(match[0]);
    }
  }
  return found;
}

// Zero-width / bidi-format characters an attacker could inject to split
// the literal delimiter token into a byte sequence a whitespace-tolerant
// (but still literal-character) regex still misses, while an LLM
// tokenizer/renderer plausibly collapses them and reads the result as the
// real tag anyway (independent factory-security-reviewer finding, F1-S9
// slice 3, issue #12).
//
// CATEGORICAL FIX (operator correction, PR #70 review round 5 \u2014 the
// markdown-it lesson applied one level down): this pattern was
// previously an enumerated set of Unicode ranges, extended TWICE across
// this same PR review as Codex found the next gap each time (U+200B-
// 200F/202A-202E/2060-2064/FEFF, then U+061C + the bidi ISOLATE block
// U+2066-2069, then the deprecated bidi shaping controls U+206A-206F).
// Enumerating ranges is exactly the class of bug the markdown-it swap
// was meant to close for code-region detection \u2014 the same lesson
// applies here: `\p{Cf}` (the Unicode FORMAT general category, matched
// via the `u`-flag property-escape syntax) matches EVERY assigned
// format character in ONE pattern \u2014 every zero-width character, every
// bidi control, soft hyphen, and any future Unicode-assigned format
// character this module has never explicitly enumerated \u2014 closing the
// whole class by construction rather than the next round's specific
// gap. Verified (not assumed) against every codepoint previously
// enumerated here: `\p{Cf}` matches all of them except U+2065, which
// isn't a real format character at all \u2014 it's an UNASSIGNED reserved
// codepoint inside the invisible-operators block that only ever
// appeared here as an accidental inclusion in a convenience numeric
// range, never a meaningful character an attacker could type or a
// renderer could collapse.
//
// `\p{Cf}` was STILL the wrong property, one round later (Codex finding,
// PR #70 review round 9 — a real delimiter-breakout, category (a),
// always folds regardless of the common-form cap): the Unicode Format
// general category and the "default-ignorable" concept invisible-
// character attacks actually key off are OVERLAPPING, not identical.
// Combining Grapheme Joiner (U+034F), variation selectors (U+FE00-FE0F),
// and Mongolian free variation selectors (U+180B-180D) are all
// default-ignorable — an LLM tokenizer/renderer plausibly collapses
// them the same way — but are NOT in category Cf, verified empirically
// (each tests false against `\p{Cf}` alone) before writing this fix.
// `\p{Default_Ignorable_Code_Point}` (JS's own supported Unicode binary-
// property syntax under the `u` flag) closes the DI half; UNIONED with
// `\p{Cf}` (which has its own members DI doesn't cover, e.g. the Arabic
// number sign U+0600) the two together close the whole invisible-
// breakout class by construction, not by enumerating this round's three
// named characters and waiting for the next.
//
// Exotic Unicode whitespace (Codex finding, PR #70 review round 18 — a
// real delimiter-breakout, category (a), always folds):
// `</UNTRUSTED_ISSUE_DATA>` survives when a NEL (U+0085) sits inside the
// tag, e.g. between the `<` and the `/`. NEL is Unicode White_Space but is
// NOT matched by JS's own `\s` metacharacter (verified empirically:
// `/\s/.test("\u0085")` is `false`), so it defeated BOTH the whitespace-
// tolerant `\s*` inside {@link DELIMITER_TAG_PATTERN} and the `\p{Cf}`/DI
// cleanup above — yet a model's tokenizer/renderer plausibly still
// collapses it as ordinary whitespace and reads the result as the real
// closing delimiter.
//
// STILL not categorically complete, TWO rounds later (Codex + an
// independent security-reviewer pass, PR #72 review round 3 — BOTH
// found real breakout gaps sharing ONE root cause: the diff guard added in
// slice 3b-i for the PR diff had drifted onto a DIFFERENT character set
// than this one, and neither set alone was complete):
// - The diff guard's `\p{C}` (Cc ∪ Cf ∪ Cn ∪ Co ∪ Cs)
//   MISSED `\p{Default_Ignorable_Code_Point}`'s own members outside
//   category C — Combining Grapheme Joiner (U+034F) and the variation
//   selectors (U+FE00-FE0F) are category Mn, not any C subcategory, so a
//   `</UNTRUSTED_PR_DIFF>` split by one survived. (This traces to an error
//   in the guidance that produced the diff guard's pattern: "invert to
//   `\p{C}`" silently dropped `Default_Ignorable_Code_Point`, which the
//   ORIGINAL criteria guard, right here, had never lost.)
// - This module's own criteria guard, in turn, had never picked up
//   `\p{Cc}` (plain control characters — U+0008 BACKSPACE, U+001B
//   ESCAPE, U+007F DELETE, verified empirically to break
//   `</UNTRUSTED_ISSUE_DATA>` out the same way NEL once did) or the
//   Co/Cn/Cs members `\p{C}` closes, on the PRIMARY anti-gaming surface —
//   a real, reproduced gap, not a theoretical one.
//
// CANONICAL FIX: exactly ONE breakout-character pattern, used by BOTH
// guards, combining every class either one individually needed: `\p{C}`
// (Cc ∪ Cf ∪ Cn ∪ Co ∪ Cs — controls, format
// characters, unassigned, private-use, surrogates) UNIONED with
// `\p{Default_Ignorable_Code_Point}` (closes the Mn-category default-
// ignorables `\p{C}` alone misses) UNIONED with `\p{White_Space}` (closes
// NEL and every other exotic space/separator). Sharing this SINGLE
// exported primitive between `neutralizeDelimiterBreakout` here and slice
// 3b-i's diff guard (`spec-grounding-runner-logic.mts`) makes "both guards
// cover the same breakout class" a fact enforced by construction —
// reusing one constant — rather than a claim in a comment two
// independently-maintained patterns could silently drift apart from,
// which is exactly what happened here.
export const UNTRUSTED_DATA_BREAKOUT_PATTERN = /[\p{C}\p{Default_Ignorable_Code_Point}\p{White_Space}]/gu;

// The ONLY characters {@link UNTRUSTED_DATA_BREAKOUT_PATTERN} must never
// strip or visibly mark — the four ordinary ASCII whitespace
// characters (space, tab, LF, CR) real criterion/diff text legitimately
// contains. Deliberately does NOT also exempt VT/FF (Codex + security-
// reviewer finding, PR #72 review round 3 — narrowed from an earlier
// six-character exemption set that also spared those two): VT and FF are
// themselves `\p{Cc}` control characters, and this guard's whole point,
// after the same review round found `\p{Cc}` was a real gap, is to
// surface a control character sitting where it doesn't belong — not
// carve out two more as "harmless" the same way NEL once was.
export const ASCII_WHITESPACE_CHARS: ReadonlySet<string> = new Set([" ", "\t", "\n", "\r"]);

/**
 * Renders every character {@link UNTRUSTED_DATA_BREAKOUT_PATTERN} matches
 * as a VISIBLE `[U+XXXX]` marker instead of silently removing it (Codex
 * finding, PR #72 review — a real bug in the original version of this
 * module: it reused `spec-grounding-logic.mts`'s criteria-text guard,
 * which STRIPS these characters, on the diff too).
 *
 * Uses the SAME shared, canonical breakout-character pattern
 * `neutralizeDelimiterBreakout` (criteria/title text) uses — see that
 * pattern's own docstring for why this took three review rounds to become
 * exactly one shared primitive (PR #72 review round 3, BLOCKER: two
 * independently-drifting local patterns — one here, one there — each
 * missed a class the other one covered).
 *
 * DELIBERATELY DIFFERENT TREATMENT from `neutralizeDelimiterBreakout`,
 * even though the DETECTION pattern is now identical (criterion/title
 * text). That function's silent-strip approach is correct THERE because
 * criteria are untrusted DATA — their only job is to be read as a
 * checklist, and an invisible character in them has no legitimate meaning
 * worth preserving. The PR diff is a fundamentally different kind of
 * untrusted input: it is CONTENT THE REVIEW AGENT MUST INSPECT for
 * exactly this class of attack. A bidi override hiding malicious code
 * behind visually-reordered text (Trojan-Source), a control character
 * hidden mid-line, a zero-width character splitting a homoglyph
 * identifier, or any other invisible/unprintable-character trick IN THE
 * DIFF ITSELF is precisely what a security-minded review exists to
 * catch — silently stripping it before the agent ever sees the diff
 * would make the review BLIND to that exact attack class, a strictly
 * worse outcome than the delimiter-breakout risk the original (wrong)
 * version of this function was guarding against.
 *
 * Rendering each such character as a literal, visible marker instead
 * PRESERVES the evidence (the agent can see "there is a suspicious
 * invisible or unprintable character right here") rather than destroying
 * it, and as a side effect also defeats an invisible-character-based
 * delimiter-breakout attempt on the diff's own wrapper tag — an invisible
 * character sitting between `<` and `/` becomes literal, visible marker
 * text once this pass runs, so it no longer reads as whitespace to the
 * plain, ordinary-whitespace-tolerant tag-neutralization pass
 * {@link neutralizeDiffDelimiterBreakout} applies next.
 *
 * NEVER applies `.normalize("NFKC")` (Codex finding, same review round):
 * NFKC normalization can silently change WHICH glyph represents a
 * homoglyph-adjacent character before the agent ever sees the original —
 * exactly the kind of transformation that could mask, not reveal, a
 * homoglyph-substitution attack. This function does not normalize the
 * diff at all.
 *
 * Exported (PR #82 round 2 review, FOLD 3) so `publish-spec-grounding-
 * verdict-logic.mts`'s rationale sanitizer can reuse this SAME categorical
 * primitive for the agent's own rationale text, rather than a second,
 * independently-maintained enumeration of "invisible/bidi characters to
 * neutralize" that could drift from this one — `UNTRUSTED_DATA_BREAKOUT_
 * PATTERN` already includes every Unicode bidi control (U+202A-202E,
 * U+2066-2069 are all category `Cf`, covered by `\p{C}`), so this function
 * already neutralizes Trojan-Source-style bidi reordering, not just this
 * module's own diff-guard use case.
 *
 * @param text - Raw text (a diff, or any other untrusted/agent-authored
 *   string this categorical guard applies to).
 * @returns The same text, byte-for-byte, EXCEPT every invisible/
 *   unprintable character (ordinary ASCII whitespace excluded) is
 *   replaced with a visible `[U+XXXX]` marker showing its exact codepoint.
 */
export function escapeInvisibleCharactersVisibly(text: string): string {
  return text.replace(UNTRUSTED_DATA_BREAKOUT_PATTERN, (ch) => {
    if (ASCII_WHITESPACE_CHARS.has(ch)) {
      return ch;
    }
    const codePoint = ch.codePointAt(0);
    if (codePoint === undefined) {
      // Defensive: this pattern only ever matches a single real codepoint,
      // never an empty string — unreachable by construction.
      /* v8 ignore next */
      return ch;
    }
    return `[U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}]`;
  });
}

/**
 * Per-field character clamp for a sanitised value placed in a posted body
 * or step summary. Keeps one attacker-controlled field from dominating the
 * comment. Applied via {@link safeClamp}, NOT a bare slice: truncation is a
 * LOSSY transform that can MANUFACTURE a live `@codex` at the new tail (see
 * {@link safeClamp}), so it needs the trailing-fragment strip that a bare
 * slice lacks.
 */
export const MAX_SANITIZED_STEP_SUMMARY_FIELD_LENGTH = 200;

/**
 * A partial-or-complete `@…codex` fragment anchored at the END of a string
 * (`@c`, `@ codex`, `＠codex`, …), matched on the RAW view.
 * {@link stripTruncationTailArtifacts} strips this after a length truncation,
 * because truncation is the one transform that can MANUFACTURE a live trigger
 * the {@link neutralizeCodexTriggerPhrases} `\b` guard deliberately left alone
 * (#158 fold round 3, factory-security-reviewer BLOCKER): `@codexx` is a benign
 * DIFFERENT mention the `\b` skips, but truncating its last char to `@codex` and
 * appending `…` GIVES it the word boundary that turns it into a live trigger.
 * Truncation's only NEW boundary is at the tail, so cleaning the tail is provably
 * sufficient; the strip only removes characters, so the length bound still holds.
 */
const TRAILING_TRIGGER_FRAGMENT = /[@＠]\s*c(?:o(?:d(?:e(?:x)?)?)?)?$/iu;

/**
 * The FOLDED-view companion of {@link TRAILING_TRIGGER_FRAGMENT} (#168): the same
 * end-anchored `@…codex` fragment, but matched against a per-code-point-NFKC fold
 * so a homoglyph tail (`@ｃ`, `@ｃo`, …) a truncation manufactured is stripped too.
 * `@` alone suffices on the folded view (NFKC folds `＠`/`﹫` to `@`). Run via
 * `.exec` on the fold; the origin index map cuts the ORIGINAL at the source code
 * point the match starts on, so the emitted text is never itself normalised.
 */
const FOLDED_TRAILING_TRIGGER_FRAGMENT = /@\s*c(?:o(?:d(?:e(?:x)?)?)?)?$/iu;

/**
 * An UNCLOSED `[U+XXXX` escape marker anchored at the END of a string — the
 * cosmetic artifact a mid-marker truncation would otherwise leave (a marker
 * that closes with `]` is NOT matched, since `$` sits after the `]`).
 * {@link safeClamp} strips it so a clamped value never ends in half a marker.
 */
const TRAILING_PARTIAL_ESCAPE_MARKER = /\[U\+[0-9A-F]*$/;

/**
 * A lone UTF-16 high surrogate anchored at the END of a string — what a
 * code-unit `slice` leaves when it cuts an astral character (emoji, etc.) in
 * half (#158 fold, PR #170, Codex P2). Astral chars pass the pipeline
 * untouched ({@link escapeInvisibleCharactersVisibly} does not match category
 * So), so the clamp is the only place a pair can be split. A lone surrogate
 * is NOT representable in wire UTF-8, so `githubRequest`'s JSON body would
 * carry a literal `\uD83D` that GitHub can reject — AFTER the branch is
 * pushed. {@link safeClamp} strips it. Deliberately code-UNIT slicing plus
 * this strip, NOT `Array.from` code-POINT slicing (the soft-truncation
 * precedent in `publish-spec-grounding-verdict-logic.mts`): the title caller
 * has a HARD 256 limit, and code-point slicing could let the code-UNIT length
 * reach 2×budget and blow it if GitHub counts UTF-16 units. This keeps the
 * result `≤ maxLength + 1` under both code-unit AND code-point counting.
 */
const TRAILING_LONE_HIGH_SURROGATE = /[\uD800-\uDBFF]$/;

/**
 * Length-bounds `value` to `maxLength` content characters with a trailing
 * `…`, WITHOUT letting the truncation resynthesise a live `@codex` at the new
 * end ({@link TRAILING_TRIGGER_FRAGMENT}), leave half an escape marker
 * ({@link TRAILING_PARTIAL_ESCAPE_MARKER}), or leave a lone UTF-16 surrogate
 * from a split astral char ({@link TRAILING_LONE_HIGH_SURROGATE}). Every strip
 * only REMOVES tail characters, so the result is at most `maxLength + 1`
 * characters (the `+ 1` is the ellipsis) — the same bound the bare field clamp
 * this replaces had. A value already within bound is returned unchanged (no
 * ellipsis).
 *
 * Strip order is partial-marker → lone-surrogate → trigger, so each strip
 * cleans what an earlier one can expose: a `…😀[U+F` tail drops the dangling
 * marker to reveal the intact emoji, and a `…@codex😀` cut mid-emoji drops the
 * lone surrogate to reveal the `@codex` the trigger strip then removes.
 *
 * **SECURITY PRECONDITION:** `value` MUST already have passed {@link
 * neutralizeCodexTriggerPhrases} (both callers do, via {@link
 * sanitizeUntrustedInlineText}). safeClamp neutralises ONLY the
 * truncation-manufactured tail `@codex`, NOT interior triggers — calling it
 * on raw attacker text would pass an interior `@codex` straight through and
 * reopen #158's class. Robust-by-construction hardening (so a future raw-text
 * caller cannot silently reintroduce the bug) is tracked in #169.
 *
 * @param value - The already-defanged (see precondition) value to bound.
 * @param maxLength - The content-character budget (before the ellipsis).
 * @returns `value` bounded and, when truncated, tail-cleaned and `…`-suffixed.
 */
/**
 * Removes the artifacts a truncation can leave at a new string end, in the
 * order that lets each strip clean what an earlier one exposes: a dangling
 * partial `[U+XXXX` marker, then a lone high surrogate, then a
 * truncation-manufactured `@…codex` fragment on the RAW view, then the same
 * fragment on a per-code-point-NFKC FOLDED view (#168 — a homoglyph tail like
 * `@ｃo` the ASCII fragment misses). Every strip only REMOVES, so it never
 * lengthens the input. Shared by {@link safeClamp} (code-unit budget) and
 * {@link renderBoundedUntrustedReason} (code-point budget).
 *
 * The whole sequence runs in a SHRINK-UNTIL-STABLE loop because one strip can
 * expose another the single ordered pass would miss: a partial `[U+` marker
 * hiding a `@ｃ` fold fragment behind it, or a fold-fragment strip uncovering a
 * `[U+` marker in front of it. The loop terminates — each pass only removes, so
 * the string strictly shrinks until a pass changes nothing — and preserves the
 * `≤ maxLength + 1` bound its callers rely on.
 */
function stripTruncationTailArtifacts(truncated: string): string {
  let current = truncated;
  for (;;) {
    let next = current
      .replace(TRAILING_PARTIAL_ESCAPE_MARKER, "")
      .replace(TRAILING_LONE_HIGH_SURROGATE, "")
      .replace(TRAILING_TRIGGER_FRAGMENT, "");
    const { folded, originStart } = buildTriggerDetectionFold(next);
    const foldMatch = FOLDED_TRAILING_TRIGGER_FRAGMENT.exec(folded);
    if (foldMatch !== null) {
      next = next.slice(0, originStart[foldMatch.index]);
    }
    if (next === current) {
      return next;
    }
    current = next;
  }
}

export function safeClamp(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }
  return `${stripTruncationTailArtifacts(value.slice(0, maxLength))}…`;
}

/**
 * Robustly defangs an untrusted field to inert PLAIN text (no Markdown
 * wrap, no clamp), for any surface where an attacker-controlled string is
 * interpolated — a rendered Markdown body OR a non-Markdown context like a
 * PR title. This is the single shared primitive both {@link
 * sanitizeUntrustedTextForPostedBody} and the PR-title path call, so
 * "title and body cannot drift on trigger-defang" is a fact by
 * construction, not a comment (#158 fold).
 *
 * **Order is the whole fix (#158 fold — factory-security-reviewer BLOCKER).**
 * The trigger neutralise runs LAST, AFTER every removal/collapse step,
 * because a strip or collapse that runs after it can REJOIN a `@…codex`
 * the neutralise already walked past. The proven exploit: `` @`codex
 * review `` slips {@link neutralizeCodexTriggerPhrases} (a backtick is not
 * `\s`), so stripping backticks FIRST is exactly what lets the neutralise
 * then see — and defang — the reconstructed `@codex`. The earlier
 * "neutralise on the raw value first" order was wrong for this reason.
 *
 *  1. {@link escapeInvisibleCharactersVisibly} — render every invisible/
 *     bidi/exotic-whitespace character as a visible `[U+XXXX]` marker.
 *     This defangs a zero-width split (`@<ZWSP>codex`) JS `\s` misses (the
 *     `@` and `codex` are separated by literal marker text) and surfaces a
 *     Trojan-Source bidi override instead of hiding it.
 *  2. Collapse `[\r\n]+` to a single space.
 *  3. Strip backticks (they can end a wrapping code span early AND, more
 *     importantly, a backtick between `@` and `codex` is a trigger-split
 *     that only stripping reveals).
 *  4. {@link neutralizeCodexTriggerPhrases} — LAST, so it sees the value
 *     after every join-capable removal above.
 *
 * @param value - The untrusted field value to defang.
 * @returns The value as inert plain text: invisibles surfaced, newlines
 *   collapsed, backticks stripped, and every trigger variant neutralised.
 */
export function sanitizeUntrustedInlineText(value: string): string {
  const invisiblesMarked = escapeInvisibleCharactersVisibly(value);
  const collapsed = invisiblesMarked.replace(/[\r\n]+/g, " ").replace(/`/g, "");
  return neutralizeCodexTriggerPhrases(collapsed);
}

/**
 * Neutralises an untrusted field for interpolation into a Markdown body the
 * privileged publisher POSTs/PATCHes to GitHub (issue comment, PR body,
 * review comment, or `$GITHUB_STEP_SUMMARY`). The name is load-bearing:
 * this is THE posted-body sanitiser, and every caller interpolating agent/
 * issue/PR/path/transcript-derived text into such a body routes through
 * here (#158 — the previous, step-summary-scoped name was how the class
 * regressed onto surfaces the original author never revisited).
 *
 * Defangs the value to inert plain text via {@link
 * sanitizeUntrustedInlineText} (see there for why the trigger neutralise
 * runs LAST), then length-bounds it with {@link safeClamp} to {@link
 * MAX_SANITIZED_STEP_SUMMARY_FIELD_LENGTH} and wraps in a single-backtick
 * inline code span. The clamp uses {@link safeClamp}, NOT a bare slice,
 * because truncation can otherwise resynthesise a live `@codex` at the new
 * tail (e.g. `@codexx` → `@codex…`) — the neutralise that ran inside {@link
 * sanitizeUntrustedInlineText} cannot see a fragment the later truncation
 * only then creates.
 *
 * The code span is the categorical Markdown fix (post-#46, three prior
 * rounds against the same class): a GFM inline code span renders its
 * contents as literal text — no links, no autolinks, no `@mention`, no
 * HTML — by construction, so brackets/parens/backslashes/bare URLs need no
 * per-metacharacter escaping once inside it. The returned value ALREADY
 * includes its own surrounding backticks; a caller must NOT wrap it again
 * (that would double-wrap).
 *
 * @param value - The untrusted field value to render.
 * @returns The defanged value, wrapped in its own inline code span.
 */
export function sanitizeUntrustedTextForPostedBody(value: string): string {
  return `\`${safeClamp(sanitizeUntrustedInlineText(value), MAX_SANITIZED_STEP_SUMMARY_FIELD_LENGTH)}\``;
}

/**
 * Renders one untrusted REASON for a Markdown sink (a posted comment or the
 * step summary) under a GENEROUS per-item bound that, unlike {@link
 * sanitizeUntrustedTextForPostedBody}'s tight 200-char field clamp, DISCLOSES
 * any truncation rather than dropping evidence silently (#158 fold, PR #170,
 * Codex P1 — the AGENTS.md floor is "evidence/state is never SILENTLY dropped
 * or truncated"; a bounded-but-disclosed render is compliant, a silent cut is
 * not). Mirrors the two-tier LIST-bounding shape of
 * `publish-spec-grounding-verdict-logic.mts`'s
 * `buildSpecGroundingFallbackCommentBody` (per-item + total + omitted count),
 * but lives here so `implement-patch-logic.mts` need not import that
 * markdown-it-bearing module into the import-closure verifier's reach. NOTE:
 * `publish-spec-grounding-verdict-logic.mts`'s own two PER-ITEM helpers
 * (`sanitizeAgentRationaleForDisplay`, `sanitizeReasonForDisplay`) now BOTH
 * route through this primitive too (#158 slice 2, closing #172 — each used to
 * truncate with a BARE `…`, a silent cut of this same class), each passing its
 * own trusted {@link fullDetailLocation} literal — so there is no second,
 * independently-maintained silent-truncation path left in that module.
 *
 * Defangs via {@link sanitizeUntrustedInlineText} (so a `@codex review` in a
 * reason cannot start a review from the comment), then bounds by CODE POINTS
 * (never splitting an astral char): a reason within `maxCodePoints` is
 * returned in full; a longer one is truncated to `maxCodePoints`, tail-cleaned
 * ({@link stripTruncationTailArtifacts}, so truncation cannot resynthesise a
 * trigger or leave half a marker), and followed by an explicit, non-silent
 * disclosure naming the omitted count and where the full evidence lives. The
 * kept text is wrapped in a code span; the disclosure is our own trusted
 * italic text OUTSIDE the span.
 *
 * @param reason - The untrusted reason text.
 * @param maxCodePoints - The generous per-item code-point budget.
 * @param fullDetailLocation - A TRUSTED caller-supplied literal naming where the
 *   full, untruncated evidence lives (e.g. `"the uploaded verdict artifact"`),
 *   interpolated into the disclosure suffix. This MUST be a fixed string
 *   literal owned by the caller, NEVER attacker-derived or otherwise untrusted
 *   text — it is placed OUTSIDE the code span and is not itself sanitised. The
 *   default keeps the slice-1 `implement-patch-logic.mts` callers byte-for-byte.
 * @returns Markdown: a code span, plus a disclosure suffix when truncated.
 */
export function renderBoundedUntrustedReason(
  reason: string,
  maxCodePoints: number,
  fullDetailLocation = "the run output",
): string {
  const defanged = sanitizeUntrustedInlineText(reason);
  const codePoints = Array.from(defanged);
  if (codePoints.length <= maxCodePoints) {
    return `\`${defanged}\``;
  }
  const kept = stripTruncationTailArtifacts(codePoints.slice(0, maxCodePoints).join(""));
  // Count omitted from the ACTUAL kept length, AFTER the tail strip — the strip
  // removes MORE than the raw `length - maxCodePoints` gap (a partial trigger/
  // marker fragment, a lone surrogate), so counting before it would understate
  // the disclosure (qa finding, PR #170).
  const omitted = codePoints.length - Array.from(kept).length;
  return `\`${kept}\` _[truncated, ${omitted} character(s) omitted — full detail in ${fullDetailLocation}]_`;
}

/**
 * Renders one untrusted MULTI-LINE block (agent prose whose newlines carry
 * meaning) for a Markdown sink the privileged publisher POSTs/PATCHes to
 * GitHub, wrapped in a fenced ```` ```text ```` code block so the whole block
 * renders as literal, inert text with its line breaks preserved (#158 slice 3,
 * the triage-verdict reasoning sink). The single-line {@link
 * renderBoundedUntrustedReason} is wrong here: it collapses `[\r\n]+` to one
 * space, which would flatten multi-line reasoning into an unreadable run-on.
 *
 * **The transform ORDER is load-bearing** — each step is placed so a later one
 * cannot re-open what an earlier one closed:
 *
 *  1. **EOL-normalise** `\r\n`/`\r` → `\n`, so the posted fenced block has
 *     consistent line endings. This is NORMALISATION plus defence-in-depth, NOT
 *     the sole guard for a CR-prefixed fence or trigger: JS's `/m` anchors `^`
 *     at a bare `\r` (`/^~{3,}/m.test("x\r~~~")` is `true`), so the step-4
 *     tilde-defuse already catches a `\r~~~` line even without this step, and
 *     the step-5 `\s*` includes `\r`, so a `@\rcodex` split is already caught
 *     too. The value here is a clean, deterministic output line ending — a bare
 *     `\r` left in the rendered block serves no purpose — and belt-and-suspenders
 *     against a downstream CommonMark renderer that treats bare CR as a line
 *     ending. A test pins the `\r\n`/`\r` → `\n` normalisation so the step is
 *     not a silent no-op.
 *  2. **{@link escapeInvisibleCharactersVisibly}** — render every invisible/
 *     bidi/exotic-whitespace character (Trojan-Source overrides, zero-width
 *     trigger splits, NEL/LS/PS separators) as a visible `[U+XXXX]` marker.
 *     This PRESERVES `\n` (ASCII whitespace is exempt), so the block's real
 *     line structure survives while a `@<ZWSP>codex` split JS `\s` misses is
 *     turned into inert marker text, and a NEL/LS/PS that could act as a
 *     line terminator to a renderer stops reading as one.
 *  3. **Strip ALL backticks** `` ` `` → "". A backtick can neither close our
 *     ```` ``` ```` fence early (fence-escape) nor split `@`/`codex` for the
 *     step-5 neutralise to miss (the slice-1 backtick-split exploit). There is
 *     no newline-collapse here to do collateral joining, so the strip must
 *     happen at this step. This strip is LOSSY (a backtick-only reasoning
 *     collapses to an empty block); so is the step-4 tilde-defuse. Rather than a
 *     per-transform check, a SINGLE class-level disclosure fires whenever any
 *     step-3/4 content-modifying transform changed the text (see
 *     `modifiedForSafeRendering` below): a non-silent note is appended OUTSIDE
 *     the fence pointing at `fullDetailLocation` (the run log holds the full
 *     un-modified value) — the AGENTS.md floor is that evidence is never
 *     SILENTLY dropped. It is emitted on EVERY path, truncated or not: on the
 *     truncated path the omitted count is measured against the POST-transform
 *     content, so it does not cover the stripped/reduced characters, and the
 *     formatting note sits alongside the truncation note (each accurate for its
 *     own removal).
 *  4. **Tilde-fence defusal** `^( {0,3})~{3,}` → `$1~~` (defence-in-depth for a
 *     renderer that also honours `~~~` fences). AFTER step 3, because a backtick
 *     strip can expose a `~~~` a backtick had split. The `/m` `^` anchors at
 *     every line start (`\n` AND, in JS, a bare `\r`), so this catches a CR-
 *     prefixed fence with or without step 1's normalisation. An interior `~~~`
 *     not at a line start is left alone. Like step 3, this is a content-
 *     modifying transform, so any reduction it makes is covered by the same
 *     step-3 safe-rendering disclosure.
 *  5. **{@link neutralizeCodexTriggerPhrases}** — LAST content transform (the
 *     slice-1 order lesson: any join-capable removal after it can rebuild a
 *     `@…codex` it already walked past). Its `\s*` spans `\n`, so a cross-line
 *     `@\ncodex` split is caught here (the deliberate newline-preservation
 *     exception — the block keeps its newlines, but a trigger straddling one is
 *     still defanged). Unconditional: whether the connector honours a trigger
 *     INSIDE a fenced code block is unproven, so this fails closed and always
 *     runs.
 *  6. **Code-point bound + non-silent disclosure** — mirrors {@link
 *     renderBoundedUntrustedReason} exactly: slice to `maxCodePoints` (never
 *     splitting an astral char), {@link stripTruncationTailArtifacts} on the
 *     tail (so truncation cannot resynthesise a trigger or leave half a
 *     marker/a lone surrogate), and count the omitted characters AFTER that
 *     strip.
 *  7. **Wrap.** Untruncated: ```` ```text\n<content>\n``` ````. Truncated: the
 *     kept fence, then a trusted italic disclosure OUTSIDE the fence naming the
 *     omitted count and where the full evidence lives. EITHER form ALSO carries
 *     the step-3 "formatting characters removed" disclosure OUTSIDE the fence
 *     when a backtick was stripped — on the truncated path the omitted count
 *     does not cover the stripped backticks, so both notes appear. All
 *     disclosures are trusted italic; the `text` info-string is a trusted
 *     constant.
 *
 * @param text - The untrusted multi-line text.
 * @param maxCodePoints - The generous per-block code-point budget.
 * @param fullDetailLocation - A TRUSTED caller-supplied literal naming where the
 *   full, untruncated evidence lives (e.g. `"the run log"`), interpolated into
 *   the disclosure suffix OUTSIDE the fence. MUST be a fixed string literal
 *   owned by the caller, NEVER attacker-derived — it is not itself sanitised.
 * @returns Markdown: a ```` ```text ```` fenced block, plus a disclosure suffix
 *   when truncated.
 */
export function renderBoundedUntrustedMultilineBlock(
  text: string,
  maxCodePoints: number,
  fullDetailLocation = "the run output",
): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  const invisiblesMarked = escapeInvisibleCharactersVisibly(normalized);
  const withoutBackticks = invisiblesMarked.replace(/`/g, "");
  const tildeDefused = withoutBackticks.replace(/^( {0,3})~{3,}/gm, "$1~~");
  const defanged = neutralizeCodexTriggerPhrases(tildeDefused);
  // Disclose whenever ANY content-modifying safe-rendering transform in steps
  // 3-4 changed the text — strip-backticks OR tilde-defuse, or any future lossy
  // transform added to that segment — so a shortened (or empty) reasoning is
  // never published silently (#158 #174 Codex P2/r2/r3 — the AGENTS.md floor is
  // that evidence is never SILENTLY dropped; the full un-stripped value is in
  // the run log, written before the POST). Comparing the post-tilde-defuse
  // content against `invisiblesMarked` closes the whole CLASS in one check
  // rather than one transform at a time. The baseline is DELIBERATELY the
  // post-EOL-normalise text: CRLF/CR -> LF (step 1) is benign, content-
  // preserving line-ending normalisation, not a lossy safety transform, so it
  // is intentionally NOT disclosed (a note on every Windows-line-ending verdict
  // would be noise) — do not move the baseline back to the pre-EOL text. The
  // step-5 trigger neutralise is also excluded: it substitutes a VISIBLE marker,
  // so nothing is silently lost.
  const modifiedForSafeRendering = tildeDefused !== invisiblesMarked;
  // Disclosed on EVERY path when true. ORTHOGONAL to the truncation note: the
  // truncation count below is measured against the POST-transform `defanged`
  // text, so it does NOT account for the stripped/reduced characters. Both notes
  // are accurate for their own removal and both point at `fullDetailLocation`
  // (the run log, which holds the full un-stripped value).
  const formattingNote = modifiedForSafeRendering
    ? `\n_[formatting characters removed for safe rendering — full detail in ${fullDetailLocation}]_`
    : "";
  const codePoints = Array.from(defanged);
  if (codePoints.length <= maxCodePoints) {
    return `\`\`\`text\n${defanged}\n\`\`\`${formattingNote}`;
  }
  const kept = stripTruncationTailArtifacts(
    codePoints.slice(0, maxCodePoints).join(""),
  );
  // Count omitted from the ACTUAL kept length, AFTER the tail strip (same
  // reasoning as renderBoundedUntrustedReason — the strip removes more than the
  // raw gap, so counting before it would understate the disclosure).
  const omitted = codePoints.length - Array.from(kept).length;
  return (
    `\`\`\`text\n${kept}\n\`\`\`\n` +
    `_[truncated, ${omitted} character(s) omitted — full detail in ${fullDetailLocation}]_` +
    formattingNote
  );
}
