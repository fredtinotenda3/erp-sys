/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeAll } from "vitest";
import { createTestOrg, ownerSession, type TestOrg } from "../../modules/iam/__tests__/test-helpers";
import { login } from "../../modules/iam/session-service";
import { prisma } from "../../shared/db";
import { planDevSeed, seedDevData, seedUuid, type SeedReport } from "../seed-dev";
import { SEED_CUSTOMERS, SEED_MATERIALS, SEED_PRODUCTS, SEED_RATES, SEED_RECEIPTS, SEED_USERS, SEED_WAREHOUSES } from "../seed-data";
import { createJob, getJob, transitionJob } from "../../modules/production/job-service";
import { getShortages } from "../../modules/inventory/shortage-service";
import { getJobCost } from "../../modules/costing/cost-service";
import { getJobReadiness } from "../../modules/production/readiness-api";
import { listInspections, recordDisposition } from "../../modules/production/quality-service";
import { listStages } from "../../modules/production/stage-service";
import { capabilitiesFor } from "../../shared/authz";
import type { AuthenticatedSession } from "../../modules/iam/session-service";

const PASSWORD = "Seed-Test-Passw0rd!";
let org: TestOrg;
let owner: AuthenticatedSession;
let first: SeedReport;
let second: SeedReport;
let before: { movements: number; items: number; users: number };
let planBefore: SeedReport;

const counts = async () => ({
  movements: await prisma.stockMovement.count({ where: { orgId: org.organizationId } }),
  items: await prisma.item.count({ where: { orgId: org.organizationId } }),
  users: await prisma.user.count({ where: { orgId: org.organizationId } }),
});
const item = async (sku: string) => (await prisma.item.findFirstOrThrow({ where: { orgId: org.organizationId, sku } })).id;
const newJob = async (sku: string, qty: number) => ((await createJob(owner, { branchId: org.branchId, productItemId: await item(sku), plannedQty: qty })) as any).id as string;

beforeAll(async () => {
  org = await createTestOrg("seeddev");
  owner = await ownerSession(org);
  planBefore = await planDevSeed({ orgId: org.organizationId, branchId: org.branchId, withJobs: true });
  const dryCounts = await counts();
  expect(dryCounts.items).toBe(0); // planning wrote nothing
  first = await seedDevData({ session: owner, branchId: org.branchId, userPassword: PASSWORD, withJobs: true });
  before = await counts();
  second = await seedDevData({ session: owner, branchId: org.branchId, userPassword: PASSWORD, withJobs: true });
}, 300_000);

describe("dry run", () => {
  it("reports what would be created and creates nothing", () => {
    expect(planBefore.created).toMatchObject({ users: 5, customers: 3, items: 12, warehouses: 2, "stock receipts": 11, "exchange-rate pairs": 4, jobs: 2 });
    expect(planBefore.existing).toEqual({});
  });
});

describe("first run", () => {
  it("creates the full dataset", () => {
    expect(first.created).toMatchObject({
      users: SEED_USERS.length,
      customers: SEED_CUSTOMERS.length,
      items: SEED_MATERIALS.length + SEED_PRODUCTS.length,
      BOMs: SEED_PRODUCTS.length,
      warehouses: SEED_WAREHOUSES.length,
      "stock receipts": SEED_RECEIPTS.length,
      "exchange-rate pairs": SEED_RATES.length,
      jobs: 2,
    });
    expect(first.warnings).toEqual([]);
  });
});

describe("repeatability", () => {
  it("a second run creates nothing and duplicates nothing", async () => {
    expect(second.created).toEqual({});
    expect(second.existing).toMatchObject({ users: 5, customers: 3, items: 12, BOMs: 4, warehouses: 2, "stock receipts": 11, "exchange-rate pairs": 4, jobs: 2 });
    expect(second.warnings).toEqual([]);
    expect(await counts()).toEqual(before);
    expect(await prisma.exchangeRate.count({ where: { orgId: org.organizationId } })).toBe(5); // 4 pairs, USD->ZIG has two dated rates
    expect(await prisma.productionJob.count({ where: { orgId: org.organizationId } })).toBe(2);
  });

  it("a later dry run sees everything as already there", async () => {
    const p = await planDevSeed({ orgId: org.organizationId, branchId: org.branchId, withJobs: true });
    expect(p.created).toEqual({});
    expect(p.existing).toMatchObject({ users: 5, items: 12, jobs: 2 });
  });

  it("receipt ids are deterministic (that is what makes a re-run a replay)", () => {
    expect(seedUuid("receipt:main-steel-1")).toBe(seedUuid("receipt:main-steel-1"));
    expect(seedUuid("receipt:main-steel-1")).not.toBe(seedUuid("receipt:main-steel-2"));
    expect(seedUuid("x")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("users and permissions", () => {
  it("each demo user has the intended role, belongs to this org and branch, and can log in", async () => {
    for (const u of SEED_USERS) {
      const row = await prisma.user.findFirstOrThrow({ where: { orgId: org.organizationId, email: u.email } });
      expect(row.role).toBe(u.role);
      expect(await prisma.userBranchAccess.count({ where: { orgId: org.organizationId, userId: row.id, branchId: org.branchId } })).toBe(1);
      const { session } = await login({ organizationId: org.organizationId, email: u.email, password: PASSWORD });
      expect(session.role).toBe(u.role);
    }
  });

  it("passwords are hashed, never stored in clear", async () => {
    for (const u of await prisma.user.findMany({ where: { orgId: org.organizationId, email: { endsWith: "@operis.test" } } })) {
      expect(u.passwordHash).not.toContain(PASSWORD);
      expect(u.passwordHash.startsWith("$argon2")).toBe(true);
    }
  });

  it("roles hold exactly what the role definitions give them (nothing extra was granted)", () => {
    expect(capabilitiesFor("VIEWER")).not.toContain("stock:receive");
    expect(capabilitiesFor("PRODUCTION_OPERATOR")).not.toContain("quality:approve");
    expect(capabilitiesFor("INVENTORY_MANAGER")).not.toContain("cost:read");
    expect(capabilitiesFor("FINANCE_MANAGER")).toContain("cost:adjust");
  });
});

describe("catalogue, BOMs and units", () => {
  it("every BOM line points at a seeded raw material with a matching unit; products have different BOMs", async () => {
    const boms = new Map<string, string>();
    for (const p of SEED_PRODUCTS) {
      const prod = await prisma.item.findFirstOrThrow({ where: { orgId: org.organizationId, sku: p.sku } });
      const bom = await prisma.billOfMaterial.findFirstOrThrow({ where: { orgId: org.organizationId, productItemId: prod.id, status: "active" }, include: { lines: true } });
      expect(bom.lines).toHaveLength(p.bom.length);
      for (const l of bom.lines) {
        const mat = await prisma.item.findFirstOrThrow({ where: { id: l.materialItemId } });
        expect(mat.itemType).toBe("raw_material");
        expect(l.uom).toBe(mat.uom);
        expect(mat.orgId).toBe(org.organizationId);
      }
      boms.set(p.sku, bom.lines.map((l) => l.materialItemId).sort().join(","));
    }
    expect(new Set(boms.values()).size).toBe(SEED_PRODUCTS.length);
  });
});

describe("inventory ledger", () => {
  it("balances reconcile exactly with the ledger, and only receipts/issues created them", async () => {
    const rows = await prisma.stockMovement.groupBy({ by: ["itemId", "warehouseId"], where: { orgId: org.organizationId }, _sum: { quantity: true } });
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      const bal = await prisma.stockBalance.findFirstOrThrow({ where: { orgId: org.organizationId, itemId: r.itemId, warehouseId: r.warehouseId } });
      expect(String(bal.quantity)).toBe(String(r._sum.quantity));
    }
    const types = (await prisma.stockMovement.groupBy({ by: ["movementType"], where: { orgId: org.organizationId } })).map((t) => t.movementType).sort();
    expect(types).toEqual(["production_consumption", "purchase_receipt"]);
  });

  it("opening stock minus sample-job consumption is what is on hand", async () => {
    const onHand = async (sku: string) => (await prisma.stockBalance.aggregate({ where: { orgId: org.organizationId, itemId: await item(sku) }, _sum: { quantity: true } }))._sum.quantity;
    expect(String(await onHand("RM-STL-3MM"))).toBe("940"); // 1,200 - 40 (J1) - 220 (J2)
    expect(String(await onHand("RM-MTR-55"))).toBe("6");
    expect(String(await onHand("RM-PNT-GRY"))).toBe("104"); // 110 - 6 (J2)
    expect(await onHand("RM-IBEAM-100")).toBeNull(); // never stocked
  });
});

describe("sample jobs for the Phase 3 screens", () => {
  it("J1 is completed with a frozen snapshot, scrap, an over-issue, a margin and a cost per good unit", async () => {
    const j = await prisma.productionJob.findFirstOrThrow({ where: { orgId: org.organizationId, status: "completed" } });
    const c = (await getJobCost(owner, j.id)) as any;
    expect(c.actualBasis).toBe("snapshot");
    expect(c.materialBreakdown.find((m: any) => m.overIssuedQty !== "0")).toMatchObject({ expectedQty: "36", issuedQty: "40", overIssuedQty: "4" });
    expect(c.output).toMatchObject({ effectiveGood: "2", scrap: "1", yieldPercent: "66.7" });
    expect(c.output.costPerGoodUnit.available).toBe(true);
    expect(c.profit).toMatchObject({ available: true, revenueBasis: "quoted" });
  });

  it("J2 is in progress, multi-currency, with a failed inspection that blocks completion until decided", async () => {
    const j = await prisma.productionJob.findFirstOrThrow({ where: { orgId: org.organizationId, status: "in_progress" } });
    const c = (await getJobCost(owner, j.id)) as any;
    expect(c.lines.map((l: any) => l.currency)).toEqual(["USD", "ZIG"]);
    expect(c.profit).toMatchObject({ available: false });
    const stages = (await listStages(owner, j.id)).stages;
    expect(stages.map((s) => s.status)).toEqual(["completed", "in_progress", "pending"]);
    expect(stages[1]).toMatchObject({ workCentre: "Weld Bay 1", inspection: { state: "failed_open" } });
    expect((await getJobReadiness(owner, j.id)).canComplete).toBe(false);
    // the manager can resolve it, and then the rest of the workflow can be driven from the UI
    const manager = (await login({ organizationId: org.organizationId, email: "manager@operis.test", password: PASSWORD })).session;
    const insp = (await listInspections(manager, j.id)).inspections[0]!;
    await expect(recordDisposition(manager, j.id, insp.id, { clientRequestId: seedUuid("test:disp"), kind: "scrap", qty: 1, reason: "Beyond repair" })).resolves.toBeTruthy();
  });
});

describe("scenarios the operator creates from the UI", () => {
  it("normal job: the BOM estimates and all materials are in stock", async () => {
    const id = await newJob("FG-GUARD-01", 5);
    await transitionJob(owner, id, { status: "released" });
    const shortages = (await getShortages(owner, {})) as any[];
    expect(shortages.filter((s) => s.status === "shortage")).toEqual([]);
  });

  it("large job: the estimate scales linearly and stock still covers it", async () => {
    const small = (await getJob(owner, await newJob("FG-GUARD-01", 3))) as any;
    const large = (await getJob(owner, await newJob("FG-GUARD-01", 60))) as any;
    expect(String(small.costEstimate.lines[0].estimatedMaterialCost)).toBe("78.3"); // 3 x (12 x 1.80 + 4.50)
    expect(String(large.costEstimate.lines[0].estimatedMaterialCost)).toBe("1566"); // 60 x 26.10
    await transitionJob(owner, large.id, { status: "released" });
    const steel = ((await getShortages(owner, {})) as any[]).find((s) => s.item.sku === "RM-STL-3MM");
    expect(steel.status).not.toBe("shortage"); // 720 + 5 x 12 needed of 940
  });

  it("shortage job: more pumps than motors is flagged, with the exact deficit", async () => {
    const id = await newJob("FG-PUMP-55", 7);
    await transitionJob(owner, id, { status: "released" });
    const motor = ((await getShortages(owner, {})) as any[]).find((s) => s.item.sku === "RM-MTR-55");
    expect(motor).toMatchObject({ status: "shortage", onHand: "6", remainingRequirement: "7", shortageQty: "1", hasStockRecord: true });
  });

  it("different BOM with a material that has no stock at all: shortage with no stock record", async () => {
    const id = await newJob("FG-SKID-03", 2);
    await transitionJob(owner, id, { status: "released" });
    const beam = ((await getShortages(owner, {})) as any[]).find((s) => s.item.sku === "RM-IBEAM-100");
    expect(beam).toMatchObject({ status: "shortage", hasStockRecord: false, onHand: "0", remainingRequirement: "12", shortageQty: "12" });
  });

  it("a low-stock (not short) material: bearings below their reorder level are flagged Low", async () => {
    const bearing = ((await getShortages(owner, {})) as any[]).find((s) => s.item.sku === "RM-BRG-6308");
    expect(bearing.status).toBe("low");
  });

  it("different currency: paint is costed in ZIG and its cost stays separate from USD", async () => {
    const j = (await getJob(owner, await newJob("FG-FRAME-02", 2))) as any;
    const cur = j.costEstimate.lines.map((l: any) => l.currency).sort();
    expect(cur).toEqual(["USD", "ZIG"]);
  });
});
