// Fixtures for the Production test suites. Real Postgres, same approach as
// the IAM/catalog suites: every test org is fresh and random, no cleanup
// (audit rows make orgs undeletable by design -- see iam test-helpers.ts).
import { createUser } from "../../iam/user-service";
import { loginAs, testEmail, TEST_PASSWORD, type TestOrg } from "../../iam/__tests__/test-helpers";
import { createItem } from "../../catalog/item-service";
import { createBomVersion, activateBomVersion } from "../../catalog/bom-service";
import type { AuthenticatedSession } from "../../iam/session-service";
import type { Role } from "../../../shared/authz";

export async function sessionWithRole(
  owner: AuthenticatedSession,
  orgId: string,
  role: Role,
  label: string,
  branchIds: string[] = [],
): Promise<AuthenticatedSession> {
  const email = testEmail(label);
  await createUser(owner, { email, fullName: label, role, password: TEST_PASSWORD, branchIds });
  const { session } = await loginAs(orgId, email);
  return session;
}

export interface MaterialSpec {
  /** Item uom. */
  uom?: string;
  standardCost?: number;
  standardCostCurrency?: string;
  /** Quantity per ONE unit of product, in the BOM. */
  bomQty: number;
  /** BOM line uom; defaults to the item's uom. Set differently to force a unit mismatch. */
  bomUom?: string;
}

let skuCounter = 0;
function sku(prefix: string): string {
  skuCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${skuCounter}`;
}

/** Creates a finished good plus materials and an ACTIVE BOM. */
export async function productWithActiveBom(owner: AuthenticatedSession, materials: MaterialSpec[]) {
  const product = await createItem(owner, { sku: sku("PROD"), itemType: "finished_good", name: "Test product", uom: "ea" });
  const materialItems: Awaited<ReturnType<typeof createItem>>[] = [];
  for (const m of materials) {
    materialItems.push(
      await createItem(owner, {
        sku: sku("MAT"),
        itemType: "raw_material",
        name: "Test material",
        uom: m.uom ?? "kg",
        ...(m.standardCost !== undefined ? { standardCost: m.standardCost, standardCostCurrency: m.standardCostCurrency } : {}),
      }),
    );
  }
  const bom = await createBomVersion(owner, product.id, {
    lines: materials.map((m, i) => ({ materialItemId: materialItems[i].id, quantity: m.bomQty, uom: m.bomUom ?? m.uom ?? "kg" })),
  });
  await activateBomVersion(owner, product.id, bom!.id);
  return { product, materialItems, bom: bom! };
}

export function mainBranch(org: TestOrg): string {
  return org.branchId;
}
