// Actual cost of jobs, DERIVED from the immutable ledgers -- never a stored
// running total. Used for (a) the live view of an in-progress job and (b) the
// snapshot written once at completion. Both call the same function, so the
// number a manager sees mid-job is exactly the number that gets frozen.
//
// Always grouped by currency. Material cost is the weighted-average cost the
// ledger stamped on each consumption; labour is hours x the recorded rate.
import { Prisma } from "../../../generated/prisma/client";

export interface ActualCostLine {
  currency: string;
  materialCost: Prisma.Decimal;
  /** null = no labour recorded in this currency (not "zero"). */
  labourCost: Prisma.Decimal | null;
}

type Raw = Pick<Prisma.TransactionClient, "$queryRaw">;

export async function computeActualCostLines(
  db: Raw,
  orgId: string,
  jobIds: string[],
): Promise<Map<string, ActualCostLine[]>> {
  const out = new Map<string, ActualCostLine[]>();
  if (jobIds.length === 0) return out;
  const idList = Prisma.join(jobIds.map((id) => Prisma.sql`${id}::uuid`));

  // Consumption is stored negative; returns (when added) are positive and
  // offset it. Cost is therefore -SUM(quantity * unit_cost).
  const materials = await db.$queryRaw<{ job_id: string; currency: string; cost: string }[]>(Prisma.sql`
    SELECT reference_id::text AS job_id, currency, round(-SUM(quantity * unit_cost), 4)::text AS cost
    FROM stock_movement
    WHERE org_id = ${orgId}::uuid
      AND reference_type = 'production_job'
      AND movement_type IN ('production_consumption', 'material_return')
      AND currency IS NOT NULL AND unit_cost IS NOT NULL
      AND reference_id IN (${idList})
    GROUP BY reference_id, currency`);

  const labour = await db.$queryRaw<{ job_id: string; currency: string; cost: string }[]>(Prisma.sql`
    SELECT job_id::text AS job_id, rate_currency AS currency, round(SUM(hours * rate), 4)::text AS cost
    FROM labour_record
    WHERE org_id = ${orgId}::uuid AND job_id IN (${idList})
    GROUP BY job_id, rate_currency`);

  const key = (j: string, c: string) => `${j}|${c}`;
  const merged = new Map<string, ActualCostLine & { jobId: string }>();
  for (const m of materials) {
    merged.set(key(m.job_id, m.currency), {
      jobId: m.job_id,
      currency: m.currency.trim(),
      materialCost: new Prisma.Decimal(m.cost),
      labourCost: null,
    });
  }
  for (const l of labour) {
    const k = key(l.job_id, l.currency);
    const existing = merged.get(k);
    if (existing) existing.labourCost = new Prisma.Decimal(l.cost);
    else
      merged.set(k, { jobId: l.job_id, currency: l.currency.trim(), materialCost: new Prisma.Decimal(0), labourCost: new Prisma.Decimal(l.cost) });
  }
  for (const { jobId, ...line } of merged.values()) {
    const arr = out.get(jobId) ?? [];
    arr.push(line);
    out.set(jobId, arr);
  }
  for (const arr of out.values()) arr.sort((a, b) => a.currency.localeCompare(b.currency));
  return out;
}
