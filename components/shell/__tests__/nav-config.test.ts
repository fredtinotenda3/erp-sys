import { describe, expect, it } from "vitest";
import { getVisibleNavItems } from "../nav-config";

const labels = (role: Parameters<typeof getVisibleNavItems>[0]) => getVisibleNavItems(role).map((i) => i.label);
const childLabels = (role: Parameters<typeof getVisibleNavItems>[0], parent: string) => getVisibleNavItems(role).find((i) => i.label === parent)?.children.map((c) => c.label) ?? [];

describe("getVisibleNavItems", () => {
  it("everyone sees the Command Centre", () => {
    for (const role of ["OWNER_ADMIN", "OPERATIONS_MANAGER", "PRODUCTION_MANAGER", "INVENTORY_MANAGER", "FINANCE_MANAGER", "VIEWER"] as const) {
      expect(labels(role)).toContain("Command Centre");
    }
  });
  it("never lists modules that have no screens yet", () => {
    for (const l of ["Orders", "Customers", "Quality", "Reports", "Settings"]) expect(labels("OWNER_ADMIN")).not.toContain(l);
  });
  it("only offers workflow links the role can actually perform", () => {
    expect(childLabels("VIEWER", "Inventory")).toEqual(["Stock", "Movements", "Warehouses"]);
    expect(childLabels("INVENTORY_MANAGER", "Inventory")).toContain("Receive stock");
    expect(childLabels("VIEWER", "Production")).not.toContain("New job");
    expect(childLabels("PRODUCTION_MANAGER", "Production")).toContain("New job");
  });
  it("exchange rates are visible to those who may read them, and only to them", () => {
    for (const r of ["OWNER_ADMIN", "OPERATIONS_MANAGER", "FINANCE_MANAGER"] as const) expect(labels(r)).toContain("Exchange rates");
    for (const r of ["PRODUCTION_MANAGER", "INVENTORY_MANAGER", "VIEWER"] as const) expect(labels(r)).not.toContain("Exchange rates");
  });
  it("returns plain serialisable data", () => {
    expect(() => JSON.stringify(getVisibleNavItems("OWNER_ADMIN"))).not.toThrow();
  });
});
