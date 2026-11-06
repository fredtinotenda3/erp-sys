// Milestone 5 (Configurable Industry Architecture): the one place an
// organization's industry profile is read and changed. Reading is NOT
// capability-gated -- every authenticated session needs its own org's
// current profile to render the app shell (terminology, which nav entries
// to show), the same "every role needs this" reasoning
// iam/me-service.ts already documents for orgName; see that file, which
// surfaces this via GET /auth/me so the frontend never has to make a
// second call just to find out what profile it's rendering for.
// CHANGING the profile is the one privileged operation here
// (industry_profile:manage, OWNER_ADMIN only -- mandate §7: "Do not permit
// arbitrary users to change an organisation's manufacturing configuration").
import { z } from "zod";
import { prisma } from "../../shared/db";
import { assertCapability } from "../../shared/authz";
import { ValidationError } from "../../shared/errors";
import { recordAudit } from "../iam/audit-service";
import type { AuthenticatedSession } from "../iam/session-service";
import {
  INDUSTRY_PROFILE_VALUES,
  PROFILE_REGISTRY,
  type IndustryProfileKey,
  getProfileDefinition,
  getTerminology,
  isValidModuleForProfile,
} from "./profile-registry";

export interface OrganizationIndustryProfile {
  industryProfile: IndustryProfileKey;
  enabledModules: string[];
  isImplemented: boolean;
  terminology: Record<string, string>;
}

async function loadOrgProfile(orgId: string): Promise<{ industryProfile: IndustryProfileKey; industryProfileModules: unknown }> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { industryProfile: true, industryProfileModules: true } });
  // Mirrors me-service.ts's own reasoning: a miss here means the session's
  // own org row no longer resolves, not an ordinary "not found" -- there is
  // no sensible partial result, so this is a hard failure.
  if (!org) throw new Error("Authenticated session refers to an organization that no longer resolves");
  return org;
}

function toModuleList(raw: unknown): string[] {
  // industry_profile_modules is DB-constrained to always be a JSON array
  // (see the migration's CHECK), so this cast is safe; defensively falls
  // back to [] rather than throwing if it somehow isn't, since this is a
  // read path every session hits.
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

/** Every authenticated session's own org profile -- no capability check (see file header). */
export async function getIndustryProfile(session: AuthenticatedSession): Promise<OrganizationIndustryProfile> {
  const org = await loadOrgProfile(session.orgId);
  const enabledModules = toModuleList(org.industryProfileModules);
  return {
    industryProfile: org.industryProfile,
    enabledModules,
    isImplemented: getProfileDefinition(org.industryProfile).isImplemented,
    terminology: getTerminology(org.industryProfile),
  };
}

/** The full registry, for the admin screen's profile picker -- not org-specific, no capability check (static, non-sensitive data). */
export function listIndustryProfiles() {
  return INDUSTRY_PROFILE_VALUES.map((key) => {
    const def = PROFILE_REGISTRY[key];
    return { key: def.key, label: def.label, description: def.description, isImplemented: def.isImplemented, availableModules: def.implementedModules };
  });
}

const updateSchema = z.object({
  industryProfile: z.enum(INDUSTRY_PROFILE_VALUES),
  enabledModules: z.array(z.string()).max(50).default([]),
  reason: z.string().trim().max(500).optional(),
});

export async function updateIndustryProfile(session: AuthenticatedSession, input: unknown): Promise<OrganizationIndustryProfile> {
  assertCapability(session.role, "industry_profile:manage");
  const parsed = updateSchema.safeParse(input);
  if (!parsed.success) throw new ValidationError("Invalid industry profile payload", parsed.error.issues);
  const d = parsed.data;

  const invalidModules = d.enabledModules.filter((m) => !isValidModuleForProfile(d.industryProfile, m));
  if (invalidModules.length > 0) {
    throw new ValidationError(
      `These modules are not available under the "${d.industryProfile}" profile: ${invalidModules.join(", ")}`,
    );
  }
  // Deduplicate defensively -- a caller resubmitting the same module twice
  // should never be able to make the stored array grow without bound.
  const enabledModules = [...new Set(d.enabledModules)];

  const before = await loadOrgProfile(session.orgId);
  const beforeModules = toModuleList(before.industryProfileModules);

  await prisma.$transaction(async (tx) => {
    await tx.organization.update({
      where: { id: session.orgId },
      data: { industryProfile: d.industryProfile, industryProfileModules: enabledModules },
    });
    // Reuses the existing generic AuditLog, same convention as every other
    // module (iam/audit-service.ts) -- no bespoke "industry profile change
    // log" table, exactly the "avoid abstraction with no immediate business
    // value" principle the mandate asks for here specifically.
    await recordAudit(tx, {
      orgId: session.orgId,
      actorUserId: session.userId,
      entityType: "organization",
      entityId: session.orgId,
      action: "update",
      beforeValue: { industryProfile: before.industryProfile, enabledModules: beforeModules },
      afterValue: { industryProfile: d.industryProfile, enabledModules },
      reason: d.reason ?? null,
    });
  });

  return {
    industryProfile: d.industryProfile,
    enabledModules,
    isImplemented: getProfileDefinition(d.industryProfile).isImplemented,
    terminology: getTerminology(d.industryProfile),
  };
}

/**
 * The real enforcement point for every Milestone 6 (plastics) WRITE path --
 * never a UI-only gate. READ paths for plastics data never call this (see
 * the schema.prisma "MILESTONE 6" comment block): an organization that
 * switches away from the plastics profile keeps its historical plastics
 * data fully visible, it just can't create or change any more of it until
 * it switches back. Deliberately does not check industryProfileModules --
 * Milestone 6 is a single cohesive extension once the profile itself is
 * "plastics" (it is its own implemented-modules list in the registry for
 * documentation/UI purposes, not a further per-feature gate here).
 */
export async function assertPlasticsProfileActive(session: AuthenticatedSession): Promise<void> {
  const org = await loadOrgProfile(session.orgId);
  if (org.industryProfile !== "plastics") {
    throw new ValidationError(
      `This organization's industry profile is "${org.industryProfile}", not "plastics" -- switch it under Settings before using plastics-specific features.`,
    );
  }
}
