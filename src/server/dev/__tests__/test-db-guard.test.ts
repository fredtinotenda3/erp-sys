import { describe, it, expect } from "vitest";
import { checkRemoteTestDbSafety } from "../test-db-guard";

const url = (host: string, db: string, user = "u", pw = "s3cret") => `postgresql://${user}:${pw}@${host}/${db}?sslmode=require`;

describe("checkRemoteTestDbSafety", () => {
  it("passes through silently when both URLs are local -- no remote opt-in in play", () => {
    const r = checkRemoteTestDbSafety({
      MIGRATION_DATABASE_URL: url("localhost", "operis_test"),
      RUNTIME_DATABASE_URL: url("localhost", "operis_test"),
    });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it("reports nothing when a URL is remote but ALLOW_REMOTE_TEST_DB is not set -- that refusal belongs to the caller", () => {
    const r = checkRemoteTestDbSafety({
      MIGRATION_DATABASE_URL: url("ep-quiet-lake-1.c-7.us-east-2.aws.neon.tech", "operis_test"),
      RUNTIME_DATABASE_URL: url("ep-quiet-lake-1.c-7.us-east-2.aws.neon.tech", "operis_test"),
    });
    expect(r.ok).toBe(true);
    expect(r.problems).toEqual([]);
  });

  it("allows a remote target once confirmed, consistent, and not production-named", () => {
    const host = "ep-quiet-lake-1.c-7.us-east-2.aws.neon.tech";
    const r = checkRemoteTestDbSafety({
      MIGRATION_DATABASE_URL: url(host, "operis_test"),
      RUNTIME_DATABASE_URL: url(host, "operis_test"),
      ALLOW_REMOTE_TEST_DB: "1",
      TEST_DB_CONFIRM_TARGET: `operis_test@${host}`,
    });
    expect(r.ok).toBe(true);
    expect(r.target).toBe(`operis_test@${host}`);
  });

  it("refuses a remote target with no confirmation and says exactly what to set", () => {
    const host = "ep-quiet-lake-1.c-7.us-east-2.aws.neon.tech";
    const r = checkRemoteTestDbSafety({
      MIGRATION_DATABASE_URL: url(host, "operis_test"),
      RUNTIME_DATABASE_URL: url(host, "operis_test"),
      ALLOW_REMOTE_TEST_DB: "1",
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toContain(`TEST_DB_CONFIRM_TARGET=operis_test@${host}`);
  });

  it("refuses a confirmation that names a different database", () => {
    const host = "ep-quiet-lake-1.c-7.us-east-2.aws.neon.tech";
    const r = checkRemoteTestDbSafety({
      MIGRATION_DATABASE_URL: url(host, "operis_test"),
      RUNTIME_DATABASE_URL: url(host, "operis_test"),
      ALLOW_REMOTE_TEST_DB: "1",
      TEST_DB_CONFIRM_TARGET: "operis_test@somewhere-else.example",
    });
    expect(r.ok).toBe(false);
  });

  it("refuses a production-looking name even when confirmed", () => {
    for (const db of ["operis_prod", "production", "operis-live"]) {
      const host = "ep-x.neon.tech";
      const r = checkRemoteTestDbSafety({
        MIGRATION_DATABASE_URL: url(host, db),
        RUNTIME_DATABASE_URL: url(host, db),
        ALLOW_REMOTE_TEST_DB: "1",
        TEST_DB_CONFIRM_TARGET: `${db}@${host}`,
      });
      expect(r.ok, db).toBe(false);
      expect(r.problems.join(" ")).toMatch(/production/);
    }
  });

  it("does not mistake a name that merely contains 'prod' or 'live' (e.g. 'olivera')", () => {
    const host = "ep-x.neon.tech";
    const r = checkRemoteTestDbSafety({
      MIGRATION_DATABASE_URL: url(host, "olivera_test"),
      RUNTIME_DATABASE_URL: url(host, "olivera_test"),
      ALLOW_REMOTE_TEST_DB: "1",
      TEST_DB_CONFIRM_TARGET: `olivera_test@${host}`,
    });
    expect(r.ok).toBe(true);
  });

  it("refuses when the two URLs disagree about the database, even if both are confirmed-shaped", () => {
    const host = "ep-x.neon.tech";
    const r = checkRemoteTestDbSafety({
      MIGRATION_DATABASE_URL: url(host, "operis_test"),
      RUNTIME_DATABASE_URL: url(host, "another_db"),
      ALLOW_REMOTE_TEST_DB: "1",
      TEST_DB_CONFIRM_TARGET: `operis_test@${host}`,
    });
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(/different databases/);
  });

  it("treats Neon's pooled and direct hosts as the same database", () => {
    const r = checkRemoteTestDbSafety({
      MIGRATION_DATABASE_URL: url("ep-quiet-lake-1.c-7.us-east-2.aws.neon.tech", "operis_test"),
      RUNTIME_DATABASE_URL: url("ep-quiet-lake-1-pooler.c-7.us-east-2.aws.neon.tech", "operis_test"),
      ALLOW_REMOTE_TEST_DB: "1",
      TEST_DB_CONFIRM_TARGET: "operis_test@ep-quiet-lake-1.c-7.us-east-2.aws.neon.tech",
    });
    expect(r.ok).toBe(true);
    expect(r.target).not.toContain("pooler");
  });

  it("never exposes credentials in anything it returns", () => {
    const host = "ep-x.neon.tech";
    const r = checkRemoteTestDbSafety({
      MIGRATION_DATABASE_URL: url(host, "operis_test"),
      RUNTIME_DATABASE_URL: url(host, "operis_test"),
      ALLOW_REMOTE_TEST_DB: "1",
    });
    expect(JSON.stringify(r)).not.toMatch(/s3cret|postgresql:/);
  });
});
