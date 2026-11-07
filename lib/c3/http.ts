/** C3 request-shape checks and exact, non-cacheable error responses. */

/** Enumerate query entries rather than collapsing duplicate keys. */
export function validGetShape(request: Request): boolean {
  if (request.headers.has("content-type") || request.headers.has("transfer-encoding")) return false;
  const length = request.headers.get("content-length");
  if (length !== null && length !== "0") return false;
  const query = new URL(request.url).searchParams;
  for (const [key] of query.entries()) if (key !== "cursor") return false;
  if (query.getAll("cursor").length > 1) return false;
  return true;
}

/** Build the shared exact JSON/error boundary. */
export function jsonFailure(status: number, error: string, reason?: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(reason === undefined ? { error } : { error, reason }), {
    status, headers: { "content-type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}
