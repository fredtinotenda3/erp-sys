import { describe, expect, it } from "vitest";
import { IdempotentRequest, generateUuid } from "../idempotency";

function seq() {
  let n = 0;
  return () => `id-${++n}`;
}

describe("IdempotentRequest", () => {
  it("reuses the same clientRequestId when the same payload is retried", () => {
    const r = new IdempotentRequest(seq());
    const a = r.prepare({ q: 1 });
    r.settle("unknown");
    const b = r.prepare({ q: 1 });
    expect(a).toEqual({ ok: true, clientRequestId: "id-1" });
    expect(b).toEqual({ ok: true, clientRequestId: "id-1" });
  });

  it("issues a new id after success", () => {
    const r = new IdempotentRequest(seq());
    r.prepare({ q: 1 });
    r.settle("success");
    expect(r.prepare({ q: 1 })).toEqual({ ok: true, clientRequestId: "id-2" });
  });

  it("issues a new id when the payload changes after a definite rejection", () => {
    const r = new IdempotentRequest(seq());
    r.prepare({ q: 1 });
    r.settle("rejected");
    expect(r.prepare({ q: 2 })).toEqual({ ok: true, clientRequestId: "id-2" });
  });

  it("refuses changed data while the previous outcome is unknown (could double-post or 409)", () => {
    const r = new IdempotentRequest(seq());
    r.prepare({ q: 1 });
    r.settle("unknown");
    const changed = r.prepare({ q: 2 });
    expect(changed.ok).toBe(false);
    // ...but retrying the original is still fine
    expect(r.prepare({ q: 1 })).toEqual({ ok: true, clientRequestId: "id-1" });
  });

  it("keeps the id on rejection with identical payload", () => {
    const r = new IdempotentRequest(seq());
    r.prepare({ q: 1 });
    r.settle("rejected");
    expect(r.prepare({ q: 1 })).toEqual({ ok: true, clientRequestId: "id-1" });
  });
});

describe("generateUuid", () => {
  it("produces a v4 UUID the backend's z.string().uuid() accepts", () => {
    expect(generateUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
  it("falls back when crypto.randomUUID is unavailable (insecure context)", () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { value: { getRandomValues: (a: Uint8Array) => a.fill(7) }, configurable: true });
    try {
      expect(generateUuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      if (original) Object.defineProperty(globalThis, "crypto", original);
    }
  });
});
