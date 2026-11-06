// Regrind generation (Milestone 6, Plastics Manufacturing Vertical).
//
// A regrind lot is an ordinary MaterialLot of the SAME raw-material item it
// was ground from -- not a separate catalog SKU -- created via a dedicated
// movement_type = regrind_generation (see stock-core.ts's PostableMovementType
// comment for why this is its own type and never purchase_receipt: the
// mandate's explicit requirement is "prevent regrind from being counted as
// newly purchased raw material"). Like a goods receipt, this is a POSITIVE
// movement that brings new usable stock into existence, so it requires a
// real unit_cost/currency the same way purchase_receipt does -- but that
// cost is the value of the ground material (operator- or policy-supplied),
// never a purchase price, and it is never invented by this service.
//
// Traceability is deliberately JOB-level, not single-lot-level: grinding
// mixes scrap that may trace back to several different original material
// lots, so claiming one parent lot would overstate the precision this
// physical process actually has (see MaterialLot.sourceRegrindJobId's schema
// comment, and lot-service.ts's getLotDetail/getLotTraceability "regrind"
// origin branch, which reads this lineage back).
//
// What this file deliberately does NOT do: it does not try to derive the
// regrind quantity from the job's recorded scrap quantity (output-service.ts's
// ProductionOutput.scrapQty is counted in the PRODUCT's own uom -- e.g.
// bottles -- not the raw-material uom a regrind lot is weighed in, so the
// two are not directly convertible without a per-product weight figure this
// schema does not store as a hard conversion factor). The operator weighs
// the actual regrind output and enters it here; the job reference is for
// traceability ("this regrind came from this job's scrap"), not an
// automatic quantity derivation.
import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import { NotFoundError, ValidationError } from "../../shared/errors";
import type { AuthenticatedSession } from "../iam/session-service";
import { findJobInScope } from "../production/job-service";
import { findWarehouseInScope } from "./warehouse-service";
import { checkReplay, findByClientRequestId, postMovement, readBalance, toMovementView } from "./stock-core";
import { assertPlasticsProfileActive } from "../industry/industry-profile-service";

const D = (v: unknown) => new Prisma.Decimal(String(v));
const MAX_QTY = 1_000_000_000;
const hasAtMost4dp = (n: number) => Math.abs(n * 1e4 - Math.round(n * 1e4)) < 1e-6;

const positiveQty = z.number().finite().positive().max(MAX_QTY).refine(hasAtMost4dp, "quantity supports at most 4 decimal places");
const positiveCost = z.number().finite().positive().max(MAX_QTY).refine(hasAtMost4dp, "unitCost supports at most 4 decimal places");

const createRegrindSchema = z.object({
  clientRequestId: z.string().uuid(),
  sourceJobId: z.string().uuid(),
  itemId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  quantity: positiveQty,
  // Same discipline as stock-service.ts's positive adjustment: a positive
  // movement always carries a real cost basis supplied by the caller, never
  // an invented or copied-forward figure.
  unitCost: positiveCost,
  currency: z.string().trim().toUpperCase().length(3),
  notes: z.string().trim().max(500).optional(),
  occurredAt: z.coerce.date().optional(),
});

async function requireCurrency(code: string) {
  const c = await prisma.currency.findUnique({ where: { code } });
  if (!c) throw new ValidationError(`Unknown currency code "${code}"`);
}

/** Next LOT-###### number, same generator/locking scheme as material-issue-service.ts's return-lot spawning. */
async function nextLotNumber(tx: Prisma.TransactionClient, orgId: string): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"material_lot_number:" + orgId}))`;
  const last = await tx.$queryRaw<{ n: number | null }[]>`
    SELECT MAX(substring(lot_number from '^LOT-([0-9]+)$')::int) AS n
      FROM material_lot WHERE org_id = ${orgId}::uuid`;
  const n = (last[0]?.n ?? 0) + 1;
  return `LOT-${String(n).padStart(6, "0")}`;
}

/**
 * Generate a regrind lot from a production job's own scrap. Requires
 * regrind:create and the plastics profile to be active (write-gated, same as
 * every other Milestone 6 mutation -- see industry-profile-service.ts).
 * Reads of the resulting lot go through lot-service.ts exactly like any
 * other MaterialLot, and are never profile-gated: a regrind lot stays fully
 * visible and traceable even if the org later switches away from plastics.
 */
export async function createRegrindLot(session: AuthenticatedSession, input: unknown) {
  assertCapability(session.role, "regrind:create");
  await assertPlasticsProfileActive(session);
  const parsed = createRegrindSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid regrind creation payload", parsed.error.issues);
  const d = parsed.data;

  const job = await findJobInScope(session, d.sourceJobId);
  if (!job) throw new NotFoundError("Production job");

  const item = await prisma.item.findFirst({ where: { orgId: session.orgId, id: d.itemId } });
  if (!item) throw new NotFoundError("Item");
  if (item.itemType !== "raw_material" && item.itemType !== "consumable") {
    throw new ValidationError("Regrind can only be generated for a raw_material or consumable item");
  }
  if (!item.isActive) throw new ValidationError("Cannot generate regrind for an inactive item");

  const warehouse = await findWarehouseInScope(session, d.warehouseId);
  if (!warehouse) throw new NotFoundError("Warehouse");
  if (!warehouse.isActive) throw new ValidationError("Cannot receive regrind into an inactive warehouse");
  if (warehouse.branchId !== job.branchId) {
    throw new ValidationError("Regrind can only be received into a warehouse in the same branch as the source job");
  }

  await requireCurrency(d.currency);

  const args = {
    warehouse: { id: warehouse.id, branchId: warehouse.branchId },
    itemId: d.itemId,
    movementType: "regrind_generation" as const,
    quantity: D(d.quantity),
    unitCost: D(d.unitCost),
    currency: d.currency,
    referenceType: "production_job" as const,
    referenceId: job.id,
    reason: d.notes ?? null,
    clientRequestId: d.clientRequestId,
    occurredAt: d.occurredAt,
  };

  // A retried offline submission must succeed even if the job has since moved on.
  const existing = await findByClientRequestId(session.orgId, d.clientRequestId);
  if (existing) {
    const r = checkReplay(existing, args);
    return shape(session, r.replayed, r.movement, d.itemId, warehouse.id);
  }

  const result = await postMovement(session, {
    ...args,
    afterInsert: async (tx, movement) => {
      const lotNumber = await nextLotNumber(tx, session.orgId);
      await tx.materialLot.create({
        data: {
          orgId: session.orgId,
          lotNumber,
          itemId: d.itemId,
          // No external supplier -- see schema.prisma's MaterialLot comment
          // and this file's header: regrind is generated internally, never
          // purchased.
          supplierId: null,
          supplierLotRef: null,
          warehouseId: warehouse.id,
          quantityReceived: D(d.quantity),
          uom: item.uom,
          // Regrind is treated as immediately usable stock, not quarantined:
          // unlike a job's "needs inspection" return (material-issue-service.ts),
          // this is a deliberate operator action recording material they have
          // already produced and judged usable, not a disposition decision
          // the system is making on their behalf. A plant that wants a
          // quality hold on regrind can still set it to quarantined
          // afterwards via lot-service.ts's setLotStatus (lot:manage).
          status: "active",
          expiryDate: null,
          receivedAt: d.occurredAt ?? new Date(),
          sourceRegrindJobId: job.id,
          sourceRegrindMovementId: movement.id,
        },
      });
    },
  });
  return shape(session, result.replayed, result.movement, d.itemId, warehouse.id);
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
    balance: await readBalance(session, itemId, warehouseId),
  };
}
