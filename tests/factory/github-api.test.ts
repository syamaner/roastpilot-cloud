import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubRequest, requireEnv } from "../../scripts/factory/github-api.mts";

describe("requireEnv", () => {
  afterEach(() => {
    delete process.env.TEST_VAR;
  });

  it("returns the value when set", () => {
    process.env.TEST_VAR = "hello";
    expect(requireEnv("TEST_VAR")).toBe("hello");
  });

  it("throws with the variable name when unset", () => {
    delete process.env.TEST_VAR;
    expect(() => requireEnv("TEST_VAR")).toThrow(/TEST_VAR/);
  });

  it("throws when set to an empty string", () => {
    process.env.TEST_VAR = "";
    expect(() => requireEnv("TEST_VAR")).toThrow(/TEST_VAR/);
  });
});

describe("githubRequest", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/ok")) {
          return new Response(JSON.stringify({ hello: "world" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.endsWith("/no-content")) {
          return new Response(null, { status: 204 });
        }
        if (url.endsWith("/error")) {
          return new Response("nope", { status: 403 });
        }
        throw new Error(`unexpected fetch to ${url} (${init?.method})`);
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed JSON on a 2xx response", async () => {
    const result = await githubRequest<{ hello: string }>(
      "tok",
      "GET",
      "/ok",
    );
    expect(result).toEqual({ hello: "world" });
  });

  it("returns undefined for a 204 No Content response", async () => {
    const result = await githubRequest("tok", "DELETE", "/no-content");
    expect(result).toBeUndefined();
  });

  it("throws, including the status and body, on a non-ok response", async () => {
    await expect(githubRequest("tok", "GET", "/error")).rejects.toThrow(
      /403/,
    );
  });

  it("sends the bearer token and a JSON body when provided", async () => {
    // `input` is typed but intentionally unused: it's here only so
    // fetchMock's inferred type matches fetch's signature, which is what
    // makes fetchMock.mock.calls type correctly below.
    const fetchMock = vi.fn(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      async (input: string | URL, init?: RequestInit) =>
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await githubRequest("secret-token", "POST", "/ok", { a: 1 });

    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer secret-token",
    });
    expect(init?.body).toBe(JSON.stringify({ a: 1 }));
  });
});
