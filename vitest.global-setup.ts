// Pre-flight for the real-database test suite. Runs ONCE before any test file.
//
// Why it exists: when the database is behind the code (a migration not applied,
// or one that failed part-way), dozens of unrelated tests fail with
// "column ... does not exist" and it is not obvious that a single missing
// migration is the cause. This turns that wall of failures into one clear
// message that says what to run.
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { Pool } from "pg";
import { assertSafeTestDatabase, loadTestEnv } from "./vitest.test-env";

export default async function globalSetup() {
  loadTestEnv();
  assertSafeTestDatabase(); // refuses a non-local database and a missing .env.test
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  const runtimeUrl = process.env.RUNTIME_DATABASE_URL;
  if (!migrationUrl || !runtimeUrl) return; // vitest.setup.ts reports this

  const problems: string[] = [];
  const pool = new Pool({ connectionString: migrationUrl, max: 1, connectionTimeoutMillis: 10_000 });
  pool.on("error", () => undefined); // an idle-connection drop must not crash the preflight
  try {
    const failed = await pool.query(
      `SELECT migration_name FROM _prisma_migrations
        WHERE finished_at IS NULL AND rolled_back_at IS NULL ORDER BY started_at`,
    ).catch(() => ({ rows: [] as { migration_name: string }[] })); // no history table: DB built by hand with psql
    for (const r of failed.rows) {
      problems.push(
        `Migration "${r.migration_name}" is recorded as FAILED. Fix the cause shown by ` +
          `\`npx prisma migrate deploy\`, then \`npx prisma migrate resolve --rolled-back ${r.migration_name}\` ` +
          `and deploy again. (docs/SETUP_COMMANDS.md section 9)`,
      );
    }

    // Every migration directory in the repo must be recorded as applied. This catches ANY migration the
    // database is behind on (e.g. 20261031100000_account_security, which creates auth_throttle — without
    // it every login() fails with `relation "auth_throttle" does not exist`). If there is no history table
    // the database was built by hand with psql, and the table/column probes below are the only check.
    const migrationsDir = path.join(process.cwd(), "prisma", "migrations");
    if (existsSync(migrationsDir)) {
      const onDisk = readdirSync(migrationsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(path.join(migrationsDir, e.name, "migration.sql")))
        .map((e) => e.name)
        .sort();
      const applied = await pool
        .query(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)
        .then((r) => new Set<string>(r.rows.map((x: { migration_name: string }) => x.migration_name)))
        .catch(() => null);
      if (applied) {
        const missing = onDisk.filter((m) => !applied.has(m));
        if (missing.length > 0) {
          problems.push(
            `${missing.length} migration(s) in prisma/migrations are not applied to this database: ` +
              `${missing.join(", ")}. Run \`npm run test:db:setup\`.`,
          );
        }
      }
    }

    const needed: [string, string][] = [
      ["exchange_rate", "org_id"],
      ["job_cost_actual", "revenue_currency"],
      ["job_cost_actual_line", "currency"],
      // migration 20261031100000_account_security
      ["auth_throttle", "window_start"],
      ["password_reset_token", "token_hash"],
    ];
    for (const [table, column] of needed) {
      const { rowCount } = await pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
        [table, column],
      );
      if (!rowCount) problems.push(`${table}.${column} is missing — run \`npx prisma migrate deploy\`.`);
    }

    const grants = await pool.query(
      `SELECT has_table_privilege('mops_runtime', 'stock_balance', 'UPDATE') AS bal_update,
              has_table_privilege('mops_runtime', 'stock_balance', 'INSERT') AS bal_insert,
              has_table_privilege('mops_runtime', 'stock_balance', 'DELETE') AS bal_delete`,
    ).catch(() => null);
    const sec = await pool
      .query(
        `SELECT has_table_privilege('mops_runtime', 'auth_throttle', 'SELECT,INSERT,UPDATE,DELETE') AS thr,
                has_table_privilege('mops_runtime', 'password_reset_token', 'SELECT,INSERT,UPDATE') AS prt`,
      )
      .catch(() => null); // tables missing: already reported above
    if (sec && (!sec.rows[0].thr || !sec.rows[0].prt)) {
      problems.push(
        "mops_runtime lacks privileges on auth_throttle / password_reset_token. Re-run Stage 3 of " +
          "docs/db-roles-and-security.sql as a superuser — for the test database, just run `npm run test:db:setup`.",
      );
    }
    if (grants && (grants.rows[0].bal_update || grants.rows[0].bal_insert || grants.rows[0].bal_delete)) {
      problems.push(
        "mops_runtime can write to stock_balance (it must be SELECT-only). Run `npx prisma migrate deploy` " +
          "(it revokes this) or run `npm run test:db:setup`.",
      );
    }
  } catch (err) {
    problems.push(`Could not inspect the database with MIGRATION_DATABASE_URL: ${(err as Error).message}`);
  } finally {
    await pool.end();
  }

  if (problems.length > 0) {
    throw new Error(
      "\n\nDATABASE IS NOT UP TO DATE — tests were not run.\n\n - " + problems.join("\n - ") + "\n",
    );
  }
}
