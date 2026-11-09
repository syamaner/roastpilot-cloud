import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
const nextCache = vi.hoisted(() => ({ revalidatePath: vi.fn() }));
vi.mock("next/cache", () => nextCache);
import { nextLegacyCacheInvalidator } from "../lib/c3/next-legacy-cache-invalidator";
const calls = () => nextCache.revalidatePath.mock.calls;
beforeEach(() => { vi.resetAllMocks(); });
it("INV-1 requests page then preview path invalidation exactly", () => {
  nextLegacyCacheInvalidator.invalidateLegacyRoast("slug");expect(calls()).toEqual([["/r/slug"],["/r/slug/opengraph-image"]]);
});
it("INV-2 synchronous throw propagates", async () => {
  const sentinel=new Error("invalidation sentinel");
  nextCache.revalidatePath.mockImplementationOnce(() => { throw sentinel; });
  let outcome: {returned: unknown}|{thrown: unknown};
  try { outcome={returned:nextLegacyCacheInvalidator.invalidateLegacyRoast("slug")}; } catch(thrown) { outcome={thrown}; }
  if ("returned" in outcome && outcome.returned instanceof Promise) await outcome.returned.catch(() => undefined);
  expect(outcome).toEqual({thrown:sentinel});
});
it("INV-3 returns undefined synchronously", () => { expect(nextLegacyCacheInvalidator.invalidateLegacyRoast("slug")).toBeUndefined(); });
it("INV-4 public adapter import surface", () => {
  const source=readFileSync(join(process.cwd(),"lib/c3/next-legacy-cache-invalidator.ts"),"utf8");
  const FORBIDDEN_IMPORT = /\bupdateTag\b|\brevalidateTag\b|\bunstable_[a-z]+|next\/dist\//;
  expect(source).not.toMatch(FORBIDDEN_IMPORT);
  expect(source).toContain('import { revalidatePath } from "next/cache";');
});
