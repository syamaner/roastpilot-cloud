import { formatReviewerName } from "../lib/format";
import type { Review } from "@/lib/roast";

export function ReviewsList({ reviews }: { reviews: Review[] }) {
  if (reviews.length === 0) {
    return (
      <section aria-label="Taster reviews" className="space-y-3">
        <h2 className="text-xl font-bold">Taster reviews</h2>
        <p className="rounded-control border border-border bg-surface p-6 text-foreground-muted shadow-sm">
          Be the first to taste this roast
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Taster reviews" className="space-y-3">
      <h2 className="text-xl font-bold">Taster reviews</h2>
      <ol className="space-y-3">
        {reviews.map((review, index) => (
          <li
            className="rounded-control border border-border bg-surface p-5 shadow-sm"
            data-testid="review-row"
            key={`${review.public_slug}-${review.created_at}-${index}`}
          >
            <h3 className="font-semibold">
              {formatReviewerName(review.reviewer_name)}
            </h3>
            <p className="text-sm text-foreground-muted">
              Score: {review.score}
            </p>
            {review.notes === null ? null : (
              <p className="mt-2">{review.notes}</p>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
