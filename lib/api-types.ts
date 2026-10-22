// JSON shapes of the existing API responses, as they look AFTER serialisation
// (Decimals -> strings, Dates -> ISO strings). These mirror the services in
// src/server/modules/*; fields that depend on a capability are optional because
// the server omits them rather than sending placeholders.
import type { JobStatus } from "../src/server/modules/production/job-state";

export type Dec = string;

export interface Branch {
  id: string;
  name: string;
  isActive?: boolean;
}

export type ItemType = "raw_material" | "consumable" | "spare_part" | "finished_good" | "wip";

export interface Item {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  uom: string;
  itemType: ItemType;
  isSellable: boolean;
  isActive: boolean;
  reorderThreshold: Dec | null;
  createdAt: string;
  updatedAt: string;
  // cost:read only
  standardCost?: Dec | null;
  standardCostCurrency?: string | null;
  sellingPrice?: Dec | null;
  sellingPriceCurrency?: string | null;
}

export interface BomLine {
  id: string;
  bomId: string;
  materialItemId: string;
  quantity: Dec;
  uom: string;
}

export interface Bom {
  id: string;
  productItemId: string;
  version: number;
  status: "draft" | "active" | "superseded";
  effectiveFrom: string | null;
  createdAt: string;
  lines: BomLine[];
}

export interface Customer {
  id: string;
  name: string;
  status: "active" | "inactive";
}

export interface Warehouse {
  id: string;
  branchId: string;
  name: string;
  isActive: boolean;
}

export interface CostEstimateLine {
  currency: string;
  estimatedMaterialCost: Dec;
  estimatedLabourCost: Dec | null;
  estimatedOverheadCost: Dec | null;
}

export interface JobRequirement {
  id: string;
  materialItemId: string;
  expectedQty: Dec;
  uom: string;
  standardUnitCost?: Dec | null;
  standardUnitCostCurrency?: string | null;
}

export interface Job {
  id: string;
  branchId: string;
  jobNumber: string;
  productItemId: string;
  bomId: string;
  plannedQty: Dec;
  plannedStart: string | null;
  plannedEnd: string | null;
  actualStart: string | null;
  actualEnd: string | null;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  // customer:read
  customerId?: string | null;
  salesOrderLineId?: string | null;
  // cost:read
  quotedAmount?: Dec | null;
  quotedCurrency?: string | null;
  materialRequirements?: JobRequirement[];
  costEstimate?: {
    computedAt: string;
    lines: CostEstimateLine[];
    unpricedMaterials: { materialItemId: string; reason: "no_standard_cost" | "uom_mismatch" }[];
    isMaterialEstimateComplete: boolean;
  } | null;
}

export interface JobMaterialRow {
  materialItemId: string;
  uom: string;
  expectedQty: Dec;
  issuedQty: Dec;
  remainingQty: Dec;
  overIssuedQty: Dec;
  standardUnitCost?: Dec | null;
  standardUnitCostCurrency?: string | null;
}

export interface VarianceInfo {
  /** actual - estimated. Show it as variance only when `comparable`. */
  amount: string | null;
  percent: string | null;
  comparable: boolean;
  reason: string | null;
  /** legacy to-date amount (same as before Phase 2) */
  material: string | null;
}

export interface CostLine {
  currency: string;
  estimated: { material: Dec | null; labour: null; overhead: null };
  /** Snapshot (final) or live (to date). Adjustments are shown separately. */
  actual: { material: Dec; labour: Dec | null; overhead: null };
  variance: VarianceInfo;
  adjustments: { material: Dec | null; labour: Dec | null };
  /** actual + adjustments */
  adjusted: { material: Dec; labour: Dec | null };
}

export type JobProfit =
  | { available: false; reason: string; blockers?: string[] }
  | {
      available: true;
      currency: string;
      revenue: Dec;
      revenueBasis: "quoted";
      actualCost: Dec;
      grossProfit: Dec;
      marginPercent: Dec | null;
      excludesOverhead: true;
      labourRecorded: boolean;
    };

export interface MissingComponent {
  component: "job" | "estimate" | "material" | "labour" | "overhead";
  code: string;
  message: string;
}

export interface Completeness {
  isFinal: boolean;
  estimate: "complete" | "incomplete" | "none";
  material: "recorded" | "none_recorded" | "has_uncosted";
  labour: "recorded" | "none_recorded";
  overhead: "unavailable";
  missing: MissingComponent[];
  marginBlockers: string[];
  varianceComparable: boolean;
  varianceBlocker: string | null;
}

export type MaterialExplanation =
  | { comparable: false; reason: "unpriced" | "unit_mismatch" | "currency_differs" | "multiple_currencies" }
  | { comparable: true; currency: string; expectedCost: Dec; actualCost: Dec; usageVariance: Dec; priceVariance: Dec; totalVariance: Dec; overIssuedQty: Dec };

export interface MaterialBreakdownRow {
  materialItemId: string;
  uom: string;
  expectedQty: Dec;
  issuedQty: Dec;
  overIssuedQty: Dec;
  actualCost: { currency: string; cost: Dec }[];
  explanation: MaterialExplanation;
}

export interface CostAdjustment {
  id: string;
  currency: string;
  component: "material" | "labour";
  amount: Dec;
  reason: string;
  createdById: string | null;
  createdAt: string;
}

export interface OutputTotals {
  grossGood: Dec;
  effectiveGood: Dec;
  scrap: Dec;
  rework: Dec;
  reworkOpen: Dec;
  reclassified: Dec;
  processed: Dec;
  yieldPercent: Dec | null;
}

export type CostPerGoodUnit =
  | { available: false; reason: string }
  | { available: true; currency: string; amount: Dec; basis: "calculated"; excludesOverhead: true; includesScrapAndRework: true };

export interface JobOutputCost extends OutputTotals {
  stages: { total: number; completed: number };
  costPerGoodUnit: CostPerGoodUnit;
}

export interface JobCost {
  jobId: string;
  jobNumber: string;
  status: JobStatus;
  actualBasis: "live" | "snapshot";
  snapshottedAt: string | null;
  estimateComputedAt: string | null;
  isMaterialEstimateComplete: boolean;
  unpricedMaterials: { materialItemId: string; reason: "no_standard_cost" | "uom_mismatch" }[];
  varianceReliable: boolean;
  lines: CostLine[];
  overhead: "unavailable";
  overheadReason: string;
  completeness: Completeness;
  snapshot: { status: "frozen" | "not_frozen"; snapshottedAt: string | null; completenessAtCompletion: unknown; evidence: Record<string, unknown> | null };
  adjustments: CostAdjustment[];
  output: JobOutputCost;
  materialBreakdown: MaterialBreakdownRow[];
  profit: JobProfit;
  conversion?: {
    to: string;
    basis: "as_of_completion" | "as_of_date" | "latest";
    asOf: string | null;
    available: boolean;
    groups: { currency: string; rate: { id: string; rate: string; asOfDate: string; source: string; recordedAt: string } | null; converted: boolean }[];
    totals: { currency: string; estimatedMaterial: Dec | null; actualMaterial: Dec; actualLabour: Dec | null } | null;
  };
}

export interface JobCostSummary {
  jobId: string;
  jobNumber: string;
  status: JobStatus;
  branchId: string;
  actualBasis: "live" | "snapshot";
  isMaterialEstimateComplete: boolean;
  lines: {
    currency: string;
    estimated: { material: Dec | null };
    actual: { material: Dec; labour: Dec | null };
    variance: { material: Dec | null };
  }[];
}

export interface ExchangeRate {
  id: string;
  baseCurrency: string;
  quoteCurrency: string;
  rate: Dec;
  asOfDate: string;
  source: "RBZ_OFFICIAL" | "MARKET" | "MANUAL";
  recordedById: string | null;
  recordedAt: string;
}

export interface StockBalance {
  itemId: string;
  warehouseId: string;
  quantity: Dec;
  updatedAt: string;
  averageUnitCost?: Dec | null;
  averageUnitCostCurrency?: string | null;
}

export type MovementType =
  | "purchase_receipt"
  | "material_issue"
  | "material_return"
  | "production_consumption"
  | "finished_goods_receipt"
  | "sale_delivery"
  | "adjustment"
  | "stock_transfer_out"
  | "stock_transfer_in";

export interface StockMovement {
  id: string;
  branchId: string;
  itemId: string;
  warehouseId: string;
  movementType: MovementType;
  quantity: Dec;
  referenceType: string | null;
  referenceId: string | null;
  reason: string | null;
  createdById: string | null;
  occurredAt: string;
  syncedAt: string;
  unitCost?: Dec | null;
  currency?: string | null;
}

export interface Shortage {
  branchId: string;
  item: { id: string; sku?: string; name?: string; uom?: string };
  status: "shortage" | "low" | "ok";
  hasStockRecord: boolean;
  onHand: Dec;
  remainingRequirement: Dec;
  available: Dec;
  shortageQty: Dec | null;
  reorderThreshold: Dec | null;
  demand: { jobId: string; jobNumber: string; expected: Dec; issued: Dec; remaining: Dec }[];
}

export interface AuditEntry {
  id: string;
  branchId: string | null;
  actorUserId: string | null;
  entityType: string;
  entityId: string;
  action: string;
  beforeValue: unknown;
  afterValue: unknown;
  reason: string | null;
  createdAt: string;
}

export interface UserLite {
  id: string;
  fullName: string;
}

export interface Currency {
  code: string;
  name: string;
  decimals: number;
}

// ---------------------------------------------------------------------------
// Shop floor (Phase 3)
// ---------------------------------------------------------------------------
export type RejectReason = "wrong_dimensions" | "damaged" | "paint_defect" | "missing_component" | "other";

export interface StageView {
  id: string;
  sequence: number;
  name: string;
  status: "pending" | "in_progress" | "completed";
  plannedStart: string | null;
  plannedEnd: string | null;
  startedAt: string | null;
  completedAt: string | null;
  workCentre: string | null;
  operatorUserId: string | null;
  requiresInspection: boolean;
  blockedReason: string | null;
  blockedAt: string | null;
  notes: string | null;
  isDelayed: boolean;
  output: OutputTotals;
  inspection: { state: "not_required" | "pending" | "passed" | "failed_open" | "failed_resolved"; inspected: Dec; rejected: Dec; openRejected: Dec };
  completionBlockers: string[];
}

export interface OutputEntry {
  id: string;
  jobStageId: string | null;
  goodQty: Dec;
  scrapQty: Dec;
  reworkQty: Dec;
  reworkGoodQty: Dec;
  reworkScrapQty: Dec;
  reclassifiedFromGoodQty: Dec;
  uom: string;
  reason: RejectReason | null;
  notes: string | null;
  source: "operator" | "quality_disposition";
  inspectionId: string | null;
  operatorUserId: string | null;
  recordedAt: string;
  voided: { reason: string; voidedBy: string | null; voidedAt: string } | null;
}

export interface OutputList {
  jobId: string;
  uom: string | null;
  entries: OutputEntry[];
  totals: OutputTotals;
  byStage: Record<string, OutputTotals>;
  plannedQty: Dec;
  exceedsPlan: boolean;
}

export interface InspectionView {
  id: string;
  jobStageId: string | null;
  inspectedQty: Dec;
  acceptedQty: Dec;
  rejectedQty: Dec;
  outcome: "pass" | "fail";
  defectCategory: RejectReason | null;
  notes: string | null;
  evidenceRef: string | null;
  uom: string | null;
  inspectorUserId: string | null;
  inspectedAt: string;
  disposition: "not_needed" | "open" | "resolved";
  openRejectedQty: Dec;
  dispositions: { id: string; kind: "scrap" | "rework" | "use_as_is"; qty: Dec; reason: string; decidedBy: string; decidedAt: string }[];
}

export interface InspectionList {
  jobId: string;
  inspections: InspectionView[];
  summary: { total: number; passed: number; failed: number; inspectedUnits: Dec; rejectedUnits: Dec; openRejectedUnits: Dec };
}

export interface Readiness {
  jobId: string;
  status: JobStatus;
  usesStages: boolean;
  canComplete: boolean;
  jobBlockers: string[];
  stages: { id: string; sequence: number; name: string; completionBlockers: string[] }[];
}
