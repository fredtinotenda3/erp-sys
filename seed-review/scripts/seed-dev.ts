// DEVELOPMENT / TEST SEED -- never for production.
//
//   PowerShell (dry run first; it writes nothing and prints the target to confirm):
//     $env:SEED_ORG_SLUG       = "<existing org handle>"
//     $env:SEED_ADMIN_EMAIL    = "<that org's OWNER_ADMIN email>"
//     $env:SEED_ADMIN_PASSWORD = "<that admin's password>"
//     npm run seed:dev
//   then confirm the target it prints, set the user password, and apply:
//     $env:OPERIS_DEV_SEED_TARGET = "<database>@<host>"     # copied from the dry run
//     $env:SEED_USER_PASSWORD     = "<12+ chars for the demo users>"
//     npm run seed:dev -- --apply            (add --no-jobs to skip the two sample jobs)
//
// It signs in as the org's real OWNER_ADMIN (real authentication, no backdoor) and
// calls the application's own services. Re-running is safe: existing records are
// found by business key and left alone. It never deletes or resets anything.
import "dotenv/config";
import { checkSeedSafety } from "../src/server/dev/seed-guard";
import { planDevSeed, seedDevData, type SeedReport } from "../src/server/dev/seed-dev";
import { login } from "../src/server/modules/iam/session-service";
import { prisma } from "../src/server/shared/db";

const fmt = (o: Record<string, number>) => (Object.keys(o).length ? Object.entries(o).map(([k, v]) => `${k}: ${v}`).join(", ") : "none");
function print(title: string, r: SeedReport) {
  console.log(`\n${title}`);
  console.log(`  ${title.startsWith("Would") ? "would create" : "created"} : ${fmt(r.created)}`);
  console.log(`  already there: ${fmt(r.existing)}`);
  for (const w of r.warnings) console.log(`  WARNING: ${w}`);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const withJobs = !process.argv.includes("--no-jobs");

  const guard = checkSeedSafety(process.env);
  console.log(`Target database: ${guard.target ?? "(unreadable)"}`);
  if (!guard.ok) {
    console.error("\nRefusing to seed:");
    for (const p of guard.problems) console.error(`  - ${p}`);
    // A dry run is still useful before confirming, but only the confirmation line may be missing.
    const onlyConfirmation = guard.problems.length === 1 && guard.problems[0]!.startsWith("Confirmation required");
    if (!(onlyConfirmation && !apply)) { process.exitCode = 1; return; }
  }

  const slug = process.env.SEED_ORG_SLUG;
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!slug || !email || !password) throw new Error("Set SEED_ORG_SLUG, SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (the existing organization's owner/admin; create one with `npm run create-admin` if none exists).");

  const { session } = await login({ organizationSlug: slug, email, password });
  if (session.role !== "OWNER_ADMIN") throw new Error("SEED_ADMIN_EMAIL must be an OWNER_ADMIN of the organization.");
  const branches = await prisma.branch.findMany({ where: { orgId: session.orgId }, orderBy: { createdAt: "asc" } });
  const wanted = process.env.SEED_BRANCH_NAME;
  const branch = wanted ? branches.find((b) => b.name === wanted) : branches[0];
  if (!branch) throw new Error(wanted ? `No branch named "${wanted}" in this organization.` : "The organization has no branch.");
  console.log(`Organization: ${slug} | Branch: ${branch.name}`);

  if (!apply || !guard.ok) {
    print("Would create (dry run, nothing written)", await planDevSeed({ orgId: session.orgId, branchId: branch.id, withJobs }));
    console.log(`\nTo apply, set OPERIS_DEV_SEED_TARGET=${guard.target} and SEED_USER_PASSWORD, then run: npm run seed:dev -- --apply`);
    return;
  }

  const userPassword = process.env.SEED_USER_PASSWORD;
  if (!userPassword || userPassword.length < 12) throw new Error("Set SEED_USER_PASSWORD (at least 12 characters) for the demo users.");
  const report = await seedDevData({ session, branchId: branch.id, userPassword, withJobs, log: (m) => console.log(`  + ${m}`) });
  print("Seed complete", report);
  console.log("\nDemo logins: <role>@operis.test with SEED_USER_PASSWORD (manager, operator, finance, inventory, viewer).");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
