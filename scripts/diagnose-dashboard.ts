// Replays exactly what the dashboard does after login, with timings, and prints the REAL error.
//   $env:ADMIN_PASSWORD = "..."; npx tsx scripts/diagnose-dashboard.ts
import "dotenv/config";
import { login, validateSessionToken } from "../src/server/modules/iam/session-service";
import { getCurrentUserDisplay } from "../src/server/modules/iam/me-service";
import { listJobs } from "../src/server/modules/production/job-service";
import { prisma } from "../src/server/shared/db";

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  const t = Date.now();
  try {
    const v = await fn();
    console.log(`OK    ${name} (${Date.now() - t} ms)`);
    return v;
  } catch (e) {
    console.log(`FAIL  ${name} (${Date.now() - t} ms):`, e instanceof Error ? `${e.name}: ${e.message}` : e);
    return undefined;
  }
}

async function main() {
  const slug = (process.env.ORG_SLUG ?? "willsgrove").toLowerCase();
  const email = (process.env.ADMIN_EMAIL ?? "debtors2@willsgrove.co.zw").toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? "";
  console.log("DB host:", new URL(process.env.RUNTIME_DATABASE_URL!).host);

  await step("raw query (SELECT 1)", () => prisma.$queryRaw`SELECT 1`);
  const res = await step("login", () => login({ organizationSlug: slug, email, password }));
  if (!res) return;
  const session = await step("validateSessionToken", () => validateSessionToken(res.token));
  if (!session) return;
  console.log("   role:", session.role);
  await step("getCurrentUserDisplay (layout)", () => getCurrentUserDisplay(session));
  await step("listJobs (dashboard)", () => listJobs(session, { limit: 5 }));
}

main().finally(() => prisma.$disconnect());