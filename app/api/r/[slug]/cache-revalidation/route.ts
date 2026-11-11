import { cacheRevalidationPost } from "../../../../../lib/c3/cache-revalidation";
import { createPublicAbsenceReader } from "../../../../../lib/c3/absence-sql";
import { nextLegacyCacheInvalidator } from "../../../../../lib/c3/next-legacy-cache-invalidator";

export const runtime = "nodejs";

/** Authenticated legacy-cache acknowledgement; configuration, SQL and cache effects occur only on invocation. */
export async function POST(request: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return cacheRevalidationPost(request, slug, createPublicAbsenceReader(), nextLegacyCacheInvalidator, () => process.env.ROASTPILOT_C3_CALLER_SECRET);
}
