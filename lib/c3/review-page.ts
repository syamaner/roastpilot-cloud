/** Pure C3 page grammars, traversal decisions and content validators. */
import { createHash } from "node:crypto";
import { z } from "zod";

const integer = z.string().regex(/^(0|[1-9][0-9]{0,18})$/);
const signed = z.string().regex(/^(0|-?[1-9][0-9]{0,18})$/);
const numeric = z.string().refine((s) => s.trim() !== "" && Number.isFinite(Number(s)));
const timestamp = z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{9}[+-][0-9]{2}:[0-9]{2}$/);
const key = z.string().regex(/^v1-[0-9a-f]{64}$/);
const cells = z.tuple([
  z.string().nullable(), numeric, numeric.nullable(), numeric.nullable(), numeric.nullable(), numeric.nullable(), numeric.nullable(),
  z.string().nullable(), z.string().nullable(), timestamp, key.nullable(), signed, z.string().regex(/^[1-9][0-9]{0,18}$/), integer,
]);
const stateCells = z.tuple([integer, integer, integer, integer]);
const cursorSchema = z.string().regex(/^c1\.(0|-?[1-9][0-9]{0,18})\.([0-9a-f]{64})\.([0-9a-f]{16})$/);
export const PAGE_COLUMNS = ["reviewer_name", "score", "aroma", "acidity", "sweetness", "body", "aftertaste", "brew_method", "notes", "created_at", "paging_key", "order_ns", "key_multiplicity", "null_key_count"];
const STATE_COLUMNS = ["roast_rows", "review_rows", "null_key_rows", "duplicate_key_rows"];

/** Consumer-owned raw result shape, independent of SQL transport descriptors. */
export interface PageResult { columns: ReadonlyArray<{ name: string }>; rows: ReadonlyArray<ReadonlyArray<string | null>>; rowCount: number }
export interface Cursor { orderNs: bigint; pagingKey: string }
export interface ReviewRow { reviewer_name: string | null; score: number; aroma: number | null; acidity: number | null; sweetness: number | null; body: number | null; aftertaste: number | null; brew_method: string | null; notes: string | null; created_at: string; paging_key: string | null; orderNs: bigint; multiplicity: bigint; nullKeys: bigint }
export interface ReviewState { roastRows: bigint; reviewRows: bigint; nullKeys: bigint; duplicateKeys: bigint }
export type PageDecision = { kind: "page"; reviews: ReviewRow[]; nextCursor: string | null } | { kind: "error"; status: number; error: string; reason?: string };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const scope = (slug: string) => digest("roastpilot/c9-c3/cursor-scope/v1\n" + slug).slice(0, 16);

/** Reject noncanonical or cross-resource cursors without revealing input. */
export function parseCursor(value: string, slug: string): Cursor | null {
  if (!cursorSchema.safeParse(value).success) return null;
  const [, ns, hex, binding] = value.split(".");
  if (binding !== scope(slug)) return null;
  return { orderNs: BigInt(ns), pagingKey: "v1-" + hex };
}

/** Produce only canonical, resource-scoped opaque cursors. */
export function encodeCursor(cursor: Cursor, slug: string): string {
  return `c1.${cursor.orderNs}.${cursor.pagingKey.slice(3)}.${scope(slug)}`;
}

/** Parse exact ordered PAGE columns and closed 14-cell tuples. */
export function parsePage(result: PageResult): ReviewRow[] | null {
  if (JSON.stringify(result.columns.map((c) => c.name.toLowerCase())) !== JSON.stringify(PAGE_COLUMNS)) return null;
  if (result.rowCount !== result.rows.length) return null;
  const parsed = z.array(cells).safeParse(result.rows);
  if (!parsed.success) return null;
  return parsed.data.map((r) => ({
    reviewer_name: r[0], score: Number(r[1]), aroma: r[2] === null ? null : Number(r[2]), acidity: r[3] === null ? null : Number(r[3]),
    sweetness: r[4] === null ? null : Number(r[4]), body: r[5] === null ? null : Number(r[5]), aftertaste: r[6] === null ? null : Number(r[6]),
    brew_method: r[7], notes: r[8], created_at: r[9], paging_key: r[10], orderNs: BigInt(r[11]), multiplicity: BigInt(r[12]), nullKeys: BigInt(r[13]),
  }));
}

/** STATE grammar is validated before zero can mean invisible. */
export function parseState(result: PageResult): ReviewState | null {
  if (JSON.stringify(result.columns.map((c) => c.name.toLowerCase())) !== JSON.stringify(STATE_COLUMNS) || result.rowCount !== 1 || result.rows.length !== 1) return null;
  const parsed = stateCells.safeParse(result.rows[0]);
  if (!parsed.success) return null;
  const [roastRows, reviewRows, nullKeys, duplicateKeys] = parsed.data.map((s) => BigInt(s));
  return { roastRows, reviewRows, nullKeys, duplicateKeys };
}
const incomplete = (reason: string): PageDecision => ({ kind: "error", status: 503, error: "incomplete", reason });
const before = (a: Cursor, b: Cursor) => a.orderNs < b.orderNs || (a.orderNs === b.orderNs && a.pagingKey < b.pagingKey);

/** Decide only after the final STATE observation, with closed error precedence. */
export function decideReviewPage(page: PageResult, state: PageResult, cursor: Cursor | null, slug: string): PageDecision {
  const current = parseState(state);
  if (current === null) return incomplete("schema");
  if (current.roastRows === 0n) return { kind: "error", status: 404, error: "not_found" };
  const rows = parsePage(page);
  if (current.roastRows !== 1n || rows === null) return incomplete("schema");
  if (current.nullKeys !== 0n || rows.some((r) => r.nullKeys !== 0n || r.paging_key === null)) return incomplete("identity");
  if (current.duplicateKeys !== 0n || rows.some((r) => r.multiplicity !== 1n)) return incomplete("duplicate_key");
  const tuples = rows.map((r) => ({ orderNs: r.orderNs, pagingKey: r.paging_key! }));
  if (tuples.some((r, i) => i > 0 && !before(r, tuples[i - 1])) || (cursor !== null && tuples.length > 0 && !before(tuples[0], cursor))) return incomplete("order");
  if (current.reviewRows < BigInt(rows.length)) return incomplete("changed");
  if (cursor !== null && rows.length === 0) return { kind: "error", status: 409, error: "restart_required" };
  if (rows.length > 51) return incomplete("schema");
  if (rows.length === 51) return { kind: "page", reviews: rows.slice(0, 50), nextCursor: encodeCursor(tuples[49], slug) };
  return { kind: "page", reviews: rows, nextCursor: null };
}

/** Preserve explicit nulls and the exact public response key order. */
export function serializePage(slug: string, reviews: ReviewRow[], nextCursor: string | null): string {
  return JSON.stringify({ api_version: 1, public_slug: slug, reviews: reviews.map((r) => ({
    paging_key: r.paging_key, reviewer_name: r.reviewer_name, score: r.score, aroma: r.aroma, acidity: r.acidity, sweetness: r.sweetness,
    body: r.body, aftertaste: r.aftertaste, brew_method: r.brew_method, notes: r.notes, created_at: r.created_at,
  })), next_cursor: nextCursor });
}

/** Hash exact representation, resource, request page and serialized content. */
export function reviewETag(slug: string, cursor: string | null, body: string): string {
  const frame = "roastpilot/c9-c3/reviews-etag/v1\n" + slug + "\n" + (cursor ?? "") + "\n" + "application/json;api_version=1\n" + body;
  return `W/"${digest(frame)}"`;
}

/** Scan quoted etagc without splitting embedded commas; malformed means absent. */
export function parseIfNoneMatch(header: string | null): "*" | string[] | null {
  if (header === null) return null;
  if (/^[ \t]*\*[ \t]*$/.test(header)) return "*";
  const tags: string[] = [];
  let i = 0;
  while (i < header.length) {
    while (header[i] === " " || header[i] === "\t" || header[i] === ",") i++;
    if (i === header.length) break;
    if (header.slice(i, i + 2) === "W/") i += 2;
    if (header[i++] !== '"') return null;
    let tag = "";
    while (i < header.length && header[i] !== '"') {
      const n = header.charCodeAt(i);
      if (!(n === 0x21 || (n >= 0x23 && n <= 0x7e))) return null;
      tag += header[i++];
    }
    if (header[i++] !== '"') return null;
    tags.push(tag);
    while (header[i] === " " || header[i] === "\t") i++;
    if (i < header.length && header[i++] !== ",") return null;
  }
  return tags;
}

/** Weak comparison intentionally ignores whether a tag was written weakly. */
export function matchesIfNoneMatch(parsed: ReturnType<typeof parseIfNoneMatch>, current: string): boolean {
  return parsed === "*" || (parsed !== null && parsed.includes(current.replace(/^W\//, "").slice(1, -1)));
}
