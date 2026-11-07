import { expect, it, vi } from "vitest";
import { createReviewPageReader, PAGE_FIRST, PAGE_NEXT, STATE } from "../lib/c3/review-page-sql";
const inner = `select reviewer_name,score,aroma,acidity,sweetness,body,aftertaste,brew_method,notes,to_varchar(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF9TZH:TZM') as created_at_iso,paging_key,date_part(epoch_nanosecond, created_at) as order_ns,count(*) over (partition by paging_key) as key_multiplicity,coalesce(count_if(paging_key is null) over (), 0) as null_key_count from app.reviews_by_roast where public_slug = :1`;
const projection = "select reviewer_name,score,aroma,acidity,sweetness,body,aftertaste,brew_method,notes,created_at_iso as created_at,paging_key,order_ns,key_multiplicity,null_key_count";
it("SQL-1 exact first and next statements", () => {
  expect(PAGE_FIRST).toBe(`${projection} from (${inner}) order by order_ns desc, paging_key desc limit 51`);
  expect(PAGE_NEXT).toBe(`${projection} from (${inner}) where order_ns < cast(:2 as number(38,0)) or (order_ns = cast(:3 as number(38,0)) and paging_key < :4) order by order_ns desc, paging_key desc limit 51`);
});
it("SQL-2 exact final authority statement", () => { expect(STATE).toBe("select (select count(*) from app.roast_by_slug where public_slug = :1) as roast_rows, count(*) as review_rows, coalesce(count_if(paging_key is null), 0) as null_key_rows, count(paging_key) - count(distinct paging_key) as duplicate_key_rows from app.reviews_by_roast where public_slug = :2"); });
it("SQL-3 view references qualified and projection closed", () => {
  for (const sql of [PAGE_FIRST, PAGE_NEXT, STATE]) {
    const refs = [...sql.matchAll(/\b(?:from|join)\s+([a-z_.]+)/g)].map((m) => m[1]);
    expect(refs.every((r) => ["app.reviews_by_roast", "app.roast_by_slug"].includes(r))).toBe(true);
    expect(sql).not.toMatch(/select\s+\*/);
  }
});
it("SQL-4 exact positional bindings and substitution", async () => {
  const execute = vi.fn(async () => ({ columns: [], rows: [], rowCount: 0 }));
  const reader = createReviewPageReader(execute); const slug = "123456789ABCDEFGHJKLM"; const key = "v1-" + "a".repeat(64);
  await reader.readPage(slug, null); await reader.readPage(slug, { orderNs: BigInt("-10"), pagingKey: key }); await reader.readState(slug);
  expect(execute.mock.calls).toEqual([[PAGE_FIRST, { "1": { type: "TEXT", value: slug } }], [PAGE_NEXT, { "1": { type: "TEXT", value: slug }, "2": { type: "TEXT", value: "-10" }, "3": { type: "TEXT", value: "-10" }, "4": { type: "TEXT", value: key } }], [STATE, { "1": { type: "TEXT", value: slug }, "2": { type: "TEXT", value: slug } }]]);
});
