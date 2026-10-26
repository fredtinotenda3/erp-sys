// The development dataset. Plain data only; seed-dev.ts turns it into records by
// calling the application's own services (so ledger, costing, numbering, audit and
// permission rules all apply). Every business key here (email, SKU, name,
// receipt key) is what makes a re-run find the record instead of duplicating it.
import type { Role } from "../shared/authz";

export const SEED_USERS: { email: string; fullName: string; role: Role }[] = [
  { email: "manager@operis.test", fullName: "Demo Production Manager", role: "PRODUCTION_MANAGER" },
  { email: "operator@operis.test", fullName: "Demo Production Operator", role: "PRODUCTION_OPERATOR" },
  { email: "finance@operis.test", fullName: "Demo Finance Manager", role: "FINANCE_MANAGER" },
  { email: "inventory@operis.test", fullName: "Demo Inventory Manager", role: "INVENTORY_MANAGER" },
  { email: "viewer@operis.test", fullName: "Demo Viewer", role: "VIEWER" },
];

export const SEED_CUSTOMERS = [
  { name: "Kuwadzana Agri Supplies", contact: "Procurement desk", address: "Kuwadzana, Harare" },
  { name: "Harare Mining Services", contact: "Workshop manager", address: "Msasa, Harare" },
  { name: "Bulawayo Pump & Engineering", contact: "Projects office", address: "Belmont, Bulawayo" },
];

export interface SeedMaterial { sku: string; name: string; uom: string; cost: number; currency: string; reorder: number }
export const SEED_MATERIALS: SeedMaterial[] = [
  { sku: "RM-STL-3MM", name: "Steel Plate 3mm", uom: "kg", cost: 1.8, currency: "USD", reorder: 200 },
  { sku: "RM-BRG-6308", name: "Bearing 6308", uom: "ea", cost: 6.5, currency: "USD", reorder: 50 }, // stocked 40 => LOW (below reorder), not short
  { sku: "RM-MTR-55", name: "Electric Motor 5.5 kW", uom: "ea", cost: 210, currency: "USD", reorder: 2 }, // stocked 6 => short once > 6 are needed
  { sku: "RM-SHF-40", name: "Shaft Steel 40mm", uom: "m", cost: 14, currency: "USD", reorder: 10 },
  { sku: "RM-PNT-GRY", name: "Grey Paint", uom: "l", cost: 110, currency: "ZIG", reorder: 20 }, // costed in ZIG
  { sku: "RM-SEAL-KIT", name: "Seal Kit", uom: "ea", cost: 3.2, currency: "USD", reorder: 10 },
  { sku: "RM-FAST-KIT", name: "Fastener Kit", uom: "ea", cost: 4.5, currency: "USD", reorder: 50 },
  { sku: "RM-IBEAM-100", name: "I-Beam 100mm", uom: "m", cost: 12, currency: "USD", reorder: 12 }, // deliberately NEVER stocked
];

export interface SeedProduct { sku: string; name: string; price: number; bom: [sku: string, qty: number, uom: string][] }
export const SEED_PRODUCTS: SeedProduct[] = [
  { sku: "FG-PUMP-55", name: "Slurry Pump 5.5kW", price: 1850, bom: [["RM-STL-3MM", 40, "kg"], ["RM-BRG-6308", 2, "ea"], ["RM-MTR-55", 1, "ea"], ["RM-SHF-40", 1.2, "m"], ["RM-PNT-GRY", 3, "l"], ["RM-SEAL-KIT", 1, "ea"]] },
  { sku: "FG-GUARD-01", name: "Conveyor Guard Panel", price: 240, bom: [["RM-STL-3MM", 12, "kg"], ["RM-FAST-KIT", 1, "ea"]] },
  { sku: "FG-FRAME-02", name: "Support Frame", price: 520, bom: [["RM-STL-3MM", 55, "kg"], ["RM-PNT-GRY", 1.5, "l"]] },
  { sku: "FG-SKID-03", name: "Pump Skid Base", price: 780, bom: [["RM-STL-3MM", 30, "kg"], ["RM-IBEAM-100", 6, "m"], ["RM-FAST-KIT", 4, "ea"]] },
];

export const SEED_WAREHOUSES = ["Main Store", "Workshop Store"] as const;

export interface SeedReceipt { key: string; warehouse: (typeof SEED_WAREHOUSES)[number]; sku: string; qty: number; cost: number; currency: string }
export const SEED_RECEIPTS: SeedReceipt[] = [
  { key: "main-steel-1", warehouse: "Main Store", sku: "RM-STL-3MM", qty: 800, cost: 1.8, currency: "USD" },
  { key: "main-steel-2", warehouse: "Main Store", sku: "RM-STL-3MM", qty: 400, cost: 2.0, currency: "USD" }, // second price => weighted average 1.8667
  { key: "main-bearing", warehouse: "Main Store", sku: "RM-BRG-6308", qty: 40, cost: 6.5, currency: "USD" },
  { key: "main-motor", warehouse: "Main Store", sku: "RM-MTR-55", qty: 6, cost: 210, currency: "USD" },
  { key: "main-shaft", warehouse: "Main Store", sku: "RM-SHF-40", qty: 30, cost: 14, currency: "USD" },
  { key: "main-paint", warehouse: "Main Store", sku: "RM-PNT-GRY", qty: 90, cost: 110, currency: "ZIG" },
  { key: "main-seal", warehouse: "Main Store", sku: "RM-SEAL-KIT", qty: 60, cost: 3.2, currency: "USD" },
  { key: "main-fastener", warehouse: "Main Store", sku: "RM-FAST-KIT", qty: 200, cost: 4.5, currency: "USD" },
  { key: "shop-paint", warehouse: "Workshop Store", sku: "RM-PNT-GRY", qty: 20, cost: 110, currency: "ZIG" },
  { key: "shop-seal", warehouse: "Workshop Store", sku: "RM-SEAL-KIT", qty: 10, cost: 3.2, currency: "USD" },
  { key: "shop-fastener", warehouse: "Workshop Store", sku: "RM-FAST-KIT", qty: 20, cost: 4.5, currency: "USD" },
];

// Rates are only created for a pair that has NO manual rate yet (never overwritten).
export const SEED_RATES: { base: string; quote: string; rates: { rate: number; daysAgo: number }[] }[] = [
  { base: "USD", quote: "ZIG", rates: [{ rate: 26.5, daysAgo: 7 }, { rate: 27.0, daysAgo: 0 }] },
  { base: "ZIG", quote: "USD", rates: [{ rate: 0.037, daysAgo: 0 }] },
  { base: "USD", quote: "ZAR", rates: [{ rate: 18.5, daysAgo: 0 }] },
  { base: "ZAR", quote: "USD", rates: [{ rate: 0.054, daysAgo: 0 }] },
];

export const REQUIRED_CURRENCIES = ["USD", "ZIG", "ZAR"] as const;
