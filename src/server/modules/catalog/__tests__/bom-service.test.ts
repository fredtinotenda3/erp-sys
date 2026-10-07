import { describe, it, expect } from "vitest";
import { createTestOrg, ownerSession, loginAs, testEmail, TEST_PASSWORD } from "../../iam/__tests__/test-helpers";
import { createUser } from "../../iam/user-service";
import { listAuditLog } from "../../iam/audit-service";
import { createItem } from "../item-service";
import { createBomVersion, listBomVersions, getActiveBom, activateBomVersion } from "../bom-service";
import { ForbiddenError, NotFoundError, ValidationError, ConflictError } from "../../../shared/errors";
import type { AuthenticatedSession } from "../../iam/session-service";

// Scope note (same as item-service.test.ts): only tenant isolation,
// capability enforcement, and BOM versioning's own business rules are
// covered here. "BOM snapshot immutability" in the full sense Stanley's
// Rule 3 describes — a BOM change never alters an existing ProductionJob —
// cannot be tested until the Production module exists; what IS tested here
// is the narrower, already-applicable half of that same invariant: creating
// or activating a new version never mutates a previous version's own rows.

async function sessionWithRole(
  owner: AuthenticatedSession,
  orgId: string,
  role: "PRODUCTION_MANAGER" | "INVENTORY_MANAGER" | "PRODUCTION_OPERATOR",
  label: string,
): Promise<AuthenticatedSession> {
  const email = testEmail(label);
  await createUser(owner, { email, fullName: label, role, password: TEST_PASSWORD });
  const { session } = await loginAs(orgId, email);
  return session;
}

async function productAndMaterial(owner: AuthenticatedSession, suffix: string) {
  const product = await createItem(owner, {
    sku: `PROD-${suffix}`,
    itemType: "finished_good",
    name: `Product ${suffix}`,
    uom: "ea",
  });
  const material = await createItem(owner, {
    sku: `MAT-${suffix}`,
    itemType: "raw_material",
    name: `Material ${suffix}`,
    uom: "kg",
  });
  return { product, material };
}

describe("bom-service", () => {
  describe("createBomVersion", () => {
    it("creates version 1 as a draft with its lines, and records an audit entry", async () => {
      const org = await createTestOrg("bomCreateV1");
      const owner = await ownerSession(org);
      const { product, material } = await productAndMaterial(owner, "A");

      const bom = await createBomVersion(owner, product.id, {
        lines: [{ materialItemId: material.id, quantity: 2.5, uom: "kg" }],
      });

      expect(bom?.version).toBe(1);
      expect(bom?.status).toBe("draft");
      expect(bom?.lines).toHaveLength(1);
      expect(bom?.lines[0].materialItemId).toBe(material.id);

      const entries = await listAuditLog(owner, { entityType: "bill_of_material", entityId: bom!.id, limit: 10 });
      expect(entries.some((e) => e.action === "create")).toBe(true);
    });

    it("a second version increments the version number without mutating the first", async () => {
      const org = await createTestOrg("bomCreateV2");
      const owner = await ownerSession(org);
      const { product, material } = await productAndMaterial(owner, "B");

      const v1 = await createBomVersion(owner, product.id, {
        lines: [{ materialItemId: material.id, quantity: 1, uom: "kg" }],
      });
      const v2 = await createBomVersion(owner, product.id, {
        lines: [{ materialItemId: material.id, quantity: 9, uom: "kg" }],
      });

      expect(v2?.version).toBe(2);
      expect(v2?.status).toBe("draft");

      const versions = await listBomVersions(owner, product.id);
      const reloadedV1 = versions.find((v) => v.id === v1!.id);
      expect(reloadedV1?.status).toBe("draft");
      expect(reloadedV1?.lines).toHaveLength(1);
      expect(reloadedV1?.lines[0].quantity.toNumber()).toBe(1);
    });

    it("rejects a materialItemId that does not belong to this organization", async () => {
      const orgA = await createTestOrg("bomMaterialIsoA");
      const orgB = await createTestOrg("bomMaterialIsoB");
      const ownerA = await ownerSession(orgA);
      const ownerB = await ownerSession(orgB);
      const { product } = await productAndMaterial(ownerA, "C");
      const { material: foreignMaterial } = await productAndMaterial(ownerB, "D");

      await expect(
        createBomVersion(ownerA, product.id, {
          lines: [{ materialItemId: foreignMaterial.id, quantity: 1, uom: "kg" }],
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("rejects a productItemId that does not exist in this organization", async () => {
      const org = await createTestOrg("bomProductMissing");
      const owner = await ownerSession(org);
      const { material } = await productAndMaterial(owner, "E");

      await expect(
        createBomVersion(owner, "00000000-0000-0000-0000-000000000000", {
          lines: [{ materialItemId: material.id, quantity: 1, uom: "kg" }],
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("rejects an empty lines array", async () => {
      const org = await createTestOrg("bomEmptyLines");
      const owner = await ownerSession(org);
      const { product } = await productAndMaterial(owner, "F");

      await expect(createBomVersion(owner, product.id, { lines: [] })).rejects.toBeInstanceOf(ValidationError);
    });

    it("a PRODUCTION_MANAGER can create BOM versions", async () => {
      const org = await createTestOrg("bomCapProdMgrCreate");
      const owner = await ownerSession(org);
      const { product, material } = await productAndMaterial(owner, "G");
      const prodMgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "prodmgr-bom-create");

      await expect(
        createBomVersion(prodMgr, product.id, { lines: [{ materialItemId: material.id, quantity: 1, uom: "kg" }] }),
      ).resolves.toBeDefined();
    });

    it("an INVENTORY_MANAGER cannot create BOM versions — read-only on BOMs (capability check)", async () => {
      const org = await createTestOrg("bomCapInvMgrCreate");
      const owner = await ownerSession(org);
      const { product, material } = await productAndMaterial(owner, "H");
      const invMgr = await sessionWithRole(owner, org.organizationId, "INVENTORY_MANAGER", "invmgr-bom-no-create");

      await expect(
        createBomVersion(invMgr, product.id, { lines: [{ materialItemId: material.id, quantity: 1, uom: "kg" }] }),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("a PRODUCTION_OPERATOR cannot create or read BOMs at all (capability check)", async () => {
      const org = await createTestOrg("bomCapOperator");
      const owner = await ownerSession(org);
      const { product, material } = await productAndMaterial(owner, "I");
      const operator = await sessionWithRole(owner, org.organizationId, "PRODUCTION_OPERATOR", "operator-bom-none");

      await expect(
        createBomVersion(operator, product.id, { lines: [{ materialItemId: material.id, quantity: 1, uom: "kg" }] }),
      ).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listBomVersions(operator, product.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getActiveBom(operator, product.id)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  describe("activateBomVersion / getActiveBom", () => {
    it("getActiveBom returns null before any version has been activated", async () => {
      const org = await createTestOrg("bomNoneActiveYet");
      const owner = await ownerSession(org);
      const { product, material } = await productAndMaterial(owner, "J");
      await createBomVersion(owner, product.id, { lines: [{ materialItemId: material.id, quantity: 1, uom: "kg" }] });

      await expect(getActiveBom(owner, product.id)).resolves.toBeNull();
    });

    it("activating a draft makes it the active version, and records a transition audit entry", async () => {
      const org = await createTestOrg("bomActivateFirst");
      const owner = await ownerSession(org);
      const { product, material } = await productAndMaterial(owner, "K");
      const v1 = await createBomVersion(owner, product.id, {
        lines: [{ materialItemId: material.id, quantity: 1, uom: "kg" }],
      });

      const activated = await activateBomVersion(owner, product.id, v1!.id);
      expect(activated?.status).toBe("active");

      const active = await getActiveBom(owner, product.id);
      expect(active?.id).toBe(v1!.id);

      const entries = await listAuditLog(owner, { entityType: "bill_of_material", entityId: v1!.id, limit: 10 });
      expect(entries.some((e) => e.action === "transition" && e.afterValue && (e.afterValue as Record<string, unknown>).status === "active")).toBe(
        true,
      );
    });

    it("activating a second version supersedes the first without mutating the first's lines", async () => {
      const org = await createTestOrg("bomSupersede");
      const owner = await ownerSession(org);
      const { product, material } = await productAndMaterial(owner, "L");
      const v1 = await createBomVersion(owner, product.id, {
        lines: [{ materialItemId: material.id, quantity: 1, uom: "kg" }],
      });
      await activateBomVersion(owner, product.id, v1!.id);
      const v2 = await createBomVersion(owner, product.id, {
        lines: [{ materialItemId: material.id, quantity: 2, uom: "kg" }],
      });
      await activateBomVersion(owner, product.id, v2!.id);

      const versions = await listBomVersions(owner, product.id);
      const reloadedV1 = versions.find((v) => v.id === v1!.id);
      const reloadedV2 = versions.find((v) => v.id === v2!.id);
      expect(reloadedV1?.status).toBe("superseded");
      expect(reloadedV1?.lines[0].quantity.toNumber()).toBe(1); // untouched by the supersession
      expect(reloadedV2?.status).toBe("active");

      const active = await getActiveBom(owner, product.id);
      expect(active?.id).toBe(v2!.id);

      const supersedeEntry = (await listAuditLog(owner, { entityType: "bill_of_material", entityId: v1!.id, limit: 10 })).find(
        (e) => e.action === "transition" && (e.afterValue as Record<string, unknown> | null)?.status === "superseded",
      );
      expect(supersedeEntry).toBeDefined();
    });

    it("activating the already-active version is an idempotent no-op", async () => {
      const org = await createTestOrg("bomActivateIdempotent");
      const owner = await ownerSession(org);
      const { product, material } = await productAndMaterial(owner, "M");
      const v1 = await createBomVersion(owner, product.id, {
        lines: [{ materialItemId: material.id, quantity: 1, uom: "kg" }],
      });
      await activateBomVersion(owner, product.id, v1!.id);

      const reactivated = await activateBomVersion(owner, product.id, v1!.id);
      expect(reactivated?.status).toBe("active");
    });

    it("rejects reactivating a superseded version", async () => {
      const org = await createTestOrg("bomReactivateSuperseded");
      const owner = await ownerSession(org);
      const { product, material } = await productAndMaterial(owner, "N");
      const v1 = await createBomVersion(owner, product.id, {
        lines: [{ materialItemId: material.id, quantity: 1, uom: "kg" }],
      });
      await activateBomVersion(owner, product.id, v1!.id);
      const v2 = await createBomVersion(owner, product.id, {
        lines: [{ materialItemId: material.id, quantity: 2, uom: "kg" }],
      });
      await activateBomVersion(owner, product.id, v2!.id);

      await expect(activateBomVersion(owner, product.id, v1!.id)).rejects.toBeInstanceOf(ConflictError);
    });

    it("returns NotFoundError for a nonexistent BOM id", async () => {
      const org = await createTestOrg("bomActivateMissing");
      const owner = await ownerSession(org);
      const { product } = await productAndMaterial(owner, "O");

      await expect(activateBomVersion(owner, product.id, "00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(
        NotFoundError,
      );
    });

    it("org B's owner cannot activate or read org A's BOM versions (tenant isolation)", async () => {
      const orgA = await createTestOrg("bomIsoA");
      const orgB = await createTestOrg("bomIsoB");
      const ownerA = await ownerSession(orgA);
      const ownerB = await ownerSession(orgB);
      const { product, material } = await productAndMaterial(ownerA, "P");
      const v1 = await createBomVersion(ownerA, product.id, {
        lines: [{ materialItemId: material.id, quantity: 1, uom: "kg" }],
      });

      await expect(listBomVersions(ownerB, product.id)).rejects.toBeInstanceOf(NotFoundError);
      await expect(activateBomVersion(ownerB, product.id, v1!.id)).rejects.toBeInstanceOf(NotFoundError);
    });

    it("a PRODUCTION_MANAGER can activate BOM versions", async () => {
      const org = await createTestOrg("bomCapProdMgrActivate");
      const owner = await ownerSession(org);
      const { product, material } = await productAndMaterial(owner, "Q");
      const v1 = await createBomVersion(owner, product.id, {
        lines: [{ materialItemId: material.id, quantity: 1, uom: "kg" }],
      });
      const prodMgr = await sessionWithRole(owner, org.organizationId, "PRODUCTION_MANAGER", "prodmgr-bom-activate");

      await expect(activateBomVersion(prodMgr, product.id, v1!.id)).resolves.toMatchObject({ status: "active" });
    });

    it("an INVENTORY_MANAGER cannot activate BOM versions (capability check)", async () => {
      const org = await createTestOrg("bomCapInvMgrActivate");
      const owner = await ownerSession(org);
      const { product, material } = await productAndMaterial(owner, "R");
      const v1 = await createBomVersion(owner, product.id, {
        lines: [{ materialItemId: material.id, quantity: 1, uom: "kg" }],
      });
      const invMgr = await sessionWithRole(owner, org.organizationId, "INVENTORY_MANAGER", "invmgr-bom-no-activate");

      await expect(activateBomVersion(invMgr, product.id, v1!.id)).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
