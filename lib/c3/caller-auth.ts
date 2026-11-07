/** Closed C3 caller admission. Format validation is not entropy qualification. */
import { createHash, timingSafeEqual } from "node:crypto";

export type CallerAuth = { ok: true } | { ok: false; status: 401 | 503; error: "unauthorized" | "not_configured" };

/** Check canonical 32-byte base64url configuration without trimming. */
export function isCanonicalSecret(value: string | undefined): value is string {
  if (value === undefined || !/^rpc3_[A-Za-z0-9_-]{43}$/.test(value)) return false;
  const bytes = Buffer.from(value.slice(5), "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === value.slice(5);
}

/** Authenticate before even reading a header when configuration is malformed. */
export function authenticateCaller(readSecret: () => string | undefined, readAuthorization: () => string | null): CallerAuth {
  const configured = readSecret();
  if (!isCanonicalSecret(configured)) return { ok: false, status: 503, error: "not_configured" };
  const header = readAuthorization();
  const match = header === null ? null : /^bearer (rpc3_[A-Za-z0-9_-]{43})$/i.exec(header);
  if (match === null || !isCanonicalSecret(match[1])) return { ok: false, status: 401, error: "unauthorized" };
  const tokenDigest = createHash("sha256").update(match[1]).digest();
  const configuredDigest = createHash("sha256").update(configured).digest();
  const equal = timingSafeEqual(tokenDigest, configuredDigest);
  return equal ? { ok: true } : { ok: false, status: 401, error: "unauthorized" };
}
