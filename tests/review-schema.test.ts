import { describe, expect, it } from "vitest";
import { ReviewSubmissionSchema } from "../lib/review-schema";

function expectFailure(input: unknown, path: PropertyKey[]): void {
  const result = ReviewSubmissionSchema.safeParse(input);

  expect(result.success).toBe(false);
  if (!result.success) {
    expect(result.error.issues[0]?.path).toEqual(path);
  }
}

describe("review submission schema", () => {
  it("T1 accepts a fully populated submission", () => {
    const result = ReviewSubmissionSchema.safeParse({
      score: 5,
      aroma: 0,
      acidity: 25,
      sweetness: 50,
      body: 75,
      aftertaste: 100,
      reviewerName: "Ada",
      notes: "Chocolate and stone fruit",
      brewMethod: "pour over",
      website: "",
    });

    expect(result.success).toBe(true);
  });

  it("T2 accepts score as the only field", () => {
    expect(ReviewSubmissionSchema.safeParse({ score: 3 }).success).toBe(true);
  });

  it("T3 accepts null for every slider", () => {
    expect(
      ReviewSubmissionSchema.safeParse({
        score: 3,
        aroma: null,
        acidity: null,
        sweetness: null,
        body: null,
        aftertaste: null,
      }).success,
    ).toBe(true);
  });

  it("T4 accepts every slider being absent", () => {
    expect(ReviewSubmissionSchema.safeParse({ score: 3 }).success).toBe(true);
  });

  it("T5 accepts an absent honeypot", () => {
    expect(ReviewSubmissionSchema.safeParse({ score: 4 }).success).toBe(true);
  });

  it("T6 accepts an empty honeypot", () => {
    expect(
      ReviewSubmissionSchema.safeParse({ score: 4, website: "" }).success,
    ).toBe(true);
  });

  it("T7 rejects a missing score", () => {
    expectFailure({}, ["score"]);
  });

  it("T8 rejects score below 1", () => {
    expectFailure({ score: 0 }, ["score"]);
  });

  it("T9 rejects score above 5", () => {
    expectFailure({ score: 6 }, ["score"]);
  });

  it("T10 rejects a fractional score", () => {
    expectFailure({ score: 2.5 }, ["score"]);
  });

  it("T11 rejects a string score without coercion", () => {
    expectFailure({ score: "5" }, ["score"]);
  });

  it("T12 rejects aroma below 0", () => {
    expectFailure({ score: 3, aroma: -1 }, ["aroma"]);
  });

  it("T13 rejects aroma above 100", () => {
    expectFailure({ score: 3, aroma: 101 }, ["aroma"]);
  });

  it("T14 rejects fractional aroma", () => {
    expectFailure({ score: 3, aroma: 50.5 }, ["aroma"]);
  });

  it("T15 rejects acidity above 100", () => {
    expectFailure({ score: 3, acidity: 101 }, ["acidity"]);
  });

  it("T16 rejects sweetness below 0", () => {
    expectFailure({ score: 3, sweetness: -1 }, ["sweetness"]);
  });

  it("T17 rejects body above 100", () => {
    expectFailure({ score: 3, body: 101 }, ["body"]);
  });

  it("T18 rejects aftertaste below 0", () => {
    expectFailure({ score: 3, aftertaste: -1 }, ["aftertaste"]);
  });

  it("T19 rejects a populated honeypot", () => {
    expectFailure({ score: 3, website: "http://x" }, ["website"]);
  });

  it("T20 rejects whitespace in the honeypot", () => {
    expectFailure({ score: 3, website: "  " }, ["website"]);
  });

  it("T21 rejects reviewer names longer than 80 characters", () => {
    expectFailure({ score: 3, reviewerName: "a".repeat(81) }, [
      "reviewerName",
    ]);
  });

  it("T22 accepts an 80-character reviewer name", () => {
    expect(
      ReviewSubmissionSchema.safeParse({
        score: 3,
        reviewerName: "a".repeat(80),
      }).success,
    ).toBe(true);
  });

  it("T23 rejects notes longer than 2000 characters", () => {
    expectFailure({ score: 3, notes: "a".repeat(2001) }, ["notes"]);
  });

  it("T24 accepts 2000-character notes", () => {
    expect(
      ReviewSubmissionSchema.safeParse({
        score: 3,
        notes: "a".repeat(2000),
      }).success,
    ).toBe(true);
  });

  it("T25 rejects brew methods longer than 40 characters", () => {
    expectFailure({ score: 3, brewMethod: "a".repeat(41) }, ["brewMethod"]);
  });

  it("T26 accepts a free-text brew method", () => {
    expect(
      ReviewSubmissionSchema.safeParse({
        score: 3,
        brewMethod: "aeropress inverted",
      }).success,
    ).toBe(true);
  });

  it("T27 rejects unknown keys", () => {
    expectFailure({ score: 3, isAdmin: true }, []);
  });

  it("T28 accepts boundary scores 1 and 5", () => {
    expect(ReviewSubmissionSchema.safeParse({ score: 1 }).success).toBe(true);
    expect(ReviewSubmissionSchema.safeParse({ score: 5 }).success).toBe(true);
  });

  it("T29 accepts boundary sliders 0 and 100", () => {
    expect(
      ReviewSubmissionSchema.safeParse({
        score: 3,
        aroma: 0,
        acidity: 100,
        sweetness: 0,
        body: 100,
        aftertaste: 0,
      }).success,
    ).toBe(true);
  });

  it("T30 rejects a string slider value", () => {
    expectFailure({ score: 3, aroma: "50" }, ["aroma"]);
  });

  it("T31 rejects a boolean slider value", () => {
    expectFailure({ score: 3, body: true }, ["body"]);
  });

  it("T32 rejects a non-string reviewerName", () => {
    expectFailure({ score: 3, reviewerName: 123 }, ["reviewerName"]);
  });

  it("T33 rejects a non-string notes", () => {
    expectFailure({ score: 3, notes: 5 }, ["notes"]);
  });

  it("T34 rejects a non-string brewMethod", () => {
    expectFailure({ score: 3, brewMethod: 7 }, ["brewMethod"]);
  });
});
