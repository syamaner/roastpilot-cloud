"use client";

import { useRef, useState, type FormEvent } from "react";
import type { Review } from "@/lib/roast";
import { FlavorSliders } from "./FlavorSliders";
import { StarRating } from "./StarRating";
import {
  buildPayload,
  EMPTY_REVIEW_STATE,
  mapSubmitResponse,
  validateReview,
  type FlavorKey,
  type ReviewFormState,
} from "./review-form-logic";

interface ReviewFormProps {
  slug: string;
  onSubmitted: (review: Review) => void;
}

type FieldErrors = Record<string, string[]>;

function allErrorMessages(errors: FieldErrors): string[] {
  return Object.values(errors).flat();
}

export function ReviewForm({ slug, onSubmitted }: ReviewFormProps) {
  const [state, setState] = useState<ReviewFormState>(EMPTY_REVIEW_STATE);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const honeypotRef = useRef<HTMLInputElement>(null);

  function updateText(
    key: "reviewerName" | "notes" | "brewMethod",
    value: string,
  ) {
    setState((current) => ({ ...current, [key]: value }));
  }

  function updateFlavor(key: FlavorKey, value: number | null) {
    setState((current) => ({ ...current, [key]: value }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const validation = validateReview(state);
    if (!validation.ok) {
      setFieldErrors(validation.fieldErrors);
      setMessage(null);
      return;
    }

    setSubmitting(true);
    setFieldErrors({});
    setMessage(null);

    try {
      const website = honeypotRef.current?.value ?? "";
      const payload = buildPayload({ ...state, website });
      const response = await fetch(`/api/r/${encodeURIComponent(slug)}/reviews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const result = mapSubmitResponse(response.status, body);

      if (result.kind === "success") {
        const optimisticReview: Review = {
          public_slug: slug,
          reviewer_name: payload.reviewerName ?? null,
          score: payload.score,
          aroma: payload.aroma ?? null,
          acidity: payload.acidity ?? null,
          sweetness: payload.sweetness ?? null,
          body: payload.body ?? null,
          aftertaste: payload.aftertaste ?? null,
          brew_method: payload.brewMethod ?? null,
          notes: payload.notes ?? null,
          created_at: new Date().toISOString(),
        };
        onSubmitted(optimisticReview);
        setState(EMPTY_REVIEW_STATE);
        setSubmitted(true);
        return;
      }

      if (result.kind === "validation") {
        setFieldErrors(result.fieldErrors);
      } else {
        setMessage(result.message);
      }
    } catch {
      setMessage(mapSubmitResponse("network", null).message);
    } finally {
      setSubmitting(false);
    }
  }

  if (submitted) {
    return (
      <p
        className="rounded-card border border-border bg-surface p-6 text-center font-semibold text-foreground shadow-lg"
        role="status"
        aria-live="polite"
      >
        Thanks — your tasting was saved
      </p>
    );
  }

  const errors = allErrorMessages(fieldErrors);
  const describedBy = errors.length > 0 || message !== null ? "review-errors" : undefined;

  return (
    <section className="space-y-6" aria-label="Submit a review">
      <h2 className="text-2xl font-bold text-foreground">Review this roast</h2>
      <form
        className="space-y-6"
        onSubmit={handleSubmit}
        aria-describedby={describedBy}
      >
        {errors.length > 0 ? (
          <div
            className="rounded-input border border-primary-strong bg-[var(--rp-surface-muted)] p-4 text-foreground"
            id="review-errors"
            role="alert"
          >
            {errors.map((error, index) => (
              <p key={`${error}-${index}`}>{error}</p>
            ))}
          </div>
        ) : message === null ? null : (
          <p
            className="rounded-input border border-primary-strong bg-[var(--rp-surface-muted)] p-4 text-foreground"
            id="review-errors"
            role="alert"
          >
            {message}
          </p>
        )}

        <fieldset className="rounded-card border border-border bg-surface p-6 text-center shadow-lg">
          <legend className="px-2 text-lg font-semibold text-foreground">
            Overall score (required)
          </legend>
          <StarRating
            value={state.score}
            onChange={(score) => setState((current) => ({ ...current, score }))}
          />
        </fieldset>

        <FlavorSliders values={state} onChange={updateFlavor} />

        <div className="rounded-card border border-border bg-surface p-6 shadow-lg">
          <label
            className="mb-2 block font-semibold text-foreground"
            htmlFor="reviewer-name"
          >
            First name (optional)
          </label>
          <input
            className="w-full rounded-input border border-foreground-muted bg-surface px-4 py-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary-strong"
            id="reviewer-name"
            name="reviewerName"
            maxLength={80}
            value={state.reviewerName}
            onChange={(event) => updateText("reviewerName", event.target.value)}
          />
        </div>

        <div className="rounded-card border border-border bg-surface p-6 shadow-lg">
          <label
            className="mb-2 block font-semibold text-foreground"
            htmlFor="brew-method"
          >
            Brew method (optional)
          </label>
          <input
            className="w-full rounded-input border border-foreground-muted bg-surface px-4 py-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary-strong"
            id="brew-method"
            name="brewMethod"
            maxLength={40}
            value={state.brewMethod}
            onChange={(event) => updateText("brewMethod", event.target.value)}
          />
        </div>

        <div className="rounded-card border border-border bg-surface p-6 shadow-lg">
          <label
            className="mb-2 block font-semibold text-foreground"
            htmlFor="review-notes"
          >
            Tasting notes (optional)
          </label>
          <textarea
            className="min-h-32 w-full resize-y rounded-input border border-foreground-muted bg-surface px-4 py-3 text-foreground focus:outline-none focus:ring-2 focus:ring-primary-strong"
            id="review-notes"
            name="notes"
            maxLength={2000}
            value={state.notes}
            onChange={(event) => updateText("notes", event.target.value)}
          />
        </div>

        <label
          htmlFor="review-website"
          style={{ position: "absolute", left: "-9999px" }}
          aria-hidden="true"
        >
          Website
          <input
            ref={honeypotRef}
            id="review-website"
            name="website"
            defaultValue=""
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            style={{ position: "absolute", left: "-9999px" }}
          />
        </label>

        <button
          className="w-full cursor-pointer rounded-full border-0 bg-primary-strong px-6 py-3 font-semibold text-on-amber transition-colors hover:bg-primary focus:outline-none focus:ring-2 focus:ring-primary-strong focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          type="submit"
          disabled={submitting}
        >
          {submitting ? "Submitting…" : "Submit review"}
        </button>
      </form>
    </section>
  );
}
