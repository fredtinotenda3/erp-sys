// Creates the first organization, its first branch and an OWNER_ADMIN login.
// Run once per organization:
//
//   PowerShell:
//     $env:ADMIN_PASSWORD = "<12+ chars>"
//     npx tsx scripts/create-admin.ts
//
// Everything else comes from optional env vars (defaults below). The password
// is read from the environment so it never lands in a file or in shell history
// of the script. Uses the same service the API uses (bootstrapOrganization), so
// the audit log and org/branch/user rows are created exactly as in production.
import "dotenv/config";
import { bootstrapOrganization } from "../src/server/modules/iam/org-service";
import { login } from "../src/server/modules/iam/session-service";
import { prisma } from "../src/server/shared/db";

async function main() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error("Set ADMIN_PASSWORD (at least 12 characters) before running this script.");
  }
  const input = {
    organizationName: process.env.ORG_NAME ?? "Wills Grove",
    organizationSlug: process.env.ORG_SLUG ?? "willsgrove",
    baseCurrency: process.env.BASE_CURRENCY ?? "USD",
    firstBranchName: process.env.BRANCH_NAME ?? "Main",
    ownerEmail: process.env.ADMIN_EMAIL ?? "debtors2@willsgrove.co.zw",
    ownerFullName: process.env.ADMIN_NAME ?? "Wills Grove Admin",
    ownerPassword: password,
  };
  const result = await bootstrapOrganization(input);
  // Prove the credentials work end to end.
  await login({ organizationSlug: result.organizationSlug, email: input.ownerEmail, password });
  console.log("\nAdmin created and login verified.\n");
  console.log("  Organization handle :", result.organizationSlug);
  console.log("  Email               :", input.ownerEmail.toLowerCase());
  console.log("  Role                : OWNER_ADMIN");
  console.log("  (password: the ADMIN_PASSWORD you set)\n");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
