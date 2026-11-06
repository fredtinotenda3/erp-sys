// Milestone 6 (Plastics Manufacturing Vertical): plastics material
// attributes (raw_material/consumable side) and plastics product spec
// (finished_good/wip side), both 1:1 extensions of an existing Item. Real-
// database test, not executed in this environment -- see
// IMPLEMENTATION_MANIFEST.md and industry-profile-service.test.ts's header
// comment for why. Run with `npm test -- plastics-item-service`.
//
// Covers:
//  - getPlasticsMaterialAttributes/setPlasticsMaterialAttributes: itemType
//    gate (raw_material/consumable only), blendComposition sum validation,
//    plastics_spec:manage capability, write-gated on the plastics profile
//    while reads are never profile-gated
//  - the partial-merge fix made during this round's hand-verification: an
//    omitted field on a second PUT preserves its existing value (does not
//    silently wipe it to null), while an explicit null still clears it --
//    this is the exact defect found while reviewing the service for
//    blendComposition (never exposed by the UI form) and fixed before this
//    delivery
//  - getPlasticsProductSpec/setPlasticsProductSpec: itemType gate
//    (finished_good/wip only), productType required on create, optional
//    thereafter, same partial-merge discipline
import { describe, it, expect, beforeAll } from "vitest";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { sessionWithRole } from "../../production/__tests__/production-helpers";
import { createItem } from "../item-service";
import { updateIndustryProfile } from "../../industry/industry-profile-service";
import {
  getPlasticsMaterialAttributes,
  setPlasticsMaterialAttributes,
  getPlasticsProductSpec,
  setPlasticsProductSpec,
} from "../plastics-item-service";
import { ForbiddenError, ValidationError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";

let org: TestOrg;
let owner: AuthenticatedSession;
let inv: AuthenticatedSession; // plastics_spec:manage
let operator: AuthenticatedSession; // lacks plastics_spec:manage
let viewer: AuthenticatedSession;
let resinItemId: string;
let bottleItemId: string;
let sparePartItemId: string;

let skuCounter = 0;
function sku(prefix: string) {
  skuCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${skuCounter}`;
}

beforeAll(async () => {
  org = await createTestOrg("plItemA");
  owner = await ownerSession(org);
  inv = await sessionWithRole(owner, org.organizationId, "INVENTORY_MANAGER", "pi-inv", [org.branchId]);
  operator = await sessionWithRole(owner, org.organizationId, "PRODUCTION_OPERATOR", "pi-op", [org.branchId]);
  viewer = await sessionWithRole(owner, org.organizationId, "VIEWER", "pi-vw", [org.branchId]);
  await updateIndustryProfile(owner, { industryProfile: "plastics", enabledModules: [] });

  resinItemId = (await createItem(owner, { sku: sku("RESIN"), itemType: "raw_material", name: "HDPE resin", uom: "kg" })).id;
  bottleItemId = (await createItem(owner, { sku: sku("BTL"), itemType: "finished_good", name: "500ml bottle", uom: "ea" })).id;
  sparePartItemId = (await createItem(owner, { sku: sku("SPARE"), itemType: "spare_part", name: "Extruder screw", uom: "ea" })).id;
}, 180_000);

describe("plastics material attributes", () => {
  it("returns null for an item with none recorded yet, readable by every role", async () => {
    for (const session of [owner, inv, operator, viewer]) {
      await expect(getPlasticsMaterialAttributes(session, resinItemId)).resolves.toBeNull();
    }
  });

  it("sets and reads back material attributes for a raw_material item", async () => {
    const row: any = await setPlasticsMaterialAttributes(inv, resinItemId, {
      polymerGrade: "HDPE 5502",
      resinSpec: "ASTM D1248",
      colourMasterbatch: "Natural",
      recycledContentPct: 25,
      blendComposition: [{ component: "Virgin HDPE", percentage: 75 }, { component: "Recycled HDPE", percentage: 25 }],
    });
    expect(row.polymerGrade).toBe("HDPE 5502");
    expect(row.recycledContentPct.toString()).toBe("25");

    const read: any = await getPlasticsMaterialAttributes(owner, resinItemId);
    expect(read.polymerGrade).toBe("HDPE 5502");
    expect(read.blendComposition).toHaveLength(2);
  });

  it("preserves a field omitted from a later PUT instead of wiping it to null (partial-merge, not full-replace)", async () => {
    // blendComposition is deliberately not resent here -- this is exactly
    // the scenario the UI form (plastics-spec-form.tsx) produces, since it
    // has no input for blendComposition at all.
    const row: any = await setPlasticsMaterialAttributes(inv, resinItemId, { polymerGrade: "HDPE 5502 (corrected)" });
    expect(row.polymerGrade).toBe("HDPE 5502 (corrected)");
    expect(row.blendComposition).toHaveLength(2); // untouched, not wiped
    expect(row.resinSpec).toBe("ASTM D1248"); // also untouched
  });

  it("an explicit null still clears a field, distinct from omitting it", async () => {
    const row: any = await setPlasticsMaterialAttributes(inv, resinItemId, { colourMasterbatch: null });
    expect(row.colourMasterbatch).toBeNull();
    expect(row.polymerGrade).toBe("HDPE 5502 (corrected)"); // other fields still untouched
  });

  it("rejects blendComposition percentages summing to more than 100%", async () => {
    await expect(
      setPlasticsMaterialAttributes(inv, resinItemId, {
        blendComposition: [{ component: "A", percentage: 60 }, { component: "B", percentage: 60 }],
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("rejects a finished_good/wip or spare_part item -- material attributes only apply to raw_material/consumable", async () => {
    await expect(setPlasticsMaterialAttributes(inv, bottleItemId, { polymerGrade: "x" })).rejects.toThrow(ValidationError);
    await expect(setPlasticsMaterialAttributes(inv, sparePartItemId, { polymerGrade: "x" })).rejects.toThrow(ValidationError);
  });

  it("requires plastics_spec:manage to write, but not to read", async () => {
    await expect(setPlasticsMaterialAttributes(operator, resinItemId, { polymerGrade: "x" })).rejects.toThrow(ForbiddenError);
    await expect(setPlasticsMaterialAttributes(viewer, resinItemId, { polymerGrade: "x" })).rejects.toThrow(ForbiddenError);
    await expect(getPlasticsMaterialAttributes(operator, resinItemId)).resolves.toBeTruthy();
  });

  it("requires the plastics profile to be active to write, but reads remain available after switching away", async () => {
    await updateIndustryProfile(owner, { industryProfile: "general", enabledModules: [] });
    await expect(setPlasticsMaterialAttributes(inv, resinItemId, { polymerGrade: "x" })).rejects.toThrow(ValidationError);
    // Historical data stays fully visible -- reads are never profile-gated.
    const stillReadable: any = await getPlasticsMaterialAttributes(owner, resinItemId);
    expect(stillReadable.polymerGrade).toBe("HDPE 5502 (corrected)");
    await updateIndustryProfile(owner, { industryProfile: "plastics", enabledModules: [] });
  });
});

describe("plastics product spec", () => {
  it("requires productType when creating a spec for the first time", async () => {
    await expect(setPlasticsProductSpec(inv, bottleItemId, { colour: "Clear" })).rejects.toThrow(ValidationError);
  });

  it("creates and reads back a product spec for a finished_good item", async () => {
    const row: any = await setPlasticsProductSpec(inv, bottleItemId, {
      productType: "bottle",
      resinType: "PET",
      colour: "Clear",
      nominalWeightGrams: 28.5,
      capacityMl: 500,
      neckFinish: "28mm PCO",
    });
    expect(row.productType).toBe("bottle");
    expect(row.capacityMl.toString()).toBe("500");

    const read: any = await getPlasticsProductSpec(owner, bottleItemId);
    expect(read.productType).toBe("bottle");
    expect(read.neckFinish).toBe("28mm PCO");
  });

  it("does not require productType again on a later partial update, and preserves omitted fields", async () => {
    const row: any = await setPlasticsProductSpec(inv, bottleItemId, { colour: "Amber" });
    expect(row.productType).toBe("bottle"); // preserved, not wiped
    expect(row.capacityMl.toString()).toBe("500"); // preserved
    expect(row.colour).toBe("Amber"); // updated
  });

  it("rejects a raw_material or spare_part item -- product spec only applies to finished_good/wip", async () => {
    await expect(setPlasticsProductSpec(inv, resinItemId, { productType: "x" })).rejects.toThrow(ValidationError);
    await expect(setPlasticsProductSpec(inv, sparePartItemId, { productType: "x" })).rejects.toThrow(ValidationError);
  });

  it("rejects non-positive dimension/weight/capacity values", async () => {
    await expect(setPlasticsProductSpec(inv, bottleItemId, { nominalWeightGrams: -1 })).rejects.toThrow(ValidationError);
    await expect(setPlasticsProductSpec(inv, bottleItemId, { capacityMl: 0 })).rejects.toThrow(ValidationError);
  });

  it("requires plastics_spec:manage to write, but not to read", async () => {
    await expect(setPlasticsProductSpec(operator, bottleItemId, { colour: "x" })).rejects.toThrow(ForbiddenError);
    await expect(getPlasticsProductSpec(viewer, bottleItemId)).resolves.toBeTruthy();
  });

  it("404s for an item that does not belong to this organization", async () => {
    await expect(getPlasticsProductSpec(owner, "00000000-0000-0000-0000-000000000000")).rejects.toThrow();
  });
});

describe("tenant isolation", () => {
  it("an item from a different organization never resolves", async () => {
    const orgB = await createTestOrg("plItemB");
    const ownerB = await ownerSession(orgB);
    await updateIndustryProfile(ownerB, { industryProfile: "plastics", enabledModules: [] });
    const itemB = await createItem(ownerB, { sku: sku("B-RESIN"), itemType: "raw_material", name: "Org B resin", uom: "kg" });
    await setPlasticsMaterialAttributes(ownerB, itemB.id, { polymerGrade: "PP" });

    await expect(getPlasticsMaterialAttributes(owner, itemB.id)).rejects.toThrow();
    await expect(setPlasticsMaterialAttributes(owner, itemB.id, { polymerGrade: "x" })).rejects.toThrow();
  });
});

