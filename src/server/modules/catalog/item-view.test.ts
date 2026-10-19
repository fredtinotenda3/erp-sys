import { describe, expect, it } from "vitest";
import { toItemView, toItemViews } from "./item-view";

const item = { id: "i", sku: "S", name: "N", standardCost: "5.00", standardCostCurrency: "USD", sellingPrice: "9.00", sellingPriceCurrency: "USD", reorderThreshold: "3" };

describe("toItemView (cost projection)", () => {
  it("removes cost and price fields for roles without cost:read", () => {
    for (const role of ["INVENTORY_MANAGER", "VIEWER", "PRODUCTION_OPERATOR"] as const) {
      const v = toItemView(role, item) as Record<string, unknown>;
      expect(v.standardCost).toBeUndefined();
      expect(v.standardCostCurrency).toBeUndefined();
      expect(v.sellingPrice).toBeUndefined();
      expect(v.sellingPriceCurrency).toBeUndefined();
      expect(v.sku).toBe("S");
      expect(v.reorderThreshold).toBe("3");
    }
  });
  it("keeps them for roles with cost:read", () => {
    for (const role of ["OWNER_ADMIN", "FINANCE_MANAGER", "PRODUCTION_MANAGER"] as const) {
      expect((toItemView(role, item) as Record<string, unknown>).standardCost).toBe("5.00");
    }
  });
  it("does not mutate the input", () => {
    toItemView("VIEWER", item);
    expect(item.standardCost).toBe("5.00");
  });
  it("projects lists", () => {
    expect(toItemViews("VIEWER", [item, item]).every((i) => !("standardCost" in i))).toBe(true);
  });
});
