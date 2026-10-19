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
