// The completion-cost snapshot (Phase 2 §3).
//
// WHEN: only inside the transaction that moves a job to "completed" (the DB
//   refuses a snapshot for any other job state, and refuses currency lines
//   unless they are written in the header's own transaction).
// WHAT IT FREEZES: actual cost per currency (derived from the immutable ledgers
//   by the SAME function the live view uses), the quote at completion, and
//   -- new -- what was known and unknown: `completeness` (named missing
//   components) and `evidence` (how many ledger/labour rows were counted).
// INCOMPLETE COSTS: completion is an operational act and is never blocked by a
//   finance data gap. The gap is recorded in the snapshot and blocks margin
//   and variance claims instead; closing the gap is an explicit, audited cost
//   adjustment (cost-adjustment-service.ts), never an edit.
// CURRENCY: lines are stored in their native currency. No conversion is frozen;
//   any later conversion cites an exchange-rate row chosen by rule (see
//   cost-service.ts), so the same question always gets the same answer.
// CONCURRENCY: the caller holds the job's exclusive advisory lock and has
//   already won the status compare-and-set, so there is exactly one snapshot.
import { Prisma } from "../../../generated/prisma/client";
import { computeActualCostLines, computeConsumptionEvidence } from "./actual-cost";
import { assessCompleteness, type Completeness } from "./cost-completeness";
import { summarizeShopfloor } from "../production/shopfloor-data";

type Tx = Prisma.TransactionClient;

export interface SnapshotJob {
  id: string;
  quotedAmount: Prisma.Decimal | null;
  quotedCurrency: string | null;
}

export async function lockJobForCompletion(tx: Tx, jobId: string): Promise<void> {
  // Exclusive side of the lock the ledger/labour insert triggers take shared.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${jobId}, 7))`;
}

export async function createCompletionSnapshot(tx: Tx, orgId: string, job: SnapshotJob) {
  const actual = (await computeActualCostLines(tx, orgId, [job.id])).get(job.id) ?? [];
  const evidence = await computeConsumptionEvidence(tx, orgId, job.id);
  const estimate = await tx.jobCostEstimate.findUnique({ where: { jobId: job.id } });
  const shopfloor = await summarizeShopfloor(tx, orgId, job.id);
  const unpriced = Array.isArray(estimate?.unpricedMaterials) ? (estimate!.unpricedMaterials as { materialItemId: string; reason: string }[]) : [];

  const completeness: Completeness = assessCompleteness({
    isFinal: true,
    hasEstimate: estimate !== null,
    unpricedMaterials: unpriced,
    uncostedConsumptionCount: evidence.uncostedMovements,
    costedConsumptionCount: evidence.costedMovements,
    labourRecordCount: evidence.labourRecords,
  });

  await tx.jobCostActual.create({
    data: {
      orgId,
      jobId: job.id,
      revenue: job.quotedAmount,
      revenueCurrency: job.quotedCurrency,
      completeness: completeness as unknown as Prisma.InputJsonValue,
      evidence: {
        costedMovements: evidence.costedMovements,
        uncostedMovements: evidence.uncostedMovements,
        lastMovementAt: evidence.lastMovementAt ? evidence.lastMovementAt.toISOString() : null,
        labourRecords: evidence.labourRecords,
        labourHours: evidence.labourHours,
        estimateComputedAt: estimate ? estimate.computedAt.toISOString() : null,
        unpricedMaterials: unpriced,
        // Quantities only (no money): output, yield and inspections as they stood at completion.
        shopfloor: shopfloor as unknown as Prisma.InputJsonValue,
        source: "ledger_and_labour_records_at_completion",
      },
    },
  });
  if (actual.length > 0) {
    await tx.jobCostActualLine.createMany({
      data: actual.map((l) => ({
        orgId,
        jobId: job.id,
        currency: l.currency,
        actualMaterialCost: l.materialCost,
        actualLabourCost: l.labourCost,
        actualOverheadCost: null, // unavailable: no allocation method approved
      })),
    });
  }
  return { actual, completeness };
}
