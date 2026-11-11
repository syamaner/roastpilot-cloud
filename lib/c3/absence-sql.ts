/** APP-qualified, public-view-only uncached absence observation. */
import { executeStatement } from "../sqlapi";
import type { Absence } from "./revalidation-request";
import type { PublicAbsenceReader } from "./cache-revalidation";
export interface RawResult { readonly columns: ReadonlyArray<{ readonly name: string }>; readonly rows: ReadonlyArray<ReadonlyArray<string | null>>; readonly rowCount: number }
const ABSENCE_COLUMNS = ["roast_rows", "review_rows"];
const COUNT = /^(0|[1-9][0-9]{0,18})$/;

export function parseAbsence(result: RawResult): Absence {
  const names = result.columns.map((column) => column.name.toLowerCase());
  if (names.length !== 2 || names[0] !== ABSENCE_COLUMNS[0] || names[1] !== ABSENCE_COLUMNS[1]) return { kind: "invalid" };
  if (result.rowCount !== 1) return { kind: "invalid" };
  if (result.rows.length !== 1) return { kind: "invalid" };
  const row = result.rows[0];
  if (row.length !== 2) return { kind: "invalid" };
  if (row[0] === null || row[1] === null || !COUNT.test(row[0]) || !COUNT.test(row[1])) return { kind: "invalid" };
  return row[0] === "0" && row[1] === "0" ? { kind: "absent" } : { kind: "present" };
}

export const ABSENCE = "select (select count(*) from app.roast_by_slug where public_slug = :1) as roast_rows, (select count(*) from app.reviews_by_roast where public_slug = :2) as review_rows";

export function createPublicAbsenceReader(execute: typeof executeStatement = executeStatement): PublicAbsenceReader {
  return {
    readAbsence: async (slug) => parseAbsence(await execute(ABSENCE, { "1": { type: "TEXT", value: slug }, "2": { type: "TEXT", value: slug } })),
  };
}
