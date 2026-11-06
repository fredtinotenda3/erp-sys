// Browsing, searching and manually managing material lots, and the
// traceability queries over them ("Phase One" of the next mandate round --
// see prisma/schema.prisma's comments on MaterialLot/LotConsumption and
// material-issue-service.ts's header for the write side this reads back).
//
// Everything here is read-only except setLotStatus, and everything requires
// "lot:read" or "lot:manage" -- NOT "material:issue". A PRODUCTION_OPERATOR
// can issue and return lot-tracked material (material-issue-service.ts's
// allocateLotsForConsumption runs the FEFO sweep server-side with no lot:read
// check of its own, the same "no capability gate on an internal lookup"
// convention findWarehouseInScope already uses) but cannot browse the lot
// catalogue or name a specific lot to override FEFO with -- that needs
// lot:read, granted to the manager/finance/viewer roles, not to operators.
// This is a deliberate least-privilege split, not an oversight: an operator
// has no legitimate operational reason to hand-pick a lot FEFO wouldn't have
// chosen anyway, so the frontend's lot picker is only rendered for roles that
// hold lot:read, and every operator issue/return simply omits
// lotAllocations/lotReturns' lot choice and lets the server auto-allocate.
// See IMPLEMENTATION_MANIFEST.md.
import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";
import { findWarehouseInScope } from "./warehouse-service";
import { findJobInScope } from "../production/job-service";
import { isAvailable, listLotsWithRemaining } from "./lot-availability";

const D = (v: unknown) => new Prisma.Decimal(String(v));

function branchScope(session: AuthenticatedSession) {
  return session.role === "OWNER_ADMIN" ? {} : { warehouse: { branchId: { in: [...session.branchIds] } } };
}

function lotView(l: Awaited<ReturnType<typeof listLotsWithRemaining>>[number]) {
  return {
    id: l.id,
    lotNumber: l.lotNumber,
    itemId: l.itemId,
    warehouseId: l.warehouseId,
    supplierId: l.supplierId,
    uom: l.uom,
    status: l.status,
    expiryDate: l.expiryDate,
    receivedAt: l.receivedAt,
    quantityReceived: l.quantityReceived,
    remaining: l.remaining,
    available: isAvailable(l),
  };
}

/**
 * The lot picker behind a manual lot override on an issue/return. Scoped to
 * one (item, warehouse) pair -- never a bare "list all lots" -- because it
 * exists to answer one question: what can I draw from right now. Use
 * listLots for open-ended browsing/search.
 */
export async function getAvailableLotsForIssue(session: AuthenticatedSession, input: unknown) {
  assertCapability(session.role, "lot:read");
  const parsed = z.object({ itemId: z.string().uuid(), warehouseId: z.string().uuid() }).safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid query", parsed.error.issues);
  const warehouse = await findWarehouseInScope(session, parsed.data.warehouseId);
  if (!warehouse) throw new NotFoundError("Warehouse");
  const lots = await listLotsWithRemaining(prisma, session.orgId, parsed.data.itemId, parsed.data.warehouseId);
  return lots.map(lotView);
}

const listFilterSchema = z.object({
  itemId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  supplierId: z.string().uuid().optional(),
  status: z.enum(["active", "quarantined", "expired"]).optional(),
  // Lots whose expiryDate falls on/before this date and are still active --
  // the "what's about to go off" view.
  expiringBy: z.coerce.date().optional(),
  search: z.string().trim().min(1).max(100).optional(), // matches lotNumber / supplierLotRef, case-insensitive
  limit: z.number().int().min(1).max(500).optional(),
});

/** Open-ended lot browsing/search across the org (branch-scoped for non-owners). */
export async function listLots(session: AuthenticatedSession, filter: unknown = {}) {
  assertCapability(session.role, "lot:read");
  const parsed = listFilterSchema.safeParse(filter);
  if (!parsed.success) throw new ValidationError("Invalid filter", parsed.error.issues);
  const f = parsed.data;

  const lots = await prisma.materialLot.findMany({
    where: {
      orgId: session.orgId,
      ...(f.itemId ? { itemId: f.itemId } : {}),
      ...(f.warehouseId ? { warehouseId: f.warehouseId } : {}),
      ...(f.supplierId ? { supplierId: f.supplierId } : {}),
      ...(f.status ? { status: f.status } : {}),
      ...(f.expiringBy ? { expiryDate: { lte: f.expiringBy }, status: f.status ?? "active" } : {}),
      ...(f.search
        ? { OR: [{ lotNumber: { contains: f.search, mode: "insensitive" } }, { supplierLotRef: { contains: f.search, mode: "insensitive" } }] }
        : {}),
      ...branchScope(session),
    },
    orderBy: [{ expiryDate: "asc" }, { receivedAt: "asc" }],
    take: f.limit ?? 200,
  });
  if (lots.length === 0) return [];

  const consumed = await prisma.lotConsumption.groupBy({
    by: ["lotId"],
    where: { orgId: session.orgId, lotId: { in: lots.map((l) => l.id) } },
    _sum: { quantity: true },
  });
  const consumedByLot = new Map(consumed.map((c) => [c.lotId, D(c._sum.quantity ?? 0)]));
  return lots.map((l) =>
    lotView({
      id: l.id,
      lotNumber: l.lotNumber,
      itemId: l.itemId,
      warehouseId: l.warehouseId,
      supplierId: l.supplierId,
      uom: l.uom,
      status: l.status,
      expiryDate: l.expiryDate,
      receivedAt: l.receivedAt,
      quantityReceived: D(l.quantityReceived),
      remaining: D(l.quantityReceived).sub(consumedByLot.get(l.id) ?? D(0)),
    }),
  );
}

async function findLotInScope(session: AuthenticatedSession, id: string) {
  return prisma.materialLot.findFirst({
    where: { id, orgId: session.orgId, ...branchScope(session) },
    include: {
      receiptLine: { include: { receipt: { include: { po: { include: { supplier: true } } } } } },
      sourceReturnOfLot: true,
      sourceReturnJob: true,
      sourceReturnMovement: true,
      // Milestone 6: a regrind-generated lot has neither receiptLineId nor
      // sourceReturnOfLotId -- see this file's getLotDetail/getLotTraceability
      // for the third origin branch this enables.
      sourceRegrindJob: true,
      sourceRegrindMovement: true,
    },
  });
}

/** Full detail for one lot: identity, remaining balance, and its origin. */
export async function getLotDetail(session: AuthenticatedSession, id: string) {
  assertCapability(session.role, "lot:read");
  const lot = await findLotInScope(session, id);
  if (!lot) throw new NotFoundError("Material lot");

  const consumed = await prisma.lotConsumption.aggregate({ where: { orgId: session.orgId, lotId: id }, _sum: { quantity: true } });
  const remaining = D(lot.quantityReceived).sub(D(consumed._sum.quantity ?? 0));
  const childLots = await prisma.materialLot.findMany({
    where: { orgId: session.orgId, sourceReturnOfLotId: id },
    orderBy: { createdAt: "asc" },
  });

  return {
    ...lotView({
      id: lot.id,
      lotNumber: lot.lotNumber,
      itemId: lot.itemId,
      warehouseId: lot.warehouseId,
      supplierId: lot.supplierId,
      uom: lot.uom,
      status: lot.status,
      expiryDate: lot.expiryDate,
      receivedAt: lot.receivedAt,
      quantityReceived: D(lot.quantityReceived),
      remaining,
    }),
    supplierLotRef: lot.supplierLotRef,
    // Milestone 6: a regrind-generated lot is checked BEFORE the "return"
    // fallback -- it has neither receiptLineId nor sourceReturnOfLotId, so
    // without this branch it would fall into "return" with every
    // sourceReturnOfLotId field null, which the "dangling" comment in
    // getLotTraceability below used to assume could never happen.
    origin: lot.receiptLineId
      ? {
          type: "receipt" as const,
          receiptLineId: lot.receiptLineId,
          goodsReceiptId: lot.receiptLine!.receiptId,
          purchaseOrderId: lot.receiptLine!.receipt.poId,
          purchaseOrderNumber: lot.receiptLine!.receipt.po.poNumber,
          supplierId: lot.receiptLine!.receipt.po.supplierId,
          supplierName: lot.receiptLine!.receipt.po.supplier.name,
        }
      : lot.sourceRegrindJobId
        ? {
            type: "regrind" as const,
            sourceRegrindJobId: lot.sourceRegrindJobId,
            sourceRegrindJobNumber: lot.sourceRegrindJob?.jobNumber ?? null,
            sourceRegrindMovementId: lot.sourceRegrindMovementId,
            // Grinding mixes scrap that may trace to several original
            // material lots -- see schema.prisma's MaterialLot comment.
            // Job-level traceability is the correct, honest granularity
            // here, not a single parent lot.
            note: "Regrind traces to the production job it was ground from, not to a single parent material lot -- grinding can mix scrap from several lots.",
          }
        : {
            type: "return" as const,
            sourceReturnOfLotId: lot.sourceReturnOfLotId,
            sourceReturnOfLotNumber: lot.sourceReturnOfLot?.lotNumber ?? null,
            sourceReturnJobId: lot.sourceReturnJobId,
            sourceReturnJobNumber: lot.sourceReturnJob?.jobNumber ?? null,
            sourceReturnMovementId: lot.sourceReturnMovementId,
          },
    returnChildLots: childLots.map((c) => ({
      id: c.id,
      lotNumber: c.lotNumber,
      status: c.status,
      quantityReceived: c.quantityReceived,
      createdAt: c.createdAt,
    })),
  };
}

/**
 * The lot's full traceability chain: backward to the receiving document (and,
 * for a quarantine-spawned lot, back through however many return hops it
 * takes to reach one -- a quarantined lot can never itself be consumed again
 * until manually released via setLotStatus, so this chain is always finite
 * and walked here with a defensive hop cap rather than recursion), and
 * forward to every job that has drawn from it. Finished-goods batches and
 * customer deliveries are the forward continuation of this chain but are
 * explicitly Milestone 2/3's responsibility (schema.prisma's MaterialLot
 * comment) -- not included here, and this function's result says so rather
 * than silently stopping.
 */
export async function getLotTraceability(session: AuthenticatedSession, id: string) {
  assertCapability(session.role, "lot:read");
  const root = await findLotInScope(session, id);
  if (!root) throw new NotFoundError("Material lot");

  const originChain: Array<Record<string, unknown>> = [];
  let cursor = root;
  const MAX_HOPS = 50;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    if (cursor.receiptLineId) {
      originChain.push({
        type: "receipt",
        lotId: cursor.id,
        lotNumber: cursor.lotNumber,
        receiptLineId: cursor.receiptLineId,
        goodsReceiptId: cursor.receiptLine!.receiptId,
        purchaseOrderId: cursor.receiptLine!.receipt.poId,
        purchaseOrderNumber: cursor.receiptLine!.receipt.po.poNumber,
        supplierId: cursor.receiptLine!.receipt.po.supplierId,
        supplierName: cursor.receiptLine!.receipt.po.supplier.name,
      });
      break;
    }
    if (cursor.sourceRegrindJobId) {
      // Milestone 6: regrind is the chain's terminus, same as a receipt --
      // it never chases a sourceReturnOfLotId (it has none) because the
      // material it represents does not trace to one parent lot. See
      // getLotDetail's origin branch above for the same reasoning.
      originChain.push({
        type: "regrind",
        lotId: cursor.id,
        lotNumber: cursor.lotNumber,
        generatedFromJobId: cursor.sourceRegrindJobId,
        generatedFromJobNumber: cursor.sourceRegrindJob?.jobNumber ?? null,
        generatedFromMovementId: cursor.sourceRegrindMovementId,
      });
      break;
    }
    originChain.push({
      type: "return",
      lotId: cursor.id,
      lotNumber: cursor.lotNumber,
      returnedFromJobId: cursor.sourceReturnJobId,
      returnedFromJobNumber: cursor.sourceReturnJob?.jobNumber ?? null,
      returnedFromMovementId: cursor.sourceReturnMovementId,
      parentLotId: cursor.sourceReturnOfLotId,
    });
    if (!cursor.sourceReturnOfLotId) break; // dangling (should not happen -- every non-receipt, non-regrind lot has a parent return lot)
    const next = await findLotInScope(session, cursor.sourceReturnOfLotId);
    if (!next) break;
    cursor = next;
  }

  const consumption = await prisma.lotConsumption.findMany({
    where: { orgId: session.orgId, lotId: id },
    include: { job: true, movement: true },
    orderBy: { createdAt: "asc" },
  });
  const byJob = new Map<string, { jobId: string; jobNumber: string; consumed: Prisma.Decimal; returned: Prisma.Decimal; events: unknown[] }>();
  for (const c of consumption) {
    const entry = byJob.get(c.jobId) ?? { jobId: c.jobId, jobNumber: c.job.jobNumber, consumed: D(0), returned: D(0), events: [] };
    if (c.type === "consumption") entry.consumed = entry.consumed.add(D(c.quantity));
    else entry.returned = entry.returned.add(D(c.quantity).neg());
    entry.events.push({ type: c.type, quantity: c.quantity, movementId: c.movementId, occurredAt: c.movement.occurredAt, createdAt: c.createdAt });
    byJob.set(c.jobId, entry);
  }

  return {
    lotId: root.id,
    lotNumber: root.lotNumber,
    originChain,
    consumedByJobs: [...byJob.values()].map((e) => ({ ...e, netOutstanding: e.consumed.sub(e.returned) })),
    forwardChainNote:
      "Finished-goods batch and customer-delivery traceability from this point forward is implemented in a later milestone (see IMPLEMENTATION_MANIFEST.md).",
  };
}

const statusChangeSchema = z.object({
  status: z.enum(["active", "quarantined"]), // "expired" is date-derived, never set manually -- see below
  reason: z.string().trim().min(3).max(500),
});

/**
 * Manual active<->quarantined transition (e.g. a supplier recall, or
 * releasing a lot after a quality hold clears). "expired" is deliberately
 * not a settable target here: expiry is derived from expiryDate vs. today
 * (see lot-availability.ts's isAvailable, which already blocks consumption
 * of a past-expiry lot regardless of its stored status), not a fact anyone
 * asserts -- allowing it to be set by hand would let it drift from the date
 * it is supposed to represent.
 */
export async function setLotStatus(session: AuthenticatedSession, id: string, input: unknown) {
  assertCapability(session.role, "lot:manage");
  const parsed = statusChangeSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid status change", parsed.error.issues);
  const d = parsed.data;

  const lot = await prisma.materialLot.findFirst({
    where: { id, orgId: session.orgId, ...branchScope(session) },
    include: { warehouse: { select: { branchId: true } } },
  });
  if (!lot) throw new NotFoundError("Material lot");
  if (lot.status === "expired") throw new ConflictError("An expired lot's status cannot be changed");
  if (lot.status === d.status) throw new ConflictError(`Lot is already ${d.status}`);

  const updated = await prisma.$transaction(async (tx) => {
    const result = await tx.materialLot.updateMany({ where: { id, orgId: session.orgId, status: lot.status }, data: { status: d.status } });
    if (result.count !== 1) throw new ConflictError("Lot status changed concurrently -- reload and retry");
    await recordAudit(tx, {
      orgId: session.orgId,
      branchId: lot.warehouse.branchId,
      actorUserId: session.userId,
      entityType: "material_lot",
      entityId: id,
      action: "transition",
      beforeValue: { status: lot.status },
      afterValue: { status: d.status },
      reason: d.reason,
    });
    return tx.materialLot.findUniqueOrThrow({ where: { id } });
  });
  return lotView({
    id: updated.id,
    lotNumber: updated.lotNumber,
    itemId: updated.itemId,
    warehouseId: updated.warehouseId,
    supplierId: updated.supplierId,
    uom: updated.uom,
    status: updated.status,
    expiryDate: updated.expiryDate,
    receivedAt: updated.receivedAt,
    quantityReceived: D(updated.quantityReceived),
    remaining: D(updated.quantityReceived).sub(D((await prisma.lotConsumption.aggregate({ where: { orgId: session.orgId, lotId: id }, _sum: { quantity: true } }))._sum.quantity ?? 0)),
  });
}

/**
 * Per-job, per-material lot breakdown -- "which lots did this job's material
 * come from" -- the job-detail-page companion to getJobMaterials in
 * material-issue-service.ts (which is expected-vs-issued; this is the lot
 * detail behind the issued figure, only for materials that were lot-tracked).
 */
export async function getJobLotConsumption(session: AuthenticatedSession, jobId: string) {
  assertCapability(session.role, "production_job:read");
  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");

  const rows = await prisma.lotConsumption.findMany({
    where: { orgId: session.orgId, jobId: job.id },
    include: { lot: true, movement: true },
    orderBy: { createdAt: "asc" },
  });
  const byLot = new Map<string, { lotId: string; lotNumber: string; itemId: string; warehouseId: string; consumed: Prisma.Decimal; returned: Prisma.Decimal }>();
  for (const r of rows) {
    const entry = byLot.get(r.lotId) ?? { lotId: r.lotId, lotNumber: r.lot.lotNumber, itemId: r.lot.itemId, warehouseId: r.lot.warehouseId, consumed: D(0), returned: D(0) };
    if (r.type === "consumption") entry.consumed = entry.consumed.add(D(r.quantity));
    else entry.returned = entry.returned.add(D(r.quantity).neg());
    byLot.set(r.lotId, entry);
  }
  return [...byLot.values()].map((e) => ({ ...e, netOutstanding: e.consumed.sub(e.returned) }));
}
