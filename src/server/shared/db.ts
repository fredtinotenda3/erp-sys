// The ONE place the application constructs its Prisma Client. Deliberately
// uses RUNTIME_DATABASE_URL (the mops_runtime role) and NOTHING ELSE —
// never MIGRATION_DATABASE_URL, which is reserved for the Prisma CLI
// (prisma.config.ts) and manual migration SQL. If this file ever needs
// MIGRATION_DATABASE_URL for something, that's a sign the operation belongs
// in a migration or an admin script, not in application code — the whole
// point of the two-role split (ARCHITECTURE.md Phase 0 Addendum #6) is that
// the running app can never hold schema-owner privileges.
//
// Prisma ORM 7's "prisma-client" generator (see prisma/schema.prisma header)
// requires an explicit driver adapter at runtime rather than managing its
// own connection internally — @prisma/adapter-pg wraps a `pg.Pool`.
import { Pool } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
// NOTE the "/client" suffix: Prisma 7's "prisma-client" generator emits its
// importable entry point at "<output>/client" (a client.ts/.js file), not a
// plain index at the output root — confirmed against two current Prisma v7
// doc pages (generating-prisma-client, handling-exceptions-and-errors) since
// `npx prisma generate` could not be run in this sandbox to confirm it
// empirically (see ARCHITECTURE.md Phase 0 Addendum, "Known verification
// gap"). If your actual generated output differs, this is the one line to
// fix.
import { PrismaClient, Prisma } from "../../generated/prisma/client";

const RUNTIME_DATABASE_URL = process.env.RUNTIME_DATABASE_URL;

if (!RUNTIME_DATABASE_URL) {
  throw new Error(
    "RUNTIME_DATABASE_URL is not set. The application connects as the least-" +
      "privilege mops_runtime role, configured separately from the Prisma " +
      "CLI's MIGRATION_DATABASE_URL — see .env.example and SETUP_COMMANDS.md.",
  );
}

// Next.js's dev server module-reloads on every file change; without caching
// the client on `globalThis`, each reload would create a brand new
// connection pool and leak the old one (a well-documented Prisma+Next.js dev
// footgun). Not needed in production, where the module is loaded exactly
// once per server process.
declare global {
  // eslint-disable-next-line no-var
  var __mopsPrismaClient: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const pool = new Pool({
    connectionString: RUNTIME_DATABASE_URL,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  const adapter = new PrismaPg(pool);
  return new PrismaClient({ adapter });
}

export const prisma: PrismaClient = globalThis.__mopsPrismaClient ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalThis.__mopsPrismaClient = prisma;
}

// A function/service-layer function can run inside a transaction (passed a
// `Prisma.TransactionClient`) or standalone (passed the top-level
// `PrismaClient`) — this union lets repository helpers like
// modules/iam/audit-service.ts accept either without duplicating code.
export type Db = PrismaClient | Prisma.TransactionClient;

export function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}
