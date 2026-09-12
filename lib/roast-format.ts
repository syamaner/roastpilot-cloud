import type { Review, Roast } from "@/lib/roast";

export function beanLabel(
  roast: Pick<Roast, "bean_origin" | "bean_varietal">,
): string {
  const label = [roast.bean_origin, roast.bean_varietal]
    .filter((part): part is string => part !== null)
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .join(" · ");
  return label === "" ? "Roast" : label;
}

export function roastDateLabel(
  roast: Pick<Roast, "roasted_at_utc">,
): string | null {
  if (roast.roasted_at_utc === null) return null;

  const value = roast.roasted_at_utc.trim();
  const isIsoDate = /^\d{4}-\d{2}-\d{2}/.test(value);
  if (!isIsoDate && !/^-?\d+(\.\d+)?( -?\d+)?$/.test(value)) return null;

  const date = isIsoDate
    ? new Date(value)
    : new Date(Number.parseFloat(value) * 1000);

  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

export function aggregateRating(reviews: Review[]): number | null {
  if (reviews.length === 0) return null;
  return reviews.reduce((total, review) => total + review.score, 0) /
    reviews.length;
}

export function truncateLabel(label: string, max = 48): string {
  const segments =
    typeof Intl.Segmenter === "function"
      ? Array.from(
          new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
            label,
          ),
          ({ segment }) => segment,
        )
      : Array.from(label);
  if (segments.length <= max) return label;
  return `${segments.slice(0, max).join("").trimEnd()}…`;
}
