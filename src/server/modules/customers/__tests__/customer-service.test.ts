import { describe, it, expect } from "vitest";
import { createTestOrg, ownerSession, loginAs, testEmail, TEST_PASSWORD } from "../../iam/__tests__/test-helpers";
import { createUser } from "../../iam/user-service";
import { listAuditLog } from "../../iam/audit-service";
import { createCustomer, listCustomers, getCustomerById, updateCustomer } from "../customer-service";
import { ForbiddenError, NotFoundError, ValidationError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";
import type { Role } from "../../../shared/authz";

// Scope note: this module is Customer only — no SalesOrder. See
// customer-service.ts's header comment for why (ARCHITECTURE.md's own
// resolved decision table scopes SalesOrder to "Phase 3", not the first
// slice). Branch isolation does not apply here either — Customer is
// deliberately org-wide (same decision table, item #5), confirmed by
// schema.prisma having no branchId column on Customer.

async function sessionWithRole(owner: AuthenticatedSession, orgId: string, role: Role, label: string): Promise<AuthenticatedSession> {
  const email = testEmail(label);
  await createUser(owner, { email, fullName: label, role, password: TEST_PASSWORD });
  const { session } = await loginAs(orgId, email);
  return session;
}

describe("customer-service", () => {
  describe("createCustomer", () => {
    it("creates a customer and records an audit log entry", async () => {
      const org = await createTestOrg("custCreate");
      const owner = await ownerSession(org);

      const customer = await createCustomer(owner, { name: "Acme Fabrication", contact: "+263 77 123 4567" });
      expect(customer.name).toBe("Acme Fabrication");
      expect(customer.status).toBe("active");
      expect(customer.orgId).toBe(org.organizationId);

      const entries = await listAuditLog(owner, { entityType: "customer", entityId: customer.id, limit: 10 });
      expect(entries.some((e) => e.action === "create" && e.actorUserId === org.ownerUserId)).toBe(true);
    });

    it("allows two different customers to share the same name — no uniqueness constraint on Customer.name", async () => {
      const org = await createTestOrg("custDupName");
      const owner = await ownerSession(org);
      await expect(createCustomer(owner, { name: "Same Name Ltd" })).resolves.toBeDefined();
      await expect(createCustomer(owner, { name: "Same Name Ltd" })).resolves.toBeDefined();
    });

    it("rejects an empty name", async () => {
      const org = await createTestOrg("custEmptyName");
      const owner = await ownerSession(org);
      await expect(createCustomer(owner, { name: "" })).rejects.toBeInstanceOf(ValidationError);
    });

    it("an OPERATIONS_MANAGER can create customers", async () => {
      const org = await createTestOrg("custCapOpsMgr");
      const owner = await ownerSession(org);
      const opsMgr = await sessionWithRole(owner, org.organizationId, "OPERATIONS_MANAGER", "opsmgr-cust-create");
      await expect(createCustomer(opsMgr, { name: "Ops Created Co" })).resolves.toBeDefined();
    });

    it("a PRODUCTION_MANAGER cannot create customers — read-only here (capability check)", async () => {
      const org = await createTestOrg("custCapProdMgr");
      const owner = await ownerSession(org);
      const prodMgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "prodmgr-cust-no-create");
      await expect(createCustomer(prodMgr, { name: "Blocked Co" })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("a FINANCE_MANAGER cannot create customers (capability check)", async () => {
      const org = await createTestOrg("custCapFinMgr");
      const owner = await ownerSession(org);
      const finMgr = await sessionWithRole(owner, org.organizationId, "FINANCE_MANAGER", "finmgr-cust-no-create");
      await expect(createCustomer(finMgr, { name: "Blocked Co" })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("a VIEWER cannot create customers (capability check)", async () => {
      const org = await createTestOrg("custCapViewer");
      const owner = await ownerSession(org);
      const viewer = await sessionWithRole(owner, org.organizationId, "VIEWER", "viewer-cust-no-create");
      await expect(createCustomer(viewer, { name: "Blocked Co" })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("an INVENTORY_MANAGER cannot create or read customers at all (capability check)", async () => {
      const org = await createTestOrg("custCapInvMgr");
      const owner = await ownerSession(org);
      const invMgr = await sessionWithRole(owner, org.organizationId, "INVENTORY_MANAGER", "invmgr-cust-none");
      await expect(createCustomer(invMgr, { name: "Blocked Co" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listCustomers(invMgr, {})).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("a PRODUCTION_OPERATOR cannot create or read customers at all (capability check)", async () => {
      const org = await createTestOrg("custCapOperator");
      const owner = await ownerSession(org);
      const operator = await sessionWithRole(owner, org.organizationId, "PRODUCTION_OPERATOR", "operator-cust-none");
      await expect(createCustomer(operator, { name: "Blocked Co" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listCustomers(operator, {})).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe("listCustomers / getCustomerById — tenant isolation, filtering, and read access", () => {
    it("org B's owner cannot see org A's customers via listCustomers", async () => {
      const orgA = await createTestOrg("custIsoListA");
      const orgB = await createTestOrg("custIsoListB");
      const ownerA = await ownerSession(orgA);
      const ownerB = await ownerSession(orgB);
      await createCustomer(ownerA, { name: "Org A Only Co" });

      const bCustomers = await listCustomers(ownerB, {});
      expect(bCustomers.some((c) => c.name === "Org A Only Co")).toBe(false);
    });

    it("org B's owner gets NotFoundError reading org A's customer by id", async () => {
      const orgA = await createTestOrg("custIsoGetA");
      const orgB = await createTestOrg("custIsoGetB");
      const ownerA = await ownerSession(orgA);
      const ownerB = await ownerSession(orgB);
      const customer = await createCustomer(ownerA, { name: "Org A Only Co 2" });

      await expect(getCustomerById(ownerB, customer.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("filters by status and case-insensitive search", async () => {
      const org = await createTestOrg("custFilter");
      const owner = await ownerSession(org);
      const c1 = await createCustomer(owner, { name: "Harare Hardware", contact: "sales@hararehw.test" });
      await createCustomer(owner, { name: "Bulawayo Builders" });
      await updateCustomer(owner, c1.id, { status: "inactive" });

      const activeOnly = await listCustomers(owner, { status: "active" });
      expect(activeOnly.some((c) => c.id === c1.id)).toBe(false);
      expect(activeOnly.some((c) => c.name === "Bulawayo Builders")).toBe(true);

      const searched = await listCustomers(owner, { search: "harare" });
      expect(searched.some((c) => c.id === c1.id)).toBe(true);
    });

    it("a PRODUCTION_MANAGER, FINANCE_MANAGER, and VIEWER can all read customers", async () => {
      const org = await createTestOrg("custCapReadRoles");
      const owner = await ownerSession(org);
      const customer = await createCustomer(owner, { name: "Readable Co" });
      const prodMgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "prodmgr-cust-read");
      const finMgr = await sessionWithRole(owner, org.organizationId, "FINANCE_MANAGER", "finmgr-cust-read");
      const viewer = await sessionWithRole(owner, org.organizationId, "VIEWER", "viewer-cust-read");

      await expect(getCustomerById(prodMgr, customer.id)).resolves.toMatchObject({ id: customer.id });
      await expect(getCustomerById(finMgr, customer.id)).resolves.toMatchObject({ id: customer.id });
      await expect(getCustomerById(viewer, customer.id)).resolves.toMatchObject({ id: customer.id });
    });
  });

  describe("updateCustomer", () => {
    it("updates fields and records only the changed keys in the audit diff", async () => {
      const org = await createTestOrg("custUpdateDiff");
      const owner = await ownerSession(org);
      const customer = await createCustomer(owner, { name: "Old Co Name", contact: "old@co.test" });

      const updated = await updateCustomer(owner, customer.id, { name: "New Co Name" });
      expect(updated.name).toBe("New Co Name");
      expect(updated.contact).toBe("old@co.test");

      const entries = await listAuditLog(owner, { entityType: "customer", entityId: customer.id, limit: 10 });
      const updateEntry = entries.find((e) => e.action === "update");
      expect(updateEntry).toBeDefined();
      expect(updateEntry?.beforeValue).toMatchObject({ name: "Old Co Name" });
      expect(updateEntry?.afterValue).toMatchObject({ name: "New Co Name" });
      expect(updateEntry?.afterValue).not.toHaveProperty("contact");
    });

    it("soft-deletes via the status field (active -> inactive), not a hard delete", async () => {
      const org = await createTestOrg("custSoftDelete");
      const owner = await ownerSession(org);
      const customer = await createCustomer(owner, { name: "To Deactivate Co" });

      const updated = await updateCustomer(owner, customer.id, { status: "inactive" });
      expect(updated.status).toBe("inactive");

      // Still readable by id — soft delete, not gone.
      await expect(getCustomerById(owner, customer.id)).resolves.toMatchObject({ status: "inactive" });
    });

    it("rejects an update with no fields supplied", async () => {
      const org = await createTestOrg("custUpdateEmpty");
      const owner = await ownerSession(org);
      const customer = await createCustomer(owner, { name: "Co" });
      await expect(updateCustomer(owner, customer.id, {})).rejects.toBeInstanceOf(ValidationError);
    });

    it("returns NotFoundError for a nonexistent customer", async () => {
      const org = await createTestOrg("custUpdateMissing");
      const owner = await ownerSession(org);
      await expect(updateCustomer(owner, "00000000-0000-0000-0000-000000000000", { name: "X" })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("org B's owner cannot update org A's customer (tenant isolation)", async () => {
      const orgA = await createTestOrg("custUpdateIsoA");
      const orgB = await createTestOrg("custUpdateIsoB");
      const ownerA = await ownerSession(orgA);
      const ownerB = await ownerSession(orgB);
      const customer = await createCustomer(ownerA, { name: "Org A Only Co 3" });

      await expect(updateCustomer(ownerB, customer.id, { name: "Hijacked" })).rejects.toBeInstanceOf(NotFoundError);
    });

    it("a VIEWER cannot update customers, even though they can read them (capability check)", async () => {
      const org = await createTestOrg("custCapViewerUpdate");
      const owner = await ownerSession(org);
      const customer = await createCustomer(owner, { name: "Co" });
      const viewer = await sessionWithRole(owner, org.organizationId, "VIEWER", "viewer-cust-no-update");

      await expect(updateCustomer(viewer, customer.id, { name: "Blocked" })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("an OPERATIONS_MANAGER can update customers", async () => {
      const org = await createTestOrg("custCapOpsMgrUpdate");
      const owner = await ownerSession(org);
      const customer = await createCustomer(owner, { name: "Co" });
      const opsMgr = await sessionWithRole(owner, org.organizationId, "OPERATIONS_MANAGER", "opsmgr-cust-update");

      await expect(updateCustomer(opsMgr, customer.id, { name: "Allowed" })).resolves.toMatchObject({ name: "Allowed" });
    });
  });
});
