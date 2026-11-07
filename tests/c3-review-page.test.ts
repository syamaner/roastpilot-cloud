import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decideReviewPage, encodeCursor, matchesIfNoneMatch, parseCursor, parseIfNoneMatch, parsePage, parseState, reviewETag, serializePage } from "../lib/c3/review-page";
import { jsonFailure } from "../lib/c3/http";
import type { PageResult, Cursor } from "../lib/c3/review-page";
const slug = "123456789ABCDEFGHJKLM";
const names = ["reviewer_name", "score", "aroma", "acidity", "sweetness", "body", "aftertaste", "brew_method", "notes", "created_at", "paging_key", "order_ns", "key_multiplicity", "null_key_count"];
const key = (n: number) => "v1-" + n.toString(16).padStart(64, "0");
const row = (n = 100, ns = n): (string | null)[] => [null, "4", null, "20", null, null, null, null, "public review", "2026-11-06T12:00:00.000000001+00:00", key(n), String(ns), "1", "0"];
const page = (rows = [row()]): PageResult => ({ columns: names.map((name) => ({ name })), rows, rowCount: rows.length });
const state = (roast = "1", count = "1000", nil = "0", dup = "0"): PageResult => ({ columns: ["roast_rows", "review_rows", "null_key_rows", "duplicate_key_rows"].map((name) => ({ name })), rows: [[roast, count, nil, dup]], rowCount: 1 });
const decision = (rows = [row()], s = state(), cursor: Cursor | null = null) => decideReviewPage(page(rows), s, cursor, slug);
const error = (reason: string) => ({ kind: "error", status: 503, error: "incomplete", reason });
describe("C3 pure page protocol", () => {
  it("CUR-1 round trip", () => { const c = { orderNs: BigInt("-5"), pagingKey: key(5) }; expect(parseCursor(encodeCursor(c, slug), slug)).toEqual(c); });
  it("CUR-2 grammar rejects noncanonical forms", () => {
    const c = encodeCursor({ orderNs: BigInt("12"), pagingKey: key(15) }, slug);
    for (const bad of [c.replace(".12.", ".-0."), c.replace(".12.", ".12345678901234567890."), c.toUpperCase(), c.split(".").slice(0, 3).join("."), c + ".", c.replace("c1.", "c2."), ""]) expect(parseCursor(bad, slug)).toBeNull();
  });
  it("CUR-3 rejects cursor from another roast", () => { expect(parseCursor(encodeCursor({ orderNs: BigInt("1"), pagingKey: key(1) }, slug), slug + "2")).toBeNull(); });
  it("ROW-1 accepts exactly 14 columns", () => { expect(parsePage(page())?.[0]).toMatchObject({ score: 4, acidity: 20, aroma: null, orderNs: BigInt("100"), multiplicity: BigInt("1") }); expect(parsePage({ ...page(), columns: names.map((name) => ({ name: name.toUpperCase() })) })).not.toBeNull(); });
  it("ROW-2 rejects wrong columns and bad cells", () => {
    const columns = page().columns;
    for (const bad of [columns.slice(0, 13), [...columns, { name: "extra" }], [{ name: "score" }, { name: "reviewer_name" }, ...columns.slice(2)]]) expect(parsePage({ ...page(), columns: bad })).toBeNull();
    for (const [i, value] of [[1, ""], [1, "Infinity"], [1, "NaN"], [9, "2026-11-06T12:00:00Z"], [10, "v2-" + "a".repeat(64)], [11, "-0"], [12, "0"], [13, null]] as const) {
      const bad = row(); bad[i] = value; expect(parsePage(page([bad]))).toBeNull();
    }
    expect(parsePage(page([row().slice(0, 13)]))).toBeNull();
    expect(parsePage(page([[...row(), "extra"]]))).toBeNull();
  });
  it("ROW-3 cardinality mismatch", () => { expect(parsePage({ ...page(), rowCount: 2 })).toBeNull(); });
  it("STATE-PARSE-1 null cell rejected", () => { const s = state(); for (let i = 0; i < 4; i++) { const cells = [...s.rows[0]]; cells[i] = null; expect(parseState({ ...s, rows: [cells] })).toBeNull(); } });
  it("STATE-PARSE-2 non-digit rejected", () => { for (const value of ["-1", "01", "", " ", "1.5", "NaN"]) expect(parseState(state(value))).toBeNull(); expect(parseState({ ...state(), rowCount: 0 })).toBeNull(); });
  it("DEC-1 hidden roast with anomalies is 404", () => {
    expect(decision([row()], state("0", "0", "1", "2"))).toEqual({ kind: "error", status: 404, error: "not_found" });
    expect(decision([row()], state("2"))).toEqual(error("schema"));
    expect(decideReviewPage({ columns: [], rows: [["malformed"]], rowCount: 9 }, state("0", "0"), null, slug)).toEqual({ kind: "error", status: 404, error: "not_found" });
    expect(decision([row()], state(""))).toEqual(error("schema"));
  });
  it("DEC-2 null key is identity", () => { const r = row(); r[10] = null; expect(decision([r])).toEqual(error("identity")); expect(decision([row()], state("1", "100", "1"))).toEqual(error("identity")); const n = row(); n[13] = "1"; expect(decision([n])).toEqual(error("identity")); });
  it("DEC-3 duplicate key is incomplete", () => { expect(decision([row()], state("1", "100", "0", "1"))).toEqual(error("duplicate_key")); const r = row(); r[12] = "2"; expect(decision([r])).toEqual(error("duplicate_key")); });
  it("DEC-4 order violation and cursor boundary", () => { expect(decision([row(1), row(2)])).toEqual(error("order")); expect(decision([row()], state(), { orderNs: BigInt("100"), pagingKey: key(100) })).toEqual(error("order")); expect(decision([row(), row()])).toEqual(error("order")); });
  it("DEC-5 cursor and empty page requires restart", () => { expect(decision([], state(), { orderNs: BigInt("100"), pagingKey: key(100) })).toEqual({ kind: "error", status: 409, error: "restart_required" }); });
  it("DEC-6 exactly 50 rows is final", () => { expect(decision(Array.from({ length: 50 }, (_, i) => row(100 - i)))).toMatchObject({ kind: "page", nextCursor: null }); });
  it("DEC-7 51 rows returns 50 and row50 cursor", () => { const d = decision(Array.from({ length: 51 }, (_, i) => row(100 - i))); expect(d.kind).toBe("page"); if (d.kind === "page") { expect(d.reviews).toHaveLength(50); expect(parseCursor(d.nextCursor!, slug)).toEqual({ orderNs: BigInt("51"), pagingKey: key(51) }); } });
  it("DEC-8 more than 51 rows is schema", () => { expect(decision(Array.from({ length: 52 }, (_, i) => row(100 - i)))).toEqual(error("schema")); });
  it("DEC-9 smaller review count is changed", () => { expect(decision([row(), row(99)], state("1", "1"))).toEqual(error("changed")); });
  it("DEC-10 ties descend by key", () => { const d = decision([row(3, 10), row(2, 10)], state(), { orderNs: BigInt("10"), pagingKey: key(4) }); expect(d).toEqual({ kind: "page", reviews: [3, 2].map((n) => ({ reviewer_name: null, score: 4, aroma: null, acidity: 20, sweetness: null, body: null, aftertaste: null, brew_method: null, notes: "public review", created_at: "2026-11-06T12:00:00.000000001+00:00", paging_key: key(n), orderNs: BigInt("10"), multiplicity: BigInt("1"), nullKeys: BigInt("0") })), nextCursor: null }); expect(decision([row(4, 10)], state(), { orderNs: BigInt("10"), pagingKey: key(4) })).toEqual(error("order")); });
  it("INM-1 exact match", () => { expect(matchesIfNoneMatch(parseIfNoneMatch('"abc"'), 'W/"abc"')).toBe(true); });
  it("INM-2 weak tag matches strong-written current", () => { expect(matchesIfNoneMatch(parseIfNoneMatch('W/"abc"'), '"abc"')).toBe(true); expect(matchesIfNoneMatch(parseIfNoneMatch('"abc"'), 'W/"abc"')).toBe(true); });
  it("INM-3 comma inside quoted tag", () => { expect(parseIfNoneMatch('"a,b", W/"c"')).toEqual(["a,b", "c"]); });
  it("INM-4 wildcard", () => { expect(matchesIfNoneMatch(parseIfNoneMatch(" \t*\t "), 'W/"x"')).toBe(true); });
  it("INM-5 malformed means absent", () => { for (const h of ['w/"a"', "abc", '"é"', '"unterminated', '"a"x', '* , "a"']) expect(parseIfNoneMatch(h)).toBeNull(); expect(parseIfNoneMatch(null)).toBeNull(); });
  it("INM-6 empty list element", () => { expect(parseIfNoneMatch(', , "abc",,\t')).toEqual(["abc"]); });
  it("ETAG-1 exact bytes", () => { const body = '{"example":null}'; const expected = 'W/"' + createHash("sha256").update("roastpilot/c9-c3/reviews-etag/v1\n" + slug + "\n\napplication/json;api_version=1\n" + body).digest("hex") + '"'; const tag = reviewETag(slug, null, body); expect(tag).toBe(expected); expect(tag).toMatch(/^W\/"[0-9a-f]{64}"$/); expect(tag).toHaveLength(68); });
  it("ETAG-2 distinct cursors distinct tags", () => { expect(reviewETag(slug, null, "body")).not.toBe(reviewETag(slug, "cursor", "body")); });
  it("ETAG-3 slug-bound", () => { expect(reviewETag(slug, null, "body")).not.toBe(reviewETag(slug + "2", null, "body")); });
  it("ETAG-4 content-bound", () => { expect(reviewETag(slug, null, "one")).not.toBe(reviewETag(slug, null, "two")); });
  it("BODY-1 exact key order error bytes and nulls", async () => {
    const r = parsePage(page())![0];
    expect(serializePage(slug, [r], null)).toBe('{"api_version":1,"public_slug":"' + slug + '","reviews":[{"paging_key":"' + key(100) + '","reviewer_name":null,"score":4,"aroma":null,"acidity":20,"sweetness":null,"body":null,"aftertaste":null,"brew_method":null,"notes":"public review","created_at":"2026-11-06T12:00:00.000000001+00:00"}],"next_cursor":null}');
    expect(await jsonFailure(503, "incomplete", "identity").text()).toBe('{"error":"incomplete","reason":"identity"}');
  });
});

it("STATE-PARSE-3 rejects wrong columns and row cardinality", () => {
  const valid = state();
  const wrongOrder = [...valid.columns]; [wrongOrder[0], wrongOrder[1]] = [wrongOrder[1], wrongOrder[0]];
  const wrongName = [{ name: "wrong" }, ...valid.columns.slice(1)];
  for (const columns of [wrongOrder, wrongName]) expect(parseState({ ...valid, columns })).toBeNull();
  expect(parseState({ ...valid, rows: [valid.rows[0], valid.rows[0]], rowCount: 2 })).toBeNull();
  expect(parseState({ ...valid, rowCount: 2 })).toBeNull();
});
