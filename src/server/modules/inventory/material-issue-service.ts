// Issuing materials to a production job, returning unused/rejected material
// from one, and the per-job expected-vs-issued view (the data behind the
// job's "Materials" tab).
//
// An issue to a job is stored as movement_type = production_consumption with
// reference_type = production_job. A return is stored as movement_type =
// material_return, same reference_type/reference_id -- that exact pairing is
// what the job-cost views (actual-cost.ts's computeActualCostLines, already
// written to include both types) and the shortage calculation read, so it
// must not drift. Generic non-job issues (material_issue) are not exposed
// here.
//
// Over-issue (more than the BOM expects) is ALLOWED: over-consumption is
// precisely the variance the product exists to surface. What cannot happen is
// the stock going negative, which the ledger trigger refuses.
//
// LOT TRACEABILITY (migration 20261105120000_lot_consumption_and_traceability,
// "Phase One" of the next mandate round) -- design decisions worth restating
// here (full rationale in IMPLEMENTATION_MANIFEST.md):
//  - If an item has ANY MaterialLot row for (item, warehouse), every issue of
//    that item from that warehouse must be fully lot-tracked: either the
//    caller names which lot(s) to draw from (lotAllocations), or the service
//    auto-allocates FEFO (earliest expiry first, then earliest received) and
//    fails loudly if lot-tracked availability is insufficient -- it never
//    silently falls back to untracked consumption. An item with zero lots
//    ever received in that warehouse is treated as not lot-tracked and
//    issues exactly as before this migration (full backward compatibility
//    with every existing caller that doesn't know lots exist).
//  - A return mirrors this: if the job's consumption of that material was
//    lot-tracked, the caller must say which lot(s) the returned quantity
//    traces back to (lotReturns), each bounded by what that job actually
//    drew from that lot and not yet returned.
//  - A return's disposition is "good" (credited straight back to the
//    originating lot -- it becomes available again) or "quarantine"
//    (the ORIGINAL lot's consumption is left standing -- nothing is credited
//    back to it -- and the returned quantity instead spawns a brand-new
//    MaterialLot with status=quarantined, linked back to the original lot,
//    this job and this movement for full lineage). This is a deliberate
//    simplification: there is no sub-warehouse "quarantine bin" in this
//    schema (a warehouse is the only location granularity), so quarantine is
//    enforced at the LOT-selection layer (quarantined lots are never
//    available for consumption, see lot-availability.ts's isAvailable) and
//    not by giving the quarantined quantity a different physical location --
//    see IMPLEMENTATION_MANIFEST.md "Known limitations".
//  - A return's unit cost is NEVER an arbitrary current average: it is
//    derived from the cost basis of the specific consumption event(s) being
//    reversed (per lot for a lot-tracked item; net-weighted-average of this
//    job's consumption/return ledger for an untracked one), so that a full
//    return of everything issued nets the job's material cost back to
//    exactly zero. See computeLotReturnCost / computeUntrackedReturnCost.
//  - True pre-consumption soft reservation of a lot (holding material for a
//    future job without yet debiting the ledger) is explicitly NOT built
//    this round -- "allocation" and "consumption" are one atomic act, at
//    issuance time. See IMPLEMENTATION_MANIFEST.md for why this is a
//    reasoned scope decision, not an oversight, and where it would belong.
import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertCapability, hasCapability } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";
import { findJobInScope } from "../production/job-service";
import { acceptsWork, type JobStatus } from "../production/job-state";
import { findWarehouseInScope } from "./warehouse-service";
import { checkReplay, findByClientRequestId, postMovement, readBalance, toMovementView } from "./stock-core";
import { getRemainingForLots, isAvailable, lockLots } from "./lot-availability";

const D = (v: unknown) => new Prisma.Decimal(String(v));
const MAX_QTY = 1_000_000_000;
const hasAtMost4dp = (n: number) => Math.abs(n * 1e4 - Math.round(n * 1e4)) < 1e-6;

const positiveQty = z
  .number()
  .finite()
  .positive()
  .max(MAX_QTY)
  .refine(hasAtMost4dp, "quantity supports at most 4 decimal places");

const occurredAtSchema = z.coerce
  .date()
  .refine((d) => d.getTime() <= Date.now() + 5 * 60_000, "occurredAt cannot be in the future")
  .optional();

const lotAllocationSchema = z.object({
  lotId: z.string().uuid(),
  quantity: positiveQty,
});

const issueSchema = z.object({
  clientRequestId: z.string().uuid(),
  materialItemId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  quantity: positiveQty,
  occurredAt: occurredAtSchema,
  // Omit to auto-allocate FEFO across whatever lots this item has in this
  // warehouse. Required to name specific lots instead; see the file header.
  lotAllocations: z.array(lotAllocationSchema).min(1).max(50).optional(),
});

export async function issueMaterialToJob(session: AuthenticatedSession, jobId: string, input: unknown) {
  assertCapability(session.role, "material:issue");
  const parsed = issueSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid material issue payload", parsed.error.issues);
  const d = parsed.data;

  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");

  const warehouse = await findWarehouseInScope(session, d.warehouseId);
  if (!warehouse) throw new NotFoundError("Warehouse");

  const args = {
    warehouse: { id: warehouse.id, branchId: warehouse.branchId },
    itemId: d.materialItemId,
    movementType: "production_consumption" as const,
    quantity: D(d.quantity).neg(),
    unitCost: null, // stamped by the ledger trigger at the current weighted-average cost
    currency: null,
    referenceType: "production_job" as const,
    referenceId: job.id,
    reason: null,
    clientRequestId: d.clientRequestId,
    occurredAt: d.occurredAt,
  };

  // A retried offline submission must succeed even if the job has since moved on.
  const existing = await findByClientRequestId(session.orgId, d.clientRequestId);
  if (existing) {
    const r = checkReplay(existing, args);
    return shape(session, r.replayed, r.movement, d.materialItemId, warehouse.id);
  }

  if (!acceptsWork(job.status as JobStatus)) {
    throw new ConflictError(`Material cannot be issued to a job that is "${job.status}" (it must be released or in progress)`);
  }
  if (warehouse.branchId !== job.branchId) {
    throw new ValidationError("Material can only be issued from a warehouse in the same branch as the job");
  }
  if (!warehouse.isActive) throw new ValidationError("Cannot issue from an inactive warehouse");

  const requirement = await prisma.materialRequirement.findFirst({
    where: { orgId: session.orgId, jobId: job.id, materialItemId: d.materialItemId },
  });
  if (!requirement) {
    throw new ValidationError("That material is not part of this job's bill of materials");
  }

  const wasReleased = job.status === "released";
  const result = await postMovement(session, {
    ...args,
    afterInsert: async (tx, movement) => {
      if (wasReleased) {
        const moved = await tx.productionJob.updateMany({
          where: { id: job.id, orgId: session.orgId, status: "released" },
          data: { status: "in_progress", actualStart: new Date() },
        });
        if (moved.count === 1) {
          await recordAudit(tx, {
            orgId: session.orgId,
            branchId: job.branchId,
            actorUserId: session.userId,
            entityType: "production_job",
            entityId: job.id,
            action: "transition",
            beforeValue: { status: "released" },
            afterValue: { status: "in_progress" },
            reason: "first material issue",
          });
        }
      }

      await allocateLotsForConsumption(tx, session, {
        jobId: job.id,
        itemId: d.materialItemId,
        warehouseId: warehouse.id,
        quantity: D(d.quantity),
        movementId: movement.id,
        requestedAllocations: d.lotAllocations,
        materialLabel: `material ${d.materialItemId}`,
        uom: requirement.uom,
      });
    },
  });
  return shape(session, result.replayed, result.movement, d.materialItemId, warehouse.id);
}

/**
 * If `itemId` has no MaterialLot rows in `warehouseId` at all, this is a
 * no-op (the item has never been lot-tracked there). Otherwise, allocates
 * `quantity` across specific lots -- either the caller's `requestedAllocations`
 * (validated) or an auto FEFO sweep -- and writes one append-only
 * LotConsumption(type=consumption) row per lot drawn from. Must run inside
 * the same transaction as the StockMovement it is attached to (via
 * postMovement's/postMovementInTransaction's afterInsert hook): on any
 * failure here the whole movement rolls back, so a job can never end up
 * partially lot-traced.
 */
async function allocateLotsForConsumption(
  tx: Prisma.TransactionClient,
  session: AuthenticatedSession,
  args: {
    jobId: string;
    itemId: string;
    warehouseId: string;
    quantity: Prisma.Decimal;
    movementId: string;
    requestedAllocations?: { lotId: string; quantity: number }[];
    materialLabel: string;
    uom: string;
  },
): Promise<void> {
  const candidates = await tx.materialLot.findMany({
    where: { orgId: session.orgId, itemId: args.itemId, warehouseId: args.warehouseId },
  });
  if (candidates.length === 0) return; // never lot-tracked here -- untouched, pre-existing behaviour

  const candidateIds = candidates.map((l) => l.id);
  const requestedIds = args.requestedAllocations?.map((a) => a.lotId) ?? candidateIds;
  await lockLots(tx, requestedIds);
  const remaining = await getRemainingForLots(tx, session.orgId, requestedIds);
  const byId = new Map(candidates.map((l) => [l.id, l]));

  let allocations: { lotId: string; quantity: Prisma.Decimal }[];

  if (args.requestedAllocations && args.requestedAllocations.length > 0) {
    const sum = args.requestedAllocations.reduce((s, a) => s.add(D(a.quantity)), D(0));
    if (!sum.equals(args.quantity)) {
      throw new ValidationError(`lotAllocations must sum exactly to the issued quantity (${args.quantity.toString()} ${args.uom})`);
    }
    const seen = new Set<string>();
    allocations = args.requestedAllocations.map((a) => {
      if (seen.has(a.lotId)) throw new ValidationError("Each lot can only appear once in lotAllocations");
      seen.add(a.lotId);
      const lot = byId.get(a.lotId);
      if (!lot) throw new ValidationError(`lotId ${a.lotId} is not a material lot of ${args.materialLabel} in this warehouse`);
      const rem = remaining.get(a.lotId) ?? D(0);
      if (!isAvailable({ status: lot.status, expiryDate: lot.expiryDate, remaining: rem })) {
        const expired = Boolean(lot.expiryDate && lot.expiryDate.getTime() < Date.now());
        throw new ValidationError(
          `Lot ${lot.lotNumber} is not available for consumption (status=${lot.status}${expired ? ", expired" : ""}, remaining=${rem.toString()} ${lot.uom})`,
        );
      }
      const qty = D(a.quantity);
      if (qty.greaterThan(rem)) {
        throw new ValidationError(`Lot ${lot.lotNumber} only has ${rem.toString()} ${lot.uom} remaining -- cannot allocate ${qty.toString()}`);
      }
      return { lotId: a.lotId, quantity: qty };
    });
  } else {
    // Auto FEFO: earliest expiry first (no-expiry lots last), then earliest received.
    const sorted = [...candidates].sort((a, b) => {
      const ea = a.expiryDate ? a.expiryDate.getTime() : Infinity;
      const eb = b.expiryDate ? b.expiryDate.getTime() : Infinity;
      if (ea !== eb) return ea - eb;
      return a.receivedAt.getTime() - b.receivedAt.getTime();
    });
    let need = args.quantity;
    allocations = [];
    for (const lot of sorted) {
      if (need.lessThanOrEqualTo(0)) break;
      const rem = remaining.get(lot.id) ?? D(0);
      if (!isAvailable({ status: lot.status, expiryDate: lot.expiryDate, remaining: rem })) continue;
      const take = Prisma.Decimal.min(need, rem);
      if (take.greaterThan(0)) {
        allocations.push({ lotId: lot.id, quantity: take });
        need = need.sub(take);
      }
    }
    if (need.greaterThan(0)) {
      const totalAvailable = [...remaining.values()].reduce((s, r) => s.add(Prisma.Decimal.max(r, 0)), D(0));
      throw new ValidationError(
        `Insufficient lot-tracked stock for ${args.materialLabel} in this warehouse: ${need.toString()} ${args.uom} short ` +
          `(only ${totalAvailable.toString()} ${args.uom} available across ${candidates.length} lot(s))`,
      );
    }
  }

  for (const a of allocations) {
    await tx.lotConsumption.create({
      data: { orgId: session.orgId, lotId: a.lotId, jobId: args.jobId, movementId: args.movementId, type: "consumption", quantity: a.quantity, createdById: session.userId },
    });
  }
}

async function shape(
  session: AuthenticatedSession,
  replayed: boolean,
  movement: Parameters<typeof toMovementView>[1],
  itemId: string,
  warehouseId: string,
) {
  return {
    replayed,
    movement: toMovementView(session.role, movement),
    // Only callers who may read stock see the resulting balance.
    balance: await readBalance(session, itemId, warehouseId),
  };
}

/** Expected (BOM snapshot) vs issued (ledger) per material, for one job. */
export async function getJobMaterials(session: AuthenticatedSession, jobId: string) {
  assertCapability(session.role, "production_job:read");
  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");

  const [requirements, issued] = await Promise.all([
    prisma.materialRequirement.findMany({ where: { orgId: session.orgId, jobId: job.id } }),
    prisma.stockMovement.groupBy({
      by: ["itemId"],
      where: { orgId: session.orgId, referenceType: "production_job", referenceId: job.id, movementType: { in: ["production_consumption", "material_return"] } },
      _sum: { quantity: true },
    }),
  ]);
  const issuedByItem = new Map(issued.map((g) => [g.itemId, new Prisma.Decimal(g._sum.quantity ?? 0).neg()]));
  const showCost = hasCapability(session.role, "cost:read");

  return requirements.map((r) => {
    // Net = issued - returned (material_return is positive and offsets
    // production_consumption's negative sign, same convention as
    // actual-cost.ts) -- this is the quantity still genuinely out at the job.
    const issuedQty = issuedByItem.get(r.materialItemId) ?? new Prisma.Decimal(0);
    const expected = new Prisma.Decimal(r.expectedQty);
    return {
      materialItemId: r.materialItemId,
      uom: r.uom,
      expectedQty: expected, // PLANNED: snapshot from job creation
      issuedQty, // ACTUAL (net of returns): summed from the ledger
      remainingQty: Prisma.Decimal.max(expected.sub(issuedQty), 0), // CALCULATED
      overIssuedQty: Prisma.Decimal.max(issuedQty.sub(expected), 0), // CALCULATED; >0 is a variance, not an error
      ...(showCost ? { standardUnitCost: r.standardUnitCost, standardUnitCostCurrency: r.standardUnitCostCurrency } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Returns
// ---------------------------------------------------------------------------

const lotReturnSchema = z.object({
  lotId: z.string().uuid(),
  quantity: positiveQty,
  disposition: z.enum(["good", "quarantine"]).default("good"),
});

const returnSchema = z.object({
  clientRequestId: z.string().uuid(),
  materialItemId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  quantity: positiveQty,
  occurredAt: occurredAtSchema,
  reason: z.string().trim().min(3, "Give a brief reason for the return").max(500),
  // Required when this job's consumption of this material was lot-tracked;
  // must be omitted otherwise. See allocateLotsForConsumption's sibling logic
  // below (computeLotReturnCost) for why a lot-tracked return cannot be
  // accepted without naming which lot(s) it traces back to.
  lotReturns: z.array(lotReturnSchema).min(1).max(50).optional(),
});

/**
 * Returns unused or rejected material from a job back to a warehouse.
 * Reuses the "material:issue" capability -- the same role set that can
 * issue material to a job is the one that can correct/reverse that issue;
 * there is no segregation-of-duties reason (unlike purchase_order:confirm)
 * to split them. See the file header for the full design.
 */
export async function returnMaterialFromJob(session: AuthenticatedSession, jobId: string, input: unknown) {
  assertCapability(session.role, "material:issue");
  const parsed = returnSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid material return payload", parsed.error.issues);
  const d = parsed.data;

  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");

  const warehouse = await findWarehouseInScope(session, d.warehouseId);
  if (!warehouse) throw new NotFoundError("Warehouse");

  // Idempotency check first -- cheap, and `sameRequest` (stock-core.ts) only
  // compares itemId/warehouseId/movementType/quantity/referenceId, none of
  // which depend on the cost computation below, so this is safe to do before
  // we know the unit cost.
  const existing = await findByClientRequestId(session.orgId, d.clientRequestId);
  if (existing) {
    const r = checkReplay(existing, {
      warehouse: { id: warehouse.id, branchId: warehouse.branchId },
      itemId: d.materialItemId,
      movementType: "material_return",
      quantity: D(d.quantity),
      unitCost: null,
      currency: null,
      referenceType: "production_job",
      referenceId: job.id,
      reason: d.reason,
      clientRequestId: d.clientRequestId,
      occurredAt: d.occurredAt,
    });
    return shape(session, r.replayed, r.movement, d.materialItemId, warehouse.id);
  }

  if (warehouse.branchId !== job.branchId) {
    throw new ValidationError("Material can only be returned to a warehouse in the same branch as the job");
  }
  if (!warehouse.isActive) throw new ValidationError("Cannot return material to an inactive warehouse");

  const requirement = await prisma.materialRequirement.findFirst({
    where: { orgId: session.orgId, jobId: job.id, materialItemId: d.materialItemId },
  });
  if (!requirement) throw new ValidationError("That material is not part of this job's bill of materials");

  // Was this job's consumption of this material lot-tracked at all?
  const consumption = await prisma.lotConsumption.findMany({
    where: { orgId: session.orgId, jobId: job.id, lot: { itemId: d.materialItemId, warehouseId: warehouse.id } },
    include: { lot: true, movement: true },
  });
  const isLotTracked = consumption.length > 0;

  if (isLotTracked && (!d.lotReturns || d.lotReturns.length === 0)) {
    throw new ValidationError("This material was issued from a specific lot -- specify lotReturns naming which lot(s) the returned quantity comes from");
  }
  if (!isLotTracked && d.lotReturns && d.lotReturns.length > 0) {
    throw new ValidationError("This material was never lot-tracked for this job -- omit lotReturns");
  }

  let unitCost: Prisma.Decimal;
  let currency: string;
  const lotPlan: { lotId: string; quantity: Prisma.Decimal; disposition: "good" | "quarantine"; lot: (typeof consumption)[number]["lot"] }[] = [];

  if (isLotTracked) {
    const sum = d.lotReturns!.reduce((s, r) => s.add(D(r.quantity)), D(0));
    if (!sum.equals(D(d.quantity))) throw new ValidationError("lotReturns quantities must sum exactly to the returned quantity");

    const netByLot = new Map<string, Prisma.Decimal>();
    const lotById = new Map<string, (typeof consumption)[number]["lot"]>();
    const costBasisByLot = new Map<string, { qty: Prisma.Decimal; cost: Prisma.Decimal; currency: string | null }>();
    for (const c of consumption) {
      netByLot.set(c.lotId, (netByLot.get(c.lotId) ?? D(0)).add(D(c.quantity)));
      lotById.set(c.lotId, c.lot);
      if (c.type === "consumption") {
        const movementCost = c.movement.unitCost ? D(c.movement.unitCost) : null;
        if (movementCost) {
          const entry = costBasisByLot.get(c.lotId) ?? { qty: D(0), cost: D(0), currency: c.movement.currency };
          if (entry.currency && c.movement.currency && entry.currency !== c.movement.currency) {
            throw new ConflictError(`Lot ${c.lot.lotNumber} was consumed by this job in more than one currency -- cannot compute a single return cost`);
          }
          const q = D(c.quantity);
          entry.qty = entry.qty.add(q);
          entry.cost = entry.cost.add(q.mul(movementCost));
          entry.currency = entry.currency ?? c.movement.currency;
          costBasisByLot.set(c.lotId, entry);
        }
      }
    }

    const seen = new Set<string>();
    let totalCost = D(0);
    let returnCurrency: string | null = null;
    for (const r of d.lotReturns!) {
      if (seen.has(r.lotId)) throw new ValidationError("Each lot can only appear once in lotReturns");
      seen.add(r.lotId);
      const outstanding = netByLot.get(r.lotId);
      const lot = lotById.get(r.lotId);
      if (outstanding === undefined || !lot) {
        throw new ValidationError(`This job has no recorded consumption of that lot for this material`);
      }
      const qty = D(r.quantity);
      if (qty.greaterThan(outstanding)) {
        throw new ValidationError(`Lot ${lot.lotNumber}: cannot return more than this job has outstanding from it (${outstanding.toString()} ${lot.uom})`);
      }
      const basis = costBasisByLot.get(r.lotId);
      if (!basis || basis.qty.lessThanOrEqualTo(0)) {
        throw new ConflictError(`Lot ${lot.lotNumber} has no costed consumption on record for this job -- cannot determine a return cost`);
      }
      if (basis.currency) {
        if (returnCurrency && returnCurrency !== basis.currency) {
          throw new ConflictError("The lots in this return were consumed in different currencies -- return them separately");
        }
        returnCurrency = returnCurrency ?? basis.currency;
      }
      const lotAvgCost = basis.cost.div(basis.qty);
      totalCost = totalCost.add(qty.mul(lotAvgCost));
      lotPlan.push({ lotId: r.lotId, quantity: qty, disposition: r.disposition, lot });
    }
    if (!returnCurrency) throw new ConflictError("Could not determine a currency for this return");
    unitCost = totalCost.div(D(d.quantity));
    currency = returnCurrency;
  } else {
    const rows = await prisma.stockMovement.findMany({
      where: {
        orgId: session.orgId,
        referenceType: "production_job",
        referenceId: job.id,
        itemId: d.materialItemId,
        movementType: { in: ["production_consumption", "material_return"] },
      },
    });
    let qtyOut = D(0);
    let costOut = D(0);
    let currencyOut: string | null = null;
    for (const m of rows) {
      if (!m.unitCost || !m.currency) continue;
      if (currencyOut && m.currency !== currencyOut) {
        throw new ConflictError("This material's consumption on this job spans more than one currency -- cannot determine a single return cost");
      }
      currencyOut = currencyOut ?? m.currency;
      qtyOut = qtyOut.sub(D(m.quantity));
      costOut = costOut.sub(D(m.quantity).mul(D(m.unitCost)));
    }
    if (qtyOut.lessThanOrEqualTo(0) || !currencyOut) {
      throw new ValidationError("This job has nothing currently issued (and not already returned) for this material");
    }
    if (D(d.quantity).greaterThan(qtyOut)) {
      throw new ValidationError(`Cannot return more than is currently issued and not yet returned (${qtyOut.toString()} ${requirement.uom})`);
    }
    unitCost = costOut.div(qtyOut);
    currency = currencyOut;
  }

  const result = await postMovement(session, {
    warehouse: { id: warehouse.id, branchId: warehouse.branchId },
    itemId: d.materialItemId,
    movementType: "material_return",
    quantity: D(d.quantity),
    unitCost,
    currency,
    referenceType: "production_job",
    referenceId: job.id,
    reason: d.reason,
    clientRequestId: d.clientRequestId,
    occurredAt: d.occurredAt,
    afterInsert: async (tx, movement) => {
      if (!isLotTracked) return;
      await lockLots(tx, lotPlan.map((p) => p.lotId));
      let nextLotSeq: number | null = null;
      const nextLotNumber = async (): Promise<string> => {
        if (nextLotSeq === null) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"material_lot_number:" + session.orgId}))`;
          const last = await tx.$queryRaw<{ n: number | null }[]>`
            SELECT MAX(substring(lot_number from '^LOT-([0-9]+)$')::int) AS n
              FROM material_lot WHERE org_id = ${session.orgId}::uuid`;
          nextLotSeq = (last[0]?.n ?? 0) + 1;
        } else {
          nextLotSeq += 1;
        }
        return `LOT-${String(nextLotSeq).padStart(6, "0")}`;
      };

      for (const p of lotPlan) {
        if (p.disposition === "good") {
          await tx.lotConsumption.create({
            data: { orgId: session.orgId, lotId: p.lotId, jobId: job.id, movementId: movement.id, type: "return", quantity: p.quantity.neg(), createdById: session.userId },
          });
        } else {
          const lotNumber = await nextLotNumber();
          await tx.materialLot.create({
            data: {
              orgId: session.orgId,
              lotNumber,
              itemId: d.materialItemId,
              supplierId: p.lot.supplierId,
              supplierLotRef: p.lot.supplierLotRef,
              warehouseId: warehouse.id,
              quantityReceived: p.quantity,
              uom: p.lot.uom,
              status: "quarantined",
              expiryDate: p.lot.expiryDate,
              receivedAt: d.occurredAt ?? new Date(),
              sourceReturnOfLotId: p.lotId,
              sourceReturnJobId: job.id,
              sourceReturnMovementId: movement.id,
            },
          });
        }
      }
    },
  });
  return shape(session, result.replayed, result.movement, d.materialItemId, warehouse.id);
}
