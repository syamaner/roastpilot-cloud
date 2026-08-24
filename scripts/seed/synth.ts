import { createHash } from "node:crypto";
import { isValidSlug, MIN_SLUG_LENGTH } from "../../lib/slug";
import { CLOUD_ROAST_ID_PATTERN, IP_HASH_PATTERN } from "./rules";

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

export function synthCloudRoastId(rng: SeededRng): string {
  const bytes = Array.from({ length: 16 }, () => Math.floor(rng() * 256));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0"));
  const id = [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
  /* v8 ignore next 3 -- unreachable unless the UUID contract drifts. */
  if (!CLOUD_ROAST_ID_PATTERN.test(id)) {
    throw new Error("Synthetic cloud roast id has an invalid shape");
  }
  return id;
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
