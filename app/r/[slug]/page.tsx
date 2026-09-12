import type { Metadata } from "next";
import { cachedReviewsByRoast, cachedRoastBySlug } from "@/lib/roast-cache";
import {
  aggregateRating,
  beanLabel,
  roastDateLabel,
} from "@/lib/roast-format";
import { isValidSlug } from "@/lib/slug";
import { notFound } from "next/navigation";
import RoastCurve from "../../../components/RoastCurve";
import { ReviewsList } from "../../../components/ReviewsList";
import { RoastHeadline } from "../../../components/RoastHeadline";

export const revalidate = 300;

const MINIMAL_METADATA: Metadata = { title: "RoastPilot Cloud" };

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  if (!isValidSlug(slug)) return MINIMAL_METADATA;

  const roast = await cachedRoastBySlug(slug);
  if (roast === null) return MINIMAL_METADATA;

  const reviews = await cachedReviewsByRoast(slug);
  const rating = aggregateRating(reviews);
  const roastDate = roastDateLabel(roast);
  const ratingText =
    rating === null ? "No ratings yet" : `${rating.toFixed(1)} / 5`;
  const description =
    roastDate === null ? ratingText : `${roastDate} · ${ratingText}`;
  const title = beanLabel(roast);

  return {
    title,
    description,
    openGraph: { title, description },
    twitter: { card: "summary_large_image", title, description },
  };
}

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
