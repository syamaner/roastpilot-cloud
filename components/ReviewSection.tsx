"use client";

import { useState } from "react";
import type { Review } from "@/lib/roast";
import { ReviewForm } from "./ReviewForm";
import { ReviewsList } from "./ReviewsList";

interface ReviewSectionProps {
  slug: string;
  reviews: Review[];
}

export function ReviewSection({ slug, reviews }: ReviewSectionProps) {
  const [extraReviews, setExtraReviews] = useState<Review[]>([]);

  return (
    <>
      <ReviewsList reviews={[...extraReviews, ...reviews]} />
      <ReviewForm
        slug={slug}
        onSubmitted={(review) =>
          setExtraReviews((current) => [review, ...current])
        }
      />
    </>
  );
}
