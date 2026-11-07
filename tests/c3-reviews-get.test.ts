import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reviewsGet } from "../lib/c3/reviews-get";
import type { ReviewPageReader } from "../lib/c3/reviews-get";
import type { Cursor, PageResult } from "../lib/c3/review-page";
import { encodeCursor } from "../lib/c3/review-page";
import { SqlApiError } from "../lib/sqlapi";
const slug = "123456789ABCDEFGHJKLM"; const secret = "rpc3_" + Buffer.alloc(32, 1).toString("base64url");
const cols = ["reviewer_name", "score", "aroma", "acidity", "sweetness", "body", "aftertaste", "brew_method", "notes", "created_at", "paging_key", "order_ns", "key_multiplicity", "null_key_count"];
const key = (n: number) => "v1-" + n.toString(16).padStart(64, "0");
const row = (n: number, ns = n): (string | null)[] => [null, "4", null, null, null, null, null, null, "PUBLIC TEXT", "2026-11-06T12:00:00.000000001+00:00", key(n), String(ns), "1", "0"];
const page = (rows = [row(100)]): PageResult => ({ columns: cols.map((name) => ({ name })), rows, rowCount: rows.length });
const state = (visible = "1", count = "1000"): PageResult => ({ columns: ["roast_rows", "review_rows", "null_key_rows", "duplicate_key_rows"].map((name) => ({ name })), rows: [[visible, count, "0", "0"]], rowCount: 1 });
const req = (query = "", headers: Record<string, string> = {}, method = "GET") => new Request("http://localhost/api/r/" + slug + "/reviews" + query, { method, headers: { authorization: `Bearer ${secret}`, ...headers } });
function scripted(p = page(), s = state()) { const log: string[] = []; const reader: ReviewPageReader = { readPage: async () => { log.push("page"); return p; }, readState: async () => { log.push("state"); return s; } }; return { reader, log }; }
const logs: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => { for (const name of Object.getOwnPropertyNames(console)) { if (typeof console[name as keyof Console] === "function") logs.push(vi.spyOn(console, name as "log").mockImplementation(() => {})); } });
afterEach(() => { for (const spy of logs) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); } logs.length = 0; });
describe("C3 authenticated GET", () => {
  it("GET-AUTH-1 performs no SQL when unauthenticated or unconfigured", async () => {
    const f = scripted(); const noAuth = new Request("http://localhost/", { headers: {} });
    const a = await reviewsGet(noAuth, slug, f.reader, () => secret); expect(a.status).toBe(401); expect(await a.text()).toBe('{"error":"unauthorized"}'); expect(a.headers.get("www-authenticate")).toBe("Bearer");
    const b = await reviewsGet(req(), slug, f.reader, () => undefined); expect(b.status).toBe(503); expect(await b.text()).toBe('{"error":"not_configured"}'); expect(f.log).toEqual([]);
  });
  it("GET-METHOD-1 rejects non-GET after auth", async () => { const f = scripted(); for (const method of ["HEAD", "POST", "DELETE"]) { const r = await reviewsGet(req("", {}, method), slug, f.reader, () => secret); expect(r.status).toBe(405); expect(await r.text()).toBe('{"error":"method_not_allowed"}'); expect(r.headers.get("allow")).toBe("GET"); expect(r.headers.get("cache-control")).toBe("no-store"); } expect(f.log).toEqual([]); });
  it("GET-Q-1 rejects unknown query key", async () => { const f = scripted(); const r = await reviewsGet(req("?other=x"), "invalid", f.reader, () => secret); expect(r.status).toBe(400); expect(await r.text()).toBe('{"error":"invalid_request"}'); expect(f.log).toEqual([]); });
  it("GET-Q-2 rejects duplicate cursor", async () => { const f = scripted(); const c = encodeCursor({ orderNs: BigInt("100"), pagingKey: key(100) }, slug); const r = await reviewsGet(req(`?cursor=${c}&cursor=${c}`), slug, f.reader, () => secret); expect(r.status).toBe(400); expect(await r.text()).toBe('{"error":"invalid_request"}'); expect(f.log).toEqual([]); });
  it("GET-BODY-1 rejects GET with body or content-type headers", async () => { const invalidHeaders: Record<string, string>[] = [{ "content-length": "1" }, { "content-type": "application/json" }, { "transfer-encoding": "chunked" }]; for (const h of invalidHeaders) { const f = scripted(); const r = await reviewsGet(req("", h), slug, f.reader, () => secret); expect(r.status).toBe(400); expect(f.log).toEqual([]); } const f = scripted(); expect((await reviewsGet(req("", { "content-length": "0" }), slug, f.reader, () => secret)).status).toBe(200); });
  it("GET-404-1 identical bytes and headers", async () => { const outputs = []; for (const [s, f] of [["bad", scripted()], [slug, scripted(page([]), state("0", "0"))], [slug, scripted(page(), state("0", "0"))]] as const) { const r = await reviewsGet(req(), s, f.reader, () => secret); outputs.push([r.status, [...r.headers], await r.text()]); } expect(outputs[0]).toEqual([404, [["cache-control", "no-store"], ["content-type", "application/json"]], '{"error":"not_found"}']); expect(outputs[1]).toEqual(outputs[0]); expect(outputs[2]).toEqual(outputs[0]); });
  it("GET-RACE-1 deleted before page is 404", async () => { const f = scripted(page([]), state("0", "0")); expect((await reviewsGet(req(), slug, f.reader, () => secret)).status).toBe(404); expect(f.log).toEqual(["page", "state"]); });
  it("GET-RACE-2 deletion between page and state is 404", async () => { const f = scripted(page(), state("0", "0")); const r = await reviewsGet(req(), slug, f.reader, () => secret); expect(r.status).toBe(404); expect(await r.text()).toBe('{"error":"not_found"}'); expect(f.log).toEqual(["page", "state"]); });
  it("GET-RACE-3 hidden after STATE residual remains non-linearizable", async () => { let hidden = false; const f = scripted(); const original = f.reader.readState; f.reader.readState = async (s) => { const r = await original(s); hidden = true; return r; }; const r = await reviewsGet(req(), slug, f.reader, () => secret); expect(hidden).toBe(true); expect(r.status).toBe(200); });
  it("GET-304-1 matching tag only after STATE", async () => { const f = scripted(); const first = await reviewsGet(req(), slug, f.reader, () => secret); f.log.length = 0; const r = await reviewsGet(req("", { "if-none-match": first.headers.get("etag")! }), slug, f.reader, () => secret); expect(r.status).toBe(304); expect(await r.text()).toBe(""); expect(f.log).toEqual(["page", "state"]); expect(r.headers.get("cache-control")).toBe("private, no-cache"); });
  it("GET-304-2 hidden roast with matching If-None-Match is 404", async () => { const f = scripted(page(), state("0", "0")); const r = await reviewsGet(req("", { "if-none-match": "*" }), slug, f.reader, () => secret); expect(r.status).toBe(404); expect(await r.text()).toBe('{"error":"not_found"}'); expect(f.log).toEqual(["page", "state"]); });
  it("GET-ERR-1 SqlApiError is unavailable", async () => { const f = scripted(); f.reader.readPage = async () => { throw new SqlApiError("transport", "partition failure"); }; const r = await reviewsGet(req(), slug, f.reader, () => secret); expect(r.status).toBe(503); expect(await r.text()).toBe('{"error":"unavailable"}'); expect(r.headers.get("cache-control")).toBe("no-store"); });
  it("GET-LOG-1 never logs", async () => { const f = scripted(); f.reader.readPage = async () => { throw new SqlApiError("transport", "private diagnostic"); }; const r = await reviewsGet(req(), slug, f.reader, () => secret); expect(r.status).toBe(503); for (const spy of logs) expect(spy).not.toHaveBeenCalled(); });
  it("GET-CURSOR-1 invalid cursor and schema are closed", async () => { const f = scripted(); expect((await reviewsGet(req("?cursor="), slug, f.reader, () => secret)).status).toBe(400); const bad = scripted({ ...page(), rowCount: 4 }); const r = await reviewsGet(req(), slug, bad.reader, () => secret); expect(await r.text()).toBe('{"error":"incomplete","reason":"schema"}'); });
});

/** A keyset model fake, not an evaluation of Snowflake SQL or collation. */
function model(initial = 120) {
  let rows = Array.from({ length: initial }, (_, i) => row(initial - i, Math.floor((initial - i) / 3)));
  const reader: ReviewPageReader = {
    readPage: async (_slug, c) => page(rows.filter((r) => c === null || BigInt(r[11]!) < c.orderNs || (BigInt(r[11]!) === c.orderNs && r[10]! < c.pagingKey)).slice(0, 51)),
    readState: async () => state("1", String(rows.length)),
  };
  return { reader, add: (r: (string | null)[]) => { rows.push(r); rows.sort((a, b) => BigInt(a[11]!) > BigInt(b[11]!) ? -1 : BigInt(a[11]!) < BigInt(b[11]!) ? 1 : a[10]! > b[10]! ? -1 : 1); }, remove: (k: string) => { rows = rows.filter((r) => r[10] !== k); } };
}
async function traverse(reader: ReviewPageReader, afterFirst = (_cursor: string) => {}) {
  const keys: string[] = []; let cursor: string | null = null;
  for (let i = 0; i < 10; i++) {
    const r = await reviewsGet(req(cursor === null ? "" : "?cursor=" + cursor), slug, reader, () => secret);
    expect(r.status).toBe(200); const body = await r.json(); keys.push(...body.reviews.map((r: { paging_key: string }) => r.paging_key)); cursor = body.next_cursor;
    if (cursor === null) return keys;
    if (i === 0) afterFirst(cursor);
  }
  throw new Error("model traversal did not terminate");
}
it("GET-TRAV-1 120 rows with ties enumerate once", async () => { const m = model(); const keys = await traverse(m.reader); expect(new Set(keys).size).toBe(120); expect(keys).toEqual(Array.from({ length: 120 }, (_, i) => key(120 - i))); });
it("GET-TRAV-2 concurrent newer insert is not collected", async () => { const m = model(); const keys = await traverse(m.reader, () => m.add(row(999, 999))); expect(keys).toHaveLength(120); expect(keys).not.toContain(key(999)); });
it("GET-TRAV-3 concurrent older insert collected once", async () => { const m = model(); const keys = await traverse(m.reader, () => m.add(row(999, -1))); expect(keys).toHaveLength(121); expect(new Set(keys).size).toBe(121); expect(keys.at(-1)).toBe(key(999)); });
it("GET-TRAV-4 missing anchor non-empty tail continues", async () => { const m = model(); const keys = await traverse(m.reader, (c) => m.remove("v1-" + c.split(".")[2])); expect(keys).toHaveLength(120); expect(new Set(keys).size).toBe(120); });
it("GET-TRAV-5 missing anchor empty tail restarts", async () => { const m = model(1); const c: Cursor = { orderNs: BigInt("0"), pagingKey: key(1) }; m.remove(key(1)); const r = await reviewsGet(req("?cursor=" + encodeCursor(c, slug)), slug, m.reader, () => secret); expect(r.status).toBe(409); expect(await r.text()).toBe('{"error":"restart_required"}'); });
