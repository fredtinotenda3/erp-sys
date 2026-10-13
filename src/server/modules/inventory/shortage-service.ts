// Stock shortages (UX spec §2.15 / §6): what each branch holds versus what its
// open jobs still need.
//
//   remaining requirement = expected (BOM snapshot) - already issued   (per job, never below 0)
//   shortage              = on-hand < sum of remaining requirements
//   low                   = not short, but on-hand < the item's reorderThreshold (only if one is set)
//
// Computed per BRANCH: stock in one branch's warehouse cannot cover another
// branch's job. All figures are CALCULATED from real rows, and each row carries
// the jobs that drive it so "why is this short?" is always answerable. An item
// that was never received into a branch reports hasStockRecord:false ("no stock
// recorded"), which is not the same fact as a balance of zero.
import { z } from "zod";
import { Prisma } from "../../../generated/prisma/client";
import { prisma } from "../../shared/db";
import { assertCapability, assertBranchAccess } from "../../shared/authz";
import { ValidationError } from "../../shared/errors";
import type { AuthenticatedSession } from "../iam/session-service";

const filterSchema = z.object({
  branchId: z.string().uuid().optional(),
  status: z.enum(["shortage", "low", "ok"]).optional(),
});

const OPEN = ["planned", "released", "in_progress", "on_hold"] as const;
const Z = new Prisma.Decimal(0);
const D = (v: unknown) => new Prisma.Decimal(String(v));

export async function getShortages(session: AuthenticatedSession, input: unknown = {}) {
  assertCapability(session.role, "stock:read");
  assertCapability(session.role, "production_job:read");
  const parsed = filterSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid filter", parsed.error.issues);

  if (parsed.data.branchId) assertBranchAccess(session, parsed.data.branchId);
  const branchScope = parsed.data.branchId
    ? { branchId: parsed.data.branchId }
    : session.role === "OWNER_ADMIN"
      ? {}
      : { branchId: { in: [...session.branchIds] } };

  const [balances, jobs] = await Promise.all([
    prisma.stockBalance.findMany({
      where: { orgId: session.orgId, warehouse: branchScope },
      include: { warehouse: { select: { branchId: true } } },
    }),
    prisma.productionJob.findMany({
      where: { orgId: session.orgId, status: { in: [...OPEN] }, ...branchScope },
      select: { id: true, jobNumber: true, branchId: true, materialRequirements: { select: { materialItemId: true, expectedQty: true } } },
    }),
  ]);

  const issued = jobs.length
    ? await prisma.stockMovement.groupBy({
        by: ["referenceId", "itemId"],
        where: {
          orgId: session.orgId,
          referenceType: "production_job",
          movementType: { in: ["production_consumption", "material_return"] },
          referenceId: { in: jobs.map((j) => j.id) },
        },
        _sum: { quantity: true },
      })
    : [];
  const issuedBy = new Map(issued.map((g) => [`${g.referenceId}|${g.itemId}`, D(g._sum.quantity ?? 0).neg()]));

  type Row = {
    branchId: string;
    itemId: string;
    hasStockRecord: boolean;
    onHand: Prisma.Decimal;
    required: Prisma.Decimal;
    demand: { jobId: string; jobNumber: string; expected: string; issued: string; remaining: string }[];
  };
  const rows = new Map<string, Row>();
  const get = (branchId: string, itemId: string): Row => {
    const k = `${branchId}|${itemId}`;
    let r = rows.get(k);
    if (!r) {
      r = { branchId, itemId, hasStockRecord: false, onHand: Z, required: Z, demand: [] };
      rows.set(k, r);
    }
    return r;
  };

  for (const b of balances) {
    const r = get(b.warehouse.branchId, b.itemId);
    r.hasStockRecord = true;
    r.onHand = r.onHand.add(D(b.quantity));
  }
  for (const j of jobs) {
    for (const req of j.materialRequirements) {
      const expected = D(req.expectedQty);
      const done = issuedBy.get(`${j.id}|${req.materialItemId}`) ?? Z;
      const remaining = Prisma.Decimal.max(expected.sub(done), 0);
      if (remaining.isZero()) continue;
      const r = get(j.branchId, req.materialItemId);
      r.required = r.required.add(remaining);
      r.demand.push({ jobId: j.id, jobNumber: j.jobNumber, expected: expected.toString(), issued: done.toString(), remaining: remaining.toString() });
    }
  }

  const itemIds = [...new Set([...rows.values()].map((r) => r.itemId))];
  const items = itemIds.length
    ? await prisma.item.findMany({ where: { orgId: session.orgId, id: { in: itemIds } }, select: { id: true, sku: true, name: true, uom: true, reorderThreshold: true } })
    : [];
  const itemById = new Map(items.map((i) => [i.id, i]));

  const rank = { shortage: 0, low: 1, ok: 2 } as const;
  const out = [...rows.values()].map((r) => {
    const item = itemById.get(r.itemId);
    const threshold = item?.reorderThreshold != null ? D(item.reorderThreshold) : null;
    const status: "shortage" | "low" | "ok" = r.onHand.lt(r.required)
      ? "shortage"
      : threshold && r.onHand.lt(threshold)
        ? "low"
        : "ok";
    return {
      branchId: r.branchId,
      item: item ? { id: item.id, sku: item.sku, name: item.name, uom: item.uom } : { id: r.itemId },
      status,
      hasStockRecord: r.hasStockRecord, // false => "No stock recorded", not zero
      onHand: r.onHand.toString(),
      remainingRequirement: r.required.toString(),
      available: r.onHand.sub(r.required).toString(),
      shortageQty: status === "shortage" ? r.required.sub(r.onHand).toString() : null,
      reorderThreshold: threshold ? threshold.toString() : null,
      demand: r.demand,
    };
  });

  return out
    .filter((r) => !parsed.data.status || r.status === parsed.data.status)
    .sort((a, b) => rank[a.status] - rank[b.status] || a.item.id.localeCompare(b.item.id));
}
