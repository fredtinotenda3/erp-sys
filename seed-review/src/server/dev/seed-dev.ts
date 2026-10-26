// Development seed. Everything is written through the application's own services
// (createUser, createItem, receiveStock, createJob, ...) as an authenticated
// OWNER_ADMIN, so passwords are hashed by the real mechanism, stock exists only as
// ledger movements (balances are derived by the service), job numbers, estimates,
// stage rules, quality rules, costing snapshots and the audit log all behave as in
// real use. Nothing here writes a table directly except read-only lookups.
//
// Repeatability: every record is found by a stable business key first (email, SKU,
// customer name, warehouse name, exchange-rate pair, receipt/issue clientRequestId
// derived from a fixed key, job fingerprint). Existing records are never modified
// or overwritten; a second run reports "existing" and creates nothing.
import { createHash } from "node:crypto";
import { prisma } from "../shared/db";
import type { AuthenticatedSession } from "../modules/iam/session-service";
import { createUser } from "../modules/iam/user-service";
import { createCustomer } from "../modules/customers/customer-service";
import { createItem } from "../modules/catalog/item-service";
import { activateBomVersion, createBomVersion, listBomVersions } from "../modules/catalog/bom-service";
import { createWarehouse } from "../modules/inventory/warehouse-service";
import { receiveStock } from "../modules/inventory/stock-service";
import { issueMaterialToJob } from "../modules/inventory/material-issue-service";
import { recordExchangeRate } from "../modules/costing/exchange-rate-service";
import { createJob, completeJob, transitionJob } from "../modules/production/job-service";
import { recordLabour } from "../modules/production/labour-service";
import { defineStages, transitionStage } from "../modules/production/stage-service";
import { recordOutput } from "../modules/production/output-service";
import { recordInspection } from "../modules/production/quality-service";
import {
  REQUIRED_CURRENCIES,
  SEED_CUSTOMERS,
  SEED_MATERIALS,
  SEED_PRODUCTS,
  SEED_RATES,
  SEED_RECEIPTS,
  SEED_USERS,
  SEED_WAREHOUSES,
} from "./seed-data";

/** Deterministic, RFC-4122-shaped id so a re-run replays instead of duplicating. */
export function seedUuid(key: string): string {
  const h = createHash("sha1").update(`operis-dev-seed:${key}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export interface SeedReport {
  created: Record<string, number>;
  existing: Record<string, number>;
  warnings: string[];
}
const newReport = (): SeedReport => ({ created: {}, existing: {}, warnings: [] });
const bump = (r: SeedReport, kind: string, wasCreated: boolean) => {
  const bucket = wasCreated ? r.created : r.existing;
  bucket[kind] = (bucket[kind] ?? 0) + 1;
};

const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

/** J1/J2 are the only pre-built jobs: just enough to inspect costing, stages, output and quality. */
const JOBS = {
  completed: { product: "FG-GUARD-01", customer: "Harare Mining Services", qty: 3, quote: 480 },
  inProgress: { product: "FG-FRAME-02", customer: "Bulawayo Pump & Engineering", qty: 4, quote: 2080 },
} as const;

async function assertCurrencies() {
  const have = new Set((await prisma.currency.findMany({ select: { code: true } })).map((c) => c.code.trim()));
  const missing = REQUIRED_CURRENCIES.filter((c) => !have.has(c));
  if (missing.length) throw new Error(`Currencies missing: ${missing.join(", ")}. Run scripts/seed-currencies.sql first.`);
}

/** Read-only: what a real run would create vs. find. Writes nothing. */
export async function planDevSeed(opts: { orgId: string; branchId: string; withJobs: boolean }): Promise<SeedReport> {
  const { orgId, branchId } = opts;
  const r = newReport();
  const tally = (kind: string, total: number, existing: number) => {
    if (existing) r.existing[kind] = existing;
    if (total - existing) r.created[kind] = total - existing;
  };
  tally("users", SEED_USERS.length, await prisma.user.count({ where: { orgId, email: { in: SEED_USERS.map((u) => u.email) } } }));
  tally("customers", SEED_CUSTOMERS.length, await prisma.customer.count({ where: { orgId, name: { in: SEED_CUSTOMERS.map((c) => c.name) } } }));
  const skus = [...SEED_MATERIALS.map((m) => m.sku), ...SEED_PRODUCTS.map((p) => p.sku)];
  tally("items", skus.length, await prisma.item.count({ where: { orgId, sku: { in: skus } } }));
  tally("warehouses", SEED_WAREHOUSES.length, await prisma.warehouse.count({ where: { orgId, branchId, name: { in: [...SEED_WAREHOUSES] } } }));
  tally("stock receipts", SEED_RECEIPTS.length, await prisma.stockMovement.count({ where: { orgId, clientRequestId: { in: SEED_RECEIPTS.map((x) => seedUuid(`receipt:${x.key}`)) } } }));
  let ratePairs = 0;
  for (const p of SEED_RATES) if (await prisma.exchangeRate.findFirst({ where: { orgId, baseCurrency: p.base, quoteCurrency: p.quote, source: "MANUAL" } })) ratePairs++;
  tally("exchange-rate pairs", SEED_RATES.length, ratePairs);
  if (opts.withJobs) {
    let jobs = 0;
    for (const j of Object.values(JOBS)) if (await findSeedJob(orgId, j)) jobs++;
    tally("jobs", Object.keys(JOBS).length, jobs);
  }
  return r;
}

async function findSeedJob(orgId: string, j: { product: string; customer: string; qty: number; quote: number }) {
  const [item, customer] = await Promise.all([prisma.item.findFirst({ where: { orgId, sku: j.product } }), prisma.customer.findFirst({ where: { orgId, name: j.customer } })]);
  if (!item || !customer) return null;
  return prisma.productionJob.findFirst({ where: { orgId, productItemId: item.id, customerId: customer.id, plannedQty: j.qty, quotedAmount: j.quote } });
}

export interface SeedOptions {
  session: AuthenticatedSession;
  branchId: string;
  /** Password for the seeded demo users. Supplied by the operator, hashed by createUser, never stored or logged. */
  userPassword: string;
  withJobs: boolean;
  log?: (message: string) => void;
}

export async function seedDevData(opts: SeedOptions): Promise<SeedReport> {
  const { session, branchId, userPassword } = opts;
  const orgId = session.orgId;
  const log = opts.log ?? (() => undefined);
  const report = newReport();
  if (userPassword.length < 12) throw new Error("The demo-user password must be at least 12 characters.");
  await assertCurrencies();

  // Exchange rates: only for a pair with no manual rate at all (never alters real rates).
  for (const pair of SEED_RATES) {
    const has = await prisma.exchangeRate.findFirst({ where: { orgId, baseCurrency: pair.base, quoteCurrency: pair.quote, source: "MANUAL" } });
    if (has) { bump(report, "exchange-rate pairs", false); continue; }
    for (const x of pair.rates) await recordExchangeRate(session, { baseCurrency: pair.base, quoteCurrency: pair.quote, rate: x.rate, asOfDate: day(-x.daysAgo), source: "MANUAL" });
    bump(report, "exchange-rate pairs", true);
    log(`rate ${pair.base}->${pair.quote}`);
  }

  // Users (real hashing via createUser; branch access granted explicitly).
  const userIds = new Map<string, string>();
  for (const u of SEED_USERS) {
    const found = await prisma.user.findFirst({ where: { orgId, email: u.email } });
    if (found) {
      userIds.set(u.email, found.id);
      bump(report, "users", false);
      if (found.role !== u.role) report.warnings.push(`User ${u.email} exists with role ${found.role}, not ${u.role}; left unchanged.`);
      continue;
    }
    const made = await createUser(session, { email: u.email, fullName: u.fullName, role: u.role, password: userPassword, branchIds: [branchId] });
    userIds.set(u.email, made.id);
    bump(report, "users", true);
    log(`user ${u.email} (${u.role})`);
  }

  // Customers
  const customerIds = new Map<string, string>();
  for (const c of SEED_CUSTOMERS) {
    const found = await prisma.customer.findFirst({ where: { orgId, name: c.name } });
    if (found) { customerIds.set(c.name, found.id); bump(report, "customers", false); continue; }
    const made = await createCustomer(session, c);
    customerIds.set(c.name, made.id);
    bump(report, "customers", true);
    log(`customer ${c.name}`);
  }

  // Items
  const itemIds = new Map<string, string>();
  const ensureItem = async (sku: string, payload: Record<string, unknown>, expect: { itemType: string; uom: string }) => {
    const found = await prisma.item.findFirst({ where: { orgId, sku } });
    if (found) {
      itemIds.set(sku, found.id);
      bump(report, "items", false);
      if (found.itemType !== expect.itemType || found.uom !== expect.uom) report.warnings.push(`Item ${sku} exists as ${found.itemType}/${found.uom}, not ${expect.itemType}/${expect.uom}; left unchanged.`);
      return;
    }
    itemIds.set(sku, (await createItem(session, payload)).id);
    bump(report, "items", true);
    log(`item ${sku}`);
  };
  for (const m of SEED_MATERIALS) {
    await ensureItem(m.sku, { sku: m.sku, name: m.name, uom: m.uom, itemType: "raw_material", standardCost: m.cost, standardCostCurrency: m.currency, reorderThreshold: m.reorder }, { itemType: "raw_material", uom: m.uom });
  }
  for (const p of SEED_PRODUCTS) {
    await ensureItem(p.sku, { sku: p.sku, name: p.name, uom: "ea", itemType: "finished_good", isSellable: true, sellingPrice: p.price, sellingPriceCurrency: "USD" }, { itemType: "finished_good", uom: "ea" });
    const id = itemIds.get(p.sku)!;
    const versions = (await listBomVersions(session, id)) as { status: string }[];
    if (versions.some((v) => v.status === "active")) { bump(report, "BOMs", false); continue; }
    const bom = (await createBomVersion(session, id, { lines: p.bom.map(([sku, quantity, uom]) => ({ materialItemId: itemIds.get(sku)!, quantity, uom })) }))!;
    await activateBomVersion(session, id, bom.id);
    bump(report, "BOMs", true);
    log(`BOM ${p.sku}`);
  }

  // Warehouses
  const warehouseIds = new Map<string, string>();
  for (const name of SEED_WAREHOUSES) {
    const found = await prisma.warehouse.findFirst({ where: { orgId, branchId, name } });
    if (found) { warehouseIds.set(name, found.id); bump(report, "warehouses", false); continue; }
    warehouseIds.set(name, (await createWarehouse(session, { branchId, name })).id);
    bump(report, "warehouses", true);
    log(`warehouse ${name}`);
  }

  // Opening stock: receipts only. A fixed clientRequestId per receipt makes a re-run a replay.
  for (const x of SEED_RECEIPTS) {
    const res = await receiveStock(session, {
      clientRequestId: seedUuid(`receipt:${x.key}`),
      warehouseId: warehouseIds.get(x.warehouse),
      itemId: itemIds.get(x.sku),
      quantity: x.qty,
      unitCost: x.cost,
      currency: x.currency,
    });
    bump(report, "stock receipts", !res.replayed);
    if (!res.replayed) log(`receipt ${x.key}`);
  }

  if (opts.withJobs) await seedJobs({ session, branchId, itemIds, customerIds, warehouseIds, operatorId: userIds.get("operator@operis.test"), report, log });
  return report;
}

interface JobCtx {
  session: AuthenticatedSession;
  branchId: string;
  itemIds: Map<string, string>;
  customerIds: Map<string, string>;
  warehouseIds: Map<string, string>;
  operatorId?: string;
  report: SeedReport;
  log: (m: string) => void;
}

async function seedJobs(c: JobCtx) {
  const { session, branchId, itemIds, customerIds, report, log } = c;
  const orgId = session.orgId;
  const main = c.warehouseIds.get("Main Store")!;
  const item = (sku: string) => itemIds.get(sku)!;

  const start = async (kind: keyof typeof JOBS, expectedStatus: string, build: (jobId: string) => Promise<void>, plan: { s: number; e: number }) => {
    const j = JOBS[kind];
    const existing = await findSeedJob(orgId, j);
    if (existing) {
      bump(report, "jobs", false);
      if (existing.status !== expectedStatus) report.warnings.push(`Seed job ${existing.jobNumber} (${j.product} x${j.qty}) is "${existing.status}", expected "${expectedStatus}": it may be partially seeded or since changed; left unchanged.`);
      return;
    }
    const job = (await createJob(session, {
      branchId, productItemId: item(j.product), plannedQty: j.qty, customerId: customerIds.get(j.customer),
      quotedAmount: j.quote, quotedCurrency: "USD", plannedStart: day(plan.s), plannedEnd: day(plan.e),
    })) as { id: string; jobNumber: string };
    await build(job.id);
    bump(report, "jobs", true);
    log(`job ${job.jobNumber} (${kind})`);
  };
  const id = (k: string) => seedUuid(k);
  const issue = (jobId: string, key: string, sku: string, quantity: number) => issueMaterialToJob(session, jobId, { clientRequestId: id(key), materialItemId: item(sku), warehouseId: main, quantity });
  const labour = (jobId: string, key: string, hours: number, rate: number) => recordLabour(session, jobId, { clientRequestId: id(key), hours, rate, rateCurrency: "USD" });
  const stageAct = (jobId: string, stageId: string, action: string) => transitionStage(session, jobId, stageId, { action });
  const out = (jobId: string, key: string, stageId: string, body: Record<string, unknown>) => recordOutput(session, jobId, { clientRequestId: id(key), jobStageId: stageId, ...body });

  // J1 - COMPLETED guard panels: frozen cost snapshot, 4 kg over-issue, scrap 1, quote vs cost, cost per good unit.
  await start("completed", "completed", async (jobId) => {
    const st = (await defineStages(session, jobId, { stages: [{ name: "Cut" }, { name: "Weld", requiresInspection: true }, { name: "Paint" }] })).stages;
    await transitionJob(session, jobId, { status: "released" });
    await issue(jobId, "j1:steel", "RM-STL-3MM", 40); // 36 expected -> 4 kg over-issue
    await issue(jobId, "j1:fastener", "RM-FAST-KIT", 3);
    await labour(jobId, "j1:labour", 6, 4.5);
    await stageAct(jobId, st[0]!.id, "start"); await out(jobId, "j1:cut", st[0]!.id, { goodQty: 3 }); await stageAct(jobId, st[0]!.id, "complete");
    await stageAct(jobId, st[1]!.id, "start"); await out(jobId, "j1:weld", st[1]!.id, { goodQty: 2, scrapQty: 1, reason: "damaged", notes: "Seed: one panel warped in welding" });
    await recordInspection(session, jobId, { clientRequestId: id("j1:insp"), jobStageId: st[1]!.id, inspectedQty: 2 });
    await stageAct(jobId, st[1]!.id, "complete");
    await stageAct(jobId, st[2]!.id, "start"); await out(jobId, "j1:paint", st[2]!.id, { goodQty: 2 }); await stageAct(jobId, st[2]!.id, "complete");
    await completeJob(session, jobId);
  }, { s: -14, e: -7 });

  // J2 - IN PROGRESS frames: multi-currency cost, Weld inspection FAILED and awaiting a manager's decision.
  await start("inProgress", "in_progress", async (jobId) => {
    const st = (await defineStages(session, jobId, {
      stages: [{ name: "Cut" }, { name: "Weld", requiresInspection: true, workCentre: "Weld Bay 1", operatorUserId: c.operatorId }, { name: "Finish" }],
    })).stages;
    await transitionJob(session, jobId, { status: "released" });
    await issue(jobId, "j2:steel", "RM-STL-3MM", 220); // exactly 4 x 55
    await issue(jobId, "j2:paint", "RM-PNT-GRY", 6); // ZIG-costed
    await labour(jobId, "j2:labour", 8, 4.5);
    await stageAct(jobId, st[0]!.id, "start"); await out(jobId, "j2:cut", st[0]!.id, { goodQty: 4 }); await stageAct(jobId, st[0]!.id, "complete");
    await stageAct(jobId, st[1]!.id, "start"); await out(jobId, "j2:weld", st[1]!.id, { goodQty: 4 });
    await recordInspection(session, jobId, { clientRequestId: id("j2:insp"), jobStageId: st[1]!.id, inspectedQty: 4, rejectedQty: 1, rejectReason: "wrong_dimensions", notes: "Seed: bracket weld off-spec; needs a manager's decision" });
  }, { s: -3, e: 6 });
}
