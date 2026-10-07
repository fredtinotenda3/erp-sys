import { describe, it, expect } from "vitest";
import { createTestOrg, ownerSession, loginAs, testEmail, TEST_PASSWORD } from "../../iam/__tests__/test-helpers";
import { createUser } from "../../iam/user-service";
import { listAuditLog } from "../../iam/audit-service";
import { createItem, listItems, getItemById, updateItem } from "../item-service";
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";

// Covers, per the Phase 1.5 kickoff instructions, only what genuinely applies
// to Catalog: tenant isolation, capability/role enforcement, and the item
// create/update business rules. Branch isolation, BOM snapshot immutability
// against a real ProductionJob, idempotent client_request_id retry, the
// operator reduced-view projection, and currency-grouped cost summation do
// NOT apply to this module (see the module-level note in the report sent
// alongside these files) and are deliberately not faked here.

async function sessionWithRole(
  owner: AuthenticatedSession,
  orgId: string,
  role: "OPERATIONS_MANAGER" | "PRODUCTION_MANAGER" | "INVENTORY_MANAGER" | "PRODUCTION_OPERATOR" | "FINANCE_MANAGER" | "VIEWER",
  label: string,
): Promise<AuthenticatedSession> {
  const email = testEmail(label);
  await createUser(owner, { email, fullName: label, role, password: TEST_PASSWORD });
  const { session } = await loginAs(orgId, email);
  return session;
}

describe("item-service", () => {
  describe("createItem", () => {
    it("creates an item and records an audit log entry", async () => {
      const org = await createTestOrg("itemCreate");
      const owner = await ownerSession(org);

      const item = await createItem(owner, {
        sku: "RM-001",
        itemType: "raw_material",
        name: "Steel Sheet 2mm",
        uom: "kg",
      });

      expect(item.sku).toBe("RM-001");
      expect(item.isSellable).toBe(false);
      expect(item.orgId).toBe(org.organizationId);

      const entries = await listAuditLog(owner, { entityType: "item", entityId: item.id, limit: 10 });
      expect(entries.some((e) => e.action === "create" && e.actorUserId === org.ownerUserId)).toBe(true);
    });

    it("rejects isSellable:true with no sellingPrice", async () => {
      const org = await createTestOrg("itemSellNoPrice");
      const owner = await ownerSession(org);
      await expect(
        createItem(owner, { sku: "FG-001", itemType: "finished_good", name: "Widget", uom: "ea", isSellable: true }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a sellingPrice when isSellable is false", async () => {
      const org = await createTestOrg("itemPriceNotSellable");
      const owner = await ownerSession(org);
      await expect(
        createItem(owner, {
          sku: "FG-002",
          itemType: "finished_good",
          name: "Widget 2",
          uom: "ea",
          isSellable: false,
          sellingPrice: 10,
          sellingPriceCurrency: "USD",
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects an unknown currency code", async () => {
      const org = await createTestOrg("itemUnknownCcy");
      const owner = await ownerSession(org);
      await expect(
        createItem(owner, {
          sku: "FG-003",
          itemType: "finished_good",
          name: "Widget 3",
          uom: "ea",
          isSellable: true,
          sellingPrice: 10,
          sellingPriceCurrency: "ZZZ",
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a duplicate SKU within the same organization", async () => {
      const org = await createTestOrg("itemDupSku");
      const owner = await ownerSession(org);
      await createItem(owner, { sku: "RM-DUP", itemType: "raw_material", name: "First", uom: "kg" });
      await expect(
        createItem(owner, { sku: "RM-DUP", itemType: "raw_material", name: "Second", uom: "kg" }),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    it("allows the same SKU to be reused across different organizations", async () => {
      const orgA = await createTestOrg("itemSkuOrgA");
      const orgB = await createTestOrg("itemSkuOrgB");
      const ownerA = await ownerSession(orgA);
      const ownerB = await ownerSession(orgB);

      await expect(
        createItem(ownerA, { sku: "SHARED-SKU", itemType: "raw_material", name: "Org A item", uom: "kg" }),
      ).resolves.toBeDefined();
      await expect(
        createItem(ownerB, { sku: "SHARED-SKU", itemType: "raw_material", name: "Org B item", uom: "kg" }),
      ).resolves.toBeDefined();
    });

    it("a PRODUCTION_OPERATOR cannot create items (capability check)", async () => {
      const org = await createTestOrg("itemCapOperator");
      const owner = await ownerSession(org);
      const operator = await sessionWithRole(owner, org.organizationId, "PRODUCTION_OPERATOR", "op-no-create");
      await expect(
        createItem(operator, { sku: "RM-OP", itemType: "raw_material", name: "Blocked", uom: "kg" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("a VIEWER cannot create items (capability check)", async () => {
      const org = await createTestOrg("itemCapViewer");
      const owner = await ownerSession(org);
      const viewer = await sessionWithRole(owner, org.organizationId, "VIEWER", "viewer-no-create");
      await expect(
        createItem(viewer, { sku: "RM-VW", itemType: "raw_material", name: "Blocked", uom: "kg" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("a PRODUCTION_MANAGER cannot create items — read-only on Catalog (capability check)", async () => {
      const org = await createTestOrg("itemCapProdMgr");
      const owner = await ownerSession(org);
      const prodMgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "prodmgr-no-create");
      await expect(
        createItem(prodMgr, { sku: "RM-PM", itemType: "raw_material", name: "Blocked", uom: "kg" }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("an INVENTORY_MANAGER can create items", async () => {
      const org = await createTestOrg("itemCapInvMgr");
      const owner = await ownerSession(org);
      const invMgr = await sessionWithRole(owner, org.organizationId, "INVENTORY_MANAGER", "invmgr-can-create");
      await expect(
        createItem(invMgr, { sku: "RM-IM", itemType: "raw_material", name: "Allowed", uom: "kg" }),
      ).resolves.toBeDefined();
    });
  });

  describe("listItems / getItemById — tenant isolation and filtering", () => {
    it("org B's owner cannot see org A's items via listItems", async () => {
      const orgA = await createTestOrg("itemIsoListA");
      const orgB = await createTestOrg("itemIsoListB");
      const ownerA = await ownerSession(orgA);
      const ownerB = await ownerSession(orgB);
      await createItem(ownerA, { sku: "ISO-A-1", itemType: "raw_material", name: "Org A only", uom: "kg" });

      const bItems = await listItems(ownerB, {});
      expect(bItems.some((i) => i.sku === "ISO-A-1")).toBe(false);
    });

    it("org B's owner gets NotFoundError reading org A's item by id", async () => {
      const orgA = await createTestOrg("itemIsoGetA");
      const orgB = await createTestOrg("itemIsoGetB");
      const ownerA = await ownerSession(orgA);
      const ownerB = await ownerSession(orgB);
      const item = await createItem(ownerA, { sku: "ISO-A-2", itemType: "raw_material", name: "Org A only", uom: "kg" });

      await expect(getItemById(ownerB, item.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("a PRODUCTION_OPERATOR cannot read the catalog at all (capability check)", async () => {
      const org = await createTestOrg("itemCapReadOperator");
      const owner = await ownerSession(org);
      const item = await createItem(owner, { sku: "RM-OPREAD", itemType: "raw_material", name: "Hidden", uom: "kg" });
      const operator = await sessionWithRole(owner, org.organizationId, "PRODUCTION_OPERATOR", "op-no-read");

      await expect(listItems(operator, {})).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getItemById(operator, item.id)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("filters by itemType and case-insensitive search", async () => {
      const org = await createTestOrg("itemFilter");
      const owner = await ownerSession(org);
      await createItem(owner, { sku: "FLT-RM", itemType: "raw_material", name: "Aluminium Bar", uom: "kg" });
      await createItem(owner, { sku: "FLT-FG", itemType: "finished_good", name: "Aluminium Widget", uom: "ea" });

      const rawOnly = await listItems(owner, { itemType: "raw_material" });
      expect(rawOnly.every((i) => i.itemType === "raw_material")).toBe(true);
      expect(rawOnly.some((i) => i.sku === "FLT-RM")).toBe(true);
      expect(rawOnly.some((i) => i.sku === "FLT-FG")).toBe(false);

      const searched = await listItems(owner, { search: "aluminium" });
      expect(searched.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("updateItem", () => {
    it("updates a field and records only the changed keys in the audit diff", async () => {
      const org = await createTestOrg("itemUpdateDiff");
      const owner = await ownerSession(org);
      const item = await createItem(owner, { sku: "UPD-1", itemType: "raw_material", name: "Old Name", uom: "kg" });

      const updated = await updateItem(owner, item.id, { name: "New Name" });
      expect(updated.name).toBe("New Name");
      expect(updated.uom).toBe("kg");

      const entries = await listAuditLog(owner, { entityType: "item", entityId: item.id, limit: 10 });
      const updateEntry = entries.find((e) => e.action === "update");
      expect(updateEntry).toBeDefined();
      expect(updateEntry?.beforeValue).toMatchObject({ name: "Old Name" });
      expect(updateEntry?.afterValue).toMatchObject({ name: "New Name" });
      expect(updateEntry?.afterValue).not.toHaveProperty("uom");
    });

    it("turning isSellable off auto-clears sellingPrice and sellingPriceCurrency", async () => {
      const org = await createTestOrg("itemUpdateClear");
      const owner = await ownerSession(org);
      const item = await createItem(owner, {
        sku: "UPD-2",
        itemType: "finished_good",
        name: "Sellable Thing",
        uom: "ea",
        isSellable: true,
        sellingPrice: 25,
        sellingPriceCurrency: "USD",
      });

      const updated = await updateItem(owner, item.id, { isSellable: false });
      expect(updated.isSellable).toBe(false);
      expect(updated.sellingPrice).toBeNull();
      expect(updated.sellingPriceCurrency).toBeNull();
    });

    it("rejects setting sellingPrice in the same call that turns isSellable off", async () => {
      const org = await createTestOrg("itemUpdateContradiction");
      const owner = await ownerSession(org);
      const item = await createItem(owner, {
        sku: "UPD-3",
        itemType: "finished_good",
        name: "Sellable Thing 2",
        uom: "ea",
        isSellable: true,
        sellingPrice: 25,
        sellingPriceCurrency: "USD",
      });

      await expect(
        updateItem(owner, item.id, { isSellable: false, sellingPrice: 30, sellingPriceCurrency: "USD" }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects turning isSellable on when no sellingPrice exists or is supplied", async () => {
      const org = await createTestOrg("itemUpdateNoPrice");
      const owner = await ownerSession(org);
      const item = await createItem(owner, { sku: "UPD-4", itemType: "finished_good", name: "Not Priced", uom: "ea" });

      await expect(updateItem(owner, item.id, { isSellable: true })).rejects.toBeInstanceOf(ValidationError);
    });

    it("returns NotFoundError for a nonexistent item", async () => {
      const org = await createTestOrg("itemUpdateMissing");
      const owner = await ownerSession(org);
      await expect(updateItem(owner, "00000000-0000-0000-0000-000000000000", { name: "X" })).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("org B's owner cannot update org A's item (tenant isolation)", async () => {
      const orgA = await createTestOrg("itemUpdateIsoA");
      const orgB = await createTestOrg("itemUpdateIsoB");
      const ownerA = await ownerSession(orgA);
      const ownerB = await ownerSession(orgB);
      const item = await createItem(ownerA, { sku: "ISO-UPD", itemType: "raw_material", name: "Org A only", uom: "kg" });

      await expect(updateItem(ownerB, item.id, { name: "Hijacked" })).rejects.toBeInstanceOf(NotFoundError);
    });

    it("a PRODUCTION_MANAGER cannot update items — read-only on Catalog (capability check)", async () => {
      const org = await createTestOrg("itemUpdateCapProdMgr");
      const owner = await ownerSession(org);
      const item = await createItem(owner, { sku: "UPD-5", itemType: "raw_material", name: "Target", uom: "kg" });
      const prodMgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "prodmgr-no-update");

      await expect(updateItem(prodMgr, item.id, { name: "Blocked" })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("an INVENTORY_MANAGER can update items", async () => {
      const org = await createTestOrg("itemUpdateCapInvMgr");
      const owner = await ownerSession(org);
      const item = await createItem(owner, { sku: "UPD-6", itemType: "raw_material", name: "Target", uom: "kg" });
      const invMgr = await sessionWithRole(owner, org.organizationId, "INVENTORY_MANAGER", "invmgr-can-update");

      await expect(updateItem(invMgr, item.id, { name: "Allowed" })).resolves.toMatchObject({ name: "Allowed" });
    });
  });
});
