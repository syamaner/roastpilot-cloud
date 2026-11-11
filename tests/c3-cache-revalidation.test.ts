import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { cacheRevalidationPost, type PublicAbsenceReader } from "../lib/c3/cache-revalidation";
import type { Absence } from "../lib/c3/revalidation-request";
import { createPublicAbsenceReader } from "../lib/c3/absence-sql";
import type { executeStatement, SqlApiResult } from "../lib/sqlapi";
const effects = vi.hoisted(() => ({ executeStatement: vi.fn(), revalidatePath: vi.fn() }));
vi.mock("../lib/sqlapi", async (actual) => ({ ...await actual<typeof import("../lib/sqlapi")>(), executeStatement: effects.executeStatement }));
vi.mock("next/cache", () => ({ revalidatePath: effects.revalidatePath }));
const revalidations = () => effects.revalidatePath.mock.calls;
const slug="demoroastseedone234"; const nonce="A".repeat(43);const secret="rpc3_"+"A".repeat(43);
const complete=`{"api_version":1,"public_slug":"${slug}","request_nonce":"${nonce}","cache_invalidation":"complete","evidence":{"view":"absent_uncached_before_and_after","current_render":"uncached","invalidation_calls":"requested","legacy_cache":"transition_qualified_non_servability"}}`;
const pending=(reason:string)=>`{"api_version":1,"public_slug":"${slug}","request_nonce":"${nonce}","cache_invalidation":"pending","reason":"${reason}"}`;
const absent:Absence={kind:"absent"};const present:Absence={kind:"present"};const invalid:Absence={kind:"invalid"};const unavailable=new Error("unavailable sentinel");
const raw=(a="0",b="0"):SqlApiResult=>({columns:[{name:"ROAST_ROWS",type:"fixed"},{name:"REVIEW_ROWS",type:"fixed"}],rows:[[a,b]],rowCount:1});
function request(options:{body?:"absent"|"oversize"|"throw"|"malformed";authorization?:string|null;method?:string;url?:string;contentType?:string}={}) {
  const pull=vi.fn(); let sent=false;
  const body=options.body==="absent"?null:new ReadableStream<Uint8Array>({pull(c) {pull(); if(options.body==="throw") throw unavailable;if(sent){c.close();return;}sent=true;c.enqueue(new TextEncoder().encode(options.body==="oversize"?"x".repeat(64):options.body==="malformed"?"bad":`{"request_nonce":"${nonce}"}`));}}, {highWaterMark:0});
  const getReader=body===null?vi.fn():vi.spyOn(body,"getReader");
  const headers=new Headers({"content-type":options.contentType??"application/json","content-length":"63"});
  if(options.authorization!==null)headers.set("authorization",options.authorization??`Bearer ${secret}`);
  const get=vi.spyOn(headers,"get");
  return {value:{method:options.method??"POST",url:options.url??"https://example.test/api/r/demo/cache-revalidation",headers,body},pull,getReader,get};
}
function scripted(observations:(Absence|Error)[]=[absent,absent]) {
  const log:string[]=[];let at=0;
  const reader:PublicAbsenceReader={async readAbsence() {log.push("absence");const value=observations[at++];if(value instanceof Error)throw value;if(value===undefined)throw unavailable;return value;}};
  const invalidate=vi.fn(()=>{log.push("invalidate");});return {reader,invalidator:{invalidateLegacyRoast:invalidate},invalidate,log};
}
async function run(observations:(Absence|Error)[]=[absent,absent],options:Parameters<typeof request>[0]={}) {const q=request(options);const f=scripted(observations);const response=await cacheRevalidationPost(q.value,slug,f.reader,f.invalidator,()=>secret);return {q,f,response,text:await response.text()};}
function zero(q:ReturnType<typeof request>,f:ReturnType<typeof scripted>) {expect(q.getReader).not.toHaveBeenCalled();expect(q.pull).not.toHaveBeenCalled();expect(f.log).toEqual([]);expect(f.invalidate).not.toHaveBeenCalled();}
const original=process.env.ROASTPILOT_C3_CALLER_SECRET;
beforeEach(()=>{vi.resetAllMocks();effects.executeStatement.mockResolvedValue(raw());delete process.env.ROASTPILOT_C3_CALLER_SECRET;});
afterEach(()=>{if(original===undefined)delete process.env.ROASTPILOT_C3_CALLER_SECRET;else process.env.ROASTPILOT_C3_CALLER_SECRET=original;});
it("REV-AUTH-1 unconfigured secret yields 503 with no credential, body, SQL or cache effect",async()=>{
  for(const configured of [undefined,"malformed"]) {const q=request();const f=scripted();const response=await cacheRevalidationPost(q.value,slug,f.reader,f.invalidator,()=>configured);expect(response.status).toBe(503);expect(await response.text()).toBe('{"error":"not_configured"}');expect(q.get).not.toHaveBeenCalled();zero(q,f);}
});
it("REV-AUTH-2 absent or wrong credential yields 401 Bearer with zero effects",async()=>{
  for(const authorization of [null,"Bearer rpc3_"+"E".repeat(43)]) {const {q,f,response,text}=await run([absent,absent],{authorization});expect(response.status).toBe(401);expect(text).toBe('{"error":"unauthorized"}');expect(response.headers.get("WWW-Authenticate")).toBe("Bearer");zero(q,f);}
});
it("REV-SHAPE-1 raw query marker yields 400 with zero effects",async()=>{
  for(const url of ["https://example.test/r/x?","https://example.test/r/x?x=1"]) {const {q,f,response,text}=await run([absent,absent],{url});expect(response.status).toBe(400);expect(text).toBe('{"error":"invalid_request"}');zero(q,f);}
});
it("REV-SHAPE-2 non-JSON content type yields 415 with zero effects",async()=>{const {q,f,response,text}=await run([absent,absent],{contentType:"text/plain"});expect(response.status).toBe(415);expect(text).toBe('{"error":"unsupported_media_type"}');zero(q,f);});
it("REV-SHAPE-3 non-POST yields 405 Allow POST with zero effects",async()=>{const {q,f,response,text}=await run([absent,absent],{method:"GET"});expect(response.status).toBe(405);expect(text).toBe('{"error":"method_not_allowed"}');expect(response.headers.get("Allow")).toBe("POST");zero(q,f);});
it("REV-404-1 invalid slug yields not_found before body read",async()=>{const q=request();const f=scripted();const response=await cacheRevalidationPost(q.value,"!!!",f.reader,f.invalidator,()=>secret);expect(response.status).toBe(404);expect(await response.text()).toBe('{"error":"not_found"}');zero(q,f);});

it("REV-PRECEDENCE-AUTH authentication wins over invalid method slug and body", async () => {
  const cases = [
    { configured: undefined, status: 503, body: '{"error":"not_configured"}' },
    { configured: secret, status: 401, body: '{"error":"unauthorized"}' },
  ];
  for (const { configured, status, body } of cases) {
    const q = request({
      method: "GET",
      body: "malformed",
      authorization: "Bearer rpc3_" + "E".repeat(43),
    });
    const f = scripted();
    const response = await cacheRevalidationPost(q.value, "!!!", f.reader, f.invalidator, () => configured);
    expect(response.status).toBe(status);
    expect(await response.text()).toBe(body);
    zero(q, f);
  }
});

it("REV-PRECEDENCE-SHAPE shape wins over invalid slug and body", async () => {
  const q = request({ method: "POST", contentType: "text/plain", body: "malformed" });
  const f = scripted();
  const response = await cacheRevalidationPost(q.value, "!!!", f.reader, f.invalidator, () => secret);
  expect(response.status).toBe(415);
  expect(await response.text()).toBe('{"error":"unsupported_media_type"}');
  zero(q, f);
});

it("REV-PRECEDENCE-SLUG invalid slug wins over malformed body", async () => {
  const q = request({ body: "malformed" });
  const f = scripted();
  const response = await cacheRevalidationPost(q.value, "!!!", f.reader, f.invalidator, () => secret);
  expect(response.status).toBe(404);
  expect(await response.text()).toBe('{"error":"not_found"}');
  zero(q, f);
});

for(const [name,body] of [["REV-BODY-1 absent body yields 400 with zero effects","absent"],["REV-BODY-2 oversized body yields 400 with zero effects","oversize"],["REV-BODY-3 body read failure yields 400 with zero effects","throw"],["REV-BODY-4 malformed nonce yields 400 with zero effects","malformed"]] as const)it(name,async()=>{const {f,response,text}=await run([absent,absent],{body});expect(response.status).toBe(400);expect(text).toBe('{"error":"invalid_request"}');expect(f.log).toEqual([]);expect(f.invalidate).not.toHaveBeenCalled();});
it("REV-1 complete exact bytes headers and effect order",async()=>{const {f,response,text}=await run();expect(response.status).toBe(200);expect(text).toBe(complete);expect(response.headers.get("cache-control")).toBe("no-store");expect(response.headers.get("content-type")).toBe("application/json");expect(f.log).toEqual(["absence","invalidate","absence"]);expect(f.invalidate).toHaveBeenCalledWith(slug);});
it("REV-2 visible roast pending view_present without invalidation",async()=>{const {f,response,text}=await run([present]);expect(response.status).toBe(202);expect(text).toBe(pending("view_present"));expect(f.log).toEqual(["absence"]);expect(f.invalidate).not.toHaveBeenCalled();});
it("REV-3 reviews without roast pending view_present without invalidation",async()=>{
 const f=scripted();const execute=vi.fn<typeof executeStatement>().mockResolvedValue(raw("0","1"));const q=request();const reader=createPublicAbsenceReader(execute);const response=await cacheRevalidationPost(q.value,slug,{readAbsence:async(s)=>{f.log.push("absence");return reader.readAbsence(s);}},f.invalidator,()=>secret);
 expect(response.status).toBe(202);expect(await response.text()).toBe(pending("view_present"));expect(f.log).toEqual(["absence"]);expect(f.invalidate).not.toHaveBeenCalled();
});
it("REV-4 synchronous invalidation failure pending invalidation_failed without final observation",async()=>{const q=request();const f=scripted();f.invalidate.mockImplementation(()=>{f.log.push("invalidate");throw unavailable;});const response=await cacheRevalidationPost(q.value,slug,f.reader,f.invalidator,()=>secret);expect(response.status).toBe(202);expect(await response.text()).toBe(pending("invalidation_failed"));expect(f.log).toEqual(["absence","invalidate"]);});
it("REV-6 resurfaced after invalidation pending view_present",async()=>{const {f,response,text}=await run([absent,present]);expect(response.status).toBe(202);expect(text).toBe(pending("view_present"));expect(f.log).toEqual(["absence","invalidate","absence"]);});
it("REV-8a first observation transport failure pending view_unavailable",async()=>{const {f,response,text}=await run([unavailable]);expect(response.status).toBe(202);expect(text).toBe(pending("view_unavailable"));expect(f.log).toEqual(["absence"]);expect(f.invalidate).not.toHaveBeenCalled();});
it("REV-8b final observation transport failure pending view_unavailable",async()=>{const {f,response,text}=await run([absent,unavailable]);expect(response.status).toBe(202);expect(text).toBe(pending("view_unavailable"));expect(f.log).toEqual(["absence","invalidate","absence"]);});
it("REV-9a first observation invalid pending view_invalid",async()=>{const {f,response,text}=await run([invalid]);expect(response.status).toBe(202);expect(text).toBe(pending("view_invalid"));expect(f.log).toEqual(["absence"]);expect(f.invalidate).not.toHaveBeenCalled();});
it("REV-9b final observation invalid pending view_invalid",async()=>{const {f,response,text}=await run([absent,invalid]);expect(response.status).toBe(202);expect(text).toBe(pending("view_invalid"));expect(f.log).toEqual(["absence","invalidate","absence"]);});
it("REV-9c unsupported reader observations pending view_invalid",async()=>{
 for(const value of [null,undefined,{kind:"unknown"}])for(const final of [false,true]) {const q=request();const f=scripted();let n=0;const reader:PublicAbsenceReader={readAbsence:async()=>{f.log.push("absence");return (final&&n++===0?absent:value) as unknown as Absence;}};const response=await cacheRevalidationPost(q.value,slug,reader,f.invalidator,()=>secret);expect(response.status).toBe(202);expect(await response.text()).toBe(pending("view_invalid"));expect(f.log).toEqual(final?["absence","invalidate","absence"]:["absence"]);}
});
it("REV-HDR-1 every complete and pending acknowledgement is no-store JSON",async()=>{
 for(const observations of [[absent,absent],[present],[invalid],[unavailable],[absent,present],[absent,invalid],[absent,unavailable]]) {const {response}=await run(observations);expect(response.headers.get("cache-control")).toBe("no-store");expect(response.headers.get("content-type")).toBe("application/json");}
 const q=request();const f=scripted();f.invalidate.mockImplementation(()=>{throw unavailable;});const response=await cacheRevalidationPost(q.value,slug,f.reader,f.invalidator,()=>secret);expect(response.headers.get("cache-control")).toBe("no-store");expect(response.headers.get("content-type")).toBe("application/json");
});
it("REV-LOG-1 never logs",async()=>{
 const spies=Object.keys(console).filter(k=>typeof console[k as keyof Console]==="function").map(k=>vi.spyOn(console,k as "log").mockImplementation(()=>undefined));
 try {await run();await run([present]);await run([unavailable]);for(const spy of spies)expect(spy).not.toHaveBeenCalled();}finally{for(const spy of spies)spy.mockRestore();}
});
it("REV-SUB-1 scripted reader and SQL adapter over fake execute yield identical responses",async()=>{
 for(const observations of [[absent,absent],[present],[invalid],[unavailable],[absent,present],[absent,invalid],[absent,unavailable]]) {
  const a=await run(observations);let at=0;const execute=vi.fn<typeof executeStatement>().mockImplementation(async()=>{const v=observations[at++];if(v===undefined||v instanceof Error)throw unavailable;return v.kind==="absent"?raw():v.kind==="present"?raw("1"):({...raw(),rowCount:0});});const f=scripted();const response=await cacheRevalidationPost(request().value,slug,createPublicAbsenceReader(execute),f.invalidator,()=>secret);expect({status:response.status,text:await response.text()}).toEqual({status:a.response.status,text:a.text});
 }
});
it("REV-COMPOSE-1 real route authenticates and runs ABSENCE twice and both path requests",async()=>{
 process.env.ROASTPILOT_C3_CALLER_SECRET=secret;const {POST}=await import("../app/api/r/[slug]/cache-revalidation/route");const response=await POST(request().value as Request,{params:Promise.resolve({slug})});expect(response.status).toBe(200);expect(await response.text()).toBe(complete);expect(effects.executeStatement.mock.calls).toEqual(Array.from({length:2},()=>["select (select count(*) from app.roast_by_slug where public_slug = :1) as roast_rows, (select count(*) from app.reviews_by_roast where public_slug = :2) as review_rows",{"1":{type:"TEXT",value:slug},"2":{type:"TEXT",value:slug}}]));expect(revalidations()).toEqual([[`/r/${slug}`],[`/r/${slug}/opengraph-image`]]);
});
it("REV-COMPOSE-2 real route unconfigured yields 503 with no SQL and no path request",async()=>{const {POST}=await import("../app/api/r/[slug]/cache-revalidation/route");const response=await POST(request().value as Request,{params:Promise.resolve({slug})});expect(response.status).toBe(503);expect(await response.text()).toBe('{"error":"not_configured"}');expect(effects.executeStatement).not.toHaveBeenCalled();expect(revalidations()).toEqual([]);});
it("REV-COMPOSE-3 route exports exactly POST and nodejs runtime and imports without effects",async()=>{vi.resetModules(); const saved=process.env;let reads=0;process.env=new Proxy(saved,{get(target,key){if(key==="ROASTPILOT_C3_CALLER_SECRET")reads++;return Reflect.get(target,key);}});try {const route=await import("../app/api/r/[slug]/cache-revalidation/route");expect(Object.keys(route).sort()).toEqual(["POST","runtime"]);expect(route.runtime).toBe("nodejs");expect(reads).toBe(0);expect(effects.executeStatement).not.toHaveBeenCalled();expect(revalidations()).toEqual([]);}finally{process.env=saved;}});
