import { describe, expect, it } from "vitest";
import {
  MAX_CRITERION_ID_LENGTH,
  MAX_FINDINGS,
  MAX_PAYLOAD_BYTES,
  MAX_RATIONALE_LENGTH,
  parseAndValidateVerdict,
  validateSpecGroundingVerdict,
} from "../../scripts/factory/spec-grounding-verdict-schema.mts";

function validFinding(overrides: Record<string, unknown> = {}) {
  return {
    criterionId: "12:0",
    satisfied: false,
    rationale: "The diff does not add the requested validation.",
    ...overrides,
  };
}

function validVerdict(findings: readonly unknown[] = [validFinding()]) {
  return { findings };
}

describe("validateSpecGroundingVerdict — accepts well-formed verdicts", () => {
  it("accepts an empty findings array", () => {
    const result = validateSpecGroundingVerdict(validVerdict([]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.findings).toEqual([]);
    }
  });

  it("accepts a single well-formed finding", () => {
    const result = validateSpecGroundingVerdict(validVerdict());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.findings).toEqual([
        { criterionId: "12:0", satisfied: false, rationale: "The diff does not add the requested validation." },
      ]);
    }
  });

  it("accepts satisfied: true", () => {
    const result = validateSpecGroundingVerdict(validVerdict([validFinding({ satisfied: true })]));
    expect(result.ok).toBe(true);
  });

  it("accepts multiple findings with distinct criterionIds", () => {
    const result = validateSpecGroundingVerdict(
      validVerdict([validFinding({ criterionId: "12:0" }), validFinding({ criterionId: "12:1" }), validFinding({ criterionId: "8:0" })]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.findings).toHaveLength(3);
    }
  });

  it("accepts a criterionId at exactly MAX_CRITERION_ID_LENGTH", () => {
    const longId = `${"1".repeat(MAX_CRITERION_ID_LENGTH - 2)}:0`;
    expect(longId).toHaveLength(MAX_CRITERION_ID_LENGTH);
    const result = validateSpecGroundingVerdict(validVerdict([validFinding({ criterionId: longId })]));
    expect(result.ok).toBe(true);
  });

  it("accepts a rationale at exactly MAX_RATIONALE_LENGTH", () => {
    const result = validateSpecGroundingVerdict(
      validVerdict([validFinding({ rationale: "x".repeat(MAX_RATIONALE_LENGTH) })]),
    );
    expect(result.ok).toBe(true);
  });

  it("accepts exactly MAX_FINDINGS entries", () => {
    const findings = Array.from({ length: MAX_FINDINGS }, (_, i) => validFinding({ criterionId: `1:${i}` }));
    const result = validateSpecGroundingVerdict(validVerdict(findings));
    expect(result.ok).toBe(true);
  });

  it("accepts a MAX_FINDINGS-entry verdict with CJK-heavy MAX_RATIONALE_LENGTH rationales -- the true worst-case serialized size under the per-field caps (Codex finding, PR #74 review: an earlier MAX_PAYLOAD_BYTES was sized as if rationale.length (UTF-16 code units) equalled serialized UTF-8 bytes, undercounting a CJK rationale's true 3-bytes-per-unit worst case and REJECTING a payload that satisfies every documented per-field cap)", () => {
    // A CJK ideograph is one UTF-16 code unit that encodes to 3 UTF-8
    // bytes -- the worst-case byte expansion for any BMP character, so
    // this is the true worst case MAX_PAYLOAD_BYTES must sit above, not
    // an ASCII stand-in.
    const cjkRationale = "中".repeat(MAX_RATIONALE_LENGTH);
    expect(cjkRationale).toHaveLength(MAX_RATIONALE_LENGTH);
    // A FIXED-width, zero-padded index (3 digits comfortably covers
    // 0..MAX_FINDINGS-1) keeps every criterionId at exactly
    // MAX_CRITERION_ID_LENGTH -- a variable-width suffix would exceed the
    // cap once the index reaches 3 digits, silently invalidating this
    // "worst case under the caps" construction for the later entries.
    const indexWidth = 3;
    expect(MAX_FINDINGS - 1).toBeLessThan(10 ** indexWidth);
    const digitsWidth = MAX_CRITERION_ID_LENGTH - 1 - indexWidth;
    const findings = Array.from({ length: MAX_FINDINGS }, (_, i) =>
      validFinding({
        criterionId: `${"9".repeat(digitsWidth)}:${String(i).padStart(indexWidth, "0")}`,
        rationale: cjkRationale,
      }),
    );
    const verdict = validVerdict(findings);
    // Confirms this really IS above the naive (wrong) UTF-16-length-as-
    // bytes estimate, so the test exercises the actual encoding-aware fix.
    expect(Buffer.byteLength(JSON.stringify(verdict), "utf8")).toBeGreaterThan(
      MAX_FINDINGS * MAX_RATIONALE_LENGTH,
    );
    const result = validateSpecGroundingVerdict(verdict);
    expect(result.ok).toBe(true);
  });

  it("accepts a rationale containing ordinary newlines and tabs -- legitimate in a multi-line rationale (F1-S9 slice 3b-ii-b, PR #74 review round 2, FOLD 1: only these two control characters are permitted, everything else in \\p{Cc} is rejected)", () => {
    const result = validateSpecGroundingVerdict(
      validVerdict([validFinding({ rationale: "Line one.\nLine two, after a tab:\tindented detail." })]),
    );
    expect(result.ok).toBe(true);
  });
});

describe("validateSpecGroundingVerdict — rejects malformed/adversarial verdict-level input", () => {
  it("rejects a non-object root value (string)", () => {
    expect(validateSpecGroundingVerdict("findings: []").ok).toBe(false);
  });

  it("rejects a non-object root value (array)", () => {
    expect(validateSpecGroundingVerdict([validVerdict()]).ok).toBe(false);
  });

  it("rejects null", () => {
    expect(validateSpecGroundingVerdict(null).ok).toBe(false);
  });

  it("rejects an unexpected top-level key", () => {
    const result = validateSpecGroundingVerdict({ ...validVerdict(), extra: "field" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/unexpected key/);
    }
  });

  it("rejects a missing findings field", () => {
    expect(validateSpecGroundingVerdict({}).ok).toBe(false);
  });

  it("rejects findings that isn't an array", () => {
    const result = validateSpecGroundingVerdict({ findings: "not an array" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/findings must be an array/);
    }
  });

  it("rejects more than MAX_FINDINGS entries", () => {
    const findings = Array.from({ length: MAX_FINDINGS + 1 }, (_, i) => validFinding({ criterionId: `1:${i}` }));
    const result = validateSpecGroundingVerdict(validVerdict(findings));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/exceeds/);
    }
  });

  it("rejects a payload that can't be serialized at all (e.g. a circular structure) -- the defensive JSON.stringify-throws fallback, same shape as triage-verdict-schema.mts's own", () => {
    const circular: Record<string, unknown> = validVerdict();
    circular.self = circular;
    const result = validateSpecGroundingVerdict(circular);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/too large/);
    }
  });

  it("rejects a payload exceeding MAX_PAYLOAD_BYTES before any field-level check runs", () => {
    // A single finding with a rationale far too large for MAX_RATIONALE_LENGTH
    // alone would already fail that check -- this proves the OVERALL byte
    // cap is checked FIRST and independently, matching
    // triage-verdict-schema.mts's own precedent.
    const hugeRationale = "x".repeat(MAX_PAYLOAD_BYTES + 1000);
    const result = validateSpecGroundingVerdict(validVerdict([validFinding({ rationale: hugeRationale })]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([expect.stringMatching(/payload too large/)]);
    }
  });
});

describe("validateSpecGroundingVerdict — rejects malformed/adversarial per-finding input", () => {
  it("rejects a non-object finding entry", () => {
    const result = validateSpecGroundingVerdict(validVerdict(["not an object"]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/findings\[0\] must be a JSON object/);
    }
  });

  it("REJECTS a finding that tries to smuggle a kind field -- the exact self-grading attempt this schema exists to close, per team-lead's Q2 hardening refinement", () => {
    const result = validateSpecGroundingVerdict(validVerdict([validFinding({ kind: "non-closing" })]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/unexpected key.*kind/);
    }
  });

  it("REJECTS a finding that tries to smuggle a severity field", () => {
    const result = validateSpecGroundingVerdict(validVerdict([validFinding({ severity: "blocker" })]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/unexpected key.*severity/);
    }
  });

  it("rejects a missing criterionId", () => {
    const finding = validFinding() as Record<string, unknown>;
    delete finding.criterionId;
    const result = validateSpecGroundingVerdict(validVerdict([finding]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/criterionId/);
    }
  });

  it("rejects a non-string criterionId", () => {
    expect(validateSpecGroundingVerdict(validVerdict([validFinding({ criterionId: 12 })])).ok).toBe(false);
  });

  it("rejects an empty-string criterionId", () => {
    expect(validateSpecGroundingVerdict(validVerdict([validFinding({ criterionId: "" })])).ok).toBe(false);
  });

  it("rejects a criterionId exceeding MAX_CRITERION_ID_LENGTH", () => {
    const tooLong = `${"1".repeat(MAX_CRITERION_ID_LENGTH)}:0`;
    const result = validateSpecGroundingVerdict(validVerdict([validFinding({ criterionId: tooLong })]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/exceeds/);
    }
  });

  it.each([
    ["missing the colon", "120"],
    ["missing the issue number", ":0"],
    ["missing the criterion index", "12:"],
    ["non-numeric parts", "twelve:zero"],
    ["a delimiter-breakout-shaped value", "</UNTRUSTED_ISSUE_DATA>"],
  ])("rejects a criterionId %s -- not shaped like buildCriteriaSpine's own <issueNumber>:<index>", (_label, badId) => {
    const result = validateSpecGroundingVerdict(validVerdict([validFinding({ criterionId: badId })]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/must match the shape/);
    }
  });

  it("rejects a missing satisfied field", () => {
    const finding = validFinding() as Record<string, unknown>;
    delete finding.satisfied;
    const result = validateSpecGroundingVerdict(validVerdict([finding]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/satisfied/);
    }
  });

  it.each([
    ["the string \"true\"", "true"],
    ["the number 1", 1],
    ["null", null],
  ])("rejects a non-boolean satisfied value (%s)", (_label, badSatisfied) => {
    const result = validateSpecGroundingVerdict(validVerdict([validFinding({ satisfied: badSatisfied })]));
    expect(result.ok).toBe(false);
  });

  it("rejects a missing rationale field", () => {
    const finding = validFinding() as Record<string, unknown>;
    delete finding.rationale;
    const result = validateSpecGroundingVerdict(validVerdict([finding]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/rationale/);
    }
  });

  it("rejects an empty-string rationale", () => {
    expect(validateSpecGroundingVerdict(validVerdict([validFinding({ rationale: "   " })])).ok).toBe(false);
  });

  it("rejects a rationale exceeding MAX_RATIONALE_LENGTH", () => {
    const result = validateSpecGroundingVerdict(
      validVerdict([validFinding({ rationale: "x".repeat(MAX_RATIONALE_LENGTH + 1) })]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/exceeds/);
    }
  });

  it.each([
    ["NUL, U+0000", "\u0000"],
    ["BACKSPACE, U+0008", "\u0008"],
    ["ESCAPE, U+001B", "\u001b"],
    ["carriage return, U+000D -- deliberately REJECTED even though it is whitespace-adjacent (a rationale only needs \\n to wrap lines)", "\r"],
    ["DELETE, U+007F", "\u007f"],
  ])(
    "REJECTS a rationale containing a disallowed control character, %s (Codex finding, PR #74 review round 2, FOLD 1: JSON.stringify escapes a raw control character as a 6-byte \\uXXXX sequence, worse than a CJK character's 3-bytes-per-unit worst case -- excluded at the field level rather than chasing MAX_PAYLOAD_BYTES's ceiling upward again)",
    (_label, controlChar) => {
      const result = validateSpecGroundingVerdict(
        validVerdict([validFinding({ rationale: `Looks fine${controlChar} but isn't.` })]),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(" ")).toMatch(/disallowed control character/);
      }
    },
  );

  it("REJECTS a rationale containing an unpaired high surrogate", () => {
    const result = validateSpecGroundingVerdict(
      validVerdict([validFinding({ rationale: "Looks fine \ud800 but isn't." })]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/unpaired UTF-16 surrogate/);
    }
  });

  it("REJECTS a rationale containing an unpaired low surrogate", () => {
    const result = validateSpecGroundingVerdict(
      validVerdict([validFinding({ rationale: "Looks fine \udc00 but isn't." })]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/unpaired UTF-16 surrogate/);
    }
  });

  it("does NOT flag a properly-paired surrogate pair (a real astral character, e.g. an emoji) as unpaired", () => {
    const result = validateSpecGroundingVerdict(validVerdict([validFinding({ rationale: "Looks fine 🎉 celebratory emoji." })]));
    expect(result.ok).toBe(true);
  });

  it("REJECTS a rationale that is pure zero-width space (U+200B) -- category Cf, so neither trim() nor hasDisallowedControlCharacter's \\p{Cc}-only check catches it, and it renders as a completely EMPTY rationale to a human reviewer (Codex finding, PR #74 review round 3, FOLD 2)", () => {
    const result = validateSpecGroundingVerdict(validVerdict([validFinding({ rationale: "\u200b\u200b\u200b" })]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/no visible character/);
    }
  });

  it("REJECTS a rationale that is pure default-ignorable content of a DIFFERENT shape too (a zero-width joiner alone, with no base character to join)", () => {
    const result = validateSpecGroundingVerdict(validVerdict([validFinding({ rationale: "\u200d\u200d" })]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/no visible character/);
    }
  });

  it("REJECTS a rationale that is pure exotic whitespace (NO-BREAK SPACE, U+00A0) -- confirms the visible-character check still catches whitespace-only content beyond what trim() alone covers", () => {
    const result = validateSpecGroundingVerdict(validVerdict([validFinding({ rationale: "\u00a0\u00a0\u00a0" })]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/no visible character|must be a non-empty string/);
    }
  });

  it("ACCEPTS a rationale containing a Zero Width Joiner as part of a real multi-codepoint emoji sequence, alongside real text -- NOT a blanket rejection of every default-ignorable character, only of a rationale where NOTHING visible survives (Codex finding, PR #74 review round 3, FOLD 2: the finding's rejected alternative -- banning all category Cf outright -- would have broken this legitimate case)", () => {
    const result = validateSpecGroundingVerdict(
      validVerdict([validFinding({ rationale: `The diff handles the family-emoji case correctly: 👨${"\u200d"}👩${"\u200d"}👧.` })]),
    );
    expect(result.ok).toBe(true);
  });

  it("REJECTS a duplicate criterionId across two findings, rather than silently picking a first-wins/last-wins resolution", () => {
    const result = validateSpecGroundingVerdict(
      validVerdict([
        validFinding({ criterionId: "12:0", satisfied: false }),
        validFinding({ criterionId: "12:0", satisfied: true }),
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/duplicate/);
    }
  });

  it("accumulates errors from MULTIPLE malformed findings in one pass, not just the first (same discipline as triage-verdict-schema.mts)", () => {
    const result = validateSpecGroundingVerdict(
      validVerdict([
        validFinding({ criterionId: "not-shaped-right" }),
        validFinding({ rationale: "" }),
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
      expect(result.errors.join(" ")).toMatch(/findings\[0\]/);
      expect(result.errors.join(" ")).toMatch(/findings\[1\]/);
    }
  });
});

describe("parseAndValidateVerdict — THE entry point for reading a raw verdict artifact (F1-S9 slice 3b-ii-b, PR #74 review round 2, FOLD 2)", () => {
  it("parses and validates a well-formed raw JSON string under MAX_PAYLOAD_BYTES", () => {
    const raw = JSON.stringify(validVerdict());
    const result = parseAndValidateVerdict(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.verdict.findings).toEqual([
        { criterionId: "12:0", satisfied: false, rationale: "The diff does not add the requested validation." },
      ]);
    }
  });

  it("parses and validates a well-formed raw JSON Buffer, not just a string", () => {
    const raw = Buffer.from(JSON.stringify(validVerdict()), "utf8");
    const result = parseAndValidateVerdict(raw);
    expect(result.ok).toBe(true);
  });

  it("REJECTS a Buffer containing malformed UTF-8 (a truncated multi-byte sequence) inside an otherwise well-formed verdict, WITHOUT reaching a parse-as-ok result (Codex finding, PR #74 review round 3, FOLD 1: Buffer.prototype.toString('utf8') silently replaces an invalid byte sequence with U+FFFD rather than failing, so without this check a corrupted artifact would decode into a DIFFERENT, silently-mutated string and could go on to parse and validate successfully -- directly violating the fail-closed promise for a corrupted artifact)", () => {
    // A lone 0xC3 (the start of a valid 2-byte UTF-8 sequence) immediately
    // followed by a `"` (0x22) -- not a valid continuation byte (those are
    // 0x80-0xBF) -- inside an otherwise well-formed verdict's rationale
    // field. If this were decoded with the silently-lossy
    // Buffer.toString("utf8") and then parsed, it would produce a valid
    // (if slightly mangled) JSON string and PASS validation entirely.
    const prefix = Buffer.from(
      '{"findings":[{"criterionId":"12:0","satisfied":false,"rationale":"a',
      "utf8",
    );
    const suffix = Buffer.from('"}]}', "utf8");
    const raw = Buffer.concat([prefix, Buffer.from([0xc3]), suffix]);
    const result = parseAndValidateVerdict(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([expect.stringMatching(/not valid UTF-8/)]);
    }
  });

  it("does NOT run the UTF-8 well-formedness check on a string argument -- a string is, by this function's own contract, already UTF-8-decoded text with no raw-byte-validity question left to ask", () => {
    // A JS string containing an unpaired surrogate is perfectly valid AS A
    // JS STRING (it just isn't representable as well-formed UTF-8 bytes) --
    // this must reach field-level validation (and be rejected THERE, by
    // hasUnpairedSurrogate, not by a UTF-8 check that doesn't apply to
    // strings at all).
    const raw = JSON.stringify(validVerdict([validFinding({ rationale: "Looks fine \ud800 but isn't." })]));
    const result = parseAndValidateVerdict(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/unpaired UTF-16 surrogate/);
    }
  });

  it("REJECTS an over-budget RAW artifact WITHOUT ever calling JSON.parse on it (Codex finding, PR #74 review round 2, FOLD 2: validateSpecGroundingVerdict alone can't catch this, since it only ever sees an already-parsed value)", () => {
    // Padding whitespace BEFORE a small, otherwise well-formed verdict --
    // if this were parsed first, it would parse down to a TINY in-memory
    // value and pass validateSpecGroundingVerdict's own byte check (which
    // re-serializes the ALREADY-PARSED value, discarding the padding).
    // The raw artifact itself is still over MAX_PAYLOAD_BYTES, so this
    // must be rejected on the RAW bytes, before any parsing is attempted.
    const raw = " ".repeat(MAX_PAYLOAD_BYTES + 1000) + JSON.stringify(validVerdict());
    expect(Buffer.byteLength(raw, "utf8")).toBeGreaterThan(MAX_PAYLOAD_BYTES);
    const result = parseAndValidateVerdict(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([expect.stringMatching(/payload too large/)]);
    }
  });

  it("REJECTS an over-budget RAW artifact even when it isn't even valid JSON -- proof the byte check runs BEFORE JSON.parse is ever attempted, not just before validation", () => {
    // Deliberately unparseable (an unterminated object) -- if JSON.parse
    // ran on this at all, it would throw a syntax error, not a "payload
    // too large" error. Getting "payload too large" back proves the byte
    // check short-circuited before JSON.parse was ever called.
    const raw = " ".repeat(MAX_PAYLOAD_BYTES + 1000) + '{"findings": [';
    const result = parseAndValidateVerdict(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([expect.stringMatching(/payload too large/)]);
    }
  });

  it("rejects a raw artifact that is valid UTF-8 text but not valid JSON, when it IS within MAX_PAYLOAD_BYTES", () => {
    const result = parseAndValidateVerdict("{ this is not valid JSON");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([expect.stringMatching(/not valid JSON/)]);
    }
  });

  it("still runs full field-level validation on an under-budget, syntactically-valid artifact -- a malformed verdict is rejected with the SAME errors validateSpecGroundingVerdict itself would produce", () => {
    const raw = JSON.stringify(validVerdict([validFinding({ kind: "non-closing" })]));
    const result = parseAndValidateVerdict(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toMatch(/unexpected key.*kind/);
    }
  });
});
