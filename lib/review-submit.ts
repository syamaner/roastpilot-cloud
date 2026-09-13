import { createHmac } from "node:crypto";
import type { ReviewSubmission } from "./review-schema";
import { executeStatement, SqlApiError } from "./sqlapi";

const SUBMIT_REVIEW_STATEMENT =
  "call submit_review(:1, :2, :3, :4, :5, :6, :7, :8, :9, :10, :11)";
const REVIEW_SUBMIT_ERROR_MESSAGE = "Review submission failed.";

export interface ReviewSubmitResult {
  reviewId: string;
}

// `invalid_request` is reserved for a future SQLCODE-aware path when #526's
// -20017/-20018 guards land; the current kind-based mapping produces transient.
export type ReviewSubmitFailure = "invalid_request" | "transient";

export class ReviewSubmitError extends Error {
  readonly reason: ReviewSubmitFailure;

  constructor(reason: ReviewSubmitFailure) {
    super(REVIEW_SUBMIT_ERROR_MESSAGE);
    this.name = "ReviewSubmitError";
    this.reason = reason;
  }
}

const SQL_API_FAILURE_REASONS: Record<string, ReviewSubmitFailure> = {
  not_found: "transient",
  auth: "transient",
  config: "transient",
  transport: "transient",
};

function sqlApiFailureReason(error: SqlApiError): ReviewSubmitFailure {
  // TODO(#526): map -20017/-20018 when S1 lands
  // Unknown future kinds default to transient so an unrecognised failure fails closed.
  return SQL_API_FAILURE_REASONS[error.kind] ?? "transient";
}

function nullableText(value: string | null | undefined) {
  return { type: "TEXT", value: value ?? null };
}

function nullableFixed(value: number | null | undefined) {
  return { type: "FIXED", value: value == null ? null : String(value) };
}

function hashClientIp(clientIp: string): string {
  const pepper = process.env.REVIEW_IP_HASH_PEPPER;
  if (pepper === undefined || pepper.trim() === "") {
    throw new ReviewSubmitError("transient");
  }

  return createHmac("sha256", pepper)
    .update(clientIp.trim().toLowerCase())
    .digest("hex");
}

export async function submitReview(
  slug: string,
  submission: ReviewSubmission,
  clientIp: string,
): Promise<ReviewSubmitResult> {
  const submittedIpHash = hashClientIp(clientIp);
  const bindings = {
    "1": { type: "TEXT", value: slug },
    "2": nullableText(submission.reviewerName),
    "3": { type: "FIXED", value: String(submission.score) },
    "4": nullableFixed(submission.aroma),
    "5": nullableFixed(submission.acidity),
    "6": nullableFixed(submission.sweetness),
    "7": nullableFixed(submission.body),
    "8": nullableFixed(submission.aftertaste),
    "9": nullableText(submission.brewMethod),
    "10": nullableText(submission.notes),
    "11": { type: "TEXT", value: submittedIpHash },
  };

  let result;
  try {
    result = await executeStatement(SUBMIT_REVIEW_STATEMENT, bindings);
  } catch (error) {
    const reason =
      error instanceof SqlApiError
        ? sqlApiFailureReason(error)
        : "transient";
    throw new ReviewSubmitError(reason);
  }

  const reviewId = result.rows[0]?.[0];
  if (
    result.rowCount !== 1 ||
    typeof reviewId !== "string" ||
    reviewId.trim() === ""
  ) {
    throw new ReviewSubmitError("transient");
  }

  return { reviewId };
}
