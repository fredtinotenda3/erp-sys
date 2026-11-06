// Role/capability model. Originally scoped to Phase 1 (IAM module only); the
// block below marked "PHASE 1.5 ADDITIONS" extends it for catalog, BOM,
// customer, sales order, production, inventory, and costing — per the
// capability-by-role table approved in docs/UX_UI_ARCHITECTURE.md §15.1
// (2026-10-07). Same convention as the original: capabilities live here,
// not a DB-configurable permissions table, until a real requirement forces
// that change (ARCHITECTURE.md §3.2).
//
// ROLE VALUES ARE REDECLARED HERE, NOT IMPORTED FROM THE GENERATED PRISMA
// CLIENT. This is deliberate, not an oversight: `npx prisma generate` could
// not be run in the sandbox this was built in (binaries.prisma.sh is
// network-blocked there — see ARCHITECTURE.md Phase 0 Addendum, "Known
// verification gap"), so the exact shape of Prisma 7's generated enum export
// (a real TS `enum`, vs. a `const` object + derived union type, which is
// Prisma's historical pattern) was not independently confirmed. A plain
// string-literal union here is guaranteed to compile against either shape at
// every call site that assigns a role to a Prisma field, whereas importing
// the generated type first and it turning out to be a real `enum` would
// require every literal assignment (`role: 'OWNER_ADMIN'`) to be rewritten
// as `role: Role.OWNER_ADMIN`. After your first successful `prisma generate`,
// it is safe (and preferable, for single-source-of-truth) to replace
// ROLE_VALUES/Role below with `import type { Role } from
// "../../generated/prisma/client"` — just confirm the 7 values below still
// match prisma/schema.prisma's `enum Role` first.
import { ForbiddenError } from "./errors";

export const ROLE_VALUES = [
  "OWNER_ADMIN",
  "OPERATIONS_MANAGER",
  "PRODUCTION_MANAGER",
  "INVENTORY_MANAGER",
  "PRODUCTION_OPERATOR",
  "FINANCE_MANAGER",
  "VIEWER",
] as const;

export type Role = (typeof ROLE_VALUES)[number];

export type Capability =
  // --- IAM (Phase 1, unchanged) ---
  | "branch:create"
  | "branch:read"
  | "branch:deactivate"
  | "user:create"
  | "user:read"
  | "user:update_role"
  | "user:deactivate"
  | "branch_access:grant"
  | "branch_access:revoke"
  | "audit_log:read"
  // --- PHASE 1.5 ADDITIONS (docs/UX_UI_ARCHITECTURE.md §15.1) ---
  // Catalog
  | "item:create"
  | "item:read"
  | "item:update"
  | "bom:create"
  | "bom:read"
  | "bom:activate"
  // Sales
  | "customer:create"
  | "customer:read"
  | "customer:update"
  | "sales_order:create"
  | "sales_order:read"
  | "sales_order:update"
  | "sales_order:confirm"
  // Suppliers (shared-core milestone 1 — ARCHITECTURE.md's new sequencing note)
  | "supplier:create"
  | "supplier:read"
  | "supplier:update"
  // Purchasing (shared-core milestone 2). purchase_order:confirm is deliberately
  // its own capability, not folded into :update, for the same reason
  // sales_order:confirm is separate from sales_order:update — see the grant
  // table below for the segregation-of-duties reasoning specific to Purchasing.
  | "purchase_order:create"
  | "purchase_order:read"
  | "purchase_order:update"
  | "purchase_order:confirm"
  // Goods receiving (shared-core milestone 3)
  | "goods_receipt:create"
  | "goods_receipt:read"
  // Production
  | "production_job:create"
  | "production_job:read"
  | "production_job:update"
  | "production_job:complete"
  | "stage:transition"
  | "material:issue"
  | "labour:record"
  | "quality:record"
  | "quality:approve"
  | "output:record"
  | "quality:read"
  // Inventory
  | "stock:receive"
  | "stock:adjust"
  | "warehouse:create"
  | "stock:read"
  // Lot traceability (Phase One of the next mandate round, migration
  // 20261105120000_lot_consumption_and_traceability). Issuing/returning
  // material to/from a specific lot reuses "material:issue" (the same role
  // set that can issue is the one that can correct an issue by returning
  // it — segregation-of-duties doesn't give a reason to split them, unlike
  // purchase_order:confirm). These two are for everything else:
  // lot:read   -- browsing/searching lots and the traceability chain. Given
  //               to exactly the role set that already has goods_receipt:read
  //               (a lot's existence is already visible to them via the
  //               receipt that created it; this just makes it searchable on
  //               its own terms).
  // lot:manage -- manually transitioning a lot's status (active <->
  //               quarantined/expired), e.g. after a physical recheck. Given
  //               to the same role set as stock:adjust, since both are
  //               inventory-integrity corrections, not routine stock moves.
  | "lot:read"
  | "lot:manage"
  // Finished-goods inventory (Milestone 2 — Finished-Goods Inventory).
  // finished_goods:read -- browsing batches, their traceability and
  //   valuation. Given the same role set as lot:read: a batch is the
  //   forward-chain continuation of a lot, so whoever may trace backward
  //   from a lot may trace forward from a batch too.
  // finished_goods:receive -- converting already-recorded good output
  //   (ProductionOutput, unchanged by this milestone) into valued
  //   finished-goods stock. Given to the role set that already holds
  //   output:record AND has a production-management remit
  //   (OWNER_ADMIN/OPERATIONS_MANAGER/PRODUCTION_MANAGER), plus
  //   INVENTORY_MANAGER (the role that already owns every other inventory-
  //   receiving action: stock:receive, goods_receipt:create). Deliberately
  //   NOT PRODUCTION_OPERATOR: recording shop-floor output (quantities) and
  //   converting it into valued stock (a cost-bearing, inventory-integrity
  //   event, same category as lot:manage) are different levels of
  //   authority -- same reasoning lot:read/lot:manage already split "browse"
  //   from "change the ledger's shape" for raw-material lots.
  // finished_goods:manage -- quarantine/release a batch, transfer it between
  //   warehouses, or post a controlled adjustment. Mirrors lot:manage's role
  //   set exactly (OWNER_ADMIN, OPERATIONS_MANAGER, INVENTORY_MANAGER) for
  //   the same reason: these are inventory-integrity corrections, not
  //   routine production actions.
  | "finished_goods:read"
  | "finished_goods:receive"
  | "finished_goods:manage"
  // Dispatch and delivery (Milestone 3). dispatch:read mirrors
  // finished_goods:read's role set exactly -- a dispatch is the forward-
  // chain continuation of a finished-goods batch, so whoever may browse a
  // batch's traceability may browse what it was dispatched into too.
  // dispatch:create covers BOTH creating a dispatch (the stock-moving,
  // batch-debiting event) and confirming its delivery (confirmDelivery) --
  // unlike purchase_order:confirm/sales_order:confirm, there is no real
  // segregation-of-duties tension between shipping something and recording
  // that it arrived, so this is deliberately one capability, not two.
  // Mirrors finished_goods:manage's role set exactly (OWNER_ADMIN,
  // OPERATIONS_MANAGER, INVENTORY_MANAGER) -- dispatching is a warehouse/
  // fulfillment action, not a production one, so PRODUCTION_MANAGER does
  // NOT get it (consistent with it also lacking finished_goods:manage).
  | "dispatch:read"
  | "dispatch:create"
  // Costing / currency
  | "cost:read"
  | "cost:adjust"
  | "exchange_rate:create"
  | "exchange_rate:read"
  // Milestone 4 — Full Manufacturing Lifecycle.
  // machine:read -- browsing the work-centre/machine register, downtime and
  //   maintenance history, and the capacity-visibility report. Given the
  //   same broad role set as stock:read/quality:read (every role except none
  //   -- even VIEWER gets it, mirroring its read-everything-but-cost grant).
  // machine:manage -- creating/editing work centres and machines, logging
  //   downtime, and scheduling/recording maintenance. Given to the same role
  //   set as bom:create/bom:activate: a planning-and-engineering act, not a
  //   routine shop-floor one (PRODUCTION_OPERATOR does NOT get it, same as
  //   it lacks bom:create).
  | "machine:read"
  | "machine:manage"
  // machine_time:record -- logging actual setup/run minutes against a job
  //   (optionally a stage and machine). Mirrors labour:record's role set
  //   exactly -- same shop-floor act, same people record it.
  | "machine_time:record"
  // quality_plan:manage -- defining/editing inspection plans and their
  //   characteristics (tolerances). Mirrors bom:create's role set exactly:
  //   both are planning/engineering configuration, not shop-floor recording.
  //   Reading a plan reuses quality:read; recording a measurement against
  //   one reuses quality:record (recordInspection's existing capability).
  | "quality_plan:manage"
  // corrective_action:manage -- raising, assigning, and resolving a
  //   corrective action. Mirrors quality:approve's role set exactly -- same
  //   people who may decide what happens to rejected units (dispositions)
  //   are the people accountable for the root-cause follow-up. Reading
  //   reuses quality:read.
  | "corrective_action:manage"
  // Milestone 5 -- Configurable Industry Architecture.
  // industry_profile:manage -- changing the organization's industry
  //   profile and which optional modules it has enabled. OWNER_ADMIN ONLY
  //   (mandate §7: "Do not permit arbitrary users to change an
  //   organisation's manufacturing configuration") -- deliberately narrower
  //   than every other "admin tier" capability in this file, which
  //   OPERATIONS_MANAGER otherwise mirrors; this one sits with role changes
  //   (user:update_role) as the two capabilities OPERATIONS_MANAGER does
  //   NOT get. There is no separate "...:read" capability -- every
  //   authenticated session already receives its own org's current profile
  //   via me-service.ts (the same "every role needs this to render the app
  //   shell" reasoning that file already documents for orgName), since
  //   reading your own org's profile is not a privileged operation.
  | "industry_profile:manage"
  // Milestone 6 -- Plastics Manufacturing Vertical.
  // mould:read / mould:manage -- mirrors machine:read/machine:manage's role
  //   sets exactly: a mould is equipment, same tier as a machine.
  | "mould:read"
  | "mould:manage"
  // plastics_spec:manage -- setting an item's plastics material attributes
  //   or product spec. Mirrors bom:create's role set: planning/engineering
  //   configuration, not shop-floor recording. Reading reuses item:read
  //   (the spec is exposed as part of an item's own detail, not a separate
  //   capability).
  | "plastics_spec:manage"
  // regrind:create -- spawning a new regrind MaterialLot from a job's
  //   scrap. Mirrors lot:manage's exact role set (it IS a lot-management
  //   action -- creating a new MaterialLot -- not a shop-floor recording
  //   one), not machine_time:record's/output:record's broader set. Reading
  //   a regrind lot reuses lot:read (it's an ordinary MaterialLot row once
  //   created).
  | "regrind:create"
  // plastics_process:record -- setting a job stage's plastics process
  //   detail (process type, mould, cycle time, cavity counts). Mirrors
  //   machine_time:record's exact role set: the same shop-floor act of
  //   recording what actually happened on a specific stage, just for
  //   plastics-specific fields instead of generic setup/run minutes.
  | "plastics_process:record";

// Deliberately NOT granting user:update_role to anyone but OWNER_ADMIN.
// Role changes are the one IAM action with privilege-escalation potential
// (a user who can set roles can promote themselves or anyone else to
// OWNER_ADMIN), so it is kept out of the "ops admin" tier even though that
// tier can otherwise create/deactivate users and manage branches. This is a
// Phase 1 default, not a spec answer — flag if you want a narrower or wider
// rule here.
//
// NOTE on supplier:create for INVENTORY_MANAGER: unlike Customer (where only
// OWNER_ADMIN/OPERATIONS_MANAGER get create/update, and every other role that
// can see Customer is read-only), INVENTORY_MANAGER is ALSO granted
// supplier:create/update below. This is a deliberate divergence from treating
// Supplier as a pure mirror of Customer's capability row, not an oversight:
// Suppliers is the first module of a chain INVENTORY_MANAGER already owns
// the rest of (stock:receive, stock:adjust, warehouse:create), and the next
// milestone (Purchasing/POs) will need someone who can both place an order
// and register who it's with. Flag if you'd rather keep Supplier creation
// restricted to Owner/Admin/Ops-Manager only, same as Customer.
//
// PHASE 1.5 NOTE on exchange_rate:create: ARCHITECTURE.md §11 scoped
// exchange-rate writes to "Finance/Admin only" — read literally, that's
// OWNER_ADMIN + FINANCE_MANAGER, not OPERATIONS_MANAGER, even though
// OPERATIONS_MANAGER otherwise mirrors OWNER_ADMIN everywhere else added in
// this round. I've kept that literal reading below rather than extending
// OPERATIONS_MANAGER's "same as Owner/Admin minus role edits" pattern to
// this one capability, because exchange rates feed every cost figure in the
// app (ARCHITECTURE.md §9) and a financial-integrity-sensitive write seems
// deliberately narrowed in the original note, not an oversight. Flag if you
// want OPERATIONS_MANAGER to have it too — this is the one place I diverged
// from "OPS_MGR = everything the table gives OWNER_ADMIN" and I'm not
// treating that divergence as settled on my own say-so.
const CAPABILITIES_BY_ROLE: Readonly<Record<Role, ReadonlySet<Capability>>> = {
  OWNER_ADMIN: new Set<Capability>([
    "branch:create",
    "branch:read",
    "branch:deactivate",
    "user:create",
    "user:read",
    "user:update_role",
    "user:deactivate",
    "branch_access:grant",
    "branch_access:revoke",
    "audit_log:read",
    "item:create",
    "item:read",
    "item:update",
    "bom:create",
    "bom:read",
    "bom:activate",
    "customer:create",
    "customer:read",
    "customer:update",
    "sales_order:create",
    "sales_order:read",
    "sales_order:update",
    "sales_order:confirm",
    "supplier:create",
    "supplier:read",
    "supplier:update",
    "purchase_order:create",
    "purchase_order:read",
    "purchase_order:update",
    "purchase_order:confirm",
    "goods_receipt:create",
    "goods_receipt:read",
    "production_job:create",
    "production_job:read",
    "production_job:update",
    "production_job:complete",
    "stage:transition",
    "material:issue",
    "labour:record",
    "quality:record",
    "quality:approve",
    "output:record",
    "quality:read",
    "stock:receive",
    "stock:adjust",
    "warehouse:create",
    "stock:read",
    "lot:read",
    "lot:manage",
    "finished_goods:read",
    "finished_goods:receive",
    "finished_goods:manage",
    "dispatch:read",
    "dispatch:create",
    "cost:read",
    "cost:adjust",
    "exchange_rate:create",
    "exchange_rate:read",
    "machine:read",
    "machine:manage",
    "machine_time:record",
    "quality_plan:manage",
    "corrective_action:manage",
    "industry_profile:manage",
    "mould:read",
    "mould:manage",
    "plastics_spec:manage",
    "regrind:create",
    "plastics_process:record",
  ]),
  OPERATIONS_MANAGER: new Set<Capability>([
    "branch:create",
    "branch:read",
    "branch:deactivate",
    "user:create",
    "user:read",
    "user:deactivate",
    "branch_access:grant",
    "branch_access:revoke",
    "audit_log:read",
    "item:create",
    "item:read",
    "item:update",
    "bom:create",
    "bom:read",
    "bom:activate",
    "customer:create",
    "customer:read",
    "customer:update",
    "sales_order:create",
    "sales_order:read",
    "sales_order:update",
    "sales_order:confirm",
    "supplier:create",
    "supplier:read",
    "supplier:update",
    "purchase_order:create",
    "purchase_order:read",
    "purchase_order:update",
    "purchase_order:confirm",
    "goods_receipt:create",
    "goods_receipt:read",
    "production_job:create",
    "production_job:read",
    "production_job:update",
    "production_job:complete",
    "stage:transition",
    "material:issue",
    "labour:record",
    "quality:record",
    "quality:approve",
    "output:record",
    "quality:read",
    "stock:receive",
    "stock:adjust",
    "warehouse:create",
    "stock:read",
    "lot:read",
    "lot:manage",
    "finished_goods:read",
    "finished_goods:receive",
    "finished_goods:manage",
    "dispatch:read",
    "dispatch:create",
    "cost:read",
    // exchange_rate:create intentionally omitted — see note above the map.
    "exchange_rate:read",
    "machine:read",
    "machine:manage",
    "machine_time:record",
    "quality_plan:manage",
    "corrective_action:manage",
    // industry_profile:manage intentionally omitted — OWNER_ADMIN only, see
    // the capability's own doc comment above the map.
    "mould:read",
    "mould:manage",
    "plastics_spec:manage",
    "regrind:create",
    "plastics_process:record",
  ]),
  PRODUCTION_MANAGER: new Set<Capability>([
    "branch:read",
    "user:read",
    "item:read",
    "bom:create",
    "bom:read",
    "bom:activate",
    "customer:read",
    "supplier:read",
    "purchase_order:read",
    "goods_receipt:read",
    "sales_order:read",
    "production_job:create",
    "production_job:read",
    "production_job:update",
    "production_job:complete",
    "stage:transition",
    "material:issue",
    "labour:record",
    "quality:record",
    "quality:approve",
    "output:record",
    "quality:read",
    "stock:read",
    "lot:read",
    "finished_goods:read",
    "finished_goods:receive",
    "dispatch:read",
    "cost:read",
    "machine:read",
    "machine:manage",
    "machine_time:record",
    "quality_plan:manage",
    "corrective_action:manage",
    "mould:read",
    "mould:manage",
    "plastics_spec:manage",
    // regrind:create intentionally omitted — mirrors lot:manage's exact
    // role set (OWNER_ADMIN/OPERATIONS_MANAGER/INVENTORY_MANAGER only),
    // which this role does not hold either (it has lot:read, not
    // lot:manage, below).
    "plastics_process:record",
  ]),
  // purchase_order:confirm is deliberately NOT granted here, unlike
  // purchase_order:create/update (which mirror the same reasoning as
  // supplier:create/update's grant to this role -- see that comment).
  // Confirming a PO is the point where the organisation takes on a real
  // financial commitment to a supplier, same category of action as approving
  // a sales order (sales_order:confirm, also withheld from this role).
  // supplier-service.ts's own comment flagged exactly this: "letting the
  // same role both create a vendor and set its banking/tax details
  // unsupervised is a segregation-of-duties question real procurement
  // controls usually care about ... revisit when Purchasing adds
  // vendor-financial fields" -- this is that revisit. Inventory Manager can
  // draft and edit a PO (ordering is operationally theirs, same as stock
  // receive/adjust) but Owner/Admin or Operations Manager must commit it.
  // goods_receipt:create/read ARE granted -- physically receiving a delivery
  // against an already-confirmed PO is a direct extension of stock:receive,
  // which this role already holds; it creates no new financial commitment,
  // only records what physically arrived.
  INVENTORY_MANAGER: new Set<Capability>([
    "branch:read",
    "user:read",
    "item:create",
    "item:read",
    "item:update",
    "bom:read",
    // supplier:create/update granted here, unlike Customer — see the note
    // above the map explaining this divergence.
    "supplier:create",
    "supplier:read",
    "supplier:update",
    "purchase_order:create",
    "purchase_order:read",
    "purchase_order:update",
    "goods_receipt:create",
    "goods_receipt:read",
    "production_job:read",
    // sales_order:read -- added for Milestone 3 (Dispatch and Delivery).
    // This role is the one that creates dispatches (dispatch:create below,
    // mirroring finished_goods:manage's grant), and dispatching against a
    // sales order requires seeing what that order actually asked for
    // (customer, lines, quantities) -- the same reasoning this role already
    // has production_job:read (read-only visibility into an adjacent
    // module it must act against, here to receive finished goods from a
    // job). It remains read-only: sales_order:create/update/confirm are
    // NOT granted -- drafting and committing a customer's order stays a
    // sales-side action.
    "sales_order:read",
    "quality:read",
    "material:issue",
    "stock:receive",
    "stock:adjust",
    "warehouse:create",
    "stock:read",
    "lot:read",
    "lot:manage",
    "finished_goods:read",
    "finished_goods:receive",
    "finished_goods:manage",
    "dispatch:read",
    "dispatch:create",
    "machine:read",
    "mould:read",
    // plastics_spec:manage and regrind:create both granted here -- this
    // role already holds item:create/item:update (the plastics material
    // attributes this capability also covers extend an Item it can already
    // edit) and lot:manage (regrind is a lot-management action). mould:manage
    // is NOT granted, mirroring machine:manage's omission here too.
    "plastics_spec:manage",
    "regrind:create",
  ]),
  PRODUCTION_OPERATOR: new Set<Capability>([
    "branch:read",
    // production_job:read is branch-scoped AND field-reduced for this role
    // (no customer, no quoted amount, no cost fields) — enforced by the
    // service layer's response projection, not by a second capability.
    // See docs/UX_UI_ARCHITECTURE.md §15.1 resolution note / §16.
    "production_job:read",
    "stage:transition",
    "material:issue",
    "labour:record",
    "quality:record",
    "output:record",
    "quality:read",
    // Milestone 4: an operator may see machine status/select one when
    // starting a stage, and log setup/run minutes against it (mirrors its
    // existing labour:record grant) — but not create/edit the register
    // itself (machine:manage), define quality plans, or manage corrective
    // actions, same as it lacks bom:create/quality:approve today.
    "machine:read",
    "machine_time:record",
    // Milestone 6: an operator may see the mould register (to know which
    // mould is loaded, mirroring its machine:read grant) and record a
    // stage's actual plastics process detail -- cycle time, cavity counts
    // -- mirroring its machine_time:record grant exactly (the same
    // shop-floor act, just plastics-specific fields). It may not manage the
    // mould register, item specs, or spawn regrind lots, same tier as its
    // existing lack of machine:manage/lot:manage.
    "mould:read",
    "plastics_process:record",
  ]),
  FINANCE_MANAGER: new Set<Capability>([
    "branch:read",
    "user:read",
    "audit_log:read",
    "item:read",
    "bom:read",
    "customer:read",
    "supplier:read",
    "purchase_order:read",
    "goods_receipt:read",
    "sales_order:read",
    "production_job:read",
    "quality:read",
    "stock:read",
    "lot:read",
    "finished_goods:read",
    "dispatch:read",
    "cost:read",
    "cost:adjust",
    "exchange_rate:create",
    "exchange_rate:read",
    "machine:read",
    "mould:read",
  ]),
  VIEWER: new Set<Capability>([
    "branch:read",
    "item:read",
    "bom:read",
    "customer:read",
    "supplier:read",
    "purchase_order:read",
    "goods_receipt:read",
    "sales_order:read",
    "production_job:read",
    "quality:read",
    "stock:read",
    "lot:read",
    "finished_goods:read",
    "dispatch:read",
    "machine:read",
    "mould:read",
    // cost:read intentionally omitted — approved choice, docs/UX_UI_ARCHITECTURE.md
    // §15.1: Viewer sees every module read-only except cost/margin data.
  ]),
};

export function hasCapability(role: Role, capability: Capability): boolean {
  return CAPABILITIES_BY_ROLE[role].has(capability);
}

/** Every capability a role holds (used by GET /auth/me so the UI can filter navigation). */
export function capabilitiesFor(role: Role): Capability[] {
  return [...CAPABILITIES_BY_ROLE[role]].sort();
}

export function assertCapability(role: Role, capability: Capability): void {
  if (!hasCapability(role, capability)) {
    throw new ForbiddenError(`Role ${role} does not have the "${capability}" capability`);
  }
}

// Branch-level access check. OWNER_ADMIN gets IMPLICIT access to every
// branch in its org (ARCHITECTURE.md Section 15, Q4 — answered: implicit),
// enforced here in code rather than by materializing a user_branch_access
// row per branch for every OWNER_ADMIN (which would need to be kept in sync
// every time a new branch is created). Every other role must hold an
// explicit grant row — there is no fallback to org-wide access for them.
export function hasBranchAccess(session: { role: Role; branchIds: readonly string[] }, branchId: string): boolean {
  if (session.role === "OWNER_ADMIN") return true;
  return session.branchIds.includes(branchId);
}

export function assertBranchAccess(session: { role: Role; branchIds: readonly string[] }, branchId: string): void {
  if (!hasBranchAccess(session, branchId)) {
    throw new ForbiddenError("You do not have access to this branch");
  }
}
