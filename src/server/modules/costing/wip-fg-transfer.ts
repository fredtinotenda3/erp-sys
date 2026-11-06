// The Raw-Materials -> WIP -> Finished-Goods cost flow (Milestone 2's
// non-negotiable #3). There is no physical "WIP" stock_balance row in this
// system (schema.prisma's comment on StockMovement/MaterialLot already
// explains material_requirement/material consumption posts directly against
// the RAW MATERIAL item, never a separate WIP item) -- WIP is, and remains, a
// purely computed accounting bucket: a job's live actual cost
// (actual-cost.ts's computeActualCostLines, unchanged by this milestone)
// MINUS whatever has already been transferred out of it into finished-goods
// batches (FinishedGoodsBatchCostLine, this milestone). This file is the
// single place that boundary is computed, so the live view a manager sees
// and the amount actually transferred at receipt time can never drift apart.
//
// NEVER COUNT MATERIAL VALUE TWICE: a finished-goods receipt does not re-read
// or re-charge any raw-material cost. It reads the job's ALREADY-RECOGNISED
// actual cost (the same ledger-derived figure the live job-cost view and the
// completion snapshot already use) and allocates a share of THAT existing
// total to the new batch -- it is a transfer within the valuation model, not
// a second charge. The clamp in computeBatchCostLines below is what makes
// this provable: the sum of every batch's allocated cost for a job, in any
// currency, can never exceed that job's own actual cost in that currency at
// the moment of computation.
//
// BOUNDARY WITH GENERAL-LEDGER INTEGRATION (per the mandate's "Financial
// accounting" non-negotiable): this module, and the FinishedGoodsBatchCostLine
// rows it writes, are an OPERATIONAL inventory/WIP valuation subledger --
// weighted-average cost of goods actually consumed and labour actually
// recorded, grouped by currency. It is NOT a general ledger: there is no
// chart of accounts, no journal entry, no debit/credit posting, and no
// period close here. Connecting this subledger's balances to a real GL
// (e.g. posting a "WIP" and "Finished Goods" account movement per batch) is
// explicitly future integration work, not something this milestone claims.
//
// KNOWN LIMITATION (documented, not silently ignored -- see
// IMPLEMENTATION_MANIFEST.md): computeActualCostLines deliberately reads
// ONLY the live, immutable ledgers (stock_movement, labour_record) -- see
// that function's own header. It never reads JobCostAdjustment.
// cost-adjustment-service.ts's recordCostAdjustment can ONLY be called once
// a job is "completed" or "closed" (its own guard), and corrects the FROZEN
// JobCostActualLine snapshot, not the live ledger -- "effective actual cost"
// elsewhere in this codebase is snapshot + adjustments, a figure this module
// does not compute. Consequence: if a finance adjustment is posted to a
// completed job BEFORE every unit of that job's good output has been
// received into a finished-goods batch, the remaining batch(es)' cost lines
// will be allocated from the PRE-adjustment live total, not the corrected
// one -- the adjustment amount will not reach FinishedGoodsBatchCostLine.
// Operational mitigation: receive all of a job's finished goods before
// posting a cost adjustment against it (the common real-world order
// already, since adjustments correct a frozen snapshot after the fact).
// Closing this gap exactly would mean teaching the live-ledger computation
// about a snapshot-and-adjustment flow it is intentionally decoupled from --
// out of scope for this milestone; flagged here rather than fixed so it is
// not mistaken for "never count material value twice" being unmet (the
// clamp below still holds for every value this module DOES see).
import { Prisma } from "../../../generated/prisma/client";
import { computeActualCostLines } from "./actual-cost";
import { loadShopfloor } from "../production/shopfloor-data";
import { jobTotals } from "../production/shopfloor-math";

const D = (v: unknown) => new Prisma.Decimal(String(v));

type Tx = Prisma.TransactionClient;

export interface BatchCostLine {
  currency: string;
  materialCost: Prisma.Decimal;
  labourCost: Prisma.Decimal | null;
}

/** Cumulative "good" output the shop floor has recorded for this job so far (ProductionOutput, net of reclassification and voids). */
export async function cumulativeGoodOutput(db: Tx, orgId: string, jobId: string): Promise<Prisma.Decimal> {
  const s = await loadShopfloor(db, orgId, jobId);
  return D(jobTotals(s.stages, s.outputs).effectiveGood);
}

/**
 * This batch's allocated share of the job's live actual cost, one row per
 * currency, clamped so the cumulative allocation across every batch of this
 * job can never exceed the job's own actual cost in that currency. Must run
 * inside the same transaction that will write the returned lines (read-your-
 * writes consistency against FinishedGoodsBatchCostLine's "already
 * allocated" totals).
 */
export async function computeBatchCostLines(
  tx: Tx,
  orgId: string,
  jobId: string,
  batchGoodQty: Prisma.Decimal,
  cumulativeGoodToDate: Prisma.Decimal,
): Promise<BatchCostLine[]> {
  if (cumulativeGoodToDate.lessThanOrEqualTo(0)) return [];
  const linesByJob = await computeActualCostLines(tx, orgId, [jobId]);
  const lines = linesByJob.get(jobId) ?? [];
  if (lines.length === 0) return [];

  const already = await tx.finishedGoodsBatchCostLine.groupBy({
    by: ["currency"],
    where: { orgId, batch: { jobId } },
    _sum: { materialCost: true, labourCost: true },
  });
  const allocatedByCurrency = new Map(
    already.map((a) => [a.currency, { material: D(a._sum.materialCost ?? 0), labour: D(a._sum.labourCost ?? 0) }]),
  );

  const out: BatchCostLine[] = [];
  for (const line of lines) {
    const unitMaterial = line.materialCost.div(cumulativeGoodToDate);
    const rawMaterial = unitMaterial.mul(batchGoodQty).toDecimalPlaces(4);
    const prior = allocatedByCurrency.get(line.currency) ?? { material: D(0), labour: D(0) };
    const materialHeadroom = Prisma.Decimal.max(line.materialCost.sub(prior.material), D(0));
    const materialCost = Prisma.Decimal.min(rawMaterial, materialHeadroom);

    let labourCost: Prisma.Decimal | null = null;
    if (line.labourCost !== null) {
      const unitLabour = line.labourCost.div(cumulativeGoodToDate);
      const rawLabour = unitLabour.mul(batchGoodQty).toDecimalPlaces(4);
      const labourHeadroom = Prisma.Decimal.max(line.labourCost.sub(prior.labour), D(0));
      labourCost = Prisma.Decimal.min(rawLabour, labourHeadroom);
    }
    // A line with genuinely zero allocatable cost (fully allocated to
    // earlier batches already) is still recorded as zero, not omitted --
    // omitting it would make the batch's cost-line set look like "this
    // currency was never involved", which would be false.
    out.push({ currency: line.currency, materialCost, labourCost });
  }
  return out;
}

/**
 * Live "how much WIP cost is still sitting on this job, not yet transferred
 * to any finished-goods batch" -- per currency, never summed across
 * currencies, never stored. Used by the WIP valuation report.
 */
export async function getWipRemaining(db: Tx | Prisma.TransactionClient, orgId: string, jobId: string) {
  const linesByJob = await computeActualCostLines(db, orgId, [jobId]);
  const lines = linesByJob.get(jobId) ?? [];
  const already = await db.finishedGoodsBatchCostLine.groupBy({
    by: ["currency"],
    where: { orgId, batch: { jobId } },
    _sum: { materialCost: true, labourCost: true },
  });
  const allocatedByCurrency = new Map(
    already.map((a) => [a.currency, { material: D(a._sum.materialCost ?? 0), labour: D(a._sum.labourCost ?? 0) }]),
  );
  return lines.map((line) => {
    const prior = allocatedByCurrency.get(line.currency) ?? { material: D(0), labour: D(0) };
    const materialRemaining = Prisma.Decimal.max(line.materialCost.sub(prior.material), D(0));
    const labourRemaining = line.labourCost !== null ? Prisma.Decimal.max(line.labourCost.sub(prior.labour), D(0)) : null;
    return {
      currency: line.currency,
      actualMaterialCost: line.materialCost,
      actualLabourCost: line.labourCost,
      transferredMaterialCost: Prisma.Decimal.min(prior.material, line.materialCost),
      transferredLabourCost: line.labourCost !== null ? Prisma.Decimal.min(prior.labour, line.labourCost) : null,
      remainingMaterialCost: materialRemaining,
      remainingLabourCost: labourRemaining,
    };
  });
}
