// Supplier CRUD-lite — first milestone of the shared-core build-out
// (ARCHITECTURE.md's "shared core before industry layer" sequencing note).
// Deliberately shaped identically to customer-service.ts: see that file's
// own header comment and schema.prisma's Supplier model comment for why.
//
// Supplier scope is ORG-WIDE, not branch-scoped — same reasoning as Customer
// (a vendor relationship isn't a branch concept: the same supplier can ship
// to any branch), confirmed by schema.prisma having no branchId column on
// Supplier.
//
// No hard delete, same reasoning as every other entity in this codebase:
// audit history exists immediately. Supplier's lifecycle flag is the
// `status` enum (active/inactive), exposed through the generic updateSupplier
// path rather than a dedicated deactivate function, same pattern as Customer
// (authz.ts only grants "supplier:update", no separate "supplier:deactivate"
// capability).
import { z } from "zod";
import { prisma } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import { NotFoundError, ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";

// Redeclared as a plain string-literal union — same reasoning as every other
// enum in this codebase (shared/authz.ts's ROLE_VALUES header comment).
// Confirm against prisma/schema.prisma's `enum SupplierStatus` after your
// next `prisma generate`.
export const SUPPLIER_STATUS_VALUES = ["active", "inactive"] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUS_VALUES)[number];

const createSupplierSchema = z.object({
  name: z.string().trim().min(1).max(200),
  contact: z.string().trim().max(200).optional(),
  address: z.string().trim().max(500).optional(),
  notes: z.string().trim().max(2000).optional(),
});

// NOTE on "duplicate handling": same decision as Customer — schema.prisma has
// no unique constraint on Supplier beyond (orgId, id). Two different vendors
// sharing the same trading name is a real, legitimate case, so this service
// does NOT reject duplicate names — that's a deliberate choice, not an
// oversight, and supplier-service.test.ts asserts it explicitly. If you want
// duplicate-name detection (a warning, not a hard block — two "Acme Supplies"
// entries might both be real), that's a product decision plus a schema
// change (a supplier code field, or an app-level near-duplicate check) — flag
// it if you want that added.
export async function createSupplier(session: AuthenticatedSession, input: unknown) {
  assertCapability(session.role, "supplier:create");
  const parsed = createSupplierSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid supplier payload", parsed.error.issues);
  const data = parsed.data;

  const supplier = await prisma.supplier.create({
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
    entityType: "supplier",
    entityId: supplier.id,
    action: "create",
    afterValue: { name: supplier.name },
  });
  return supplier;
}

export interface ListSuppliersFilter {
  status?: SupplierStatus;
  search?: string;
}

export async function listSuppliers(session: AuthenticatedSession, filter: ListSuppliersFilter = {}) {
  assertCapability(session.role, "supplier:read");
  return prisma.supplier.findMany({
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

export async function getSupplierById(session: AuthenticatedSession, supplierId: string) {
  assertCapability(session.role, "supplier:read");
  const supplier = await prisma.supplier.findFirst({ where: { orgId: session.orgId, id: supplierId } });
  if (!supplier) throw new NotFoundError("Supplier");
  return supplier;
}

const updateSupplierSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    contact: z.string().trim().max(200),
    address: z.string().trim().max(500),
    notes: z.string().trim().max(2000),
    status: z.enum(SUPPLIER_STATUS_VALUES),
  })
  .partial();

export async function updateSupplier(session: AuthenticatedSession, supplierId: string, input: unknown) {
  assertCapability(session.role, "supplier:update");
  const parsed = updateSupplierSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid supplier payload", parsed.error.issues);
  const data = parsed.data;
  if (Object.keys(data).length === 0) throw new ValidationError("No fields supplied to update");

  const existing = await prisma.supplier.findFirst({ where: { orgId: session.orgId, id: supplierId } });
  if (!existing) throw new NotFoundError("Supplier");

  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const key of Object.keys(data)) {
    before[key] = (existing as Record<string, unknown>)[key];
    after[key] = (data as Record<string, unknown>)[key];
  }

  const updated = await prisma.supplier.update({ where: { id: existing.id }, data });
  await recordAudit(prisma, {
    orgId: session.orgId,
    actorUserId: session.userId,
    entityType: "supplier",
    entityId: existing.id,
    action: "update",
    beforeValue: before,
    afterValue: after,
  });
  return updated;
}
