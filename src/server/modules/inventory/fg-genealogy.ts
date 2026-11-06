// Finished-goods lot genealogy: for one newly-created FinishedGoodsBatch,
// work out which material-lot quantities (already consumed by the batch's
// job, via LotConsumption -- Milestone 1) should be attributed to THIS
// batch, as opposed to any other batch the same job has produced or will
// produce.
//
// THE PROBLEM: a job's material issue is recorded once, against the WHOLE
// job (allocateLotsForConsumption, material-issue-service.ts) -- it is not
// recorded per unit of output, because this system (like most real shop
// floors) does not track exactly which physical input quantity ended up in
// exactly which physical output unit. A job may draw from several lots over
// its life and may complete in several batches over its life; the mandate
// requires each batch to carry correct, non-duplicated lot lineage ("do not
// incorrectly attach every material lot consumed by a job to every output
// batch").
//
// THE ALGORITHM (a documented, defensible allocation rule -- not a
// fabricated exact physical trace, which this system's data does not
// support):
//   1. For each material the job's BOM requires, this batch's THEORETICAL
//      need = (that material's BOM ratio, i.e. MaterialRequirement.expectedQty
//      / job.plannedQty) x this batch's goodQty. This is exactly the same
//      ratio job-service.ts used to compute the requirement in the first
//      place, so it is consistent with the job's own cost estimate.
//   2. The pool available to draw from is that material's net lot
//      consumption by this job (LotConsumption summed per lot, consumption
//      positive/return negative) MINUS whatever has already been attributed
//      to an earlier batch of the same job (FgBatchMaterialLot, summed per
//      lot). This guarantees no lot quantity is ever attributed twice.
//   3. Draw from that pool in FIFO order of first consumption (the order
//      lots were first drawn from for this job) -- the same "earliest first"
//      principle allocateLotsForConsumption itself uses for FEFO, applied
//      here to allocation instead of selection.
//   4. If the pool is short (e.g. output ran ahead of the ratio the BOM
//      implies -- a legitimate material-usage variance, same as
//      over-issue), allocate whatever IS available and stop: genealogy is
//      best-effort, never a reason to block a completion that is otherwise
//      valid. The batch's traceability view says plainly when its lineage is
//      partial -- see finished-goods-service.ts's getBatchTraceability.
//
// An item with no LotConsumption rows at all for this job (never lot-tracked,
// same backward-compatible no-op as material-issue-service.ts) gets no
// genealogy rows for that material -- exactly the same "untouched, pre-
// existing behaviour" rule Milestone 1 established.
import { Prisma } from "../../../generated/prisma/client";

const D = (v: unknown) => new Prisma.Decimal(String(v));

type Tx = Prisma.TransactionClient;

export interface FgGenealogyAllocation {
  lotId: string;
  materialItemId: string;
  lotConsumptionId: string | null;
  quantity: Prisma.Decimal;
}

/**
 * Computes (but does not write) this batch's lot genealogy. Must be called
 * inside the same transaction that will write the rows and the batch itself,
 * after the job's material requirements and lot consumption are already
 * committed-within-transaction, so "already allocated to earlier batches" is
 * read-your-writes consistent.
 */
export async function computeFgGenealogy(
  tx: Tx,
  orgId: string,
  jobId: string,
  batchGoodQty: Prisma.Decimal,
): Promise<FgGenealogyAllocation[]> {
  const job = await tx.productionJob.findFirst({ where: { orgId, id: jobId }, select: { plannedQty: true } });
  if (!job) return [];
  const plannedQty = D(job.plannedQty);
  if (plannedQty.lessThanOrEqualTo(0)) return [];

  const requirements = await tx.materialRequirement.findMany({ where: { orgId, jobId } });
  const allocations: FgGenealogyAllocation[] = [];

  for (const req of requirements) {
    // Chronological consumption/return rows for this job and this material's lots.
    const rows = await tx.lotConsumption.findMany({
      where: { orgId, jobId, lot: { itemId: req.materialItemId } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, lotId: true, quantity: true, createdAt: true },
    });
    if (rows.length === 0) continue; // this material was never lot-tracked for this job

    // Net consumption per lot, and the id of its EARLIEST consumption row
    // (used to attribute genealogy quantity to a specific, real ledger
    // entry) and the FIFO order lots first appeared in.
    const order: string[] = [];
    const netByLot = new Map<string, Prisma.Decimal>();
    const firstConsumptionRowByLot = new Map<string, string>();
    for (const r of rows) {
      if (!netByLot.has(r.lotId)) {
        netByLot.set(r.lotId, D(0));
        order.push(r.lotId);
      }
      netByLot.set(r.lotId, netByLot.get(r.lotId)!.add(D(r.quantity)));
      if (!firstConsumptionRowByLot.has(r.lotId) && D(r.quantity).greaterThan(0)) {
        firstConsumptionRowByLot.set(r.lotId, r.id);
      }
    }

    // Already attributed to earlier batches of this same job, per lot.
    const already = await tx.fgBatchMaterialLot.groupBy({
      by: ["lotId"],
      where: { orgId, materialItemId: req.materialItemId, batch: { jobId } },
      _sum: { quantity: true },
    });
    const allocatedByLot = new Map(already.map((a) => [a.lotId, D(a._sum.quantity ?? 0)]));

    // This batch's theoretical share of this material, same ratio job-service.ts used.
    const ratio = D(req.expectedQty).div(plannedQty);
    let need = ratio.mul(batchGoodQty).toDecimalPlaces(4);
    if (need.lessThanOrEqualTo(0)) continue;

    for (const lotId of order) {
      if (need.lessThanOrEqualTo(0)) break;
      const net = netByLot.get(lotId) ?? D(0);
      const used = allocatedByLot.get(lotId) ?? D(0);
      const available = net.sub(used);
      if (available.lessThanOrEqualTo(0)) continue;
      const take = Prisma.Decimal.min(need, available);
      if (take.greaterThan(0)) {
        allocations.push({
          lotId,
          materialItemId: req.materialItemId,
          lotConsumptionId: firstConsumptionRowByLot.get(lotId) ?? null,
          quantity: take,
        });
        need = need.sub(take);
      }
    }
    // Any remaining `need` is an honest shortfall (material-usage variance
    // outran the lot-tracked pool available at this moment) -- left
    // unallocated, never invented. See the file header.
  }

  return allocations;
}
