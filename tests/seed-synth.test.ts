import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isValidSlug } from "../lib/slug";
import { IP_HASH_PATTERN } from "../scripts/seed/rules";
import {
  createSeededRng,
  SYNTHETIC_NAME_POOL,
  synthIdempotencyKey,
  synthIpHash,
  synthReviewerName,
  synthSessionId,
  synthSlug,
} from "../scripts/seed/synth";

describe("synthetic seed values", () => {
  it("draws reviewer names only from the clearly synthetic pool", () => {
    const rng = createSeededRng(11);
    const names = Array.from({ length: 100 }, () => synthReviewerName(rng));
    expect(names.every((name) => SYNTHETIC_NAME_POOL.includes(name))).toBe(true);
  });

  it("generates valid public slugs", () => {
    const rng = createSeededRng(12);
    for (let index = 0; index < 100; index += 1) {
      expect(isValidSlug(synthSlug(rng))).toBe(true);
    }
  });

  it("hashes only synthetic tokens, disjoint from real-looking IP controls", () => {
    const controls = ["127.0.0.1", "192.168.0.1", "10.0.0.1", "8.8.8.8"];
    const controlHashes = new Set(
      controls.map((ip) => createHash("sha256").update(ip).digest("hex")),
    );
    const rng = createSeededRng(13);
    const hashes = Array.from({ length: 500 }, () => synthIpHash(rng));

    expect(hashes.every((hash) => IP_HASH_PATTERN.test(hash))).toBe(true);
    expect(hashes.some((hash) => controlHashes.has(hash))).toBe(false);
  });

  it("generates unique idempotency keys across 1000 fixed-seed draws", () => {
    const rng = createSeededRng(14);
    const values = Array.from({ length: 1_000 }, () => synthIdempotencyKey(rng));
    expect(new Set(values)).toHaveLength(values.length);
  });

  it("generates unique session ids across 1000 fixed-seed draws", () => {
    const rng = createSeededRng(15);
    const values = Array.from({ length: 1_000 }, () => synthSessionId(rng));
    expect(new Set(values)).toHaveLength(values.length);
  });
});
