// Creates the first organization + OWNER_ADMIN, OR (if the organization already exists)
// verifies the login and can repair/reset the admin account. Safe to re-run.
//
//   PowerShell:
//     $env:ADMIN_PASSWORD = "<12+ chars>"
//     $env:ADMIN_EMAIL    = "debtors2@willsgrove.co.zw"
//     npx tsx scripts/create-admin.ts
//
//   Repair an existing account (reset password, force OWNER_ADMIN, reactivate, grant all branches):
//     $env:RESET_ADMIN = "1"
//     npx tsx scripts/create-admin.ts
import "dotenv/config";
import { bootstrapOrganization } from "../src/server/modules/iam/org-service";
import { login } from "../src/server/modules/iam/session-service";
import { hashPassword } from "../src/server/shared/password";
import { prisma } from "../src/server/shared/db";

async function main() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error("Set ADMIN_PASSWORD (at least 12 characters) before running this script.");
  }
  const slug = (process.env.ORG_SLUG ?? "stanleyverse").trim().toLowerCase();
  const email = (process.env.ADMIN_EMAIL ?? "fredtinotenda@gmail.com").trim().toLowerCase();

  const org = await prisma.organization.findUnique({ where: { slug }, select: { id: true, name: true } });

  if (!org) {
    const result = await bootstrapOrganization({
      organizationName: process.env.ORG_NAME ?? "StanleyVerse",
      organizationSlug: slug,
      baseCurrency: process.env.BASE_CURRENCY ?? "USD",
      firstBranchName: process.env.BRANCH_NAME ?? "Main",
      ownerEmail: email,
      ownerFullName: process.env.ADMIN_NAME ?? "Stanley",
      ownerPassword: password,
    });
    await login({ organizationSlug: result.organizationSlug, email, password });
    console.log("\nOrganization + admin created and login verified.");
    return;
  }

  console.log(`Organization "${slug}" already exists (${org.name}) — not creating it again.`);

  const branches = await prisma.branch.findMany({ where: { orgId: org.id }, select: { id: true, name: true, isActive: true } });
  console.log("Branches:", branches.length ? branches.map((b) => b.name).join(", ") : "NONE");

  const user = await prisma.user.findFirst({ where: { orgId: org.id, email } });
  console.log(
    user
      ? `User ${email}: role=${user.role} active=${user.isActive}`
      : `User ${email}: DOES NOT EXIST in this organization`,
  );

  if (process.env.RESET_ADMIN === "1") {
    const passwordHash = await hashPassword(password);
    const fixed = user
      ? await prisma.user.update({ where: { id: user.id }, data: { passwordHash, role: "OWNER_ADMIN", isActive: true } })
      : await prisma.user.create({
          data: { orgId: org.id, email, passwordHash, fullName: process.env.ADMIN_NAME ?? "Wills Grove Admin", role: "OWNER_ADMIN", isActive: true },
        });
    console.log(`Repaired ${fixed.email}: OWNER_ADMIN, active, password reset.`);
  }

  try {
    const r = await login({ organizationSlug: slug, email, password });
    console.log(`\nLogin OK. role=${r.session.role}. Use these on the login page:`);
    console.log(`  Organization: ${slug}\n  Email: ${email}`);
  } catch (e) {
    console.log("\nLogin FAILED:", e instanceof Error ? e.message : e);
    console.log("Re-run with $env:RESET_ADMIN = \"1\" to repair the account.");
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());