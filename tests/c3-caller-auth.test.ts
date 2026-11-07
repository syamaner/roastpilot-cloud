import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { authenticateCaller } from "../lib/c3/caller-auth";

const secret = "rpc3_" + Buffer.alloc(32, 1).toString("base64url");
const wrong = "rpc3_" + Buffer.alloc(32, 2).toString("base64url");
describe("C3 caller admission", () => {
  it("AUTH-1 accepts canonical secret and credential", () => {
    expect(authenticateCaller(() => secret, () => `Bearer ${secret}`)).toEqual({ ok: true });
  });
  it("AUTH-2 rejects malformed configured secret before reading credentials", () => {
    for (const value of [undefined, "", "a", secret.slice(0, -1) + "F", secret + " ", secret.replace("rpc3_", "rpc3-"), secret + "="]) {
      const header = vi.fn(() => `Bearer ${secret}`);
      expect(authenticateCaller(() => value, header)).toEqual({ ok: false, status: 503, error: "not_configured" });
      expect(header).not.toHaveBeenCalled();
    }
  });
  it("AUTH-3 rejects non-Bearer and malformed credentials", () => {
    for (const value of [null, `Basic ${secret}`, "Bearer", `Bearer  ${secret}`, `Bearer ${secret} `, `Bearer ${secret}, Bearer ${secret}`]) {
      expect(authenticateCaller(() => secret, () => value)).toEqual({ ok: false, status: 401, error: "unauthorized" });
    }
    expect(authenticateCaller(() => secret, () => `bearer ${secret}`)).toEqual({ ok: true });
  });
  it("AUTH-4 rejects wrong same-format credential", () => {
    expect(authenticateCaller(() => secret, () => `Bearer ${wrong}`)).toEqual({ ok: false, status: 401, error: "unauthorized" });
  });
  it("AUTH-5 timing-safe compare is over fixed-length digests", () => {
    for (const value of ["x", secret + "x", wrong]) expect(authenticateCaller(() => secret, () => `Bearer ${value}`)).toEqual({ ok: false, status: 401, error: "unauthorized" });
    const source = readFileSync("lib/c3/caller-auth.ts", "utf8");
    expect(source).toMatch(/const equal = timingSafeEqual\(tokenDigest, configuredDigest\);/);
    expect(source).toContain('createHash("sha256").update(match[1]).digest()');
    expect(source).toContain('createHash("sha256").update(configured).digest()');
  });
});
