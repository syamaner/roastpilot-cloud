/** HTTP boundary: exact request shape and grammar-bounded body reader. */
import { NONCE_BODY_BYTES } from "./revalidation-request";
export interface RevalidationRequestView { readonly method: string; readonly url: string; readonly headers: Headers }
export type ShapeCheck = { ok: true } | { ok: false; status: 400 | 405 | 415; error: "invalid_request" | "method_not_allowed" | "unsupported_media_type" };

export function checkRevalidationShape(request: RevalidationRequestView): ShapeCheck {
  if (request.method !== "POST") return { ok: false, status: 405, error: "method_not_allowed" };
  if (request.url.includes("?")) return { ok: false, status: 400, error: "invalid_request" };
  if (request.headers.get("content-type")?.toLowerCase() !== "application/json") return { ok: false, status: 415, error: "unsupported_media_type" };
  if (request.headers.has("transfer-encoding") || request.headers.has("content-encoding")) return { ok: false, status: 400, error: "invalid_request" };
  if (request.headers.get("content-length") !== String(NONCE_BODY_BYTES)) return { ok: false, status: 400, error: "invalid_request" };
  return { ok: true };
}
export type BodyRead =
  | { kind: "bytes"; bytes: Uint8Array }
  | { kind: "absent" }
  | { kind: "too_large" }
  | { kind: "read_failed" };

export async function readBoundedBody(body: ReadableStream<Uint8Array> | null, limit: number): Promise<BodyRead> {
  if (body === null) return { kind: "absent" };
  try {
    const reader = body.getReader();
    const out = new Uint8Array(limit);
    let length = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return { kind: "bytes", bytes: out.slice(0, length) };
      if (!(chunk.value instanceof Uint8Array)) return { kind: "read_failed" };
      if (length + chunk.value.byteLength > limit) {
        await reader.cancel();
        return { kind: "too_large" };
      }
      out.set(chunk.value, length);
      length += chunk.value.byteLength;
    }
  } catch {
    return { kind: "read_failed" };
  }
}
