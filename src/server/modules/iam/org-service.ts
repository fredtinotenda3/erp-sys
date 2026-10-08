// Organization bootstrap — the one operation in this module that runs with
// NO authenticated session, because it's what CREATES the first session-
// worthy thing (an org and its first OWNER_ADMIN user) for a brand new
// tenant. Every other function in server/modules/iam/* requires an
// AuthenticatedSession. Deployment note: this endpoint is unauthenticated by
// necessity (akin to a signup form) — if self-service tenant creation isn't
// desired in production, gate app/api/v1/organizations/bootstrap/route.ts
// behind an invite code or an operator-only deployment flag; that's a
// deployment/product decision, not something this service layer should
// assume either way.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma, isUniqueConstraintError } from "../../shared/db";
import { ConflictError, ValidationError } from "../../shared/errors";
import { hashPassword } from "../../shared/password";
import { recordAudit } from "./audit-service";

// Login handle format. Mirrors the CHECK constraint in migration
// 20261008100000_add_organization_slug: 3-50 chars, lowercase letters and
// digits, single hyphens between groups.
export const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "slug must be at least 3 characters")
  .max(50, "slug must be at most 50 characters")
  .regex(SLUG_PATTERN, "slug may only contain lowercase letters, digits, and single hyphens between them");

// Used only when the caller doesn't supply a slug: slugified organization
// name plus a short random suffix, so two orgs with the same name never
// collide and the caller never has to retry.
export function generateSlug(organizationName: string): string {
  const base = organizationName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
    .replace(/-+$/g, "");
  const suffix = randomBytes(3).toString("hex");
  return `${base || "org"}-${suffix}`;
}

const bootstrapSchema = z.object({
  organizationName: z.string().trim().min(2).max(200),
  // Optional: the login handle the owner will type, e.g. "acme-furniture".
  // If omitted a unique one is generated from the name.
  organizationSlug: slugSchema.optional(),
  baseCurrency: z
    .string()
    .trim()
    .toUpperCase()
    .length(3, "baseCurrency must be a 3-letter ISO 4217 code, e.g. USD"),
  firstBranchName: z.string().trim().min(1).max(200).default("Main"),
  ownerEmail: z.string().trim().toLowerCase().email(),
  ownerFullName: z.string().trim().min(1).max(200),
  // 12-char minimum, not OWASP's bare 8-char floor — this account is an
  // OWNER_ADMIN by construction (see below), so it deserves the stricter
  // end of what's reasonable without requiring a dedicated password-policy
  // configuration screen in Phase 1.
  ownerPassword: z.string().min(12).max(200),
});

export interface BootstrapOrganizationResult {
  organizationId: string;
  organizationSlug: string;
  branchId: string;
  ownerUserId: string;
}

export async function bootstrapOrganization(input: unknown): Promise<BootstrapOrganizationResult> {
  const parsed = bootstrapSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid organization bootstrap payload", parsed.error.issues);
  const data = parsed.data;

  const currency = await prisma.currency.findUnique({ where: { code: data.baseCurrency } });
  if (!currency) {
    throw new ValidationError(
      `Unknown currency code "${data.baseCurrency}" — seed it into the currency table first ` +
        "(see SETUP_COMMANDS.md Section 7).",
    );
  }

  // Hashing happens OUTSIDE the transaction: argon2id at the OWASP-minimum
  // parameters (shared/password.ts) takes real wall-clock time by design,
  // and a Postgres transaction holding locks for that long is the wrong
  // trade — better to pay the hashing cost first and keep the transaction
  // itself fast.
  const passwordHash = await hashPassword(data.ownerPassword);

  const slug = data.organizationSlug ?? generateSlug(data.organizationName);
  if (data.organizationSlug) {
    // Friendly early check for a caller-chosen slug; the UNIQUE constraint
    // is still the real guard (the create below also maps a race to the
    // same ConflictError).
    const taken = await prisma.organization.findUnique({ where: { slug }, select: { id: true } });
    if (taken) throw new ConflictError(`The organization handle "${slug}" is already taken`);
  }

  try {
    return await createOrganizationTx(data, slug, passwordHash);
  } catch (err) {
    if (isUniqueConstraintError(err) && data.organizationSlug) {
      throw new ConflictError(`The organization handle "${slug}" is already taken`);
    }
    throw err;
  }
}

async function createOrganizationTx(
  data: z.infer<typeof bootstrapSchema>,
  slug: string,
  passwordHash: string,
): Promise<BootstrapOrganizationResult> {
  return prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: { name: data.organizationName, slug, baseCurrency: data.baseCurrency },
    });

    const branch = await tx.branch.create({
      data: { orgId: org.id, name: data.firstBranchName },
    });

    const owner = await tx.user.create({
      data: {
        orgId: org.id,
        email: data.ownerEmail,
        fullName: data.ownerFullName,
        role: "OWNER_ADMIN",
        passwordHash,
      },
    });

    // OWNER_ADMIN has implicit all-branch access (shared/authz.ts) — no
    // user_branch_access row is created for the owner, by design.

    await recordAudit(tx, {
      orgId: org.id,
      actorUserId: owner.id,
      entityType: "organization",
      entityId: org.id,
      action: "create",
      afterValue: { name: org.name, slug: org.slug, baseCurrency: org.baseCurrency },
      reason: "organization bootstrap",
    });
    await recordAudit(tx, {
      orgId: org.id,
      branchId: branch.id,
      actorUserId: owner.id,
      entityType: "branch",
      entityId: branch.id,
      action: "create",
      afterValue: { name: branch.name },
      reason: "organization bootstrap",
    });
    await recordAudit(tx, {
      orgId: org.id,
      actorUserId: owner.id,
      entityType: "app_user",
      entityId: owner.id,
      action: "create",
      afterValue: { email: owner.email, role: owner.role },
      reason: "organization bootstrap",
    });

    return { organizationId: org.id, organizationSlug: org.slug, branchId: branch.id, ownerUserId: owner.id };
  });
}
