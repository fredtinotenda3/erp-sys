import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { bootstrapOrganization, generateSlug } from "../org-service";
import { login } from "../session-service";
import { prisma } from "../../../shared/db";
import { ConflictError, UnauthorizedError, ValidationError } from "../../../shared/errors";
import { hasCapability, ROLE_VALUES } from "../../../shared/authz";
import { TEST_PASSWORD, testEmail, uniqueSuffix } from "./test-helpers";

function bootstrapInput(slug: string | undefined, label: string) {
  return {
    organizationName: `Slug Test ${label} ${uniqueSuffix()}`,
    organizationSlug: slug,
    baseCurrency: "USD",
    ownerEmail: testEmail(`${label}.owner`),
    ownerFullName: `${label} Owner`,
    ownerPassword: TEST_PASSWORD,
  };
}

describe("organization slug (login handle)", () => {
  it("uses a caller-supplied slug and returns it", async () => {
    const slug = `acme-${uniqueSuffix()}`;
    const input = bootstrapInput(slug, "supplied");
    const result = await bootstrapOrganization(input);
    expect(result.organizationSlug).toBe(slug);
    const row = await prisma.organization.findUnique({ where: { id: result.organizationId } });
    expect(row?.slug).toBe(slug);
  });

  it("generates a unique slug from the name when none is supplied", async () => {
    const a = await bootstrapOrganization(bootstrapInput(undefined, "genA"));
    const b = await bootstrapOrganization(bootstrapInput(undefined, "genB"));
    expect(a.organizationSlug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(a.organizationSlug).not.toBe(b.organizationSlug);
  });

  it("generateSlug handles names with no usable characters", () => {
    expect(generateSlug("!!!")).toMatch(/^org-[0-9a-f]{6}$/);
    expect(generateSlug("Chido Furnishings (Pvt) Ltd")).toMatch(/^chido-furnishings-pvt-ltd-[0-9a-f]{6}$/);
  });

  it("rejects malformed slugs", async () => {
    for (const bad of ["ab", "Has Space", "-leading", "trailing-", "double--hyphen", "UPPER_case!", "x".repeat(51)]) {
      await expect(bootstrapOrganization(bootstrapInput(bad, "bad"))).rejects.toBeInstanceOf(ValidationError);
    }
  });

  it("rejects a duplicate slug with ConflictError", async () => {
    const slug = `dup-${uniqueSuffix()}`;
    await bootstrapOrganization(bootstrapInput(slug, "dup1"));
    await expect(bootstrapOrganization(bootstrapInput(slug, "dup2"))).rejects.toBeInstanceOf(ConflictError);
  });

  it("logs in by slug + email + password", async () => {
    const slug = `login-${uniqueSuffix()}`;
    const input = bootstrapInput(slug, "loginSlug");
    const org = await bootstrapOrganization(input);
    const { session } = await login({ organizationSlug: slug, email: input.ownerEmail, password: TEST_PASSWORD });
    expect(session.orgId).toBe(org.organizationId);
  });

  it("treats the slug case-insensitively at login", async () => {
    const slug = `casey-${uniqueSuffix()}`;
    const input = bootstrapInput(slug, "case");
    await bootstrapOrganization(input);
    const { session } = await login({ organizationSlug: slug.toUpperCase(), email: input.ownerEmail, password: TEST_PASSWORD });
    expect(session.userId).toBeTruthy();
  });

  it("an unknown slug fails with the SAME error as a wrong password (no handle enumeration)", async () => {
    await expect(
      login({ organizationSlug: `nope-${uniqueSuffix()}`, email: testEmail("x"), password: TEST_PASSWORD }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("org A's slug cannot be used with org B's credentials", async () => {
    const slugA = `orga-${uniqueSuffix()}`;
    const slugB = `orgb-${uniqueSuffix()}`;
    await bootstrapOrganization(bootstrapInput(slugA, "A"));
    const inputB = bootstrapInput(slugB, "B");
    await bootstrapOrganization(inputB);
    await expect(
      login({ organizationSlug: slugA, email: inputB.ownerEmail, password: TEST_PASSWORD }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it("requires exactly one of organizationSlug / organizationId", async () => {
    await expect(login({ email: testEmail("y"), password: TEST_PASSWORD })).rejects.toBeInstanceOf(ValidationError);
    await expect(
      login({ organizationSlug: "abc", organizationId: randomUUID(), email: testEmail("z"), password: TEST_PASSWORD }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("organizationId login still works (internal callers / existing tests)", async () => {
    const input = bootstrapInput(undefined, "byId");
    const org = await bootstrapOrganization(input);
    const { session } = await login({ organizationId: org.organizationId, email: input.ownerEmail, password: TEST_PASSWORD });
    expect(session.orgId).toBe(org.organizationId);
  });
});

describe("quality:read capability", () => {
  it("is held by every role", () => {
    for (const role of ROLE_VALUES) expect(hasCapability(role, "quality:read")).toBe(true);
  });
});
