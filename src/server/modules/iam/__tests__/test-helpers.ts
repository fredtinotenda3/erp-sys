// Shared fixtures for the IAM isolation test suite. These tests run against
// a REAL local PostgreSQL database (see vitest.setup.ts) — not a mock, not
// an in-memory substitute — because the invariants under test (tenant
// isolation, branch isolation, session revocation) are enforced partly by
// this module's code and partly by the real schema (composite FKs, unique
// constraints), and only a real database exercises both at once.
//
// NO CLEANUP / NO afterEach(): this is intentional, not an oversight. Once
// an organization has any audit_log row (bootstrap always creates three —
// see org-service.ts), it can never be deleted: audit_log.org_id ->
// organization(id) is ON DELETE RESTRICT (docs/schema.sql), and the
// immutability trigger on audit_log blocks deleting the audit rows
// themselves even as the table owner (verified during Phase 0 — see
// ARCHITECTURE.md Phase 0 Addendum). That is the intended behavior of an
// audit trail that must outlive the entities it describes, not a test-suite
// problem to work around. Every test below instead generates a fresh,
// random organization/branch/email per test via uniqueSuffix()/testEmail(),
// so tests never collide with each other or with a previous run. Your dev
// database will accumulate test organizations over time; periodically
// drop/recreate it (SETUP_COMMANDS.md) if that matters to you — do not
// disable the immutability trigger to "fix" this, that would defeat the
// exact guarantee this suite exists to prove.
import { randomUUID } from "node:crypto";
import { bootstrapOrganization } from "../org-service";
import { login } from "../session-service";
import type { AuthenticatedSession } from "../session-service";

// 12+ chars to satisfy both org-service's and user-service's password
// minimum. Test-only constant — never reused outside this suite.
export const TEST_PASSWORD = "Test-Passw0rd-12345!";

// Must already be seeded in the target database — see SETUP_COMMANDS.md
// Section 7. If it isn't, every test below fails fast with a clear
// ValidationError ("Unknown currency code"), not a confusing downstream
// error, which is the correct failure mode for a missing precondition.
const TEST_CURRENCY = "USD";

export function uniqueSuffix(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

export function testEmail(label: string): string {
  return `${label}.${uniqueSuffix()}@test.mops.invalid`;
}

export interface TestOrg {
  organizationId: string;
  branchId: string;
  ownerUserId: string;
  ownerEmail: string;
}

export async function createTestOrg(label: string): Promise<TestOrg> {
  const ownerEmail = testEmail(`${label}.owner`);
  const result = await bootstrapOrganization({
    organizationName: `Test Org ${label} ${uniqueSuffix()}`,
    baseCurrency: TEST_CURRENCY,
    firstBranchName: "Main",
    ownerEmail,
    ownerFullName: `${label} Owner`,
    ownerPassword: TEST_PASSWORD,
  });
  return { ...result, ownerEmail };
}

export async function loginAs(organizationId: string, email: string, password: string = TEST_PASSWORD) {
  return login({ organizationId, email, password });
}

export async function ownerSession(org: TestOrg): Promise<AuthenticatedSession> {
  const { session } = await loginAs(org.organizationId, org.ownerEmail);
  return session;
}
