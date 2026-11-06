/** Literal APP-qualified, public-view-only SQL adapter. */
import { executeStatement } from "../sqlapi";
import { REVIEWS_LIMIT } from "../roast";
import type { ReviewPageReader } from "./reviews-get";

export const INNER = `select reviewer_name,score,aroma,acidity,sweetness,body,aftertaste,brew_method,notes,to_varchar(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.FF9TZH:TZM') as created_at_iso,paging_key,date_part(epoch_nanosecond, created_at) as order_ns,count(*) over (partition by paging_key) as key_multiplicity,coalesce(count_if(paging_key is null) over (), 0) as null_key_count from app.reviews_by_roast where public_slug = :1`;
const PROJECTION = "select reviewer_name,score,aroma,acidity,sweetness,body,aftertaste,brew_method,notes,created_at_iso as created_at,paging_key,order_ns,key_multiplicity,null_key_count";
export const PAGE_FIRST = `${PROJECTION} from (${INNER}) order by order_ns desc, paging_key desc limit ${REVIEWS_LIMIT + 1}`;
export const PAGE_NEXT = `${PROJECTION} from (${INNER}) where order_ns < cast(:2 as number(38,0)) or (order_ns = cast(:3 as number(38,0)) and paging_key < :4) order by order_ns desc, paging_key desc limit ${REVIEWS_LIMIT + 1}`;
export const STATE = "select (select count(*) from app.roast_by_slug where public_slug = :1) as roast_rows, count(*) as review_rows, coalesce(count_if(paging_key is null), 0) as null_key_rows, count(paging_key) - count(distinct paging_key) as duplicate_key_rows from app.reviews_by_roast where public_slug = :2";

/** Substitute the same statement capability for deterministic adapter contracts. */
export function createReviewPageReader(execute: typeof executeStatement = executeStatement): ReviewPageReader {
  return {
    readPage: (slug, cursor) => execute(cursor === null ? PAGE_FIRST : PAGE_NEXT, cursor === null ? { "1": { type: "TEXT", value: slug } } : {
      "1": { type: "TEXT", value: slug }, "2": { type: "TEXT", value: cursor.orderNs.toString() }, "3": { type: "TEXT", value: cursor.orderNs.toString() }, "4": { type: "TEXT", value: cursor.pagingKey },
    }),
    readState: (slug) => execute(STATE, { "1": { type: "TEXT", value: slug }, "2": { type: "TEXT", value: slug } }),
  };
}
