import { describe, expect, it } from "vitest";
import { RejectReason } from "../../src/generated/prisma/client";
import { DISPOSITION_LABELS, INSPECTION_STATE_LABELS, MOVEMENT_LABELS, REJECT_REASON_LABELS, REJECT_REASON_OPTIONS } from "../labels";
import { PROFIT_REASON } from "../cost-copy";
import { formatQuantity, formatSignedQuantity } from "../format";

// The screen must be able to name every value the database/server can produce.
describe("shop-floor labels", () => {
  it("every defect category in the database enum has a label, and nothing else is offered", () => {
    for (const v of Object.values(RejectReason)) expect(REJECT_REASON_LABELS[v], v).toBeTruthy();
    expect(REJECT_REASON_OPTIONS.map(([v]) => v).sort()).toEqual(Object.values(RejectReason).sort());
  });
  it("dispositions and inspection states are all labelled", () => {
    expect(Object.keys(DISPOSITION_LABELS).sort()).toEqual(["rework", "scrap", "use_as_is"]);
    for (const s of ["not_required", "pending", "passed", "failed_open", "failed_resolved"]) expect(INSPECTION_STATE_LABELS[s], s).toBeTruthy();
  });
  it("the unit-cost gate's extra reason has copy", () => {
    expect(PROFIT_REASON.no_good_output).toBeTruthy();
  });
  it("existing movement labels are untouched", () => {
    expect(MOVEMENT_LABELS.production_consumption).toBeTruthy();
  });
});

describe("quantity display used by the output tables", () => {
  it("trims zeros without losing precision and signs reclassified units", () => {
    expect(formatQuantity("12.5000", "ea")).toBe("12.5 ea");
    expect(formatQuantity("0.0001")).toBe("0.0001");
    expect(formatSignedQuantity("-3")).toBe("−3");
  });
});
