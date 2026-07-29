import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CODEX_TRIGGER_PATTERN,
  CODEX_TRIGGER_REMOVED_MARKER,
  escapeInvisibleCharactersVisibly,
  MAX_SANITIZED_STEP_SUMMARY_FIELD_LENGTH,
  neutralizeCodexTriggerPhrases,
  safeClamp,
  sanitizeUntrustedInlineText,
  sanitizeUntrustedTextForPostedBody,
} from "../../scripts/factory/untrusted-text.mts";

/**
 * The round-3 oracle: a truncation must not RESYNTHESISE a live `@codex`.
 * Strip any invisible/default-ignorable char (so a zero-width split can't
 * hide one), then assert no contiguous `@codex`/`＠codex`. The inert marker
 * `[codex trigger removed]` contains "codex" but never "@codex", so it does
 * not trip this.
 */
function expectNoResynthesizedTrigger(output: string): void {
  const withoutInvisibles = output.replace(/[\p{C}\p{Default_Ignorable_Code_Point}]/gu, "");
  expect(/[@＠]codex/iu.test(withoutInvisibles)).toBe(false);
}

/**
 * A live Codex trigger surviving into a POSTED body is the bug #158 closes.
 * `expectNoLiveTrigger` asserts the sanitised output can no longer read as
 * `@…codex` to the connector, using a FRESH, non-global literal — never the
 * module's own stateful `g`-flag pattern, and never a regex derived from it,
 * so mutating `CODEX_TRIGGER_PATTERN` cannot also weaken this check.
 */
const LIVE_TRIGGER = /[@＠]\s*codex/iu;
function expectNoLiveTrigger(output: string): void {
  expect(LIVE_TRIGGER.test(output)).toBe(false);
}

describe("issue #158: no Codex-trigger variant survives sanitizeUntrustedTextForPostedBody", () => {
  // The posted-body path (neutralize -> escape -> collapse -> strip -> clamp
  // -> span) is the real interpolation site, so the matrix runs through the
  // whole sanitiser, not just the trigger step.
  it.each([
    ["T1 canonical", "@codex review"],
    ["T2 mixed case", "@Codex review"],
    ["T3 upper case", "@CODEX REVIEW"],
    ["T4 double space before codex", "@  codex review"],
    ["T5 newline split", "@codex\nreview"],
    ["T6 tab split", "@codex\treview"],
    ["T7 space after @", "@ codex review"],
    ["T8 bare @codex", "@codex"],
    ["T9 twice (g-flag)", "@codex a @codex b"],
    ["T12 @codex-review (\\b)", "@codex-review"],
    ["T13 fullwidth ＠ (decision 4)", "＠codex review"],
  ])("%s -> no live trigger in the posted body", (_label, input) => {
    expectNoLiveTrigger(sanitizeUntrustedTextForPostedBody(input));
  });

  it("T10: a zero-width split (@<ZWSP>codex) is defanged AND surfaced as a visible [U+200B]", () => {
    // JS `\s` misses U+200B, so the trigger step can't see this one — the
    // escape step is what renders it inert by making the hidden char visible,
    // splitting `@` from `codex` with literal marker text.
    const output = sanitizeUntrustedTextForPostedBody("@\u200Bcodex review");
    expectNoLiveTrigger(output);
    expect(output).toContain("[U+200B]");
  });

  it("T11: an NBSP split (@<NBSP>codex) is neutralised (NBSP is \\s, so the trigger step catches it)", () => {
    expectNoLiveTrigger(sanitizeUntrustedTextForPostedBody("@\u00A0codex review"));
  });
});

describe("neutralizeCodexTriggerPhrases", () => {
  it("replaces the trigger with the inert marker (the pattern consumes @codex; the bare word review is harmless)", () => {
    expect(neutralizeCodexTriggerPhrases("please @codex review this")).toBe(
      `please ${CODEX_TRIGGER_REMOVED_MARKER} review this`,
    );
  });

  it("rewrites EVERY occurrence, not just the first (g-flag)", () => {
    expect(neutralizeCodexTriggerPhrases("@codex a @codex b")).toBe(
      `${CODEX_TRIGGER_REMOVED_MARKER} a ${CODEX_TRIGGER_REMOVED_MARKER} b`,
    );
  });

  it("leaves a different mention (@codexfoo) untouched — the \\b keeps the boundary (G5)", () => {
    // `@codexfoo` is a mention of a DIFFERENT user, not the trigger phrase, so
    // the `\b` must keep neutralize from rewriting it (false-positive guard).
    expect(neutralizeCodexTriggerPhrases("@codexfoo shipped")).toBe("@codexfoo shipped");
  });

  it("N5: the removed-trigger marker does not itself match the pattern (no re-trigger)", () => {
    expect(LIVE_TRIGGER.test(CODEX_TRIGGER_REMOVED_MARKER)).toBe(false);
    // The module pattern is global (stateful), so compare with a fresh
    // non-global clone rather than calling `.test()` on the shared instance.
    const fresh = new RegExp(CODEX_TRIGGER_PATTERN.source, "iu");
    expect(fresh.test(CODEX_TRIGGER_REMOVED_MARKER)).toBe(false);
    // Neutralising the marker is therefore a fixpoint.
    expect(neutralizeCodexTriggerPhrases(CODEX_TRIGGER_REMOVED_MARKER)).toBe(
      CODEX_TRIGGER_REMOVED_MARKER,
    );
  });
});

describe("escapeInvisibleCharactersVisibly (in the untrusted-text leaf)", () => {
  it("renders a control character as a visible [U+XXXX] marker", () => {
    expect(escapeInvisibleCharactersVisibly("a\u0000b")).toBe("a[U+0000]b");
  });

  it("renders a Trojan-Source bidi override visibly instead of hiding it", () => {
    expect(escapeInvisibleCharactersVisibly("x\u202Ey")).toBe("x[U+202E]y");
  });

  it("preserves ordinary ASCII whitespace (space, tab, LF, CR) verbatim", () => {
    expect(escapeInvisibleCharactersVisibly("a b\tc\nd\re")).toBe("a b\tc\nd\re");
  });
});

describe("sanitizeUntrustedTextForPostedBody (posted-body sanitiser, #158 rename of sanitizeStepSummary text)", () => {
  it("wraps the value in a single-backtick inline code span", () => {
    expect(sanitizeUntrustedTextForPostedBody("plain text")).toBe("`plain text`");
  });

  it("collapses newlines to a space before wrapping", () => {
    expect(sanitizeUntrustedTextForPostedBody("line one\nline two\r\nline three")).toBe(
      "`line one line two line three`",
    );
  });

  it("strips backticks before wrapping (so the value can't break out of its own code span)", () => {
    expect(sanitizeUntrustedTextForPostedBody("a `dangerous` value")).toBe("`a dangerous value`");
  });

  it("preserves brackets/parens/angle-brackets/backslashes VERBATIM — a code span renders them literally", () => {
    expect(sanitizeUntrustedTextForPostedBody("roastpilot-factory[bot]")).toBe(
      "`roastpilot-factory[bot]`",
    );
    expect(sanitizeUntrustedTextForPostedBody("the mint step failed (outcome=failure)")).toBe(
      "`the mint step failed (outcome=failure)`",
    );
    expect(sanitizeUntrustedTextForPostedBody("a\\b")).toBe("`a\\b`");
  });

  it("renders a [text](url) link-injection attempt as inert text, not a live link", () => {
    const malicious = ".github/workflows/[x](https://attacker.example).yml";
    // Inside a code span GitHub renders NOTHING as Markdown, so the raw
    // sequence is literal text, not a parsed link.
    expect(sanitizeUntrustedTextForPostedBody(malicious)).toBe(`\`${malicious}\``);
  });

  it("renders a BARE autolink-shaped URL as inert text — escaping alone never closes this, code spans do", () => {
    expect(sanitizeUntrustedTextForPostedBody("see www.attacker.example for details")).toBe(
      "`see www.attacker.example for details`",
    );
  });

  it("N4: trigger-free, invisible-free text is unchanged apart from the surrounding span", () => {
    const clean = "patch touches .github/workflows/x.yml, empty diff (outcome=failure)";
    expect(sanitizeUntrustedTextForPostedBody(clean)).toBe(`\`${clean}\``);
  });

  it("clamps to 200 characters (before wrapping) with an ellipsis", () => {
    const long = "x".repeat(250);
    const result = sanitizeUntrustedTextForPostedBody(long);
    // MAX chars + the ellipsis + the two wrapping backticks.
    expect(result.length).toBe(MAX_SANITIZED_STEP_SUMMARY_FIELD_LENGTH + 3);
    expect(result.startsWith("`")).toBe(true);
    expect(result.endsWith("…`")).toBe(true);
  });

  it("does not clamp a value at or under the limit", () => {
    const exact = "x".repeat(MAX_SANITIZED_STEP_SUMMARY_FIELD_LENGTH);
    expect(sanitizeUntrustedTextForPostedBody(exact)).toBe(`\`${exact}\``);
  });

  it("neutralises the trigger BEFORE clamping — truncation can't resurrect it", () => {
    const output = sanitizeUntrustedTextForPostedBody(`${"y".repeat(198)} @codex review`);
    expectNoLiveTrigger(output);
  });
});

describe("issue #158 fold: a backtick-split trigger cannot be RECONSTRUCTED by backtick-stripping (neutralise runs LAST)", () => {
  // The factory-security-reviewer BLOCKER: with neutralise BEFORE strip, a
  // backtick between `@` and `codex` slips the pattern (a backtick is not
  // `\s`), then the strip rejoins `@codex` LIVE inside the wrapping span.
  // Running neutralise AFTER every removal transform closes it.
  it.each([
    ["backtick between @ and codex", "@`codex review"],
    ["backtick inside the word", "@co`dex review"],
    ["backtick between every letter", "@`c`o`d`e`x review"],
  ])("%s -> defanged in both the body and the plain-text (title) primitive", (_label, input) => {
    const body = sanitizeUntrustedTextForPostedBody(input);
    expectNoLiveTrigger(body);
    expect(body).not.toContain("@codex");

    const inline = sanitizeUntrustedInlineText(input);
    expectNoLiveTrigger(inline);
    expect(inline).not.toContain("@codex");
  });
});

describe("sanitizeUntrustedInlineText (shared plain-text primitive — title path and body sanitiser both call it)", () => {
  it("returns inert plain text with NO surrounding code span (a title is not Markdown)", () => {
    expect(sanitizeUntrustedInlineText("plain text")).toBe("plain text");
  });

  it("escapes invisibles, collapses newlines, strips backticks, and neutralises the trigger", () => {
    expect(sanitizeUntrustedInlineText("a `b`\nc @codex review")).toBe(
      "a b c [codex trigger removed] review",
    );
  });

  it("is the exact defanged core the body sanitiser wraps and clamps", () => {
    const value = "reason: @codex review touched `x`";
    expect(sanitizeUntrustedTextForPostedBody(value)).toBe(
      `\`${sanitizeUntrustedInlineText(value)}\``,
    );
  });
});

describe("issue #158 fold round 3: a length clamp cannot RESYNTHESISE a live trigger at the truncated tail", () => {
  const PAD = "a".repeat(194);

  it.each([
    ["@codexx (word char after codex)", "@codexx"],
    ["@codexcodex", "@codexcodex"],
    ["@codexZ", "@codexZ"],
    ["@codex9", "@codex9"],
    ["@codexreview (no space)", "@codexreview"],
    ["＠codexx (fullwidth @)", "＠codexx"],
  ])("clamps `PAD + %s` without leaving `@codex` at the tail", (_label, suffix) => {
    // `@codexWORD` is a benign different mention the `\b` deliberately skips,
    // so neutralize leaves it — but a naive slice to 200 truncates the WORD,
    // manufacturing `@codex…` at the tail. safeClamp strips that fragment.
    expectNoResynthesizedTrigger(sanitizeUntrustedTextForPostedBody(PAD + suffix));
  });

  it("marker-growth boundary: expanded `@codex ` markers shift a trailing `@codexx` onto the cut", () => {
    // Each `@codex ` neutralises to a LONGER marker, so the trailing
    // `@codexWORD` lands at the truncation boundary — safeClamp runs AFTER
    // neutralize (on the expanded string), so it still cleans the real tail.
    const input = "@codex ".repeat(28) + "@codexx";
    const output = sanitizeUntrustedTextForPostedBody(input);
    expectNoResynthesizedTrigger(output);
    // and the length bound still holds (200 content + ellipsis + 2 backticks).
    expect(output.length).toBeLessThanOrEqual(MAX_SANITIZED_STEP_SUMMARY_FIELD_LENGTH + 3);
  });
});

describe("safeClamp", () => {
  it("returns a value already within bound unchanged (no ellipsis)", () => {
    expect(safeClamp("short value", 200)).toBe("short value");
    expect(safeClamp("x".repeat(200), 200)).toBe("x".repeat(200));
  });

  it("truncates with a trailing ellipsis (result is at most maxLength + 1)", () => {
    const result = safeClamp("x".repeat(250), 200);
    expect(result.length).toBe(201);
    expect(result.endsWith("…")).toBe(true);
  });

  it("strips a trailing `@codex` fragment the truncation manufactured", () => {
    const result = safeClamp("a".repeat(194) + "@codexx", 200);
    expect(result).toBe("a".repeat(194) + "…");
    expect(result).not.toContain("@codex");
  });

  it("strips a trailing PARTIAL `[U+XXXX` escape marker rather than splitting it", () => {
    // 196 z + the 8-char marker `[U+FE0F]` = 204 chars; slicing to 200 cuts
    // the marker to `[U+F`, which safeClamp removes so no half-marker survives.
    const result = safeClamp("z".repeat(196) + "[U+FE0F]", 200);
    expect(result).not.toMatch(/\[U\+[0-9A-F]*$/);
    expect(result.endsWith("…")).toBe(true);
  });

  it("leaves a COMPLETE trailing `[U+XXXX]` marker intact", () => {
    // Landing exactly after the closing `]` must not strip a valid marker.
    expect(safeClamp("y".repeat(192) + "[U+FE0F]", 200)).toBe("y".repeat(192) + "[U+FE0F]");
  });
});

describe("issue #158 fold round 3: availability negatives (over-clamping must not eat legitimate content)", () => {
  it("a legitimate <=200-char field is only escaped, never truncated", () => {
    const legit = "patch touches lib/foo.ts and lib/bar.ts (200-char safe reason)";
    expect(sanitizeUntrustedTextForPostedBody(legit)).toBe(`\`${legit}\``);
  });

  it("a legitimate non-trigger `@` mention survives", () => {
    expect(sanitizeUntrustedTextForPostedBody("ping @syamaner please")).toBe(
      "`ping @syamaner please`",
    );
    expect(sanitizeUntrustedInlineText("ping @syamaner please")).toBe("ping @syamaner please");
  });
});

describe("G14: the untrusted-text leaf stays import-free", () => {
  it("contains no import statement (that is what keeps the verifier's closure minimal)", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../scripts/factory/untrusted-text.mts", import.meta.url)),
      "utf8",
    );
    // Strip comments first so the word "import" inside the module's own
    // docstrings can never false-positive this guard.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    expect(/\bimport\b/.test(code)).toBe(false);
    expect(/\brequire\s*\(/.test(code)).toBe(false);
  });
});
