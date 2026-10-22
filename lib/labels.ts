import type { ItemType, MovementType } from "./api-types";

export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  raw_material: "Raw material",
  consumable: "Consumable",
  spare_part: "Spare part",
  finished_good: "Finished good",
  wip: "Work in progress",
};

export const ITEM_TYPE_OPTIONS = Object.entries(ITEM_TYPE_LABELS) as [ItemType, string][];

export const MOVEMENT_LABELS: Record<MovementType, string> = {
  purchase_receipt: "Receipt",
  material_issue: "Material issue",
  material_return: "Material return",
  production_consumption: "Issued to job",
  finished_goods_receipt: "Finished goods receipt",
  sale_delivery: "Sale delivery",
  adjustment: "Adjustment",
  stock_transfer_out: "Transfer out",
  stock_transfer_in: "Transfer in",
};

/** Item types a job can produce (job-service enforces this too). */
export const PRODUCIBLE: readonly ItemType[] = ["finished_good", "wip"];
/** Item types a purchase receipt may be posted for (stock-service enforces this too). */
export const RECEIVABLE: readonly ItemType[] = ["raw_material", "consumable", "spare_part"];

export const REJECT_REASON_LABELS: Record<string, string> = {
  wrong_dimensions: "Wrong dimensions",
  damaged: "Damaged",
  paint_defect: "Paint defect",
  missing_component: "Missing component",
  other: "Other",
};
export const REJECT_REASON_OPTIONS = Object.entries(REJECT_REASON_LABELS);

export const DISPOSITION_LABELS: Record<string, string> = {
  scrap: "Scrap",
  rework: "Send to rework",
  use_as_is: "Use as is (concession)",
};

export const INSPECTION_STATE_LABELS: Record<string, string> = {
  not_required: "Not required",
  pending: "Inspection pending",
  passed: "Passed",
  failed_open: "Failed — decision needed",
  failed_resolved: "Failed — resolved",
};
