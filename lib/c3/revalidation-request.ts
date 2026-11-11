/** Closed C3B request/response grammar. Pure: no framework, SQL or environment access. */
import { z } from "zod";

export const NONCE_BODY_BYTES = 63;
const NonceBodySchema = z.string().regex(/^\{"request_nonce":"([A-Za-z0-9_-]{43})"\}$/);

export type Absence = { kind: "absent" } | { kind: "present" } | { kind: "invalid" };
export type PendingReason = "view_present" | "view_invalid" | "view_unavailable" | "invalidation_failed";

export function parseNonceBody(bytes: Uint8Array): string | null {
  const parsed = NonceBodySchema.safeParse(String.fromCharCode(...bytes));
  if (!parsed.success) return null;
  const nonce = parsed.data.slice(-45, -2);
  return Buffer.from(nonce, "base64url").toString("base64url") === nonce ? nonce : null;
}

export function absenceReason(observed: Absence | "unavailable"): PendingReason | null {
  if (observed === "unavailable") return "view_unavailable";
  const kind = observed?.kind;
  if (kind === "absent") return null;
  if (kind === "present") return "view_present";
  return "view_invalid";
}

export function completeBody(slug: string, nonce: string): string {
  return JSON.stringify({ api_version: 1, public_slug: slug, request_nonce: nonce, cache_invalidation: "complete", evidence: { view: "absent_uncached_before_and_after", current_render: "uncached", invalidation_calls: "requested", legacy_cache: "transition_qualified_non_servability" } });
}

export function pendingBody(slug: string, nonce: string, reason: PendingReason): string {
  return JSON.stringify({ api_version: 1, public_slug: slug, request_nonce: nonce, cache_invalidation: "pending", reason });
}
