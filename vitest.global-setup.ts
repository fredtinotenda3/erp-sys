// Pre-flight for the real-database test suite. Runs ONCE before any test file.
//
// Why it exists: when the database is behind the code (a migration not applied,
// or one that failed part-way), dozens of unrelated tests fail with
// "column ... does not exist" and it is not obvious that a single missing
// migration is the cause. This turns that wall of failures into one clear
// message that says what to run.
import "dotenv/config";
import { Pool } from "pg";

export default async function globalSetup() {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL;
  const runtimeUrl = process.env.RUNTIME_DATABASE_URL;
  if (!migrationUrl || !runtimeUrl) return; // vitest.setup.ts reports this

  const problems: string[] = [];
  const pool = new Pool({ connectionString: migrationUrl, max: 1, connectionTimeoutMillis: 10_000 });
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

    const needed: [string, string][] = [
      ["exchange_rate", "org_id"],
      ["job_cost_actual", "revenue_currency"],
      ["job_cost_actual_line", "currency"],
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
    if (grants && (grants.rows[0].bal_update || grants.rows[0].bal_insert || grants.rows[0].bal_delete)) {
      problems.push(
        "mops_runtime can write to stock_balance (it must be SELECT-only). Run `npx prisma migrate deploy` " +
          "(it revokes this) or re-run Stage 3 of docs/db-roles-and-security.sql.",
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
