// Prisma ORM 7 config file — replaces the `"prisma"` key that used to live
// in package.json in earlier Prisma versions. Loaded automatically by every
// `prisma` CLI command (migrate, generate, studio, ...).
//
// Deliberately loads MIGRATION_DATABASE_URL (the mops_migrator role), never
// RUNTIME_DATABASE_URL — the CLI's job is schema ownership (DDL), which is
// exactly the privilege boundary revision #6 (ARCHITECTURE.md Phase 0
// Addendum) draws between the two roles. The running application never
// reads this file; it configures its own Prisma Client directly in
// src/server/shared/db.ts using RUNTIME_DATABASE_URL and @prisma/adapter-pg.
import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("MIGRATION_DATABASE_URL"),
  },
});
