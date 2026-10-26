import { describe, it, expect } from "vitest";
import { checkSeedSafety, parseTarget, targetLabel } from "../seed-guard";

const url = (host: string, db: string, user = "u", pw = "s3cret") => `postgresql://${user}:${pw}@${host}/${db}?sslmode=require`;
const base = (over: Record<string, string | undefined> = {}) => ({
  RUNTIME_DATABASE_URL: url("ep-quiet-lake-1.c-7.us-east-2.aws.neon.tech", "operis_dev"),
  MIGRATION_DATABASE_URL: url("ep-quiet-lake-1.c-7.us-east-2.aws.neon.tech", "operis_dev", "owner", "other"),
  OPERIS_DEV_SEED_TARGET: "operis_dev@ep-quiet-lake-1.c-7.us-east-2.aws.neon.tech",
  ...over,
});

describe("seed guard", () => {
  it("allows only an explicitly confirmed, non-production, consistent target", () => {
    const r = checkSeedSafety(base());
    expect(r.ok).toBe(true);
    expect(r.target).toBe("operis_dev@ep-quiet-lake-1.c-7.us-east-2.aws.neon.tech");
  });

  it("refuses without the confirmation variable and says exactly what to set", () => {
    const r = checkSeedSafety(base({ OPERIS_DEV_SEED_TARGET: undefined }));
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain("OPERIS_DEV_SEED_TARGET=operis_dev@ep-quiet-lake-1");
  });

  it("refuses a confirmation that names a different database", () => {
    expect(checkSeedSafety(base({ OPERIS_DEV_SEED_TARGET: "operis_dev@somewhere-else.example" })).ok).toBe(false);
  });

  it("refuses NODE_ENV=production even when confirmed", () => {
    expect(checkSeedSafety(base({ NODE_ENV: "production" })).ok).toBe(false);
  });

  it("refuses names that look like production, even when confirmed", () => {
    for (const db of ["operis_prod", "production", "operis-live"]) {
      const host = "ep-x.neon.tech";
      const r = checkSeedSafety({ RUNTIME_DATABASE_URL: url(host, db), MIGRATION_DATABASE_URL: url(host, db), OPERIS_DEV_SEED_TARGET: `${db}@${host}` });
      expect(r.ok, db).toBe(false);
      expect(r.problems.join(" ")).toMatch(/production/);
    }
  });

  it("does not mistake words that merely contain 'prod' or 'live' (e.g. 'olivera')", () => {
    const host = "ep-x.neon.tech";
    const r = checkSeedSafety({ RUNTIME_DATABASE_URL: url(host, "olivera_dev"), MIGRATION_DATABASE_URL: url(host, "olivera_dev"), OPERIS_DEV_SEED_TARGET: `olivera_dev@${host}` });
    expect(r.ok).toBe(true);
  });

  it("refuses when the two URLs disagree about the database", () => {
    const r = checkSeedSafety(base({ MIGRATION_DATABASE_URL: url("ep-quiet-lake-1.c-7.us-east-2.aws.neon.tech", "another_db") }));
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/different databases/);
  });

  it("treats Neon's pooled and direct hosts as the same database", () => {
    const r = checkSeedSafety(base({ RUNTIME_DATABASE_URL: url("ep-quiet-lake-1-pooler.c-7.us-east-2.aws.neon.tech", "operis_dev") }));
    expect(r.ok).toBe(true);
    expect(r.target).not.toContain("pooler");
  });

  it("refuses missing or unreadable URLs", () => {
    expect(checkSeedSafety({}).ok).toBe(false);
    expect(checkSeedSafety({ RUNTIME_DATABASE_URL: "not a url", MIGRATION_DATABASE_URL: "nope" }).ok).toBe(false);
  });

  it("never exposes credentials in anything it returns", () => {
    const r = checkSeedSafety(base({ OPERIS_DEV_SEED_TARGET: undefined }));
    expect(JSON.stringify(r)).not.toMatch(/s3cret|other|owner|postgresql:/);
    expect(parseTarget(url("h.example", "d"))).toEqual({ host: "h.example", database: "d" });
    expect(targetLabel({ host: "h", database: "d" })).toBe("d@h");
  });
});
