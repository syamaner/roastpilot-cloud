import type { ReviewSubmission } from "@/lib/review-schema";

export const FLAVOR_KEYS = [
  "aroma",
  "acidity",
  "sweetness",
  "body",
  "aftertaste",
] as const;

export type FlavorKey = (typeof FLAVOR_KEYS)[number];
export type FlavorValues = Record<FlavorKey, number | null>;

export interface ReviewFormState extends FlavorValues {
  score: number | null;
  reviewerName: string;
  notes: string;
  brewMethod: string;
  website: string;
}

export const EMPTY_REVIEW_STATE: ReviewFormState = {
  score: null,
  aroma: null,
  acidity: null,
  sweetness: null,
  body: null,
  aftertaste: null,
  reviewerName: "",
  notes: "",
  brewMethod: "",
  website: "",
};

export type ReviewValidation =
  | { ok: true }
  | { ok: false; fieldErrors: Record<string, string[]> };

export function validateReview(state: ReviewFormState): ReviewValidation {
  if (state.score === null) {
    return {
      ok: false,
      fieldErrors: { score: ["Choose an overall score."] },
    };
  }
  return { ok: true };
}

export type ReviewPayload = Omit<ReviewSubmission, "website"> & {
  website: string;
};

export function buildPayload(state: ReviewFormState): ReviewPayload {
  if (state.score === null) {
    throw new Error("A score is required before building a review payload.");
  }

  const payload: ReviewPayload = {
    score: state.score,
    website: state.website,
  };

  for (const key of FLAVOR_KEYS) {
    const value = state[key];
    if (value !== null) payload[key] = value;
  }

  const reviewerName = state.reviewerName.trim();
  const notes = state.notes.trim();
  const brewMethod = state.brewMethod.trim();
  if (reviewerName !== "") payload.reviewerName = reviewerName;
  if (notes !== "") payload.notes = notes;
  if (brewMethod !== "") payload.brewMethod = brewMethod;

  return payload;
}

type FieldErrors = Record<string, string[]>;

export type SubmitResult =
  | { kind: "success"; preserveInput: false }
  | { kind: "validation"; fieldErrors: FieldErrors; preserveInput: true }
  | { kind: "rate_limited"; message: string; preserveInput: true }
  | { kind: "error"; message: string; preserveInput: true };

const RATE_LIMIT_MESSAGE =
  "Too many reviews have been sent from this connection. Please wait and try again.";
const RETRY_MESSAGE = "We couldn't submit your review. Please try again.";

function fieldErrorsFrom(body: unknown): FieldErrors {
  if (typeof body !== "object" || body === null || !("fieldErrors" in body)) {
    return { form: ["Please check your review and try again."] };
  }
  const candidate = body.fieldErrors;
  if (typeof candidate !== "object" || candidate === null) {
    return { form: ["Please check your review and try again."] };
  }

  const errors: FieldErrors = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      errors[key] = value;
    }
  }
  return Object.keys(errors).length > 0
    ? errors
    : { form: ["Please check your review and try again."] };
}

export function mapSubmitResponse(
  status: "network",
  body: unknown,
): Extract<SubmitResult, { kind: "error" }>;
export function mapSubmitResponse(status: number, body: unknown): SubmitResult;
export function mapSubmitResponse(
  status: number | "network",
  body: unknown,
): SubmitResult {
  if (status === 200) return { kind: "success", preserveInput: false };
  if (status === 400) {
    return {
      kind: "validation",
      fieldErrors: fieldErrorsFrom(body),
      preserveInput: true,
    };
  }
  if (status === 429) {
    return {
      kind: "rate_limited",
      message: RATE_LIMIT_MESSAGE,
      preserveInput: true,
    };
  }
  return { kind: "error", message: RETRY_MESSAGE, preserveInput: true };
}
