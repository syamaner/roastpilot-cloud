import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CI_SKIP_TOKEN_REMOVED_MARKER,
  CODEX_TRIGGER_PATTERN,
  CODEX_TRIGGER_REMOVED_MARKER,
  escapeInvisibleCharactersVisibly,
  findCiSkipDirectives,
  MAX_SANITIZED_STEP_SUMMARY_FIELD_LENGTH,
  neutralizeCiSkipDirectives,
  neutralizeCodexTriggerPhrases,
  renderBoundedUntrustedMultilineBlock,
  renderBoundedUntrustedReason,
  sanitizeAndClampUntrustedInlineText,
  sanitizeAndClampUntrustedTextForCommitMessage,
  sanitizeUntrustedInlineText,
  sanitizeUntrustedTextForCommitMessage,
  sanitizeUntrustedTextForPostedBody,
} from "../../scripts/factory/untrusted-text.mts";
import * as untrustedTextModule from "../../scripts/factory/untrusted-text.mts";
import {
  expectNoLiveTrigger,
  expectNoResynthesizedTrigger,
  hasLiveTrigger,
} from "./support/live-trigger-oracle";

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

  it("N5 / H12: the removed-trigger marker does not itself match the pattern (no re-trigger, fixpoint)", () => {
    // Fold-aware oracle: the marker is inert on the raw AND the folded view.
    expect(hasLiveTrigger(CODEX_TRIGGER_REMOVED_MARKER)).toBe(false);
    // The module pattern is global (stateful), so compare with a fresh
    // non-global clone rather than calling `.test()` on the shared instance.
    const fresh = new RegExp(CODEX_TRIGGER_PATTERN.source, "iu");
    expect(fresh.test(CODEX_TRIGGER_REMOVED_MARKER)).toBe(false);
    // H12: neutralising the marker is a fixpoint, under BOTH passes now (the
    // folded view of the marker carries no `@…codex` either).
    expect(neutralizeCodexTriggerPhrases(CODEX_TRIGGER_REMOVED_MARKER)).toBe(
      CODEX_TRIGGER_REMOVED_MARKER,
    );
    expect(
      neutralizeCodexTriggerPhrases(neutralizeCodexTriggerPhrases("@ｃodex review")),
    ).toBe(neutralizeCodexTriggerPhrases("@ｃodex review"));
  });
});

describe("O1: the shared fold-aware trigger oracle is not itself fooled by a homoglyph (G8)", () => {
  // The oracle is the thing that has to detect the bug; a weakened (ASCII-only)
  // oracle would green-light a live `@ｃodex`. It shares NO code with the module.
  it.each([
    ["@codex", "@codex"],
    ["＠codex (fullwidth @)", "＠codex"],
    ["﹫ codex (U+FE6B small @ — the [@＠] enumeration misses it)", "﹫ codex"],
    ["@ｃodex (U+FF43 fullwidth c)", "@ｃodex"],
    ["@\\u{1D41C}odex (astral bold c)", "@\u{1D41C}odex"],
  ])("flags %s as a live trigger", (_label, input) => {
    expect(hasLiveTrigger(input)).toBe(true);
  });

  it.each([
    ["the inert removed-trigger marker", CODEX_TRIGGER_REMOVED_MARKER],
    ["ordinary prose (no @)", "please review the codebase for me"],
    ["a bare word 'codex' with no @", "the codex handbook is on the shelf"],
  ])("does NOT flag %s", (_label, input) => {
    expect(hasLiveTrigger(input)).toBe(false);
  });
});

describe("#168: a homoglyph Codex-trigger variant is folded, detected, and neutralised (emitted text never normalised)", () => {
  const MARKER = CODEX_TRIGGER_REMOVED_MARKER;

  // Each row asserts BOTH no live trigger survives the fold-aware oracle AND
  // the inert marker is present, so the fold genuinely detected + replaced it
  // (a positive assertion that fails loudly on a wrong NFKC assumption).
  it.each([
    ["H1 @ｃodex review (U+FF43, live at HEAD)", "@ｃodex review"],
    ["H2 ＠ｃｏｄｅｘ review (all fullwidth)", "＠ｃｏｄｅｘ review"],
    ["H3 @ｃｏｄｅｘ (fullwidth word, bare)", "@ｃｏｄｅｘ"],
    ["H4 @cｏdex (single fullwidth o)", "@cｏdex"],
    ["H5 ＠ ｃodex (fullwidth @ + space)", "＠ ｃodex"],
    ["H6 @\\u{1D41C}odex (astral bold c)", "@\u{1D41C}odex"],
    ["H7 @ⓒodex (circled c)", "@ⓒodex"],
    ["H8 ﹫ codex review (U+FE6B — the enumeration-miss, live at HEAD)", "﹫ codex review"],
    ["H9 @Ｃodex (fullwidth uppercase C)", "@Ｃodex"],
    ["H10 ＠ＣＯＤＥＸ (fullwidth uppercase word)", "＠ＣＯＤＥＸ"],
  ])("%s: neutralise emits the marker + no live trigger; the body path stays trigger-free (G1)", (_label, input) => {
    const neutralised = neutralizeCodexTriggerPhrases(input);
    expect(neutralised).toContain(MARKER);
    expectNoLiveTrigger(neutralised);
    expectNoLiveTrigger(sanitizeUntrustedTextForPostedBody(input));
  });

  it("H11: monotonicity — a raw-view-only trigger (`@codexｘ`, U+FF58 word-continuation) stays neutralised (G2)", () => {
    // Pass 1's raw `\b` catches `@codex` before the fullwidth x; the fold view
    // would see `@codexx` (no boundary) and miss it, so RETAINING pass 1 is
    // what keeps this neutralised.
    const out = neutralizeCodexTriggerPhrases("@codexｘ");
    expect(out).toContain(MARKER);
    expectNoLiveTrigger(out);
  });

  it("H13: both bounded renderers inherit the fold detection with no per-call change", () => {
    const reason = renderBoundedUntrustedReason("blocked: @ｃodex review", 8000);
    expect(reason).toContain(MARKER);
    expectNoLiveTrigger(reason);
    const block = renderBoundedUntrustedMultilineBlock("line\n@ｃodex review\nmore", 32_000, "the run log");
    expect(block).toContain(MARKER);
    expectNoLiveTrigger(block);
  });

  it("H14: the commit-message sanitiser inherits the fold detection", () => {
    const out = sanitizeUntrustedTextForCommitMessage("[F1-S3] @ｃodex review this");
    expect(out).toContain(MARKER);
    expectNoLiveTrigger(out);
  });

  it("H15: a homoglyph DIFFERENT mention (`@ｃodexfoo`) is left byte-identical (the \\b false-positive guard)", () => {
    expect(neutralizeCodexTriggerPhrases("@ｃodexfoo shipped")).toBe("@ｃodexfoo shipped");
  });

  it("H16: a compat/homoglyph corpus passes through the emit paths byte-identically (no NFKC leak)", () => {
    // None of these fold-affected code points is a trigger, so every function's
    // EMITTED text is byte-for-byte the input (modulo the code-span / no-op
    // wrappers) — proof NFKC lives only in the throwaway detection buffer.
    const corpus = "ﬁle ㎏ ① Ⅷ ｱ ½";
    expect(neutralizeCodexTriggerPhrases(corpus)).toBe(corpus);
    expect(sanitizeUntrustedInlineText(corpus)).toBe(corpus);
    expect(escapeInvisibleCharactersVisibly(corpus)).toBe(corpus);
    expect(sanitizeUntrustedTextForPostedBody(corpus)).toBe(`\`${corpus}\``);
    expect(sanitizeUntrustedTextForCommitMessage(corpus)).toBe(corpus);
  });

  it("H16b: the two bounded renderers AND the two #169 clamp wrappers also emit the corpus byte-identically (no NFKC leak on the UNTRUNCATED path)", () => {
    // qa: H16 above covered five emit paths but NOT the renderers or the two new
    // clamp wrappers. The corpus is NFKC-UNSTABLE (`corpus.normalize("NFKC") !==
    // corpus`), so an `.normalize("NFKC")` slipped into ANY of these four
    // functions' untruncated return path would change the output and fail here.
    // Budgets are far above the corpus length, so every call takes the
    // UNTRUNCATED branch (where a leak would otherwise ship silently).
    const corpus = "ﬁle ㎏ ① Ⅷ ｱ ½";
    expect(corpus.normalize("NFKC")).not.toBe(corpus); // guard: the corpus must be NFKC-unstable
    expect(renderBoundedUntrustedReason(corpus, 8000)).toBe(`\`${corpus}\``);
    expect(renderBoundedUntrustedMultilineBlock(corpus, 32_000, "x")).toBe(
      `\`\`\`text\n${corpus}\n\`\`\``,
    );
    expect(sanitizeAndClampUntrustedInlineText(corpus, 200)).toBe(corpus);
    expect(sanitizeAndClampUntrustedTextForCommitMessage(corpus, 200)).toBe(corpus);
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
    const match =
      /^```text\n([\s\S]*)\n```(?:\n_\[(?:truncated|formatting)[\s\S]*)?$/.exec(output);
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

  it("normalises CRLF and bare-CR line endings to LF in the rendered block (pins step 1)", () => {
    // Step 1 (EOL-normalise) is output-normalisation + defence-in-depth, not the
    // sole \r~~~ / @\rcodex guard (those are caught by the tilde-defuse and the
    // neutralise step — JS `/m` anchors at CR and `\s*` spans CR). This pins the
    // \r\n / \r -> \n normalisation so the step is never a silent no-op.
    const out = renderBoundedUntrustedMultilineBlock("a\r\nb\rc\nd", BIG, "the run log");
    expect(fencedContent(out)).toBe("a\nb\nc\nd");
    expect(out).not.toContain("\r");
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

  it("N5: backticks-only content collapses to an empty fence WITH a non-silent formatting-removed disclosure", () => {
    // #174 Codex P2: the empty fence alone would silently drop the whole
    // reasoning; the disclosure points a reader at the full un-stripped value.
    expect(renderBoundedUntrustedMultilineBlock("```", BIG, "the run log")).toBe(
      "```text\n\n```\n_[formatting characters removed for safe rendering — full detail in the run log]_",
    );
  });

  it("#174: interior backticks (not truncated) → inert fenced body + a formatting-removed disclosure to the run log", () => {
    const out = renderBoundedUntrustedMultilineBlock("use `--flag` now", BIG, "the run log");
    expect(fencedContent(out)).toBe("use --flag now");
    expect(fencedContent(out)).not.toContain("`");
    expect(out).toContain(
      "_[formatting characters removed for safe rendering — full detail in the run log]_",
    );
  });

  it("#174: a no-backtick block gets NO formatting-removed disclosure (byte-identical to before)", () => {
    const clean = "no code spans here\njust prose";
    expect(renderBoundedUntrustedMultilineBlock(clean, BIG, "the run log")).toBe(
      `\`\`\`text\n${clean}\n\`\`\``,
    );
    expect(renderBoundedUntrustedMultilineBlock(clean, BIG, "the run log")).not.toContain(
      "formatting characters removed",
    );
  });

  it("#174 r3: tilde-defuse alone (no backticks) fires the class-level safe-rendering disclosure", () => {
    // The r3 case: tilde-defuse reduces `~~~` -> `~~`, a content change the
    // backtick-only check missed. The generalised check catches it.
    const out = renderBoundedUntrustedMultilineBlock("a\n~~~\nb", BIG, "the run log");
    expect(fencedContent(out)).toBe("a\n~~\nb");
    expect(out).toContain(
      "_[formatting characters removed for safe rendering — full detail in the run log]_",
    );
  });

  it("#174 r3: a CRLF-only block is normalised to LF and gets NO disclosure (EOL-normalise is deliberately excluded)", () => {
    // EOL-normalise (step 1) is benign, content-preserving line-ending
    // normalisation — the baseline for the disclosure is the POST-EOL text, so a
    // Windows-line-ending verdict is NOT flagged as modified.
    const out = renderBoundedUntrustedMultilineBlock("a\r\nb", BIG, "the run log");
    expect(out).toBe("```text\na\nb\n```");
    expect(out).not.toContain("formatting characters removed");
  });

  it("#174 r2: truncated AND backticks → BOTH the truncation note AND the formatting-removed note", () => {
    // The truncation count is measured against the POST-strip content (it
    // reports the 40 the LENGTH bound cut, NOT the 5 stripped backticks), so the
    // formatting note must ALSO be present to disclose the strip. Both point at
    // the run log, which holds the full un-stripped value.
    const out = renderBoundedUntrustedMultilineBlock("`".repeat(5) + "x".repeat(50), 10, "the run log");
    expect(out).toContain("_[truncated, 40 character(s) omitted — full detail in the run log]_");
    expect(out).toContain(
      "_[formatting characters removed for safe rendering — full detail in the run log]_",
    );
    expect(fencedContent(out)).toBe("x".repeat(10));
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

  it.each([
    ["H17 @ｃodexx (homoglyph word-continuation)", "@ｃodexx"],
    ["H18 ＠ｃｏｄｅｘＸ (fullwidth word + fullwidth X)", "＠ｃｏｄｅｘＸ"],
  ])("%s: a truncation-manufactured HOMOGLYPH `@codex` at the tail is stripped (G3, fold-view fragment)", (_label, suffix) => {
    // The homoglyph mention is a benign different-mention neutralise leaves; a
    // naive slice truncates the trailing word char, manufacturing a homoglyph
    // `@ｃodex…` the ASCII TRAILING_TRIGGER_FRAGMENT misses — the fold-view tail
    // strip is what removes it.
    expectNoResynthesizedTrigger(sanitizeUntrustedTextForPostedBody(PAD + suffix));
  });

  it("H19: two ADJACENT homoglyph fold fragments at the clamp tail are both stripped (needs the shrink loop)", () => {
    // Post-clamp tail is `@ｃod@ｃo`; a single fold-strip pass removes only the
    // last `@ｃo`, leaving `@ｃod`. The shrink-until-stable loop (G4) strips the
    // exposed `@ｃod` on the next pass.
    const input = "w".repeat(193) + "@ｃod@ｃoMORE";
    expectNoResynthesizedTrigger(sanitizeUntrustedTextForPostedBody(input));
  });

  it("H20: a fold-fragment strip that EXPOSES a dangling `[U+` marker is cleaned by the loop (G4)", () => {
    // Post-clamp tail is a literal `[U+FF@ｃo`; the fold-strip removes `@ｃo`
    // first, EXPOSING the dangling `[U+FF` partial marker, which only a second
    // loop pass (the partial-marker strip) then removes.
    const input = "z".repeat(192) + "[U+FF@ｃoMORE";
    const output = sanitizeUntrustedTextForPostedBody(input);
    expectNoResynthesizedTrigger(output);
    // The exposed literal `[U+FF` partial marker must not survive at the tail.
    expect(output.replace(/…`$/, "")).not.toMatch(/\[U\+[0-9A-F]*$/);
  });

  it.each([
    ["H21 @ｃ (single fold char)", "z".repeat(198) + "@ｃodexReview"],
    ["H21 @ｃo", "z".repeat(197) + "@ｃodexReview"],
    ["H21 ＠ ｃod (fullwidth @ + space)", "z".repeat(195) + "＠ ｃodexReview"],
  ])("%s: a PARTIAL homoglyph fragment at the clamp tail is fold-stripped", (_label, input) => {
    expectNoResynthesizedTrigger(sanitizeUntrustedTextForPostedBody(input));
  });
});

describe("K1 (#169): safeClamp is un-exported; the two composed clamp wrappers are the public surface", () => {
  it("the leaf no longer exports safeClamp", () => {
    expect("safeClamp" in untrustedTextModule).toBe(false);
  });

  it("exposes both sanitise-then-clamp wrappers as functions", () => {
    expect(typeof sanitizeAndClampUntrustedInlineText).toBe("function");
    expect(typeof sanitizeAndClampUntrustedTextForCommitMessage).toBe("function");
  });
});

describe("K2 (#169): each public wrapper NEUTRALISES raw attacker text a bare clamp would pass straight through", () => {
  const wrappers: ReadonlyArray<readonly [string, (value: string) => string]> = [
    ["sanitizeAndClampUntrustedInlineText", (value) => sanitizeAndClampUntrustedInlineText(value, 200)],
    [
      "sanitizeAndClampUntrustedTextForCommitMessage",
      (value) => sanitizeAndClampUntrustedTextForCommitMessage(value, 200),
    ],
  ];

  describe.each(wrappers)("%s", (_name, wrap) => {
    it("neutralises an interior `@codex` trigger (marker present, no live trigger)", () => {
      const out = wrap("blocked: @codex review please");
      expectNoLiveTrigger(out);
      expect(out).toContain(CODEX_TRIGGER_REMOVED_MARKER);
    });

    it("neutralises a backtick-split ``@`codex`` (the backtick strip rejoins it before neutralise)", () => {
      const out = wrap("see @`codex review");
      expectNoLiveTrigger(out);
      expect(out).toContain(CODEX_TRIGGER_REMOVED_MARKER);
    });

    it("defangs a zero-width split `@<ZWSP>codex` by surfacing it visibly", () => {
      // ZWSP as an escape, never a literal — the tracked-file invisible-format
      // guard rejects a literal default-ignorable code point in source.
      const out = wrap("hi @\u200Bcodex review");
      expectNoLiveTrigger(out);
      expect(out).toContain("[U+200B]");
    });

    it("neutralises a HOMOGLYPH `@ｃodex` (the fold detection reaches through the wrapper)", () => {
      const out = wrap("note @ｃodex review");
      expectNoLiveTrigger(out);
      expect(out).toContain(CODEX_TRIGGER_REMOVED_MARKER);
    });
  });
});

describe("K3 (#169): the wrapper composition order is sanitise-THEN-clamp, pinned against the expected literal", () => {
  it("sanitises (expanding invisibles to markers) BEFORE clamping, so a marker is never split by a clamp-first slice", () => {
    // 30 ZWSP escapes each expand to an 8-char `[U+200B]` marker (240 chars),
    // then the clamp bounds to 20 and drops the dangling half-marker -> exactly
    // two whole markers + ellipsis. Clamping FIRST would slice 20 raw ZWSP and
    // then expand to 160 chars of markers — a different, unbounded result.
    const zwsp = "\u200B".repeat(30);
    expect(sanitizeAndClampUntrustedInlineText(zwsp, 20)).toBe("[U+200B][U+200B]…");
    expect(sanitizeAndClampUntrustedTextForCommitMessage(zwsp, 20)).toBe("[U+200B][U+200B]…");
    // The clamp-first order would have been strictly longer than the budget.
    expect(sanitizeAndClampUntrustedInlineText(zwsp, 20).length).toBeLessThanOrEqual(21);
  });
});

describe("K4 (#169): the safeClamp unit behaviours, PORTED onto the public inline wrapper (sanitise is identity on benign input)", () => {
  it("returns a value already within bound unchanged (no ellipsis)", () => {
    expect(sanitizeAndClampUntrustedInlineText("short value", 200)).toBe("short value");
    expect(sanitizeAndClampUntrustedInlineText("x".repeat(200), 200)).toBe("x".repeat(200));
  });

  it("truncates with a trailing ellipsis (result is at most maxLength + 1)", () => {
    const result = sanitizeAndClampUntrustedInlineText("x".repeat(250), 200);
    expect(result.length).toBe(201);
    expect(result.endsWith("…")).toBe(true);
  });

  it("strips a trailing `@codex` fragment the truncation manufactured", () => {
    const result = sanitizeAndClampUntrustedInlineText("a".repeat(194) + "@codexx", 200);
    expect(result).toBe("a".repeat(194) + "…");
    expect(result).not.toContain("@codex");
  });

  it("strips a trailing PARTIAL `[U+XXXX` escape marker rather than splitting it", () => {
    // 196 z + the 8-char LITERAL marker text `[U+FE0F]` = 204 chars; sanitise is
    // identity (no real invisibles), the slice to 200 cuts the marker to `[U+F`,
    // and the clamp removes it so no half-marker survives.
    const result = sanitizeAndClampUntrustedInlineText("z".repeat(196) + "[U+FE0F]", 200);
    expect(result).not.toMatch(/\[U\+[0-9A-F]*$/);
    expect(result.endsWith("…")).toBe(true);
  });

  it("leaves a COMPLETE trailing `[U+XXXX]` marker intact when the cut lands right after its `]` (non-vacuous, length 201)", () => {
    // The input must EXCEED maxLength so the truncation/strip path actually runs
    // (an exactly-200-char input would hit the within-bound early return and the
    // test would pass vacuously — qa finding). Here the cut at 200 lands right
    // after the marker's closing `]` (y*192 + `[U+FE0F]` = 200), so the
    // partial-marker strip must NOT fire and the complete marker survives.
    const result = sanitizeAndClampUntrustedInlineText("y".repeat(192) + "[U+FE0F]" + "tail", 200);
    expect(result).toBe("y".repeat(192) + "[U+FE0F]…");
    expect(result).toContain("[U+FE0F]");
    expect(result.endsWith("…")).toBe(true);
    // Length 201 (200 content + `…`) proves the truncation path ran, not the
    // vacuous early return.
    expect(result.length).toBe(201);
  });
});

describe("K4 (#169): the astral/lone-surrogate clamp behaviours, PORTED onto the public inline wrapper", () => {
  it("strips the lone high surrogate a slice leaves when it cuts an emoji in half", () => {
    // Codex P2 reproduction: 199 ASCII + emoji, clamped to 200, cuts the first
    // emoji mid-pair. Without the strip the tail is a lone `\uD83D`.
    const result = sanitizeAndClampUntrustedInlineText("a".repeat(199) + "😀".repeat(10), 200);
    expectNoLoneSurrogate(result);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(201);
  });

  it("handles an emoji-then-partial-marker tail (strip order: marker then surrogate)", () => {
    // Cut lands inside `[U+FE0F]` (leaving `[U+F`) with a COMPLETE emoji just
    // before it: the partial-marker strip fires, the emoji stays whole, and no
    // lone surrogate is left.
    const result = sanitizeAndClampUntrustedInlineText("z".repeat(194) + "😀[U+FE0F]", 200);
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
    const result = sanitizeAndClampUntrustedInlineText("😀".repeat(150), 200);
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

/**
 * The seven exact spellings GitHub Actions honours in a commit message
 * (verified 2026-07-29). A commit-message sanitiser output that still
 * CONTAINS one of these (case-insensitively) could suppress a required
 * workflow run — the #171 bug. The literal-substring check is deliberately
 * independent of `findCiSkipDirectives` so a bug in the module's own
 * detector cannot mask a bug in its transform; the shared-detector check is
 * an additional belt.
 */
const HONOURED_CI_SKIP_SPELLINGS = [
  "[skip ci]",
  "[ci skip]",
  "[no ci]",
  "[skip actions]",
  "[actions skip]",
  "skip-checks:true",
  "skip-checks: true",
];

function expectNoHonouredCiSkipToken(output: string): void {
  const lower = output.toLowerCase();
  for (const spelling of HONOURED_CI_SKIP_SPELLINGS) {
    expect(lower).not.toContain(spelling.toLowerCase());
  }
  expect(findCiSkipDirectives(output)).toEqual([]);
}

describe("issue #171: CI-skip control tokens neutralised for the commit surface", () => {
  it("L1: neutralises every honoured spelling (bracketed + directive)", () => {
    for (const token of [
      "[skip ci]",
      "[ci skip]",
      "[no ci]",
      "[skip actions]",
      "[actions skip]",
      "skip-checks:true",
      "skip-checks: true",
    ]) {
      const out = sanitizeUntrustedTextForCommitMessage(`fix ${token} thing`);
      expect(out).toContain(CI_SKIP_TOKEN_REMOVED_MARKER);
      expectNoHonouredCiSkipToken(out);
    }
  });

  it("L2: neutralises case variants (GitHub is case-sensitive; our superset is not)", () => {
    for (const token of ["[SKIP CI]", "[Ci Skip]", "[No Ci]", "SKIP-CHECKS:TRUE"]) {
      const out = sanitizeUntrustedTextForCommitMessage(`x ${token} y`);
      expect(out).toContain(CI_SKIP_TOKEN_REMOVED_MARKER);
      expectNoHonouredCiSkipToken(out);
    }
  });

  it("L3: neutralises whitespace/punctuation-obfuscated variants", () => {
    for (const token of [
      "[skip  ci]",
      "[ skip ci ]",
      "[skip-ci]",
      "[skip.ci]",
      "[skip_ci]",
      "[skip\tci]",
      "skip-checks : true",
      "skip-checks:  true",
    ]) {
      const out = sanitizeUntrustedTextForCommitMessage(`x ${token} y`);
      expect(out).toContain(CI_SKIP_TOKEN_REMOVED_MARKER);
      expectNoHonouredCiSkipToken(out);
    }
  });

  it("L4: neutralise runs LAST — a backtick-split token reconstituted by the backtick-strip is still caught (mutation G7 reconstitutes it)", () => {
    // The backtick-strip inside sanitizeUntrustedInlineText runs BEFORE the
    // CI-skip neutralise, so `[skip`ci]` becomes `[skipci]` and is then
    // neutralised. If the neutralise ran first (G7), it would miss the
    // backtick-poisoned key and the later strip would rejoin a live token.
    const bracket = sanitizeUntrustedTextForCommitMessage("ship [skip`ci] now");
    expect(bracket).toContain(CI_SKIP_TOKEN_REMOVED_MARKER);
    expectNoHonouredCiSkipToken(bracket);

    // Same order lesson for the directive form: `skip-checks:tru`e` slips a
    // neutralise-first pass and reconstitutes to a live `skip-checks:true`.
    const directive = sanitizeUntrustedTextForCommitMessage("trailer skip-checks:tru`e end");
    expect(directive).toContain(CI_SKIP_TOKEN_REMOVED_MARKER);
    expectNoHonouredCiSkipToken(directive);
  });

  it("L5: neutralises EVERY occurrence in a multi-token message", () => {
    const out = sanitizeUntrustedTextForCommitMessage(
      "[skip ci] and [ci skip] and skip-checks:true",
    );
    expect(out.match(/\(ci-skip token removed\)/g)).toHaveLength(3);
    expectNoHonouredCiSkipToken(out);
  });

  it("L6: findCiSkipDirectives detects every honoured spelling in an assembled message", () => {
    for (const token of [
      "[skip ci]",
      "[ci skip]",
      "[no ci]",
      "[skip actions]",
      "[actions skip]",
      "skip-checks:true",
      "skip-checks: true",
    ]) {
      const assembled = `Implement #6: title\n\nCloses #6\n\n${token}`;
      expect(findCiSkipDirectives(assembled).length).toBeGreaterThan(0);
    }
  });

  it("L7: findCiSkipDirectives returns [] for a clean assembled message", () => {
    expect(
      findCiSkipDirectives("Implement #6: add feature\n\nCloses #6\n\nCo-Authored-By: Claude <noreply@anthropic.com>"),
    ).toEqual([]);
  });

  it("L8: output carries no newline, backtick, or live @codex trigger", () => {
    const out = sanitizeUntrustedTextForCommitMessage(
      "[skip ci]\n\nCo-Authored-By: mallory <m@e.com> `code` @codex review",
    );
    expect(out).not.toContain("\n");
    expect(out).not.toContain("\r");
    expect(out).not.toContain("`");
    expectNoLiveTrigger(out);
    expectNoHonouredCiSkipToken(out);
  });

  it("L9: the removal marker is itself inert — it matches neither pattern", () => {
    expect(neutralizeCiSkipDirectives(CI_SKIP_TOKEN_REMOVED_MARKER)).toBe(
      CI_SKIP_TOKEN_REMOVED_MARKER,
    );
    expect(findCiSkipDirectives(CI_SKIP_TOKEN_REMOVED_MARKER)).toEqual([]);
  });

  it("L10: an invisible char cannot manufacture or hide a honoured token", () => {
    // A zero-width space injected mid-token is surfaced as a visible marker
    // BEFORE the CI-skip neutralise looks, so it can neither reconstitute a
    // live token nor evade detection — the output reads as inert text.
    // Built from an escape (never a literal invisible, which the repo's own
    // invisible-format guard would reject in this source file).
    const zwsp = "\u200B";
    const out = sanitizeUntrustedTextForCommitMessage(`go [skip${zwsp}ci] now`);
    expect(out).toContain("[U+200B]");
    expectNoHonouredCiSkipToken(out);
  });

  it("N1: a legitimate [F1-S11]-style story tag is left untouched", () => {
    const out = sanitizeUntrustedTextForCommitMessage("[F1-S11] add the thing");
    expect(out).toBe("[F1-S11] add the thing");
    expect(out).not.toContain(CI_SKIP_TOKEN_REMOVED_MARKER);
  });

  it("N2: a literal [U+200B] escape marker is not read as a token", () => {
    expect(neutralizeCiSkipDirectives("value [U+200B] here")).toBe("value [U+200B] here");
    expect(findCiSkipDirectives("value [U+200B] here")).toEqual([]);
  });

  it("N3: [skipper city] does not substring-match [skip ci]", () => {
    expect(neutralizeCiSkipDirectives("[skipper city] wins")).toBe("[skipper city] wins");
    expect(findCiSkipDirectives("[skipper city] wins")).toEqual([]);
  });

  it("N4: a bare [ci] (not a honoured token) is left untouched", () => {
    expect(neutralizeCiSkipDirectives("build [ci] logs")).toBe("build [ci] logs");
    expect(findCiSkipDirectives("build [ci] logs")).toEqual([]);
  });

  it("N5: skip-checks WITHOUT :true is not a directive", () => {
    for (const text of ["skip-checks:false", "skip-checks", "skip-checks:untrue"]) {
      expect(neutralizeCiSkipDirectives(text)).toBe(text);
      expect(findCiSkipDirectives(text)).toEqual([]);
    }
  });

  it("N6: unbracketed prose mentioning skip/ci is left untouched", () => {
    const prose = "please skip the ci flakiness discussion for now";
    expect(neutralizeCiSkipDirectives(prose)).toBe(prose);
    expect(findCiSkipDirectives(prose)).toEqual([]);
  });
});

describe("issue #171 (fsr BLOCKER): nested-bracket CI-skip tokens are caught as literal substrings", () => {
  // GitHub does a LITERAL SUBSTRING search, so `[skip ci]` nested inside an
  // outer bracket (`[oops [skip ci]`) is still honoured. The earlier
  // extract-the-outer-group detector normalised `oops [skip ci` to a
  // non-member and missed it; the per-token literal regexes start the match at
  // the INNER `[`. Each row is a nested form of a honoured token.
  it.each([
    ["nested [skip ci] no space", "[x[skip ci]", /\[\s*skip[\s._-]*ci\s*\]/i],
    ["nested [skip ci] with space", "[oops [skip ci]", /\[\s*skip[\s._-]*ci\s*\]/i],
    ["nested [skip ci] longer prefix", "[broken [skip ci]", /\[\s*skip[\s._-]*ci\s*\]/i],
    ["nested [ci skip]", "[a[ci skip]", /\[\s*ci[\s._-]*skip\s*\]/i],
    ["nested [no ci]", "[a[no ci]", /\[\s*no[\s._-]*ci\s*\]/i],
    ["nested [skip actions]", "[a[skip actions]", /\[\s*skip[\s._-]*actions\s*\]/i],
    ["nested [actions skip]", "[a[actions skip]", /\[\s*actions[\s._-]*skip\s*\]/i],
  ])("%s: neutralised and detected", (_label, input, liveTokenPattern) => {
    // findCiSkipDirectives (the pre-push assertion) fires on the raw title.
    expect(findCiSkipDirectives(input).length).toBeGreaterThan(0);
    // The transform removes the honoured substring, leaving no live token.
    const out = sanitizeUntrustedTextForCommitMessage(input);
    expect(out).toContain(CI_SKIP_TOKEN_REMOVED_MARKER);
    expect(liveTokenPattern.test(out)).toBe(false);
    expect(findCiSkipDirectives(out)).toEqual([]);
  });

  it("the leftover unclosed outer bracket is harmless prose, not a token", () => {
    // `[oops [skip ci]` -> `[oops (ci-skip token removed)`: the dangling
    // `[oops` matches no honoured token.
    const out = sanitizeUntrustedTextForCommitMessage("[oops [skip ci]");
    expect(out).toBe("[oops (ci-skip token removed)");
    expect(findCiSkipDirectives(out)).toEqual([]);
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
