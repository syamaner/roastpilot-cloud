import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewSubmission } from "../lib/review-schema";
import { SqlApiError } from "../lib/sqlapi";
import {
  ReviewSubmitError,
  submitReview,
} from "../lib/review-submit";

const { executeStatementMock } = vi.hoisted(() => ({
  executeStatementMock: vi.fn(),
}));

vi.mock("../lib/sqlapi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sqlapi")>();
  return { ...actual, executeStatement: executeStatementMock };
});

const STATEMENT =
  "call submit_review(:1, :2, :3, :4, :5, :6, :7, :8, :9, :10, :11)";
const PEPPER = "unit-test-review-ip-pepper";
const REVIEW_ID = "da03ad4e-cbc9-4f96-bfa6-f474be94ae09";
const CLIENT_IP = "  2001:DB8::CAFE  ";

type Bindings = Record<
  string,
  { type: string; value: string | null }
>;

const completeSubmission: ReviewSubmission = {
  score: 5,
  aroma: 91,
  acidity: 72,
  sweetness: 83,
  body: 64,
  aftertaste: 55,
  reviewerName: "  Reviewer Name  ",
  brewMethod: "V60 / pour-over",
  notes: "Cocoa, citrus; exactly as entered.\nSecond line.",
  website: "",
};

function result(reviewId: string | null = REVIEW_ID, rowCount = 1) {
  return {
    columns: [{ name: "SUBMIT_REVIEW", type: "TEXT" }],
    rows: rowCount === 0 ? [] : [[reviewId]],
    rowCount,
  };
}

function capturedBindings(): Bindings {
  expect(executeStatementMock).toHaveBeenCalledTimes(1);
  return executeStatementMock.mock.calls[0][1] as Bindings;
}

async function capturedError(
  promise: Promise<unknown>,
): Promise<ReviewSubmitError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ReviewSubmitError);
  return caught as ReviewSubmitError;
}

function consoleSpies() {
  return [
    vi.spyOn(console, "log").mockImplementation(() => undefined),
    vi.spyOn(console, "info").mockImplementation(() => undefined),
    vi.spyOn(console, "warn").mockImplementation(() => undefined),
    vi.spyOn(console, "error").mockImplementation(() => undefined),
    vi.spyOn(console, "debug").mockImplementation(() => undefined),
  ];
}

beforeEach(() => {
  vi.stubEnv("REVIEW_IP_HASH_PEPPER", PEPPER);
  executeStatementMock.mockResolvedValue(result());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  executeStatementMock.mockReset();
});

describe("submitReview", () => {
  it("T1 submits once and returns the scalar review ID", async () => {
    await expect(
      submitReview("roast-slug", completeSubmission, CLIENT_IP),
    ).resolves.toEqual({ reviewId: REVIEW_ID });
    expect(executeStatementMock).toHaveBeenCalledTimes(1);
  });

  it("T2 binds all eleven procedure arguments in their exact order", async () => {
    await submitReview("roast-slug", completeSubmission, CLIENT_IP);

    expect(executeStatementMock.mock.calls[0][0]).toBe(STATEMENT);
    expect(Object.keys(capturedBindings())).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
      "10",
      "11",
    ]);
    expect(capturedBindings()).toMatchObject({
      "1": { type: "TEXT", value: "roast-slug" },
      "2": { type: "TEXT", value: completeSubmission.reviewerName },
      "3": { type: "FIXED", value: "5" },
      "4": { type: "FIXED", value: "91" },
      "5": { type: "FIXED", value: "72" },
      "6": { type: "FIXED", value: "83" },
      "7": { type: "FIXED", value: "64" },
      "8": { type: "FIXED", value: "55" },
      "9": { type: "TEXT", value: completeSubmission.brewMethod },
      "10": { type: "TEXT", value: completeSubmission.notes },
      "11": { type: "TEXT" },
    });
  });

  it("T3 places the slug first and the IP hash eleventh", async () => {
    await submitReview("position-one", completeSubmission, CLIENT_IP);
    const bindings = capturedBindings();

    expect(bindings["1"]).toEqual({ type: "TEXT", value: "position-one" });
    expect(bindings["11"].type).toBe("TEXT");
    expect(bindings["11"].value).not.toBe(CLIENT_IP);
  });

  it("T4 serialises every numeric binding as FIXED decimal text", async () => {
    await submitReview("roast-slug", completeSubmission, CLIENT_IP);
    const bindings = capturedBindings();

    expect(["3", "4", "5", "6", "7", "8"].map((key) => bindings[key]))
      .toEqual([
        { type: "FIXED", value: "5" },
        { type: "FIXED", value: "91" },
        { type: "FIXED", value: "72" },
        { type: "FIXED", value: "83" },
        { type: "FIXED", value: "64" },
        { type: "FIXED", value: "55" },
      ]);
  });

  it("T5 preserves optional text verbatim", async () => {
    await submitReview("roast-slug", completeSubmission, CLIENT_IP);
    const bindings = capturedBindings();

    expect(bindings["2"].value).toBe(completeSubmission.reviewerName);
    expect(bindings["9"].value).toBe(completeSubmission.brewMethod);
    expect(bindings["10"].value).toBe(completeSubmission.notes);
  });

  it("T6 reads the review ID only from rows[0][0]", async () => {
    const scalar = "review-id-from-first-cell";
    executeStatementMock.mockResolvedValue({
      columns: [{ name: "IGNORED", type: "TEXT" }],
      rows: [[scalar]],
      rowCount: 1,
    });

    await expect(
      submitReview("roast-slug", completeSubmission, CLIENT_IP),
    ).resolves.toEqual({ reviewId: scalar });
  });

  it("T7 binds untouched sliders as null, never as defaults", async () => {
    const submission: ReviewSubmission = {
      score: 3,
      aroma: null,
      sweetness: null,
    };
    await submitReview("roast-slug", submission, CLIENT_IP);
    const bindings = capturedBindings();

    for (const key of ["4", "5", "6", "7", "8"]) {
      expect(bindings[key]).toEqual({ type: "FIXED", value: null });
      expect(bindings[key].value).not.toBe("0");
      expect(bindings[key].value).not.toBe("50");
    }
  });

  it("T8 binds absent optional text as null", async () => {
    await submitReview("roast-slug", { score: 4 }, CLIENT_IP);
    const bindings = capturedBindings();

    expect(bindings["2"]).toEqual({ type: "TEXT", value: null });
    expect(bindings["9"]).toEqual({ type: "TEXT", value: null });
    expect(bindings["10"]).toEqual({ type: "TEXT", value: null });
  });

  it("T9 produces a lowercase 64-hex IP hash", async () => {
    await submitReview("roast-slug", completeSubmission, CLIENT_IP);
    expect(capturedBindings()["11"].value).toMatch(/^[0-9a-f]{64}$/);
  });

  it("T10 never exposes the raw client IP to SQL, bindings, or console", async () => {
    const rawIpSentinel = "  RAW-IP-SENTINEL.EXAMPLE  ";
    const spies = consoleSpies();
    await submitReview("roast-slug", completeSubmission, rawIpSentinel);

    const [statement, bindings] = executeStatementMock.mock.calls[0] as [
      string,
      Bindings,
    ];
    expect(statement).not.toContain(rawIpSentinel);
    expect(JSON.stringify(bindings)).not.toContain(rawIpSentinel);
    expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain(
      rawIpSentinel,
    );
  });

  it("T11 maps not_found, current procedure failures, and unknown kinds to transient", async () => {
    executeStatementMock.mockRejectedValueOnce(
      new SqlApiError("not_found", "safe -20001 classification"),
    );
    expect(
      await capturedError(
        submitReview("roast-slug", completeSubmission, CLIENT_IP),
      ),
    ).toMatchObject({ reason: "transient", message: "Review submission failed." });

    executeStatementMock.mockRejectedValueOnce(
      new SqlApiError("transport", "safe -20001 procedure failure"),
    );
    expect(
      await capturedError(
        submitReview("roast-slug", completeSubmission, CLIENT_IP),
      ),
    ).toMatchObject({ reason: "transient" });

    const unknownKind = new SqlApiError("transport", "safe");
    Object.defineProperty(unknownKind, "kind", { value: "future_kind" });
    executeStatementMock.mockRejectedValueOnce(unknownKind);
    expect(
      await capturedError(
        submitReview("roast-slug", completeSubmission, CLIENT_IP),
      ),
    ).toMatchObject({ reason: "transient" });
  });

  it("T12 maps auth, config, and transport to sanitised transient errors", async () => {
    const secrets = ["connector-sentinel", "host-sentinel", "key-sentinel", "PEM-sentinel", "raw-IP-sentinel"];
    for (const kind of ["auth", "config", "transport"] as const) {
      executeStatementMock.mockRejectedValueOnce(
        new SqlApiError(kind, secrets.join(" ")),
      );
      const error = await capturedError(
        submitReview("roast-slug", completeSubmission, CLIENT_IP),
      );
      expect(error.reason).toBe("transient");
      expect(error.message).toBe("Review submission failed.");
      for (const secret of secrets) expect(error.message).not.toContain(secret);
    }
  });

  it("T13 rejects zero, multiple, null, and blank scalar results", async () => {
    const malformedResults = [
      result(null, 0),
      { ...result(), rows: [[REVIEW_ID], ["second"]], rowCount: 2 },
      result(null),
      result(""),
      result("   "),
    ];
    for (const malformedResult of malformedResults) {
      executeStatementMock.mockResolvedValueOnce(malformedResult);
      const error = await capturedError(
        submitReview("roast-slug", completeSubmission, CLIENT_IP),
      );
      expect(error).toMatchObject({ reason: "transient" });
      expect(error.message).toBe("Review submission failed.");
    }
  });

  it("T14 sanitises non-SqlApiError failures as transient", async () => {
    const leakedDetail = "connector host private-key PEM raw-IP traceback";
    executeStatementMock.mockRejectedValueOnce(new Error(leakedDetail));

    const error = await capturedError(
      submitReview("roast-slug", completeSubmission, CLIENT_IP),
    );
    expect(error.reason).toBe("transient");
    expect(error.message).toBe("Review submission failed.");
    expect(error.message).not.toContain(leakedDetail);
  });

  it("T15 drops a non-empty honeypot value entirely", async () => {
    const websiteSentinel = "HONEYPOT-WEBSITE-SENTINEL";
    const submission = {
      ...completeSubmission,
      website: websiteSentinel,
    } as unknown as ReviewSubmission;
    await submitReview("roast-slug", submission, CLIENT_IP);

    const [statement, bindings] = executeStatementMock.mock.calls[0] as [
      string,
      Bindings,
    ];
    expect(statement).not.toContain(websiteSentinel);
    expect(JSON.stringify(bindings)).not.toContain(websiteSentinel);
    expect(Object.keys(bindings)).toHaveLength(11);
  });

  it("T16 fails closed without a non-empty pepper before transport", async () => {
    delete process.env.REVIEW_IP_HASH_PEPPER;
    let error = await capturedError(
      submitReview("roast-slug", completeSubmission, CLIENT_IP),
    );
    expect(error).toMatchObject({ reason: "transient" });
    expect(executeStatementMock).not.toHaveBeenCalled();

    for (const emptyPepper of ["", "   "]) {
      vi.stubEnv("REVIEW_IP_HASH_PEPPER", emptyPepper);
      error = await capturedError(
        submitReview("roast-slug", completeSubmission, CLIENT_IP),
      );
      expect(error.message).toBe("Review submission failed.");
      expect(executeStatementMock).not.toHaveBeenCalled();
    }
  });
});
