import { formatReviewerName } from "../lib/format";
import type { Review } from "@/lib/roast";

export function ReviewsList({ reviews }: { reviews: Review[] }) {
  if (reviews.length === 0) {
    return (
      <section aria-label="Taster reviews">
        <p>Be the first to taste this roast</p>
      </section>
    );
  }

  return (
    <section aria-label="Taster reviews">
      <h2>Taster reviews</h2>
      <ol>
        {reviews.map((review, index) => (
          <li
            data-testid="review-row"
            key={`${review.public_slug}-${review.created_at}-${index}`}
          >
            <h3>{formatReviewerName(review.reviewer_name)}</h3>
            <p>Score: {review.score}</p>
            {review.notes === null ? null : <p>{review.notes}</p>}
          </li>
        ))}
      </ol>
    </section>
  );
}
