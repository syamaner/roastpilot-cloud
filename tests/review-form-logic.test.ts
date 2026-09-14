import { describe, expect, it } from "vitest";
import { ReviewSubmissionSchema } from "../lib/review-schema";
import {
  buildPayload,
  EMPTY_REVIEW_STATE,
  mapSubmitResponse,
  validateReview,
  type ReviewFormState,
} from "../components/review-form-logic";

function state(overrides: Partial<ReviewFormState> = {}): ReviewFormState {
  return { ...EMPTY_REVIEW_STATE, ...overrides };
}

describe("review form logic", () => {
  it("T-required-star: blocks a missing overall score", () => {
    expect(validateReview(state())).toEqual({
      ok: false,
      fieldErrors: { score: ["Choose an overall score."] },
    });
    expect(() => buildPayload(state())).toThrow(/score is required/i);
  });

  it("T-score-ok: accepts each selectable integer score", () => {
    for (const score of [1, 2, 3, 4, 5]) {
      expect(validateReview(state({ score }))).toEqual({ ok: true });
      expect(buildPayload(state({ score })).score).toBe(score);
    }
  });

  it("T-null-slider: omits every untouched slider instead of sending 50", () => {
    expect(buildPayload(state({ score: 3 }))).toEqual({
      score: 3,
      website: "",
    });
  });

  it("T-touched-state: includes only the slider that was touched", () => {
    expect(buildPayload(state({ score: 4, acidity: 0 }))).toEqual({
      score: 4,
      acidity: 0,
      website: "",
    });
  });

  it("T-text-omit: trims non-empty text and omits blank optional text", () => {
    expect(
      buildPayload(
        state({
          score: 5,
          reviewerName: "  Ada  ",
          notes: "  Apricot  ",
          brewMethod: "  V60 ",
        }),
      ),
    ).toEqual({
      score: 5,
      reviewerName: "Ada",
      notes: "Apricot",
      brewMethod: "V60",
      website: "",
    });

    expect(
      buildPayload(
        state({
          score: 5,
          reviewerName: " ",
          notes: "\t",
          brewMethod: "\n",
        }),
      ),
    ).toEqual({ score: 5, website: "" });
  });

  it("T-honeypot-present: forwards the actual website value", () => {
    expect(
      buildPayload(state({ score: 1, website: "http://spam.example" })),
    ).toHaveProperty("website", "http://spam.example");
  });

  it("T-payload-keys: emits only strict schema keys and a full payload parses", () => {
    const payload = buildPayload(
      state({
        score: 5,
        aroma: 10,
        acidity: 20,
        sweetness: 30,
        body: 40,
        aftertaste: 50,
        reviewerName: "Ada",
        notes: "Apricot",
        brewMethod: "V60",
      }),
    );
    const schemaKeys = new Set(Object.keys(ReviewSubmissionSchema.shape));

    expect(Object.keys(payload).every((key) => schemaKeys.has(key))).toBe(true);
    expect(ReviewSubmissionSchema.safeParse(payload).success).toBe(true);
  });
});

describe("submission response mapping", () => {
  it("T-200-success: maps only HTTP 200 to success", () => {
    expect(mapSubmitResponse(200, { ok: true })).toEqual({
      kind: "success",
      preserveInput: false,
    });
  });

  it("T-400-validation: retains field errors and preserves input", () => {
    const fieldErrors = { notes: ["Too long"] };
    expect(mapSubmitResponse(400, { error: "invalid", fieldErrors })).toEqual({
      kind: "validation",
      fieldErrors,
      preserveInput: true,
    });
    expect(mapSubmitResponse(400, null)).toMatchObject({
      kind: "validation",
      preserveInput: true,
    });
    expect(mapSubmitResponse(400, {})).toMatchObject({
      kind: "validation",
      preserveInput: true,
    });
    expect(mapSubmitResponse(400, { fieldErrors: null })).toMatchObject({
      kind: "validation",
      preserveInput: true,
    });
    expect(mapSubmitResponse(400, { fieldErrors: {} })).toMatchObject({
      kind: "validation",
      preserveInput: true,
    });
    expect(mapSubmitResponse(400, { fieldErrors: { score: [3] } })).toMatchObject(
      { kind: "validation", preserveInput: true },
    );
    expect(
      mapSubmitResponse(400, {
        fieldErrors: { notes: ["Too long"], ignored: "not an array" },
      }),
    ).toMatchObject({
      kind: "validation",
      fieldErrors: { notes: ["Too long"] },
      preserveInput: true,
    });
  });

  it("T-429-copy: uses client-owned connection copy and preserves input", () => {
    const serverBody = "server-controlled secret wording";
    const result = mapSubmitResponse(429, { error: serverBody });
    expect(result).toMatchObject({ kind: "rate_limited", preserveInput: true });
    expect("message" in result ? result.message : "").toMatch(/connection/i);
    expect("message" in result ? result.message : "").not.toContain(serverBody);
  });

  it.each([404, 415, 503])(
    "T-error-generic: maps %s to retry copy while preserving input",
    (status) => {
      const result = mapSubmitResponse(status, { error: "do not echo me" });
      expect(result).toMatchObject({ kind: "error", preserveInput: true });
      expect("message" in result ? result.message : "").toMatch(/try again/i);
      expect("message" in result ? result.message : "").not.toContain(
        "do not echo me",
      );
    },
  );

  it("T-network-error: maps a network failure to retry copy", () => {
    expect(mapSubmitResponse("network", null)).toEqual({
      kind: "error",
      message: "We couldn't submit your review. Please try again.",
      preserveInput: true,
    });
  });
});
