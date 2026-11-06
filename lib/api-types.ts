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
  // Milestone 4, both optional/nullable; null = unchanged pre-M4 behaviour.
  expectedScrapPct: Dec | null;
  expectedYieldPct: Dec | null;
}

export interface Bom {
  id: string;
  productItemId: string;
  version: number;
  status: "draft" | "active" | "superseded";
  effectiveFrom: string | null;
  /** Milestone 4, informational only -- does not auto-supersede or deactivate anything. */
  effectiveTo: string | null;
  createdAt: string;
  lines: BomLine[];
}

export interface Customer {
  id: string;
  name: string;
  status: "active" | "inactive";
}

export interface Supplier {
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
  priority: "low" | "normal" | "high" | "urgent";
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
  | "stock_transfer_in"
  // Milestone 6 (Plastics Manufacturing Vertical) -- see stock-core.ts's
  // PostableMovementType comment for why this is its own movement type
  // rather than "purchase_receipt".
  | "regrind_generation";

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
  // Milestone 4: structured work-centre/machine assignment, independent of
  // the legacy free-text `workCentre` field above (kept for compatibility).
  workCentreId: string | null;
  machineId: string | null;
  expectedSetupMinutes: number | null;
  expectedRunMinutes: number | null;
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
  // Milestone 4: optional inspection-plan-driven characteristic measurements,
  // diagnostic detail only -- never the source of `outcome`/`rejectedQty` above.
  inspectionPlanId: string | null;
  measurements: QualityMeasurementView[];
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

// --- Lot traceability ("Phase One" of the next mandate round) -------------

export type MaterialLotStatus = "active" | "quarantined" | "expired";

export interface MaterialLot {
  id: string;
  lotNumber: string;
  itemId: string;
  warehouseId: string;
  supplierId: string;
  uom: string;
  status: MaterialLotStatus;
  expiryDate: string | null;
  receivedAt: string;
  quantityReceived: Dec;
  remaining: Dec;
  /** false when quarantined, expired, or nothing left -- see lot-availability.ts's isAvailable. */
  available: boolean;
}

export type LotOrigin =
  | { type: "receipt"; receiptLineId: string; goodsReceiptId: string; purchaseOrderId: string; purchaseOrderNumber: string; supplierId: string; supplierName: string }
  | { type: "return"; sourceReturnOfLotId: string | null; sourceReturnOfLotNumber: string | null; sourceReturnJobId: string | null; sourceReturnJobNumber: string | null; sourceReturnMovementId: string | null };

export interface LotDetail extends MaterialLot {
  supplierLotRef: string | null;
  origin: LotOrigin;
  returnChildLots: { id: string; lotNumber: string; status: MaterialLotStatus; quantityReceived: Dec; createdAt: string }[];
}

export interface LotTraceabilityJobEvent {
  type: "consumption" | "return";
  quantity: Dec;
  movementId: string;
  occurredAt: string;
  createdAt: string;
}

export interface LotTraceabilityJob {
  jobId: string;
  jobNumber: string;
  consumed: Dec;
  returned: Dec;
  netOutstanding: Dec;
  events: LotTraceabilityJobEvent[];
}

export interface LotTraceability {
  lotId: string;
  lotNumber: string;
  originChain: Array<Record<string, unknown>>;
  consumedByJobs: LotTraceabilityJob[];
  forwardChainNote: string;
}

/** Per-job, per-lot breakdown behind a JobMaterialRow's issuedQty figure. */
export interface JobLotConsumptionRow {
  lotId: string;
  lotNumber: string;
  itemId: string;
  warehouseId: string;
  consumed: Dec;
  returned: Dec;
  netOutstanding: Dec;
}

// ---------------------------------------------------------------------------
// Milestone 2: Finished-Goods Inventory (finished-goods-service.ts)
// ---------------------------------------------------------------------------

export type FgBatchStatus = "active" | "quarantined" | "rejected";

export interface FgBatchMaterialLotLine {
  lotId: string;
  lotNumber: string;
  materialItemId: string;
  quantity: Dec;
}

export interface FgBatchCostLine {
  currency: string;
  materialCost: Dec;
  labourCost: Dec | null;
}

export interface FinishedGoodsBatch {
  id: string;
  batchNumber: string;
  productItemId: string;
  productSku: string;
  productName: string;
  jobId: string;
  jobNumber: string;
  warehouseId: string;
  goodQty: Dec;
  uom: string;
  status: FgBatchStatus;
  qualityNotes: string | null;
  producedAt: string;
  transferredFromBatchId: string | null;
  createdAt: string;
  materialLots: FgBatchMaterialLotLine[];
  /** cost:read only */
  costLines?: FgBatchCostLine[];
}

/** FinishedGoodsBatch plus the fields listFinishedGoodsBatches/getBatchDetail add. */
export interface FinishedGoodsBatchDetail extends FinishedGoodsBatch {
  remaining: Dec;
}

export interface FgBatchMovementRow {
  id: string;
  type: "transfer_out" | "adjustment" | "dispatch";
  quantity: Dec;
  reason: string | null;
  movementId: string;
  createdAt: string;
}

export interface FinishedGoodsBatchFull extends FinishedGoodsBatchDetail {
  movements: FgBatchMovementRow[];
}

export interface FgGenealogyRow {
  materialItemId: string;
  theoreticalQty: Dec;
  attributedQty: Dec;
  complete: boolean;
}

/** One shipment this batch was drawn into (Milestone 3). */
export interface FgBatchDispatchRow {
  dispatchId: string;
  dispatchNumber: string;
  status: DispatchStatus;
  dispatchedAt: string;
  quantity: Dec;
  /** sales_order:read only */
  salesOrderId?: string;
  orderNumber?: string;
  customerName?: string;
}

export interface FgBatchTraceability {
  batchId: string;
  batchNumber: string;
  jobId: string;
  jobNumber: string;
  materialLots: FgBatchMaterialLotLine[];
  genealogyByMaterial: FgGenealogyRow[];
  genealogyNote: string;
  dispatches: FgBatchDispatchRow[];
  forwardChainNote: string;
}

export interface JobFinishedGoodsSummary {
  jobId: string;
  producedGoodQty: Dec;
  receivedToFinishedGoodsQty: Dec;
  uncommittedGoodQty: Dec;
  batches: FinishedGoodsBatchDetail[];
}

export interface WipValuationLine {
  currency: string;
  actualMaterialCost: Dec;
  actualLabourCost: Dec | null;
  transferredMaterialCost: Dec;
  transferredLabourCost: Dec | null;
  remainingMaterialCost: Dec;
  remainingLabourCost: Dec | null;
}

export interface WipValuationForJob {
  jobId: string;
  jobNumber: string;
  lines: WipValuationLine[];
}

export interface FinishedGoodsValuationRow {
  itemId: string;
  sku: string;
  itemName: string;
  uom: string;
  warehouseId: string;
  warehouseName: string;
  quantity: Dec;
  /** cost:read only */
  averageUnitCost?: Dec | null;
  averageUnitCostCurrency?: string | null;
  totalValue?: Dec | null;
}

// ---------------------------------------------------------------------------
// Milestone 3: Dispatch and Delivery (dispatch-service.ts)
// ---------------------------------------------------------------------------

export type DispatchStatus = "dispatched" | "delivered";

export interface DispatchBatchAllocationRow {
  batchId: string;
  batchNumber: string;
  quantity: Dec;
}

export interface DispatchLineRow {
  id: string;
  salesOrderLineId: string;
  itemId: string;
  sku: string;
  itemName: string;
  quantity: Dec;
  uom: string;
  batchAllocations: DispatchBatchAllocationRow[];
}

export interface CostOfGoodsLine {
  currency: string;
  amount: Dec;
}

export interface Dispatch {
  id: string;
  dispatchNumber: string;
  branchId: string;
  status: DispatchStatus;
  salesOrderId: string;
  orderNumber: string;
  customer: { id: string; name: string };
  warehouseId: string;
  warehouseName: string;
  dispatchedAt: string;
  carrier: string | null;
  trackingReference: string | null;
  notes: string | null;
  deliveredAt: string | null;
  receivedBy: string | null;
  deliveryNotes: string | null;
  createdAt: string;
  lines: DispatchLineRow[];
  /** cost:read only */
  costOfGoodsDispatched?: CostOfGoodsLine[];
  costNote?: string;
}

// ---------------------------------------------------------------------------
// Milestone 4 -- Full Manufacturing Lifecycle
// ---------------------------------------------------------------------------

export type MachineStatus = "available" | "in_use" | "down" | "maintenance" | "retired";
export type DowntimeCategory = "breakdown" | "changeover" | "no_material" | "no_operator" | "planned_maintenance" | "other";
export type MaintenanceType = "scheduled" | "unscheduled";
export type CorrectiveActionStatus = "open" | "in_progress" | "completed" | "cancelled";

export interface Machine {
  id: string;
  workCentreId: string;
  code: string;
  name: string;
  status: MachineStatus;
  isActive: boolean;
  createdAt: string;
  /** Present on listMachines() rows; a thin reference, not a full WorkCentre. */
  workCentre?: { id: string; code: string; name: string; branchId: string };
}

export interface WorkCentre {
  id: string;
  branchId: string;
  code: string;
  name: string;
  /** null = capacity not configured; capacity report shows raw load with no %. */
  dailyCapacityMinutes: number | null;
  isActive: boolean;
  createdAt: string;
  /** Present on listWorkCentres()/getWorkCentre() rows. */
  machines?: Machine[];
}

export interface MachineDowntimeRecord {
  id: string;
  machineId: string;
  category: DowntimeCategory;
  reason: string;
  startedAt: string;
  /** null = still open. */
  endedAt: string | null;
  loggedById: string | null;
}

export interface MachineMaintenanceRecord {
  id: string;
  machineId: string;
  type: MaintenanceType;
  scheduledAt: string | null;
  completedAt: string | null;
  notes: string | null;
  performedById: string | null;
  createdAt: string;
}

/** Shape returned by getMachine(): the machine plus its recent operational history. */
export interface MachineDetail extends Machine {
  openDowntime: MachineDowntimeRecord | null;
  recentDowntime: MachineDowntimeRecord[];
  maintenance: MachineMaintenanceRecord[];
}

export interface CapacityDayRow {
  date: string;
  assignedMinutes: number;
  stageCount: number;
  jobNumbers: string[];
  capacityMinutes: number | null;
  utilisationPct: number | null;
  overCapacity: boolean | null;
}

export interface CapacityWorkCentreRow {
  id: string;
  code: string;
  name: string;
  branchId: string;
  dailyCapacityMinutes: number | null;
  days: CapacityDayRow[];
}

export interface CapacityReport {
  from: string;
  to: string;
  note?: string;
  workCentres: CapacityWorkCentreRow[];
}

export interface MachineTimeEntry {
  id: string;
  jobId: string;
  jobStageId: string | null;
  machineId: string;
  setupMinutes: number;
  runMinutes: number;
  operatorUserId: string | null;
  recordedAt: string;
}

export interface MachineTimeList {
  jobId: string;
  entries: MachineTimeEntry[];
  totals: { setupMinutes: number; runMinutes: number };
}

export interface InspectionCharacteristicView {
  id: string;
  planId: string;
  name: string;
  uom: string | null;
  minValue: Dec | null;
  maxValue: Dec | null;
  targetValue: Dec | null;
  sequence: number;
  isActive: boolean;
}

export interface InspectionPlanView {
  id: string;
  itemId: string;
  name: string;
  isActive: boolean;
  createdById: string | null;
  createdAt: string;
  characteristics: InspectionCharacteristicView[];
}

export interface QualityMeasurementView {
  id: string;
  characteristicId: string;
  characteristicName: string;
  uom: string | null;
  minValue: Dec | null;
  maxValue: Dec | null;
  measuredValue: Dec;
  passed: boolean;
  recordedAt: string;
}

export interface CorrectiveActionView {
  id: string;
  jobId: string;
  qualityRecordId: string | null;
  description: string;
  assignedToUserId: string | null;
  status: CorrectiveActionStatus;
  dueDate: string | null;
  resolvedAt: string | null;
  resolutionNotes: string | null;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Milestone 5 -- Configurable Industry Architecture
// ---------------------------------------------------------------------------

export type IndustryProfileKey =
  | "general"
  | "plastics"
  | "food_beverage"
  | "metal_fabrication"
  | "textile_garment"
  | "furniture_woodworking"
  | "packaging_printing";

export interface IndustryProfileModuleEntry {
  key: string;
  label: string;
  description: string;
}

export interface IndustryProfileRegistryEntry {
  key: IndustryProfileKey;
  label: string;
  description: string;
  isImplemented: boolean;
  // readonly: this mirrors profile-registry.ts's own IndustryProfileDefinition.implementedModules,
  // which is static, compile-time registry data (never built or mutated by request handling) --
  // see listIndustryProfiles() in industry-profile-service.ts, which passes it straight through.
  availableModules: readonly IndustryProfileModuleEntry[];
}

export interface OrganizationIndustryProfile {
  industryProfile: IndustryProfileKey;
  enabledModules: string[];
  isImplemented: boolean;
  terminology: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Milestone 6 -- Plastics Manufacturing Vertical
// ---------------------------------------------------------------------------

export type MouldStatus = "available" | "in_use" | "maintenance" | "retired";

export interface Mould {
  id: string;
  branchId: string;
  code: string;
  name: string;
  cavityCount: number;
  status: MouldStatus;
  compatibleProductItemId: string | null;
  isActive: boolean;
}

export interface MouldMaintenanceRecordView {
  id: string;
  type: "scheduled" | "unscheduled";
  scheduledAt: string | null;
  completedAt: string | null;
  notes: string | null;
  performedById: string | null;
  createdAt: string;
}

/** Shape returned by getMould(): the mould plus compatible machines and recent maintenance. */
export interface MouldDetail extends Mould {
  compatibleMachineIds: string[];
  maintenance: MouldMaintenanceRecordView[];
}

export interface PlasticsMaterialAttributesView {
  itemId: string;
  polymerGrade: string | null;
  resinSpec: string | null;
  colourMasterbatch: string | null;
  additiveNotes: string | null;
  recycledContentPct: Dec | null;
  supplierMaterialRef: string | null;
  materialCertificateReference: string | null;
  blendComposition: { component: string; percentage: number }[] | null;
}

export interface PlasticsProductSpecView {
  itemId: string;
  productType: string;
  resinType: string | null;
  colour: string | null;
  nominalWeightGrams: Dec | null;
  capacityMl: Dec | null;
  heightMm: Dec | null;
  diameterMm: Dec | null;
  neckFinish: string | null;
  closureCompatibilityNotes: string | null;
  otherAttributes: Record<string, string> | null;
}

export interface PlasticsProcessDetailView {
  jobStageId: string;
  processType: string;
  mouldId: string | null;
  targetCycleTimeSeconds: Dec | null;
  actualCycleTimeSeconds: Dec | null;
  totalCavities: number | null;
  goodCavities: number | null;
}

/** getPlasticsJobCostSummary()'s read-only report. Every figure says whether it's measured or computed. */
export interface PlasticsJobCostSummary {
  jobId: string;
  materialCost: { amount: Dec; currency: string; basis: "measured" } | null;
  labourCost: { amount: Dec; currency: string; basis: "measured" } | null;
  // Always present (never null at the top level) -- there is always a
  // "basis" and "note" to report, even when no amount is available. amount/
  // currency are null because no connected machine telemetry or energy
  // metering exists in this system (mandate §8: never invent this figure).
  machineCost: { amount: Dec | null; currency: string | null; basis: "not_available"; note: string };
  scrapQty: Dec;
  regrindGeneratedQty: Dec;
  regrindConsumedQty: Dec;
  goodOutputQty: Dec;
  yieldPct: Dec | null;
  scrapRatePct: Dec | null;
  costPerGoodUnit: { amount: Dec; currency: string } | null;
}
