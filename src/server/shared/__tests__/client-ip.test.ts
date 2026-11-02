// The client address feeds every per-address rate limit and the session record, so it must never come
// from a header the caller can choose. These tests need no database.
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIp } from "../http";

const h = (o: Record<string, string>) => new Headers(o);

describe("clientIp trusts only what the deployment guarantees", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("ignores every forwarding header when no trusted source is configured (self-hosted default)", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "");
    expect(clientIp(h({ "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.10", "x-vercel-forwarded-for": "203.0.113.11" }))).toBeUndefined();
  });

  it("on Vercel uses x-vercel-forwarded-for, then x-real-ip", () => {
    vi.stubEnv("VERCEL", "1");
    vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "");
    expect(clientIp(h({ "x-vercel-forwarded-for": "203.0.113.11", "x-real-ip": "203.0.113.10" }))).toBe("203.0.113.11");
    expect(clientIp(h({ "x-real-ip": "203.0.113.10", "x-forwarded-for": "198.51.100.1" }))).toBe("203.0.113.10");
    expect(clientIp(h({ "x-forwarded-for": "198.51.100.1" }))).toBeUndefined(); // appendable, never trusted
  });

  it("uses only the single header the operator names, and never x-forwarded-for", () => {
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "cf-connecting-ip");
    expect(clientIp(h({ "cf-connecting-ip": "2001:db8::1", "x-real-ip": "203.0.113.10" }))).toBe("2001:db8::1");
    vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "x-forwarded-for");
    expect(clientIp(h({ "x-forwarded-for": "198.51.100.1" }))).toBeUndefined();
  });

  it("discards values that are not literal IP addresses", () => {
    vi.stubEnv("TRUSTED_CLIENT_IP_HEADER", "x-real-ip");
    expect(clientIp(h({ "x-real-ip": "not-an-ip" }))).toBeUndefined();
    expect(clientIp(h({ "x-real-ip": "1.2.3.4-injected" }))).toBeUndefined();
    expect(clientIp(h({ "x-real-ip": "x".repeat(5000) }))).toBeUndefined();
  });
});
