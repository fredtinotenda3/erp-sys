// Demo seed for "Mavuno Packaging Industries (Pvt) Ltd" -- a fictional
// Zimbabwean rigid-plastic packaging manufacturer, built to showcase this
// application's plastics-manufacturing vertical end to end (OPERIS_USER_GUIDE.md,
// DEMO_DATA_CATALOGUE.md and the presentation guide describe what it produces).
//
// Same discipline as seed-dev.ts, re-used and extended, not replaced:
//   - Everything is written through the application's own services
//     (createItem, issueMaterialToJob, receiveGoodsForPurchaseOrder, createJob, ...).
//     Nothing here writes a business table directly -- only read-only lookups
//     (finding an existing row by business key) and building the per-persona
//     AuthenticatedSession objects below.
//   - Every record is found by a stable business key first (slug, email, SKU,
//     code, name, PO/SO number via its own idempotent clientRequestId). A
//     second run reports "existing" and creates nothing new.
//   - No table is ever cleared, reset, or deleted. Nothing here can run
//     against a database checkSeedSafety (seed-guard.ts, reused unmodified)
//     has not explicitly cleared.
//
// What's different from seedDevData: this seed BOOTSTRAPS a brand-new
// organization (seed-dev.ts only ever logs into an org that already exists),
// switches its industry profile to "plastics", and -- because recordLabour's
// userId, recordOutput's operatorUserId and recordInspection's inspectorUserId
// are each hard-set to session.userId at the call site (see labour-service.ts,
// output-service.ts, quality-service.ts) -- performs shop-floor actions
// through SEPARATE per-persona AuthenticatedSession objects (one real login
// per demo user) rather than a single OWNER_ADMIN session, so the data shows
// believable attribution (the Machine Operator records output, not the Owner).
import { createHash } from "node:crypto";
import { prisma } from "../shared/db";
import type { AuthenticatedSession } from "../modules/iam/session-service";
import { login } from "../modules/iam/session-service";
import { bootstrapOrganization } from "../modules/iam/org-service";
import { updateIndustryProfile } from "../modules/industry/industry-profile-service";
import { createBranch } from "../modules/iam/branch-service";
import { createUser } from "../modules/iam/user-service";
import { createWarehouse } from "../modules/inventory/warehouse-service";
import { createWorkCentre, createMachine } from "../modules/production/machine-service";
import { createMould, addMouldMachineCompatibility } from "../modules/production/mould-service";
import { createItem } from "../modules/catalog/item-service";
import { setPlasticsMaterialAttributes, setPlasticsProductSpec } from "../modules/catalog/plastics-item-service";
import { createBomVersion, activateBomVersion, listBomVersions } from "../modules/catalog/bom-service";
import { createInspectionPlan } from "../modules/production/quality-plan-service";
import { createSupplier } from "../modules/suppliers/supplier-service";
import { createCustomer } from "../modules/customers/customer-service";
import { recordExchangeRate } from "../modules/costing/exchange-rate-service";
import { createPurchaseOrder, confirmPurchaseOrder, closePurchaseOrder } from "../modules/purchasing/purchase-order-service";
import { receiveGoodsForPurchaseOrder } from "../modules/purchasing/goods-receipt-service";
import { createSalesOrder, confirmSalesOrder, cancelSalesOrder } from "../modules/sales/sales-order-service";
import { createJob, transitionJob, completeJob } from "../modules/production/job-service";
import { defineStages, transitionStage } from "../modules/production/stage-service";
import { issueMaterialToJob } from "../modules/inventory/material-issue-service";
import { recordLabour } from "../modules/production/labour-service";
import { recordOutput } from "../modules/production/output-service";
import { setPlasticsProcessDetail } from "../modules/production/plastics-process-service";
import { recordInspection, recordDisposition } from "../modules/production/quality-service";
import { createRegrindLot } from "../modules/inventory/regrind-service";
import { receiveFinishedGoods, transferBatch } from "../modules/inventory/finished-goods-service";
import { createDispatch, confirmDelivery } from "../modules/inventory/dispatch-service";
import {
  ORG,
  SECOND_BRANCH_NAME,
  PLASTICS_MODULES,
  DEMO_USERS,
  WORK_CENTRES,
  MACHINES,
  WAREHOUSES_HARARE,
  WAREHOUSES_BULAWAYO,
  RAW_MATERIALS,
  PRODUCTS,
  MOULDS,
  SUPPLIERS,
  CUSTOMERS,
  EXCHANGE_RATES,
  INSPECTION_PLANS,
  REQUIRED_CURRENCIES,
  type SeedUser,
} from "./seed-demo-data";

/** Deterministic, RFC-4122-shaped id so a re-run replays instead of duplicating. Own namespace, distinct from seed-dev.ts's seedUuid, so the two seeds' clientRequestIds never collide. */
export function demoUuid(key: string): string {
  const h = createHash("sha1").update(`operis-mavuno-demo-seed:${key}`).digest("hex");
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

/** Day offset from today, YYYY-MM-DD -- for date-only fields (requestedDeliveryDate, expiryDate). */
const day = (n: number) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
/** Day offset from today, full ISO timestamp -- for occurredAt-style fields (receivedAt, dispatchedAt, deliveredAt). */
const at = (n: number) => new Date(Date.now() + n * 864e5).toISOString();

async function assertCurrencies() {
  const have = new Set((await prisma.currency.findMany({ select: { code: true } })).map((c) => c.code.trim()));
  const missing = REQUIRED_CURRENCIES.filter((c) => !have.has(c));
  if (missing.length) throw new Error(`Currencies missing: ${missing.join(", ")}. Seed the currency table first (see SETUP_COMMANDS.md).`);
}

function itemTypeForSku(sku: string): "raw_material" | "consumable" | "spare_part" {
  if (sku.startsWith("RM-")) return "raw_material";
  if (sku.startsWith("CS-")) return "consumable";
  if (sku.startsWith("SP-")) return "spare_part";
  throw new Error(`Unrecognised raw-material SKU prefix: ${sku}`);
}

export interface SeedDemoOptions {
  /** Password for the OWNER_ADMIN account created by bootstrapOrganization. Never logged or stored beyond this run. */
  ownerPassword: string;
  /** Shared password for the other 7 demo users. Supplied by the operator, hashed by createUser, never stored or logged. */
  userPassword: string;
  log?: (message: string) => void;
}

export interface SeedDemoResult {
  organizationSlug: string;
  report: SeedReport;
}

/**
 * Finds (or bootstraps) the Mavuno Packaging organization and returns an
 * OWNER_ADMIN session for it. Idempotent: a second run logs into the
 * existing org instead of trying to bootstrap it again.
 */
async function ensureOrganizationAndOwner(ownerPassword: string, report: SeedReport, log: (m: string) => void): Promise<AuthenticatedSession> {
  const owner = DEMO_USERS[0]!;
  const existing = await prisma.organization.findUnique({ where: { slug: ORG.slug } });
  if (existing) {
    bump(report, "organization", false);
    const { session } = await login({ organizationSlug: ORG.slug, email: owner.email, password: ownerPassword });
    if (session.role !== "OWNER_ADMIN") throw new Error(`${owner.email} exists but is not OWNER_ADMIN of ${ORG.slug}; refusing to continue.`);
    return session;
  }
  const result = await bootstrapOrganization({
    organizationName: ORG.name,
    organizationSlug: ORG.slug,
    baseCurrency: ORG.baseCurrency,
    firstBranchName: ORG.firstBranchName,
    ownerEmail: owner.email,
    ownerFullName: owner.fullName,
    ownerPassword,
  });
  bump(report, "organization", true);
  log(`organization ${result.organizationSlug} (owner ${owner.email})`);
  const { session } = await login({ organizationSlug: ORG.slug, email: owner.email, password: ownerPassword });
  return session;
}

async function ensureSecondBranch(owner: AuthenticatedSession, report: SeedReport, log: (m: string) => void): Promise<string> {
  const found = await prisma.branch.findFirst({ where: { orgId: owner.orgId, name: SECOND_BRANCH_NAME } });
  if (found) {
    bump(report, "branches", false);
    return found.id;
  }
  const branch = (await createBranch(owner, { name: SECOND_BRANCH_NAME })) as { id: string };
  bump(report, "branches", true);
  log(`branch ${SECOND_BRANCH_NAME}`);
  return branch.id;
}

async function ensurePlasticsProfile(owner: AuthenticatedSession, report: SeedReport, log: (m: string) => void): Promise<void> {
  const org = await prisma.organization.findUnique({ where: { id: owner.orgId }, select: { industryProfile: true } });
  if (org?.industryProfile === "plastics") {
    bump(report, "industry profile", false);
    return;
  }
  await updateIndustryProfile(owner, {
    industryProfile: "plastics",
    enabledModules: [...PLASTICS_MODULES],
    reason: "Mavuno Packaging demo: enable the full plastics manufacturing vertical for this fictional demonstration organization.",
  });
  bump(report, "industry profile", true);
  log(`industry profile -> plastics (${PLASTICS_MODULES.length} modules)`);
}

/** Creates the 7 non-owner demo users (owner already exists from bootstrap) and logs each in. Returns a session map keyed by a short persona handle. */
async function ensureUsersAndSessions(
  owner: AuthenticatedSession,
  hareBranchId: string,
  bulawayoBranchId: string,
  userPassword: string,
  report: SeedReport,
  log: (m: string) => void,
): Promise<Record<string, AuthenticatedSession>> {
  const handleFor = (u: SeedUser): string => u.email.split("@")[0]!.split(".")[0]!; // "production.manager@..." -> "production"; fine, just needs to be unique and stable
  const sessions: Record<string, AuthenticatedSession> = { owner };

  for (const u of DEMO_USERS) {
    if (u.role === "OWNER_ADMIN") continue; // created by bootstrapOrganization
    const branchIds = u.email.startsWith("warehouse@") || u.email.startsWith("sales@") ? [hareBranchId, bulawayoBranchId] : [hareBranchId];
    const found = await prisma.user.findFirst({ where: { orgId: owner.orgId, email: u.email } });
    if (found) {
      bump(report, "users", false);
      if (found.role !== u.role) report.warnings.push(`User ${u.email} exists with role ${found.role}, not ${u.role}; left unchanged.`);
    } else {
      await createUser(owner, { email: u.email, fullName: u.fullName, role: u.role, password: userPassword, branchIds });
      bump(report, "users", true);
      log(`user ${u.email} (${u.role})`);
    }
    const { session } = await login({ organizationSlug: ORG.slug, email: u.email, password: userPassword });
    sessions[handleFor(u)] = session;
  }
  return sessions;
}

async function ensureWorkCentresAndMachines(
  owner: AuthenticatedSession,
  branchId: string,
  report: SeedReport,
  log: (m: string) => void,
): Promise<{ workCentreIds: Map<string, string>; machineIds: Map<string, string> }> {
  const workCentreIds = new Map<string, string>();
  for (const wc of WORK_CENTRES) {
    const found = await prisma.workCentre.findFirst({ where: { orgId: owner.orgId, branchId, code: wc.code } });
    if (found) {
      workCentreIds.set(wc.code, found.id);
      bump(report, "work centres", false);
      continue;
    }
    const created = (await createWorkCentre(owner, { branchId, code: wc.code, name: wc.name, dailyCapacityMinutes: wc.dailyCapacityMinutes })) as { id: string };
    workCentreIds.set(wc.code, created.id);
    bump(report, "work centres", true);
    log(`work centre ${wc.code} ${wc.name}`);
  }

  const machineIds = new Map<string, string>();
  for (const m of MACHINES) {
    const workCentreId = workCentreIds.get(m.workCentreCode)!;
    const found = await prisma.machine.findFirst({ where: { orgId: owner.orgId, workCentreId, code: m.code } });
    if (found) {
      machineIds.set(m.code, found.id);
      bump(report, "machines", false);
      continue;
    }
    const created = (await createMachine(owner, { workCentreId, code: m.code, name: m.name })) as { id: string };
    machineIds.set(m.code, created.id);
    bump(report, "machines", true);
    log(`machine ${m.code} ${m.name}`);
  }
  return { workCentreIds, machineIds };
}

async function ensureWarehouses(owner: AuthenticatedSession, hareBranchId: string, bulawayoBranchId: string, report: SeedReport, log: (m: string) => void): Promise<Map<string, string>> {
  const warehouseIds = new Map<string, string>();
  for (const name of WAREHOUSES_HARARE) {
    const found = await prisma.warehouse.findFirst({ where: { orgId: owner.orgId, branchId: hareBranchId, name } });
    if (found) { warehouseIds.set(name, found.id); bump(report, "warehouses", false); continue; }
    const created = (await createWarehouse(owner, { branchId: hareBranchId, name })) as { id: string };
    warehouseIds.set(name, created.id);
    bump(report, "warehouses", true);
    log(`warehouse ${name}`);
  }
  for (const name of WAREHOUSES_BULAWAYO) {
    const found = await prisma.warehouse.findFirst({ where: { orgId: owner.orgId, branchId: bulawayoBranchId, name } });
    if (found) { warehouseIds.set(name, found.id); bump(report, "warehouses", false); continue; }
    const created = (await createWarehouse(owner, { branchId: bulawayoBranchId, name })) as { id: string };
    warehouseIds.set(name, created.id);
    bump(report, "warehouses", true);
    log(`warehouse ${name}`);
  }
  return warehouseIds;
}

/** Items (raw materials + products), their plastics attributes/specs, and BOM v1 for every product. BOM v2 for the 2L preform is activated later, mid-job-sequence, to demonstrate version history realistically. */
async function ensureCatalog(owner: AuthenticatedSession, report: SeedReport, log: (m: string) => void): Promise<Map<string, string>> {
  const itemIds = new Map<string, string>();

  for (const m of RAW_MATERIALS) {
    const itemType = itemTypeForSku(m.sku);
    const found = await prisma.item.findFirst({ where: { orgId: owner.orgId, sku: m.sku } });
    if (found) {
      itemIds.set(m.sku, found.id);
      bump(report, "items", false);
    } else {
      const created = (await createItem(owner, { sku: m.sku, name: m.name, uom: m.uom, itemType, standardCost: m.cost, standardCostCurrency: m.currency, reorderThreshold: m.reorder })) as { id: string };
      itemIds.set(m.sku, created.id);
      bump(report, "items", true);
      log(`item ${m.sku}`);
    }
    if (m.plastics) {
      await setPlasticsMaterialAttributes(owner, itemIds.get(m.sku)!, {
        polymerGrade: m.plastics.polymerGrade ?? null,
        resinSpec: m.plastics.resinSpec ?? null,
        colourMasterbatch: m.plastics.colourMasterbatch ?? null,
        additiveNotes: m.plastics.additiveNotes ?? null,
        recycledContentPct: m.plastics.recycledContentPct ?? null,
        supplierMaterialRef: m.plastics.supplierMaterialRef ?? null,
      });
    }
  }

  for (const p of PRODUCTS) {
    const found = await prisma.item.findFirst({ where: { orgId: owner.orgId, sku: p.sku } });
    if (found) {
      itemIds.set(p.sku, found.id);
      bump(report, "items", false);
    } else {
      const created = (await createItem(owner, {
        sku: p.sku,
        name: p.name,
        uom: p.uom,
        itemType: p.itemType,
        isSellable: p.itemType === "finished_good",
        ...(p.itemType === "finished_good" ? { sellingPrice: p.price, sellingPriceCurrency: "USD" } : {}),
      })) as { id: string };
      itemIds.set(p.sku, created.id);
      bump(report, "items", true);
      log(`item ${p.sku}`);
    }
    if (p.plastics) {
      await setPlasticsProductSpec(owner, itemIds.get(p.sku)!, {
        productType: p.plastics.productType,
        resinType: p.plastics.resinType ?? null,
        colour: p.plastics.colour ?? null,
        nominalWeightGrams: p.plastics.nominalWeightGrams ?? null,
        capacityMl: p.plastics.capacityMl ?? null,
        heightMm: p.plastics.heightMm ?? null,
        diameterMm: p.plastics.diameterMm ?? null,
        neckFinish: p.plastics.neckFinish ?? null,
        closureCompatibilityNotes: p.plastics.closureCompatibilityNotes ?? null,
      });
    }

    const productId = itemIds.get(p.sku)!;
    const versions = (await listBomVersions(owner, productId)) as { id: string; status: string }[];
    if (versions.some((v) => v.status === "active")) {
      bump(report, "BOMs", false);
      continue;
    }
    const bom = (await createBomVersion(owner, productId, {
      lines: p.bom.map(([sku, quantity, uom, expectedScrapPct]) => ({
        materialItemId: itemIds.get(sku)!,
        quantity,
        uom,
        ...(expectedScrapPct !== undefined ? { expectedScrapPct } : {}),
      })),
    })) as { id: string };
    await activateBomVersion(owner, productId, bom.id);
    bump(report, "BOMs", true);
    log(`BOM v1 ${p.sku}`);
  }

  return itemIds;
}

/** Activates BOM v2 for the 2L preform (virgin/rPET blend), superseding v1. Called mid-sequence, after Job A1 has already snapshotted v1, so Job A3 (created afterward) snapshots v2 -- a real version-history demonstration, not a cosmetic one. */
async function activatePreform2LBomV2(owner: AuthenticatedSession, itemIds: Map<string, string>, report: SeedReport, log: (m: string) => void): Promise<void> {
  const product = PRODUCTS.find((p) => p.sku === "WIP-PET-PFM-2L")!;
  if (!product.bomV2) return;
  const productId = itemIds.get(product.sku)!;
  const versions = (await listBomVersions(owner, productId)) as { id: string; status: string; lines?: { materialItemId: string }[] }[];
  // If a BOM already references rPET, v2 was already activated on a prior run.
  const rpetId = itemIds.get("RM-RPET-APPROVED")!;
  const alreadyHasV2 = versions.some((v) => v.status === "active" && v.lines?.some((l) => l.materialItemId === rpetId));
  if (alreadyHasV2) {
    bump(report, "BOM v2 (rPET blend)", false);
    return;
  }
  const bom = (await createBomVersion(owner, productId, {
    lines: product.bomV2.map(([sku, quantity, uom, expectedScrapPct]) => ({
      materialItemId: itemIds.get(sku)!,
      quantity,
      uom,
      ...(expectedScrapPct !== undefined ? { expectedScrapPct } : {}),
    })),
  })) as { id: string };
  await activateBomVersion(owner, productId, bom.id);
  bump(report, "BOM v2 (rPET blend)", true);
  log(`BOM v2 ${product.sku} (virgin/rPET blend, supersedes v1)`);
}

async function ensureMoulds(owner: AuthenticatedSession, branchId: string, itemIds: Map<string, string>, machineIds: Map<string, string>, report: SeedReport, log: (m: string) => void): Promise<Map<string, string>> {
  const mouldIds = new Map<string, string>();
  for (const m of MOULDS) {
    const found = await prisma.mould.findFirst({ where: { orgId: owner.orgId, branchId, code: m.code } });
    let mouldId: string;
    if (found) {
      mouldId = found.id;
      bump(report, "moulds", false);
    } else {
      const created = (await createMould(owner, { branchId, code: m.code, name: m.name, cavityCount: m.cavityCount, compatibleProductItemId: itemIds.get(m.productSku) })) as { id: string };
      mouldId = created.id;
      bump(report, "moulds", true);
      log(`mould ${m.code} ${m.name}`);
    }
    mouldIds.set(m.code, mouldId);
    for (const machineCode of m.machineCodes) {
      const machineId = machineIds.get(machineCode)!;
      const existingCompat = await prisma.mouldMachineCompatibility.findFirst({ where: { orgId: owner.orgId, mouldId, machineId } });
      if (existingCompat) { bump(report, "mould-machine compatibilities", false); continue; }
      await addMouldMachineCompatibility(owner, mouldId, machineId);
      bump(report, "mould-machine compatibilities", true);
    }
  }
  return mouldIds;
}

/** Inspection plans and their characteristics. Returns, per plan name, a map of characteristic name -> id (for recordInspection's measurements array). */
async function ensureInspectionPlans(owner: AuthenticatedSession, itemIds: Map<string, string>, report: SeedReport, log: (m: string) => void): Promise<Map<string, { planId: string; characteristics: Map<string, string> }>> {
  const result = new Map<string, { planId: string; characteristics: Map<string, string> }>();
  for (const plan of INSPECTION_PLANS) {
    const itemId = itemIds.get(plan.itemSku)!;
    const found = await prisma.inspectionPlan.findFirst({ where: { orgId: owner.orgId, itemId, name: plan.name }, include: { characteristics: true } });
    if (found) {
      bump(report, "inspection plans", false);
      result.set(plan.name, { planId: found.id, characteristics: new Map(found.characteristics.map((c) => [c.name, c.id])) });
      continue;
    }
    const created = (await createInspectionPlan(owner, itemId, {
      name: plan.name,
      characteristics: plan.characteristics.map((c) => ({ name: c.name, uom: c.uom, minValue: c.minValue, maxValue: c.maxValue, targetValue: c.targetValue })),
    })) as { id: string; characteristics: { id: string; name: string }[] };
    bump(report, "inspection plans", true);
    log(`inspection plan ${plan.name}`);
    result.set(plan.name, { planId: created.id, characteristics: new Map(created.characteristics.map((c) => [c.name, c.id])) });
  }
  return result;
}

async function ensureSuppliersAndCustomers(
  purchasing: AuthenticatedSession,
  sales: AuthenticatedSession,
  report: SeedReport,
  log: (m: string) => void,
): Promise<{ supplierIds: Map<string, string>; customerIds: Map<string, string> }> {
  const supplierIds = new Map<string, string>();
  for (const s of SUPPLIERS) {
    const found = await prisma.supplier.findFirst({ where: { orgId: purchasing.orgId, name: s.name } });
    if (found) { supplierIds.set(s.name, found.id); bump(report, "suppliers", false); continue; }
    const created = (await createSupplier(purchasing, { name: s.name, contact: s.contact, address: s.address, notes: s.notes })) as { id: string };
    supplierIds.set(s.name, created.id);
    bump(report, "suppliers", true);
    log(`supplier ${s.name}`);
  }
  const customerIds = new Map<string, string>();
  for (const c of CUSTOMERS) {
    const found = await prisma.customer.findFirst({ where: { orgId: sales.orgId, name: c.name } });
    if (found) { customerIds.set(c.name, found.id); bump(report, "customers", false); continue; }
    const created = (await createCustomer(sales, { name: c.name, contact: c.contact, address: c.address, notes: c.notes })) as { id: string };
    customerIds.set(c.name, created.id);
    bump(report, "customers", true);
    log(`customer ${c.name}`);
  }
  return { supplierIds, customerIds };
}

async function ensureExchangeRates(owner: AuthenticatedSession, report: SeedReport, log: (m: string) => void): Promise<void> {
  for (const pair of EXCHANGE_RATES) {
    const has = await prisma.exchangeRate.findFirst({ where: { orgId: owner.orgId, baseCurrency: pair.base, quoteCurrency: pair.quote, source: pair.source } });
    if (has) { bump(report, "exchange-rate pairs", false); continue; }
    for (const x of pair.rates) {
      await recordExchangeRate(owner, { baseCurrency: pair.base, quoteCurrency: pair.quote, rate: x.rate, asOfDate: day(-x.daysAgo), source: pair.source });
    }
    bump(report, "exchange-rate pairs", true);
    log(`rate ${pair.base}->${pair.quote} (${pair.source})`);
  }
}

// ---------------------------------------------------------------------------
// Purchase orders + goods receipts. Each PO is found by its own deterministic
// business key (supplier + a fixed label), not by poNumber (which is assigned
// by the server and not knowable in advance).
// ---------------------------------------------------------------------------
interface PoLineSpec { sku: string; quantity: number; unitPrice: number }
interface PoSpec {
  key: string;
  supplierName: string;
  lines: PoLineSpec[];
  requestedDeliveryDaysAgo: number;
  /** "draft" | "confirmed" | "received" | "partially_received" | "closed" */
  target: "draft" | "confirmed" | "received" | "partially_received" | "closed";
  /** For "partially_received": sku -> fraction of ordered qty actually accepted (rest stays outstanding). */
  partialFractions?: Record<string, number>;
}

async function ensurePurchaseOrders(
  purchasing: AuthenticatedSession,
  owner: AuthenticatedSession,
  warehouse: AuthenticatedSession,
  branchId: string,
  supplierIds: Map<string, string>,
  itemIds: Map<string, string>,
  rawMaterialWarehouseId: string,
  report: SeedReport,
  log: (m: string) => void,
): Promise<void> {
  const specs: PoSpec[] = [
    { key: "po1-resin-pet", supplierName: "Harare Polymers (Pvt) Ltd", requestedDeliveryDaysAgo: 35, target: "received",
      lines: [{ sku: "RM-PET-VIRGIN", quantity: 5000, unitPrice: 1.15 }, { sku: "RM-RPET-APPROVED", quantity: 1500, unitPrice: 0.78 }] },
    { key: "po2-resin-hdpe-pp", supplierName: "ZimPlast Resins (Pvt) Ltd", requestedDeliveryDaysAgo: 33, target: "received",
      lines: [{ sku: "RM-HDPE-VIRGIN", quantity: 3000, unitPrice: 1.05 }, { sku: "RM-PP-VIRGIN", quantity: 2000, unitPrice: 1.10 }] },
    { key: "po3-masterbatch", supplierName: "ColorTech Zimbabwe", requestedDeliveryDaysAgo: 30, target: "received",
      lines: [{ sku: "RM-MB-WHITE", quantity: 150, unitPrice: 3.20 }, { sku: "RM-MB-BLUE", quantity: 80, unitPrice: 3.50 }, { sku: "RM-ADD-UV", quantity: 40, unitPrice: 6.80 }] },
    { key: "po4-packaging", supplierName: "Harare Packaging Supplies", requestedDeliveryDaysAgo: 28, target: "received",
      lines: [{ sku: "CS-TRAY-STD", quantity: 1000, unitPrice: 0.65 }, { sku: "CS-STRETCHWRAP", quantity: 150, unitPrice: 2.40 }] },
    { key: "po5-spares", supplierName: "Industrial Spares Zimbabwe", requestedDeliveryDaysAgo: 20, target: "partially_received",
      lines: [{ sku: "SP-EJECTOR-PIN", quantity: 20, unitPrice: 45 }, { sku: "SP-SCREW-BARREL", quantity: 3, unitPrice: 380 }],
      partialFractions: { "SP-EJECTOR-PIN": 1, "SP-SCREW-BARREL": 1 / 3 } },
    { key: "po6-resin-pet-2", supplierName: "Harare Polymers (Pvt) Ltd", requestedDeliveryDaysAgo: 5, target: "confirmed",
      lines: [{ sku: "RM-PET-VIRGIN", quantity: 2000, unitPrice: 1.18 }] },
    { key: "po7-resin-pp-draft", supplierName: "ZimPlast Resins (Pvt) Ltd", requestedDeliveryDaysAgo: -5, target: "draft",
      lines: [{ sku: "RM-PP-VIRGIN", quantity: 1000, unitPrice: 1.12 }] },
    { key: "po8-spares-bulawayo", supplierName: "Bulawayo Engineering Spares", requestedDeliveryDaysAgo: 22, target: "closed",
      lines: [{ sku: "SP-EJECTOR-PIN", quantity: 10, unitPrice: 48 }] },
  ];

  for (const spec of specs) {
    const clientKey = `po:${spec.key}`;
    // Found by a fixed marker we control: supplierReference carries the spec key, which is otherwise free text.
    const existing = await prisma.purchaseOrder.findFirst({ where: { orgId: purchasing.orgId, supplierReference: clientKey }, include: { lines: true } });
    let po: { id: string; status: string; lines: { id: string; itemId: string; quantity: unknown }[] };
    if (existing) {
      bump(report, "purchase orders", false);
      po = existing as typeof po;
    } else {
      const created = (await createPurchaseOrder(purchasing, {
        branchId,
        supplierId: supplierIds.get(spec.supplierName)!,
        currency: "USD",
        requestedDeliveryDate: day(-spec.requestedDeliveryDaysAgo),
        supplierReference: clientKey,
        notes: `Mavuno Packaging demo data (synthetic).`,
        lines: spec.lines.map((l) => ({ itemId: itemIds.get(l.sku)!, quantity: l.quantity, uom: "kg", unitPrice: l.unitPrice })),
      })) as { id: string; status: string; lines: { id: string; itemId: string; quantity: unknown }[] };
      po = created;
      bump(report, "purchase orders", true);
      log(`PO ${spec.key} -> ${spec.supplierName}`);
    }
    if (spec.target === "draft") continue;

    if (po.status === "draft") {
      await confirmPurchaseOrder(owner, po.id);
      po.status = "confirmed";
    }
    if (spec.target === "confirmed") continue;

    // Receive: full unless partialFractions says otherwise.
    const alreadyReceived = await prisma.goodsReceipt.findFirst({ where: { orgId: purchasing.orgId, poId: po.id } });
    if (!alreadyReceived) {
      const lines = spec.lines.map((l) => {
        const poLine = po.lines.find((pl) => pl.itemId === itemIds.get(l.sku))!;
        const fraction = spec.partialFractions?.[l.sku] ?? 1;
        const acceptedQty = Math.round(l.quantity * fraction * 10000) / 10000;
        return { poLineId: poLine.id, warehouseId: rawMaterialWarehouseId, receivedQty: acceptedQty, acceptedQty, rejectedQty: 0 };
      });
      await receiveGoodsForPurchaseOrder(warehouse, po.id, {
        clientRequestId: demoUuid(clientKey + ":receipt"),
        deliveryReference: `DN-${spec.key.toUpperCase()}`,
        receivedAt: at(-(spec.requestedDeliveryDaysAgo - 3)),
        notes: "Mavuno Packaging demo data (synthetic).",
        lines,
      });
      bump(report, "goods receipts", true);
      log(`goods receipt ${spec.key}`);
    } else {
      bump(report, "goods receipts", false);
    }
    if (spec.target === "partially_received" || spec.target === "received") continue;

    if (spec.target === "closed") {
      const fresh = await prisma.purchaseOrder.findFirst({ where: { orgId: purchasing.orgId, id: po.id } });
      if (fresh && fresh.status !== "closed") {
        await closePurchaseOrder(purchasing, po.id, { reason: "Order fully received and reconciled; closing out per month-end procurement review." });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sales orders.
// ---------------------------------------------------------------------------
interface SoSpec { key: string; customerName: string; sku: string; quantity: number; unitPrice: number; target: "draft" | "confirmed" | "cancelled" | "fulfil_later" }
async function ensureSalesOrders(
  sales: AuthenticatedSession,
  branchId: string,
  customerIds: Map<string, string>,
  itemIds: Map<string, string>,
  report: SeedReport,
  log: (m: string) => void,
): Promise<Map<string, { orderId: string; lineId: string }>> {
  const specs: SoSpec[] = [
    { key: "so1-bottler-2l", customerName: "Delta Beverages Bottling (Pvt) Ltd", sku: "FG-PET-BTL-2000", quantity: 1730, unitPrice: 0.285, target: "fulfil_later" },
    { key: "so2-water-500", customerName: "Highveld Pure Water Co.", sku: "FG-PET-BTL-500", quantity: 10000, unitPrice: 0.095, target: "draft" },
    { key: "so3-detergent-500", customerName: "Sunshine Home Care Products", sku: "FG-HDPE-BTL-500D", quantity: 19700, unitPrice: 0.145, target: "fulfil_later" },
    { key: "so4-food-caps28", customerName: "Mukuru Foods Processing", sku: "FG-PP-CAP-28", quantity: 100000, unitPrice: 0.018, target: "confirmed" },
    { key: "so5-personal-care-flip", customerName: "Zambezi Personal Care Ltd", sku: "FG-PP-CAP-FLIP", quantity: 15000, unitPrice: 0.042, target: "cancelled" },
    { key: "so6-agrichem-jc", customerName: "Great Dyke Agro-Chemicals", sku: "FG-HDPE-JC-5000", quantity: 2000, unitPrice: 0.78, target: "draft" },
  ];

  const result = new Map<string, { orderId: string; lineId: string }>();
  for (const spec of specs) {
    // createSalesOrder's schema (sales-order-service.ts's createSchema) has
    // no header-level free-text field to stash a business key in, so this
    // order is instead found deterministically by its actual business
    // shape: this customer's order for this exact item/quantity/price. Safe
    // because no two specs below share a (customer, item, quantity) triple.
    const existing = await prisma.salesOrder.findFirst({
      where: { orgId: sales.orgId, customerId: customerIds.get(spec.customerName)!, lines: { some: { itemId: itemIds.get(spec.sku)!, quantity: spec.quantity as unknown as number } } },
      include: { lines: true },
    });
    let so: { id: string; status: string; lines: { id: string; itemId: string }[] };
    if (existing) {
      bump(report, "sales orders", false);
      so = existing as typeof so;
    } else {
      const created = (await createSalesOrder(sales, {
        branchId,
        customerId: customerIds.get(spec.customerName)!,
        currency: "USD",
        requestedDeliveryDate: day(10),
        lines: [{ itemId: itemIds.get(spec.sku)!, quantity: spec.quantity, unitPrice: spec.unitPrice }],
      })) as unknown as { id: string; status: string; lines: { id: string; itemId: string }[] };
      so = created;
      bump(report, "sales orders", true);
      log(`sales order ${spec.key} -> ${spec.customerName}`);
    }
    result.set(spec.key, { orderId: so.id, lineId: so.lines[0]!.id });

    if (spec.target === "draft") continue;
    if (so.status === "draft") {
      await confirmSalesOrder(sales, so.id);
      so.status = "confirmed";
    }
    if (spec.target === "cancelled" && so.status !== "cancelled") {
      await cancelSalesOrder(sales, so.id, { reason: "Customer changed the closure's neck-size specification before production started." });
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Production jobs and the rest of the transaction chain: material issue,
// labour, plastics process detail, output, inspection, disposition, job
// completion, regrind, finished-goods receipt, warehouse transfer, dispatch
// and delivery confirmation. Covers all 5 named demo scenarios:
//   A - PET bottle manufacturing end to end        (jobs A1 -> A2, preform then bottle)
//   B - injection-moulded PP closures, cavity/QC   (jobs B1 completed, B2 left in_progress)
//   C - HDPE detergent bottle via blow moulding    (job C1)
//   D - scrap/regrind reuse with cost/lot genealogy (A2's scrap -> regrind -> consumed in A3)
//   E - customer fulfilment: SO -> job -> FG -> partial dispatch -> delivery (SO1 via A2; SO3 via C1)
// ---------------------------------------------------------------------------
interface JobsCtx {
  sessions: Record<string, AuthenticatedSession>;
  branchId: string;
  itemIds: Map<string, string>;
  warehouseIds: Map<string, string>;
  workCentreIds: Map<string, string>;
  machineIds: Map<string, string>;
  mouldIds: Map<string, string>;
  inspectionPlans: Map<string, { planId: string; characteristics: Map<string, string> }>;
  soLines: Map<string, { orderId: string; lineId: string }>;
  report: SeedReport;
  log: (m: string) => void;
}

async function findJobByBusinessKey(orgId: string, productItemId: string, plannedQty: number) {
  return prisma.productionJob.findFirst({ where: { orgId, productItemId, plannedQty } });
}

/** Job A1: PET preform 2L, BOM v1 (virgin only), make-to-stock. No inspection -- preforms are checked downstream at the bottle stage. */
async function seedJobA1(c: JobsCtx): Promise<void> {
  const productId = c.itemIds.get("WIP-PET-PFM-2L")!;
  const plannedQty = 2000;
  const existing = await findJobByBusinessKey(c.sessions.owner!.orgId, productId, plannedQty);
  if (existing) { bump(c.report, "jobs", false); return; }

  const pm = c.sessions.production!, op = c.sessions.operator!, sup = c.sessions.supervisor!;
  const job = (await createJob(pm, {
    branchId: c.branchId, productItemId: productId, plannedQty, priority: "normal",
    plannedStart: day(-18), plannedEnd: day(-16),
  })) as { id: string; jobNumber: string };
  const id = (k: string) => demoUuid(`jobA1:${k}`);

  const st = (await defineStages(pm, job.id, {
    stages: [{ name: "Injection Moulding", workCentreId: c.workCentreIds.get("WC-INJ"), machineId: c.machineIds.get("INJ-01"), expectedSetupMinutes: 30, expectedRunMinutes: 240, requiresInspection: false }],
  })).stages;
  await transitionJob(pm, job.id, { status: "released" });
  await issueMaterialToJob(op, job.id, { clientRequestId: id("issue:pet"), materialItemId: c.itemIds.get("RM-PET-VIRGIN"), warehouseId: c.warehouseIds.get("Raw Materials Warehouse"), quantity: 90 });
  await recordLabour(op, job.id, { clientRequestId: id("labour"), jobStageId: st[0]!.id, hours: 8, rate: 3.8, rateCurrency: "USD" });
  await transitionStage(sup, job.id, st[0]!.id, { action: "start" });
  await setPlasticsProcessDetail(op, st[0]!.id, { processType: "injection_moulding", mouldId: c.mouldIds.get("MLD-PFM-2L"), targetCycleTimeSeconds: 16, actualCycleTimeSeconds: 17.4, totalCavities: 4, goodCavities: 4 });
  await recordOutput(op, job.id, { clientRequestId: id("output"), jobStageId: st[0]!.id, goodQty: 1960, scrapQty: 40, reason: "other", notes: "Short shots during start-of-run warm-up; discarded." });
  await transitionStage(sup, job.id, st[0]!.id, { action: "complete" });
  await completeJob(pm, job.id);
  await receiveFinishedGoods(pm, job.id, { clientRequestId: id("fg"), warehouseId: c.warehouseIds.get("Production WIP Store"), quantity: 1960, disposition: "available", occurredAt: at(-16), qualityNotes: "2L PET preforms, virgin resin (BOM v1), ready for blow moulding." });
  bump(c.report, "jobs", true);
  c.log(`job ${job.jobNumber} (A1: PET 2L preforms, virgin)`);
}

/** Job A2: PET bottle 2L, consumes A1's preforms, linked to SO1 (Scenario E). Scrap and QA-rejected units feed Scenario D's regrind. */
async function seedJobA2(c: JobsCtx): Promise<string> {
  const productId = c.itemIds.get("FG-PET-BTL-2000")!;
  // Must equal SO1's own line quantity exactly: createJob (job-service.ts)
  // enforces `line.quantity === plannedQty` for any job linked via
  // salesOrderLineId -- confirmed by an actual run against a real database,
  // which rejected the previous value of 1800 with "Planned quantity must
  // equal the order line quantity (1730)". This is a genuine, deliberate
  // validation in the real application, not something to work around:
  // changed here, not in job-service.ts. The job still finishes with a
  // real overage (1,800 total output against a 1,730 plan -- output-
  // service.ts's own `exceedsPlan` flag is informational, not a block,
  // "some over-run is normal (remakes for scrap)") rather than a fabricated
  // exact match.
  const plannedQty = 1730;
  const existing = await findJobByBusinessKey(c.sessions.owner!.orgId, productId, plannedQty);
  if (existing) { bump(c.report, "jobs", false); return existing.id; }

  const pm = c.sessions.production!, op = c.sessions.operator!, sup = c.sessions.supervisor!, qa = c.sessions.quality!;
  const so1 = c.soLines.get("so1-bottler-2l")!;
  const job = (await createJob(pm, {
    branchId: c.branchId, productItemId: productId, plannedQty, priority: "high",
    salesOrderLineId: so1.lineId, plannedStart: day(-15), plannedEnd: day(-12),
  })) as { id: string; jobNumber: string };
  const id = (k: string) => demoUuid(`jobA2:${k}`);

  const st = (await defineStages(pm, job.id, {
    stages: [{ name: "Blow Moulding", workCentreId: c.workCentreIds.get("WC-BLOW"), machineId: c.machineIds.get("ISBM-01"), expectedSetupMinutes: 20, expectedRunMinutes: 200, requiresInspection: true }],
  })).stages;
  await transitionJob(pm, job.id, { status: "released" });
  await issueMaterialToJob(op, job.id, { clientRequestId: id("issue:preform"), materialItemId: c.itemIds.get("WIP-PET-PFM-2L"), warehouseId: c.warehouseIds.get("Production WIP Store"), quantity: 1830 });
  await recordLabour(op, job.id, { clientRequestId: id("labour"), jobStageId: st[0]!.id, hours: 10, rate: 3.8, rateCurrency: "USD" });
  await transitionStage(sup, job.id, st[0]!.id, { action: "start" });
  await setPlasticsProcessDetail(op, st[0]!.id, { processType: "stretch_blow_moulding", mouldId: c.mouldIds.get("MLD-BTL-2L"), targetCycleTimeSeconds: 7, actualCycleTimeSeconds: 7.6, totalCavities: 1, goodCavities: 1 });
  await recordOutput(op, job.id, { clientRequestId: id("output"), jobStageId: st[0]!.id, goodQty: 1750, scrapQty: 50, reason: "other", notes: "Neck deformation on a run of bottles during blow-moulding pressure ramp-up." });

  const plan = c.inspectionPlans.get("PET Bottle 2L Finished-Good Inspection")!;
  const { inspection } = (await recordInspection(qa, job.id, {
    clientRequestId: id("inspection"), jobStageId: st[0]!.id, inspectedQty: 1750, rejectedQty: 20, rejectReason: "wrong_dimensions",
    notes: "20 bottles below minimum base wall thickness.", inspectionPlanId: plan.planId,
    measurements: [
      { characteristicId: plan.characteristics.get("Bottle Weight")!, measuredValue: 41.8 },
      { characteristicId: plan.characteristics.get("Wall Thickness (Base)")!, measuredValue: 0.26 },
      { characteristicId: plan.characteristics.get("Top-Load Strength")!, measuredValue: 128 },
    ],
  })) as unknown as { inspection: { id: string } };
  await recordDisposition(pm, job.id, inspection.id, { clientRequestId: id("disposition"), kind: "scrap", qty: 20, reason: "Wall thickness below the 0.28mm minimum; scrapped per QA review, routed to regrind." });
  await transitionStage(sup, job.id, st[0]!.id, { action: "complete" });
  await completeJob(pm, job.id);
  await receiveFinishedGoods(pm, job.id, { clientRequestId: id("fg"), warehouseId: c.warehouseIds.get("Finished Goods Warehouse"), quantity: 1730, disposition: "available", occurredAt: at(-12), qualityNotes: "2L PET bottles for Delta Beverages Bottling (Sales Order so1); QA-cleared, excludes 20 units scrapped at inspection." });
  bump(c.report, "jobs", true);
  c.log(`job ${job.jobNumber} (A2: PET 2L bottles, SO1)`);
  return job.id;
}

/** Regrind: Job A2's blow-moulding scrap (50 units) and QA-scrapped rejects (20 units) ground back into a MaterialLot of the SAME item (RM-PET-VIRGIN) it came from -- the regrind-service.ts design this demo must respect. */
async function seedRegrindFromA2(c: JobsCtx, jobA2Id: string): Promise<number> {
  const existing = await prisma.materialLot.findFirst({ where: { orgId: c.sessions.owner!.orgId, itemId: c.itemIds.get("RM-PET-VIRGIN"), warehouseId: c.warehouseIds.get("Regrind and Recycled Materials Store") } });
  if (existing) {
    bump(c.report, "regrind lots", false);
    return Number(existing.quantityReceived);
  }
  const quantityKg = 70 * 0.0416; // (50 scrap + 20 QA-scrapped) x 2L bottle unit weight, ground back to resin equivalent
  const quantity = Math.round(quantityKg * 100) / 100;
  await createRegrindLot(c.sessions.warehouse!, {
    clientRequestId: demoUuid("regrind:jobA2"),
    sourceJobId: jobA2Id,
    itemId: c.itemIds.get("RM-PET-VIRGIN"),
    warehouseId: c.warehouseIds.get("Regrind and Recycled Materials Store"),
    quantity,
    unitCost: 0.70,
    currency: "USD",
  });
  bump(c.report, "regrind lots", true);
  c.log(`regrind lot from Job A2 scrap (${quantity} kg, same item as virgin PET)`);
  return quantity;
}

/** Job A3: PET preform 2L again, now under BOM v2 (virgin/rPET blend), consuming virgin resin, approved rPET, AND the Job A2 regrind lot -- real, controlled regrind reuse with cost/lot genealogy intact (Scenario D). */
async function seedJobA3(c: JobsCtx, regrindQty: number): Promise<void> {
  const productId = c.itemIds.get("WIP-PET-PFM-2L")!;
  const plannedQty = 2500;
  const existing = await findJobByBusinessKey(c.sessions.owner!.orgId, productId, plannedQty);
  if (existing) { bump(c.report, "jobs", false); return; }

  const pm = c.sessions.production!, op = c.sessions.operator!, sup = c.sessions.supervisor!;
  const job = (await createJob(pm, {
    branchId: c.branchId, productItemId: productId, plannedQty, priority: "normal",
    plannedStart: day(-9), plannedEnd: day(-7),
  })) as { id: string; jobNumber: string };
  const id = (k: string) => demoUuid(`jobA3:${k}`);

  const st = (await defineStages(pm, job.id, {
    stages: [{ name: "Injection Moulding", workCentreId: c.workCentreIds.get("WC-INJ"), machineId: c.machineIds.get("INJ-02"), expectedSetupMinutes: 35, expectedRunMinutes: 260, requiresInspection: false }],
  })).stages;
  await transitionJob(pm, job.id, { status: "released" });
  await issueMaterialToJob(op, job.id, { clientRequestId: id("issue:pet"), materialItemId: c.itemIds.get("RM-PET-VIRGIN"), warehouseId: c.warehouseIds.get("Raw Materials Warehouse"), quantity: 76 });
  await issueMaterialToJob(op, job.id, { clientRequestId: id("issue:rpet"), materialItemId: c.itemIds.get("RM-RPET-APPROVED"), warehouseId: c.warehouseIds.get("Raw Materials Warehouse"), quantity: 33 });
  await issueMaterialToJob(op, job.id, { clientRequestId: id("issue:regrind"), materialItemId: c.itemIds.get("RM-PET-VIRGIN"), warehouseId: c.warehouseIds.get("Regrind and Recycled Materials Store"), quantity: regrindQty });
  await recordLabour(op, job.id, { clientRequestId: id("labour"), jobStageId: st[0]!.id, hours: 9, rate: 3.8, rateCurrency: "USD" });
  await transitionStage(sup, job.id, st[0]!.id, { action: "start" });
  await setPlasticsProcessDetail(op, st[0]!.id, { processType: "injection_moulding", mouldId: c.mouldIds.get("MLD-PFM-2L"), targetCycleTimeSeconds: 16, actualCycleTimeSeconds: 16.9, totalCavities: 4, goodCavities: 4 });
  await recordOutput(op, job.id, { clientRequestId: id("output"), jobStageId: st[0]!.id, goodQty: 2450, scrapQty: 50, reason: "other", notes: "Purge material at blend changeover from the previous virgin-only run." });
  await transitionStage(sup, job.id, st[0]!.id, { action: "complete" });
  await completeJob(pm, job.id);
  await receiveFinishedGoods(pm, job.id, { clientRequestId: id("fg"), warehouseId: c.warehouseIds.get("Production WIP Store"), quantity: 2450, disposition: "available", occurredAt: at(-7), qualityNotes: "2L PET preforms, virgin/rPET blend (BOM v2) with regrind reuse from Job A2's scrap." });
  bump(c.report, "jobs", true);
  c.log(`job ${job.jobNumber} (A3: PET 2L preforms, rPET + regrind blend, Scenario D)`);
}

/** Job B1: PP closure 28mm, high-cavity injection run with cavity-level detail and measured QC (Scenario B). A portion of the rejects is reworked rather than scrapped, for variety. */
async function seedJobB1(c: JobsCtx): Promise<void> {
  const productId = c.itemIds.get("FG-PP-CAP-28")!;
  const plannedQty = 50000;
  const orgId = c.sessions.owner!.orgId;
  const existing = await findJobByBusinessKey(orgId, productId, plannedQty);
  const pm = c.sessions.production!, op = c.sessions.operator!, sup = c.sessions.supervisor!, qa = c.sessions.quality!;

  if (existing) {
    if (existing.status === "completed") { bump(c.report, "jobs", false); return; }
    // Resume path, not a fresh create: an earlier run reached the
    // "rework" disposition below and then crashed before closing the
    // rework loop -- confirmed by an actual run: "Stage can't be
    // completed yet: 300 unit(s) are still in rework at 'Injection
    // Moulding'." findJobByBusinessKey only checks for existence, so
    // without this branch every later rerun would see this job, assume
    // it's done, and skip it forever -- silently leaving the real row
    // stuck in_progress/overdue. Finish it against the SAME job/stage
    // ids instead of creating a second job. Every sub-step is safe to
    // repeat: recordOutput/recordInspection/receiveFinishedGoods are each
    // idempotent by clientRequestId (same pattern as everywhere else in
    // this file), and transitionStage/completeJob are guarded by an
    // explicit status check first, since calling either on an
    // already-completed stage/job throws a ConflictError rather than
    // being a no-op.
    const job = { id: existing.id, jobNumber: existing.jobNumber };
    const stage = await prisma.productionJobStage.findFirst({ where: { orgId, jobId: job.id, stageName: "Injection Moulding" } });
    if (!stage) throw new Error(`Job B1 (${job.jobNumber}) exists but its "Injection Moulding" stage could not be found; this needs manual review.`);
    const id = (k: string) => demoUuid(`jobB1:${k}`);

    if (stage.status !== "completed") {
      await recordOutput(op, job.id, {
        clientRequestId: id("output:rework-returned"), jobStageId: stage.id,
        goodQty: 300, reworkGoodQty: 300,
        notes: "300 closures returned from gate-flash trim/rework; all recovered as good.",
      });
      await recordInspection(qa, job.id, {
        clientRequestId: id("inspection:rework-returned"), jobStageId: stage.id,
        inspectedQty: 300, rejectedQty: 0,
        notes: "Reworked batch (gate-flash trim) re-inspected after return; full pass.",
      });
      await transitionStage(sup, job.id, stage.id, { action: "complete" });
    }
    const jobNow = await prisma.productionJob.findFirst({ where: { orgId, id: job.id }, select: { status: true } });
    if (jobNow?.status !== "completed") await completeJob(pm, job.id);
    await receiveFinishedGoods(pm, job.id, { clientRequestId: id("fg"), warehouseId: c.warehouseIds.get("Finished Goods Warehouse"), quantity: 48500, disposition: "available", occurredAt: at(-10), qualityNotes: "PP 28mm closures, QA-cleared, including 300 units that passed after rework (gate-flash trim)." });
    bump(c.report, "jobs", true);
    c.log(`job ${job.jobNumber} (B1: PP 28mm closures, Scenario B) -- resumed and completed a previously interrupted run`);
    return;
  }

  const job = (await createJob(pm, {
    branchId: c.branchId, productItemId: productId, plannedQty, priority: "normal",
    plannedStart: day(-11), plannedEnd: day(-10),
  })) as { id: string; jobNumber: string };
  const id = (k: string) => demoUuid(`jobB1:${k}`);

  const st = (await defineStages(pm, job.id, {
    stages: [{ name: "Injection Moulding", workCentreId: c.workCentreIds.get("WC-INJ"), machineId: c.machineIds.get("INJ-02"), expectedSetupMinutes: 25, expectedRunMinutes: 300, requiresInspection: true }],
  })).stages;
  await transitionJob(pm, job.id, { status: "released" });
  await issueMaterialToJob(op, job.id, { clientRequestId: id("issue"), materialItemId: c.itemIds.get("RM-PP-VIRGIN"), warehouseId: c.warehouseIds.get("Raw Materials Warehouse"), quantity: 92 });
  await recordLabour(op, job.id, { clientRequestId: id("labour"), jobStageId: st[0]!.id, hours: 12, rate: 3.8, rateCurrency: "USD" });
  await transitionStage(sup, job.id, st[0]!.id, { action: "start" });
  await setPlasticsProcessDetail(op, st[0]!.id, { processType: "injection_moulding", mouldId: c.mouldIds.get("MLD-CAP-28"), targetCycleTimeSeconds: 12, actualCycleTimeSeconds: 12.8, totalCavities: 16, goodCavities: 15 });
  await recordOutput(op, job.id, { clientRequestId: id("output"), jobStageId: st[0]!.id, goodQty: 48500, scrapQty: 1500, reason: "wrong_dimensions", notes: "Cavity 7 producing undersized caps; flagged for mould maintenance." });

  const plan = c.inspectionPlans.get("PP Closure 28mm Finished-Good Inspection")!;
  const { inspection } = (await recordInspection(qa, job.id, {
    clientRequestId: id("inspection"), jobStageId: st[0]!.id, inspectedQty: 48500, rejectedQty: 300, rejectReason: "wrong_dimensions",
    notes: "300 closures with light flash at the gate.", inspectionPlanId: plan.planId,
    measurements: [
      { characteristicId: plan.characteristics.get("Closure Weight")!, measuredValue: 1.82 },
      { characteristicId: plan.characteristics.get("Removal Torque")!, measuredValue: 12.6 },
    ],
  })) as unknown as { inspection: { id: string } };
  await recordDisposition(pm, job.id, inspection.id, { clientRequestId: id("disposition"), kind: "rework", qty: 300, reason: "Light gate flash; trimmed and reworked rather than scrapped." });
  // A "rework" disposition only opens a tracked rework quantity (shopfloor-
  // math.ts's reworkOpen) -- it does not, by itself, resolve it, and a stage
  // can't be completed while any is still open (confirmed by an actual run:
  // "Stage can't be completed yet: 300 unit(s) are still in rework"). Close
  // the loop the same way a real operator would: the trimmed units come back
  // from rework, recorded as their own output entry (goodQty with a matching
  // reworkGoodQty, per output-service.ts's own "rework_good <= good" rule),
  // then re-inspected -- this stage requires inspection, so the newly
  // returned good units need their own inspection record too, or the stage's
  // "good units not yet inspected" blocker would simply trade one block for
  // another.
  await recordOutput(op, job.id, {
    clientRequestId: id("output:rework-returned"), jobStageId: st[0]!.id,
    goodQty: 300, reworkGoodQty: 300,
    notes: "300 closures returned from gate-flash trim/rework; all recovered as good.",
  });
  await recordInspection(qa, job.id, {
    clientRequestId: id("inspection:rework-returned"), jobStageId: st[0]!.id,
    inspectedQty: 300, rejectedQty: 0,
    notes: "Reworked batch (gate-flash trim) re-inspected after return; full pass.",
  });
  await transitionStage(sup, job.id, st[0]!.id, { action: "complete" });
  await completeJob(pm, job.id);
  // effectiveGood is now 48,500 (48,500 + 300 recovered-from-rework, minus
  // the 300 the disposition reclassified out of "good" when it sent them to
  // rework -- shopfloor-math.ts's own formula) -- i.e. the full run's good
  // output nets out once the reworked units are confirmed recovered, not
  // 48,200. receiveFinishedGoods's own bound is this effectiveGood figure.
  await receiveFinishedGoods(pm, job.id, { clientRequestId: id("fg"), warehouseId: c.warehouseIds.get("Finished Goods Warehouse"), quantity: 48500, disposition: "available", occurredAt: at(-10), qualityNotes: "PP 28mm closures, QA-cleared, including 300 units that passed after rework (gate-flash trim)." });
  bump(c.report, "jobs", true);
  c.log(`job ${job.jobNumber} (B1: PP 28mm closures, Scenario B)`);
}

/** Job B2: PP closure 38mm, deliberately LEFT in_progress with an inspection failure still awaiting the Production Manager's disposition decision -- a real, live pending-decision state for the demo (mirrors seed-dev.ts's own J2 pattern). */
async function seedJobB2(c: JobsCtx): Promise<void> {
  const productId = c.itemIds.get("FG-PP-CAP-38")!;
  const plannedQty = 20000;
  const existing = await findJobByBusinessKey(c.sessions.owner!.orgId, productId, plannedQty);
  if (existing) { bump(c.report, "jobs", false); return; }

  const pm = c.sessions.production!, op = c.sessions.operator!, sup = c.sessions.supervisor!, qa = c.sessions.quality!;
  const job = (await createJob(pm, {
    branchId: c.branchId, productItemId: productId, plannedQty, priority: "urgent",
    plannedStart: day(-2), plannedEnd: day(2),
  })) as { id: string; jobNumber: string };
  const id = (k: string) => demoUuid(`jobB2:${k}`);

  const st = (await defineStages(pm, job.id, {
    stages: [{ name: "Injection Moulding", workCentreId: c.workCentreIds.get("WC-INJ"), machineId: c.machineIds.get("INJ-01"), expectedSetupMinutes: 25, expectedRunMinutes: 150, requiresInspection: true }],
  })).stages;
  await transitionJob(pm, job.id, { status: "released" });
  await issueMaterialToJob(op, job.id, { clientRequestId: id("issue"), materialItemId: c.itemIds.get("RM-PP-VIRGIN"), warehouseId: c.warehouseIds.get("Raw Materials Warehouse"), quantity: 54 });
  await recordLabour(op, job.id, { clientRequestId: id("labour"), jobStageId: st[0]!.id, hours: 6, rate: 3.8, rateCurrency: "USD" });
  await transitionStage(sup, job.id, st[0]!.id, { action: "start" });
  await setPlasticsProcessDetail(op, st[0]!.id, { processType: "injection_moulding", mouldId: c.mouldIds.get("MLD-CAP-38"), targetCycleTimeSeconds: 13, actualCycleTimeSeconds: 13.5, totalCavities: 16, goodCavities: 16 });
  await recordOutput(op, job.id, { clientRequestId: id("output"), jobStageId: st[0]!.id, goodQty: 19600, scrapQty: 400, reason: "wrong_dimensions", notes: "Early-cycle rejects before the process stabilised." });
  await recordInspection(qa, job.id, {
    clientRequestId: id("inspection"), jobStageId: st[0]!.id, inspectedQty: 19600, rejectedQty: 150, rejectReason: "wrong_dimensions",
    notes: "150 closures with an undersized sealing lip -- awaiting the Production Manager's disposition decision.",
  });
  // Deliberately no disposition, no stage completion, no job completion: this
  // stays "in_progress" with an open ("failed_open") inspection, a real
  // pending decision visible in the demo rather than a synthetic one.
  bump(c.report, "jobs", true);
  c.log(`job ${job.jobNumber} (B2: PP 38mm closures, left in_progress awaiting QA disposition)`);
}

/** Job C1: HDPE detergent bottle 500ml via extrusion blow moulding, linked to SO3 (Scenario C + E). A clean inspection pass, for status variation against A2/B1's rejects. */
async function seedJobC1(c: JobsCtx): Promise<string> {
  const productId = c.itemIds.get("FG-HDPE-BTL-500D")!;
  const plannedQty = 19700;
  const existing = await findJobByBusinessKey(c.sessions.owner!.orgId, productId, plannedQty);
  if (existing) { bump(c.report, "jobs", false); return existing.id; }

  const pm = c.sessions.production!, op = c.sessions.operator!, sup = c.sessions.supervisor!, qa = c.sessions.quality!;
  const so3 = c.soLines.get("so3-detergent-500")!;
  const job = (await createJob(pm, {
    branchId: c.branchId, productItemId: productId, plannedQty, priority: "high",
    salesOrderLineId: so3.lineId, plannedStart: day(-6), plannedEnd: day(-4),
  })) as { id: string; jobNumber: string };
  const id = (k: string) => demoUuid(`jobC1:${k}`);

  const st = (await defineStages(pm, job.id, {
    stages: [{ name: "Blow Moulding", workCentreId: c.workCentreIds.get("WC-BLOW"), machineId: c.machineIds.get("EBM-01"), expectedSetupMinutes: 25, expectedRunMinutes: 220, requiresInspection: true }],
  })).stages;
  await transitionJob(pm, job.id, { status: "released" });
  await issueMaterialToJob(op, job.id, { clientRequestId: id("issue:hdpe"), materialItemId: c.itemIds.get("RM-HDPE-VIRGIN"), warehouseId: c.warehouseIds.get("Raw Materials Warehouse"), quantity: 565 });
  await issueMaterialToJob(op, job.id, { clientRequestId: id("issue:mb"), materialItemId: c.itemIds.get("RM-MB-WHITE"), warehouseId: c.warehouseIds.get("Raw Materials Warehouse"), quantity: 12.5 });
  await recordLabour(op, job.id, { clientRequestId: id("labour"), jobStageId: st[0]!.id, hours: 14, rate: 3.8, rateCurrency: "USD" });
  await transitionStage(sup, job.id, st[0]!.id, { action: "start" });
  await setPlasticsProcessDetail(op, st[0]!.id, { processType: "extrusion_blow_moulding", mouldId: c.mouldIds.get("MLD-HDPE-500D"), targetCycleTimeSeconds: 18, actualCycleTimeSeconds: 19.2, totalCavities: 2, goodCavities: 2 });
  await recordOutput(op, job.id, { clientRequestId: id("output"), jobStageId: st[0]!.id, goodQty: 19700, scrapQty: 300, reason: "damaged", notes: "Weld-line flash tearing during trimming." });
  await recordInspection(qa, job.id, { clientRequestId: id("inspection"), jobStageId: st[0]!.id, inspectedQty: 19700, rejectedQty: 0, notes: "Full pass; no defects found." });
  await transitionStage(sup, job.id, st[0]!.id, { action: "complete" });
  await completeJob(pm, job.id);
  await receiveFinishedGoods(pm, job.id, { clientRequestId: id("fg"), warehouseId: c.warehouseIds.get("Finished Goods Warehouse"), quantity: 19700, disposition: "available", occurredAt: at(-4), qualityNotes: "HDPE 500ml detergent bottles for Sunshine Home Care Products (Sales Order so3); full QA pass." });
  bump(c.report, "jobs", true);
  c.log(`job ${job.jobNumber} (C1: HDPE 500ml detergent bottle, SO3, Scenario C)`);
  return job.id;
}

/** SO1 fulfilment (Scenario E): dispatch 1000 units from Harare, transfer the remaining 730 to the Bulawayo depot, dispatch the rest from there, confirm both deliveries. */
async function fulfilSo1(c: JobsCtx, jobA2Id: string): Promise<void> {
  const sales = c.sessions.sales!, warehouse = c.sessions.warehouse!;
  const so1 = c.soLines.get("so1-bottler-2l")!;
  const alreadyDispatched = await prisma.dispatchLine.findFirst({ where: { orgId: sales.orgId, salesOrderLineId: so1.lineId } });
  if (alreadyDispatched) { bump(c.report, "dispatches", false); bump(c.report, "dispatches", false); return; }

  const batch = await prisma.finishedGoodsBatch.findFirst({ where: { orgId: sales.orgId, jobId: jobA2Id } });
  if (!batch) throw new Error("Expected a finished-goods batch for Job A2 before fulfilling SO1");

  const { dispatch: d1 } = (await createDispatch(sales, so1.orderId, {
    clientRequestId: demoUuid("dispatch:so1:1"), warehouseId: c.warehouseIds.get("Finished Goods Warehouse"), dispatchedAt: at(-9),
    carrier: "Mavuno own fleet", trackingReference: "MVN-TRK-0001", notes: "First partial shipment to Delta Beverages Bottling.",
    lines: [{ salesOrderLineId: so1.lineId, quantity: 1000 }],
  })) as unknown as { dispatch: { id: string } };
  await confirmDelivery(sales, d1.id, { deliveredAt: at(-8), receivedBy: "D. Beverages Warehouse (Southerton)", deliveryNotes: "Received in good order." });
  bump(c.report, "dispatches", true);
  c.log("dispatch 1/2 for SO1 (1000 units, Harare -> Delta Beverages)");

  await transferBatch(warehouse, batch.id, { clientRequestId: demoUuid("transfer:so1"), destinationWarehouseId: c.warehouseIds.get("Bulawayo Finished Goods Store"), quantity: 730, notes: "Forwarding remaining SO1 balance via the Bulawayo depot." });
  c.log("transferred remaining 730 PET 2L bottles to Bulawayo Finished Goods Store");

  const { dispatch: d2 } = (await createDispatch(sales, so1.orderId, {
    clientRequestId: demoUuid("dispatch:so1:2"), warehouseId: c.warehouseIds.get("Bulawayo Finished Goods Store"), dispatchedAt: at(-6),
    carrier: "Mavuno own fleet", trackingReference: "MVN-TRK-0002", notes: "Second and final shipment to Delta Beverages Bottling, via Bulawayo.",
    lines: [{ salesOrderLineId: so1.lineId, quantity: 730 }],
  })) as unknown as { dispatch: { id: string } };
  await confirmDelivery(sales, d2.id, { deliveredAt: at(-5), receivedBy: "D. Beverages Warehouse (Southerton)", deliveryNotes: "Received in good order; order complete." });
  bump(c.report, "dispatches", true);
  c.log("dispatch 2/2 for SO1 (730 units, Bulawayo -> Delta Beverages; order now fully delivered)");
}

/** SO3 fulfilment: one full dispatch straight from Harare. */
async function fulfilSo3(c: JobsCtx): Promise<void> {
  const sales = c.sessions.sales!;
  const so3 = c.soLines.get("so3-detergent-500")!;
  const alreadyDispatched = await prisma.dispatchLine.findFirst({ where: { orgId: sales.orgId, salesOrderLineId: so3.lineId } });
  if (alreadyDispatched) { bump(c.report, "dispatches", false); return; }

  const { dispatch: d } = (await createDispatch(sales, so3.orderId, {
    clientRequestId: demoUuid("dispatch:so3"), warehouseId: c.warehouseIds.get("Finished Goods Warehouse"), dispatchedAt: at(-3),
    carrier: "Third-party courier (Swift Logistics)", trackingReference: "SWIFT-88213", notes: "Full shipment to Sunshine Home Care Products.",
    lines: [{ salesOrderLineId: so3.lineId, quantity: 19700 }],
  })) as unknown as { dispatch: { id: string } };
  await confirmDelivery(sales, d.id, { deliveredAt: at(-2), receivedBy: "Sunshine Home Care Receiving Bay", deliveryNotes: "Full quantity received, order complete." });
  bump(c.report, "dispatches", true);
  c.log("dispatch for SO3 (19700 units, Harare -> Sunshine Home Care; order now fully delivered)");
}

// ---------------------------------------------------------------------------
// Top-level orchestration.
// ---------------------------------------------------------------------------

/**
 * Read-only: reports whether the Mavuno organization already exists and, if
 * so, tallies what a real run would create vs. find (same idea as
 * seed-dev.ts's planDevSeed). If the organization does not exist yet, there
 * is nothing in the database to tally against, so this reports the full set
 * of master data a first run would create, computed from the data file
 * alone -- still a true dry run: nothing is written either way.
 */
export async function planMavunoSeed(): Promise<{ organizationExists: boolean; report: SeedReport }> {
  const org = await prisma.organization.findUnique({ where: { slug: ORG.slug } });
  const report = newReport();
  if (!org) {
    report.created["organization"] = 1;
    report.created["branches"] = 2;
    report.created["users"] = DEMO_USERS.length;
    report.created["work centres"] = WORK_CENTRES.length;
    report.created["machines"] = MACHINES.length;
    report.created["warehouses"] = WAREHOUSES_HARARE.length + WAREHOUSES_BULAWAYO.length;
    report.created["items"] = RAW_MATERIALS.length + PRODUCTS.length;
    report.created["BOMs"] = PRODUCTS.length;
    report.created["moulds"] = MOULDS.length;
    report.created["inspection plans"] = INSPECTION_PLANS.length;
    report.created["suppliers"] = SUPPLIERS.length;
    report.created["customers"] = CUSTOMERS.length;
    report.created["exchange-rate pairs"] = EXCHANGE_RATES.length;
    report.created["purchase orders"] = 8;
    report.created["sales orders"] = 6;
    report.created["jobs"] = 6;
    report.warnings.push("Organization does not exist yet -- these are the full counts a first apply would create, not a live tally.");
    return { organizationExists: false, report };
  }
  bump(report, "organization", false);
  const u = await prisma.user.count({ where: { orgId: org.id, email: { in: DEMO_USERS.map((x) => x.email) } } });
  if (u) report.existing["users"] = u;
  const items = await prisma.item.count({ where: { orgId: org.id, sku: { in: [...RAW_MATERIALS.map((m) => m.sku), ...PRODUCTS.map((p) => p.sku)] } } });
  if (items) report.existing["items"] = items;
  const suppliers = await prisma.supplier.count({ where: { orgId: org.id, name: { in: SUPPLIERS.map((s) => s.name) } } });
  if (suppliers) report.existing["suppliers"] = suppliers;
  const customers = await prisma.customer.count({ where: { orgId: org.id, name: { in: CUSTOMERS.map((c) => c.name) } } });
  if (customers) report.existing["customers"] = customers;
  const jobs = await prisma.productionJob.count({ where: { orgId: org.id } });
  if (jobs) report.existing["jobs (organization total, not just this demo's)"] = jobs;
  return { organizationExists: true, report };
}

export async function seedMavunoDemo(opts: SeedDemoOptions): Promise<SeedDemoResult> {
  const log = opts.log ?? (() => undefined);
  const report = newReport();
  if (opts.ownerPassword.length < 12) throw new Error("ownerPassword must be at least 12 characters.");
  if (opts.userPassword.length < 12) throw new Error("userPassword must be at least 12 characters.");
  await assertCurrencies();

  const owner = await ensureOrganizationAndOwner(opts.ownerPassword, report, log);
  await ensurePlasticsProfile(owner, report, log);
  const bulawayoBranchId = await ensureSecondBranch(owner, report, log);
  const hareBranchId = await prisma.branch.findFirstOrThrow({ where: { orgId: owner.orgId, name: ORG.firstBranchName } }).then((b) => b.id);

  const sessions = await ensureUsersAndSessions(owner, hareBranchId, bulawayoBranchId, opts.userPassword, report, log);
  const { workCentreIds, machineIds } = await ensureWorkCentresAndMachines(owner, hareBranchId, report, log);
  const warehouseIds = await ensureWarehouses(owner, hareBranchId, bulawayoBranchId, report, log);
  const itemIds = await ensureCatalog(owner, report, log);
  const mouldIds = await ensureMoulds(owner, hareBranchId, itemIds, machineIds, report, log);
  const inspectionPlans = await ensureInspectionPlans(owner, itemIds, report, log);
  const { supplierIds, customerIds } = await ensureSuppliersAndCustomers(sessions.purchasing!, sessions.sales!, report, log);
  await ensureExchangeRates(owner, report, log);
  await ensurePurchaseOrders(sessions.purchasing!, owner, sessions.warehouse!, hareBranchId, supplierIds, itemIds, warehouseIds.get("Raw Materials Warehouse")!, report, log);
  const soLines = await ensureSalesOrders(sessions.sales!, hareBranchId, customerIds, itemIds, report, log);

  const jobsCtx: JobsCtx = { sessions, branchId: hareBranchId, itemIds, warehouseIds, workCentreIds, machineIds, mouldIds, inspectionPlans, soLines, report, log };
  await seedJobA1(jobsCtx);
  const jobA2Id = await seedJobA2(jobsCtx);
  const regrindQty = await seedRegrindFromA2(jobsCtx, jobA2Id);
  await activatePreform2LBomV2(owner, itemIds, report, log);
  await seedJobA3(jobsCtx, regrindQty);
  await seedJobB1(jobsCtx);
  await seedJobB2(jobsCtx);
  await seedJobC1(jobsCtx);
  await fulfilSo1(jobsCtx, jobA2Id);
  await fulfilSo3(jobsCtx);

  return { organizationSlug: ORG.slug, report };
}