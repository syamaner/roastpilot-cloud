import { expect, it, vi } from "vitest";
import { parseAbsence, createPublicAbsenceReader } from "../lib/c3/absence-sql";
import type { executeStatement, SqlApiResult } from "../lib/sqlapi";
const good = (a = "0", b = "0"): SqlApiResult => ({ columns: [{name:"ROAST_ROWS",type:"fixed"},{name:"REVIEW_ROWS",type:"fixed"}], rows:[[a,b]], rowCount:1 });
it("AB-ok zero counts are absent and roast count one is present", () => { expect(parseAbsence(good())).toEqual({kind:"absent"}); expect(parseAbsence(good("1"))).toEqual({kind:"present"}); });
it("AB-reviews-present review count without roast is present", () => { expect(parseAbsence(good("0","1"))).toEqual({kind:"present"}); });
it("AB-rowcount mismatched rowCount or row count is invalid", () => {
  for (const result of [{...good(), rowCount:0},{...good(), rows:[]},{...good(), rows:[["0","0"],["0","0"]]}]) expect(parseAbsence(result)).toEqual({kind:"invalid"});
});
it("AB-columns wrong order wrong first name wrong second name or extra column is invalid", () => {
  for (const names of [["review_rows","roast_rows"],["wrong","review_rows"],["roast_rows","wrong"],["roast_rows","review_rows","extra"]]) expect(parseAbsence({...good(),columns:names.map(name=>({name}))})).toEqual({kind:"invalid"});
  expect(parseAbsence({...good(),columns:[{name:"roast_rows"},{name:"review_rows"},{name:"extra"}],rows:[["0","0","0"]]})).toEqual({kind:"invalid"});
});
it("AB-count-grammar 00 -1 1.0 space-prefixed newline-suffixed null and twenty digits are invalid", () => {
  for (const bad of ["00","-1","1.0"," 0","0\n",null,"1".repeat(20)]) for (const pos of [0,1]) {
    const row: (string|null)[] = ["0","0"]; row[pos]=bad;
    expect(parseAbsence({...good(),rows:[row]})).toEqual({kind:"invalid"});
  }
});
it("AB-row-width missing and extra cells are invalid", () => {
  for (const row of [["0"],["0","0","0"]]) expect(parseAbsence({...good(),rows:[row]})).toEqual({kind:"invalid"});
});
function executor() { return vi.fn<typeof executeStatement>().mockResolvedValue(good()); }
it("SQL-ABS-1 exact app-qualified statement", async () => {
  const execute=executor(); await createPublicAbsenceReader(execute).readAbsence("slug");
  expect(execute.mock.calls[0][0]).toBe("select (select count(*) from app.roast_by_slug where public_slug = :1) as roast_rows, (select count(*) from app.reviews_by_roast where public_slug = :2) as review_rows");
});
it("SQL-ABS-2 exact bindings", async () => {
  const execute=executor(); await createPublicAbsenceReader(execute).readAbsence("hostile' :2; --");
  expect(execute.mock.calls[0][1]).toEqual({"1":{type:"TEXT",value:"hostile' :2; --"},"2":{type:"TEXT",value:"hostile' :2; --"}});
});
it("SQL-ABS-3 transport error propagates unchanged", async () => {
  const sentinel=new Error("transport sentinel"); const execute=executor().mockRejectedValue(sentinel);
  await expect(createPublicAbsenceReader(execute).readAbsence("slug")).rejects.toBe(sentinel);
});
it("SQL-ABS-4 result parsed through the absence grammar", async () => {
  const execute=executor().mockResolvedValueOnce(good()).mockResolvedValueOnce(good("1"));const reader=createPublicAbsenceReader(execute);
  expect(await reader.readAbsence("slug")).toEqual({kind:"absent"});expect(await reader.readAbsence("slug")).toEqual({kind:"present"});
});
