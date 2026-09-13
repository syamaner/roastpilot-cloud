import { revalidatePath } from "next/cache";

import { extractClientIp } from "../../../../../lib/client-ip";
import { checkHoneypot, checkRateLimit } from "../../../../../lib/ratelimit";
import { ReviewSubmissionSchema } from "../../../../../lib/review-schema";
import { submitReview } from "../../../../../lib/review-submit";
import { isValidSlug } from "../../../../../lib/slug";

export const runtime = "nodejs";

const jsonError = (status: number, error: string) =>
  Response.json({ error }, { status });

const successResponse = () => Response.json({ ok: true }, { status: 200 });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const { slug } = await params;
  if (!isValidSlug(slug)) {
    return jsonError(404, "Not found");
  }

  // Requiring JSON forces a cross-origin browser POST through a CORS preflight
  // this route does not answer, blocking simple-request review stuffing that
  // could otherwise distribute submissions across each visitor's IP.
  const contentType = request.headers.get("content-type")?.trim().toLowerCase();
  if (contentType === undefined || !contentType.startsWith("application/json")) {
    return jsonError(415, "Unsupported Media Type");
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return jsonError(400, "Invalid request");
  }

  const website =
    typeof rawBody === "object" && rawBody !== null
      ? ((rawBody as { website?: unknown }).website as string | undefined)
      : undefined;
  const honeypotDecision = checkHoneypot(website);
  if (!honeypotDecision.allowed && honeypotDecision.reason === "honeypot") {
    return successResponse();
  }

  const result = ReviewSubmissionSchema.safeParse(rawBody);
  if (!result.success) {
    return Response.json(
      {
        error: "Invalid request",
        fieldErrors: result.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }

  const ip = extractClientIp(request);
  const rateLimitDecision = await checkRateLimit(ip);
  if (!rateLimitDecision.allowed) {
    if (rateLimitDecision.reason === "rate_limited") {
      return Response.json(
        { error: "Too many review attempts. Please try again later." },
        {
          status: 429,
          headers: {
            "Retry-After": String(rateLimitDecision.retryAfterSeconds ?? 0),
          },
        },
      );
    }
    return jsonError(429, "Review submission is temporarily unavailable.");
  }

  try {
    await submitReview(slug, result.data, ip);
  } catch {
    return jsonError(503, "Review submission is temporarily unavailable.");
  }

  revalidatePath(`/r/${slug}`);
  return successResponse();
}
