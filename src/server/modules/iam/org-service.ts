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
import { z } from "zod";
import { prisma } from "../../shared/db";
import { ValidationError } from "../../shared/errors";
import { hashPassword } from "../../shared/password";
import { recordAudit } from "./audit-service";

const bootstrapSchema = z.object({
  organizationName: z.string().trim().min(2).max(200),
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

  return prisma.$transaction(async (tx) => {
    const org = await tx.organization.create({
      data: { name: data.organizationName, baseCurrency: data.baseCurrency },
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
      afterValue: { name: org.name, baseCurrency: org.baseCurrency },
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

    return { organizationId: org.id, branchId: branch.id, ownerUserId: owner.id };
  });
}
