# Operis User Guide

This guide describes the application as it actually exists in this codebase today — every screen, field, and permission rule named below is real: confirmed against `components/shell/nav-config.ts` (the actual navigation/capability gate), `src/server/shared/authz.ts` (the actual capability map), and the real API routes under `app/api/v1/`. Nothing here is aspirational or planned; where a capability restricts who can do something, that restriction is named explicitly rather than glossed over.

The screenshots and examples throughout reference the **Mavuno Packaging Industries (Pvt) Ltd** demo dataset (`DEMO_DATA_CATALOGUE.md`) — a fictional rigid-plastics manufacturer used only to make the examples concrete. Log in at your organization's own URL with your own organization slug to use this guide against your real data; nothing about the application itself differs between a demo org and a production one.

---

## 1. Signing in and choosing your organization

Go to `/login`. You sign in with your **organization slug**, email, and password — this application is multi-tenant, so the same email address can belong to different people in different organizations, and the slug is what disambiguates which organization you're logging into. If you've forgotten your password, `/forgot-password` starts a reset; `/reset-password` completes it using the link that's emailed to you. There is no self-service sign-up screen: an organization is created once, by whoever runs `bootstrapOrganization` for it (see `docs/SETUP_COMMANDS.md`), and every other user in it is created by an administrator (Topic 4).

## 2. Understanding roles and capabilities

Every action you can take is gated by a **capability** — a specific, named permission (e.g. `purchase_order:confirm`, `quality:approve`) — not by a vague "admin vs. user" split. There are 7 roles: `OWNER_ADMIN`, `OPERATIONS_MANAGER`, `PRODUCTION_MANAGER`, `INVENTORY_MANAGER`, `PRODUCTION_OPERATOR`, `FINANCE_MANAGER`, `VIEWER`. Each role holds a fixed set of capabilities; your role is set when your account is created and only `OWNER_ADMIN` can change anyone's role afterward (`user:update_role` is withheld from every other role, deliberately, because it's the one action that could let someone promote themselves). The sidebar only shows the sections and buttons your role's capabilities unlock — if something described in this guide isn't visible to you, that's your role, not a bug, and the page behind it would refuse the action anyway even if you reached it directly.

Two deliberate "segregation of duties" splits worth knowing up front, because they surprise people:
- **Drafting a purchase order is not the same permission as confirming one.** `INVENTORY_MANAGER` can create and edit a PO but cannot confirm it — confirmation is the point the organization takes on a real financial commitment, so it needs `OWNER_ADMIN` or `OPERATIONS_MANAGER`.
- **Recording a quality inspection is not the same permission as deciding what happens to the rejected units.** Any `PRODUCTION_OPERATOR` can record an inspection, but only `OWNER_ADMIN`, `OPERATIONS_MANAGER`, or `PRODUCTION_MANAGER` can record the disposition (scrap, rework, or use-as-is).

Also branch-scoped: most roles only see/act on branches they've been explicitly granted access to; `OWNER_ADMIN` implicitly sees every branch in the organization with no separate grant needed.

## 3. The Command Centre (dashboard)

`/dashboard` is the landing page after login, visible to every role. It summarizes your organization's current state — open jobs, stock positions, pending orders and the like, computed from the same real records every other screen reads. There is no separate "demo mode" dashboard or canned figure anywhere in this application: a dashboard that shows nothing is a dashboard with nothing seeded yet, not a bug.

## 4. Settings → Users (`/settings/users`)

Visible to anyone holding `user:read`. Lists every user in your organization with their role and branch access; `/settings/users/new` (needs `user:create`) adds one, and `/settings/users/[id]` lets an authorized user edit an existing one's details, branch access, or deactivate them (`user:deactivate`). Role changes are the one field here that needs `user:update_role` specifically — held only by `OWNER_ADMIN`.

## 5. Settings → Branches (`/settings/branches`)

A branch is this application's unit of physical location/site — a plant, depot, or office. `/settings/branches/new` creates one (needs `branch:create`); `/settings/branches/[id]` shows/edits an existing one. Warehouses, work centres, machines, and moulds all belong to exactly one branch; most roles need an explicit branch-access grant (via Topic 4's user editor) to see or act on a given branch's data.

## 6. Settings → Audit log (`/settings/audit-log`)

Visible to `audit_log:read` holders (`OWNER_ADMIN`, `OPERATIONS_MANAGER`, `FINANCE_MANAGER`). Every significant action in this system — user creation, role changes, branch grants, and more — writes an audit-log entry; this screen is where you review that history. The audit log table itself is append-only at the database layer (enforced by a Postgres trigger, not just application code), so even a compromised application process cannot rewrite history here.

## 7. Settings → Manufacturing profile (`/settings/industry-profile`)

Visible only to `industry_profile:manage` holders — **`OWNER_ADMIN` only**, deliberately narrower than every other "admin tier" capability (the mandate behind this: "do not permit arbitrary users to change an organisation's manufacturing configuration"). This is where an organization switches its **industry profile** (e.g. to `plastics`) and chooses which of that profile's optional modules are enabled. Every other role simply sees the organization's current profile as part of their own session — reading it isn't privileged, only changing it is. The Mavuno demo runs on the `plastics` profile with all 6 of its modules enabled: `plastics_materials`, `plastics_product_spec`, `mould_management`, `plastics_process_detail`, `regrind_tracking`, `plastics_analytics`.

## 8. Products & BOM → Items (`/catalog/items`)

The item catalog: every raw material, consumable, spare part, WIP (work-in-progress) item, and finished good your organization tracks. Visible to `item:read` holders (effectively everyone). `/catalog/items/new` (needs `item:create`) adds an item — SKU, name, UoM, item type (`raw_material`, `consumable`, `spare_part`, `finished_good`, or `wip`), standard cost, and, for a sellable finished good, selling price. `/catalog/items/[id]` shows full detail including whichever BOM, plastics attributes, or plastics spec apply (Topics 9–10).

## 9. Products & BOM → Bills of Materials and versioning

A BOM (Bill of Materials) is attached to a specific item and lists the materials (and quantities, with an optional expected scrap percentage) that go into making one unit of it. `/catalog/items/[id]/bom/new` (needs `bom:create`) creates a new BOM version for an item; only one version can be **active** at a time (`bom:activate`), and the system keeps every prior version on record rather than overwriting it — a real version history, not a single mutable row. The Mavuno demo's 2L PET preform shows this in practice: it shipped with a virgin-only v1, and a second, blend v2 (virgin + approved rPET) was activated later without deleting v1 — any job created before the switch keeps its original v1 snapshot; jobs created after it get v2.

## 10. Plastics material attributes and product specs

Two optional, profile-gated extensions to the plain item record, visible only when your organization's industry profile is `plastics` and the relevant module is enabled (Topic 7): **material attributes** (`plastics_materials` module — polymer grade, resin spec, colour masterbatch, additive notes, recycled-content percentage, supplier material reference) for raw materials, and **product spec** (`plastics_product_spec` module — product type, resin type, colour, nominal weight, capacity, dimensions, neck finish, closure-compatibility notes) for WIP/finished goods. Setting either needs `plastics_spec:manage`; neither adds a new database field by stealth — they're real, already-existing structured attributes on the item, just specific to this one industry profile.

## 11. Suppliers (`/suppliers`)

Visible to `supplier:read` holders. `/suppliers/new` (needs `supplier:create`) and `/suppliers/[id]/edit` (needs `supplier:update`) manage name, contact, address, and free-text notes — this schema has no dedicated payment-terms field, so if you need to record terms, they go in notes, same as the demo data does ("Payment terms: 30 days net."). Unlike Customers, `INVENTORY_MANAGER` also holds `supplier:create`/`supplier:update` — a deliberate choice, since that role already owns the rest of the purchasing chain (stock receiving, warehouse management).

## 12. Customers (`/customers`)

Visible to `customer:read` holders. `/customers/new` and `/customers/[id]/edit` need `customer:create`/`customer:update` — held by `OWNER_ADMIN` and `OPERATIONS_MANAGER` only (not `INVENTORY_MANAGER`, unlike suppliers). Same name/contact/address/notes shape as Suppliers.

## 13. Purchasing → Purchase orders (`/purchasing/orders`)

Visible to `purchase_order:read` holders. `/purchasing/orders/new` (needs `purchase_order:create`) drafts a PO against a supplier, branch, currency, and one or more lines (item, quantity, unit price). A PO moves through real, enforced states: **draft** → **confirmed** (needs `purchase_order:confirm` — see Topic 2's segregation-of-duties note) → **received** or **partially received**, depending on how much of each line was actually accepted on receipt → optionally **closed**. `/purchasing/orders/[id]/edit` edits a still-draft PO; `/purchasing/orders/[id]` shows full status and line-level receipt history.

## 14. Purchasing → Goods receipt and material lots

`/purchasing/orders/[id]/receive` (needs `goods_receipt:create`) records what actually arrived against a confirmed PO — per line, a received quantity, an accepted quantity, and a rejected quantity with a reason if any were rejected, plus an optional supplier lot reference and expiry date. You cannot accept more than was ordered on that line — the system hard-blocks over-acceptance. Every accepted quantity automatically creates a new, numbered `MaterialLot` (via the system's own lot-numbering sequence, never a number you choose) at the warehouse you received into, and the PO's overall status is recomputed from the cumulative accepted quantity across every receipt against it.

## 15. Inventory → Stock, movements, warehouses

`/inventory/stock` (needs `stock:read`) shows current on-hand quantities by item and warehouse. `/inventory/movements` is the full ledger of every stock-affecting event. `/inventory/warehouses` lists warehouses (each belongs to one branch); creating one needs `warehouse:create`. `/inventory/receive` (needs `stock:receive`) and `/inventory/adjust` (needs `stock:adjust`) handle stock entry/correction outside the PO-receipt flow (Topic 14) — e.g. a correction after a physical recount.

## 16. Inventory → Issue to job / Return from job

`/inventory/issue` and `/inventory/return` (both need `material:issue`) move material from a warehouse onto a specific production job, or back. This is how a job's actual material consumption gets recorded — distinct from the BOM (Topic 9), which only states what *should* be consumed; the issue is what *was* consumed, and it's what job-costing (Topic 29) is computed from.

## 17. Inventory → Material lots (`/inventory/lots`)

Visible to `lot:read` holders — the same role set that already holds `goods_receipt:read` (a lot's existence is already visible to them via the receipt that created it; this page just makes lots directly searchable). `/inventory/lots/[id]` shows a lot's full detail including its forward/backward traceability chain: which receipt created it, which jobs consumed from it, and what those jobs produced. Manually changing a lot's status (e.g. active ↔ quarantined) needs `lot:manage`, a step up from read-only browsing — the same role tier as `stock:adjust`, since both are inventory-integrity corrections rather than routine moves.

## 18. Inventory → Finished goods (`/inventory/finished-goods`)

Visible to `finished_goods:read` holders. Finished-goods batches are the forward-chain continuation of a lot: a job's recorded good output (Topic 24) becomes valued, trackable stock here only once someone with `finished_goods:receive` actually receives it in — a deliberate second step, not automatic, because converting recorded output into cost-bearing stock is an inventory-integrity event in its own right. `/inventory/finished-goods/[id]` shows a batch's detail, including its own traceability (`.../traceability`) and status history (`.../status`). Quarantining/releasing a batch, transferring it between warehouses (`.../transfer`), or posting a controlled adjustment (`.../adjust`) all need `finished_goods:manage` — held by `OWNER_ADMIN`, `OPERATIONS_MANAGER`, and `INVENTORY_MANAGER`, but **not** `PRODUCTION_MANAGER`, even though that role runs the jobs that create the batches in the first place.

## 19. Orders → Sales orders (`/orders`)

Visible to `sales_order:read` holders. `/orders/new` (needs `sales_order:create`) creates a sales order for a customer: branch, currency, requested delivery date, and one or more lines (item, quantity, unit price) — note this order header has no free-text notes/reference field in this schema, only the lines carry the commercial detail. `/orders/[id]/edit` edits a draft order; confirming it (needs `sales_order:confirm` — again a separate capability from create/update, same segregation-of-duties pattern as purchase orders) commits it. Cancelling an order (also needs `sales_order:confirm`-tier authority) requires a reason, recorded on the order.

## 20. Orders → Dispatches (`/dispatches`)

Visible to `dispatch:read` holders. `/orders/[id]/dispatch` (needs `dispatch:create`) creates a dispatch against a confirmed sales order: a warehouse, one or more sales-order lines with quantities (optionally allocated to specific finished-goods batches), a carrier and tracking reference. `dispatch:create` also covers confirming delivery once it arrives (`/dispatches/[id]`, `.../deliver`) — deliberately one capability, not two, because (unlike PO confirm/receive) there's no real segregation-of-duties tension between shipping something and recording that it arrived. Held by `OWNER_ADMIN`, `OPERATIONS_MANAGER`, `INVENTORY_MANAGER` — a warehouse/fulfilment action, so `PRODUCTION_MANAGER` does not hold it, consistent with that role also lacking `finished_goods:manage` (Topic 18).

## 21. Production → Jobs (`/production/jobs`)

Visible to `production_job:read` holders — note that for `PRODUCTION_OPERATOR`, this read is deliberately field-reduced (no customer, no quoted amount, no cost fields are shown), enforced by the service layer itself, not just hidden in the UI. `/production/jobs/new` (needs `production_job:create`) creates a job: branch, product item, planned quantity, priority (`low`/`normal`/`high`/`urgent`), planned dates, and optionally a linked sales-order line (for a make-to-order job) or a direct customer + quoted amount (mutually exclusive with the sales-order link). `/production/jobs/[id]` is the job's full working view: stages, material issues, labour, output, inspections, and its running cost. A job moves through real status transitions (`production_job:update` to transition it, `production_job:complete` to mark it complete) — it cannot be completed with stages still open.

## 22. Production → Machines and capacity (`/production/machines`, `/production/capacity`)

Visible to `machine:read` holders (effectively every role, mirroring `stock:read`'s broad grant). Machines belong to a work centre (a department-level grouping — Injection Moulding, Blow Moulding, etc.) and carry a code and name; `/production/machines/[id]` also shows downtime and maintenance history. Creating/editing machines or work centres, or logging downtime/maintenance, needs `machine:manage` — a planning/engineering-tier capability (same role set as `bom:create`), so `PRODUCTION_OPERATOR` can see this page but not change the register. `/production/capacity` is a read-only capacity-visibility report across work centres.

## 23. Production → Moulds (`/production/moulds`)

Visible to `mould:read` holders — granted independently of industry profile, but the page is only meaningful once your organization is on the `plastics` profile with the `mould_management` module enabled. A mould belongs to a branch, carries a cavity count, is tied to the one product it's cut for, and must be explicitly marked compatible with each machine that can run it (`/production/moulds/[id]`, and the compatibility link itself is a separate record — a mould isn't assumed to fit every machine in its work centre). Creating/editing a mould or its machine compatibility needs `mould:manage` (same role tier as `machine:manage`).

## 24. Shop floor → Material issue, labour, and output (`/shop-floor`)

The operator-facing, simplified view for people actually running a job, visible to anyone holding `output:record` or `stage:transition`. From here (or equivalently, from a job's own detail page) an operator issues material to the job (Topic 16), records labour hours and rate (attributed to whoever is actually logged in — this call always records *your own* user ID, never a value you can set to someone else), and records output: good quantity, scrap quantity, and — if any was scrapped — a reason drawn from a fixed, real set (`wrong_dimensions`, `damaged`, `paint_defect`, `missing_component`, `other`), never a free-typed category. There's also rework output (`reworkQty`/`reworkGoodQty`/`reworkScrapQty`) for units sent back through the process rather than scrapped outright.

## 25. Plastics process detail

A profile-gated extension (`plastics_process_detail` module) to a job stage's record: process type (e.g. `injection_moulding`, `stretch_blow_moulding`, `extrusion_blow_moulding`), which mould was loaded, target vs. actual cycle time in seconds, and total vs. good cavity counts for that cycle. **Actual cycle time is always operator-entered** — this application has no machine-telemetry integration, so a cycle time you see here is exactly what a person typed in, the same way a real shop floor without IoT sensors would record it. Needs `plastics_process:record` — the same role tier as `machine_time:record` (the equivalent generic, non-plastics setup/run-minutes capability).

## 26. Quality → Inspection plans and inspections (`/quality`, `/quality/inspections`)

Visible to `quality:read` holders (effectively everyone). An inspection plan (`quality_plan:manage` to create/edit — planning tier, same as `bom:create`) is attached to a specific item and lists named characteristics with optional min/max/target values and units (e.g. "Wall Thickness (Base)," 0.28–0.42mm). Recording an inspection against a job (needs `quality:record`) states an inspected quantity, a rejected quantity with a reason if any, and optionally measured values against the plan's own characteristics by ID — not a free-text measurement, a real link back to the characteristic it's being measured against. `/quality/inspections/[id]` shows a single inspection's full detail including every measurement and any disposition recorded against it.

## 27. Quality → Dispositions

What happens to a batch of rejected units: **scrap** (discarded), **rework** (sent back through the process, not yet returned to stock), or **use-as-is** (accepted despite the deviation) — each with a quantity and a reason of at least 5 characters. Recording a disposition needs `quality:approve`, deliberately separate from `quality:record` (Topic 2 and Topic 26) — the person who measured the defect is not automatically the person authorized to decide its fate. An inspection with no disposition yet recorded is a real, visible "awaiting decision" state in this system (the Mavuno demo's Job B2 shows exactly this), not a bug or a missing feature.

## 28. Regrind and recycled-material tracking

A profile-gated module (`regrind_tracking`) specific to plastics: when a job's scrap or QA-rejected units are physically reground back into usable resin, that regrind becomes a new `MaterialLot` **of the exact same item** the scrap came from (e.g. ground-up PET scrap becomes another lot of plain virgin PET resin) — there is no separate "regrind" catalog item, by this module's own design, because a regrind lot's identity is the resin it's made of, not a separate product category. Creating a regrind lot (needs `regrind:create`, sourced from a specific job) records its quantity, unit cost, and currency independently of whatever the original virgin material cost — so a job that later consumes both virgin and regrind material retains an honest, separately-costed genealogy for each source, never a blended average that hides where the cost actually came from.

## 29. Costing and Reports

**Exchange rates** (`/costing/exchange-rates`, visible to `exchange_rate:read` holders): every currency conversion used elsewhere in the system is backed by a real, dated, sourced rate record here (e.g. source `RBZ_OFFICIAL` or `MARKET`) — recording a new one needs `exchange_rate:create`, held only by `OWNER_ADMIN` and `FINANCE_MANAGER` (not `OPERATIONS_MANAGER`, a deliberate narrower reading since exchange rates feed every cost figure in the application). Exchange-rate records are append-only at the database layer, same as the audit log.

**Reports** (`/reports`, each page needing `cost:read` or `finished_goods:read`): `/reports/job-costs` breaks down a job's actual material, labour, and overhead cost against its planned/quoted amount; `/reports/profitability` rolls that up by product or customer; `/reports/wip-valuation` and `/reports/fg-valuation` value what's currently sitting in work-in-progress vs. finished-goods stock. Every figure on every one of these reports is computed live from the same real material-issue, labour, output, and receipt records described in Topics 14–24 — there is no separate, hand-maintained "KPI" number anywhere in this application, and a demo organization's reports will show exactly, and only, what its own seeded transactions actually produced.
