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
  // Costing / currency
  | "cost:read"
  | "cost:adjust"
  | "exchange_rate:create"
  | "exchange_rate:read";

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
    "cost:read",
    "cost:adjust",
    "exchange_rate:create",
    "exchange_rate:read",
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
    "cost:read",
    // exchange_rate:create intentionally omitted — see note above the map.
    "exchange_rate:read",
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
    "cost:read",
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
    "quality:read",
    "material:issue",
    "stock:receive",
    "stock:adjust",
    "warehouse:create",
    "stock:read",
    "lot:read",
    "lot:manage",
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
    "cost:read",
    "cost:adjust",
    "exchange_rate:create",
    "exchange_rate:read",
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
