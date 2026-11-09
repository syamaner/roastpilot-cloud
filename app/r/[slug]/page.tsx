import type { Metadata } from "next";
import { getReviewsByRoast, getRoastBySlug, getRoastRatingBySlug } from "@/lib/roast";
import { beanLabel, roastDateLabel } from "@/lib/roast-format";
import { isValidSlug } from "@/lib/slug";
import { notFound } from "next/navigation";
import RoastCurve from "../../../components/RoastCurve";
import { ReviewSection } from "../../../components/ReviewSection";
import { RoastHeadline } from "../../../components/RoastHeadline";
import { ReportProblemLink } from "../../../components/ReportProblemLink";

export const dynamic = "force-dynamic";

const MINIMAL_METADATA: Metadata = { title: "RoastPilot Cloud" };

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  if (!isValidSlug(slug)) return MINIMAL_METADATA;

  const roast = await getRoastBySlug(slug);
  if (roast === null) return MINIMAL_METADATA;

  const { averageScore } = await getRoastRatingBySlug(slug);
  const rating = averageScore;
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

export default async function Page({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  if (!isValidSlug(slug)) notFound();

  const roast = await getRoastBySlug(slug);

  if (roast === null) notFound();

  const reviews = await getReviewsByRoast(slug);

  return (
    <main className="space-y-6 py-6">
      <RoastHeadline roast={roast} />
      <RoastCurve curve={roast.curve} />
      <ReviewSection slug={slug} reviews={reviews} />
      <ReportProblemLink />
    </main>
  );
}
