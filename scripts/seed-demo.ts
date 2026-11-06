// DEMO SEED for "Mavuno Packaging Industries (Pvt) Ltd" -- a fictional
// Zimbabwean rigid-plastic packaging manufacturer, built to showcase the
// plastics-manufacturing vertical end to end. NEVER for production.
//
// Unlike scripts/seed-dev.ts (which logs into an org that already exists),
// this script BOOTSTRAPS a brand-new organization on its first run. Re-running
// it is safe: every record is found by its business key first, so nothing is
// duplicated, and the owner/demo-user passwords you set are only used to
// create the accounts (or, on a later run, to log back into them) -- they
// are never written to any file or logged.
//
//   PowerShell (dry run first; it writes nothing):
//     npm run seed:demo
//   then confirm the target it prints, set both passwords, and apply:
//     $env:OPERIS_DEV_SEED_TARGET   = "<database>@<host>"   # copied from the dry run
//     $env:OPERIS_DEMO_OWNER_PASSWORD = "<12+ chars for the Owner/Administrator account>"
//     $env:OPERIS_DEMO_PASSWORD       = "<12+ chars shared by the other 7 demo users>"
//     npm run seed:demo -- --apply
//
// This reuses checkSeedSafety (seed-guard.ts) UNMODIFIED -- the same
// never-run-against-production guard scripts/seed-dev.ts already relies on,
// including its explicit OPERIS_DEV_SEED_TARGET confirmation step. The demo
// seed does not introduce a second, weaker safety gate.
import "dotenv/config";
import { checkSeedSafety } from "../src/server/dev/seed-guard";
import { planMavunoSeed, seedMavunoDemo, type SeedReport } from "../src/server/dev/seed-demo";
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

  const guard = checkSeedSafety(process.env);
  console.log(`Target database: ${guard.target ?? "(unreadable)"}`);
  if (!guard.ok) {
    console.error("\nRefusing to seed:");
    for (const p of guard.problems) console.error(`  - ${p}`);
    const onlyConfirmation = guard.problems.length === 1 && guard.problems[0]!.startsWith("Confirmation required");
    if (!(onlyConfirmation && !apply)) { process.exitCode = 1; return; }
  }

  if (!apply || !guard.ok) {
    const { organizationExists, report } = await planMavunoSeed();
    console.log(`\nOrganization "mavuno-packaging": ${organizationExists ? "already exists" : "does not exist yet"}`);
    print("Would create (dry run, nothing written)", report);
    console.log(
      `\nTo apply, set OPERIS_DEV_SEED_TARGET=${guard.target}, OPERIS_DEMO_OWNER_PASSWORD and OPERIS_DEMO_PASSWORD, then run: npm run seed:demo -- --apply`,
    );
    return;
  }

  const ownerPassword = process.env.OPERIS_DEMO_OWNER_PASSWORD;
  const userPassword = process.env.OPERIS_DEMO_PASSWORD;
  if (!ownerPassword || ownerPassword.length < 12) throw new Error("Set OPERIS_DEMO_OWNER_PASSWORD (at least 12 characters) for the Owner/Administrator demo account.");
  if (!userPassword || userPassword.length < 12) throw new Error("Set OPERIS_DEMO_PASSWORD (at least 12 characters) for the other 7 demo users.");

  const { organizationSlug, report } = await seedMavunoDemo({ ownerPassword, userPassword, log: (m) => console.log(`  + ${m}`) });
  print("Seed complete", report);
  console.log(`\nOrganization handle: ${organizationSlug}`);
  console.log("Demo logins:");
  console.log("  owner@mavunopackaging.test                      (Owner / Administrator)   -- OPERIS_DEMO_OWNER_PASSWORD");
  console.log("  production.manager@mavunopackaging.test         (Production Manager)       -- OPERIS_DEMO_PASSWORD");
  console.log("  purchasing@mavunopackaging.test                 (Purchasing Officer)       -- OPERIS_DEMO_PASSWORD");
  console.log("  warehouse@mavunopackaging.test                  (Warehouse Manager)        -- OPERIS_DEMO_PASSWORD");
  console.log("  supervisor@mavunopackaging.test                 (Production Supervisor)    -- OPERIS_DEMO_PASSWORD");
  console.log("  operator@mavunopackaging.test                   (Machine Operator)         -- OPERIS_DEMO_PASSWORD");
  console.log("  quality@mavunopackaging.test                    (Quality Inspector)        -- OPERIS_DEMO_PASSWORD");
  console.log("  sales@mavunopackaging.test                      (Sales and Dispatch Officer) -- OPERIS_DEMO_PASSWORD");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());