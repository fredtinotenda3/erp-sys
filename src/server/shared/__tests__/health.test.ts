import { describe, expect, it } from "vitest";
import { GET } from "../../../../app/api/v1/health/route";

describe("GET /api/v1/health", () => {
  it("reports ok against a reachable database and leaks nothing else", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
