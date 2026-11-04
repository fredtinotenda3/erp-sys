import { describe, it, expect } from "vitest";
import { createTestOrg, ownerSession, loginAs, testEmail, TEST_PASSWORD } from "../../iam/__tests__/test-helpers";
import { createUser } from "../../iam/user-service";
import { listAuditLog } from "../../iam/audit-service";
import { createSupplier, listSuppliers, getSupplierById, updateSupplier } from "../supplier-service";
import { ForbiddenError, NotFoundError, ValidationError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";
import type { Role } from "../../../shared/authz";

// Scope note: shaped identically to customer-service.test.ts — see that
// file's header comment and supplier-service.ts's own header comment for
// why. Branch isolation does not apply here either — Supplier is
// deliberately org-wide, confirmed by schema.prisma having no branchId
// column on Supplier.
//
// Capability matrix note: unlike Customer, INVENTORY_MANAGER can create and
// update Suppliers here (authz.ts's note on supplier:create explains why —
// Suppliers feeds directly into the Purchasing/Receiving chain
// INVENTORY_MANAGER already owns). PRODUCTION_MANAGER/FINANCE_MANAGER/VIEWER
// remain read-only, same as their Customer access; PRODUCTION_OPERATOR has no
// supplier capability at all, same as Customer.

async function sessionWithRole(owner: AuthenticatedSession, orgId: string, role: Role, label: string): Promise<AuthenticatedSession> {
  const email = testEmail(label);
  await createUser(owner, { email, fullName: label, role, password: TEST_PASSWORD });
  const { session } = await loginAs(orgId, email);
  return session;
}

describe("supplier-service", () => {
  describe("createSupplier", () => {
    it("creates a supplier and records an audit log entry", async () => {
      const org = await createTestOrg("supCreate");
      const owner = await ownerSession(org);

      const supplier = await createSupplier(owner, { name: "Acme Resin Supplies", contact: "+263 77 123 4567" });
      expect(supplier.name).toBe("Acme Resin Supplies");
      expect(supplier.status).toBe("active");
      expect(supplier.orgId).toBe(org.organizationId);

      const entries = await listAuditLog(owner, { entityType: "supplier", entityId: supplier.id, limit: 10 });
      expect(entries.some((e) => e.action === "create" && e.actorUserId === org.ownerUserId)).toBe(true);
    });

    it("allows two different suppliers to share the same name — no uniqueness constraint on Supplier.name", async () => {
      const org = await createTestOrg("supDupName");
      const owner = await ownerSession(org);
      await expect(createSupplier(owner, { name: "Same Name Supplies" })).resolves.toBeDefined();
      await expect(createSupplier(owner, { name: "Same Name Supplies" })).resolves.toBeDefined();
    });

    it("rejects an empty name", async () => {
      const org = await createTestOrg("supEmptyName");
      const owner = await ownerSession(org);
      await expect(createSupplier(owner, { name: "" })).rejects.toBeInstanceOf(ValidationError);
    });

    it("an OPERATIONS_MANAGER can create suppliers", async () => {
      const org = await createTestOrg("supCapOpsMgr");
      const owner = await ownerSession(org);
      const opsMgr = await sessionWithRole(owner, org.organizationId, "OPERATIONS_MANAGER", "opsmgr-sup-create");
      await expect(createSupplier(opsMgr, { name: "Ops Created Vendor" })).resolves.toBeDefined();
    });

    it("an INVENTORY_MANAGER can create suppliers (unlike Customer — see authz.ts's note)", async () => {
      const org = await createTestOrg("supCapInvMgr");
      const owner = await ownerSession(org);
      const invMgr = await sessionWithRole(owner, org.organizationId, "INVENTORY_MANAGER", "invmgr-sup-create");
      await expect(createSupplier(invMgr, { name: "Inventory Created Vendor" })).resolves.toBeDefined();
    });

    it("a PRODUCTION_MANAGER cannot create suppliers — read-only here (capability check)", async () => {
      const org = await createTestOrg("supCapProdMgr");
      const owner = await ownerSession(org);
      const prodMgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "prodmgr-sup-no-create");
      await expect(createSupplier(prodMgr, { name: "Blocked Vendor" })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("a FINANCE_MANAGER cannot create suppliers (capability check)", async () => {
      const org = await createTestOrg("supCapFinMgr");
      const owner = await ownerSession(org);
      const finMgr = await sessionWithRole(owner, org.organizationId, "FINANCE_MANAGER", "finmgr-sup-no-create");
      await expect(createSupplier(finMgr, { name: "Blocked Vendor" })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("a VIEWER cannot create suppliers (capability check)", async () => {
      const org = await createTestOrg("supCapViewer");
      const owner = await ownerSession(org);
      const viewer = await sessionWithRole(owner, org.organizationId, "VIEWER", "viewer-sup-no-create");
      await expect(createSupplier(viewer, { name: "Blocked Vendor" })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("a PRODUCTION_OPERATOR cannot create or read suppliers at all (capability check)", async () => {
      const org = await createTestOrg("supCapOperator");
      const owner = await ownerSession(org);
      const operator = await sessionWithRole(owner, org.organizationId, "PRODUCTION_OPERATOR", "operator-sup-none");
      await expect(createSupplier(operator, { name: "Blocked Vendor" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listSuppliers(operator, {})).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe("listSuppliers / getSupplierById — tenant isolation, filtering, and read access", () => {
    it("org B's owner cannot see org A's suppliers via listSuppliers", async () => {
      const orgA = await createTestOrg("supIsoListA");
      const orgB = await createTestOrg("supIsoListB");
      const ownerA = await ownerSession(orgA);
      const ownerB = await ownerSession(orgB);
      await createSupplier(ownerA, { name: "Org A Only Vendor" });

      const bSuppliers = await listSuppliers(ownerB, {});
      expect(bSuppliers.some((s) => s.name === "Org A Only Vendor")).toBe(false);
    });

    it("org B's owner gets NotFoundError reading org A's supplier by id", async () => {
      const orgA = await createTestOrg("supIsoGetA");
      const orgB = await createTestOrg("supIsoGetB");
      const ownerA = await ownerSession(orgA);
      const ownerB = await ownerSession(orgB);
      const supplier = await createSupplier(ownerA, { name: "Org A Only Vendor 2" });

      await expect(getSupplierById(ownerB, supplier.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("filters by status and case-insensitive search", async () => {
      const org = await createTestOrg("supFilter");
      const owner = await ownerSession(org);
      const s1 = await createSupplier(owner, { name: "Harare Polymer Supplies", contact: "sales@hararepoly.test" });
      await createSupplier(owner, { name: "Bulawayo Resin Co" });
      await updateSupplier(owner, s1.id, { status: "inactive" });

      const activeOnly = await listSuppliers(owner, { status: "active" });
      expect(activeOnly.some((s) => s.id === s1.id)).toBe(false);
      expect(activeOnly.some((s) => s.name === "Bulawayo Resin Co")).toBe(true);

      const searched = await listSuppliers(owner, { search: "harare" });
      expect(searched.some((s) => s.id === s1.id)).toBe(true);
    });

    it("a PRODUCTION_MANAGER, FINANCE_MANAGER, and VIEWER can all read suppliers", async () => {
      const org = await createTestOrg("supCapReadRoles");
      const owner = await ownerSession(org);
      const supplier = await createSupplier(owner, { name: "Readable Vendor" });
      const prodMgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "prodmgr-sup-read");
      const finMgr = await sessionWithRole(owner, org.organizationId, "FINANCE_MANAGER", "finmgr-sup-read");
      const viewer = await sessionWithRole(owner, org.organizationId, "VIEWER", "viewer-sup-read");

      await expect(getSupplierById(prodMgr, supplier.id)).resolves.toMatchObject({ id: supplier.id });
      await expect(getSupplierById(finMgr, supplier.id)).resolves.toMatchObject({ id: supplier.id });
      await expect(getSupplierById(viewer, supplier.id)).resolves.toMatchObject({ id: supplier.id });
    });
  });

  describe("updateSupplier", () => {
    it("updates fields and records only the changed keys in the audit diff", async () => {
      const org = await createTestOrg("supUpdateDiff");
      const owner = await ownerSession(org);
      const supplier = await createSupplier(owner, { name: "Old Vendor Name", contact: "old@vendor.test" });

      const updated = await updateSupplier(owner, supplier.id, { name: "New Vendor Name" });
      expect(updated.name).toBe("New Vendor Name");
      expect(updated.contact).toBe("old@vendor.test");

      const entries = await listAuditLog(owner, { entityType: "supplier", entityId: supplier.id, limit: 10 });
      const updateEntry = entries.find((e) => e.action === "update");
      expect(updateEntry).toBeDefined();
      expect(updateEntry?.beforeValue).toMatchObject({ name: "Old Vendor Name" });
      expect(updateEntry?.afterValue).toMatchObject({ name: "New Vendor Name" });
      expect(updateEntry?.afterValue).not.toHaveProperty("contact");
    });

    it("soft-deletes via the status field (active -> inactive), not a hard delete", async () => {
      const org = await createTestOrg("supSoftDelete");
      const owner = await ownerSession(org);
      const supplier = await createSupplier(owner, { name: "To Deactivate Vendor" });

      const updated = await updateSupplier(owner, supplier.id, { status: "inactive" });
      expect(updated.status).toBe("inactive");

      // Still readable by id — soft delete, not gone.
      await expect(getSupplierById(owner, supplier.id)).resolves.toMatchObject({ status: "inactive" });
    });

    it("rejects an update with no fields supplied", async () => {
      const org = await createTestOrg("supUpdateEmpty");
      const owner = await ownerSession(org);
      const supplier = await createSupplier(owner, { name: "Vendor" });
      await expect(updateSupplier(owner, supplier.id, {})).rejects.toBeInstanceOf(ValidationError);
    });

    it("returns NotFoundError for a nonexistent supplier", async () => {
      const org = await createTestOrg("supUpdateMissing");
      const owner = await ownerSession(org);
      await expect(updateSupplier(owner, "00000000-0000-0000-0000-000000000000", { name: "X" })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("org B's owner cannot update org A's supplier (tenant isolation)", async () => {
      const orgA = await createTestOrg("supUpdateIsoA");
      const orgB = await createTestOrg("supUpdateIsoB");
      const ownerA = await ownerSession(orgA);
      const ownerB = await ownerSession(orgB);
      const supplier = await createSupplier(ownerA, { name: "Org A Only Vendor 3" });

      await expect(updateSupplier(ownerB, supplier.id, { name: "Hijacked" })).rejects.toBeInstanceOf(NotFoundError);
    });

    it("a VIEWER cannot update suppliers, even though they can read them (capability check)", async () => {
      const org = await createTestOrg("supCapViewerUpdate");
      const owner = await ownerSession(org);
      const supplier = await createSupplier(owner, { name: "Vendor" });
      const viewer = await sessionWithRole(owner, org.organizationId, "VIEWER", "viewer-sup-no-update");

      await expect(updateSupplier(viewer, supplier.id, { name: "Blocked" })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("an OPERATIONS_MANAGER can update suppliers", async () => {
      const org = await createTestOrg("supCapOpsMgrUpdate");
      const owner = await ownerSession(org);
      const supplier = await createSupplier(owner, { name: "Vendor" });
      const opsMgr = await sessionWithRole(owner, org.organizationId, "OPERATIONS_MANAGER", "opsmgr-sup-update");

      await expect(updateSupplier(opsMgr, supplier.id, { name: "Allowed" })).resolves.toMatchObject({ name: "Allowed" });
    });

    it("an INVENTORY_MANAGER can update suppliers (unlike Customer — see authz.ts's note)", async () => {
      const org = await createTestOrg("supCapInvMgrUpdate");
      const owner = await ownerSession(org);
      const supplier = await createSupplier(owner, { name: "Vendor" });
      const invMgr = await sessionWithRole(owner, org.organizationId, "INVENTORY_MANAGER", "invmgr-sup-update");

      await expect(updateSupplier(invMgr, supplier.id, { name: "Allowed" })).resolves.toMatchObject({ name: "Allowed" });
    });
  });
});
