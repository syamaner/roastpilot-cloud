/**
 * Public-roast slug validation (plan.md D11: high-entropy unlisted slug is
 * the access control for `/r/[slug]`).
 *
 * Slugs are base58-encoded and generated agent-side (plan.md §5); this repo
 * only validates the shape of an incoming route param before it is used in
 * a query, so a malformed or too-short candidate never reaches Snowflake.
 */

// Bitcoin-style base58: digits/letters minus the visually ambiguous
// 0, O, I, l.
const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const BASE58_PATTERN = new RegExp(`^[${BASE58_ALPHABET}]+$`);

const BITS_PER_BASE58_CHAR = Math.log2(BASE58_ALPHABET.length);

/** D11's floor: an unlisted slug must carry at least this much entropy. */
export const MIN_SLUG_ENTROPY_BITS = 96;

/**
 * Minimum slug length, in base58 characters, that guarantees at least
 * {@link MIN_SLUG_ENTROPY_BITS} bits of entropy.
 */
export const MIN_SLUG_LENGTH = Math.ceil(
  MIN_SLUG_ENTROPY_BITS / BITS_PER_BASE58_CHAR,
);

/**
 * Checks whether `candidate` is a well-formed public roast slug: base58
 * characters only, and long enough to meet the D11 entropy floor.
 *
 * This is a shape check, not a lookup — it never touches Snowflake. It
 * exists so a malformed `/r/[slug]` route param can be rejected before any
 * query is issued.
 *
 * @param candidate - The value taken from the `[slug]` route param.
 * @returns `true` if `candidate` looks like a real slug.
 */
export function isValidSlug(candidate: string): boolean {
  if (typeof candidate !== "string") {
    return false;
  }
  if (candidate.length < MIN_SLUG_LENGTH) {
    return false;
  }
  return BASE58_PATTERN.test(candidate);
}
