// Capability-driven response projection for production jobs.
//
// The approved role table gives PRODUCTION_OPERATOR, INVENTORY_MANAGER and
// VIEWER production_job:read WITHOUT customer:read and/or cost:read. So the
// job response is shaped by what the caller may see, not by role name:
//   - customer link        requires customer:read
//   - quoted amount        requires cost:read   (revenue is margin-sensitive)
//   - standard unit costs and the cost estimate   require cost:read
// An operator (neither capability) therefore gets the reduced view the UX
// spec asks for (§15.1 / §9.5) as a natural consequence, done once, here,
// in the service layer -- never a client-side filter.
import { hasCapability, type Role } from "../../shared/authz";

interface RequirementRow {
  id: string;
  materialItemId: string;
  expectedQty: unknown;
  uom: string;
  standardUnitCost: unknown;
  standardUnitCostCurrency: string | null;
}

interface EstimateLineRow {
  currency: string;
  estimatedMaterialCost: unknown;
  estimatedLabourCost: unknown;
  estimatedOverheadCost: unknown;
}

export interface JobRow {
  id: string;
  orgId: string;
  branchId: string;
  jobNumber: string;
  salesOrderLineId: string | null;
  customerId: string | null;
  productItemId: string;
  bomId: string;
  plannedQty: unknown;
  plannedStart: Date | null;
  plannedEnd: Date | null;
  actualStart: Date | null;
  actualEnd: Date | null;
  status: string;
  quotedAmount: unknown;
  quotedCurrency: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
  materialRequirements?: RequirementRow[];
  costEstimate?: { unpricedMaterials: unknown; computedAt: Date } | null;
  costEstimateLines?: EstimateLineRow[];
}

export function toJobView(role: Role, job: JobRow) {
  const canSeeCustomer = hasCapability(role, "customer:read");
  const canSeeCost = hasCapability(role, "cost:read");

  const view: Record<string, unknown> = {
    id: job.id,
    branchId: job.branchId,
    jobNumber: job.jobNumber,
    productItemId: job.productItemId,
    bomId: job.bomId,
    plannedQty: job.plannedQty,
    plannedStart: job.plannedStart,
    plannedEnd: job.plannedEnd,
    actualStart: job.actualStart,
    actualEnd: job.actualEnd,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };

  if (canSeeCustomer) {
    view.customerId = job.customerId;
    view.salesOrderLineId = job.salesOrderLineId;
  }
  if (canSeeCost) {
    view.quotedAmount = job.quotedAmount;
    view.quotedCurrency = job.quotedCurrency;
  }

  if (job.materialRequirements) {
    view.materialRequirements = job.materialRequirements.map((r) => {
      const base: Record<string, unknown> = {
        id: r.id,
        materialItemId: r.materialItemId,
        expectedQty: r.expectedQty,
        uom: r.uom,
      };
      if (canSeeCost) {
        base.standardUnitCost = r.standardUnitCost;
        base.standardUnitCostCurrency = r.standardUnitCostCurrency;
      }
      return base;
    });
  }

  if (canSeeCost && job.costEstimate !== undefined) {
    view.costEstimate = job.costEstimate
      ? {
          computedAt: job.costEstimate.computedAt,
          // Always one entry per currency -- never a blended total.
          lines: (job.costEstimateLines ?? []).map((l) => ({
            currency: l.currency,
            estimatedMaterialCost: l.estimatedMaterialCost,
            // null = unavailable (no labour standard / overhead method yet).
            estimatedLabourCost: l.estimatedLabourCost,
            estimatedOverheadCost: l.estimatedOverheadCost,
          })),
          unpricedMaterials: job.costEstimate.unpricedMaterials,
          isMaterialEstimateComplete:
            Array.isArray(job.costEstimate.unpricedMaterials) && job.costEstimate.unpricedMaterials.length === 0,
        }
      : null;
  }

  return view;
}
