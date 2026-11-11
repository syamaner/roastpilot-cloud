import { expect, it } from "vitest";
import { checkRevalidationShape } from "../lib/c3/bounded-body";
import { parseNonceBody, completeBody, pendingBody } from "../lib/c3/revalidation-request";
const nonce = "A".repeat(43);
const bytes = (s: string) => new TextEncoder().encode(s);
function shape(overrides: { method?: string; url?: string; headers?: Headers } = {}) {
  return { method: "POST", url: "https://example.test/r/valid", headers: new Headers({ "content-type": "application/json", "content-length": "63" }), ...overrides };
}
function headers(changes: Record<string, string | null>) {
  const h = shape().headers; for (const [k,v] of Object.entries(changes)) { if (v === null) h.delete(k); else h.set(k,v); } return h;
}
it("RQ-S-method PUT HEAD and GET yield 405", () => {
  for (const method of ["PUT", "HEAD", "GET"]) expect(checkRevalidationShape(shape({ method }))).toEqual({ ok: false, status: 405, error: "method_not_allowed" });
});
it("RQ-S-qmark empty and non-empty raw query markers yield 400", () => {
  for (const url of ["https://example.test/r/valid?", "https://example.test/r/valid?x=1"]) expect(checkRevalidationShape(shape({ url }))).toEqual({ ok: false, status: 400, error: "invalid_request" });
});
it("RQ-S-ctype missing text/plain charset-suffixed and joined content types yield 415 while case variants pass", () => {
  for (const value of [null,"text/plain","application/json; charset=utf-8","application/json, application/json"]) expect(checkRevalidationShape(shape({ headers: headers({ "content-type": value }) }))).toEqual({ ok: false, status: 415, error: "unsupported_media_type" });
  expect(checkRevalidationShape(shape({ headers: headers({ "content-type": "APPLICATION/JSON" }) }))).toEqual({ ok: true });
});
it("RQ-S-te transfer-encoding or content-encoding yields 400", () => {
  for (const name of ["transfer-encoding", "content-encoding"]) expect(checkRevalidationShape(shape({ headers: headers({ [name]: "identity" }) }))).toEqual({ ok: false, status: 400, error: "invalid_request" });
});
it("RQ-S-cl absent 62 64 063 and joined content-length yield 400", () => {
  for (const value of [null,"62","64","063","63, 63"]) expect(checkRevalidationShape(shape({ headers: headers({ "content-length": value }) }))).toEqual({ ok: false, status: 400, error: "invalid_request" });
});
it("RQ-S-ok exact shape accepted", () => { expect(checkRevalidationShape(shape())).toEqual({ ok: true }); });
it("RQ-N-ok canonical nonce body parsed", () => { expect(parseNonceBody(bytes(`{"request_nonce":"${nonce}"}`))).toBe(nonce); });
it("RQ-N-frame leading byte trailing byte whitespace extra or duplicate key and trailing newline rejected", () => {
  const body = `{"request_nonce":"${nonce}"}`;
  for (const s of ["x"+body,body+"x"," "+body,`{"request_nonce": "${nonce}"}`,`{"request_nonce":"${nonce}","x":1}`,`{"request_nonce":"${nonce}","request_nonce":"${nonce}"}`,body+"\n",`{"request_nonce":"${"é".repeat(43)}"}`]) expect(parseNonceBody(bytes(s))).toBeNull();
});
it("RQ-N-canonical non-canonical final base64url character rejected", () => { expect(parseNonceBody(bytes(`{"request_nonce":"${"A".repeat(42)}B"}`))).toBeNull(); });
it("RQ-BODY-1 exact complete and pending bytes", () => {
  expect(completeBody("slug",nonce)).toBe(`{"api_version":1,"public_slug":"slug","request_nonce":"${nonce}","cache_invalidation":"complete","evidence":{"view":"absent_uncached_before_and_after","current_render":"uncached","invalidation_calls":"requested","legacy_cache":"transition_qualified_non_servability"}}`);
  expect(pendingBody("slug",nonce,"view_present")).toBe(`{"api_version":1,"public_slug":"slug","request_nonce":"${nonce}","cache_invalidation":"pending","reason":"view_present"}`);
});
it("RQ-BODY-2 evidence never claims observation or erasure", () => { expect(completeBody("slug",nonce)).not.toMatch(/observed_absent|erased|purged|deleted/); });
