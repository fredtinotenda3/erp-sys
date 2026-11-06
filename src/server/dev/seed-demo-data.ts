// Demo dataset for "Mavuno Packaging Industries (Pvt) Ltd" -- a FICTIONAL
// Zimbabwean rigid-plastic packaging manufacturer, created purely to exercise
// this application's real plastics-manufacturing vertical (Milestone 6) with
// a coherent, presentable business story. This is not based on, and does not
// claim affiliation with, any real company, person, or customer relationship.
//
// Plain data only -- seed-demo.ts turns it into records by calling the
// application's own services (createItem, createBomVersion, createPurchaseOrder,
// issueMaterialToJob, ...), exactly the discipline seed-dev.ts already
// established for the generic development seed. Every business key here
// (SKU, code, name, email) is what lets a re-run find the record instead of
// duplicating it -- see seed-demo.ts's report/plan functions.
//
// Every figure below (weights, cavity counts, cycle times, costs, reorder
// thresholds) is a plausible, internally-consistent plastics-industry number
// chosen for this demo -- not a measurement from any real plant, and not
// read back from device telemetry (this codebase has none -- see
// plastics-process-service.ts's header comment).
import type { Role } from "../shared/authz";

export const ORG = {
  name: "Mavuno Packaging Industries (Pvt) Ltd",
  slug: "mavuno-packaging",
  baseCurrency: "USD",
  tagline: "Precision Packaging. Reliable Manufacturing.",
  firstBranchName: "Harare Plant",
} as const;

export const SECOND_BRANCH_NAME = "Bulawayo Depot";

// Industry-profile modules -- must exactly match profile-registry.ts's
// "plastics" entry's implementedModules keys. Never invented.
export const PLASTICS_MODULES = [
  "plastics_materials",
  "plastics_product_spec",
  "mould_management",
  "plastics_process_detail",
  "regrind_tracking",
  "plastics_analytics",
] as const;

// ---------------------------------------------------------------------------
// Demo users -- 8 named roles from the spec, mapped onto this application's
// real 7-role system (OWNER_ADMIN, OPERATIONS_MANAGER, PRODUCTION_MANAGER,
// INVENTORY_MANAGER, PRODUCTION_OPERATOR, FINANCE_MANAGER, VIEWER). No role is
// invented. The mapping is documented plainly (not glossed over) in
// DEMO_SEED_MANIFEST.md and OPERIS_USER_GUIDE.md.
// ---------------------------------------------------------------------------
export interface SeedUser { email: string; fullName: string; role: Role; title: string }
export const DEMO_USERS: SeedUser[] = [
  { email: "owner@mavunopackaging.test", fullName: "Tendai Mutasa", role: "OWNER_ADMIN", title: "Owner / Administrator" },
  { email: "production.manager@mavunopackaging.test", fullName: "Farai Ndlovu", role: "PRODUCTION_MANAGER", title: "Production Manager" },
  { email: "purchasing@mavunopackaging.test", fullName: "Chiedza Mapfumo", role: "INVENTORY_MANAGER", title: "Purchasing Officer" },
  { email: "warehouse@mavunopackaging.test", fullName: "Tapiwa Gumbo", role: "INVENTORY_MANAGER", title: "Warehouse Manager" },
  { email: "supervisor@mavunopackaging.test", fullName: "Blessing Moyo", role: "PRODUCTION_OPERATOR", title: "Production Supervisor" },
  { email: "operator@mavunopackaging.test", fullName: "Kudakwashe Sibanda", role: "PRODUCTION_OPERATOR", title: "Machine Operator" },
  { email: "quality@mavunopackaging.test", fullName: "Nomsa Dube", role: "PRODUCTION_OPERATOR", title: "Quality Inspector" },
  { email: "sales@mavunopackaging.test", fullName: "Rutendo Chikwava", role: "OPERATIONS_MANAGER", title: "Sales and Dispatch Officer" },
];

// ---------------------------------------------------------------------------
// Work centres ("departments" -- Warehouse has no type/department field in
// this schema, so departments are modelled as WorkCentre, which does belong
// to a branch and carries code/name/dailyCapacityMinutes).
// ---------------------------------------------------------------------------
export interface SeedWorkCentre { code: string; name: string; dailyCapacityMinutes: number }
export const WORK_CENTRES: SeedWorkCentre[] = [
  { code: "WC-RMR", name: "Raw Materials and Receiving", dailyCapacityMinutes: 480 },
  { code: "WC-INJ", name: "Injection Moulding", dailyCapacityMinutes: 1380 }, // 2 machines, ~23h/day across both
  { code: "WC-BLOW", name: "Blow Moulding", dailyCapacityMinutes: 1380 },
  { code: "WC-QA", name: "Quality Assurance", dailyCapacityMinutes: 480 },
  { code: "WC-FGD", name: "Finished Goods and Dispatch", dailyCapacityMinutes: 480 },
  { code: "WC-MAINT", name: "Maintenance", dailyCapacityMinutes: 480 },
];

export interface SeedMachine { code: string; name: string; workCentreCode: string }
export const MACHINES: SeedMachine[] = [
  { code: "INJ-01", name: "Injection Press 150T", workCentreCode: "WC-INJ" },
  { code: "INJ-02", name: "Injection Press 250T", workCentreCode: "WC-INJ" },
  { code: "ISBM-01", name: "Stretch-Blow Moulder (ISBM)", workCentreCode: "WC-BLOW" },
  { code: "EBM-01", name: "Extrusion Blow Moulder", workCentreCode: "WC-BLOW" },
];

// ---------------------------------------------------------------------------
// Warehouses -- Harare Plant: raw materials, WIP, finished goods, quality
// quarantine, regrind/recycled. Bulawayo Depot: a finished-goods forwarding
// warehouse, to demonstrate transferBatch/branch isolation.
// ---------------------------------------------------------------------------
export const WAREHOUSES_HARARE = [
  "Raw Materials Warehouse",
  "Production WIP Store",
  "Finished Goods Warehouse",
  "Quality Quarantine",
  "Regrind and Recycled Materials Store",
] as const;
export const WAREHOUSES_BULAWAYO = ["Bulawayo Finished Goods Store"] as const;

// ---------------------------------------------------------------------------
// Raw materials, consumables and spare parts. Regrind is deliberately NOT a
// separate SKU -- per regrind-service.ts's own header comment, a regrind lot
// is an ordinary MaterialLot of the SAME item it was ground from (RM-PET-VIRGIN
// here), so no "regrind" item is created.
// ---------------------------------------------------------------------------
export interface SeedRawMaterial {
  sku: string; name: string; uom: string; cost: number; currency: string; reorder: number;
  plastics?: { polymerGrade?: string; resinSpec?: string; colourMasterbatch?: string; additiveNotes?: string; recycledContentPct?: number; supplierMaterialRef?: string };
}
export const RAW_MATERIALS: SeedRawMaterial[] = [
  { sku: "RM-PET-VIRGIN", name: "Virgin PET Resin (Bottle Grade)", uom: "kg", cost: 1.15, currency: "USD", reorder: 1500, plastics: { polymerGrade: "PET bottle grade, IV ~0.80", resinSpec: "Intrinsic viscosity 0.78-0.82 dl/g", supplierMaterialRef: "PET-BG-080" } },
  { sku: "RM-RPET-APPROVED", name: "Approved rPET Resin (Food-Contact Recycled)", uom: "kg", cost: 0.78, currency: "USD", reorder: 500, plastics: { polymerGrade: "rPET, food-contact approved", resinSpec: "Decontaminated flake, IV ~0.76 dl/g", recycledContentPct: 100, supplierMaterialRef: "RPET-FC-100" } },
  { sku: "RM-HDPE-VIRGIN", name: "Virgin HDPE Resin (Blow-Moulding Grade)", uom: "kg", cost: 1.05, currency: "USD", reorder: 1000, plastics: { polymerGrade: "HDPE blow-moulding grade", resinSpec: "Density 0.954 g/cm3, MFI 0.3 g/10min", supplierMaterialRef: "HDPE-BM-954" } },
  { sku: "RM-PP-VIRGIN", name: "Virgin PP Resin (Injection Grade)", uom: "kg", cost: 1.10, currency: "USD", reorder: 800, plastics: { polymerGrade: "PP injection grade, homopolymer", resinSpec: "MFI 12 g/10min", supplierMaterialRef: "PP-INJ-012" } },
  { sku: "RM-MB-WHITE", name: "White Colour Masterbatch", uom: "kg", cost: 3.20, currency: "USD", reorder: 100, plastics: { colourMasterbatch: "White, TiO2-based, 50% letdown ratio" } },
  { sku: "RM-MB-BLUE", name: "Blue Colour Masterbatch", uom: "kg", cost: 3.50, currency: "USD", reorder: 60, plastics: { colourMasterbatch: "Pale blue tint, 50% letdown ratio" } },
  { sku: "RM-ADD-UV", name: "UV Stabilizer Additive", uom: "kg", cost: 6.80, currency: "USD", reorder: 30, plastics: { additiveNotes: "HALS-based UV stabiliser, used in closures exposed to sunlight" } },
  { sku: "CS-TRAY-STD", name: "Standard Shipping Tray", uom: "ea", cost: 0.65, currency: "USD", reorder: 500 },
  { sku: "CS-STRETCHWRAP", name: "Pallet Stretch Wrap", uom: "kg", cost: 2.40, currency: "USD", reorder: 80 },
  { sku: "SP-EJECTOR-PIN", name: "Injection Mould Ejector Pin Set", uom: "ea", cost: 45, currency: "USD", reorder: 10 },
  { sku: "SP-SCREW-BARREL", name: "Extruder Screw and Barrel Set", uom: "ea", cost: 380, currency: "USD", reorder: 2 },
];

// ---------------------------------------------------------------------------
// Products: WIP preforms (consumed by a bottle BOM, same two-stage pattern a
// real PET plant uses) and finished goods (bottles, HDPE containers, PP
// closures). Each finished bottle/jerrycan names its compatible closure in
// closureCompatibilityNotes -- never an "impossible" spec.
// ---------------------------------------------------------------------------
export type BomLine = [sku: string, qty: number, uom: string, expectedScrapPct?: number];

export interface SeedProduct {
  sku: string; name: string; uom: string; itemType: "wip" | "finished_good";
  price?: number; // USD selling price -- only for finished_good
  bom: BomLine[]; // v1 (always virgin-only where relevant)
  bomV2?: BomLine[]; // optional second version (used only by the 2L preform, to demonstrate versioning)
  plastics?: {
    productType: string; resinType?: string; colour?: string; nominalWeightGrams?: number; capacityMl?: number;
    heightMm?: number; diameterMm?: number; neckFinish?: string; closureCompatibilityNotes?: string;
  };
}

export const PRODUCTS: SeedProduct[] = [
  // --- PET preforms (WIP) ---------------------------------------------------
  { sku: "WIP-PET-PFM-500", name: "PET Preform 500ml (28mm neck)", uom: "ea", itemType: "wip",
    bom: [["RM-PET-VIRGIN", 0.0125, "kg", 2.5]],
    plastics: { productType: "pet_preform", resinType: "PET", nominalWeightGrams: 12.5, neckFinish: "28mm PCO" } },
  { sku: "WIP-PET-PFM-1L", name: "PET Preform 1L (28mm neck)", uom: "ea", itemType: "wip",
    bom: [["RM-PET-VIRGIN", 0.0225, "kg", 2.5]],
    plastics: { productType: "pet_preform", resinType: "PET", nominalWeightGrams: 22.5, neckFinish: "28mm PCO" } },
  { sku: "WIP-PET-PFM-1.5L", name: "PET Preform 1.5L (28mm neck)", uom: "ea", itemType: "wip",
    bom: [["RM-PET-VIRGIN", 0.0325, "kg", 2.5]],
    plastics: { productType: "pet_preform", resinType: "PET", nominalWeightGrams: 32.5, neckFinish: "28mm PCO" } },
  { sku: "WIP-PET-PFM-2L", name: "PET Preform 2L (28mm neck)", uom: "ea", itemType: "wip",
    bom: [["RM-PET-VIRGIN", 0.0430, "kg", 2.5]],
    bomV2: [["RM-PET-VIRGIN", 0.0301, "kg", 3.0], ["RM-RPET-APPROVED", 0.0129, "kg", 3.0]], // 70/30 virgin/rPET blend
    plastics: { productType: "pet_preform", resinType: "PET / rPET blend", nominalWeightGrams: 43, neckFinish: "28mm PCO" } },

  // --- PET bottles (finished goods, each consumes 1 preform) ---------------
  { sku: "FG-PET-BTL-500", name: "PET Bottle 500ml", uom: "ea", itemType: "finished_good", price: 0.095,
    bom: [["WIP-PET-PFM-500", 1, "ea", 1.5]],
    plastics: { productType: "pet_bottle", resinType: "PET", colour: "Clear", nominalWeightGrams: 12.3, capacityMl: 500, heightMm: 210, diameterMm: 62, neckFinish: "28mm PCO", closureCompatibilityNotes: "Compatible closure: FG-PP-CAP-28 (28mm PCO)" } },
  { sku: "FG-PET-BTL-1000", name: "PET Bottle 1L", uom: "ea", itemType: "finished_good", price: 0.165,
    bom: [["WIP-PET-PFM-1L", 1, "ea", 1.5]],
    plastics: { productType: "pet_bottle", resinType: "PET", colour: "Clear", nominalWeightGrams: 22.1, capacityMl: 1000, heightMm: 280, diameterMm: 75, neckFinish: "28mm PCO", closureCompatibilityNotes: "Compatible closure: FG-PP-CAP-28 (28mm PCO)" } },
  { sku: "FG-PET-BTL-1500", name: "PET Bottle 1.5L", uom: "ea", itemType: "finished_good", price: 0.225,
    bom: [["WIP-PET-PFM-1.5L", 1, "ea", 1.8]],
    plastics: { productType: "pet_bottle", resinType: "PET", colour: "Clear", nominalWeightGrams: 31.9, capacityMl: 1500, heightMm: 320, diameterMm: 85, neckFinish: "28mm PCO", closureCompatibilityNotes: "Compatible closure: FG-PP-CAP-38 (38mm)" } },
  { sku: "FG-PET-BTL-2000", name: "PET Bottle 2L", uom: "ea", itemType: "finished_good", price: 0.285,
    bom: [["WIP-PET-PFM-2L", 1, "ea", 1.8]],
    plastics: { productType: "pet_bottle", resinType: "PET / rPET blend", colour: "Clear", nominalWeightGrams: 41.6, capacityMl: 2000, heightMm: 340, diameterMm: 95, neckFinish: "28mm PCO", closureCompatibilityNotes: "Compatible closure: FG-PP-CAP-38 (38mm)" } },

  // --- HDPE products (direct resin blow moulding, no preform stage) --------
  { sku: "FG-HDPE-BTL-500D", name: "HDPE Detergent Bottle 500ml", uom: "ea", itemType: "finished_good", price: 0.145,
    bom: [["RM-HDPE-VIRGIN", 0.0280, "kg", 3.0], ["RM-MB-WHITE", 0.0006, "kg", 3.0]],
    plastics: { productType: "hdpe_bottle", resinType: "HDPE", colour: "White", nominalWeightGrams: 28, capacityMl: 500, heightMm: 195, diameterMm: 70, neckFinish: "24mm screw", closureCompatibilityNotes: "Compatible closure: FG-PP-CAP-FLIP (24/28mm flip-top)" } },
  { sku: "FG-HDPE-BTL-1000C", name: "HDPE Household Chemical Bottle 1L", uom: "ea", itemType: "finished_good", price: 0.195,
    bom: [["RM-HDPE-VIRGIN", 0.0450, "kg", 3.0], ["RM-MB-BLUE", 0.0009, "kg", 3.0]],
    plastics: { productType: "hdpe_bottle", resinType: "HDPE", colour: "Pale blue tint", nominalWeightGrams: 45, capacityMl: 1000, heightMm: 250, diameterMm: 90, neckFinish: "28mm screw", closureCompatibilityNotes: "Compatible closure: FG-PP-CAP-FLIP (24/28mm flip-top)" } },
  { sku: "FG-HDPE-JC-5000", name: "HDPE Jerrycan 5L", uom: "ea", itemType: "finished_good", price: 0.780,
    bom: [["RM-HDPE-VIRGIN", 0.1900, "kg", 2.5], ["RM-MB-WHITE", 0.0025, "kg", 2.5]],
    plastics: { productType: "hdpe_jerrycan", resinType: "HDPE", colour: "White", nominalWeightGrams: 190, capacityMl: 5000, heightMm: 330, diameterMm: 220, neckFinish: "63mm screw with handle", closureCompatibilityNotes: "Compatible closure: FG-PP-CAP-GEN (63mm tamper-evident)" } },

  // --- PP closures ----------------------------------------------------------
  { sku: "FG-PP-CAP-28", name: "PP Closure 28mm (Beverage)", uom: "ea", itemType: "finished_good", price: 0.018,
    bom: [["RM-PP-VIRGIN", 0.0018, "kg", 1.0]],
    plastics: { productType: "pp_closure", resinType: "PP", colour: "White", nominalWeightGrams: 1.8, neckFinish: "28mm PCO", closureCompatibilityNotes: "Fits FG-PET-BTL-500, FG-PET-BTL-1000" } },
  { sku: "FG-PP-CAP-38", name: "PP Closure 38mm (Wide-Mouth)", uom: "ea", itemType: "finished_good", price: 0.026,
    bom: [["RM-PP-VIRGIN", 0.0026, "kg", 1.0]],
    plastics: { productType: "pp_closure", resinType: "PP", colour: "White", nominalWeightGrams: 2.6, neckFinish: "38mm", closureCompatibilityNotes: "Fits FG-PET-BTL-1500, FG-PET-BTL-2000" } },
  { sku: "FG-PP-CAP-FLIP", name: "PP Household Flip-Top Closure", uom: "ea", itemType: "finished_good", price: 0.042,
    bom: [["RM-PP-VIRGIN", 0.0042, "kg", 1.2], ["RM-ADD-UV", 0.00005, "kg", 1.2]],
    plastics: { productType: "pp_closure", resinType: "PP", colour: "White", nominalWeightGrams: 4.2, neckFinish: "24/28mm flip-top", closureCompatibilityNotes: "Fits FG-HDPE-BTL-500D, FG-HDPE-BTL-1000C" } },
  { sku: "FG-PP-CAP-GEN", name: "PP Jerrycan Closure 63mm (Tamper-Evident)", uom: "ea", itemType: "finished_good", price: 0.065,
    bom: [["RM-PP-VIRGIN", 0.0065, "kg", 1.0]],
    plastics: { productType: "pp_closure", resinType: "PP", colour: "White", nominalWeightGrams: 6.5, neckFinish: "63mm tamper-evident", closureCompatibilityNotes: "Fits FG-HDPE-JC-5000" } },
];

// ---------------------------------------------------------------------------
// Moulds -- branch-scoped, cut for one product each, compatible with one or
// more machines. Cavity counts are realistic for the process (high-cavity for
// small injection parts, low-cavity for blow moulding).
// ---------------------------------------------------------------------------
export interface SeedMould { code: string; name: string; cavityCount: number; productSku: string; machineCodes: string[] }
export const MOULDS: SeedMould[] = [
  { code: "MLD-PFM-500", name: "Preform Mould 500ml", cavityCount: 8, productSku: "WIP-PET-PFM-500", machineCodes: ["INJ-01", "INJ-02"] },
  { code: "MLD-PFM-1L", name: "Preform Mould 1L", cavityCount: 6, productSku: "WIP-PET-PFM-1L", machineCodes: ["INJ-01", "INJ-02"] },
  { code: "MLD-PFM-1.5L", name: "Preform Mould 1.5L", cavityCount: 6, productSku: "WIP-PET-PFM-1.5L", machineCodes: ["INJ-01", "INJ-02"] },
  { code: "MLD-PFM-2L", name: "Preform Mould 2L", cavityCount: 4, productSku: "WIP-PET-PFM-2L", machineCodes: ["INJ-01", "INJ-02"] },
  { code: "MLD-CAP-28", name: "Closure Mould 28mm", cavityCount: 16, productSku: "FG-PP-CAP-28", machineCodes: ["INJ-01", "INJ-02"] },
  { code: "MLD-CAP-38", name: "Closure Mould 38mm", cavityCount: 16, productSku: "FG-PP-CAP-38", machineCodes: ["INJ-01", "INJ-02"] },
  { code: "MLD-CAP-FLIP", name: "Closure Mould Flip-Top", cavityCount: 8, productSku: "FG-PP-CAP-FLIP", machineCodes: ["INJ-01", "INJ-02"] },
  { code: "MLD-CAP-GEN", name: "Closure Mould 63mm Tamper-Evident", cavityCount: 12, productSku: "FG-PP-CAP-GEN", machineCodes: ["INJ-01", "INJ-02"] },
  { code: "MLD-BTL-500", name: "Bottle Blow Mould 500ml", cavityCount: 2, productSku: "FG-PET-BTL-500", machineCodes: ["ISBM-01"] },
  { code: "MLD-BTL-1L", name: "Bottle Blow Mould 1L", cavityCount: 2, productSku: "FG-PET-BTL-1000", machineCodes: ["ISBM-01"] },
  { code: "MLD-BTL-1.5L", name: "Bottle Blow Mould 1.5L", cavityCount: 1, productSku: "FG-PET-BTL-1500", machineCodes: ["ISBM-01"] },
  { code: "MLD-BTL-2L", name: "Bottle Blow Mould 2L", cavityCount: 1, productSku: "FG-PET-BTL-2000", machineCodes: ["ISBM-01"] },
  { code: "MLD-HDPE-500D", name: "HDPE Blow Mould 500ml Detergent", cavityCount: 2, productSku: "FG-HDPE-BTL-500D", machineCodes: ["EBM-01"] },
  { code: "MLD-HDPE-1LC", name: "HDPE Blow Mould 1L Chemical", cavityCount: 2, productSku: "FG-HDPE-BTL-1000C", machineCodes: ["EBM-01"] },
  { code: "MLD-HDPE-JC5L", name: "HDPE Blow Mould 5L Jerrycan", cavityCount: 1, productSku: "FG-HDPE-JC-5000", machineCodes: ["EBM-01"] },
];

// ---------------------------------------------------------------------------
// Suppliers (8-12, fictional) and customers (12-15, fictional). Supplier and
// Customer models here deliberately carry only {name, contact, address,
// notes, status} -- no dedicated payment-terms field -- so payment terms are
// represented as free text inside notes, never an invented schema field.
// ---------------------------------------------------------------------------
export interface SeedSupplier { name: string; contact: string; address: string; notes: string; category: string }
export const SUPPLIERS: SeedSupplier[] = [
  { name: "Harare Polymers (Pvt) Ltd", contact: "Sales desk, +263 24 277 0112", address: "14 Birmingham Road, Workington, Harare", notes: "Primary virgin PET and rPET resin supplier. Payment terms: 30 days net.", category: "resin" },
  { name: "ZimPlast Resins (Pvt) Ltd", contact: "Account manager, +263 24 266 4410", address: "88 Mutare Road, Msasa, Harare", notes: "Virgin HDPE and PP resin supplier. Payment terms: 21 days net.", category: "resin" },
  { name: "Southern Polymer Traders", contact: "Procurement, +27 11 555 0193", address: "Unit 4, Alrode Industrial Park, Johannesburg, South Africa", notes: "Secondary resin supplier (cross-border, ZAR invoicing). Payment terms: 45 days net.", category: "resin" },
  { name: "ColorTech Zimbabwe", contact: "Technical sales, +263 24 262 1187", address: "22 Coventry Road, Workington, Harare", notes: "Colour masterbatch and additive supplier. Payment terms: 30 days net.", category: "masterbatch" },
  { name: "Africa Additives & Compounds", contact: "Sales, +27 21 555 0244", address: "7 Bellville Industrial Avenue, Cape Town, South Africa", notes: "UV stabiliser and specialty additive supplier. Payment terms: cash on delivery.", category: "masterbatch" },
  { name: "Harare Packaging Supplies", contact: "Orders desk, +263 24 270 5523", address: "41 Seke Road, Graniteside, Harare", notes: "Shipping trays, stretch wrap and general packaging consumables. Payment terms: 14 days net.", category: "packaging" },
  { name: "Mutare Industrial Consumables", contact: "Branch manager, +263 20 264 4471", address: "9 Herbert Chitepo Street, Mutare", notes: "Secondary packaging consumables supplier. Payment terms: 30 days net.", category: "packaging" },
  { name: "Industrial Spares Zimbabwe", contact: "Parts counter, +263 24 275 8820", address: "15 Mazoe Street, Harare", notes: "Mould and machine spare parts, ejector pins, screws and barrels. Payment terms: cash on delivery.", category: "maintenance" },
  { name: "Bulawayo Engineering Spares", contact: "Sales, +263 29 226 1134", address: "33 Fife Street, Bulawayo", notes: "Secondary spares and maintenance consumables supplier. Payment terms: 14 days net.", category: "maintenance" },
  { name: "Precision Tooling & Moulds Africa", contact: "Technical director, +27 11 555 0871", address: "12 Aeroport Road, Kempton Park, South Africa", notes: "Mould fabrication and major tooling refurbishment. Payment terms: 50% deposit, balance on delivery.", category: "maintenance" },
];

export interface SeedCustomer { name: string; contact: string; address: string; notes: string; segment: string }
export const CUSTOMERS: SeedCustomer[] = [
  { name: "Delta Beverages Bottling (Pvt) Ltd", contact: "Packaging procurement, +263 24 275 0021", address: "Southerton, Harare", notes: "Beverage bottler. Payment terms: 30 days net. High-volume PET bottle customer.", segment: "beverage_bottler" },
  { name: "Mazoe Valley Bottlers", contact: "Supply chain office, +263 24 262 7740", address: "Msasa, Harare", notes: "Beverage bottler. Payment terms: 21 days net.", segment: "beverage_bottler" },
  { name: "Highveld Pure Water Co.", contact: "Procurement, +263 24 233 4410", address: "Ruwa, near Harare", notes: "Bottled water manufacturer. Payment terms: 30 days net.", segment: "water_manufacturer" },
  { name: "Nyanga Springs Water (Pvt) Ltd", contact: "Owner-manager, +263 29 884 2210", address: "Nyanga, Manicaland", notes: "Bottled water manufacturer. Payment terms: cash on delivery.", segment: "water_manufacturer" },
  { name: "Mukuru Foods Processing", contact: "Procurement manager, +263 24 266 1198", address: "Willowvale, Harare", notes: "Food processor (sauces and cooking oil packaging). Payment terms: 30 days net.", segment: "food_processor" },
  { name: "Chegutu AgriProcessors", contact: "Operations office, +263 54 221 1056", address: "Chegutu, Mashonaland West", notes: "Food processor. Payment terms: 14 days net.", segment: "food_processor" },
  { name: "Sunshine Home Care Products", contact: "Purchasing, +263 24 262 8830", address: "Graniteside, Harare", notes: "Detergent and household chemical manufacturer. Payment terms: 30 days net.", segment: "detergent_manufacturer" },
  { name: "CleanBright Chemicals (Pvt) Ltd", contact: "Procurement, +263 24 270 9941", address: "Msasa, Harare", notes: "Detergent manufacturer. Payment terms: 21 days net.", segment: "detergent_manufacturer" },
  { name: "Zambezi Personal Care Ltd", contact: "Supply chain, +263 24 233 7762", address: "Southerton, Harare", notes: "Personal care manufacturer (lotions, shampoos). Payment terms: 30 days net.", segment: "personal_care_manufacturer" },
  { name: "Savanna Cosmetics Group", contact: "Buyer, +263 29 226 5540", address: "Bulawayo", notes: "Personal care manufacturer. Payment terms: 30 days net.", segment: "personal_care_manufacturer" },
  { name: "Great Dyke Agro-Chemicals", contact: "Procurement office, +263 24 262 0087", address: "Msasa, Harare", notes: "Agricultural and industrial chemical manufacturer (jerrycan customer). Payment terms: 45 days net.", segment: "agri_chemical_manufacturer" },
  { name: "Matabeleland Industrial Chemicals", contact: "Operations, +263 29 226 8841", address: "Bulawayo", notes: "Industrial chemical manufacturer. Payment terms: 30 days net.", segment: "agri_chemical_manufacturer" },
  { name: "Gokwe Cotton & Oil Processors", contact: "Procurement, +263 54 338 2214", address: "Gokwe, Midlands", notes: "Food processor (cooking oil). Payment terms: 30 days net.", segment: "food_processor" },
  { name: "Lowveld Beverages (Pvt) Ltd", contact: "Packaging buyer, +263 31 234 1187", address: "Chiredzi, Masvingo", notes: "Beverage bottler. Payment terms: 21 days net.", segment: "beverage_bottler" },
];

// ---------------------------------------------------------------------------
// Exchange rates -- reuses the SAME three currencies the existing dev seed
// already requires to be present (USD/ZIG/ZAR); no new currency is invented.
// RBZ_OFFICIAL (Reserve Bank of Zimbabwe) and MARKET sources, matching the
// ExchangeRate.source enum's own real-world intent.
// ---------------------------------------------------------------------------
export const EXCHANGE_RATES: { base: string; quote: string; source: "RBZ_OFFICIAL" | "MARKET"; rates: { rate: number; daysAgo: number }[] }[] = [
  { base: "USD", quote: "ZIG", source: "RBZ_OFFICIAL", rates: [{ rate: 26.8, daysAgo: 30 }, { rate: 27.4, daysAgo: 7 }] },
  { base: "ZIG", quote: "USD", source: "RBZ_OFFICIAL", rates: [{ rate: 0.0365, daysAgo: 7 }] },
  { base: "USD", quote: "ZAR", source: "MARKET", rates: [{ rate: 18.3, daysAgo: 0 }] },
  { base: "ZAR", quote: "USD", source: "MARKET", rates: [{ rate: 0.0546, daysAgo: 0 }] },
];

// ---------------------------------------------------------------------------
// Inspection plans -- one incoming raw-material plan, two finished-good plans.
// ---------------------------------------------------------------------------
export interface SeedCharacteristic { name: string; uom?: string; minValue?: number; maxValue?: number; targetValue?: number }
export interface SeedInspectionPlan { itemSku: string; name: string; characteristics: SeedCharacteristic[] }
export const INSPECTION_PLANS: SeedInspectionPlan[] = [
  {
    itemSku: "RM-PET-VIRGIN",
    name: "Incoming Virgin PET Resin Inspection",
    characteristics: [
      { name: "Intrinsic Viscosity", uom: "dl/g", minValue: 0.78, maxValue: 0.82, targetValue: 0.80 },
      { name: "Moisture Content", uom: "%", minValue: 0, maxValue: 0.02, targetValue: 0.01 },
    ],
  },
  {
    itemSku: "FG-PET-BTL-2000",
    name: "PET Bottle 2L Finished-Good Inspection",
    characteristics: [
      { name: "Bottle Weight", uom: "g", minValue: 40.0, maxValue: 43.5, targetValue: 41.6 },
      { name: "Wall Thickness (Base)", uom: "mm", minValue: 0.28, maxValue: 0.42, targetValue: 0.35 },
      { name: "Top-Load Strength", uom: "N", minValue: 110, maxValue: 180, targetValue: 150 },
    ],
  },
  {
    itemSku: "FG-PP-CAP-28",
    name: "PP Closure 28mm Finished-Good Inspection",
    characteristics: [
      { name: "Closure Weight", uom: "g", minValue: 1.65, maxValue: 1.95, targetValue: 1.80 },
      { name: "Removal Torque", uom: "N.cm", minValue: 8, maxValue: 18, targetValue: 13 },
    ],
  },
];

export const REQUIRED_CURRENCIES = ["USD", "ZIG", "ZAR"] as const;
