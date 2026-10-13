/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll } from "vitest";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { listAuditLog } from "../../iam/audit-service";
import { prisma } from "../../../shared/db";
import { recordExchangeRate, getLatestExchangeRate, listExchangeRates } from "../exchange-rate-service";
import { ForbiddenError, NotFoundError, ValidationError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";
import { sessionWithRole } from "../../production/__tests__/production-helpers";

let orgA: TestOrg;
let orgB: TestOrg;
let ownerA: AuthenticatedSession;
let ownerB: AuthenticatedSession;
let finance: AuthenticatedSession;
let ops: AuthenticatedSession;
let prodMgr: AuthenticatedSession;

const rate = (over: Record<string, unknown> = {}) => ({
  baseCurrency: "ZIG", quoteCurrency: "USD", rate: 0.04, asOfDate: "2026-10-01", source: "MANUAL", ...over,
});

beforeAll(async () => {
  orgA = await createTestOrg("fxA");
  orgB = await createTestOrg("fxB");
  ownerA = await ownerSession(orgA);
  ownerB = await ownerSession(orgB);
  finance = await sessionWithRole(ownerA, orgA.organizationId, "FINANCE_MANAGER", "fm", [orgA.branchId]);
  ops = await sessionWithRole(ownerA, orgA.organizationId, "OPERATIONS_MANAGER", "ops", [orgA.branchId]);
  prodMgr = await sessionWithRole(ownerA, orgA.organizationId, "PRODUCTION_MANAGER", "pm", [orgA.branchId]);
}, 180_000);

describe("exchange rates", () => {
  it("records a rate with its source and audits it", async () => {
    const row = await recordExchangeRate(finance, rate());
    expect(row.source).toBe("MANUAL");
    expect(String(row.rate)).toBe("0.04");
    const entries = (await listAuditLog(ownerA, { entityType: "exchange_rate", entityId: row.id })) as any[];
    expect(entries.some((e) => e.action === "create")).toBe(true);
  });

  it("the latest rate wins by as-of date, then by recording time; history is kept", async () => {
    await recordExchangeRate(ownerA, rate({ baseCurrency: "ZAR", quoteCurrency: "USD", rate: 0.05, asOfDate: "2026-09-01" }));
    await recordExchangeRate(ownerA, rate({ baseCurrency: "ZAR", quoteCurrency: "USD", rate: 0.06, asOfDate: "2026-10-01" }));
    await recordExchangeRate(ownerA, rate({ baseCurrency: "ZAR", quoteCurrency: "USD", rate: 0.055, asOfDate: "2026-10-01" })); // correction, same day
    const latest = await getLatestExchangeRate(ownerA, { baseCurrency: "ZAR", quoteCurrency: "USD" });
    expect(String(latest.rate)).toBe("0.055");
    const all = await listExchangeRates(ownerA, { baseCurrency: "ZAR", quoteCurrency: "USD" });
    expect(all).toHaveLength(3);
  });

  it("filters by source", async () => {
    await recordExchangeRate(ownerA, rate({ baseCurrency: "ZIG", quoteCurrency: "ZAR", rate: 2, source: "RBZ_OFFICIAL" }));
    await recordExchangeRate(ownerA, rate({ baseCurrency: "ZIG", quoteCurrency: "ZAR", rate: 3, source: "MARKET" }));
    expect(String((await getLatestExchangeRate(ownerA, { baseCurrency: "ZIG", quoteCurrency: "ZAR", source: "RBZ_OFFICIAL" })).rate)).toBe("2");
    expect(String((await getLatestExchangeRate(ownerA, { baseCurrency: "ZIG", quoteCurrency: "ZAR", source: "MARKET" })).rate)).toBe("3");
  });

  it("does not derive an inverse rate", async () => {
    await expect(getLatestExchangeRate(ownerA, { baseCurrency: "USD", quoteCurrency: "ZIG" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("validates payloads", async () => {
    for (const bad of [
      rate({ rate: 0 }), rate({ rate: -1 }), rate({ rate: 1.123456789 }),
      rate({ quoteCurrency: "ZIG" }), rate({ baseCurrency: "XXX" }), rate({ source: "GUESS" }),
      rate({ asOfDate: "2999-01-01" }), rate({ asOfDate: "not-a-date" }),
    ]) {
      await expect(recordExchangeRate(ownerA, bad)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("only owner and finance may record; owner, ops and finance may read; production manager neither", async () => {
    await expect(recordExchangeRate(ops, rate())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordExchangeRate(prodMgr, rate())).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listExchangeRates(ops)).resolves.toBeTruthy();
    await expect(listExchangeRates(prodMgr)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("TENANT ISOLATION: org B can neither see nor be affected by org A's rates", async () => {
    await recordExchangeRate(ownerA, rate({ baseCurrency: "USD", quoteCurrency: "ZAR", rate: 18 }));
    await expect(getLatestExchangeRate(ownerB, { baseCurrency: "USD", quoteCurrency: "ZAR" })).rejects.toBeInstanceOf(NotFoundError);
    expect(await listExchangeRates(ownerB)).toHaveLength(0);
  });

  it("rates are immutable at the database level", async () => {
    const row = await recordExchangeRate(ownerA, rate({ rate: 0.07 }));
    await expect(prisma.exchangeRate.update({ where: { id: row.id }, data: { rate: 9 } })).rejects.toBeTruthy();
    await expect(prisma.exchangeRate.delete({ where: { id: row.id } })).rejects.toBeTruthy();
  });
});
