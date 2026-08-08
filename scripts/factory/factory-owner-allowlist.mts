/**
 * The single repo-wide factory-owner allowlist. This base-owned protected
 * configuration under `scripts/factory/**` may be extended only by a
 * human-reviewed base change; a second allowlist definition anywhere is a
 * review blocker.
 */
export const FACTORY_OWNER_LOGINS: ReadonlySet<string> = new Set(["syamaner"]);

/** Authorize a factory owner by exact, unnormalised login bytes. */
export function isFactoryOwnerLogin(login: unknown): boolean {
  return typeof login === "string" && FACTORY_OWNER_LOGINS.has(login);
}
