// Customer CRUD-lite. Scope note: this module is Customer only — NOT
// SalesOrder/SalesOrderLine. ARCHITECTURE.md's resolved decision table
// (Phase 0 Addendum, decision #2) explicitly scoped SalesOrder OUT of the
// first slice: "First-slice quoting via bare ProductionJob.quoted_amount —
// Yes — skip SalesOrder for the first slice." SalesOrder is listed under
// "Phase 3 — Orders + Production (full)", built alongside the full
// ProductionJobStage/operator workflow, not now. So a ProductionJob in the
// Production module (next) will carry its own quoted_amount/quoted_currency
// directly, with no SalesOrder dependency — see that decision table before
// building Production.
//
// Customer scope is ORG-WIDE, not branch-scoped (same decision table,
// item #5) — no branchId column on Customer, confirmed in schema.prisma.
//
// No hard delete, same reasoning as every other entity in this codebase:
// audit history exists immediately. Customer's own lifecycle flag is the
// `status` enum (active/inactive) rather than a bare isActive boolean —
// that's schema.prisma's choice, not mine; this service treats `status` as
// just another updatable field, exposed through the generic updateCustomer
// path rather than a dedicated deactivate function, because authz.ts only
// grants "customer:update" (no separate "customer:deactivate" capability,
// unlike Branch/User which do have one — confirm that asymmetry is what you
// want; I'm following the capability table as given, not second-guessing
// it here).
import { z } from "zod";
import { prisma } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import { NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";

// Redeclared as a plain string-literal union — same reasoning as every
// other enum in this codebase (shared/authz.ts's ROLE_VALUES header
// comment). Confirm against prisma/schema.prisma's `enum CustomerStatus`
// after your next `prisma generate`.
export const CUSTOMER_STATUS_VALUES = ["active", "inactive"] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUS_VALUES)[number];

const createCustomerSchema = z.object({
  name: z.string().trim().min(1).max(200),
  contact: z.string().trim().max(200).optional(),
  address: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
});

// NOTE on "duplicate handling": unlike Item (unique on orgId+sku),
// schema.prisma has no unique constraint on Customer beyond (orgId, id) —
// there is no natural secondary key to enforce uniqueness against (a
// customer "code"/reference number isn't in scope here). Two different
// customers sharing the same name is a real, legitimate case (common
// personal/business names), so this service does NOT reject duplicate
// names — that's a deliberate choice, not an oversight, and
// customer-service.test.ts asserts it explicitly so the behavior is
// documented rather than silently assumed. If you want duplicate-name
// detection (a warning, not a hard block, presumably — two "Acme Ltd"
// entries might both be real), that's a product decision plus a schema
// change (either a unique code field, or an app-level near-duplicate
// check) — flag it if you want that added.
export async function createCustomer(session: AuthenticatedSession, input: unknown) {
  assertCapability(session.role, "customer:create");
  const parsed = createCustomerSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid customer payload", parsed.error.issues);
  const data = parsed.data;

  const customer = await prisma.customer.create({
    data: {
      orgId: session.orgId,
      name: data.name,
      contact: data.contact ?? null,
      address: data.address ?? null,
      notes: data.notes ?? null,
    },
  });
  await recordAudit(prisma, {
    orgId: session.orgId,
    actorUserId: session.userId,
    entityType: "customer",
    entityId: customer.id,
    action: "create",
    afterValue: { name: customer.name },
  });
  return customer;
}

export interface ListCustomersFilter {
  status?: CustomerStatus;
  search?: string;
}

export async function listCustomers(session: AuthenticatedSession, filter: ListCustomersFilter = {}) {
  assertCapability(session.role, "customer:read");
  return prisma.customer.findMany({
    where: {
      orgId: session.orgId,
      ...(filter.status ? { status: filter.status } : {}),
      ...(filter.search
        ? {
            OR: [
              { name: { contains: filter.search, mode: "insensitive" as const } },
              { contact: { contains: filter.search, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    orderBy: { name: "asc" },
  });
}

export async function getCustomerById(session: AuthenticatedSession, customerId: string) {
  assertCapability(session.role, "customer:read");
  const customer = await prisma.customer.findFirst({ where: { orgId: session.orgId, id: customerId } });
  if (!customer) throw new NotFoundError("Customer");
  return customer;
}

const updateCustomerSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    contact: z.string().trim().max(200),
    address: z.string().trim().max(500),
    notes: z.string().trim().max(2000),
    status: z.enum(CUSTOMER_STATUS_VALUES),
  })
  .partial();

export async function updateCustomer(session: AuthenticatedSession, customerId: string, input: unknown) {
  assertCapability(session.role, "customer:update");
  const parsed = updateCustomerSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid customer payload", parsed.error.issues);
  const data = parsed.data;
  if (Object.keys(data).length === 0) throw new ValidationError("No fields supplied to update");

  const existing = await prisma.customer.findFirst({ where: { orgId: session.orgId, id: customerId } });
  if (!existing) throw new NotFoundError("Customer");

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    before[key] = (existing as Record<string, unknown>)[key];
    after[key] = (data as Record<string, unknown>)[key];
  }

  const updated = await prisma.customer.update({ where: { id: existing.id }, data });
  await recordAudit(prisma, {
    orgId: session.orgId,
    actorUserId: session.userId,
    entityType: "customer",
    entityId: existing.id,
    action: "update",
    beforeValue: before,
    afterValue: after,
  });
  return updated;
}
