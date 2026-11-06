# Demo Data Catalogue — Mavuno Packaging Industries (Pvt) Ltd

**Fictional company. Fictional people. Fictional transactions.** "Mavuno Packaging Industries (Pvt) Ltd" is a rigid-plastics packaging manufacturer in Harare, Zimbabwe, invented solely to give this application's real plastics-manufacturing vertical a coherent, presentable demo story. It is not based on, and does not claim affiliation with, ALPLA, Visy, Plastipak, or any other real company — those names informed only the general shape of the industry while this dataset was designed, and no real company's products, branding, pricing, or data appear anywhere below. Every supplier, customer, employee name, job, quantity, and figure in this catalogue is synthetic, authored for this demonstration.

This document describes what exists after a successful `npm run seed:demo -- --apply` run (see `DEMO_SEED_MANIFEST.md` for the exact command and environment variables). All of it was created through the application's own real service functions — never a raw database insert — so every record you see in the UI after seeding is exactly as "real" to the application as anything a human user would create by hand.

---

## 1. Organization

| Field | Value |
|---|---|
| Name | Mavuno Packaging Industries (Pvt) Ltd |
| Slug | `mavuno-packaging` |
| Base currency | USD |
| Tagline | "Precision Packaging. Reliable Manufacturing." |
| Industry profile | `plastics`, with modules `plastics_materials`, `plastics_product_spec`, `mould_management`, `plastics_process_detail`, `regrind_tracking`, `plastics_analytics` all enabled |
| Branches | **Harare Plant** (the organization's first branch, created at bootstrap) and **Bulawayo Depot** (a second branch, added to demonstrate branch isolation and cross-branch transfer) |

## 2. People (8 demo users)

| Title | Email | Role | Branch access |
|---|---|---|---|
| Owner / Administrator — Tendai Mutasa | owner@mavunopackaging.test | OWNER_ADMIN | Implicit, all branches (OWNER_ADMIN never needs an explicit grant) |
| Production Manager — Farai Ndlovu | production.manager@mavunopackaging.test | PRODUCTION_MANAGER | Harare Plant |
| Purchasing Officer — Chiedza Mapfumo | purchasing@mavunopackaging.test | INVENTORY_MANAGER | Harare Plant |
| Warehouse Manager — Tapiwa Gumbo | warehouse@mavunopackaging.test | INVENTORY_MANAGER | Harare Plant + Bulawayo Depot |
| Production Supervisor — Blessing Moyo | supervisor@mavunopackaging.test | PRODUCTION_OPERATOR | Harare Plant |
| Machine Operator — Kudakwashe Sibanda | operator@mavunopackaging.test | PRODUCTION_OPERATOR | Harare Plant |
| Quality Inspector — Nomsa Dube | quality@mavunopackaging.test | PRODUCTION_OPERATOR | Harare Plant |
| Sales and Dispatch Officer — Rutendo Chikwava | sales@mavunopackaging.test | OPERATIONS_MANAGER | Harare Plant + Bulawayo Depot |

See `DEMO_SEED_MANIFEST.md` §7–8 for exactly which real capability each title exercises and why, including the two segregation-of-duties points this demo deliberately shows (PO confirmation, QA disposition authority).

## 3. Shop floor — work centres, machines, moulds

**Work centres** (`WC-RMR` Raw Materials & Receiving, `WC-INJ` Injection Moulding, `WC-BLOW` Blow Moulding, `WC-QA` Quality Assurance, `WC-FGD` Finished Goods & Dispatch, `WC-MAINT` Maintenance) model Mavuno's departments — this schema has no separate "department" field, so, as the codebase's own `WorkCentre` model already does, each department is represented as a work centre.

**Machines:** `INJ-01` (150T injection press), `INJ-02` (250T injection press) under WC-INJ; `ISBM-01` (stretch-blow moulder, used for PET bottles) and `EBM-01` (extrusion blow moulder, used for HDPE products) under WC-BLOW.

**Moulds (15):** one per finished part, each compatible with the machine(s) that actually run it:

| Mould | Product | Cavities | Machine(s) |
|---|---|---|---|
| MLD-PFM-500 / -1L / -1.5L / -2L | PET preforms, 4 sizes | 8 / 6 / 6 / 4 | INJ-01, INJ-02 |
| MLD-CAP-28 / -38 / -FLIP / -GEN | PP closures, 4 variants | 16 / 16 / 8 / 12 | INJ-01, INJ-02 |
| MLD-BTL-500 / -1L / -1.5L / -2L | PET bottles, 4 sizes | 2 / 2 / 1 / 1 | ISBM-01 |
| MLD-HDPE-500D / -1LC / -JC5L | HDPE products, 3 variants | 2 / 2 / 1 | EBM-01 |

High cavity counts on small injection parts (16 for closures) and low cavity counts on blow-moulded items (1–2) are the realistic, industry-typical pattern for each process.

## 4. Warehouses (6)

Harare Plant: Raw Materials Warehouse, Production WIP Store, Finished Goods Warehouse, Quality Quarantine, Regrind and Recycled Materials Store. Bulawayo Depot: Bulawayo Finished Goods Store (a forwarding warehouse, used only to receive a cross-branch transfer and dispatch from there — see Scenario E).

## 5. Catalog — 26 items

### Raw materials, consumables, spare parts (11)

| SKU | Name | UoM | Standard cost | Plastics attributes |
|---|---|---|---|---|
| RM-PET-VIRGIN | Virgin PET Resin (Bottle Grade) | kg | $1.15 | IV 0.78–0.82 dl/g |
| RM-RPET-APPROVED | Approved rPET Resin (Food-Contact Recycled) | kg | $0.78 | 100% recycled content, food-contact approved |
| RM-HDPE-VIRGIN | Virgin HDPE Resin (Blow-Moulding Grade) | kg | $1.05 | Density 0.954 g/cm³ |
| RM-PP-VIRGIN | Virgin PP Resin (Injection Grade) | kg | $1.10 | MFI 12 g/10min |
| RM-MB-WHITE | White Colour Masterbatch | kg | $3.20 | TiO2-based, 50% letdown |
| RM-MB-BLUE | Blue Colour Masterbatch | kg | $3.50 | 50% letdown |
| RM-ADD-UV | UV Stabilizer Additive | kg | $6.80 | HALS-based |
| CS-TRAY-STD | Standard Shipping Tray | ea | $0.65 | — (consumable) |
| CS-STRETCHWRAP | Pallet Stretch Wrap | kg | $2.40 | — (consumable) |
| SP-EJECTOR-PIN | Injection Mould Ejector Pin Set | ea | $45 | — (spare part) |
| SP-SCREW-BARREL | Extruder Screw and Barrel Set | ea | $380 | — (spare part) |

**Regrind is deliberately not a separate SKU.** Per this codebase's own `regrind-service.ts` design, a regrind lot is an ordinary `MaterialLot` of the *same* item it was ground from — so the demo's one regrind lot sits under `RM-PET-VIRGIN`, not a fabricated "RM-REGRIND" item.

### Products (15): WIP preforms + finished goods

| SKU | Name | Type | Price (USD) | BOM (v1) |
|---|---|---|---|---|
| WIP-PET-PFM-500/1L/1.5L/2L | PET Preforms, 4 sizes | wip | — | virgin PET only |
| FG-PET-BTL-500/1000/1500/2000 | PET Bottles, 4 sizes | finished_good | $0.095 / $0.165 / $0.225 / $0.285 | 1 matching preform each |
| FG-HDPE-BTL-500D | HDPE Detergent Bottle 500ml | finished_good | $0.145 | virgin HDPE + white masterbatch |
| FG-HDPE-BTL-1000C | HDPE Household Chemical Bottle 1L | finished_good | $0.195 | virgin HDPE + blue masterbatch |
| FG-HDPE-JC-5000 | HDPE Jerrycan 5L | finished_good | $0.780 | virgin HDPE + white masterbatch |
| FG-PP-CAP-28/-38/-FLIP/-GEN | PP Closures, 4 variants | finished_good | $0.018 / $0.026 / $0.042 / $0.065 | virgin PP (+ UV additive for -FLIP) |

**BOM versioning (`WIP-PET-PFM-2L` only):** v1 is 100% virgin PET (0.0430 kg/preform). **v2**, activated mid-sequence (after Job A1 has already snapshotted v1, before Job A3 is created — a real version-history change, not a cosmetic one), is a 70/30 virgin/rPET blend (0.0301 kg virgin + 0.0129 kg rPET). This is the only product with a second BOM version in this demo.

Closures each document which bottle/container they fit (`closureCompatibilityNotes`), e.g. FG-PP-CAP-28 fits FG-PET-BTL-500 and FG-PET-BTL-1000 — never an "impossible" pairing.

## 6. Suppliers (10) and customers (14)

Suppliers span resin (Harare Polymers, ZimPlast Resins, Southern Polymer Traders), masterbatch/additives (ColorTech Zimbabwe, Africa Additives & Compounds), packaging consumables (Harare Packaging Supplies, Mutare Industrial Consumables), and maintenance/tooling (Industrial Spares Zimbabwe, Bulawayo Engineering Spares, Precision Tooling & Moulds Africa). Customers span beverage bottlers, water manufacturers, food processors, detergent manufacturers, personal-care manufacturers, and agro-chemical manufacturers — see `src/server/dev/seed-demo-data.ts`'s `SUPPLIERS`/`CUSTOMERS` arrays for every name, contact, address and payment-terms note. Payment terms are stored as free text inside each party's `notes` field — this schema has no dedicated payment-terms column, so none was invented.

## 7. Exchange rates (4 currency pairs)

| Pair | Source | Rate(s) |
|---|---|---|
| USD → ZIG | RBZ_OFFICIAL | 26.8 (30 days ago), 27.4 (7 days ago) |
| ZIG → USD | RBZ_OFFICIAL | 0.0365 (7 days ago) |
| USD → ZAR | MARKET | 18.3 (today) |
| ZAR → USD | MARKET | 0.0546 (today) |

Reuses the three currencies (`USD`, `ZIG`, `ZAR`) this application's base reference data already requires — no new currency was invented. `ZIG` (Zimbabwe Gold) is the currency code already present in this codebase's required-currency list, not a typo for `ZWG`.

## 8. Inspection plans (3)

| Plan | Item | Characteristics |
|---|---|---|
| Incoming Virgin PET Resin Inspection | RM-PET-VIRGIN | Intrinsic Viscosity (0.78–0.82 dl/g), Moisture Content (0–0.02%) |
| PET Bottle 2L Finished-Good Inspection | FG-PET-BTL-2000 | Bottle Weight (40.0–43.5g), Wall Thickness Base (0.28–0.42mm), Top-Load Strength (110–180N) |
| PP Closure 28mm Finished-Good Inspection | FG-PP-CAP-28 | Closure Weight (1.65–1.95g), Removal Torque (8–18 N·cm) |

## 9. Purchase orders (8) and goods receipts

| Key | Supplier | Lines | Target status |
|---|---|---|---|
| po1-resin-pet | Harare Polymers | 5,000 kg virgin PET @ $1.15; 1,500 kg rPET @ $0.78 | **received** |
| po2-resin-hdpe-pp | ZimPlast Resins | 3,000 kg HDPE @ $1.05; 2,000 kg PP @ $1.10 | **received** |
| po3-masterbatch | ColorTech Zimbabwe | 150 kg white MB; 80 kg blue MB; 40 kg UV additive | **received** |
| po4-packaging | Harare Packaging Supplies | 1,000 trays; 150 kg stretch wrap | **received** |
| po5-spares | Industrial Spares Zimbabwe | 20 ejector pins; 3 screw/barrel sets | **partially received** — ejector pins 100% accepted, screw/barrel sets 1/3 accepted, remainder stays outstanding |
| po6-resin-pet-2 | Harare Polymers | 2,000 kg virgin PET @ $1.18 | **confirmed**, not yet received |
| po7-resin-pp-draft | ZimPlast Resins | 1,000 kg PP @ $1.12 | **draft**, never confirmed |
| po8-spares-bulawayo | Bulawayo Engineering Spares | 10 ejector pins @ $48 | **closed** |

Every accepted receipt line auto-generates a `LOT-######` `MaterialLot` via the application's own `nextLotNumber()` sequence and `receiveGoodsForPurchaseOrder` service — this demo never assigns a lot number itself. This gives the Raw Materials Warehouse and Regrind Store real, traceable lot genealogy from the moment resin arrives.

## 10. Sales orders (6)

| Key | Customer | Item | Qty | Unit price | Status |
|---|---|---|---|---|---|
| so1-bottler-2l | Delta Beverages Bottling | FG-PET-BTL-2000 | 1,730 | $0.285 | confirmed, fully dispatched & delivered (Scenario E) |
| so2-water-500 | Highveld Pure Water Co. | FG-PET-BTL-500 | 10,000 | $0.095 | **draft** |
| so3-detergent-500 | Sunshine Home Care Products | FG-HDPE-BTL-500D | 19,700 | $0.145 | confirmed, fully dispatched & delivered (Scenario E) |
| so4-food-caps28 | Mukuru Foods Processing | FG-PP-CAP-28 | 100,000 | $0.018 | **confirmed**, not yet produced/dispatched |
| so5-personal-care-flip | Zambezi Personal Care Ltd | FG-PP-CAP-FLIP | 15,000 | $0.042 | **cancelled** (customer changed the closure neck-size spec before production started) |
| so6-agrichem-jc | Great Dyke Agro-Chemicals | FG-HDPE-JC-5000 | 2,000 | $0.78 | **draft** |

## 11. Production jobs (6) and the 5 demo scenarios

```
Job A1 ──(preforms)──▶ Job A2 ──(bottles, SO1)──▶ dispatch/transfer/dispatch ──▶ delivered
                            │
                            └─ scrap + QA-scrapped rejects ──▶ regrind lot
                                                                    │
Job A3 (BOM v2, virgin + rPET + regrind) ◀─────────────────────────┘

Job B1 (closures, completed, rework disposition)
Job B2 (closures, left in_progress, open QA decision)

Job C1 (HDPE bottle, SO3) ──▶ dispatch ──▶ delivered
```

| Job | Product | Planned qty | Stage / process | Output (good/scrap) | QC | Status | Scenario(s) |
|---|---|---|---|---|---|---|---|
| **A1** | WIP-PET-PFM-2L (v1 BOM) | 2,000 | Injection Moulding, INJ-01, mould MLD-PFM-2L, 4 cavities | 1,960 / 40 (start-of-run short shots) | none (checked downstream) | completed, received into Production WIP Store | A |
| **A2** | FG-PET-BTL-2000 | 1,800 | Blow Moulding, ISBM-01, mould MLD-BTL-2L | 1,750 / 50 (neck deformation) | inspected 1,750; 20 rejected (wall thickness) → **scrap** disposition; 1,730 received to FG | A, D (scrap source), E (SO1) |
| **A3** | WIP-PET-PFM-2L (v2 BOM, virgin/rPET/regrind blend) | 2,500 | Injection Moulding, INJ-02, mould MLD-PFM-2L | 2,450 / 50 (blend-changeover purge) | none | completed, received into Production WIP Store | D (regrind reuse closes the loop) |
| **B1** | FG-PP-CAP-28 | 50,000 | Injection Moulding, INJ-02, mould MLD-CAP-28, 16 cavities (15 good) | 48,500 / 1,500 (undersized, cavity 7) | inspected 48,500; 300 rejected (gate flash) → **rework** disposition; 48,200 received to FG | B |
| **B2** | FG-PP-CAP-38 | 20,000 | Injection Moulding, INJ-01, mould MLD-CAP-38, 16 cavities (all good) | 19,600 / 400 (early-cycle rejects) | inspected 19,600; 150 rejected (undersized sealing lip) — **no disposition recorded yet** | **in_progress — live pending QA decision** | B (live workflow state) |
| **C1** | FG-HDPE-BTL-500D | 19,700 | Blow Moulding, EBM-01, mould MLD-HDPE-500D, 2 cavities | 19,700 / 300 (weld-line flash tearing) | inspected 19,700; 0 rejected — full pass | completed, received into Finished Goods Warehouse | C, E (SO3) |

**Regrind lot (Scenario D):** 70 units of Job A2's scrap/rejects (50 blow-moulding scrap + 20 QA-scrapped) ground back to resin equivalent ≈ 2.91 kg, recorded as a `MaterialLot` of `RM-PET-VIRGIN` in the Regrind and Recycled Materials Store, cost $0.70/kg, created via `createRegrindLot` by the Warehouse Manager. Job A3 then issues from **three separate sources** against the same product — virgin resin (76 kg) and approved rPET (33 kg) from the Raw Materials Warehouse, plus the full regrind lot from the Regrind Store — demonstrating real, controlled regrind reuse with unbroken cost/lot genealogy: each issue carries its own warehouse's own weighted-average cost, not a blended guess.

**Job B2 is deliberately left mid-workflow**, mirroring the base application's own `seed-dev.ts` pattern (its Job J2): a real "awaiting decision" state — an open inspection with no disposition yet — rather than a synthetic "pending" flag, so the demo can show what an actual unresolved QA decision looks like in this system.

## 12. Finished-goods fulfilment (Scenario E)

**SO1 (Delta Beverages Bottling, 1,730 × FG-PET-BTL-2000, from Job A2's batch):**
1. Dispatch 1 — 1,000 units from Harare Finished Goods Warehouse, carrier "Mavuno own fleet," tracking MVN-TRK-0001 → delivered.
2. `transferBatch` — the remaining 730 units moved from Harare Finished Goods Warehouse to Bulawayo Finished Goods Store (demonstrates cross-branch batch movement, not a second production run).
3. Dispatch 2 — 730 units from the Bulawayo depot, tracking MVN-TRK-0002 → delivered. SO1 is now fully delivered.

**SO3 (Sunshine Home Care Products, 19,700 × FG-HDPE-BTL-500D, from Job C1's batch):** one full dispatch from Harare Finished Goods Warehouse, third-party courier "Swift Logistics," tracking SWIFT-88213 → delivered. SO3 is now fully delivered.

## 13. Scenario-to-record index

| Scenario | What it demonstrates | Primary records |
|---|---|---|
| **A** — PET bottle manufacturing end to end | Preform injection moulding → bottle blow moulding, two linked jobs, mould/machine/cycle-time detail at each stage | Job A1 → Job A2 |
| **B** — Injection-moulded PP closures, cavity output & QC | High-cavity-count injection moulding, cavity-level good/total tracking, a completed job with rework disposition, and a live in-progress job with an open QA decision | Job B1 (completed), Job B2 (in_progress) |
| **C** — HDPE detergent packaging via blow moulding | Extrusion blow moulding, direct-resin product (no preform stage), clean QC pass | Job C1 |
| **D** — Scrap/regrind reuse with cost/lot genealogy | Job A2's rejects ground into a regrind lot of the *same* item; Job A3 consumes virgin + rPET + regrind from three separate warehouse sources under a newly activated BOM v2, each retaining its own cost basis | Job A2 → regrind lot → Job A3 (BOM v2) |
| **E** — Customer fulfilment: SO → job → FG → dispatch → delivery | Sales order linkage via `salesOrderLineId`, finished-goods receipt, partial dispatch, cross-branch transfer, second dispatch, delivery confirmation | SO1 (via Job A2, two dispatches + one transfer) and SO3 (via Job C1, one dispatch) |

## 14. What was verified before this data was declared complete

Every service call above was checked against the real, current function signature in this codebase (not assumed from memory) before being written into the seed script — see `DEMO_SEED_MANIFEST.md` §9 for the exact `tsc`/lint/build results and §10 for what the sandbox prevented from being verified by actually running the seed. Two real bugs were caught this way: `recordInspection` and `createDispatch` return `{replayed, inspection}` / `{replayed, dispatch}` wrapper objects, not the bare record — both call sites were corrected and re-verified clean.
