// Creates (or repairs) the throwaway test database described by .env.test. Idempotent.
//
//   node scripts/test-db-setup.mjs          create roles + database, migrate, grant, seed currencies
//   node scripts/test-db-setup.mjs --reset  drop the database first, then do the above
//
// Needs the superuser of the throwaway server (TEST_DB_ADMIN_URL in .env.test). It refuses to run
// against any non-local host: it creates roles and can drop the database.
import { config } from "dotenv";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import pg from "pg";

const root = process.cwd();
const envFile = path.join(root, ".env.test");
if (!existsSync(envFile)) {
  console.error("Missing .env.test — run: Copy-Item .env.test.example .env.test");
  process.exit(1);
}
config({ path: envFile, override: true, quiet: true });

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres-test", "host.docker.internal"]);
const need = (n) => {
  const v = process.env[n];
  if (!v) {
    console.error(`${n} is not set in .env.test`);
    process.exit(1);
  }
  return new URL(v);
};
const adminUrl = need("TEST_DB_ADMIN_URL");
const migUrl = need("MIGRATION_DATABASE_URL");
const rtUrl = need("RUNTIME_DATABASE_URL");
for (const u of [adminUrl, migUrl, rtUrl]) {
  if (!LOCAL.has(u.hostname.toLowerCase())) {
    console.error(`Refusing to run: ${u.hostname} is not a local host. This script creates roles and may drop a database.`);
    process.exit(1);
  }
}
const dbName = decodeURIComponent(migUrl.pathname.slice(1));
if (decodeURIComponent(rtUrl.pathname.slice(1)) !== dbName) {
  console.error("MIGRATION_DATABASE_URL and RUNTIME_DATABASE_URL must name the same database.");
  process.exit(1);
}
if (!/^[a-z0-9_]+$/i.test(dbName)) {
  console.error(`Unsupported database name "${dbName}" (letters, digits, underscore only).`);
  process.exit(1);
}
const migRole = decodeURIComponent(migUrl.username);
const rtRole = decodeURIComponent(rtUrl.username);
if (migRole !== "mops_migrator" || rtRole !== "mops_runtime") {
  console.error("The test URLs must use the roles mops_migrator (migration) and mops_runtime (runtime).");
  process.exit(1);
}

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const urlWithDb = (u, db) => {
  const c = new URL(u.toString());
  c.pathname = `/${db}`;
  return c.toString();
};
const connect = async (url) => {
  const c = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  c.on("error", () => undefined);
  await c.connect();
  return c;
};

const reset = process.argv.includes("--reset");

// 1. Roles and database (server level).
let admin;
try {
  admin = await connect(urlWithDb(adminUrl, "postgres"));
} catch (e) {
  console.error(`Cannot reach the test server at ${adminUrl.host}: ${e.message}\nIs it running? npm run test:db:up`);
  process.exit(1);
}
try {
  for (const [role, pw, extra] of [
    [migRole, decodeURIComponent(migUrl.password), "CREATEDB"],
    [rtRole, decodeURIComponent(rtUrl.password), ""],
  ]) {
    const exists = (await admin.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount > 0;
    await admin.query(
      `${exists ? "ALTER" : "CREATE"} ROLE ${role} WITH LOGIN PASSWORD ${lit(pw)} NOSUPERUSER ${extra}`.trim(),
    );
  }
  if (reset) {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    console.log(`dropped database ${dbName}`);
  }
  const dbExists = (await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName])).rowCount > 0;
  if (!dbExists) {
    await admin.query(`CREATE DATABASE ${dbName} OWNER ${migRole}`);
    console.log(`created database ${dbName}`);
  } else {
    await admin.query(`ALTER DATABASE ${dbName} OWNER TO ${migRole}`);
  }
  await admin.query(`GRANT CONNECT ON DATABASE ${dbName} TO ${rtRole}`);
} finally {
  await admin.end();
}

// 2. Schema-level grants (Stage 1 of docs/db-roles-and-security.sql).
admin = await connect(urlWithDb(adminUrl, dbName));
try {
  await admin.query(`GRANT ALL ON SCHEMA public TO ${migRole}; GRANT USAGE ON SCHEMA public TO ${rtRole};`);
} finally {
  await admin.end();
}

// 3. Migrations, as the schema owner. The URL is passed explicitly so a MIGRATION_DATABASE_URL in
//    .env (the Neon database) can never be picked up by prisma.config.ts: dotenv does not override
//    variables that are already set.
console.log("applying migrations...");
const mig = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  cwd: root,
  stdio: "inherit",
  shell: true,
  env: { ...process.env, MIGRATION_DATABASE_URL: migUrl.toString() },
});
if (mig.status !== 0) {
  console.error("prisma migrate deploy failed (see output above).");
  process.exit(mig.status ?? 1);
}

// 4. Runtime grants (Stage 3) and reference currencies, as the superuser.
const sqlFile = readFileSync(path.join(root, "docs", "db-roles-and-security.sql"), "utf8");
const start = sqlFile.search(/^REVOKE INSERT, UPDATE, DELETE ON stock_balance/m);
if (start < 0) {
  console.error("Could not find Stage 3 in docs/db-roles-and-security.sql (expected a REVOKE ... stock_balance statement).");
  process.exit(1);
}
admin = await connect(urlWithDb(adminUrl, dbName));
try {
  await admin.query(sqlFile.slice(start)); // one simple-protocol call = one implicit transaction
  console.log("applied runtime grants");
  await admin.query(
    `INSERT INTO currency (code, name, decimals) VALUES
       ('USD','United States Dollar',2), ('ZIG','Zimbabwe Gold',2), ('ZAR','South African Rand',2)
     ON CONFLICT DO NOTHING`,
  );
  console.log("seeded currencies");
} catch (e) {
  console.error(`Stage 3 grants failed: ${e.message}`);
  process.exit(1);
} finally {
  await admin.end();
}
console.log(`\nTest database "${dbName}" is ready. Run: npm test`);
