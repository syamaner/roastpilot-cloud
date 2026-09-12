import { getReviewsByRoast, getRoastBySlug } from "@/lib/roast";
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
