import { describe, expect, it } from "vitest";
import { GET } from "../app/api/health/route";

describe("GET /api/health", () => {
  it("responds with 200 and a status ok body", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});
