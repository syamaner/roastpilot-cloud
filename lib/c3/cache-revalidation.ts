/** Authenticated C3B orchestration over consumer-owned ports. */
import { authenticateCaller } from "./caller-auth";
import { jsonFailure } from "./http";
import { readBoundedBody, checkRevalidationShape } from "./bounded-body";
import type { RevalidationRequestView } from "./bounded-body";
import { NONCE_BODY_BYTES, absenceReason, completeBody, parseNonceBody, pendingBody } from "./revalidation-request";
import type { Absence } from "./revalidation-request";
import { isValidSlug } from "../slug";

export interface PublicAbsenceReader { readAbsence(slug: string): Promise<Absence> }
export interface LegacyCacheInvalidator { invalidateLegacyRoast(slug: string): void }
export interface RevalidationRequest extends RevalidationRequestView { readonly body: ReadableStream<Uint8Array> | null }

const json = (status: number, body: string) => new Response(body, { status, headers: { "content-type": "application/json", "Cache-Control": "no-store" } });

async function observe(reader: PublicAbsenceReader, slug: string): Promise<Absence | "unavailable"> {
  try { return await reader.readAbsence(slug); } catch { return "unavailable"; }
}


export async function cacheRevalidationPost(request: RevalidationRequest, slug: string, reader: PublicAbsenceReader, invalidator: LegacyCacheInvalidator, readSecret: () => string | undefined): Promise<Response> {
  const auth = authenticateCaller(readSecret, () => request.headers.get("authorization"));
  if (!auth.ok) return jsonFailure(auth.status, auth.error, undefined, auth.status === 401 ? { "WWW-Authenticate": "Bearer" } : {});
  const shape = checkRevalidationShape(request);
  if (!shape.ok) return jsonFailure(shape.status, shape.error, undefined, shape.status === 405 ? { Allow: "POST" } : {});
  if (!isValidSlug(slug)) return jsonFailure(404, "not_found");
  const read = await readBoundedBody(request.body, NONCE_BODY_BYTES);
  const nonce = read.kind === "bytes" ? parseNonceBody(read.bytes) : null;
  if (nonce === null) return jsonFailure(400, "invalid_request");
  const before = absenceReason(await observe(reader, slug));
  if (before !== null) return json(202, pendingBody(slug, nonce, before));
  try { invalidator.invalidateLegacyRoast(slug); } catch { return json(202, pendingBody(slug, nonce, "invalidation_failed")); }
  const after = absenceReason(await observe(reader, slug));
  if (after !== null) return json(202, pendingBody(slug, nonce, after));
  return json(200, completeBody(slug, nonce));
}
