import { getReviewsByRoast, getRoastBySlug } from "@/lib/roast";
import { isValidSlug } from "@/lib/slug";
import { unstable_cache } from "next/cache";
import { notFound } from "next/navigation";
import RoastCurve from "../../../components/RoastCurve";
import { ReviewsList } from "../../../components/ReviewsList";
import { RoastHeadline } from "../../../components/RoastHeadline";

export const revalidate = 300;

const cachedRoastBySlug = unstable_cache(
  (slug: string) => getRoastBySlug(slug),
  ["roast-by-slug"],
  { revalidate: 300 },
);

const cachedReviewsByRoast = unstable_cache(
  (slug: string) => getReviewsByRoast(slug),
  ["reviews-by-roast"],
  { revalidate: 300 },
);

export function generateStaticParams() {
  return [];
}

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  if (!isValidSlug(slug)) notFound();

  const roast = await cachedRoastBySlug(slug);

  if (roast === null) notFound();

  const reviews = await cachedReviewsByRoast(slug);

  return (
    <main>
      <RoastHeadline roast={roast} />
      <RoastCurve curve={roast.curve} />
      <ReviewsList reviews={reviews} />
    </main>
  );
}
