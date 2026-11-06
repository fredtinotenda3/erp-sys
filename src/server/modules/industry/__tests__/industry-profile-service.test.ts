// Milestone 5 (Configurable Industry Architecture). Real-database test (same
// approach as every other module suite -- see lot-consumption.test.ts's
// header comment). Fresh random orgs per file, no cleanup (audit rows make
// orgs undeletable by design). NOT executed in this environment: see
// IMPLEMENTATION_MANIFEST.md -- writing and statically checking tests is
// within this environment's restrictions, connecting to a database is not.
// Run with `npm test -- industry-profile-service` against your local test
// database, after `npx prisma generate` and `npx prisma migrate dev`.
//
// Covers:
//  - getIndustryProfile: every role's own org profile, no capability check,
//    defaults to "general" with default terminology
//  - listIndustryProfiles: the static registry -- all 7 profiles, only
//    "general"/"plastics" implemented, no capability check
//  - updateIndustryProfile: OWNER_ADMIN-only (mandate §7's "do not permit
//    arbitrary users to change an organisation's manufacturing
//    configuration"), rejects modules not in the target profile's
//    implemented list, deduplicates enabledModules, audits the change,
//    tenant isolation
//  - assertPlasticsProfileActive: the real enforcement point every
//    Milestone 6 WRITE path calls -- exercised directly here, and by every
//    Milestone 6 service's own test file for its specific write path
import { describe, it, expect, beforeAll } from "vitest";
import { createTestOrg, ownerSession, type TestOrg } from "../../iam/__tests__/test-helpers";
import { sessionWithRole } from "../../production/__tests__/production-helpers";
import { prisma } from "../../../shared/db";
import {
  getIndustryProfile,
  listIndustryProfiles,
  updateIndustryProfile,
  assertPlasticsProfileActive,
} from "../industry-profile-service";
import { ForbiddenError, ValidationError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";

let org: TestOrg;
let owner: AuthenticatedSession;
let opsMgr: AuthenticatedSession; // every other "admin tier" capability, but NOT industry_profile:manage
let viewer: AuthenticatedSession;

let orgB: TestOrg;
let ownerB: AuthenticatedSession;

beforeAll(async () => {
  org = await createTestOrg("ipA");
  owner = await ownerSession(org);
  opsMgr = await sessionWithRole(owner, org.organizationId, "OPERATIONS_MANAGER", "ip-ops", [org.branchId]);
  viewer = await sessionWithRole(owner, org.organizationId, "VIEWER", "ip-vw", [org.branchId]);

  orgB = await createTestOrg("ipB");
  ownerB = await ownerSession(orgB);
}, 180_000);

describe("getIndustryProfile", () => {
  it("defaults every new organization to \"general\" with default terminology, for every role", async () => {
    for (const session of [owner, opsMgr, viewer]) {
      const p = await getIndustryProfile(session);
      expect(p.industryProfile).toBe("general");
      expect(p.enabledModules).toEqual([]);
      expect(p.isImplemented).toBe(true);
      expect(p.terminology.machineLabel).toBe("Machine");
      expect(p.terminology.mouldLabel).toBe("Mould");
    }
  });

  it("is not capability-gated -- VIEWER, the least-privileged role, can read it", async () => {
    await expect(getIndustryProfile(viewer)).resolves.toBeTruthy();
  });
});

describe("listIndustryProfiles", () => {
  it("lists all 7 profiles with only general and plastics marked implemented", async () => {
    const profiles = listIndustryProfiles();
    expect(profiles).toHaveLength(7);
    const byKey = new Map(profiles.map((p) => [p.key, p]));
    expect(byKey.get("general")!.isImplemented).toBe(true);
    expect(byKey.get("plastics")!.isImplemented).toBe(true);
    for (const key of ["food_beverage", "metal_fabrication", "textile_garment", "furniture_woodworking", "packaging_printing"] as const) {
      expect(byKey.get(key)!.isImplemented).toBe(false);
      expect(byKey.get(key)!.availableModules).toEqual([]);
    }
    expect(byKey.get("plastics")!.availableModules.length).toBeGreaterThan(0);
    expect(byKey.get("plastics")!.availableModules.map((m) => m.key)).toContain("regrind_tracking");
  });

  it("is not capability-gated and is not organization-specific (no session org state leaks into it)", () => {
    const a = listIndustryProfiles();
    const b = listIndustryProfiles();
    expect(a).toEqual(b);
  });
});

describe("updateIndustryProfile", () => {
  it("rejects every role except OWNER_ADMIN", async () => {
    await expect(updateIndustryProfile(opsMgr, { industryProfile: "plastics", enabledModules: [] })).rejects.toThrow(ForbiddenError);
    await expect(updateIndustryProfile(viewer, { industryProfile: "plastics", enabledModules: [] })).rejects.toThrow(ForbiddenError);
  });

  it("switches an organization to plastics with a valid module subset, and reading it back reflects the change", async () => {
    const result = await updateIndustryProfile(owner, {
      industryProfile: "plastics",
      enabledModules: ["plastics_materials", "mould_management"],
      reason: "Switching to our actual plastics line",
    });
    expect(result.industryProfile).toBe("plastics");
    expect(result.enabledModules.sort()).toEqual(["mould_management", "plastics_materials"]);
    expect(result.isImplemented).toBe(true);
    expect(result.terminology.machineLabel).toBe("Press");

    const reread = await getIndustryProfile(owner);
    expect(reread.industryProfile).toBe("plastics");
    expect(reread.enabledModules.sort()).toEqual(["mould_management", "plastics_materials"]);

    // Switch back to general so later tests in this file start from a known baseline.
    await updateIndustryProfile(owner, { industryProfile: "general", enabledModules: [] });
  });

  it("rejects a module key that does not belong to the target profile's implemented list", async () => {
    await expect(
      updateIndustryProfile(owner, { industryProfile: "plastics", enabledModules: ["this_module_does_not_exist"] }),
    ).rejects.toThrow(ValidationError);
    // An unimplemented profile has an empty implemented-modules list, so ANY module is rejected for it.
    await expect(
      updateIndustryProfile(owner, { industryProfile: "food_beverage", enabledModules: ["regrind_tracking"] }),
    ).rejects.toThrow(ValidationError);
  });

  it("deduplicates a module key submitted more than once", async () => {
    const result = await updateIndustryProfile(owner, {
      industryProfile: "plastics",
      enabledModules: ["regrind_tracking", "regrind_tracking", "regrind_tracking"],
    });
    expect(result.enabledModules).toEqual(["regrind_tracking"]);
    await updateIndustryProfile(owner, { industryProfile: "general", enabledModules: [] });
  });

  it("rejects an unknown industryProfile value and an empty payload", async () => {
    await expect(updateIndustryProfile(owner, { industryProfile: "aerospace", enabledModules: [] })).rejects.toThrow(ValidationError);
    await expect(updateIndustryProfile(owner, {})).rejects.toThrow(ValidationError);
  });

  it("records an audit row with before/after on every successful change", async () => {
    await updateIndustryProfile(owner, { industryProfile: "plastics", enabledModules: [], reason: "audit check" });
    const audit = await prisma.auditLog.findFirst({
      where: { orgId: org.organizationId, entityType: "organization", entityId: org.organizationId, reason: "audit check" },
      orderBy: { createdAt: "desc" },
    });
    expect(audit).toBeTruthy();
    expect((audit!.afterValue as Record<string, unknown>).industryProfile).toBe("plastics");
    expect((audit!.beforeValue as Record<string, unknown>).industryProfile).toBe("general");
    await updateIndustryProfile(owner, { industryProfile: "general", enabledModules: [] });
  });

  it("respects tenant isolation -- org B's profile is untouched by org A's changes", async () => {
    await updateIndustryProfile(owner, { industryProfile: "plastics", enabledModules: [] });
    const bProfile = await getIndustryProfile(ownerB);
    expect(bProfile.industryProfile).toBe("general");
    await updateIndustryProfile(owner, { industryProfile: "general", enabledModules: [] });
  });
});

describe("assertPlasticsProfileActive", () => {
  it("throws ValidationError while the organization is on \"general\", and resolves once switched to \"plastics\"", async () => {
    await updateIndustryProfile(owner, { industryProfile: "general", enabledModules: [] });
    await expect(assertPlasticsProfileActive(owner)).rejects.toThrow(ValidationError);

    await updateIndustryProfile(owner, { industryProfile: "plastics", enabledModules: [] });
    await expect(assertPlasticsProfileActive(owner)).resolves.toBeUndefined();

    // Leave the fixture org on "plastics" -- every Milestone 6 service test
    // file below assumes this org (or its own freshly-created one) starts
    // on the plastics profile.
  });
});
