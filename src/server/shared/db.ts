// The ONE place the application constructs its Prisma Client. Uses RUNTIME_DATABASE_URL
// (the least-privilege role) and NOTHING ELSE -- never MIGRATION_DATABASE_URL.
//
// FIX: pool limits were hard-coded (5s connect timeout). On a remote database (Neon, us-east-2,
// reached from Zimbabwe, possibly waking from auto-suspend) opening a connection can take several
// seconds, and the dashboard fires ~12 queries at once. They queued past 5s and failed with
// "timeout exceeded when trying to connect", so the page crashed after a successful login.
// Limits are now configurable (matches .env.example) with remote-safe defaults.
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "../../generated/prisma/client";

const RUNTIME_DATABASE_URL = process.env.RUNTIME_DATABASE_URL;

if (!RUNTIME_DATABASE_URL) {
  throw new Error(
    "RUNTIME_DATABASE_URL is not set. The application connects as the least-" +
      "privilege mops_runtime role, configured separately from the Prisma " +
      "CLI's MIGRATION_DATABASE_URL — see .env.example and SETUP_COMMANDS.md.",
  );
}

const intEnv = (name: string, fallback: number): number => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

declare global {
  var __mopsPrismaClient: PrismaClient | undefined;
}

// node-postgres's Pool has no native "min" option — connections are opened
// lazily, on demand, one per concurrent query above whatever is already
// idle. On a remote, possibly-suspended Neon compute that means the FIRST
// request to land after any quiet period pays full connection-establishment
// cost (several seconds here, per the file header) for every connection it
// needs at once, even though the application code issues its queries with
// Promise.all. warmPool() below is the standard workaround: eagerly open
// and immediately release DB_POOL_MIN connections as soon as the module
// loads, so they are already idle-and-ready in the pool by the time the
// first real request's concurrent queries run. It never blocks module load
// and never throws past this function -- a warm-up failure (e.g. the DB is
// unreachable at process start) must not crash the process; the pool still
// works lazily afterwards exactly as before.
function warmPool(pool: Pool, size: number): void {
  for (let i = 0; i < size; i++) {
    pool.query("SELECT 1").catch((err) => console.error("pg pool warm-up query failed:", err instanceof Error ? err.message : err));
  }
}

function createPrismaClient(): PrismaClient {
  const pool = new Pool({
    connectionString: RUNTIME_DATABASE_URL,
    max: intEnv("DB_POOL_MAX", 10),
    idleTimeoutMillis: intEnv("DB_IDLE_TIMEOUT_MS", 30_000),
    connectionTimeoutMillis: intEnv("DB_CONNECT_TIMEOUT_MS", 15_000),
    keepAlive: true,
  });
  // An idle-connection error (Neon closing a suspended socket) must not crash the process.
  pool.on("error", (err) => console.error("pg pool idle client error:", err.message));
  warmPool(pool, intEnv("DB_POOL_MIN", 2));
  const adapter = new PrismaPg(pool);
  return new PrismaClient({
    adapter,
    transactionOptions: { maxWait: 15_000, timeout: 60_000 },
  });
}

export const prisma: PrismaClient = globalThis.__mopsPrismaClient ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__mopsPrismaClient = prisma;
}

export type Db = PrismaClient | Prisma.TransactionClient;

export function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}