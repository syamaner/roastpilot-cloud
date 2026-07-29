import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CODEX_TRIGGER_PATTERN,
  CODEX_TRIGGER_REMOVED_MARKER,
  escapeInvisibleCharactersVisibly,
  MAX_SANITIZED_STEP_SUMMARY_FIELD_LENGTH,
  neutralizeCodexTriggerPhrases,
  renderBoundedUntrustedMultilineBlock,
  renderBoundedUntrustedReason,
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
 * A lone (unpaired) UTF-16 surrogate is not representable in wire UTF-8, so a
 * JSON body carrying one can be rejected by GitHub AFTER the branch is pushed
 * (#158 fold, PR #170). Assert neither an unpaired high nor an unpaired low
 * surrogate survives a clamp.
 */
function expectNoLoneSurrogate(output: string): void {
  expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(output)).toBe(false);
  expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(output)).toBe(false);
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

  it("escapes a lone HIGH and a lone LOW surrogate to a visible marker (Cs ⊂ \\p{C})", () => {
    // Pins the load-bearing invariant that inline() output is ALWAYS
    // well-formed UTF-16: a future narrowing of UNTRUSTED_DATA_BREAKOUT_PATTERN
    // away from \p{C} would silently reopen the surrogate class (fsr note).
    expect(escapeInvisibleCharactersVisibly("a\uD83Db")).toBe("a[U+D83D]b");
    expect(escapeInvisibleCharactersVisibly("a\uDE00b")).toBe("a[U+DE00]b");
  });
});

describe("renderBoundedUntrustedReason (non-silent bounded reason render — PR #170 Codex P1)", () => {
  it("returns a within-bound reason in full, in a code span, with no disclosure", () => {
    expect(renderBoundedUntrustedReason("empty patch (no changes)", 8000)).toBe(
      "`empty patch (no changes)`",
    );
  });

  it("defangs a trigger in the reason (no live @codex, marker present)", () => {
    const out = renderBoundedUntrustedReason("blocked: @codex review this", 8000);
    expectNoLiveTrigger(out);
    expect(out).toContain("[codex trigger removed]");
  });

  it("truncates an oversized reason WITH an explicit non-silent disclosure naming the omitted count", () => {
    const out = renderBoundedUntrustedReason("x".repeat(9000), 8000);
    expect(out).toMatch(
      /^`x{8000}` _\[truncated, 1000 character\(s\) omitted — full detail in the run output\]_$/,
    );
  });

  it("a truncation at the reason boundary cannot resynthesise a trigger (@codexx at the cut)", () => {
    const out = renderBoundedUntrustedReason("a".repeat(7999) + "@codexx", 8000);
    // strip the disclosure suffix, then assert no contiguous @codex in the span
    expectNoResynthesizedTrigger(out.replace(/_\[truncated[\s\S]*$/, ""));
  });

  it("discloses the REAL omitted count, including chars removed by the tail strip (qa finding)", () => {
    // 7994 'a' + '@codex' + 50 'Z' = 8050 code points; slice to 8000 keeps
    // `…a@codex`, and the trigger-fragment strip removes `@codex` too — so the
    // true gap is 56 (50 truncated + 6 stripped), not the naive 8050 - 8000.
    const out = renderBoundedUntrustedReason("a".repeat(7994) + "@codex" + "Z".repeat(50), 8000);
    expect(out).toContain(
      "_[truncated, 56 character(s) omitted — full detail in the run output]_",
    );
    // and the manufactured `@codex` did not survive into the span.
    expectNoResynthesizedTrigger(out.replace(/_\[truncated[\s\S]*$/, ""));
  });

  it("counts by CODE POINTS, never splitting an astral char (no lone surrogate)", () => {
    const out = renderBoundedUntrustedReason("😀".repeat(9000), 8000);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(out)).toBe(false);
  });

  it("T17: a custom fullDetailLocation literal is interpolated into the disclosure suffix", () => {
    const out = renderBoundedUntrustedReason(
      "x".repeat(600),
      500,
      "the uploaded verdict artifact",
    );
    expect(out).toBe(
      `\`${"x".repeat(500)}\` _[truncated, 100 character(s) omitted — full detail in the uploaded verdict artifact]_`,
    );
  });

  it("T17: the omitted count is still computed AFTER the tail strip when a custom location is passed", () => {
    // 494 'a' + '@codex' + 50 'Z' = 550 code points; slice to 500 keeps
    // `…a@codex`, the trigger-fragment strip removes `@codex` (6), so the true
    // gap is 56 (50 truncated + 6 stripped), not the naive 550 - 500 = 50.
    const out = renderBoundedUntrustedReason(
      "a".repeat(494) + "@codex" + "Z".repeat(50),
      500,
      "the run log and the uploaded artifacts",
    );
    expect(out).toContain(
      "_[truncated, 56 character(s) omitted — full detail in the run log and the uploaded artifacts]_",
    );
    expectNoResynthesizedTrigger(out.replace(/_\[truncated[\s\S]*$/, ""));
  });

  it("T17: omitting fullDetailLocation is byte-identical to passing the default (slice-1 callers unchanged)", () => {
    const oversized = "x".repeat(9000);
    expect(renderBoundedUntrustedReason(oversized, 8000)).toBe(
      renderBoundedUntrustedReason(oversized, 8000, "the run output"),
    );
    const withinBound = "empty patch (no changes)";
    expect(renderBoundedUntrustedReason(withinBound, 8000)).toBe(
      renderBoundedUntrustedReason(withinBound, 8000, "the run output"),
    );
  });
});

describe("renderBoundedUntrustedMultilineBlock (multi-line fenced render — #158 slice 3, triage reasoning)", () => {
  const BIG = 32_000;

  /** The literal content BETWEEN the opening ` ```text\n ` and the trailing fence. */
  function fencedContent(output: string): string {
    const match = /^```text\n([\s\S]*)\n```(?:\n_\[truncated[\s\S]*)?$/.exec(output);
    if (match === null) throw new Error(`not a text fence: ${JSON.stringify(output)}`);
    return match[1] as string;
  }

  it("T1: preserves a multi-line block byte-identically inside the fence (newlines NOT collapsed)", () => {
    // The whole reason this primitive exists rather than the single-line span:
    // the reason prose keeps its line breaks.
    const reasoning = "Plan link present.\nAcceptance criteria present.\nScope and size OK.";
    expect(renderBoundedUntrustedMultilineBlock(reasoning, BIG, "the run log")).toBe(
      "```text\nPlan link present.\nAcceptance criteria present.\nScope and size OK.\n```",
    );
  });

  it("T3: an interior and a CROSS-LINE @codex trigger are both neutralised inside the fence", () => {
    const out = renderBoundedUntrustedMultilineBlock(
      "please @codex review this\nand also @\ncodex again",
      BIG,
      "the run log",
    );
    expectNoLiveTrigger(out);
    expect(out).toContain("[codex trigger removed]");
  });

  it("T4: NO backtick survives between the trusted fences (fence-escape + backtick-split closed)", () => {
    const out = renderBoundedUntrustedMultilineBlock(
      "single `tick`\n```\nfenced\n```\n````js\nfour\n````\n   ```indented",
      BIG,
      "the run log",
    );
    expect(fencedContent(out)).not.toContain("`");
  });

  it("T5: a tilde fence at a line start is defused; an interior ~~~ is left intact", () => {
    const out = renderBoundedUntrustedMultilineBlock(
      "~~~\nfenced\n~~~~~\n   ~~~ indented\n\r~~~ after CR\nkeep a~~~b interior",
      BIG,
      "the run log",
    );
    const content = fencedContent(out);
    // No line in the content still opens with a 3+-tilde fence run.
    expect(content.split("\n").some((line) => /^ {0,3}~{3,}/.test(line))).toBe(false);
    // The interior (non-line-start) run is untouched.
    expect(content).toContain("a~~~b");
  });

  it("T6: bidi/zero-width/NEL are surfaced as [U+XXXX]; a lone surrogate does not crash or survive", () => {
    const out = renderBoundedUntrustedMultilineBlock(
      "a\u202Eb\u200Bc\u0085d\uD83De",
      BIG,
      "the run log",
    );
    expect(out).toContain("[U+202E]");
    expect(out).toContain("[U+200B]");
    expect(out).toContain("[U+0085]");
    expect(out).toContain("[U+D83D]");
    expectNoLoneSurrogate(out);
  });

  it("T7: an over-budget block is truncated, tail-stripped, and discloses the count AFTER the strip", () => {
    const out = renderBoundedUntrustedMultilineBlock("x".repeat(50), 10, "the run log");
    expect(out).toBe(
      "```text\nxxxxxxxxxx\n```\n_[truncated, 40 character(s) omitted — full detail in the run log]_",
    );
  });

  it("T7: a truncation at the block boundary cannot resynthesise a trigger and counts the stripped chars", () => {
    // 494 'a' + '@codex' + 50 'Z' = 550 code points; slice to 500 keeps `…a@codex`,
    // the trigger-fragment strip removes `@codex` (6), so the true gap is 56.
    const out = renderBoundedUntrustedMultilineBlock(
      "a".repeat(494) + "@codex" + "Z".repeat(50),
      500,
      "the run log",
    );
    expect(out).toContain(
      "_[truncated, 56 character(s) omitted — full detail in the run log]_",
    );
    expectNoResynthesizedTrigger(out.replace(/\n```\n_\[truncated[\s\S]*$/, ""));
  });

  it("T8: exactly-at-budget content renders in full with no disclosure", () => {
    const out = renderBoundedUntrustedMultilineBlock("abcde", 5, "the run log");
    expect(out).toBe("```text\nabcde\n```");
    expect(out).not.toContain("truncated");
  });

  it("T8: 4000 BMP invisibles expand to exactly the 32,000-cp budget and render in FULL (derivation)", () => {
    // The MAX_RENDERED_REASONING_CODE_POINTS=32_000 derivation: a schema-valid
    // reasoning is <= 4000 code units; the worst-case ×8 defang (a BMP
    // default-ignorable -> `[U+XXXX]`, 8 chars) hits the budget exactly, so no
    // schema-valid verdict ever truncates. The repeated char is a \u200B
    // ZWSP escape, never a literal (the guard forbids literal default-ignorables).
    const out = renderBoundedUntrustedMultilineBlock("\u200B".repeat(4000), BIG, "the run log");
    expect(out).toBe("```text\n" + "[U+200B]".repeat(4000) + "\n```");
    expect(out).not.toContain("truncated");
  });

  it("T13: a backtick-split @`codex is reconstructed by the strip and then neutralised (order proof)", () => {
    const out = renderBoundedUntrustedMultilineBlock("@`codex review", BIG, "the run log");
    expectNoLiveTrigger(out);
    expect(fencedContent(out)).not.toContain("@codex");
  });

  it("T14: an embedded triage-marker-shaped comment stays inside the fence (terminal extractors unaffected)", () => {
    const spoof = "<!-- roastpilot-factory:triage-verdict:do-not-edit -->";
    const out = renderBoundedUntrustedMultilineBlock(`prefix\n${spoof}\nsuffix`, BIG, "the run log");
    // The spoof marker is not at the END of the rendered string — it sits before
    // the closing fence, so the `$`-anchored / endsWith consumers never match it.
    expect(out.endsWith(spoof)).toBe(false);
    expect(out.endsWith("```")).toBe(true);
    expect(fencedContent(out)).toContain(spoof);
  });

  it("N4: markdown-ish prose (no backticks) is byte-identical inside the fence", () => {
    const prose = "## Plan\n- item one\n- item two\n> a quoted line\n**bold** and _italic_";
    expect(fencedContent(renderBoundedUntrustedMultilineBlock(prose, BIG, "the run log"))).toBe(prose);
  });

  it("N5: backticks-only content collapses to an empty fence without throwing", () => {
    expect(renderBoundedUntrustedMultilineBlock("```", BIG, "the run log")).toBe("```text\n\n```");
  });

  it("counts by CODE POINTS, never splitting an astral char (no lone surrogate at the cut)", () => {
    const out = renderBoundedUntrustedMultilineBlock("😀".repeat(50), 10, "the run log");
    expectNoLoneSurrogate(out);
  });

  it("omitting fullDetailLocation is byte-identical to passing the default", () => {
    const oversized = "y".repeat(40);
    expect(renderBoundedUntrustedMultilineBlock(oversized, 10)).toBe(
      renderBoundedUntrustedMultilineBlock(oversized, 10, "the run output"),
    );
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

  it("leaves a COMPLETE trailing `[U+XXXX]` marker intact when the cut lands right after its `]`", () => {
    // The input must EXCEED maxLength so the truncation/strip path actually
    // runs (an exactly-200-char input would hit the within-bound early return
    // and the test would pass vacuously — qa finding). Here the cut at 200
    // lands right after the marker's closing `]` (y*192 + `[U+FE0F]` = 200),
    // so the partial-marker strip must NOT fire (the tail ends in `]`, not
    // mid-hex) and the complete marker survives; only the excess `tail` drops.
    const result = safeClamp("y".repeat(192) + "[U+FE0F]" + "tail", 200);
    expect(result).toBe("y".repeat(192) + "[U+FE0F]…");
    expect(result).toContain("[U+FE0F]");
    expect(result.endsWith("…")).toBe(true);
    // Length 201 (200 content + `…`) proves the truncation path ran, not the
    // vacuous early return.
    expect(result.length).toBe(201);
  });
});

describe("issue #158 fold (PR #170): a clamp cannot split an astral char into a lone surrogate", () => {
  it("strips the lone high surrogate a slice leaves when it cuts an emoji in half", () => {
    // Codex P2 reproduction: 199 ASCII + emoji, clamped to 200, cuts the first
    // emoji mid-pair. Without the strip the tail is a lone `\uD83D`.
    const result = safeClamp("a".repeat(199) + "😀".repeat(10), 200);
    expectNoLoneSurrogate(result);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(201);
  });

  it("handles an emoji-then-partial-marker tail (strip order: marker then surrogate)", () => {
    // Cut lands inside `[U+FE0F]` (leaving `[U+F`) with a COMPLETE emoji just
    // before it: the partial-marker strip fires, the emoji stays whole, and no
    // lone surrogate is left.
    const result = safeClamp("z".repeat(194) + "😀[U+FE0F]", 200);
    expectNoLoneSurrogate(result);
    expect(result).not.toMatch(/\[U\+[0-9A-F]*$/);
    expect(result).toContain("😀");
    expect(result.endsWith("…")).toBe(true);
  });

  it("body path: an astral-heavy field yields no lone surrogate", () => {
    expectNoLoneSurrogate(sanitizeUntrustedTextForPostedBody("😀".repeat(150)));
  });

  it("leaves a complete astral char intact when the cut lands on a pair boundary", () => {
    // 200 code units of emoji = exactly 100 complete pairs; the 200th unit is a
    // low surrogate whose high partner is present, so nothing is stripped.
    const result = safeClamp("😀".repeat(150), 200);
    expectNoLoneSurrogate(result);
    expect(result.endsWith("😀…")).toBe(true);
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
