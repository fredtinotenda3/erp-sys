// Plastics production analytics (Milestone 6): getPlasticsJobCostSummary.
//
// Deliberately NOT a second cost engine. Material cost, labour cost, profit,
// completeness gating and cost-per-good-unit are all computed exactly once,
// in cost-service.ts's getJobCost -- the existing single source of truth for
// job costing (ledger-derived, snapshot-aware, currency-safe). This module
// only ADDS the two figures that are genuinely new in this milestone and
// that getJobCost has no reason to know about: regrind generated and
// regrind consumed quantities. Re-deriving material/labour cost here would
// risk the exact thing the mandate forbids ("never double-count material
// value" / "single source of truth via the existing stock ledger").
//
// Honesty about what's measured vs. unavailable (mandate §8, "do not invent
// machine telemetry or energy readings when no connected equipment provides
// them"): this codebase has no PLC/energy-meter integration anywhere, so
// machineCost is always reported with basis "not_available" -- never
// estimated, never defaulted to zero. There is likewise no energy-cost
// field anywhere in this type: it is omitted entirely rather than faked.
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import { NotFoundError } from "../../shared/errors";
import type { AuthenticatedSession } from "../iam/session-service";
import { findJobInScope } from "./job-service";
import { getJobCost } from "../costing/cost-service";

const D = (v: unknown) => new Prisma.Decimal(String(v));
const Z = new Prisma.Decimal(0);

/**
 * Sums a set of (itemId, uom, quantity) rows, but only states a total when
 * every row shares the same (itemId, uom) pair -- summing across different
 * materials or units would be a fabricated figure, not a measurement. This
 * is the honest-granularity discipline the regrind lineage design already
 * applies elsewhere (see MaterialLot.sourceRegrindJobId's schema comment):
 * a job summary should not silently blend materials it cannot meaningfully
 * add together.
 */
function sumSingleMaterial(rows: { itemId: string; uom: string; quantity: Prisma.Decimal }[]): Prisma.Decimal {
  if (rows.length === 0) return Z;
  const distinctKeys = new Set(rows.map((r) => `${r.itemId}:${r.uom}`));
  if (distinctKeys.size > 1) return Z; // multiple materials/units involved -- see IMPLEMENTATION_MANIFEST.md known limitations
  return rows.reduce((t, r) => t.add(r.quantity), Z);
}

export async function getPlasticsJobCostSummary(session: AuthenticatedSession, jobId: string) {
  // Reads are never profile-gated (switching an org's profile must never
  // hide or corrupt historical transactions) -- same discipline as every
  // other Milestone 6 read path. getJobCost itself asserts production_job:read
  // + cost:read.
  assertCapability(session.role, "production_job:read");
  assertCapability(session.role, "cost:read");
  const job = await findJobInScope(session, jobId);
  if (!job) throw new NotFoundError("Production job");

  const jobCost = (await getJobCost(session, jobId)) as {
    lines: { currency: string; adjusted: { material: string; labour: string | null } }[];
    output: {
      effectiveGood: string;
      scrap: string;
      processed: string;
      yieldPercent: string | null;
      costPerGoodUnit: { available: true; currency: string; amount: string } | { available: false; reason: string };
    };
  };

  // materialCost/labourCost/costPerGoodUnit are only stated when the job's
  // actual cost exists in exactly one currency -- the same "never state a
  // figure across mixed currencies" rule getJobCost itself enforces for
  // profit and variance.
  const singleLine = jobCost.lines.length === 1 ? jobCost.lines[0] : null;
  const materialCost = singleLine ? { amount: D(singleLine.adjusted.material), currency: singleLine.currency, basis: "measured" as const } : null;
  const labourCost = singleLine && singleLine.adjusted.labour !== null
    ? { amount: D(singleLine.adjusted.labour), currency: singleLine.currency, basis: "measured" as const }
    : null;
  const costPerGoodUnit = jobCost.output.costPerGoodUnit.available
    ? { amount: D(jobCost.output.costPerGoodUnit.amount), currency: jobCost.output.costPerGoodUnit.currency }
    : null;

  const scrap = D(jobCost.output.scrap);
  const processed = D(jobCost.output.processed);
  const scrapRatePct = processed.gt(0) ? scrap.div(processed).mul(100).toDecimalPlaces(1) : null;

  // Regrind GENERATED from this job's own scrap (sourceRegrindJobId -- see
  // regrind-service.ts's createRegrindLot).
  const generatedLots = await prisma.materialLot.findMany({
    where: { orgId: session.orgId, sourceRegrindJobId: job.id },
    select: { itemId: true, uom: true, quantityReceived: true },
  });
  const regrindGeneratedQty = sumSingleMaterial(generatedLots.map((l) => ({ itemId: l.itemId, uom: l.uom, quantity: D(l.quantityReceived) })));

  // Regrind CONSUMED on this job: this job's own LotConsumption rows against
  // lots that are themselves regrind (from this job or any other -- regrind
  // stock is ordinary, reusable raw-material stock once generated, so a job
  // may well consume regrind that a different job produced).
  const consumedRows = await prisma.lotConsumption.findMany({
    where: { orgId: session.orgId, jobId: job.id, type: "consumption", lot: { sourceRegrindJobId: { not: null } } },
    select: { quantity: true, lot: { select: { itemId: true, uom: true } } },
  });
  const regrindConsumedQty = sumSingleMaterial(consumedRows.map((r) => ({ itemId: r.lot.itemId, uom: r.lot.uom, quantity: D(r.quantity) })));

  return {
    jobId: job.id,
    materialCost,
    labourCost,
    // Never measured in this codebase (no telemetry/PLC/energy-meter
    // integration exists anywhere) -- always this exact shape, never a
    // guessed figure.
    machineCost: {
      amount: null,
      currency: null,
      basis: "not_available" as const,
      note: "No connected machine telemetry or energy metering exists in this system; machine-time records (machine-time-service.ts) capture duration, not cost.",
    },
    scrapQty: scrap,
    regrindGeneratedQty,
    regrindConsumedQty,
    goodOutputQty: D(jobCost.output.effectiveGood),
    yieldPct: jobCost.output.yieldPercent === null ? null : D(jobCost.output.yieldPercent),
    scrapRatePct,
    costPerGoodUnit,
  };
}
