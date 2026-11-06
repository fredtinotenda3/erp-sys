// Finished-Goods Inventory (Milestone 2): converting already-recorded good
// shop-floor output (ProductionOutput, Phase 3, unchanged by this milestone)
// into valued, traceable finished-goods stock, and managing that stock once
// it exists (browsing, transferring between warehouses, controlled
// adjustments, quarantine/release).
//
// RECEIVING finished goods (receiveFinishedGoods) is this file's central
// operation and this milestone's "production completion" concept -- see
// prisma/schema.prisma's comment on FinishedGoodsBatch for why this is
// deliberately NOT a duplicate of ProductionOutput's good/scrap/rework
// fields. One call:
//   1. Bounds `quantity` by the job's cumulative good output not yet
//      received to FG (cumulativeGoodOutput - SUM(existing batches'
//      goodQty)), under a per-job advisory lock so two concurrent receives
//      can never together exceed what was actually produced ("prevent
//      duplicate completion postings").
//   2. Posts ONE StockMovement (movement_type = finished_goods_receipt,
//      positive, into the chosen warehouse) through the single canonical
//      insert path (stock-core.ts) -- so the finished-goods item's ordinary
//      (item, warehouse) stock_balance is correct and reconciles exactly the
//      same way every other item's does. The movement's own idempotency key
//      (clientRequestId) is this whole operation's idempotency key -- same
//      "one movement, one request" convention material-issue-service.ts
//      already uses (unlike goods-receipt-service.ts's header-level key,
//      this operation only ever creates one movement, so there is no need
//      for a second key at a different granularity).
//   3. In the SAME transaction (afterInsert): creates the FinishedGoodsBatch
//      row, its per-currency cost lines (wip-fg-transfer.ts -- the WIP ->
//      FG transfer, clamped so cost is never double-counted) and its lot
//      genealogy rows (fg-genealogy.ts).
//
// CURRENCY: a finished_goods_receipt movement needs exactly ONE unit_cost in
// exactly ONE currency (schema.prisma's StockMovement -- same as every other
// movement). A job's actual cost can have lines in more than one currency
// (computeActualCostLines groups by currency, same as JobCostActualLine).
// This file picks the SINGLE currency for the movement as follows, in order:
//   a) if the finished-goods item already has a stock_balance in this
//      warehouse, its existing currency is load-bearing (the DB trigger
//      refuses to average a second currency into an existing cost basis --
//      see stock-errors.ts's "cannot be averaged into it" mapping) -- that
//      currency's cost line is used, and it is a ConflictError (not a
//      trigger failure) if the job has no cost line in that currency at all;
//   b) otherwise (first-ever finished-goods receipt for this item/warehouse),
//      the organisation's own base currency if the job has a cost line in
//      it, else the job's only currency if there is exactly one, else the
//      currency with the largest allocated amount.
// The movement's unit_cost is therefore always a REAL, computed figure in a
// real currency the job actually has cost in -- never invented, never
// averaged across currencies. Every currency's full, uncombined cost detail
// is still recorded in FinishedGoodsBatchCostLine regardless of which one
// anchors the stock ledger -- that table, not the movement, is this
// milestone's authoritative valuation record.
import { randomUUID } from "crypto";
import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertCapability, hasCapability } from "../../shared/authz";
import { ConflictError, NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";
import { findJobInScope } from "../production/job-service";
import type { JobStatus } from "../production/job-state";
import { findWarehouseInScope } from "./warehouse-service";
import { checkReplay, findByClientRequestId, postMovementInTransaction, readBalance, toMovementView } from "./stock-core";
import { mapStockTriggerError } from "./stock-errors";
import { computeFgGenealogy } from "./fg-genealogy";
import { computeBatchCostLines, cumulativeGoodOutput, getWipRemaining } from "../costing/wip-fg-transfer";

const D = (v: unknown) => new Prisma.Decimal(String(v));
const MAX_QTY = 1_000_000_000;
const hasAtMost4dp = (n: number) => Math.abs(n * 1e4 - Math.round(n * 1e4)) < 1e-6;

const positiveQty = z.number().finite().positive().max(MAX_QTY).refine(hasAtMost4dp, "quantity supports at most 4 decimal places");
const occurredAtSchema = z.coerce
  .date()
  .refine((d) => d.getTime() <= Date.now() + 5 * 60_000, "occurredAt cannot be in the future")
  .optional();

const FG_RECEIVABLE_STATUSES = new Set<JobStatus>(["released", "in_progress", "completed"]);

const receiveSchema = z.object({
  clientRequestId: z.string().uuid(),
  warehouseId: z.string().uuid(),
  quantity: positiveQty,
  disposition: z.enum(["available", "quarantine"]).default("available"),
  occurredAt: occurredAtSchema,
  qualityNotes: z.string().trim().max(1000).optional(),
});

type BatchRow = Prisma.FinishedGoodsBatchGetPayload<{
  include: {
    costLines: true;
    materialLotLines: { include: { lot: { select: { lotNumber: true } } } };
    job: { select: { jobNumber: true } };
    productItem: { select: { sku: true; name: true } };
  };
}>;

const BATCH_INCLUDE = {
  costLines: { orderBy: { currency: "asc" as const } },
  materialLotLines: { include: { lot: { select: { lotNumber: true } } }, orderBy: { createdAt: "asc" as const } },
  job: { select: { jobNumber: true } },
  productItem: { select: { sku: true, name: true } },
} as const;

// Exported for dispatch-service.ts (Milestone 3): a dispatch draws from and
// debits the SAME FinishedGoodsBatch rows this file owns, so it reuses this
// module's own scope/remaining/cost-resolution logic rather than keeping a
// second, divergence-prone copy of it (the same cross-module reuse
// convention purchase-order-service.ts's findPoInScope/branchWhere already
// established for goods-receipt-service.ts).
export function branchWhere(session: AuthenticatedSession) {
  return session.role === "OWNER_ADMIN" ? {} : { branchId: { in: [...session.branchIds] } };
}

// Takes an explicit client so callers inside a transaction pass `tx` --
// required for correctness under the advisory locks in transferBatch/
// adjustBatch below: reading through the pooled `prisma` client instead
// would still be correct under the default READ COMMITTED isolation this
// app runs at (the prior lock holder's writes are durably committed before
// the lock is granted), but would silently break if either transaction's
// isolation level is ever tightened to REPEATABLE READ/SERIALIZABLE.
export async function remainingOfBatch(db: Pick<Prisma.TransactionClient, "fgBatchMovement">, orgId: string, batchId: string, goodQty: Prisma.Decimal): Promise<Prisma.Decimal> {
  const sum = await db.fgBatchMovement.aggregate({ where: { orgId, batchId }, _sum: { quantity: true } });
  return goodQty.add(D(sum._sum.quantity ?? 0));
}

// --- Cost/genealogy resolution across transfer lineage ----------------------
//
// FinishedGoodsBatchCostLine and FgBatchMaterialLot are append-only tables
// (prevent_mutation() trigger, no UPDATE grant -- see the migration) whose
// rows are totals FOR THE BATCH'S OWN goodQty. transferBatch deliberately
// does NOT write a second set of these rows for the batch it spawns at the
// destination warehouse: goodQty's conservation across a transfer (nothing
// created or destroyed, only moved) means the ORIGINAL rows already describe
// the transferred quantity's cost and lot lineage too, as a fraction of the
// original batch. Writing a second, separate total for the child in an
// append-only table with no way to shrink the source's total afterwards
// would double-count exactly the thing the mandate calls out by name --
// "never count material value twice" applies to a transfer's bookkeeping as
// much as to the original WIP->FG posting. So a transferred batch's cost and
// lot lineage are resolved LIVE, by walking transferredFromBatchId back to
// the one batch in its lineage that actually holds rows (always the batch
// receiveFinishedGoods created -- the only function that ever writes them,
// and the only kind of batch with transferredFromBatchId = null) and scaling
// that batch's totals by this batch's own share of its original goodQty.
async function resolveToRoot(
  db: Pick<Prisma.TransactionClient, "finishedGoodsBatch">,
  orgId: string,
  batch: { id: string; goodQty: Prisma.Decimal; transferredFromBatchId: string | null },
): Promise<{ rootId: string; share: Prisma.Decimal }> {
  let current: { id: string; goodQty: Prisma.Decimal; transferredFromBatchId: string | null } = batch;
  while (current.transferredFromBatchId) {
    const parent = await db.finishedGoodsBatch.findFirst({
      where: { orgId, id: current.transferredFromBatchId },
      select: { id: true, goodQty: true, transferredFromBatchId: true },
    });
    if (!parent) break; // orphaned lineage pointer -- stop rather than throw from a read path
    current = parent;
  }
  if (current.id === batch.id) return { rootId: current.id, share: D(1) };
  const rootGoodQty = D(current.goodQty);
  return { rootId: current.id, share: rootGoodQty.greaterThan(0) ? D(batch.goodQty).div(rootGoodQty) : D(0) };
}

interface CostLineView {
  currency: string;
  materialCost: string;
  labourCost: string | null;
}

export async function resolveCostLines(
  db: Pick<Prisma.TransactionClient, "finishedGoodsBatch" | "finishedGoodsBatchCostLine">,
  orgId: string,
  batch: { id: string; goodQty: Prisma.Decimal; transferredFromBatchId: string | null },
  eager?: { currency: string; materialCost: Prisma.Decimal; labourCost: Prisma.Decimal | null }[],
): Promise<CostLineView[]> {
  if (!batch.transferredFromBatchId && eager) {
    return eager.map((c) => ({ currency: c.currency.trim(), materialCost: c.materialCost.toString(), labourCost: c.labourCost?.toString() ?? null }));
  }
  const { rootId, share } = await resolveToRoot(db, orgId, batch);
  const lines = await db.finishedGoodsBatchCostLine.findMany({ where: { orgId, batchId: rootId }, orderBy: { currency: "asc" } });
  if (rootId === batch.id) return lines.map((l) => ({ currency: l.currency.trim(), materialCost: l.materialCost.toString(), labourCost: l.labourCost?.toString() ?? null }));
  return lines.map((l) => ({
    currency: l.currency.trim(),
    materialCost: l.materialCost.mul(share).toDecimalPlaces(4).toString(),
    labourCost: l.labourCost !== null ? l.labourCost.mul(share).toDecimalPlaces(4).toString() : null,
  }));
}

interface MaterialLotLineView {
  lotId: string;
  lotNumber: string;
  materialItemId: string;
  quantity: string;
}

async function resolveMaterialLots(
  db: Pick<Prisma.TransactionClient, "finishedGoodsBatch" | "fgBatchMaterialLot">,
  orgId: string,
  batch: { id: string; goodQty: Prisma.Decimal; transferredFromBatchId: string | null },
  eager?: { lotId: string; lot: { lotNumber: string }; materialItemId: string; quantity: Prisma.Decimal }[],
): Promise<MaterialLotLineView[]> {
  if (!batch.transferredFromBatchId && eager) {
    return eager.map((l) => ({ lotId: l.lotId, lotNumber: l.lot.lotNumber, materialItemId: l.materialItemId, quantity: l.quantity.toString() }));
  }
  const { rootId, share } = await resolveToRoot(db, orgId, batch);
  const lines = await db.fgBatchMaterialLot.findMany({ where: { orgId, batchId: rootId }, include: { lot: { select: { lotNumber: true } } }, orderBy: { createdAt: "asc" } });
  if (rootId === batch.id) return lines.map((l) => ({ lotId: l.lotId, lotNumber: l.lot.lotNumber, materialItemId: l.materialItemId, quantity: l.quantity.toString() }));
  return lines.map((l) => ({ lotId: l.lotId, lotNumber: l.lot.lotNumber, materialItemId: l.materialItemId, quantity: l.quantity.mul(share).toDecimalPlaces(4).toString() }));
}

async function toBatchView(row: BatchRow, showCost: boolean) {
  const [materialLots, costLines] = await Promise.all([
    resolveMaterialLots(prisma, row.orgId, row, row.materialLotLines),
    showCost ? resolveCostLines(prisma, row.orgId, row, row.costLines) : Promise.resolve<CostLineView[]>([]),
  ]);
  return {
    id: row.id,
    batchNumber: row.batchNumber,
    productItemId: row.productItemId,
    productSku: row.productItem.sku,
    productName: row.productItem.name,
    jobId: row.jobId,
    jobNumber: row.job.jobNumber,
    warehouseId: row.warehouseId,
    goodQty: row.goodQty.toString(),
    uom: row.uom,
    status: row.status,
    qualityNotes: row.qualityNotes,
    producedAt: row.producedAt,
    transferredFromBatchId: row.transferredFromBatchId,
    createdAt: row.createdAt,
    materialLots,
    ...(showCost ? { costLines } : {}),
  };
}

async function findBatchInScope(session: AuthenticatedSession, id: string): Promise<BatchRow | null> {
  if (!z.string().uuid().safeParse(id).success) return null;
  const row = await prisma.finishedGoodsBatch.findFirst({ where: { orgId: session.orgId, id, ...branchWhere(session) }, include: BATCH_INCLUDE });
  return row;
}

/** Picks the single currency (and its cost line) the finished_goods_receipt movement's unit_cost will carry. See the file header for the rule. */
async function chooseReceiptCurrency(
  db: Pick<Prisma.TransactionClient, "stockBalance" | "organization">,
  session: AuthenticatedSession,
  productItemId: string,
  warehouseId: string,
  costLines: { currency: string; materialCost: Prisma.Decimal; labourCost: Prisma.Decimal | null }[],
): Promise<{ currency: string; unitCost: Prisma.Decimal } | null> {
  if (costLines.length === 0) return null;
  const totalOf = (c: (typeof costLines)[number]) => c.materialCost.add(c.labourCost ?? D(0));

  const existingBalance = await db.stockBalance.findUnique({ where: { itemId_warehouseId: { itemId: productItemId, warehouseId } } });
  if (existingBalance && existingBalance.averageUnitCostCurrency) {
    const match = costLines.find((c) => c.currency === existingBalance.averageUnitCostCurrency!.trim());
    if (!match) return null; // caller turns this into a clear ConflictError
    return { currency: match.currency, unitCost: totalOf(match) };
  }

  const org = await db.organization.findUnique({ where: { id: session.orgId }, select: { baseCurrency: true } });
  const base = org ? costLines.find((c) => c.currency === org.baseCurrency.trim()) : undefined;
  if (base) return { currency: base.currency, unitCost: totalOf(base) };
  if (costLines.length === 1) return { currency: costLines[0]!.currency, unitCost: totalOf(costLines[0]!) };
  const dominant = [...costLines].sort((a, b) => totalOf(b).sub(totalOf(a)).toNumber())[0]!;
  return { currency: dominant.currency, unitCost: totalOf(dominant) };
}

/** "How much good output has this job produced, that hasn't yet been received into a finished-goods batch?" Also used by the frontend to bound the receive form. */
export async function getJobFinishedGoodsSummary(session: AuthenticatedSession, jobId: string) {
  assertCapability(session.role, "finished_goods:read");
  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");

  const [produced, batches] = await Promise.all([
    cumulativeGoodOutput(prisma, session.orgId, job.id),
    prisma.finishedGoodsBatch.findMany({ where: { orgId: session.orgId, jobId: job.id }, include: BATCH_INCLUDE, orderBy: [{ producedAt: "desc" }, { id: "desc" }] }),
  ]);
  const receivedToFg = batches.reduce((t, b) => t.add(D(b.goodQty)), D(0));
  const showCost = hasCapability(session.role, "cost:read");
  // Mirrors listFinishedGoodsBatches's own "remaining needs the ledger sum
  // per batch" note -- included here too so this tab can show, per batch,
  // how much of what this job produced is still on hand vs. transferred or
  // adjusted away, without a second round-trip per batch from the caller.
  return {
    jobId: job.id,
    producedGoodQty: produced.toString(),
    receivedToFinishedGoodsQty: receivedToFg.toString(),
    uncommittedGoodQty: Prisma.Decimal.max(produced.sub(receivedToFg), 0).toString(),
    batches: await Promise.all(
      batches.map(async (b) => ({
        ...(await toBatchView(b, showCost)),
        remaining: (await remainingOfBatch(prisma, session.orgId, b.id, D(b.goodQty))).toString(),
      })),
    ),
  };
}

export async function receiveFinishedGoods(session: AuthenticatedSession, jobId: string, input: unknown) {
  assertCapability(session.role, "finished_goods:receive");
  const parsed = receiveSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid finished-goods receipt", parsed.error.issues);
  const d = parsed.data;

  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");

  const warehouse = await findWarehouseInScope(session, d.warehouseId);
  if (!warehouse) throw new NotFoundError("Warehouse");

  // Idempotency: this whole operation is anchored to the ONE StockMovement it creates.
  const existing = await findByClientRequestId(session.orgId, d.clientRequestId);
  if (existing) {
    const r = checkReplay(existing, {
      warehouse: { id: warehouse.id, branchId: warehouse.branchId },
      itemId: job.productItemId,
      movementType: "finished_goods_receipt",
      quantity: D(d.quantity),
      unitCost: existing.unitCost ? D(existing.unitCost) : null,
      currency: existing.currency,
      referenceType: "production_job",
      referenceId: job.id,
      reason: null,
      clientRequestId: d.clientRequestId,
    });
    const batch = await prisma.finishedGoodsBatch.findFirst({ where: { orgId: session.orgId, producedMovementId: r.movement.id }, include: BATCH_INCLUDE });
    return {
      replayed: true,
      batch: batch ? await toBatchView(batch, hasCapability(session.role, "cost:read")) : null,
      movement: toMovementView(session.role, r.movement),
      balance: await readBalance(session, job.productItemId, warehouse.id),
    };
  }

  if (!FG_RECEIVABLE_STATUSES.has(job.status as JobStatus)) {
    throw new ConflictError(`Finished goods cannot be received for a job that is "${job.status}"`);
  }
  if (warehouse.branchId !== job.branchId) throw new ValidationError("Finished goods can only be received into a warehouse in the same branch as the job");
  if (!warehouse.isActive) throw new ValidationError("Cannot receive finished goods into an inactive warehouse");

  const product = await prisma.item.findFirst({ where: { orgId: session.orgId, id: job.productItemId } });
  if (!product) throw new NotFoundError("Product");

  const quantity = D(d.quantity);
  let batchId: string;
  let movementId: string;
  try {
    ({ batchId, movementId } = await prisma.$transaction(async (tx) => {
      // Serialises every receive against this job: the uncommitted-quantity
      // bound below must be read and acted on atomically, or two concurrent
      // receives could each see enough headroom and together over-receive.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${job.id}, 17))`;

      const produced = await cumulativeGoodOutput(tx, session.orgId, job.id);
      const alreadyReceived = await tx.finishedGoodsBatch.aggregate({ where: { orgId: session.orgId, jobId: job.id }, _sum: { goodQty: true } });
      const uncommitted = produced.sub(D(alreadyReceived._sum.goodQty ?? 0));
      if (quantity.greaterThan(uncommitted)) {
        throw new ValidationError(
          `Only ${Prisma.Decimal.max(uncommitted, 0).toString()} ${product.uom} of good output has been recorded for this job and not yet received into finished goods -- cannot receive ${quantity.toString()}`,
        );
      }

      const costLines = await computeBatchCostLines(tx, session.orgId, job.id, quantity, produced);
      if (costLines.length === 0) {
        throw new ValidationError("No costed material or labour has been recorded for this job yet -- a cost basis is required before finished goods can be received");
      }
      const chosen = await chooseReceiptCurrency(tx, session, job.productItemId, warehouse.id, costLines);
      if (!chosen) {
        throw new ConflictError(
          "This item's finished-goods stock in this warehouse already has a cost basis in a currency this job has no cost recorded in -- post an exchange-rate-based cost adjustment, or receive into a different warehouse",
        );
      }

      // Batch numbering: same advisory-lock + MAX pattern every sequential
      // number in this codebase uses (lot/job/sales-order/purchase-order).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"fg_batch_number:" + session.orgId}))`;
      const last = await tx.$queryRaw<{ n: number | null }[]>`
        SELECT MAX(substring(batch_number from '^FG-([0-9]+)$')::int) AS n
          FROM finished_goods_batch WHERE org_id = ${session.orgId}::uuid`;
      const batchNumber = `FG-${String((last[0]?.n ?? 0) + 1).padStart(6, "0")}`;
      const occurredAt = d.occurredAt ?? new Date();

      const movement = await postMovementInTransaction(tx, session, {
        warehouse: { id: warehouse.id, branchId: warehouse.branchId },
        itemId: job.productItemId,
        movementType: "finished_goods_receipt",
        quantity,
        unitCost: chosen.unitCost,
        currency: chosen.currency,
        referenceType: "production_job",
        referenceId: job.id,
        reason: null,
        clientRequestId: d.clientRequestId,
        occurredAt,
      });

      const batch = await tx.finishedGoodsBatch.create({
        data: {
          orgId: session.orgId,
          branchId: job.branchId,
          batchNumber,
          productItemId: job.productItemId,
          jobId: job.id,
          warehouseId: warehouse.id,
          producedMovementId: movement.id,
          goodQty: quantity,
          uom: product.uom,
          status: d.disposition === "quarantine" ? "quarantined" : "active",
          qualityNotes: d.qualityNotes ?? null,
          producedAt: occurredAt,
          createdById: session.userId,
        },
      });

      await tx.finishedGoodsBatchCostLine.createMany({
        data: costLines.map((c) => ({ orgId: session.orgId, batchId: batch.id, currency: c.currency, materialCost: c.materialCost, labourCost: c.labourCost })),
      });

      const genealogy = await computeFgGenealogy(tx, session.orgId, job.id, quantity);
      if (genealogy.length > 0) {
        await tx.fgBatchMaterialLot.createMany({
          data: genealogy.map((g) => ({
            orgId: session.orgId,
            batchId: batch.id,
            lotId: g.lotId,
            lotConsumptionId: g.lotConsumptionId,
            materialItemId: g.materialItemId,
            quantity: g.quantity,
          })),
        });
      }

      await recordAudit(tx, {
        orgId: session.orgId,
        branchId: job.branchId,
        actorUserId: session.userId,
        entityType: "finished_goods_batch",
        entityId: batch.id,
        action: "create",
        afterValue: { jobId: job.id, batchNumber, goodQty: quantity.toString(), warehouseId: warehouse.id, disposition: d.disposition },
      });

      return { batchId: batch.id, movementId: movement.id };
    }));
  } catch (err) {
    throw mapStockTriggerError(err);
  }

  const [batch, movement] = await Promise.all([
    prisma.finishedGoodsBatch.findFirst({ where: { orgId: session.orgId, id: batchId }, include: BATCH_INCLUDE }),
    prisma.stockMovement.findFirst({ where: { orgId: session.orgId, id: movementId } }),
  ]);
  return {
    replayed: false,
    batch: batch ? await toBatchView(batch, hasCapability(session.role, "cost:read")) : null,
    movement: movement ? toMovementView(session.role, movement as unknown as Parameters<typeof toMovementView>[1]) : null,
    balance: await readBalance(session, job.productItemId, warehouse.id),
  };
}

// ---------------------------------------------------------------------------
// Browsing
// ---------------------------------------------------------------------------

const listFilterSchema = z.object({
  productItemId: z.string().uuid().optional(),
  warehouseId: z.string().uuid().optional(),
  jobId: z.string().uuid().optional(),
  status: z.enum(["active", "quarantined", "rejected"]).optional(),
  search: z.string().trim().max(100).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export async function listFinishedGoodsBatches(session: AuthenticatedSession, filter: unknown = {}) {
  assertCapability(session.role, "finished_goods:read");
  const parsed = listFilterSchema.safeParse(filter);
  if (!parsed.success) throw new ValidationError("Invalid filter", parsed.error.issues);
  const f = parsed.data;

  const rows = await prisma.finishedGoodsBatch.findMany({
    where: {
      orgId: session.orgId,
      ...branchWhere(session),
      ...(f.productItemId ? { productItemId: f.productItemId } : {}),
      ...(f.warehouseId ? { warehouseId: f.warehouseId } : {}),
      ...(f.jobId ? { jobId: f.jobId } : {}),
      ...(f.status ? { status: f.status } : {}),
      ...(f.search ? { batchNumber: { contains: f.search, mode: "insensitive" } } : {}),
    },
    include: BATCH_INCLUDE,
    orderBy: [{ producedAt: "desc" }, { id: "desc" }],
    take: f.limit ?? 300,
  });
  const showCost = hasCapability(session.role, "cost:read");
  // "remaining" needs the ledger sum per batch; cheap enough done as one query.
  const sums = await prisma.fgBatchMovement.groupBy({ by: ["batchId"], where: { orgId: session.orgId, batchId: { in: rows.map((r) => r.id) } }, _sum: { quantity: true } });
  const remainingByBatch = new Map(sums.map((s) => [s.batchId, D(s._sum.quantity ?? 0)]));
  return Promise.all(rows.map(async (r) => ({ ...(await toBatchView(r, showCost)), remaining: D(r.goodQty).add(remainingByBatch.get(r.id) ?? D(0)).toString() })));
}

export async function getBatchDetail(session: AuthenticatedSession, id: string) {
  assertCapability(session.role, "finished_goods:read");
  const row = await findBatchInScope(session, id);
  if (!row) throw new NotFoundError("Finished-goods batch");
  const remaining = await remainingOfBatch(prisma, session.orgId, row.id, D(row.goodQty));
  const movements = await prisma.fgBatchMovement.findMany({ where: { orgId: session.orgId, batchId: row.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }] });
  return {
    ...(await toBatchView(row, hasCapability(session.role, "cost:read"))),
    remaining: remaining.toString(),
    movements: movements.map((m) => ({ id: m.id, type: m.type, quantity: m.quantity.toString(), reason: m.reason, movementId: m.movementId, createdAt: m.createdAt })),
  };
}

export async function getBatchTraceability(session: AuthenticatedSession, id: string) {
  assertCapability(session.role, "finished_goods:read");
  const row = await findBatchInScope(session, id);
  if (!row) throw new NotFoundError("Finished-goods batch");

  // Lot lineage, resolved live for a transferred batch -- see
  // resolveMaterialLots's header for why fg_batch_material_lot is never
  // duplicated onto a transferred batch.
  const materialLots = await resolveMaterialLots(prisma, session.orgId, row, row.materialLotLines);

  // Theoretical need (same ratio fg-genealogy.ts used) vs. what was actually
  // attributed -- lets the UI say plainly when a batch's lot lineage is
  // partial, instead of implying completeness it doesn't have.
  const requirements = await prisma.materialRequirement.findMany({ where: { orgId: session.orgId, jobId: row.jobId } });
  const job = await prisma.productionJob.findFirst({ where: { orgId: session.orgId, id: row.jobId }, select: { plannedQty: true } });
  const plannedQty = job ? D(job.plannedQty) : D(1);
  const attributedByMaterial = new Map<string, Prisma.Decimal>();
  for (const l of materialLots) attributedByMaterial.set(l.materialItemId, (attributedByMaterial.get(l.materialItemId) ?? D(0)).add(D(l.quantity)));

  const genealogy = requirements
    .map((r) => {
      const theoretical = D(r.expectedQty).div(plannedQty).mul(D(row.goodQty)).toDecimalPlaces(4);
      const attributed = attributedByMaterial.get(r.materialItemId) ?? D(0);
      return { materialItemId: r.materialItemId, theoreticalQty: theoretical.toString(), attributedQty: attributed.toString(), complete: attributed.greaterThanOrEqualTo(theoretical) };
    })
    .filter((g) => D(g.theoreticalQty).greaterThan(0) || D(g.attributedQty).greaterThan(0));

  // Chain back one more hop: originating lots' own origin (receipt / return),
  // reusing exactly the same chain-walk lot-service.ts's getLotTraceability
  // already built -- but just the lot numbers here, to keep this a single
  // query; the lot's own page gives the full backward chain.

  // Forward chain (Milestone 3): every dispatch this batch (or, for a
  // transferred batch, the exact batch row by id -- dispatch draws from a
  // specific batch regardless of its transfer lineage, same as transfer/
  // adjust already do) was drawn into. dispatch_batch_allocation.batch_id
  // always names the real batch a dispatch debited, so this is a direct
  // lookup, not a resolveToRoot-style scaled reconstruction.
  const dispatchedInto = await prisma.dispatchBatchAllocation.findMany({
    where: { orgId: session.orgId, batchId: row.id },
    include: {
      dispatchLine: {
        include: {
          dispatch: { select: { id: true, dispatchNumber: true, status: true, dispatchedAt: true, salesOrder: { select: { id: true, orderNumber: true, customer: { select: { id: true, name: true } } } } } },
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  const canSeeOrders = hasCapability(session.role, "sales_order:read");
  const dispatches = dispatchedInto.map((a) => ({
    dispatchId: a.dispatchLine.dispatch.id,
    dispatchNumber: a.dispatchLine.dispatch.dispatchNumber,
    status: a.dispatchLine.dispatch.status,
    dispatchedAt: a.dispatchLine.dispatch.dispatchedAt,
    quantity: a.quantity.toString(),
    ...(canSeeOrders
      ? { salesOrderId: a.dispatchLine.dispatch.salesOrder.id, orderNumber: a.dispatchLine.dispatch.salesOrder.orderNumber, customerName: a.dispatchLine.dispatch.salesOrder.customer.name }
      : {}),
  }));

  return {
    batchId: row.id,
    batchNumber: row.batchNumber,
    jobId: row.jobId,
    jobNumber: row.job.jobNumber,
    materialLots,
    genealogyByMaterial: genealogy,
    genealogyNote:
      "Lot lineage is allocated proportionally to this batch's share of the job's BOM-ratio material need, drawn FIFO from the job's recorded lot consumption. It is a documented best-effort trace, not a measured physical one -- this system does not track which physical input quantity became which physical output unit. 'complete: false' means the job's lot-tracked material issues at the time of this batch did not yet cover its full theoretical BOM share (a legitimate usage variance, not an error).",
    dispatches,
    forwardChainNote:
      dispatches.length > 0
        ? "Dispatch traceability shows every shipment this exact batch was drawn into. A batch transferred to another warehouse is tracked there under its own batch id, not here -- see its own traceability for onward dispatches."
        : "Nothing has been dispatched from this batch yet.",
  };
}

// ---------------------------------------------------------------------------
// Transfers, adjustments, status
// ---------------------------------------------------------------------------

const transferSchema = z.object({
  clientRequestId: z.string().uuid(),
  destinationWarehouseId: z.string().uuid(),
  quantity: positiveQty,
  notes: z.string().trim().max(500).optional(),
});

/**
 * Moves part or all of a batch's remaining quantity to another warehouse.
 * Does NOT mutate the source batch's warehouseId (every column but status/
 * qualityNotes is immutable, same discipline as MaterialLot) -- it closes
 * out the transferred quantity with a transfer_out ledger row and spawns a
 * new, linked FinishedGoodsBatch in the destination warehouse, exactly
 * mirroring MaterialLot's quarantine-return child-lot pattern.
 */
export async function transferBatch(session: AuthenticatedSession, id: string, input: unknown) {
  assertCapability(session.role, "finished_goods:manage");
  const parsed = transferSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid transfer request", parsed.error.issues);
  const d = parsed.data;

  const batch = await findBatchInScope(session, id);
  if (!batch) throw new NotFoundError("Finished-goods batch");
  if (batch.status === "rejected") throw new ConflictError("A rejected batch cannot be transferred");

  const destination = await findWarehouseInScope(session, d.destinationWarehouseId);
  if (!destination) throw new NotFoundError("Destination warehouse");
  if (destination.id === batch.warehouseId) throw new ValidationError("Destination warehouse must differ from the batch's current warehouse");
  if (!destination.isActive) throw new ValidationError("Cannot transfer into an inactive warehouse");

  const existing = await prisma.stockMovement.findFirst({ where: { orgId: session.orgId, clientRequestId: d.clientRequestId } });
  if (existing) {
    const spawned = await prisma.finishedGoodsBatch.findFirst({ where: { orgId: session.orgId, transferredFromMovementId: existing.id }, include: BATCH_INCLUDE });
    if (!spawned) throw new ConflictError("clientRequestId was already used for a different request");
    return { replayed: true, batch: await toBatchView(spawned, hasCapability(session.role, "cost:read")) };
  }

  const quantity = D(d.quantity);
  let newBatchId: string;
  try {
    newBatchId = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${batch.id}, 19))`;
      const remaining = await remainingOfBatch(tx, session.orgId, batch.id, D(batch.goodQty));
      if (quantity.greaterThan(remaining)) {
        throw new ValidationError(`Only ${remaining.toString()} ${batch.uom} remains in batch ${batch.batchNumber} -- cannot transfer ${quantity.toString()}`);
      }
      const sourceWarehouse = await tx.warehouse.findFirst({ where: { orgId: session.orgId, id: batch.warehouseId } });
      if (!sourceWarehouse) throw new NotFoundError("Warehouse");

      const outMovement = await postMovementInTransaction(tx, session, {
        warehouse: { id: sourceWarehouse.id, branchId: sourceWarehouse.branchId },
        itemId: batch.productItemId,
        movementType: "stock_transfer_out",
        quantity: quantity.neg(),
        unitCost: null, // the trigger stamps the source warehouse's current average
        currency: null,
        referenceType: "manual",
        referenceId: null,
        reason: d.notes ?? `Transfer of batch ${batch.batchNumber} to ${destination.name}`,
        clientRequestId: d.clientRequestId,
      });
      await tx.fgBatchMovement.create({
        data: { orgId: session.orgId, batchId: batch.id, movementId: outMovement.id, type: "transfer_out", quantity: quantity.neg(), reason: d.notes ?? null, createdById: session.userId },
      });

      const inMovement = await postMovementInTransaction(tx, session, {
        warehouse: { id: destination.id, branchId: destination.branchId },
        itemId: batch.productItemId,
        movementType: "stock_transfer_in",
        quantity,
        // Conserves value across the transfer: the destination receives the
        // exact cost basis the source just had stamped on its own ledger.
        unitCost: D(String(outMovement.unitCost)),
        currency: outMovement.currency,
        referenceType: "manual",
        referenceId: null,
        reason: d.notes ?? `Transfer of batch ${batch.batchNumber} from ${sourceWarehouse.name}`,
        // clientRequestId is @db.Uuid -- cannot derive a second key by
        // suffixing the caller's one. A fresh id is fine: this whole
        // operation's idempotency gate is the OUT movement's clientRequestId
        // (checked against findByClientRequestId before this transaction
        // even opens), so a retry never reaches this line a second time --
        // same "header-level key gates a multi-insert transaction" pattern
        // goods-receipt-service.ts uses for its own secondary inserts.
        clientRequestId: randomUUID(),
      });

      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"fg_batch_number:" + session.orgId}))`;
      const last = await tx.$queryRaw<{ n: number | null }[]>`
        SELECT MAX(substring(batch_number from '^FG-([0-9]+)$')::int) AS n
          FROM finished_goods_batch WHERE org_id = ${session.orgId}::uuid`;
      const batchNumber = `FG-${String((last[0]?.n ?? 0) + 1).padStart(6, "0")}`;

      const newBatch = await tx.finishedGoodsBatch.create({
        data: {
          orgId: session.orgId,
          branchId: destination.branchId,
          batchNumber,
          productItemId: batch.productItemId,
          jobId: batch.jobId,
          warehouseId: destination.id,
          producedMovementId: inMovement.id,
          goodQty: quantity,
          uom: batch.uom,
          status: batch.status,
          producedAt: new Date(),
          createdById: session.userId,
          transferredFromBatchId: batch.id,
          transferredFromMovementId: outMovement.id,
        },
      });

      // Cost and lot genealogy are NOT duplicated onto the new batch here --
      // see resolveCostLines/resolveMaterialLots above for why writing a
      // second total in these append-only tables would double-count the
      // transferred quantity's value. Both are resolved live, by walking
      // transferredFromBatchId (now set, below) back to this batch's
      // original receipt whenever they're read.

      await recordAudit(tx, {
        orgId: session.orgId,
        branchId: destination.branchId,
        actorUserId: session.userId,
        entityType: "finished_goods_batch",
        entityId: newBatch.id,
        action: "create",
        afterValue: { transferredFromBatchId: batch.id, quantity: quantity.toString(), destinationWarehouseId: destination.id },
        reason: d.notes ?? null,
      });

      return newBatch.id;
    });
  } catch (err) {
    throw mapStockTriggerError(err);
  }

  const newBatch = await prisma.finishedGoodsBatch.findFirst({ where: { orgId: session.orgId, id: newBatchId }, include: BATCH_INCLUDE });
  return { replayed: false, batch: newBatch ? await toBatchView(newBatch, hasCapability(session.role, "cost:read")) : null };
}

const adjustSchema = z.object({
  clientRequestId: z.string().uuid(),
  quantity: z.number().finite().refine((n) => n !== 0, "quantity cannot be zero").refine(hasAtMost4dp, "quantity supports at most 4 decimal places"),
  reason: z.string().trim().min(3, "An adjustment needs a reason").max(500),
});

/** A controlled correction to a batch's remaining quantity (e.g. a recount), posted through the same stock ledger every other adjustment uses. */
export async function adjustBatch(session: AuthenticatedSession, id: string, input: unknown) {
  assertCapability(session.role, "finished_goods:manage");
  const parsed = adjustSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid adjustment", parsed.error.issues);
  const d = parsed.data;

  const batch = await findBatchInScope(session, id);
  if (!batch) throw new NotFoundError("Finished-goods batch");

  const existing = await prisma.stockMovement.findFirst({ where: { orgId: session.orgId, clientRequestId: d.clientRequestId } });
  if (existing) {
    const row = await prisma.fgBatchMovement.findFirst({ where: { orgId: session.orgId, movementId: existing.id } });
    if (!row) throw new ConflictError("clientRequestId was already used for a different request");
    return { replayed: true, remaining: (await remainingOfBatch(prisma, session.orgId, batch.id, D(batch.goodQty))).toString() };
  }

  const quantity = D(d.quantity);
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${batch.id}, 19))`;
      const remaining = await remainingOfBatch(tx, session.orgId, batch.id, D(batch.goodQty));
      if (quantity.lessThan(0) && quantity.abs().greaterThan(remaining)) {
        throw new ValidationError(`Only ${remaining.toString()} ${batch.uom} remains in this batch -- cannot adjust it down by ${quantity.abs().toString()}`);
      }
      const warehouse = await tx.warehouse.findFirst({ where: { orgId: session.orgId, id: batch.warehouseId } });
      if (!warehouse) throw new NotFoundError("Warehouse");

      const movement = await postMovementInTransaction(tx, session, {
        warehouse: { id: warehouse.id, branchId: warehouse.branchId },
        itemId: batch.productItemId,
        movementType: "adjustment",
        quantity,
        unitCost: quantity.greaterThan(0) ? await currentAverageCost(tx, batch.productItemId, warehouse.id) : null,
        currency: quantity.greaterThan(0) ? await currentAverageCurrency(tx, batch.productItemId, warehouse.id) : null,
        referenceType: "manual",
        referenceId: null,
        reason: d.reason,
        clientRequestId: d.clientRequestId,
      });
      await tx.fgBatchMovement.create({
        data: { orgId: session.orgId, batchId: batch.id, movementId: movement.id, type: "adjustment", quantity, reason: d.reason, createdById: session.userId },
      });
      await recordAudit(tx, {
        orgId: session.orgId,
        branchId: batch.branchId,
        actorUserId: session.userId,
        entityType: "finished_goods_batch",
        entityId: batch.id,
        action: "update",
        beforeValue: { remaining: remaining.toString() },
        afterValue: { remaining: remaining.add(quantity).toString() },
        reason: d.reason,
      });
    });
  } catch (err) {
    throw mapStockTriggerError(err);
  }
  return { replayed: false, remaining: (await remainingOfBatch(prisma, session.orgId, batch.id, D(batch.goodQty))).toString() };
}

async function currentAverageCost(tx: Prisma.TransactionClient, itemId: string, warehouseId: string): Promise<Prisma.Decimal> {
  const b = await tx.stockBalance.findUnique({ where: { itemId_warehouseId: { itemId, warehouseId } } });
  if (!b || b.averageUnitCost === null) throw new ConflictError("This item has no cost basis in this warehouse yet -- a positive adjustment needs one to increase");
  return D(b.averageUnitCost);
}
async function currentAverageCurrency(tx: Prisma.TransactionClient, itemId: string, warehouseId: string): Promise<string> {
  const b = await tx.stockBalance.findUnique({ where: { itemId_warehouseId: { itemId, warehouseId } } });
  return b!.averageUnitCostCurrency!.trim();
}

const statusSchema = z.object({
  status: z.enum(["active", "quarantined", "rejected"]),
  reason: z.string().trim().min(3, "Say why in at least 3 characters").max(500),
});

/** Manual quality-disposition change (e.g. a hold clears, or a recheck fails). Mirrors lot-service.ts's setLotStatus. */
export async function setBatchStatus(session: AuthenticatedSession, id: string, input: unknown) {
  assertCapability(session.role, "finished_goods:manage");
  const parsed = statusSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid status change", parsed.error.issues);
  const d = parsed.data;

  const batch = await findBatchInScope(session, id);
  if (!batch) throw new NotFoundError("Finished-goods batch");
  if (batch.status === d.status) return getBatchDetail(session, id);

  await prisma.$transaction(async (tx) => {
    const res = await tx.finishedGoodsBatch.updateMany({ where: { orgId: session.orgId, id: batch.id, status: batch.status }, data: { status: d.status } });
    if (res.count !== 1) throw new ConflictError("This batch's status was changed by someone else -- reload and retry");
    await recordAudit(tx, {
      orgId: session.orgId,
      branchId: batch.branchId,
      actorUserId: session.userId,
      entityType: "finished_goods_batch",
      entityId: batch.id,
      action: "update",
      beforeValue: { status: batch.status },
      afterValue: { status: d.status },
      reason: d.reason,
    });
  });
  return getBatchDetail(session, id);
}

// ---------------------------------------------------------------------------
// Valuation
// ---------------------------------------------------------------------------

/** Finished-goods inventory valuation: reuses the existing (item, warehouse) stock_balance -- the single source of truth for quantity and weighted-average cost -- filtered to finished_good/wip items. No separate valuation figure is computed or stored. */
export async function getFinishedGoodsValuation(session: AuthenticatedSession) {
  assertCapability(session.role, "finished_goods:read");
  const showCost = hasCapability(session.role, "cost:read");
  const balances = await prisma.stockBalance.findMany({
    where: {
      item: { orgId: session.orgId, itemType: { in: ["finished_good", "wip"] } },
      ...(session.role === "OWNER_ADMIN" ? {} : { warehouse: { branchId: { in: [...session.branchIds] } } }),
    },
    include: { item: { select: { sku: true, name: true, uom: true } }, warehouse: { select: { name: true, branchId: true } } },
    orderBy: [{ itemId: "asc" }, { warehouseId: "asc" }],
  });
  return balances.map((b) => ({
    itemId: b.itemId,
    sku: b.item.sku,
    itemName: b.item.name,
    uom: b.item.uom,
    warehouseId: b.warehouseId,
    warehouseName: b.warehouse.name,
    quantity: b.quantity.toString(),
    ...(showCost
      ? {
          averageUnitCost: b.averageUnitCost?.toString() ?? null,
          averageUnitCostCurrency: b.averageUnitCostCurrency,
          totalValue: b.averageUnitCost ? D(b.quantity).mul(D(b.averageUnitCost)).toDecimalPlaces(4).toString() : null,
        }
      : {}),
  }));
}

/** WIP valuation for one job (live, from wip-fg-transfer.ts) or, with no jobId, every open job's WIP in the caller's scope. */
export async function getWipValuation(session: AuthenticatedSession, jobId?: string) {
  assertCapability(session.role, "cost:read");
  if (jobId) {
    const job = await findJobInScope(session, jobId);
    if (!job) throw new NotFoundError("Production job");
    const lines = await getWipRemaining(prisma, session.orgId, job.id);
    return { jobId: job.id, jobNumber: job.jobNumber, lines: lines.map(serializeWipLine) };
  }
  const jobs = await prisma.productionJob.findMany({
    where: { orgId: session.orgId, status: { in: ["released", "in_progress", "on_hold"] }, ...(session.role === "OWNER_ADMIN" ? {} : { branchId: { in: [...session.branchIds] } }) },
    select: { id: true, jobNumber: true },
    take: 200,
  });
  const out = [];
  for (const j of jobs) {
    const lines = await getWipRemaining(prisma, session.orgId, j.id);
    if (lines.some((l) => l.remainingMaterialCost.greaterThan(0) || (l.remainingLabourCost && l.remainingLabourCost.greaterThan(0)))) {
      out.push({ jobId: j.id, jobNumber: j.jobNumber, lines: lines.map(serializeWipLine) });
    }
  }
  return out;
}

function serializeWipLine(l: Awaited<ReturnType<typeof getWipRemaining>>[number]) {
  return {
    currency: l.currency,
    actualMaterialCost: l.actualMaterialCost.toString(),
    actualLabourCost: l.actualLabourCost?.toString() ?? null,
    transferredMaterialCost: l.transferredMaterialCost.toString(),
    transferredLabourCost: l.transferredLabourCost?.toString() ?? null,
    remainingMaterialCost: l.remainingMaterialCost.toString(),
    remainingLabourCost: l.remainingLabourCost?.toString() ?? null,
  };
}
