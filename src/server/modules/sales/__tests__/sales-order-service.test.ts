// Real-database tests (same approach as the other module suites). Fresh random orgs per test.
import { describe, expect, it } from "vitest";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createBranch } from "../../iam/branch-service";
import { createCustomer, updateCustomer } from "../../customers/customer-service";
import { createItem } from "../../catalog/item-service";
import { createJob } from "../../production/job-service";
import { productWithActiveBom, sessionWithRole } from "../../production/__tests__/production-helpers";
import {
  cancelSalesOrder,
  confirmSalesOrder,
  createSalesOrder,
  getSalesOrder,
  listSalesOrders,
  updateSalesOrder,
} from "../sales-order-service";
import { transitionJob } from "../../production/job-service";

async function setup(label: string) {
  const org: TestOrg = await createTestOrg(label);
  const owner = await ownerSession(org);
  const customer = await createCustomer(owner, { name: `Customer ${label}` });
  const { product } = await productWithActiveBom(owner, [{ bomQty: 2, standardCost: 3, standardCostCurrency: "USD" }]);
  return { org, owner, customer, product };
}

const line = (itemId: string, quantity = 5, unitPrice = 10) => ({ itemId, quantity, unitPrice });

describe("sales orders: create, list, read", () => {
  it("creates a draft with sequential numbers, one currency and a plain quantity x price total", async () => {
    const { org, owner, customer, product } = await setup("so-create");
    const a = await createSalesOrder(owner, { branchId: org.branchId, customerId: customer.id, currency: "usd", lines: [line(product.id, 5, 10), line(product.id, 2, 12.5)] });
    const b = await createSalesOrder(owner, { branchId: org.branchId, customerId: customer.id, currency: "USD", lines: [line(product.id)] });
    expect(a.status).toBe("draft");
    expect(a.orderNumber).toBe("SO-00001");
    expect(b.orderNumber).toBe("SO-00002");
    expect(a.currency).toBe("USD");
    expect(a.total).toBe("75");
    expect(a.lines.every((l) => l.currency === "USD")).toBe(true);
  });

  it("does not create any production work when an order is created or confirmed", async () => {
    const { org, owner, customer, product } = await setup("so-nojob");
    const o = await createSalesOrder(owner, { branchId: org.branchId, customerId: customer.id, currency: "USD", lines: [line(product.id)] });
    const confirmed = await confirmSalesOrder(owner, o.id);
    expect(confirmed.status).toBe("confirmed");
    expect(confirmed.lines.every((l) => l.productionJob === null)).toBe(true);
  });

  it("rejects bad input: no lines, zero quantity, negative price, unknown currency, raw materials, inactive customer", async () => {
    const { org, owner, customer, product } = await setup("so-validate");
    const base = { branchId: org.branchId, customerId: customer.id, currency: "USD" };
    await expect(createSalesOrder(owner, { ...base, lines: [] })).rejects.toThrow(/Invalid sales order/);
    await expect(createSalesOrder(owner, { ...base, lines: [line(product.id, 0)] })).rejects.toThrow(/Invalid sales order/);
    await expect(createSalesOrder(owner, { ...base, lines: [line(product.id, 1, -1)] })).rejects.toThrow(/Invalid sales order/);
    await expect(createSalesOrder(owner, { ...base, currency: "XXX", lines: [line(product.id)] })).rejects.toThrow(/Unknown currency/);
    const raw = await createItem(owner, { sku: `RAW-${Date.now()}`, itemType: "raw_material", name: "Raw", uom: "kg" });
    await expect(createSalesOrder(owner, { ...base, lines: [line(raw.id)] })).rejects.toThrow(/not a finished good/);
    await updateCustomer(owner, customer.id, { status: "inactive" });
    await expect(createSalesOrder(owner, { ...base, lines: [line(product.id)] })).rejects.toThrow(/inactive customer/);
  });

  it("paginates and filters by status, customer and search", async () => {
    const { org, owner, customer, product } = await setup("so-list");
    const other = await createCustomer(owner, { name: "Another Buyer" });
    for (let i = 0; i < 3; i++) await createSalesOrder(owner, { branchId: org.branchId, customerId: customer.id, currency: "USD", lines: [line(product.id)] });
    const o = await createSalesOrder(owner, { branchId: org.branchId, customerId: other.id, currency: "USD", lines: [line(product.id)] });
    await confirmSalesOrder(owner, o.id);
    const page1 = await listSalesOrders(owner, { limit: 2 });
    expect(page1.total).toBe(4);
    expect(page1.rows).toHaveLength(2);
    expect((await listSalesOrders(owner, { limit: 2, offset: 2 })).rows).toHaveLength(2);
    expect((await listSalesOrders(owner, { status: "confirmed" })).rows.map((r) => r.id)).toEqual([o.id]);
    expect((await listSalesOrders(owner, { customerId: other.id })).total).toBe(1);
    expect((await listSalesOrders(owner, { search: "another" })).total).toBe(1);
    expect((await listSalesOrders(owner, { search: o.orderNumber })).total).toBe(1);
    await expect(listSalesOrders(owner, { customerId: "not-a-uuid" })).rejects.toThrow(/Invalid customerId/);
  });
});

describe("sales orders: lifecycle", () => {
  it("edits only while draft, then refuses", async () => {
    const { org, owner, customer, product } = await setup("so-edit");
    const o = await createSalesOrder(owner, { branchId: org.branchId, customerId: customer.id, currency: "USD", lines: [line(product.id, 1, 1)] });
    const edited = await updateSalesOrder(owner, o.id, { requestedDeliveryDate: "2027-01-31", lines: [line(product.id, 4, 2.5)] });
    expect(edited.requestedDeliveryDate).toBe("2027-01-31");
    expect(edited.total).toBe("10");
    await confirmSalesOrder(owner, o.id);
    await expect(updateSalesOrder(owner, o.id, { requestedDeliveryDate: null })).rejects.toThrow(/Only draft orders can be edited/);
  });

  it("confirm is idempotent; a cancelled order cannot be confirmed or edited; cancel needs a reason", async () => {
    const { org, owner, customer, product } = await setup("so-cancel");
    const o = await createSalesOrder(owner, { branchId: org.branchId, customerId: customer.id, currency: "USD", lines: [line(product.id)] });
    await confirmSalesOrder(owner, o.id);
    expect((await confirmSalesOrder(owner, o.id)).status).toBe("confirmed");
    await expect(cancelSalesOrder(owner, o.id, {})).rejects.toThrow(/reason is required/);
    const c = await cancelSalesOrder(owner, o.id, { reason: "Customer withdrew" });
    expect(c.status).toBe("cancelled");
    await expect(confirmSalesOrder(owner, o.id)).rejects.toThrow(/can't be confirmed/);
    await expect(updateSalesOrder(owner, o.id, { requestedDeliveryDate: null })).rejects.toThrow(/Only draft orders/);
  });
});

describe("sales orders: releasing work into production", () => {
  it("requires a confirmed order, copies customer and quote from the line, and allows one job per line", async () => {
    const { org, owner, customer, product } = await setup("so-release");
    const o = await createSalesOrder(owner, { branchId: org.branchId, customerId: customer.id, currency: "USD", lines: [line(product.id, 5, 10)] });
    const lineId = o.lines[0].id;
    const req = { branchId: org.branchId, productItemId: product.id, plannedQty: 5, salesOrderLineId: lineId };

    await expect(createJob(owner, req)).rejects.toThrow(/confirmed order/);
    await confirmSalesOrder(owner, o.id);

    await expect(createJob(owner, { ...req, plannedQty: 4 })).rejects.toThrow(/must equal the order line quantity/);
    await expect(createJob(owner, { ...req, quotedAmount: 1, quotedCurrency: "USD" })).rejects.toThrow(/takes its customer and quote/);

    const job = await createJob(owner, req);
    expect(job.salesOrderLineId).toBe(lineId);
    expect(job.customerId).toBe(customer.id);
    expect(String(job.quotedAmount)).toBe("50");
    expect(job.quotedCurrency).toBe("USD");

    await expect(createJob(owner, req)).rejects.toThrow(/already has job/);
    const fresh = await getSalesOrder(owner, o.id);
    expect(fresh.lines[0].productionJob?.jobNumber).toBe(job.jobNumber);
  });

  it("blocks cancelling an order while its job is live, and allows it once the job is cancelled", async () => {
    const { org, owner, customer, product } = await setup("so-cancel-job");
    const o = await createSalesOrder(owner, { branchId: org.branchId, customerId: customer.id, currency: "USD", lines: [line(product.id, 2, 5)] });
    await confirmSalesOrder(owner, o.id);
    const job = await createJob(owner, { branchId: org.branchId, productItemId: product.id, plannedQty: 2, salesOrderLineId: o.lines[0].id });
    const jobId = job.id as string;
    await expect(cancelSalesOrder(owner, o.id, { reason: "changed mind" })).rejects.toThrow(/Cancel the linked production job/);
    await transitionJob(owner, jobId, { status: "cancelled", reason: "Order withdrawn" });
    expect((await cancelSalesOrder(owner, o.id, { reason: "changed mind" })).status).toBe("cancelled");
  });

  it("rejects a mismatched product, a mismatched branch and a cancelled order", async () => {
    const { org, owner, customer, product } = await setup("so-mismatch");
    const other = await productWithActiveBom(owner, [{ bomQty: 1, standardCost: 1, standardCostCurrency: "USD" }]);
    const second = await createBranch(owner, { name: `Second ${Date.now()}` });
    const o = await createSalesOrder(owner, { branchId: org.branchId, customerId: customer.id, currency: "USD", lines: [line(product.id, 1, 5)] });
    await confirmSalesOrder(owner, o.id);
    const lineId = o.lines[0].id;
    await expect(createJob(owner, { branchId: org.branchId, productItemId: other.product.id, plannedQty: 1, salesOrderLineId: lineId })).rejects.toThrow(/product on the order line/);
    await expect(createJob(owner, { branchId: second.id, productItemId: product.id, plannedQty: 1, salesOrderLineId: lineId })).rejects.toThrow(/order's branch/);
    await cancelSalesOrder(owner, o.id, { reason: "no longer needed" });
    await expect(createJob(owner, { branchId: org.branchId, productItemId: product.id, plannedQty: 1, salesOrderLineId: lineId })).rejects.toThrow(/confirmed order/);
  });
});

describe("sales orders: authorization and isolation", () => {
  it("enforces capabilities per role", async () => {
    const { org, owner, customer, product } = await setup("so-caps");
    const viewer = await sessionWithRole(owner, org.organizationId, "VIEWER", "so-viewer", [org.branchId]);
    const prodMgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "so-pm", [org.branchId]);
    const inventory = await sessionWithRole(owner, org.organizationId, "INVENTORY_MANAGER", "so-inv", [org.branchId]);
    const body = { branchId: org.branchId, customerId: customer.id, currency: "USD", lines: [line(product.id)] };

    const o = await createSalesOrder(owner, body);
    expect((await getSalesOrder(viewer, o.id)).id).toBe(o.id); // read-only role can read
    await expect(createSalesOrder(viewer, body)).rejects.toThrow(/does not have/);
    await expect(createSalesOrder(prodMgr, body)).rejects.toThrow(/does not have/); // PM reads orders only
    await expect(confirmSalesOrder(viewer, o.id)).rejects.toThrow(/does not have/);
    await expect(cancelSalesOrder(prodMgr, o.id, { reason: "nope nope" })).rejects.toThrow(/does not have/);
    await expect(listSalesOrders(inventory)).rejects.toThrow(/does not have/); // no sales_order:read
  });

  it("never discloses another organization's order", async () => {
    const a = await setup("so-org-a");
    const b = await setup("so-org-b");
    const o = await createSalesOrder(a.owner, { branchId: a.org.branchId, customerId: a.customer.id, currency: "USD", lines: [line(a.product.id)] });
    await expect(getSalesOrder(b.owner, o.id)).rejects.toThrow(/not found/);
    await expect(confirmSalesOrder(b.owner, o.id)).rejects.toThrow(/not found/);
    await expect(updateSalesOrder(b.owner, o.id, { requestedDeliveryDate: null })).rejects.toThrow(/not found/);
    expect((await listSalesOrders(b.owner)).total).toBe(0);
    // ...nor can org B create an order from org A's customer/product/branch
    await expect(createSalesOrder(b.owner, { branchId: b.org.branchId, customerId: a.customer.id, currency: "USD", lines: [line(b.product.id)] })).rejects.toThrow(/customerId does not belong/);
    await expect(createSalesOrder(b.owner, { branchId: b.org.branchId, customerId: b.customer.id, currency: "USD", lines: [line(a.product.id)] })).rejects.toThrow(/do not belong/);
    await expect(createSalesOrder(b.owner, { branchId: a.org.branchId, customerId: b.customer.id, currency: "USD", lines: [line(b.product.id)] })).rejects.toThrow();
  });

  it("scopes orders to the caller's branches (not-found, never forbidden)", async () => {
    const { org, owner, customer, product } = await setup("so-branch");
    const second = await createBranch(owner, { name: `Branch B ${Date.now()}` });
    const ops = await sessionWithRole(owner, org.organizationId, "OPERATIONS_MANAGER", "so-ops", [org.branchId]);
    const inSecond = await createSalesOrder(owner, { branchId: second.id, customerId: customer.id, currency: "USD", lines: [line(product.id)] });
    const inMain = await createSalesOrder(owner, { branchId: org.branchId, customerId: customer.id, currency: "USD", lines: [line(product.id)] });

    expect((await listSalesOrders(ops)).rows.map((r) => r.id)).toEqual([inMain.id]);
    await expect(getSalesOrder(ops, inSecond.id)).rejects.toThrow(/not found/);
    await expect(confirmSalesOrder(ops, inSecond.id)).rejects.toThrow(/not found/);
    await expect(createSalesOrder(ops, { branchId: second.id, customerId: customer.id, currency: "USD", lines: [line(product.id)] })).rejects.toThrow(/access to this branch/);
    await expect(listSalesOrders(ops, { branchId: second.id })).rejects.toThrow(/access to this branch/);
    // Releasing work from an order in a branch the caller can't access is refused too.
    await confirmSalesOrder(owner, inSecond.id);
    await expect(createJob(ops, { branchId: second.id, productItemId: product.id, plannedQty: 5, salesOrderLineId: inSecond.lines[0].id })).rejects.toThrow();
  });
});
