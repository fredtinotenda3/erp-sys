/* eslint-disable @typescript-eslint/no-explicit-any -- toView's total/unitPrice/lineTotal are conditionally
   spread on a runtime `canSeeCost: boolean`, so TS infers a union of the two shapes and can't statically
   narrow which branch a given role gets; same convention stock-service.test.ts uses for its own
   capability-gated view fields (unitCost/currency). */
// Real-database tests (same approach as every other module suite -- see
// e.g. sales-order-service.test.ts's header comment). Fresh random orgs per
// test. NOT executed in this environment: see IMPLEMENTATION_MANIFEST.md --
// writing and statically checking tests is within this environment's
// restrictions, connecting to a database is not. Run with
// `npm test -- purchase-order-service` against your local test database.
import { describe, expect, it } from "vitest";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createBranch, deactivateBranch } from "../../iam/branch-service";
import { sessionWithRole } from "../../production/__tests__/production-helpers";
import { createItem, updateItem } from "../../catalog/item-service";
import { createSupplier, updateSupplier } from "../../suppliers/supplier-service";
import {
  cancelPurchaseOrder,
  closePurchaseOrder,
  confirmPurchaseOrder,
  createPurchaseOrder,
  getPurchaseOrder,
  listPurchaseOrders,
  updatePurchaseOrder,
} from "../purchase-order-service";
import { ForbiddenError, NotFoundError } from "../../../shared/errors";

async function setup(label: string) {
  const org: TestOrg = await createTestOrg(label);
  const owner = await ownerSession(org);
  const supplier = await createSupplier(owner, { name: `Supplier ${label}` });
  const material = await createItem(owner, { sku: `PO-MAT-${label}-${Date.now()}`, itemType: "raw_material", name: "Test material", uom: "kg" });
  return { org, owner, supplier, material };
}

const line = (itemId: string, quantity = 10, unitPrice = 5, uom = "kg") => ({ itemId, quantity, uom, unitPrice });

describe("purchase orders: create, list, read", () => {
  it("creates a draft with sequential numbers, one currency and a plain quantity x price total", async () => {
    const { org, owner, supplier, material } = await setup("pocreate");
    const a = await createPurchaseOrder(owner, { branchId: org.branchId, supplierId: supplier.id, currency: "usd", lines: [line(material.id, 10, 5), line(material.id, 2, 12.5)] });
    const b = await createPurchaseOrder(owner, { branchId: org.branchId, supplierId: supplier.id, currency: "USD", lines: [line(material.id)] });
    expect(a.status).toBe("draft");
    expect(a.poNumber).toBe("PO-00001");
    expect(b.poNumber).toBe("PO-00002");
    expect(a.currency).toBe("USD");
    expect((a as any).total).toBe("75");
    expect(a.lines.every((l) => l.currency === "USD")).toBe(true);
    expect(a.lines[0].outstandingQty).toBe("10");
    expect(a.lines[0].receivedQty).toBe("0");
  });

  it("rejects bad input: no lines, zero quantity, negative price, missing uom, unknown currency, finished goods/wip, inactive supplier, inactive branch", async () => {
    const { org, owner, supplier, material } = await setup("povalidate");
    const base = { branchId: org.branchId, supplierId: supplier.id, currency: "USD" };
    await expect(createPurchaseOrder(owner, { ...base, lines: [] })).rejects.toThrow(/Invalid purchase order/);
    await expect(createPurchaseOrder(owner, { ...base, lines: [line(material.id, 0)] })).rejects.toThrow(/Invalid purchase order/);
    await expect(createPurchaseOrder(owner, { ...base, lines: [line(material.id, 1, -1)] })).rejects.toThrow(/Invalid purchase order/);
    await expect(createPurchaseOrder(owner, { ...base, lines: [{ itemId: material.id, quantity: 1, uom: "", unitPrice: 1 }] })).rejects.toThrow(/Invalid purchase order/);
    await expect(createPurchaseOrder(owner, { ...base, currency: "XXX", lines: [line(material.id)] })).rejects.toThrow(/Unknown currency/);

    const finished = await createItem(owner, { sku: `PO-FG-${Date.now()}`, itemType: "finished_good", name: "FG", uom: "ea" });
    await expect(createPurchaseOrder(owner, { ...base, lines: [line(finished.id)] })).rejects.toThrow(/can't be purchased/);
    const wip = await createItem(owner, { sku: `PO-WIP-${Date.now()}`, itemType: "wip", name: "WIP", uom: "ea" });
    await expect(createPurchaseOrder(owner, { ...base, lines: [line(wip.id)] })).rejects.toThrow(/can't be purchased/);

    await updateSupplier(owner, supplier.id, { status: "inactive" });
    await expect(createPurchaseOrder(owner, { ...base, lines: [line(material.id)] })).rejects.toThrow(/inactive supplier/);
    await updateSupplier(owner, supplier.id, { status: "active" });

    await expect(createPurchaseOrder(owner, { ...base, branchId: "00000000-0000-0000-0000-000000000000", lines: [line(material.id)] })).rejects.toThrow(/does not belong to this organization/);

    const branch2 = await createBranch(owner, { name: "Inactive Branch" });
    await deactivateBranch(owner, branch2.id);
    await expect(createPurchaseOrder(owner, { ...base, branchId: branch2.id, lines: [line(material.id)] })).rejects.toThrow(/inactive branch/);
  });

  it("paginates and filters by status, supplier and search", async () => {
    const { org, owner, supplier, material } = await setup("polist");
    const other = await createSupplier(owner, { name: "Another Vendor" });
    for (let i = 0; i < 3; i++) await createPurchaseOrder(owner, { branchId: org.branchId, supplierId: supplier.id, currency: "USD", lines: [line(material.id)] });
    const o = await createPurchaseOrder(owner, { branchId: org.branchId, supplierId: other.id, currency: "USD", lines: [line(material.id)] });
    await confirmPurchaseOrder(owner, o.id);
    const page1 = await listPurchaseOrders(owner, { limit: 2 });
    expect(page1.total).toBe(4);
    expect(page1.rows).toHaveLength(2);
    expect((await listPurchaseOrders(owner, { limit: 2, offset: 2 })).rows).toHaveLength(2);
    expect((await listPurchaseOrders(owner, { status: "confirmed" })).rows.map((r) => r.id)).toEqual([o.id]);
    expect((await listPurchaseOrders(owner, { supplierId: other.id })).total).toBe(1);
    expect((await listPurchaseOrders(owner, { search: "another" })).total).toBe(1);
    expect((await listPurchaseOrders(owner, { search: o.poNumber })).total).toBe(1);
    await expect(listPurchaseOrders(owner, { supplierId: "not-a-uuid" })).rejects.toThrow(/Invalid supplierId/);
  });

  it("org B's owner cannot see or read org A's purchase order (tenant isolation)", async () => {
    const a = await setup("poIsoA");
    const orgB = await createTestOrg("poIsoB");
    const ownerB = await ownerSession(orgB);
    const o = await createPurchaseOrder(a.owner, { branchId: a.org.branchId, supplierId: a.supplier.id, currency: "USD", lines: [line(a.material.id)] });

    expect((await listPurchaseOrders(ownerB, {})).rows.some((r) => r.id === o.id)).toBe(false);
    await expect(getPurchaseOrder(ownerB, o.id)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("purchase orders: lifecycle", () => {
  it("edits only while draft, then refuses", async () => {
    const { org, owner, supplier, material } = await setup("poedit");
    const o = await createPurchaseOrder(owner, { branchId: org.branchId, supplierId: supplier.id, currency: "USD", lines: [line(material.id, 1, 1)] });
    const edited = await updatePurchaseOrder(owner, o.id, { requestedDeliveryDate: "2027-01-31", lines: [line(material.id, 4, 2.5)] });
    expect(edited.requestedDeliveryDate).toBe("2027-01-31");
    expect((edited as any).total).toBe("10");
    await confirmPurchaseOrder(owner, o.id);
    await expect(updatePurchaseOrder(owner, o.id, { requestedDeliveryDate: null })).rejects.toThrow(/Only draft purchase orders can be edited/);
  });

  it("confirm is idempotent; requires at least one line; a cancelled order cannot be confirmed or edited; cancel needs a reason", async () => {
    const { org, owner, supplier, material } = await setup("pocancel");
    const o = await createPurchaseOrder(owner, { branchId: org.branchId, supplierId: supplier.id, currency: "USD", lines: [line(material.id)] });
    await confirmPurchaseOrder(owner, o.id);
    expect((await confirmPurchaseOrder(owner, o.id)).status).toBe("confirmed");
    await expect(cancelPurchaseOrder(owner, o.id, {})).rejects.toThrow(/reason is required/);
    const c = await cancelPurchaseOrder(owner, o.id, { reason: "Supplier withdrew" });
    expect(c.status).toBe("cancelled");
    await expect(confirmPurchaseOrder(owner, o.id)).rejects.toThrow(/can't be confirmed/);
    await expect(updatePurchaseOrder(owner, o.id, { requestedDeliveryDate: null })).rejects.toThrow(/Only draft purchase orders/);
  });

  it("close is idempotent and only valid from confirmed/partially_received/received; a draft can't be closed", async () => {
    const { org, owner, supplier, material } = await setup("poclose");
    const o = await createPurchaseOrder(owner, { branchId: org.branchId, supplierId: supplier.id, currency: "USD", lines: [line(material.id)] });
    await expect(closePurchaseOrder(owner, o.id, { reason: "n/a" })).rejects.toThrow(/can't be closed/);
    await confirmPurchaseOrder(owner, o.id);
    const closed = await closePurchaseOrder(owner, o.id, { reason: "Supplier discontinued the line" });
    expect(closed.status).toBe("closed");
    expect((await closePurchaseOrder(owner, o.id, { reason: "again" })).status).toBe("closed"); // idempotent
    await expect(closePurchaseOrder(owner, o.id, {})).rejects.toThrow(/reason is required/);
  });

  it("branch isolation: a user without access to the PO's branch gets NotFoundError, not Forbidden", async () => {
    const { org, owner, supplier, material } = await setup("pobranch");
    const branch2 = await createBranch(owner, { name: "Second" });
    const invOtherBranch = await sessionWithRole(owner, org.organizationId, "INVENTORY_MANAGER", "inv-other-branch", [branch2.id]);
    const o = await createPurchaseOrder(owner, { branchId: org.branchId, supplierId: supplier.id, currency: "USD", lines: [line(material.id)] });

    await expect(getPurchaseOrder(invOtherBranch, o.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(createPurchaseOrder(invOtherBranch, { branchId: org.branchId, supplierId: supplier.id, currency: "USD", lines: [line(material.id)] })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("purchase orders: capability matrix", () => {
  it("OPERATIONS_MANAGER can create, update, confirm and cancel", async () => {
    const { org, owner, supplier, material } = await setup("pocapops");
    const opsMgr = await sessionWithRole(owner, org.organizationId, "OPERATIONS_MANAGER", "opsmgr-po", [org.branchId]);
    const o = await createPurchaseOrder(opsMgr, { branchId: org.branchId, supplierId: supplier.id, currency: "USD", lines: [line(material.id)] });
    await expect(updatePurchaseOrder(opsMgr, o.id, { notes: "ok" })).resolves.toMatchObject({ notes: "ok" });
    await expect(confirmPurchaseOrder(opsMgr, o.id)).resolves.toMatchObject({ status: "confirmed" });
  });

  it("INVENTORY_MANAGER can create and update but NOT confirm a purchase order (segregation of duties)", async () => {
    const { org, owner, supplier, material } = await setup("pocapinv");
    const invMgr = await sessionWithRole(owner, org.organizationId, "INVENTORY_MANAGER", "invmgr-po", [org.branchId]);
    const o = await createPurchaseOrder(invMgr, { branchId: org.branchId, supplierId: supplier.id, currency: "USD", lines: [line(material.id)] });
    await expect(updatePurchaseOrder(invMgr, o.id, { notes: "ok" })).resolves.toMatchObject({ notes: "ok" });
    await expect(confirmPurchaseOrder(invMgr, o.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("PRODUCTION_MANAGER, FINANCE_MANAGER and VIEWER can read but not create", async () => {
    const { org, owner, supplier, material } = await setup("pocapread");
    const prodMgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "prodmgr-po", [org.branchId]);
    const finMgr = await sessionWithRole(owner, org.organizationId, "FINANCE_MANAGER", "finmgr-po", [org.branchId]);
    const viewer = await sessionWithRole(owner, org.organizationId, "VIEWER", "viewer-po", [org.branchId]);
    const o = await createPurchaseOrder(owner, { branchId: org.branchId, supplierId: supplier.id, currency: "USD", lines: [line(material.id)] });

    await expect(getPurchaseOrder(prodMgr, o.id)).resolves.toMatchObject({ id: o.id });
    await expect(getPurchaseOrder(finMgr, o.id)).resolves.toMatchObject({ id: o.id });
    await expect(getPurchaseOrder(viewer, o.id)).resolves.toMatchObject({ id: o.id });
    await expect(createPurchaseOrder(prodMgr, { branchId: org.branchId, supplierId: supplier.id, currency: "USD", lines: [line(material.id)] })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createPurchaseOrder(finMgr, { branchId: org.branchId, supplierId: supplier.id, currency: "USD", lines: [line(material.id)] })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("INVENTORY_MANAGER and VIEWER cannot see purchase unit price/total (cost:read withheld -- neither role has it, confirmed against authz.ts's CAPABILITIES_BY_ROLE)", async () => {
    const { org, owner, supplier, material } = await setup("pocapcost");
    const invMgr = await sessionWithRole(owner, org.organizationId, "INVENTORY_MANAGER", "invmgr-po-cost", [org.branchId]);
    const viewer = await sessionWithRole(owner, org.organizationId, "VIEWER", "viewer-po-cost", [org.branchId]);
    const o = await createPurchaseOrder(owner, { branchId: org.branchId, supplierId: supplier.id, currency: "USD", lines: [line(material.id, 10, 5)] });

    const asOwner: any = await getPurchaseOrder(owner, o.id);
    expect(asOwner.total).toBe("50");
    expect(asOwner.lines[0]).toHaveProperty("unitPrice");

    for (const session of [invMgr, viewer]) {
      const asRole: any = await getPurchaseOrder(session, o.id);
      expect(asRole).not.toHaveProperty("total");
      expect(asRole.lines[0]).not.toHaveProperty("unitPrice");
      expect(asRole.lines[0]).not.toHaveProperty("lineTotal");
    }
  });

  it("rejects an inactive item", async () => {
    const { org, owner, supplier, material } = await setup("poinactiveitem");
    await updateItem(owner, material.id, { isActive: false });
    await expect(createPurchaseOrder(owner, { branchId: org.branchId, supplierId: supplier.id, currency: "USD", lines: [line(material.id)] })).rejects.toThrow(/is inactive/);
  });

  it("PRODUCTION_OPERATOR has no purchase_order capability at all", async () => {
    const { org, owner, supplier, material } = await setup("pocapoperator");
    const operator = await sessionWithRole(owner, org.organizationId, "PRODUCTION_OPERATOR", "operator-po", [org.branchId]);
    await expect(listPurchaseOrders(operator, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(createPurchaseOrder(operator, { branchId: org.branchId, supplierId: supplier.id, currency: "USD", lines: [line(material.id)] })).rejects.toBeInstanceOf(ForbiddenError);
  });
});
