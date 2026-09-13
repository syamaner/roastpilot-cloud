import {
  getReviewsByRoast,
  getRoastBySlug,
  getRoastRatingBySlug,
} from "@/lib/roast";
import { unstable_cache } from "next/cache";

export const cachedRoastBySlug = unstable_cache(
  (slug: string) => getRoastBySlug(slug),
  ["roast-by-slug"],
  { revalidate: 300 },
);

export const cachedReviewsByRoast = unstable_cache(
  (slug: string) => getReviewsByRoast(slug),
  ["reviews-by-roast"],
  { revalidate: 300 },
);

export const cachedRoastRatingBySlug = unstable_cache(
  (slug: string) => getRoastRatingBySlug(slug),
  ["roast-rating-by-slug"],
  { revalidate: 300 },
);
