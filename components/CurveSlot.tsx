import type { CurveSample } from "@/lib/roast";

export function CurveSlot({ curve }: { curve: CurveSample[] | null }) {
  void curve;
  return <section aria-label="Roast curve" />;
}
