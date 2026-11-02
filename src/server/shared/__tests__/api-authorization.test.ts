/* eslint-disable @typescript-eslint/no-explicit-any */
// Route-level boundary tests: these call the real Next route handlers (not the services) so they
// catch a handler that reads its body, or touches data, BEFORE authenticating.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { SESSION_COOKIE_NAME } from "../http";
import { createTestOrg, loginAs, ownerSession, testEmail, TEST_PASSWORD } from "../../modules/iam/__tests__/test-helpers";
import { createUser, deactivateUser } from "../../modules/iam/user-service";
import { createBranch } from "../../modules/iam/branch-service";
import { productWithActiveBom } from "../../modules/production/__tests__/production-helpers";
import { createJob } from "../../modules/production/job-service";
import { GET as jobCostsExport } from "../../../../app/api/v1/reports/job-costs/export/route";
import { GET as profitabilityExport } from "../../../../app/api/v1/reports/profitability/export/route";
import { GET as auditLogGet } from "../../../../app/api/v1/audit-log/route";

const API_ROOT = join(process.cwd(), "app", "api", "v1");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
// Routes that are public ON PURPOSE. Anything not listed here must answer 401 without a session.
// logout is idempotent and only acts on the caller's own cookie; organizations/bootstrap is gated by its
// own token + rate limit (tested below).
const PUBLIC_ROUTES = new Set(["auth/login", "auth/logout", "auth/password-reset/request", "auth/password-reset/confirm", "health", "organizations/bootstrap"]);

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? routeFiles(full) : name === "route.ts" ? [full] : [];
  });
}
const routeName = (file: string) => relative(API_ROOT, file).split(sep).slice(0, -1).join("/");
const fakeId = "00000000-0000-4000-8000-000000000000";
const call = (handler: any, method: string, cookie?: string) => {
  const req = new NextRequest("http://localhost/api/x", {
    method,
    headers: cookie ? { cookie: `${SESSION_COOKIE_NAME}=${cookie}`, "content-type": "application/json" } : { "content-type": "application/json" },
    ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify({}) }),
  });
  return handler(req, { params: Promise.resolve({ id: fakeId, jobId: fakeId, stageId: fakeId, userId: fakeId }) });
};

describe("every API route requires a valid session unless it is deliberately public", () => {
  const files = routeFiles(API_ROOT);

  it("discovers the route set (guards against the sweep silently testing nothing)", () => {
    expect(files.length).toBeGreaterThan(40);
    for (const p of PUBLIC_ROUTES) expect(files.map(routeName)).toContain(p);
  });

  it("answers 401 with no cookie, and 401 with a forged cookie, on every non-public handler", async () => {
    const failures: string[] = [];
    let checked = 0;
    for (const file of files) {
      const name = routeName(file);
      if (PUBLIC_ROUTES.has(name)) continue;
      const mod = await import(pathToFileURL(file).href);
      for (const m of METHODS) {
        if (typeof mod[m] !== "function") continue;
        checked++;
        for (const cookie of [undefined, "forged-token-value"]) {
          const res: Response = await call(mod[m], m, cookie);
          if (res.status !== 401) failures.push(`${m} /${name} ${cookie ? "(forged cookie)" : "(no cookie)"} -> ${res.status}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(40);
    expect(failures).toEqual([]);
  });

  it("public routes expose nothing sensitive to an anonymous caller", async () => {
    const login = await import(pathToFileURL(join(API_ROOT, "auth/login/route.ts")).href);
    const res: Response = await call(login.POST, "POST");
    expect(res.status).toBe(400); // payload validation, not a stack trace
    expect(JSON.stringify(await res.json())).not.toMatch(/at .*\.ts|prisma|SELECT/i);
  });
});

describe("a deactivated user's old cookie is refused by the HTTP layer", () => {
  it("returns 401 after deactivation", async () => {
    const org = await createTestOrg("api-deact");
    const owner = await ownerSession(org);
    const email = testEmail("d");
    const user = await createUser(owner, { email, fullName: "D", role: "VIEWER", password: TEST_PASSWORD, branchIds: [org.branchId] });
    const { token } = await loginAs(org.organizationId, email);
    expect((await call(auditLogGet, "GET", token)).status).toBe(403); // signed in, but a viewer may not read the audit log
    await deactivateUser(owner, user.id);
    expect((await call(auditLogGet, "GET", token)).status).toBe(401);
  });
});

describe("cross-branch access through reports, exports and the audit log", () => {
  it("shows a branch-limited manager only their own branch, and refuses the other branch by id", async () => {
    const org = await createTestOrg("api-branch");
    const owner = await ownerSession(org);
    const other = await createBranch(owner, { name: `Other ${Date.now()}` });
    const { product } = await productWithActiveBom(owner, [{ uom: "kg", standardCost: 2, standardCostCurrency: "USD", bomQty: 1 }]);
    const mine = (await createJob(owner, { branchId: org.branchId, productItemId: product.id, plannedQty: 1 })) as any;
    const theirs = (await createJob(owner, { branchId: other.id, productItemId: product.id, plannedQty: 1 })) as any;

    const email = testEmail("fin");
    await createUser(owner, { email, fullName: "Fin", role: "FINANCE_MANAGER", password: TEST_PASSWORD, branchIds: [org.branchId] });
    const { token } = await loginAs(org.organizationId, email);

    const csv = await (await call(jobCostsExport, "GET", token)).text();
    expect(csv).toContain(mine.jobNumber);
    expect(csv).not.toContain(theirs.jobNumber);

    const probe = (handler: any, qs: string) =>
      handler(new NextRequest(`http://localhost/api/x?${qs}`, { headers: { cookie: `${SESSION_COOKIE_NAME}=${token}` } }));
    expect((await probe(jobCostsExport, `branchId=${other.id}`)).status).toBe(403);
    expect((await probe(profitabilityExport, `branchId=${other.id}`)).status).toBe(403);
    expect((await probe(auditLogGet, `branchId=${other.id}`)).status).toBe(403);
    expect((await probe(jobCostsExport, "branchId=not-a-uuid")).status).toBeGreaterThanOrEqual(400);

    // The owner sees both, so the filter above is doing real work.
    const ownerToken = (await loginAs(org.organizationId, org.ownerEmail)).token;
    const ownerCsv = await (await call(jobCostsExport, "GET", ownerToken)).text();
    expect(ownerCsv).toContain(theirs.jobNumber);
  });
});

describe("organization bootstrap is not an open door in production", () => {
  afterEach(() => vi.unstubAllEnvs());
  const post = async (headers: Record<string, string> = {}) => {
    const { POST } = await import("../../../../app/api/v1/organizations/bootstrap/route");
    return POST(new NextRequest("http://localhost/api/v1/organizations/bootstrap", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 250)}-${randomUUID().slice(0, 6)}`, ...headers }, body: "{}" }));
  };

  it("is disabled (404) in production when no token is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ORG_BOOTSTRAP_TOKEN", "");
    expect((await post()).status).toBe(404);
  });

  it("requires the exact token when one is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ORG_BOOTSTRAP_TOKEN", "correct-horse-battery-staple");
    expect((await post()).status).toBe(403);
    expect((await post({ "x-bootstrap-token": "wrong" })).status).toBe(403);
    expect((await post({ "x-bootstrap-token": "correct-horse-battery-staple" })).status).toBe(400); // passes the gate; empty body then fails validation
  });

  it("is rate limited per address", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ORG_BOOTSTRAP_TOKEN", "");
    const headers = { "x-forwarded-for": `192.0.2.${randomUUID().slice(0, 8)}` };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post(headers)).status);
    expect(statuses.slice(0, 5).every((s) => s === 400)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});
