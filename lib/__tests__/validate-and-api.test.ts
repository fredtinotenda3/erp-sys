import { describe, expect, it } from "vitest";
import { parseDecimalInput, requireText } from "../validate";
import { describeError, fieldErrorsFromIssues, outcomeOf } from "../api-client";
import { describeAudit } from "../audit-describe";
import type { AuditEntry } from "../api-types";

describe("parseDecimalInput", () => {
  it("parses plain decimals", () => {
    expect(parseDecimalInput("12.5", { maxDecimals: 4 })).toEqual({ ok: true, value: 12.5 });
  });
  it("rejects empty, text, and too many decimals", () => {
    expect(parseDecimalInput("", { maxDecimals: 4 }).ok).toBe(false);
    expect(parseDecimalInput("1e3", { maxDecimals: 4 }).ok).toBe(false);
    expect(parseDecimalInput("1.23456", { maxDecimals: 4 }).ok).toBe(false);
  });
  it("enforces positivity rules", () => {
    expect(parseDecimalInput("0", { maxDecimals: 2, min: "positive" }).ok).toBe(false);
    expect(parseDecimalInput("0", { maxDecimals: 2, min: "nonnegative" }).ok).toBe(true);
    expect(parseDecimalInput("-1", { maxDecimals: 2, min: "nonnegative" }).ok).toBe(false);
  });
});

describe("requireText", () => {
  it("enforces a minimum length for mandatory reasons", () => {
    expect(requireText("  ", "Reason", { min: 3 })).toMatch(/required/);
    expect(requireText("ab", "Reason", { min: 3 })).toMatch(/at least 3/);
    expect(requireText("abc", "Reason", { min: 3 })).toBeNull();
  });
});

describe("api error helpers", () => {
  it("maps zod-style issues to field keys (first message wins)", () => {
    expect(fieldErrorsFromIssues([{ path: ["lines", 0, "quantity"], message: "bad" }, { path: ["lines", 0, "quantity"], message: "other" }, { path: ["name"], message: "req" }])).toEqual({
      "lines.0.quantity": "bad",
      name: "req",
    });
  });
  it("surfaces issues that have no visible field", () => {
    const msg = describeError({ code: "VALIDATION_ERROR", message: "Invalid payload", issues: [{ path: ["secret"], message: "nope" }] }, ["name"]);
    expect(msg).toContain("secret: nope");
  });
  it("classifies outcomes for idempotency: only a definite 4xx is 'rejected'", () => {
    expect(outcomeOf({ ok: true, status: 201, data: null, replayed: false })).toBe("success");
    expect(outcomeOf({ ok: false, status: 400, network: false, error: { code: "x", message: "y" } })).toBe("rejected");
    expect(outcomeOf({ ok: false, status: 409, network: false, error: { code: "x", message: "y" } })).toBe("rejected");
    expect(outcomeOf({ ok: false, status: 500, network: false, error: { code: "x", message: "y" } })).toBe("unknown");
    expect(outcomeOf({ ok: false, status: 0, network: true, error: { code: "NETWORK", message: "y" } })).toBe("unknown");
  });
});

describe("describeAudit", () => {
  const base: AuditEntry = { id: "1", branchId: null, actorUserId: null, entityType: "production_job", entityId: "e", action: "transition", beforeValue: { status: "released" }, afterValue: { status: "in_progress" }, reason: null, createdAt: "2026-01-01T00:00:00Z" };
  it("describes status transitions from recorded values only", () => {
    expect(describeAudit(base)).toBe("Production job status changed from released to in progress");
  });
  it("falls back to entity + action", () => {
    expect(describeAudit({ ...base, action: "create", beforeValue: null, afterValue: null })).toBe("Production job created");
  });
});
