/** Authenticated GET orchestration through an injected public-page reader. */
import { authenticateCaller } from "./caller-auth";
import { jsonFailure, validGetShape } from "./http";
import { decideReviewPage, matchesIfNoneMatch, parseCursor, parseIfNoneMatch, reviewETag, serializePage } from "./review-page";
import type { Cursor, PageResult } from "./review-page";
import { isValidSlug } from "../slug";

/** The GET consumer needs only two ordered, uncached public observations. */
export interface ReviewPageReader {
  readPage(slug: string, cursor: Cursor | null): Promise<PageResult>;
  readState(slug: string): Promise<PageResult>;
}

/** Authenticate and validate all pure inputs before the first reader effect. */
export async function reviewsGet(request: Request, slug: string, reader: ReviewPageReader, readSecret: () => string | undefined): Promise<Response> {
  const auth = authenticateCaller(readSecret, () => request.headers.get("authorization"));
  if (!auth.ok) return jsonFailure(auth.status, auth.error, undefined, auth.status === 401 ? { "WWW-Authenticate": "Bearer" } : {});
  if (request.method !== "GET") return jsonFailure(405, "method_not_allowed", undefined, { Allow: "GET" });
  if (!validGetShape(request)) return jsonFailure(400, "invalid_request");
  if (!isValidSlug(slug)) return jsonFailure(404, "not_found");
  const rawCursor = new URL(request.url).searchParams.get("cursor");
  const cursor = rawCursor === null ? null : parseCursor(rawCursor, slug);
  if (rawCursor !== null && cursor === null) return jsonFailure(400, "invalid_cursor");
  const conditional = parseIfNoneMatch(request.headers.get("if-none-match"));
  try {
    const page = await reader.readPage(slug, cursor);
    const state = await reader.readState(slug);
    const decision = decideReviewPage(page, state, cursor, slug);
    if (decision.kind === "error") return jsonFailure(decision.status, decision.error, decision.reason);
    const body = serializePage(slug, decision.reviews, decision.nextCursor);
    const etag = reviewETag(slug, rawCursor, body);
    if (matchesIfNoneMatch(conditional, etag)) return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": "private, no-cache" } });
    return new Response(body, { status: 200, headers: { "content-type": "application/json", "Cache-Control": "private, no-cache", ETag: etag } });
  } catch {
    return jsonFailure(503, "unavailable");
  }
}
