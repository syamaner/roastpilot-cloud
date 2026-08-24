import { createHash } from "node:crypto";
import { isValidSlug, MIN_SLUG_LENGTH } from "../../lib/slug";
import { IP_HASH_PATTERN } from "./rules";

export type SeededRng = () => number;

export const SYNTHETIC_NAME_POOL = [
  "Test Taster Alpha",
  "Mock Reviewer Beta",
  "Sample Sipper Gamma",
] as const;

export const SYNTHETIC_IP_TOKEN_PREFIX = "roastpilot-synthetic-ip-token:";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const RNG_SEQUENCE = new WeakMap<SeededRng, number>();

export function createSeededRng(seed: number): SeededRng {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function randomToken(rng: SeededRng, length = 24): string {
  let token = "";
  for (let index = 0; index < length; index += 1) {
    token += BASE58_ALPHABET[Math.floor(rng() * BASE58_ALPHABET.length)];
  }
  return token;
}

function nextSequence(rng: SeededRng): number {
  const sequence = RNG_SEQUENCE.get(rng) ?? 0;
  RNG_SEQUENCE.set(rng, sequence + 1);
  return sequence;
}

export function synthSlug(rng: SeededRng): string {
  const slug = randomToken(rng, MIN_SLUG_LENGTH);
  /* v8 ignore next 3 -- unreachable unless the slug constants drift. */
  if (!isValidSlug(slug)) {
    throw new Error("Synthetic slug generator produced an invalid slug");
  }
  return slug;
}

export function synthIdempotencyKey(rng: SeededRng): string {
  return `synthetic-idempotency-${nextSequence(rng)}-${randomToken(rng)}`;
}

export function synthSessionId(rng: SeededRng): string {
  return `synthetic-session-${nextSequence(rng)}-${randomToken(rng)}`;
}

export function synthReviewerName(
  rng: SeededRng,
): (typeof SYNTHETIC_NAME_POOL)[number] {
  return SYNTHETIC_NAME_POOL[
    Math.floor(rng() * SYNTHETIC_NAME_POOL.length)
  ];
}

export function synthIpHash(rng: SeededRng): string {
  const token = `${SYNTHETIC_IP_TOKEN_PREFIX}${randomToken(rng)}`;
  const hash = createHash("sha256").update(token).digest("hex");
  /* v8 ignore next 3 -- unreachable unless the SHA-256 contract drifts. */
  if (!IP_HASH_PATTERN.test(hash)) {
    throw new Error("Synthetic IP-token hash has an invalid shape");
  }
  return hash;
}
