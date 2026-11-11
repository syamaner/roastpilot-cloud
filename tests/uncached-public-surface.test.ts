import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
const source = (p: string) => readFileSync(join(process.cwd(),p),"utf8");
const FORBIDDEN_CACHE_SOURCE = /\bunstable_cache\b|["']use cache["']|\bcacheTag\b|\bcacheLife\b|\brevalidateTag\b|\bupdateTag\b|\brevalidatePath\b|from\s+["']next\/cache["']|export\s+const\s+(?:revalidate|fetchCache)\b|\bgenerateStaticParams\b/;
it("U-1 page preview and readers contain no cache primitive", () => {
  for (const p of ["app/r/[slug]/page.tsx","app/r/[slug]/opengraph-image.tsx","lib/roast.ts","lib/sqlapi.ts"]) expect(source(p)).not.toMatch(FORBIDDEN_CACHE_SOURCE);
});
it("U-2 the legacy cache module is removed", () => {
  expect(existsSync(join(process.cwd(), "lib/roast-cache.ts"))).toBe(false);
});
it("U-3 page and preview import the direct readers", () => {
  expect(source("app/r/[slug]/page.tsx")).toContain('import { getReviewsByRoast, getRoastBySlug, getRoastRatingBySlug } from "@/lib/roast";');
  expect(source("app/r/[slug]/opengraph-image.tsx")).toContain('import { getRoastBySlug, getRoastRatingBySlug, type Roast } from "@/lib/roast";');
});
it("ARCH-1 pure module has no infrastructure representation or imports", () => {
  const text=source("lib/c3/revalidation-request.ts");expect([...text.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map(m=>m[1])).toEqual(["zod"]);
  expect(text).not.toMatch(/\b(?:RawResult|Headers|Request|Response|ReadableStream|SqlApiResult)\b|\bprocess\.env\b/);
});
const prose=(s:string)=>s.replace(/\s+/g," ").trim();
it("DOC-1 rollback requires qualified uncached target", () => { expect(prose(source("docs/runbooks/prod-deploy-runbook.md"))).toContain("After the C9-C3B uncached release, roll back to or promote only a deployment qualified as uncached (D229)."); });
it("DOC-2 agents stack requires uncached reads", () => { expect(prose(source("AGENTS.md"))).toContain("- Next.js App Router; the public roast page, its preview image and their roast, review and rating readers render on the server from uncached reads (D228), not client-fetched."); });
